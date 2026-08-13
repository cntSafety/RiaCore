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
 * Shared diff and merge types for the RIA Graph Diff and Merge feature.
 * Used by app-core (algorithm), app-contracts (IPC), and renderer (UI).
 */

// ── Fundamental change primitives ─────────────────────────────────────────────

export interface PropertyChange {
  attribute: string;
  changeKind: 'added' | 'deleted' | 'modified';
  /** undefined when changeKind === 'added' */
  leftValue: unknown;
  /** undefined when changeKind === 'deleted' */
  rightValue: unknown;
}

// ── Snapshot types (one side of the diff) ────────────────────────────────────

export interface NodeSnapshot {
  stableId: string;
  conceptType: string;
  namespace: string;
  attributes: Record<string, unknown>;
}

export interface EdgeSnapshot {
  sourceStableId: string;
  targetStableId: string;
  relationshipType: string;
  namespace: string;
  attributes: Record<string, unknown>;
}

export interface CrossNsEdgeSnapshot {
  sourceStableId: string;
  sourceNamespace: string;
  targetStableId: string;
  targetNamespace: string;
  relationshipType: string;
  attributes: Record<string, unknown>;
  /** Human-readable label for the source node, resolved from the source namespace. */
  sourceLabel?: string;
  /** Human-readable label for the target node, resolved from the target namespace. */
  targetLabel?: string;
}

// ── Modification records (both sides plus the delta) ─────────────────────────

export interface NodeModification {
  stableId: string;
  conceptType: string;
  propertyChanges: PropertyChange[];
  /** Snapshot of the node from the LEFT namespace */
  leftSnapshot: NodeSnapshot;
  /** Snapshot of the node from the RIGHT namespace */
  rightSnapshot: NodeSnapshot;
}

export interface EdgeModification {
  sourceStableId: string;
  targetStableId: string;
  relationshipType: string;
  namespace: string;
  propertyChanges: PropertyChange[];
  leftSnapshot: EdgeSnapshot;
  rightSnapshot: EdgeSnapshot;
}

export interface CrossNsEdgeModification {
  sourceStableId: string;
  sourceNamespace: string;
  targetStableId: string;
  targetNamespace: string;
  relationshipType: string;
  propertyChanges: PropertyChange[];
  leftSnapshot: CrossNsEdgeSnapshot;
  rightSnapshot: CrossNsEdgeSnapshot;
}

// ── Skipped nodes ─────────────────────────────────────────────────────────────

export interface SkippedNode {
  conceptType: string;
  namespace: string;
  attributes: Record<string, unknown>;
  reason: string;
}

// ── Partial diff scope metadata ───────────────────────────────────────────────

export interface DiffScope {
  leftRootStableId: string;
  rightRootStableId: string;
  containmentRelationshipTypes: string[];
}

// ── Options for diff computation ──────────────────────────────────────────────

export interface DiffOptions {
  /** Restrict diff to sub-tree rooted at this stable ID in the left namespace */
  leftRootStableId?: string;
  /** Restrict diff to sub-tree rooted at this stable ID in the right namespace */
  rightRootStableId?: string;
  /** Relationship types to traverse for sub-tree discovery.
   *  If empty and rootStableId is set, all relationship types are used. */
  containmentRelationshipTypes?: string[];
  /**
   * Include cross-namespace relationships in the diff. Defaults to true.
   * Supervised re-imports disable this because their temporary namespace only
   * contains importer-owned data; authored workspace annotations must remain
   * attached to the original namespace instead of appearing as deletions.
   */
  includeCrossNamespaceEdges?: boolean;
}

// ── Full diff result (kept server-side; accessed via getDiffResult + getResultPage) ──

export interface NamespaceDiffResult {
  diffId: string;
  leftNamespace: string;
  rightNamespace: string;
  metamodel: string;
  computedAt: string;

  // Node-level changes
  addedNodes: NodeSnapshot[];
  deletedNodes: NodeSnapshot[];
  modifiedNodes: NodeModification[];

  // Intra-namespace edge changes
  addedEdges: EdgeSnapshot[];
  deletedEdges: EdgeSnapshot[];
  modifiedEdges: EdgeModification[];

  // Cross-namespace edge changes
  addedCrossNsEdges: CrossNsEdgeSnapshot[];
  deletedCrossNsEdges: CrossNsEdgeSnapshot[];
  modifiedCrossNsEdges: CrossNsEdgeModification[];

  // Nodes whose concept type could not be identified (skipped)
  skippedNodes: SkippedNode[];

  scope?: DiffScope;
}

// ── Summary returned over IPC after computing a diff (paginated design) ────────

/**
 * Lightweight summary returned by diff.computeNamespaces / diff.computeFromPaths /
 * diff.computeHybrid. Contains only counts and the diffId — no large arrays.
 * The full arrays are accessible server-side via diff.getResultPage.
 */
export interface DiffSummary {
  diffId: string;
  leftNamespace: string;
  rightNamespace: string;
  metamodel: string;
  computedAt: string;

  addedNodesCount: number;
  deletedNodesCount: number;
  modifiedNodesCount: number;

  addedEdgesCount: number;
  deletedEdgesCount: number;
  modifiedEdgesCount: number;

  addedCrossNsEdgesCount: number;
  deletedCrossNsEdgesCount: number;
  modifiedCrossNsEdgesCount: number;

  skippedNodesCount: number;

  /** True when total changed elements exceed a large-dataset threshold */
  largeDatasetWarning: boolean;

  scope?: DiffScope;
}

// ── Section key for paginated access ─────────────────────────────────────────

