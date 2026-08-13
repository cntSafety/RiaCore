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
import { ipcMain } from 'electron';
import type { GraphCoreWindowManager } from './graph-core-window.js';
import type { InvalidationBus } from './invalidation-bus.js';
import type { SpawnManager } from './spawn-manager.js';
import type { CacheInvalidationOutbound } from '@riacore/app-contracts';
import type { ShowInTreePayload } from '@riacore/app-contracts';

/**
 * Registers main-process-only IPC handlers for window management.
 * These channels are NOT forwarded to the worker via ipc-relay.ts.
 *
 * Requirements: 9.3, 4.3, 5.1, 5.2, 15.2, 15.6
 */
export function registerWindowChannels(
  graphCoreWindowManager: GraphCoreWindowManager,
  invalidationBus: InvalidationBus,
  spawnManager: SpawnManager,
): void {
  ipcMain.handle('window.openGraphCore', async () => {
    graphCoreWindowManager.openOrFocus();
    // returns void
  });

  // window.showInTree — cross-window "Show in Tree" request.
  // Handled here (not in ipc-relay.ts) because BrowserWindow creation is
  // a main-process-only capability.
  // Requirements: 4.3, 5.1
  ipcMain.handle('window.showInTree', async (_event, payload: ShowInTreePayload) => {
    spawnManager.requestShowInTree(payload);
    // returns void
  });

  // window.spawnReady — fire-and-forget signal from the spawn renderer once
  // it has mounted and registered its navigation handler.
  // Requirements: 5.2
  ipcMain.on('window.spawnReady', (event) => {
    spawnManager.notifyReady(event.sender.id);
  });

  // window.paintReady — reveal spawn/graph-core windows when their renderer
  // signals first themed paint. The main window handles its own paintReady
  // in bootstrap(); this listener covers secondary windows.
  ipcMain.on('window.paintReady', (event) => {
    // Attempt to reveal the spawn window (no-op if sender doesn't match).
    spawnManager.revealWindow(event.sender.id);
    // Graph-Core window reveal is handled via did-finish-load (simpler lifecycle).
  });

  // cache.invalidate — fire-and-forget from any renderer.
  // ipcMain.on (NOT ipcMain.handle) — the only exception to the invoke/handle
  // convention (Requirement 15.19).
  // Requirements: 15.2, 15.6
  ipcMain.on('cache.invalidate', (event, payload: CacheInvalidationOutbound) => {
    invalidationBus.handleRendererSend(event.sender.id, payload);
  });
}
