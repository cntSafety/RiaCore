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
 * FailurePropagationDiagram — malfunction-centric propagation view.
 *
 * Thin data wrapper: fetches the BFS propagation graph starting from the
 * entry malfunction, computes isBoundary for each neighbour, and delegates
 * all rendering to the shared PropagationCanvas component.
 *
 * Scope rule:
 *   Entry malfunction                          → isBoundary: false, isEntry: true
 *   Nodes attached to the same structural node → isBoundary: false
 *   Nodes attached to a different structure   → isBoundary: true  (faded)
 *   Nodes without an occursAt target           → isBoundary: false (conservative)
 */

import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Empty } from 'antd';
import type { MalfunctionData } from '@riacore/app-contracts';
import { usePropagationGraph } from '../hooks/usePropagationGraph';
import { useMalfunction } from '../hooks/useSafetyQueries';
import {
  PropagationCanvas,
  type PropagationCanvasNode,
  type PropagationCanvasEdge,
} from './PropagationCanvas';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FailurePropagationDiagramProps {
  /** The entry malfunction node ID to start traversal from. */
  entryNodeId: number;
  /** Safety namespace for mutations. */
  namespace: string;
  /** Workspace key for cache invalidation. */
  workspaceKey: string | null;
  /** Navigate to a node in the tree. */
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /** Navigate to a reference in the tree. */
  onNavigateToReference?: (
    refNodeId: number, refNamespace: string, refConcept: string,
    hostNodeId: number, hostNamespace: string,
  ) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FailurePropagationDiagram({
  entryNodeId,
  namespace,
  workspaceKey: _workspaceKey,
  onNavigateToNode,
  onNavigateToReference,
}: FailurePropagationDiagramProps) {
  const queryClient = useQueryClient();
  const malfunctionQuery = useMalfunction(entryNodeId);
  const malfunctionData = malfunctionQuery.data as (MalfunctionData & {
    propagationScope?: { rootNodeId: number; structuralNodeIds: number[] } | null;
  }) | undefined;
  const {
    nodes: graphNodes,
    edges: graphEdges,
    isLoading,
    isError,
    error,
  } = usePropagationGraph(entryNodeId);

  // Normalise PropagationGraphNode[] → PropagationCanvas types.
  // isBoundary is derived from the entry malfunction's component scope:
  // the owning component plus its direct structural children.
  const { canvasNodes, canvasEdges } = useMemo(() => {
    const structuralScopeIds = new Set(
      malfunctionData?.propagationScope?.structuralNodeIds ?? [],
    );
    const hasStructuralScope = structuralScopeIds.size > 0;

    const canvasNodes: PropagationCanvasNode[] = graphNodes.map((n) => ({
      id: n.id,
      nodeId: n.nodeId,
      name: n.name,
      description: n.description,
      namespace: n.namespace,
      concept: n.concept,
      asil: n.asil,
      occursAtTarget: n.occursAtTarget,
      isEntry: n.isEntry,
      // A node is out-of-scope when the malfunction entry resolves to a
      // component scope and this node occurs_at a structural target outside it.
      isBoundary:
        hasStructuralScope &&
        n.occursAtTarget != null &&
        !structuralScopeIds.has(n.occursAtTarget.node_id),
      isTruncated: n.isTruncated,
    }));

    const canvasEdges: PropagationCanvasEdge[] = graphEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    }));

    return { canvasNodes, canvasEdges };
  }, [graphNodes, graphEdges, malfunctionData?.propagationScope?.structuralNodeIds]);

  // Malfunction-centric empty state: entry exists but has no propagation neighbours
  if (!isLoading && canvasEdges.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <Empty description="No propagation relationships found for this malfunction." />
      </div>
    );
  }

  return (
    <PropagationCanvas
      nodes={canvasNodes}
      edges={canvasEdges}
      namespace={namespace}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onInvalidate={() =>
        queryClient.invalidateQueries({
          queryKey: ['propagationGraph', entryNodeId],
        })
      }
      onNavigateToNode={onNavigateToNode}
      onNavigateToReference={onNavigateToReference}
      emptyDescription="No propagation relationships found for this malfunction."
    />
  );
}
