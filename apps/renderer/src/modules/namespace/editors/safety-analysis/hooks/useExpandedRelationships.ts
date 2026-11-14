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
import { useQueries } from '@tanstack/react-query';
import type { AggregatedRelationshipsResult } from '@riacore/app-contracts';
import { api } from '../../../../../api/riacore';
import { useWorkspaceQueryEnabled } from '../../../../../hooks/useWorkspaceQueryEnabled';

/**
 * The rollups for elements the reader expanded inside the CGraph lens, one
 * query each.
 *
 * `useQueries` rather than one query per expansion component, because the set
 * is dynamic — a reader expands and collapses boxes while the canvas stays
 * mounted, and hooks cannot be called conditionally.
 *
 * The key is deliberately identical to {@link useAggregatedRelationships}'s, so
 * the two share one cache entry: expanding an element and later selecting it
 * reuses the same read, and vice versa. That is also why `depth` is a parameter
 * rather than a constant — every expansion is taken at the view's current
 * depth, because a count is relative to the depth that produced it and mixing
 * two depths in one drawing would put incomparable numbers on neighbouring
 * edges.
 *
 * Expanding is the cheap direction. A leaf's subtree is one node, so the
 * descendant walk returns nothing and both boundary queries carry a one-element
 * list; cost tracks the element's own edge count rather than the corpus. The
 * expensive rollups are wide containers, which is what the selection itself
 * already is.
 */
export function useExpandedRelationships(
  nodeIds: readonly number[],
  workspaceKey: string | null,
  depth: number,
) {
  const workspaceEnabled = useWorkspaceQueryEnabled();
  const enabled = workspaceEnabled && workspaceKey !== null;
  return useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: ['safety.aggregatedRelationships', workspaceKey, nodeId, depth],
      queryFn: () => api.safety.getAggregatedRelationships(nodeId, depth),
      enabled,
      staleTime: 0,
      refetchOnWindowFocus: true,
    })),
  });
}

/**
 * The loaded rollups, in the order their elements were expanded, with the ones
 * still in flight left out.
 *
 * Separate from the hook so the canvas can render the expansions that have
 * arrived rather than waiting for all of them — each is an independent read of
 * an independent element, and a slow one should not hold back a fast one.
 */
export function loadedExpansions(
  queries: readonly { data?: AggregatedRelationshipsResult }[],
): AggregatedRelationshipsResult[] {
  return queries
    .map((query) => query.data)
    .filter((data): data is AggregatedRelationshipsResult => data !== undefined);
}
