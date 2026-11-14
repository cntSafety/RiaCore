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

/** A stored relationship connected to an element, relative to that element. */
export interface RelationshipData {
  edge_id: number;
  relationship: string;
  metamodel: string;
  direction: 'outgoing' | 'incoming';
  type: 'intra' | 'cross';
  connectedNode: {
    node_id: number;
    namespace: string;
    concept: string;
    name: string;
    identifier?: string;
    /** Used to match the tree's malfunction icon color. */
    asil?: string;
  };
}

/** One box in an aggregated relationship diagram: the selected container or one of its partners. */
export interface AggregatedRelationshipContainer {
  node_id: number;
  namespace: string;
  concept: string;
  name: string;
  /**
   * The container this one is nested in, within this result — its immediate
   * containment parent, which may be the `root`.
   *
   * Absent at `depth: 1`, where every partner is reported at one level and
   * nothing nests. At a greater depth it is what turns the flat partner list
   * into the containment forest the nested layout draws: a container with no
   * `parentContainerId` is a top-level frame, and one with a parent is reported
   * *inside* that frame. Every id named here is itself present in
   * {@link AggregatedRelationshipsResult.containers} or is the root, so a
   * consumer can always walk the chain to a top-level box.
   */
  parentContainerId?: number;
}

/**
 * One aggregated, directed edge between two containers in an
 * {@link AggregatedRelationshipsResult}: every underlying relationship of this
 * type between a descendant of `sourceContainerId` and a descendant of
 * `targetContainerId` is folded into this single count.
 *
 * Both endpoints always name the *deepest* container the requested depth
 * allows, so a count is relative to the depth that produced it: the same ten
 * calls reported as one edge at `depth: 1` are reported as several, summing to
 * ten, at `depth: 2`.
 */
export interface AggregatedRelationshipEdge {
  sourceContainerId: number;
  targetContainerId: number;
  relationship: string;
  count: number;
}

/**
 * A layered-architecture-style rollup of a container's (e.g. a C module/
 * directory or file) relationships to its sibling containers, used by the
 * "Architecture" lens. Every relationship whose endpoints both sit inside the
 * selected container's own subtree is left out — those are shown by the tree
 * itself — only edges that cross the subtree boundary are aggregated here,
 * each rolled up to the partner's own container at the same tree level as the
 * selected one.
 *
 * `depth` relaxes that last part, and only that part. The boundary, the
 * internal-edge exclusion, and the set of underlying relationships are
 * identical at every depth; what changes is how far back *down* the containment
 * chain each endpoint is reported, which is what lets a consumer draw nested
 * frames instead of one box per module.
 */
export interface AggregatedRelationshipsResult {
  root: AggregatedRelationshipContainer;
  /**
   * Every container named by an edge, plus — above `depth: 1` — the containment
   * ancestors needed to nest them, each carrying its `parentContainerId`.
   * Excludes `root`, which is reported separately and is the implicit parent of
   * any container whose `parentContainerId` is the root's `node_id`.
   */
  containers: AggregatedRelationshipContainer[];
  edges: AggregatedRelationshipEdge[];
  /**
   * True when the descendant walk hit its safety cap before exhausting the
   * subtree — the result reflects only the nodes visited, not the whole tree.
   */
  truncated: boolean;
  /**
   * The depth actually applied. 1 is the flat rollup; each further level
   * reports both endpoints of every edge one containment step deeper, where
   * such a step exists.
   */
  depth: number;
  /**
   * The depth that was asked for, after clamping to the channel's ceiling.
   *
   * Greater than `depth` when the deeper levels were too large to return — what
   * a level costs depends on the selection, not on the number, so the request
   * is honoured where it can be and reduced where it cannot. A consumer should
   * say so rather than silently showing a shallower picture than the one asked
   * for.
   */
  requestedDepth: number;
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
  /** A displayed member of this usage's definition; node_id remains the declaration. */
  isReference?: boolean;
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

/**
 * One level of a node's location in the tree: where a node sits inside its
 * parent's ordered, visible children.
 */
export interface TreeNodeLocationLevel {
  /** The parent whose children contain `nodeId`; `undefined` for namespace roots. */
  parentNodeId?: number;
  /** The ancestor at this level, or — on the last level — the located node itself. */
  nodeId: number;
  /**
   * Zero-based index of `nodeId` within its parent's ordered, visible children.
   * This is the same ordering and visibility filter `namespaces.getChildren`
   * pages over, so a client can load pages `0..floor(childIndex / pageSize)` to
   * materialize the element instead of walking pages until it appears.
   */
  childIndex: number;
  /** Visible children under `parentNodeId`, matching `GetChildrenResponse.totalCount`. */
  totalCount: number;
}

/** Root-to-node location in the paginated tree, used to reveal an element. */
export interface TreeNodeLocation {
  namespace: string;
  nodeId: number;
  /** Ordered root → node. Truncated at the first level that could not be resolved. */
  levels: TreeNodeLocationLevel[];
  /**
   * True when every level resolved, the located node included. False means the
   * node is not reachable through containment under the requested visibility —
   * an orphan, a concept hidden by the display settings, or a cross-namespace
   * authored element that appears as a reference child rather than a
   * containment child. Callers must then fall back to their own resolution.
   */
  resolved: boolean;
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
  /** Create and attach to this existing element in one transaction. */
  targetNodeId?: number;
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


