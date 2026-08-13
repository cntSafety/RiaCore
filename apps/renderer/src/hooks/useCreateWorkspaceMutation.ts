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
import type { WorkspaceInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useLifecycleHudStore, type HudPhaseStep } from '../store/lifecycleHudStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useImportRunStore } from '../store/importRunStore';
import { useJobStore } from '../store/jobStore';
import { useDiffStore } from '../store/diffStore';
import { resetWorkspaceScopedQueries } from './workspaceCacheReset';

/**
 * Phase steps for the `created` lifecycle action — the only possible outcome
 * of a successful workspace.create call.
 * All phases are marked 'done' since we reconstruct retroactively on success.
 */
const CREATED_PHASES: HudPhaseStep[] = [
  { id: 'locate', label: 'Locate', status: 'done' },
  { id: 'init-db', label: 'Initialise DB', status: 'done' },
  { id: 'ready', label: 'Ready', status: 'done' },
];

/** Indeterminate spinner phase shown while the operation is in flight. */
const PENDING_PHASES: HudPhaseStep[] = [
  { id: 'locating', label: 'Creating workspace…', status: 'active' },
];

export function useCreateWorkspaceMutation() {
  const queryClient = useQueryClient();

  return useMutation<WorkspaceInfo, Error, string>({
    mutationFn: (workingDir: string) => api.workspace.create(workingDir),

    onMutate: (workingDir: string) => {
      useLifecycleHudStore
        .getState()
        .startOperation('Creating workspace…', PENDING_PHASES, workingDir);
    },

    onSuccess: (data: WorkspaceInfo) => {
      // Retroactively set the correct phases and title, then mark complete.
      useLifecycleHudStore.setState({ phases: CREATED_PHASES, title: 'Workspace created' });
      useLifecycleHudStore.getState().completeOperation();

      useWorkspaceStore.getState().resetWorkspaceState();
      useWorkspaceStore.getState().setWorkingDir(data.workingDir);
      useImportRunStore.getState().reset();
      useJobStore.getState().resetAll();
      useDiffStore.getState().reset();

      // Drop every workspace-scoped cache from whatever was open before (see
      // workspaceCacheReset.ts — one canonical teardown for all lifecycle
      // transitions).
      resetWorkspaceScopedQueries(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
    },

    onError: (error: Error) => {
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      useLifecycleHudStore
        .getState()
        .failOperation('locating', `${ts} · Failed to create workspace: ${error.message}`);
    },
  });
}
