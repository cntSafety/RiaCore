/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
/**
 * Spawn_Manager — owns the Spawn_Window lifecycle and Pending_Navigation_Queue.
 *
 * Implements the Idle → Booting → Ready → Closed state machine.
 * Enforces the at-most-one-spawn-window invariant.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { NavigationRequest, ShowInTreePayload } from '@riacore/app-contracts';
import type { InvalidationBus } from './invalidation-bus.js';

interface AppLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

type SpawnStatus = 'Idle' | 'Booting' | 'Ready' | 'Closed';

interface SpawnManagerState {
  status: SpawnStatus;
  window: BrowserWindow | null;
  /** Bounded queue of pending navigation requests (max 8). */
  pending: NavigationRequest[];
}

const MAX_QUEUE_LENGTH = 8;

export class SpawnManager {
  private state: SpawnManagerState = {
    status: 'Idle',
    window: null,
    pending: [],
  };

  constructor(
    private readonly deps: {
      preloadPath: string;
      iconPath?: string | undefined;
      backgroundColor?: string;
      loadSpawnView(window: BrowserWindow): Promise<void>;
      createBrowserWindow(opts: BrowserWindowConstructorOptions): BrowserWindow;
      invalidationBus: InvalidationBus;
      logger: AppLogger;
    },
  ) {}

  /**
   * Handle a cross-window "Show in Tree" request from any renderer.
   * Transitions the state machine and either creates a new window,
   * queues the request, or dispatches immediately.
   *
   * Requirements: 3.1, 3.2, 5.1, 5.3
   */
  requestShowInTree(payload: ShowInTreePayload): void {
    const req: NavigationRequest = {
      homeTarget: payload.homeTarget,
      referenceTarget: payload.referenceTarget,
      requestKind: payload.requestKind,
      // Preserve the originating tree's authored analysis so the spawn window
      // mounts SafetyEditor on the SAME analysis (and profile). Dropping this
      // made resolution fall back to "the first authored Safety-Analysis
      // namespace", so opening from Sys_Monitoring_Analysis (or any non-first
      // safety analysis sharing the metamodel) wrongly landed on SW_Safety_Analysis.
      safetyNamespace: payload.safetyNamespace,
    };

    if (this.state.status === 'Idle' || this.state.status === 'Closed') {
      this.deps.logger.info('SpawnManager: Idle/Closed → Booting; creating Spawn_Window');
      this.createWindow();
      this.enqueue(req);
      return;
    }

    if (this.state.status === 'Booting') {
      this.deps.logger.info('SpawnManager: Booting; queuing navigation request');
      this.enqueue(req);
      this.state.window?.focus();
      return;
    }

    // Ready
    this.deps.logger.info('SpawnManager: Ready; dispatching navigation request immediately');
    this.state.window?.focus();
    this.dispatch(req);
  }

  /**
   * Called when the spawn renderer sends `window.spawnReady`.
   * Validates the sender, transitions Booting → Ready, drains the queue FIFO.
   *
   * Requirements: 5.2
   */
  notifyReady(senderId: number): void {
    if (this.state.status !== 'Booting') {
      this.deps.logger.warn('SpawnManager: notifyReady called in unexpected state', {
        status: this.state.status,
      });
      return;
    }

    if (this.state.window?.webContents.id !== senderId) {
      this.deps.logger.warn('SpawnManager: notifyReady from unexpected sender', {
        expectedSenderId: this.state.window?.webContents.id,
        actualSenderId: senderId,
      });
      return;
    }

    this.deps.logger.info('SpawnManager: Booting → Ready; draining Pending_Navigation_Queue', {
      queueLength: this.state.pending.length,
    });

    this.state.status = 'Ready';
    const drained = this.state.pending.splice(0);
    for (const req of drained) {
      this.dispatch(req);
    }
  }

  /**
   * Close the spawn window if one exists. Safe to call when none exists.
   * Requirements: 3.8
   */
  close(): Promise<void> {
    if (this.state.window === null || this.state.window.isDestroyed()) {
      return Promise.resolve();
    }

    const win = this.state.window;
    return new Promise<void>((resolve) => {
      win.once('closed', () => resolve());
      win.close();
    });
  }

  /** Returns true if a Spawn_Window is currently live. */
  isOpen(): boolean {
    return this.state.window !== null && !this.state.window.isDestroyed();
  }

  /**
   * Reveal the spawn window (set opacity to 1). Called by the main process
   * when the spawn renderer signals `window.paintReady`.
   * Safe to call multiple times or when no window exists.
   */
  revealWindow(senderId: number): void {
    if (this.state.window === null || this.state.window.isDestroyed()) return;
    if (this.state.window.webContents.id !== senderId) return;
    if (!this.state.window.isDestroyed()) {
      this.state.window.setOpacity(1);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private createWindow(): void {
    const { preloadPath, iconPath, backgroundColor, loadSpawnView, createBrowserWindow, invalidationBus, logger } = this.deps;

    const win = createBrowserWindow({
      width: 1200,
      height: 800,
      title: 'RiaCore — Safety View',
      icon: iconPath,
      // Show the window immediately at zero opacity so the user gets instant
      // visual feedback (the themed background appears on the taskbar and as
      // a window outline). Opacity ramps to 1 once the renderer has loaded,
      // matching the main-window reveal pattern.
      show: true,
      opacity: 0,
      backgroundColor,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Secondary window: strip the application menu (File/Git/Report/…). Those
    // menu actions only make sense in the main window. On Windows/Linux the
    // global application menu is otherwise shown on every BrowserWindow.
    win.removeMenu();

    this.state.status = 'Booting';
    this.state.window = win;

    // Reveal the window once the renderer signals `paintReady` (handled
    // externally via `revealWindow()`). As a fallback, reveal 5 seconds after
    // did-finish-load so the user is never stuck with an invisible window
    // if paintReady never arrives (renderer crash, very slow startup).
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && win.getOpacity() < 1) {
          win.setOpacity(1);
        }
      }, 5000);
    });

    // Register with the invalidation bus so cross-window cache hints flow here.
    invalidationBus.registerWindow(win);

    win.on('closed', () => {
      logger.info('SpawnManager: Spawn_Window closed → Closed state');
      this.state.status = 'Closed';
      this.state.window = null;
      // Discard any residual queue (Requirement 5.4)
      this.state.pending.splice(0);
    });

    loadSpawnView(win).catch((err) => {
      logger.error('SpawnManager: Failed to load spawn view', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    win.focus();
  }

  /**
   * Append a request to the Pending_Navigation_Queue.
   * Drops the oldest entry on overflow and logs at warn level.
   *
   * Requirements: 5.5, 5.6
   */
  private enqueue(req: NavigationRequest): void {
    if (this.state.pending.length >= MAX_QUEUE_LENGTH) {
      const dropped = this.state.pending.shift();
      this.deps.logger.warn('SpawnManager: Pending_Navigation_Queue overflow; dropped oldest entry', {
        dropped: JSON.stringify(dropped),
      });
    }
    this.state.pending.push(req);
  }

  /**
   * Dispatch a navigation request to the spawn renderer via webContents.send.
   */
  private dispatch(req: NavigationRequest): void {
    const wc = this.state.window?.webContents;
    if (!wc || wc.isDestroyed()) {
      this.deps.logger.warn('SpawnManager: dispatch called but webContents is unavailable');
      return;
    }
    wc.send('window.showInTree.dispatch', req);
  }
}
