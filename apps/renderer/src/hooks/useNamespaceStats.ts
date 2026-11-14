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
import type { NamespaceStats } from '@riacore/app-contracts';

/**
 * Fetches per-namespace node and edge counts.
 * Returns an empty array when the DB is closed or no workspace is open.
 * Polled every 10s — less frequently than dbStats since it's used for
 * informational tooltips, not primary UI state.
 */
export function useNamespaceStats(enabled = true) {
  return useQuery<NamespaceStats[]>({
    queryKey: ['db.namespaceStats'],
    queryFn: async () => {
      const stats: unknown = await api.db.getNamespaceStats();
      // A request overtaken by a database reopen comes back as
      // `{ superseded: true }` (the load gate). Failing it keeps the previous
      // list and retries, instead of handing callers something not iterable.
      if (!Array.isArray(stats)) throw new Error('Namespace statistics request was superseded');
      return stats as NamespaceStats[];
    },
    enabled,
    refetchInterval: 10000,
    staleTime: 8000,
    retry: 1,
    throwOnError: false,
  });
}
