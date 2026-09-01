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
// ---------------------------------------------------------------------------
// Safety domain types re-exported for renderer consumption.
// These mirror the types in app-core/safety-commands.ts so the renderer
// can reference them without depending on app-core directly.
// ---------------------------------------------------------------------------

export interface ConceptInstanceData {
  node_id: number;
  namespace: string;
  concept: string;
  metamodel: string;
  attributes: Record<string, unknown>;
}

export interface MalfunctionData extends ConceptInstanceData {
  riskRating?: ConceptInstanceData | null;
  occursAtTarget?: { node_id: number; namespace: string; concept: string; name?: string } | null;
  propagationScope?: {
    rootNodeId: number;
    structuralNodeIds: number[];
  } | null;
}

/**
 * A malfunction returned by getPropagations, enriched with its occursAtTarget
 * so the UI can offer "Show Reference in Tree" navigation.
 */
export interface PropagationMalfunctionData extends ConceptInstanceData {
  occursAtTarget?: { node_id: number; namespace: string; concept: string; name?: string } | null;
}

export interface CreateMalfunctionParams {
  namespace: string;
  name: string;
  description: string;
  occursAtNodeId?: number;
  asil?: string;
}

export interface CreateRiskRatingParams {
  failureModeNodeId: number;
  // Severity/Occurrence/Detection are optional: FMEA profiles always supply
  // them, but SOTIF creates a note-only risk rating (residual-risk argument)
  // and omits them so no S/O/D/RPN is persisted or exported.
  severity?: string;
  occurrence?: string;
  detection?: string;
  note?: string;
}

export interface ReviewItemData extends ConceptInstanceData {
  suspect?: boolean;
}

export interface TreeChildNode {
  node_id: number;
  concept: string;
  name: string;
  hasChildren: boolean;
  asil: string; // "" for non-malfunction nodes
}

/** A cross-namespace reference attached to a structural element. */
export interface TreeReferenceNode {
  node_id: number;
  concept: string;
  name: string;
  sourceNamespace: string;
  relationship: string; // e.g. 'occurs_at', 'has_notes', 'has_tag'
  asil: string; // "" for non-malfunction nodes
}

/** Extended getChildren response including cross-namespace references. */
export interface GetChildrenResponse {
  children: TreeChildNode[];
  references: TreeReferenceNode[];
  totalCount: number;
  offset: number;
  hasMore: boolean;
}

export interface DeleteImpactPreview {
  element: { node_id: number; concept: string; name: string };
  ownedChildren: { node_id: number; concept: string; name: string }[];
  reviewItems: { node_id: number; name: string }[];
  relationships: { edge_id: number; relationship: string; type: 'intra' | 'cross' }[];
  totalElements: number;
  totalRelationships: number;
}

export interface SearchResultNode {
  nodeId: number;
  namespace: string;
  concept: string;
  name: string;
  nodeType: 'model' | 'malfunction' | 'safety-note' | 'safety-task' | 'requirement' | 'review-item';
  ancestorPath: number[];
  /** For cross-namespace authored elements, the structural node in the imported
   *  namespace they are attached to (via occurs_at, attached_to, etc.).
   *  null for structural nodes that live in their own namespace. */
  crossNsTarget?: { nodeId: number; namespace: string } | null;
}

export interface SearchResult {
  results: SearchResultNode[];
  totalCount: number;
  hasMore: boolean;
}

export interface CreateTagParams {
  namespace: string;
  name: string;
  description?: string;
  color?: string;
}

/**
 * A structural node (component or port) that is the scope root or a direct child of it.
 * Included in ScopedPropagationResult so the table can show all ports even when they
 * have no malfunctions attached.
 */
export interface ScopedStructuralNode {
  node_id: number;
  namespace: string;
  concept: string;
  /** Display name derived from short_name / has_name attributes. */
  name: string;
  /**
   * For direct children (ports), the node_id of their parent (the scope root).
   * Null for the scope root itself.
   */
  parentNodeId: number | null;
  /** Display name of the parent component. Null for the scope root itself. */
  parentName: string | null;
}

/**
 * Scoped propagation graph for a structural component and its descendants.
 * Used by the "Propagation" lens when a port/SWC is selected in the tree.
 */
export interface ScopedPropagationResult {
  /** Malfunctions that occurs_at the component or its descendants */
  internalNodes: PropagationMalfunctionData[];
  /** Malfunctions outside the component that have propagation edges to/from internal nodes */
  boundaryNodes: PropagationMalfunctionData[];
  /** All propagation edges between internal nodes */
  internalEdges: Array<{ source: number; target: number }>;
  /** Propagation edges crossing the boundary (one end internal, one end external) */
  boundaryEdges: Array<{ source: number; target: number }>;
  /**
   * All structural nodes in scope: the root component plus its direct children (ports).
   * Included so the table can render rows for ports that have no malfunctions attached.
   */
  structuralNodes: ScopedStructuralNode[];
}


