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
 * IPC channel handlers for the report-export preferences
 * (`ExportSettings` — see `packages/app-core/src/settings/export-settings-store.ts`).
 *
 * Like `crossNsLinkSettings.*` this is a global, workspace-independent setting
 * living under `app.getPath('userData')`, so the Electron main process answers
 * both channels directly in `ipc-relay.ts`. These worker-side registrations
 * exist for channel-map completeness and for the CLI, where no store is
 * injected: `getSettings` then falls back to the defaults and `saveSettings`
 * fails with a clear message.
 */

import type { createRegistry } from '../channel-registry.js';
import { DEFAULT_EXPORT_SETTINGS } from '../../settings/export-settings-store.js';

export function registerExportSettingsChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  const CATEGORY = 'exportSettings';

  registry.register('exportSettings.getSettings', async (_payload, deps, _ctx) => {
    if (!deps.exportSettingsStore) {
      return { ...DEFAULT_EXPORT_SETTINGS };
    }
    return deps.exportSettingsStore.load();
  }, { requiresWorkspace: false, category: CATEGORY });

  registry.register('exportSettings.saveSettings', async (payload, deps, _ctx) => {
    if (!deps.exportSettingsStore) {
      throw new Error('Export settings store not configured');
    }
    await deps.exportSettingsStore.save(payload);
  }, { requiresWorkspace: false, category: CATEGORY });
}
