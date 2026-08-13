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
/**
 * usePropagationGraph - Hook that orchestrates recursive BFS traversal
 * of the propagation graph using TanStack Query for caching.
 *
 * This file exports:
 * - `buildPropagationGraph`: Pure async BFS traversal algorithm (testable independently)
 * - `usePropagationGraph`: React hook that wraps the traversal with TanStack Query
 * - Interfaces: `PropagationGraphResult`, `PropagationGraphNode`, `PropagationGraphEdge`
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PropagationMalfunctionData } from '@riacore/app-contracts';
import { api } from '../../../../../api/riacore';

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface PropagationGraphNode {
  id: string; // node_id as string (React Flow requirement)
  nodeId: number;
  name: string;
  description: string;
  namespace: string;
  concept: string;
  asil: string;
  occursAtTarget?: { node_id: number; namespace: string; concept: string; name?: string } | null;
  isEntry: boolean;
  isTruncated: boolean;
}

export interface PropagationGraphEdge {
  id: string; // `${sourceId}-${targetId}`
  source: string;
  target: string;
}

export interface PropagationGraphResult {
  nodes: PropagationGraphNode[];
  edges: PropagationGraphEdge[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// BFS traversal algorithm
// ---------------------------------------------------------------------------

/**
 * Builds the full propagation graph starting from an entry node using BFS traversal.
 *
 * Traverses both `propagatesTo` (forward/downstream) and `propagatesFrom` (backward/upstream)
 * directions. Handles cycles via a visited set — back-edges are recorded without re-traversal.
 * Nodes at the depth boundary are marked as truncated.
 *
 * @param entryNodeId - The starting malfunction node ID
 * @param getPropagations - Function that fetches propagation data for a given node
 * @param maxDepth - Maximum traversal depth (default 10)
 * @returns Object containing discovered nodes, edges, and truncated node IDs
 */
export async function buildPropagationGraph(
  entryNodeId: number,
  getPropagations: (nodeId: number) => Promise<{
    propagatesTo: PropagationMalfunctionData[];
    propagatesFrom: PropagationMalfunctionData[];
  }>,
  maxDepth: number = 10,
): Promise<{
  nodes: Map<number, PropagationMalfunctionData>;
  edges: Set<string>;
  truncated: Set<number>;
}> {
  const visited = new Set<number>();
  const nodes = new Map<number, PropagationMalfunctionData>();
  const edges = new Set<string>(); // "sourceId->targetId"
  const truncated = new Set<number>();

  const queue: Array<{ nodeId: number; depth: number }> = [{ nodeId: entryNodeId, depth: 0 }];

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    if (depth >= maxDepth) {
      truncated.add(nodeId);
      continue;
    }

    const result = await getPropagations(nodeId);

    for (const target of result.propagatesTo) {
      nodes.set(target.node_id, target);
      edges.add(`${nodeId}->${target.node_id}`);
      if (!visited.has(target.node_id)) {
        queue.push({ nodeId: target.node_id, depth: depth + 1 });
      }
    }

    for (const source of result.propagatesFrom) {
      nodes.set(source.node_id, source);
      edges.add(`${source.node_id}->${nodeId}`);
      if (!visited.has(source.node_id)) {
        queue.push({ nodeId: source.node_id, depth: depth + 1 });
      }
    }
  }

  return { nodes, edges, truncated };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * React hook that orchestrates the propagation graph traversal using TanStack Query.
 *
 * Uses a composite query key `['propagationGraph', entryNodeId]` for the full result.
 * Internally leverages `queryClient.fetchQuery` with key `['safety.propagations', nodeId]`
 * for each individual node, enabling cache reuse across different entry points.
 *
 * @param entryNodeId - The entry malfunction node ID, or null/undefined to disable
 * @returns PropagationGraphResult with nodes, edges, loading, and error state
 */
export function usePropagationGraph(
  entryNodeId: number | undefined | null,
  maxDepth: number = 1,
): PropagationGraphResult {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['propagationGraph', entryNodeId, maxDepth],
    queryFn: async () => {
      const nodeId = entryNodeId!;

      // Wrapper that caches individual node propagation results
      const getPropagationsWithCache = async (id: number) => {
        return queryClient.fetchQuery({
          queryKey: ['safety.propagations', id],
          queryFn: () => api.safety.getPropagations(id),
        });
      };

      // Run BFS traversal
      const graphResult = await buildPropagationGraph(
        nodeId,
        getPropagationsWithCache,
        maxDepth,
      );

      // Fetch entry node's own data (already cached from traversal or malfunction query)
      const entryMalfunctionData = await queryClient.fetchQuery({
        queryKey: ['safety.malfunction', nodeId],
        queryFn: () => api.safety.getMalfunction(nodeId),
      });

      // Convert the entry node into a PropagationGraphNode
      const entryNode: PropagationGraphNode = {
        id: String(nodeId),
        nodeId,
        name: String(entryMalfunctionData.attributes.has_name ?? ''),
        description: String(entryMalfunctionData.attributes.malfunction_description ?? ''),
        namespace: entryMalfunctionData.namespace,
        concept: entryMalfunctionData.concept,
        asil: String(entryMalfunctionData.attributes.malfunction_asil ?? 'QM'),
        occursAtTarget: entryMalfunctionData.occursAtTarget ?? null,
        isEntry: true,
        isTruncated: graphResult.truncated.has(nodeId),
      };

      // Convert discovered neighbor nodes into PropagationGraphNode[]
      const neighborNodes: PropagationGraphNode[] = Array.from(
        graphResult.nodes.entries(),
      ).map(([id, data]) => ({
        id: String(id),
        nodeId: id,
        name: String(data.attributes.has_name ?? ''),
        description: String(data.attributes.malfunction_description ?? ''),
        namespace: data.namespace,
        concept: data.concept,
        asil: String(data.attributes.malfunction_asil ?? 'QM'),
        occursAtTarget: data.occursAtTarget ?? null,
        isEntry: false,
        isTruncated: graphResult.truncated.has(id),
      }));

      // Combine entry node with neighbors (entry node may also appear in nodes map
      // if it was referenced by a neighbor's propagatesTo/From — deduplicate by id)
      const nodesMap = new Map<string, PropagationGraphNode>();
      nodesMap.set(entryNode.id, entryNode);
      for (const node of neighborNodes) {
        if (!nodesMap.has(node.id)) {
          nodesMap.set(node.id, node);
        }
        // If the entry node appears in neighbors, keep the entry version (isEntry: true)
      }
      const nodes = Array.from(nodesMap.values());

      // Convert edges Set<string> ("sourceId->targetId") into PropagationGraphEdge[]
      const edges: PropagationGraphEdge[] = Array.from(graphResult.edges).map(
        (edgeStr) => {
          const [source, target] = edgeStr.split('->');
          return {
            id: `${source}-${target}`,
            source,
            target,
          };
        },
      );

      return { nodes, edges };
    },
    enabled: entryNodeId != null,
  });

  return {
    nodes: data?.nodes ?? [],
    edges: data?.edges ?? [],
    isLoading,
    isError,
    error: error as Error | null,
  };
}
