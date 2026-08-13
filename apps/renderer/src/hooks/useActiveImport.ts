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
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/riacore';
import { useWorkspaceState, isDbOpen } from './useWorkspaceState';

/**
 * Polls the worker for the currently running import.
 * This is the single source of truth — the worker tracks it in memory,
 * no DB queries, no race conditions.
 *
 * Returns `{ sourceId }` when an import is running, `null` otherwise.
 */
export function useActiveImport() {
  const wsState = useWorkspaceState();
  const dbOpen = isDbOpen(wsState);

  return useQuery<{ sourceId: string } | null>({
    queryKey: ['imports.getActiveImport'],
    queryFn: () => api.imports.getActiveImport(),
    enabled: dbOpen,
    refetchInterval: 2_000,
    staleTime: 0,
  });
}
