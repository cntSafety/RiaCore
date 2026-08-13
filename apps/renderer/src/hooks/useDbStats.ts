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

/**
 * Polls DB stats. Pass fastPoll=true during active load operations
 * to get 500ms updates; otherwise polls every 5s.
 *
 * Runs unconditionally — if the DB is closed, the query will fail
 * and return undefined (which the state machine handles gracefully).
 */
export function useDbStats(fastPoll = false, enabled = true) {
  const interval = fastPoll ? 500 : 5000;
  return useQuery({
    queryKey: ['db.stats'],
    queryFn: api.db.getStats,
    enabled,
    refetchInterval: interval,
    staleTime: fastPoll ? 400 : 4000,
    retry: 1,
    // Don't throw to the error boundary — just return undefined on failure
    throwOnError: false,
  });
}
