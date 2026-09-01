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
 * ScopedPropagationDiagram — propagation view scoped to a structural element.
 *
 * Thin data wrapper: fetches ScopedPropagationResult, normalises it into the
 * PropagationCanvas node/edge format, and delegates all rendering to the
 * shared PropagationCanvas component.
 *
 * Scope rule:
 *   internalNodes → isBoundary: false  (attached to this component or its ports)
 *   boundaryNodes → isBoundary: true   (external — rendered faded)
 */

import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePropagationsForComponent } from '../hooks/useSafetyQueries';
import {
  PropagationCanvas,
  type PropagationCanvasNode,
  type PropagationCanvasEdge,
} from './PropagationCanvas';
import type { PropagationMalfunctionData } from '@riacore/app-contracts';

// ---------------------------------------------------------------------------
// Normalisation helper
// ---------------------------------------------------------------------------

function toCanvasNode(
  data: PropagationMalfunctionData,
  isBoundary: boolean,
): PropagationCanvasNode {
  return {
    id: String(data.node_id),
    nodeId: data.node_id,
    name: String(data.attributes.has_name ?? ''),
    description: String(data.attributes.malfunction_description ?? ''),
    namespace: data.namespace,
    concept: data.concept,
    asil: String(data.attributes.malfunction_asil ?? 'QM'),
    occursAtTarget: data.occursAtTarget ?? null,
    isEntry: false,
    isBoundary,
    isTruncated: false,
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ScopedPropagationDiagramProps {
  /** The structural node ID (port, SWC, etc.) to scope the diagram to. */
  structuralNodeId: number;
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

export function ScopedPropagationDiagram({
  structuralNodeId,
  namespace,
  workspaceKey: _workspaceKey,
  onNavigateToNode,
  onNavigateToReference,
}: ScopedPropagationDiagramProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = usePropagationsForComponent(structuralNodeId, namespace);

  // Normalise ScopedPropagationResult → PropagationCanvas types
  const { canvasNodes, canvasEdges } = useMemo(() => {
    if (!data) return { canvasNodes: [] as PropagationCanvasNode[], canvasEdges: [] as PropagationCanvasEdge[] };

    const canvasNodes: PropagationCanvasNode[] = [
      ...data.internalNodes.map((d) => toCanvasNode(d, false)),
      ...data.boundaryNodes.map((d) => toCanvasNode(d, true)),
    ];

    const canvasEdges: PropagationCanvasEdge[] = [
      ...data.internalEdges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: String(e.source),
        target: String(e.target),
      })),
      ...data.boundaryEdges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: String(e.source),
        target: String(e.target),
      })),
    ];

    return { canvasNodes, canvasEdges };
  }, [data]);

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
          queryKey: ['safety.propagationsForComponent', structuralNodeId],
        })
      }
      onNavigateToNode={onNavigateToNode}
      onNavigateToReference={onNavigateToReference}
      emptyDescription="No malfunctions with propagation relationships found for this component."
    />
  );
}
