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
 * IPC channel handlers for the cross-namespace-link preference
 * (`CrossNsLinkSettings` — see `packages/app-core/src/settings/cross-ns-link-settings-store.ts`).
 *
 * Like `llm.getSettings`/`llm.saveSettings`, this is a global, workspace-independent
 * setting. Unlike the LLM store it needs no `Electron.safeStorage`, so — unlike
 * `llm.*` — it does NOT need main-process interception in `ipc-relay.ts`; the
 * worker dispatcher handles it directly via `deps.crossNsLinkSettingsStore`
 * (injected by the host with `app.getPath('userData')`, mirroring the LLM store).
 */

import type { createRegistry } from '../channel-registry.js';
import { DEFAULT_CROSS_NS_LINK_SETTINGS } from '../../settings/cross-ns-link-settings-store.js';

export function registerCrossNsLinkSettingsChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  const CATEGORY = 'crossNsLinkSettings';

  registry.register('crossNsLinkSettings.getSettings', async (_payload, deps, _ctx) => {
    if (!deps.crossNsLinkSettingsStore) {
      return { ...DEFAULT_CROSS_NS_LINK_SETTINGS };
    }
    return deps.crossNsLinkSettingsStore.load();
  }, { requiresWorkspace: false, category: CATEGORY });

  registry.register('crossNsLinkSettings.saveSettings', async (payload, deps, _ctx) => {
    if (!deps.crossNsLinkSettingsStore) {
      throw new Error('Cross-namespace link settings store not configured');
    }
    await deps.crossNsLinkSettingsStore.save(payload);
  }, { requiresWorkspace: false, category: CATEGORY });
}