export type DiffResultSection =
  | 'addedNodes'
  | 'deletedNodes'
  | 'modifiedNodes'
  | 'addedEdges'
  | 'deletedEdges'
  | 'modifiedEdges'
  | 'addedCrossNsEdges'
  | 'deletedCrossNsEdges'
  | 'modifiedCrossNsEdges'
  | 'skippedNodes';

/** A page of items from a diff result section */
export interface DiffResultPage {
  /** Typed item union — cast to the correct type for the requested section */
  items: (NodeSnapshot | NodeModification | EdgeSnapshot | EdgeModification | CrossNsEdgeSnapshot | CrossNsEdgeModification | SkippedNode)[];
  totalCount: number;
  offset: number;
  hasMore: boolean;
  /** The section name for round-trip verification */
  section: DiffResultSection;
}

// ── Merge types ───────────────────────────────────────────────────────────────

export interface MergeResult {
  targetNamespace: string;
  direction: 'left-into-right' | 'right-into-left';
  appliedAt: string;
  nodesAdded: number;
  nodesDeleted: number;
  nodesModified: number;
  edgesAdded: number;
  edgesDeleted: number;
  edgesModified: number;
  /** Number of changes skipped due to selectionIds filtering or pre-condition failure */
  skipped: number;
  warnings: string[];
  /** True if the transaction was committed; false if it was rolled back or only partially applied */
  mergeApplied: boolean;
}

// ── Union merge types (UC-13, UC-14) ─────────────────────────────────────────

export interface UnionMergeResult {
  namespace: string;
  source: 'files' | 'branch';
  /** Git branch name when source is 'branch', undefined otherwise */
  sourceBranch?: string;
  mergedAt: string;
  nodesAdded: number;
  nodesUpdated: number;
  edgesAdded: number;
  edgesUpdated: number;
  /** Edges skipped because one or both endpoints were missing after node merge */
  edgesSkipped: number;
  crossNsEdgesAdded: number;
  crossNsEdgesUpdated: number;
  /** Cross-namespace edges skipped because one or both endpoints were missing */
  crossNsEdgesSkipped: number;
  warnings: string[];
  mergeApplied: boolean;
}

export interface NamespaceSyncStatus {
  namespace: string;
  inSync: boolean;
  /** Lightweight summary of differences, null when inSync is true */
  diffSummary: DiffSummary | null;
}

/**
 * Result returned by namespace.supervisedMergeFromBranchPrepare (UC-15).
 * Contains the cached diff and metadata needed for the supervised merge review phase.
 */
export interface SupervisedMergePrepareResult {
  /** Server-side cache key for the computed diff */
  diffId: string;
  /** Lightweight summary (counts only) */
  diffSummary: DiffSummary;
  /** Full commit hash of the resolved branchRef */
  resolvedCommitHash: string;
  /** Short (7-char) commit hash for display */
  resolvedShortHash: string;
  /** Absolute path to the temporary checkout directory */
  tempDir: string;
  /** Present when the live namespace has unsaved changes vs. the on-disk snapshot */
  syncWarning?: string;
}

// ── Three-way diff types ──────────────────────────────────────────────────────

export type ConflictType =
  | 'node-deleted-in-left-modified-in-right'
  | 'node-deleted-in-right-modified-in-left'
  | 'node-attribute-conflict'
  | 'edge-deleted-in-left-modified-in-right'
  | 'edge-deleted-in-right-modified-in-left'
  | 'edge-attribute-conflict';

export interface ConflictRecord {
  conflictType: ConflictType;
  elementKind: 'node' | 'edge' | 'crossNsEdge';
  /** Stable ID for nodes; composite key string for edges */
  stableId: string;
  /** Populated for attribute-level conflicts */
  attribute?: string;
  baseValue: unknown;
  leftValue: unknown;
  rightValue: unknown;
  resolution?: 'accept-left' | 'accept-right' | 'manual';
  resolvedValue?: unknown;
}

/** A reference to a specific change within a NamespaceDiffResult */
export interface ChangeReference {
  elementKind: 'node' | 'edge' | 'crossNsEdge';
  stableId: string;
  changeKind: 'added' | 'deleted' | 'modified';
}

export interface ThreeWayDiffResult {
  diffId: string;
  baseNamespace: string;
  leftVariant: string;
  rightVariant: string;
  metamodel: string;
  computedAt: string;

  /** diff(base, left) */
  leftChanges: NamespaceDiffResult;
  /** diff(base, right) */
  rightChanges: NamespaceDiffResult;

  conflicts: ConflictRecord[];
  nonConflictingLeftChanges: ChangeReference[];
  nonConflictingRightChanges: ChangeReference[];
}

/**
 * Lightweight summary for three-way diff (same pattern as DiffSummary).
 * The full result is accessible server-side via diff.getThreeWayResult.
 */
export interface ThreeWayDiffSummary {
  diffId: string;
  baseNamespace: string;
  leftVariant: string;
  rightVariant: string;
  metamodel: string;
  computedAt: string;

  leftAddedNodesCount: number;
  leftDeletedNodesCount: number;
  leftModifiedNodesCount: number;

  rightAddedNodesCount: number;
  rightDeletedNodesCount: number;
  rightModifiedNodesCount: number;

  conflictCount: number;
  nonConflictingLeftCount: number;
  nonConflictingRightCount: number;

  largeDatasetWarning: boolean;
}

/** Parameters for applying conflict resolutions */
export interface ConflictResolution {
  stableId: string;
  resolution: 'accept-left' | 'accept-right' | 'manual';
  resolvedValue?: unknown;
}
