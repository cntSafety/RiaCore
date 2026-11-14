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
import { api } from '../../../../../api/riacore';
import { useWorkspaceQueryEnabled } from '../../../../../hooks/useWorkspaceQueryEnabled';

/**
 * Backs the "Architecture" lens: a container's cross-boundary relationships,
 * rolled up to its sibling containers.
 *
 * `depth` is part of the query key, not just the request. The payload's shape
 * changes with it — above 1 the partners carry containment parents and the
 * edges terminate deeper — so a cached result from another depth is not a
 * stale version of this one, it is a different answer, and reusing it would
 * draw frames the layout was not computed for.
 */
export function useAggregatedRelationships(nodeId: number, workspaceKey: string | null, depth = 1) {
  const workspaceEnabled = useWorkspaceQueryEnabled();
  const query = useQuery({
    queryKey: ['safety.aggregatedRelationships', workspaceKey, nodeId, depth],
    queryFn: () => api.safety.getAggregatedRelationships(nodeId, depth),
    enabled: workspaceEnabled && workspaceKey !== null,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  return { ...query, available: workspaceEnabled && workspaceKey !== null };
}
