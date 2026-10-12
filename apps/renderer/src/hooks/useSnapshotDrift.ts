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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { SnapshotDriftInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceState, isDbOpen } from './useWorkspaceState';

export const SNAPSHOT_DRIFT_QUERY_KEY = ['workspace.getSnapshotDrift'] as const;

/**
 * Has `ria-data/` changed since the database was loaded?
 *
 * Polled on the same 5-second rhythm as `workspace.status`. Worst-case notice is
 * therefore ~5 s, which is acceptable because a late notice is never an unsafe
 * notice: `persistor.store` refuses the write regardless of whether anyone has
 * been told yet (docs/coreSpecs/RiaDataChangeDetection.md §4.3).
 *
 * Deliberately its own query key rather than a field on `workspace.status`: the
 * backend load gate reads `getStatus()` on every dispatched channel, so folding
 * a manifest read into it would put a JSON parse on every IPC call.
 *
 * `staleTime: 0` because this is the one query whose whole purpose is to notice
 * an out-of-band change; serving it from cache would defeat it.
 */
export function useSnapshotDrift() {
  const state = useWorkspaceState();
  const enabled = isDbOpen(state);

  return useQuery<SnapshotDriftInfo>({
    queryKey: SNAPSHOT_DRIFT_QUERY_KEY,
    queryFn: () => api.workspace.getSnapshotDrift(),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    staleTime: 0,
    // A failed drift probe must not spam retries; the next poll covers it.
    retry: false,
  });
}

/**
 * Re-check drift immediately instead of waiting for the next poll.
 *
 * Call this after anything that could have changed the relationship between the
 * DB and `ria-data/` from the renderer's point of view — a refused save, a
 * branch checkout from the Branches tab, or resolving the drift dialog.
 */
export function useRefreshSnapshotDrift() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: SNAPSHOT_DRIFT_QUERY_KEY }),
    [queryClient],
  );
}
