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
 * Scoped save mutation for the Auto_Save_Coordinator (canvas-layout-auto-save).
 *
 * Wraps `persistor.store` at the scope requested by the coordinator:
 *
 *  - `'universe'` → `api.persistor.storeUniverse(workingDir)` (dispatches
 *    `persistor.store` with `scope: 'universe'`). Writes ONLY the two
 *    universe-layer files (RIA_UNIV_CanvasLayout.json +
 *    RIA_UNIV_NamespaceConnection.json) and their Universe_Hash + inventory in
 *    the manifest (Req 1.4, 2.3, 10.1). Used by the frequent drag / connect /
 *    disconnect traffic.
 *  - `'full'` → `api.persistor.store({ workingDir })` (no scope). A full
 *    workspace store — the ONLY store variant that prunes a deleted
 *    namespace's on-disk directory and removes its `manifest.namespace_hashes`
 *    entry. Used by namespace / import-source deletes, which a universe-scoped
 *    store cannot persist.
 *
 * Per the RIACore UI data architecture this mutation performs NO cache
 * invalidation: the DB is the source of truth for the layout/connection
 * queries and those were already invalidated by the originating mutation
 * (`useLayoutPersistMutation` for universe scope; `useConnectMutation` /
 * `useDisconnectMutation` at 'full' scope because a connection edit can change
 * namespace content — the CATEGORIZEDBY edge and dependent cross-namespace
 * relationships — which a universe store cannot persist; `useDeleteNamespaceMutation` /
 * `useDeleteImportSourceMutation` via `invalidateAfterContentChange` for full
 * scope). Auto_Save only serializes the current DB content to disk; it changes
 * no in-memory server state.
 *
 * The Auto_Save_Coordinator (`useCanvasAutoSave`) drives this mutation via
 * `mutateAsync` so it can await the on-disk write and derive the Save_Status.
 * It is deliberately a thin `useMutation` wrapper with no `onSuccess`/`onError`
 * side effects — the coordinator owns status handling. (The manual File → Save
 * uses `useFullWorkspaceSaveMutation`, which owns its own HUD/toast side
 * effects.)
 */
import { useMutation } from '@tanstack/react-query';
import type { StoreResult } from '@riacore/app-contracts';
import type { SaveScope } from '../lib/canvasAutoSaveCoordinator';
import { api } from '../api/riacore';

/** Mutation variables: the workspace to persist and the scope to persist at. */
export interface ScopedSaveVars {
  workingDir: string;
  scope: SaveScope;
}

export function useScopedSaveMutation() {
  return useMutation<StoreResult, Error, ScopedSaveVars>({
    mutationFn: ({ workingDir, scope }) =>
      scope === 'full'
        ? api.persistor.store({ workingDir })
        : api.persistor.storeUniverse(workingDir),
    // No cache invalidation — see file header.
  });
}
