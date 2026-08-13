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
import { useEffect } from 'react';
import { api } from '../api/riacore';
import type { LoadProgressPushEvent } from '@riacore/app-contracts';

/**
 * Single source of truth for workspace + DB status.
 *
 * getStatus() now returns live dbModule.getStatus() on every call, so this
 * one query replaces the old useDbStatus / db.probe pair. Polled every 5s
 * normally; drops to 1s while a ria-data load is in progress so the UI
 * transitions to db_open promptly when the load finishes.
 */
export function useWorkspaceStatus() {
  const queryClient = useQueryClient();

  // Subscribe to load-progress push events and invalidate the status query
  // on each namespace_done event so the UI updates in near-real-time.
  useEffect(() => {
    const unsub = window.riacore.persistor.onLoadProgress((event: LoadProgressPushEvent) => {
      if (event.kind === 'namespace_done') {
        void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      }
    });
    return unsub;
  }, [queryClient]);

  return useQuery({
    queryKey: ['workspace.status'],
    queryFn: api.workspace.getStatus,
    refetchInterval: (query) => {
      // Poll fast while loading so the transition to db_open is prompt
      const data = query.state.data;
      if (data?.state === 'open' && data.info.lifecycleAction === 'loading_from_ria_data') {
        return 1000;
      }
      return 5000;
    },
    staleTime: 4000,
  });
}
