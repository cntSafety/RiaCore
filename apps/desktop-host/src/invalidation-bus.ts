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
 * Invalidation_Bus — main-process fan-out broker for cache-invalidation hints.
 *
 * Maintains a registry of live BrowserWindow webContents. When a renderer sends
 * a `cache.invalidate` message, the bus stamps the originWindowId from
 * event.sender.id, applies the shared broadcast policy, and fans out the
 * CacheInvalidationMessage to every other live renderer.
 *
 * Requirements: 15.3, 15.4, 15.14, 15.15
 */

import type { BrowserWindow, WebContents } from 'electron';
import { shouldBroadcast } from '@riacore/app-contracts';
import type { CacheInvalidationOutbound, CacheInvalidationMessage } from '@riacore/app-contracts';

interface AppLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export class InvalidationBus {
  /**
   * Registry: BrowserWindow.id → WebContents.
   * Keyed by BrowserWindow.id (not WebContents.id) so we can skip the origin
   * window by its BrowserWindow.id in fanOut.
   */
  private readonly registry = new Map<number, WebContents>();

  /**
   * Reverse map: WebContents.id → BrowserWindow.id.
   * Needed to look up the BrowserWindow.id from event.sender.id in
   * handleRendererSend.
   */
  private readonly webContentsToWindowId = new Map<number, number>();

  constructor(private readonly logger: AppLogger) {}

  /**
   * Register a BrowserWindow with the bus. Wires cleanup on 'closed' and
   * webContents 'destroyed' events.
   *
   * Requirements: 15.3
   */
  registerWindow(win: BrowserWindow): void {
    const windowId = win.id;
    const wc = win.webContents;
    const wcId = wc.id;

    this.registry.set(windowId, wc);
    this.webContentsToWindowId.set(wcId, windowId);

    win.on('closed', () => {
      this.registry.delete(windowId);
      this.webContentsToWindowId.delete(wcId);
    });

    wc.on('destroyed', () => {
      this.registry.delete(windowId);
      this.webContentsToWindowId.delete(wcId);
    });
  }

  /**
   * Handle a `cache.invalidate` send from a renderer.
   * Stamps originWindowId from event.sender.id, applies policy, fans out.
   *
   * Requirements: 15.4, 15.6
   */
  handleRendererSend(originSenderId: number, payload: CacheInvalidationOutbound): void {
    if (!shouldBroadcast(payload.queryKey)) {
      this.logger.warn('cache.invalidate dropped by policy', {
        queryKey: JSON.stringify(payload.queryKey),
      });
      return;
    }

    const originWindowId = this.webContentsToWindowId.get(originSenderId) ?? -1;
    const message: CacheInvalidationMessage = { ...payload, originWindowId };
    this.fanOut(message, originWindowId);
  }

  /**
   * Inject a cache-invalidation hint from the worker process.
   * Uses sentinel originWindowId = -1 so every live renderer receives it.
   *
   * Requirements: 15.15
   */
  injectFromWorker(payload: CacheInvalidationOutbound): void {
    if (!shouldBroadcast(payload.queryKey)) {
      return;
    }
    const message: CacheInvalidationMessage = { ...payload, originWindowId: -1 };
    this.fanOut(message, /* skip */ undefined);
  }

  /**
   * Fan out a CacheInvalidationMessage to every live renderer except the origin.
   * Per-iteration try/catch and isDestroyed() check ensure a crashed renderer
   * does not block delivery to others.
   *
   * Requirements: 15.14, 15.15
   */
  private fanOut(message: CacheInvalidationMessage, skipWindowId: number | undefined): void {
    for (const [windowId, wc] of this.registry) {
      if (windowId === skipWindowId) continue;

      if (wc.isDestroyed()) {
        this.registry.delete(windowId);
        continue;
      }

      try {
        wc.send('cache.invalidate', message);
      } catch (err) {
        this.logger.warn('webContents.send threw during cache.invalidate fan-out; continuing', {
          windowId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Prune stale entry
        this.registry.delete(windowId);
      }
    }
  }
}
