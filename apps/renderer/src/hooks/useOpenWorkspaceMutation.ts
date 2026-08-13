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
import type { WorkspaceInfo, LifecycleAction } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useLifecycleHudStore, type HudPhaseStep } from '../store/lifecycleHudStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useImportRunStore } from '../store/importRunStore';
import { useJobStore } from '../store/jobStore';
import { useDiffStore } from '../store/diffStore';
import { resetWorkspaceScopedQueries } from './workspaceCacheReset';

/**
 * Build the HUD phase step sequence for a given lifecycleAction.
 * All phases are marked 'done' since we reconstruct retroactively on success.
 */
function buildPhaseSteps(lifecycleAction: LifecycleAction): HudPhaseStep[] {
  const done = (id: string, label: string): HudPhaseStep => ({
    id,
    label,
    status: 'done',
  });

  switch (lifecycleAction) {
    case 'created':
      return [
        done('locate', 'Locate'),
        done('init-db', 'Initialise DB'),
        done('ready', 'Ready'),
      ];

    case 'opened_loaded_from_ria_data':
      // Could be either "no DB, ria-data present" or "DB + ria-data mismatch".
      // The design uses the same lifecycleAction for both; we show the
      // "no DB" sequence as the default (simpler, more common path).
      return [
        done('locate', 'Locate'),
        done('init-db', 'Initialise DB'),
        done('load-ria-data', 'Load from ria-data'),
        done('ready', 'Ready'),
      ];

    case 'opened_saved_to_ria_data':
      return [
        done('locate', 'Locate'),
        done('open-db', 'Open DB'),
        done('export-ria-data', 'Export to ria-data'),
        done('ready', 'Ready'),
      ];

    case 'opened_consistent':
      return [
        done('locate', 'Locate'),
        done('open-db', 'Open DB'),
        done('verify', 'Verify'),
        done('ready', 'Ready'),
      ];

    case 'opened_db_only':
      return [
        done('locate', 'Locate'),
        done('open-db', 'Open DB'),
        done('ready', 'Ready'),
      ];

    default:
      return [done('ready', 'Ready')];
  }
}

/** Map lifecycleAction + optional warning to a human-readable completion title. */
function completionTitle(lifecycleAction: LifecycleAction, lifecycleWarning?: string): string {
  switch (lifecycleAction) {
    case 'created':                    return 'Workspace created';
    case 'opened_consistent':          return 'Workspace ready — in sync';
    case 'opened_loaded_from_ria_data': return 'Workspace ready — loaded from ria-data';
    case 'opened_saved_to_ria_data':   return 'Workspace ready — exported to ria-data';
    case 'opened_db_only':
      if (lifecycleWarning && /file integrity check failed|files have been changed/i.test(lifecycleWarning))
        return 'Workspace open — ria-data files modified';
      return 'Workspace open — ria-data export failed';
    default:                           return 'Workspace ready';
  }
}

/** Indeterminate spinner phase shown while the operation is in flight. */
const PENDING_PHASES: HudPhaseStep[] = [
  { id: 'locating', label: 'Opening workspace…', status: 'active' },
];

export function useOpenWorkspaceMutation() {
  const queryClient = useQueryClient();

  return useMutation<WorkspaceInfo, Error, string>({
    mutationFn: (workingDir: string) => api.workspace.open(workingDir, { forceRecheck: true }),

    onMutate: (workingDir: string) => {
      useLifecycleHudStore
        .getState()
        .startOperation('Opening workspace…', PENDING_PHASES, workingDir);
    },

    onSuccess: (data: WorkspaceInfo) => {
      const phases = buildPhaseSteps(data.lifecycleAction);
      const title = completionTitle(data.lifecycleAction, data.lifecycleWarning);

      // Retroactively set the correct phases and title, then mark complete.
      useLifecycleHudStore.setState({ phases, title });

      // For opened_db_only with a warning, show as ⚠ (not green ✓)
      if (data.lifecycleAction === 'opened_db_only' && data.lifecycleWarning) {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
        useLifecycleHudStore.setState((s) => ({
          status: 'success',
          completedAt: Date.now(),
          phases: s.phases.map((p) => ({ ...p, status: 'done' as const })),
          eventLog: [
            ...s.eventLog,
            { timestamp: Date.now(), message: `${ts} ⚠ ${title}`, kind: 'info' as const },
          ],
        }));
      } else {
        useLifecycleHudStore.getState().completeOperation();
      }

      // Record this workspace in the recent list (best-effort, non-blocking).
      void api.workspace.addRecent(data.workingDir);

      // Node IDs are reassigned on load — clear all stale Zustand state.
      useWorkspaceStore.getState().resetWorkspaceState();
      useWorkspaceStore.getState().setWorkingDir(data.workingDir);

      // Clear import run tracking — any runs from the previous workspace are gone.
      useImportRunStore.getState().reset();

      // Clear job history — jobs from the previous workspace are irrelevant.
      useJobStore.getState().resetAll();

      // Clear diff store — namespace names and diff results are workspace-scoped.
      useDiffStore.getState().reset();

      // Remove ALL workspace-scoped TanStack Query caches so stale data from the
      // previous workspace is never visible after the transition. Everything
      // except PRESERVED_QUERY_ROOTS is dropped, so a newly added query key can
      // never silently opt out of cleanup (see workspaceCacheReset.ts).
      resetWorkspaceScopedQueries(queryClient);

      // Invalidate workspace.status to trigger a fresh poll with the new DB state.
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
    },

    onError: (error: Error) => {
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      useLifecycleHudStore
        .getState()
        .failOperation('locating', `${ts} · Failed to open workspace: ${error.message}`);
    },
  });
}
