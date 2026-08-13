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
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

interface AppLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  fatal(message: string, context?: Record<string, unknown>): void;
}

export interface GraphCoreWindowManager {
  /** Create or focus the Graph-Core window. Idempotent. */
  openOrFocus(): void;

  /** Close the Graph-Core window if it exists. Safe to call when none exists. */
  close(): Promise<void>;

  /** Returns true if a Graph-Core window is currently live. */
  isOpen(): boolean;
}

export function createGraphCoreWindowManager(deps: {
  preloadPath: string;
  iconPath?: string | undefined;
  backgroundColor?: string;
  loadGraphCoreView(window: BrowserWindow): Promise<void>;
  createBrowserWindow(opts: BrowserWindowConstructorOptions): BrowserWindow;
  logger: AppLogger;
}): GraphCoreWindowManager {
  const { preloadPath, iconPath, backgroundColor, loadGraphCoreView, createBrowserWindow, logger } = deps;

  let current: BrowserWindow | null = null;

  return {
    openOrFocus(): void {
      if (current === null || current.isDestroyed()) {
        logger.info('Creating Graph-Core window');

        const win = createBrowserWindow({
          width: 1200,
          height: 800,
          icon: iconPath,
          // Show immediately at zero opacity so the user gets instant feedback
          // (taskbar entry, window outline with themed background). Opacity
          // ramps to 1 once the renderer signals paintReady, matching the
          // main-window reveal pattern.
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

        current = win;

        // Secondary window: strip the application menu (File/Git/Report/…).
        // Those menu actions only operate on the main window. On Windows/Linux
        // the global application menu is otherwise shown on every BrowserWindow.
        win.removeMenu();

        // Reveal the window once the HTML has loaded. The renderer's main.tsx
        // sends `paintReady` after React's first themed paint; the main process
        // listens globally on ipcMain and can relay it. As a fallback, reveal
        // on did-finish-load so the user is never stuck with an invisible window.
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.setOpacity(1);
          }
        });

        win.on('closed', () => {
          logger.info('Graph-Core window closed');
          current = null;
        });

        loadGraphCoreView(win).catch((err) => {
          logger.error('Failed to load Graph-Core view', {
            error: err instanceof Error ? err.message : String(err),
          });
        });

        win.focus();
      } else {
        logger.info('Focusing existing Graph-Core window');
        current.focus();
      }
    },

    async close(): Promise<void> {
      if (current === null || current.isDestroyed()) {
        return;
      }

      const win = current;
      await new Promise<void>((resolve) => {
        win.once('closed', () => {
          resolve();
        });
        win.close();
      });
    },

    isOpen(): boolean {
      return current !== null && !current.isDestroyed();
    },
  };
}
