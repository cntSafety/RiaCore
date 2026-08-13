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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceStatus } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useLifecycleHudStore, type HudPhaseStep } from '../store/lifecycleHudStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useImportRunStore } from '../store/importRunStore';
import { useJobStore } from '../store/jobStore';
import { useDiffStore } from '../store/diffStore';
import { resetWorkspaceScopedQueries } from './workspaceCacheReset';

/** Indeterminate spinner phase shown while the close is in flight. */
const PENDING_PHASES: HudPhaseStep[] = [
  { id: 'closing', label: 'Closing workspace…', status: 'active' },
];

/**
 * Close the currently-open workspace.
 *
 * Auto-save keeps ria-data in sync, so no explicit save is required before
 * closing — the caller only needs to inform the user that the workspace will be
 * closed. The backend `workspace.close` handler releases the DB handle under the
 * lifecycle mutex (bound-awaiting any in-flight ria-data load first), so it is
 * safe to call at any time.
 *
 * On success this mirrors `useOpenWorkspaceMutation`'s teardown: it clears all
 * workspace-scoped Zustand state and removes workspace-scoped TanStack Query
 * caches, then invalidates `workspace.status` so the app phase drops to
 * `no_workspace`.
 */
export function useCloseWorkspaceMutation() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, void>({
    mutationFn: () => api.workspace.close(),

    onMutate: async () => {
      const workingDir = useWorkspaceStore.getState().workingDir ?? '';
      useLifecycleHudStore
        .getState()
        .startOperation('Closing workspace…', PENDING_PHASES, workingDir);
      // Abort any workspace-scoped request already in flight BEFORE the close
      // round-trip, so a poll dispatched moments ago doesn't reach the backend
      // after it has closed and reject with "requires an open workspace". The
      // 2s+ poll intervals mean nothing re-arms during the brief close.
      await queryClient.cancelQueries();
    },

    onSuccess: async () => {
      useLifecycleHudStore.setState({
        phases: [{ id: 'closed', label: 'Closed', status: 'done' }],
        title: 'Workspace closed',
      });
      useLifecycleHudStore.getState().completeOperation();

      // Flip the app phase to no_workspace SYNCHRONOUSLY before anything else.
      // `useWorkspaceState` derives whether workspace-scoped polling queries
      // (db.getStats, imports.listSources, namespaces.list, …) are `enabled`
      // from the polled `workspace.status`. If we only invalidate it, the cached
      // status stays `open` until the next poll resolves, and those queries fire
      // one more interval against the now-closed workspace — the backend rejects
      // them with "requires an open workspace". `close()` is deterministic: the
      // authoritative post-close status is always `closed`, so seeding it here is
      // a known-value write (not a guess), and it disables the dependent queries
      // immediately, eliminating the transition-window errors.
      queryClient.setQueryData<WorkspaceStatus>(['workspace.status'], { state: 'closed' });

      // Cancel EVERY in-flight/retrying query. On close the whole workspace is
      // going away, so any request already dispatched against the (now closed)
      // workspace would reject with "requires an open workspace" — and because
      // several polling queries (e.g. imports.getActiveImport) use React Query's
      // default retry, a rejected in-flight poll would otherwise retry ~1s later
      // and reject again. Cancelling aborts both the in-flight request and any
      // pending retry, so no stray rejection reaches the backend after close.
      // Phase-gated queries additionally stay disabled via the seeded closed
      // status above, so they never re-arm.
      await queryClient.cancelQueries();

      // Clear all workspace-scoped Zustand state — nothing is open anymore.
      useWorkspaceStore.getState().resetWorkspaceState();
      useWorkspaceStore.setState({ workingDir: null, projectName: null });
      useImportRunStore.getState().reset();
      useJobStore.getState().resetAll();
      useDiffStore.getState().reset();

      // Remove ALL workspace-scoped TanStack Query caches so no stale data from
      // the just-closed workspace lingers (removal, not invalidation, so
      // staleTime: Infinity queries cannot keep serving a closed workspace).
      // `['workspace.status']` is in PRESERVED_QUERY_ROOTS, so the seeded
      // `closed` snapshot above survives and keeps the phase at no_workspace.
      resetWorkspaceScopedQueries(queryClient);
    },

    onError: (error: Error) => {
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      useLifecycleHudStore
        .getState()
        .failOperation('closing', `${ts} · Failed to close workspace: ${error.message}`);
    },
  });
}
