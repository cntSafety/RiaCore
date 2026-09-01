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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiagramLayout, ViewLayoutSourceRef } from '@riacore/app-contracts';
import { api } from '../api/riacore';

export interface ViewLayoutPositionRecord {
  source: ViewLayoutSourceRef;
  x: number;
  y: number;
}

export interface PersistViewLayoutInput {
  viewName: string;
  records: ViewLayoutPositionRecord[];
}

/** One cache entry per view and exact evaluated source set. */
export function viewLayoutQueryKey(viewName: string, sources: ViewLayoutSourceRef[]) {
  const sourceKey = sources
    .map(({ namespace, nodeId }) => `${namespace}#${nodeId}`)
    .sort();
  return ['canvasLayout.getViewLayout', viewName, sourceKey] as const;
}

export function useViewLayout(
  viewName: string,
  sources: ViewLayoutSourceRef[],
  enabled: boolean,
) {
  return useQuery<Array<{ nodeId: number; x: number; y: number }>>({
    queryKey: viewLayoutQueryKey(viewName, sources),
    queryFn: () => api.canvasLayout.getViewLayout(viewName, sources),
    enabled,
    staleTime: Infinity,
    // This query is refreshed through invalidation after position writes, which
    // must still work while the model view temporarily has no observer.
    gcTime: Infinity,
  });
}

export function useViewLayoutPersistMutation() {
  const queryClient = useQueryClient();

  return useMutation<DiagramLayout, Error, PersistViewLayoutInput>({
    mutationFn: async ({ viewName, records }) => {
      const layout = await api.canvasLayout.setViewLayout(viewName, records);
      const persisted = await api.canvasLayout.getViewLayout(
        viewName,
        records.map((record) => record.source),
      );
      const byNodeId = new Map(persisted.map((record) => [record.nodeId, record]));
      const matched = records.filter((record) => {
        const saved = byNodeId.get(record.source.nodeId);
        return saved?.x === record.x && saved.y === record.y;
      }).length;
      if (matched !== records.length) {
        throw new Error(`Only ${matched}/${records.length} model positions could be persisted`);
      }
      return layout;
    },
    onSettled: async (_layout, _error, { viewName }) => {
      // A failed verification may still mean the backend persisted a subset, so
      // refresh the query on both success and failure.
      await queryClient.invalidateQueries({
        queryKey: ['canvasLayout.getViewLayout', viewName],
      });
    },
  });
}
