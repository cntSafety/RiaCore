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
 * IDiffService — orchestrates namespace loading, optional sub-tree filtering,
 * and the node/edge diff algorithms to produce NamespaceDiffResult.
 *
 * Supports three input modes:
 *   - Live: both namespaces from the active graph database
 *   - Snapshot: both namespaces from serialized ria-data/ directories on disk
 *   - Hybrid: one live, one snapshot
 *
 * Also provides IThreeWayDiffService for computing three-way diffs with
 * full conflict classification (base, left variant, right variant).
 */

import { randomUUID } from 'node:crypto';
import type { IDbModule } from '../db/db-module.js';
import type {
  DiffOptions,
  NamespaceDiffResult,
  DiffSummary,
  ThreeWayDiffResult,
  ThreeWayDiffSummary,
  ConflictRecord,
  ConflictType,
  ChangeReference,
  NodeModification,
  EdgeModification,
  CrossNsEdgeModification,
  CrossNsEdgeSnapshot,
  EdgeEndpointPresentation,
} from '@riacore/app-contracts';
import { loadLiveNamespace, loadSnapshotNamespace } from './namespace-loader.js';
import { diffNodes } from './diff-nodes.js';
import { diffEdges } from './diff-edges.js';
import { filterToSubtree } from './subtree-filter.js';
import type { SerializedNamespace } from './diff-types.js';
import { extractNodeName } from '../dispatch/utils/node-name.js';
import { resolveStableIdFromMeta } from '../persistor/stable-id.js';

// ── Large-dataset threshold ────────────────────────────────────────────────────

const LARGE_DATASET_THRESHOLD = 50_000;

// ── Two-way diff service ──────────────────────────────────────────────────────

export interface IDiffService {
  diffNamespaces(params: {
    leftNs: string;
    rightNs: string;
    workingDir: string;
    opts?: DiffOptions;
  }): Promise<{ summary: DiffSummary; result: NamespaceDiffResult }>;

  diffFromPaths(params: {
    leftDir: string;
    leftNs: string;
    rightDir: string;
    rightNs: string;
    opts?: DiffOptions;
  }): Promise<{ summary: DiffSummary; result: NamespaceDiffResult }>;

  diffHybrid(params: {
    liveNs: string;
    snapshotDir: string;
    snapshotNs: string;
    liveIsLeft: boolean;
    workingDir: string;
    opts?: DiffOptions;
  }): Promise<{ summary: DiffSummary; result: NamespaceDiffResult }>;
}

export function createDiffService(dbModule: IDbModule): IDiffService {
  return {
    async diffNamespaces({ leftNs, rightNs, opts }) {
      const [left, right] = await Promise.all([
        loadLiveNamespace(leftNs, dbModule),
        loadLiveNamespace(rightNs, dbModule),
      ]);
      const { summary, result } = runDiff(left, right, opts);
      await enrichCrossNsLabels(result, left, right, dbModule);
      return { summary, result };
    },

    async diffFromPaths({ leftDir, leftNs, rightDir, rightNs, opts }) {
      const left = loadSnapshotNamespace(leftDir, leftNs);
      const right = loadSnapshotNamespace(rightDir, rightNs);
      // No DB available here, so cross-NS targets that live outside the two
      // compared namespaces stay unresolved — runDiff has already labelled
      // everything that the two loaded namespaces can account for.
      const { summary, result } = runDiff(left, right, opts);
      return { summary, result };
    },

    async diffHybrid({ liveNs, snapshotDir, snapshotNs, liveIsLeft, opts }) {
      const live = await loadLiveNamespace(liveNs, dbModule);
      const snapshot = loadSnapshotNamespace(snapshotDir, snapshotNs);
      const [left, right] = liveIsLeft ? [live, snapshot] : [snapshot, live];
      const { summary, result } = runDiff(left, right, opts);
      await enrichCrossNsLabels(result, left, right, dbModule);
      return { summary, result };
    },
  };
}

// ── Edge endpoint label enrichment ────────────────────────────────────────────

interface EndpointInfo {
  label: string;
  conceptType: string;
}

/** A stableId → endpoint presentation index over *every* node of a namespace. */
type EndpointIndex = Map<string, EndpointInfo>;

function parseAttrs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Index every concept instance of a namespace by its stable ID.
 *
 * Keyed with `resolveStableIdFromMeta` — the same function `namespace-loader`
 * uses to build its `node_id → stableId` map before substituting stable IDs
 * into edge endpoints. Sharing that function is what guarantees the keys here
 * match an edge's `source_stable_id` / `target_stable_id` by construction,
 * rather than relying on `stable_path` happening to be present.
 *
 * Crucially this covers *all* nodes, not only the ones that appear as changes,
 * so an edge between two unchanged elements still gets readable endpoints.
 */
function buildEndpointIndex(ns: SerializedNamespace): EndpointIndex {
  const index: EndpointIndex = new Map();
  for (const ci of ns.conceptInstances) {
    const concept = String(ci.concept ?? '');
    let stableId = '';
    try {
      stableId = resolveStableIdFromMeta(
        typeof ci.attributes === 'string' ? ci.attributes : JSON.stringify(ci.attributes ?? {}),
        concept,
        ns.nodeKeyAttrs,
      );
    } catch {
      // Concept type has no declared identity attribute — nothing to key on.
    }
    if (!stableId || index.has(stableId)) continue;
    const label = extractNodeName(parseAttrs(ci.attributes), concept);
    index.set(stableId, { label, conceptType: concept });
  }
  return index;
}

/**
 * Fill in endpoint presentation on one edge-like record, preferring `primary`
 * (the side the record was taken from) over `secondary`.
 *
 * Only ever writes a field that is still empty, so a label already supplied by
 * a more knowledgeable pass — e.g. the DB-backed cross-NS target lookup — wins.
 */
function applyEndpointPresentation(
  edge: EdgeEndpointPresentation & { sourceStableId: string; targetStableId: string },
  primary: EndpointIndex,
  secondary: EndpointIndex,
): void {
  const source = primary.get(edge.sourceStableId) ?? secondary.get(edge.sourceStableId);
  const target = primary.get(edge.targetStableId) ?? secondary.get(edge.targetStableId);
  if (source) {
    if (!edge.sourceLabel && source.label) edge.sourceLabel = source.label;
    if (!edge.sourceConceptType && source.conceptType) edge.sourceConceptType = source.conceptType;
  }
  if (target) {
    if (!edge.targetLabel && target.label) edge.targetLabel = target.label;
    if (!edge.targetConceptType && target.conceptType) edge.targetConceptType = target.conceptType;
  }
}

/**
 * Label every edge endpoint the two compared namespaces can account for.
 *
 * Synchronous and DB-free, so all three entry points (live, snapshot, hybrid)
 * get the same treatment. Added and modified edges resolve against the right
 * namespace first (that is where they exist); deleted edges resolve against the
 * left. Cross-NS targets that live in a third namespace stay unresolved here
 * and are picked up by `enrichCrossNsLabels` when a DB is available.
 */
export function enrichEdgeEndpoints(
  result: NamespaceDiffResult,
  left: SerializedNamespace,
  right: SerializedNamespace,
): void {
  const leftIndex = buildEndpointIndex(left);
  const rightIndex = buildEndpointIndex(right);

  for (const edge of result.addedEdges) applyEndpointPresentation(edge, rightIndex, leftIndex);
  for (const edge of result.deletedEdges) applyEndpointPresentation(edge, leftIndex, rightIndex);
  for (const mod of result.modifiedEdges) {
    applyEndpointPresentation(mod, rightIndex, leftIndex);
    applyEndpointPresentation(mod.leftSnapshot, leftIndex, rightIndex);
    applyEndpointPresentation(mod.rightSnapshot, rightIndex, leftIndex);
  }

  for (const edge of result.addedCrossNsEdges) applyEndpointPresentation(edge, rightIndex, leftIndex);
  for (const edge of result.deletedCrossNsEdges) applyEndpointPresentation(edge, leftIndex, rightIndex);
  for (const mod of result.modifiedCrossNsEdges) {
    applyEndpointPresentation(mod, rightIndex, leftIndex);
    applyEndpointPresentation(mod.leftSnapshot, leftIndex, rightIndex);
    applyEndpointPresentation(mod.rightSnapshot, rightIndex, leftIndex);
  }
}

/**
 * Extract a display label from node attributes using the metamodel-configured
 * attribute priority list, falling back to the generic heuristic.
 */
function extractLabelWithConfig(
  attrs: Record<string, unknown>,
  concept: string,
  displayAttrs: string[],
): string {
  for (const attr of displayAttrs) {
    const v = attrs[attr];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return extractNodeName(attrs, concept);
}

/**
 * Resolve cross-NS edge targets that live outside the two compared namespaces.
 *
 * `runDiff` has already labelled every endpoint the two loaded namespaces can
 * account for (see `enrichEdgeEndpoints`). What remains is the cross-NS target
 * in a *third* namespace, which only the DB can supply. Runs after runDiff and
 * only fills fields that are still empty.
 */
async function enrichCrossNsLabels(
  result: NamespaceDiffResult,
  _left: SerializedNamespace,
  _right: SerializedNamespace,
  dbModule: IDbModule,
): Promise<void> {
  const allEdges: CrossNsEdgeSnapshot[] = [
    ...result.addedCrossNsEdges,
    ...result.deletedCrossNsEdges,
    ...result.modifiedCrossNsEdges.map(m => m.rightSnapshot ?? m.leftSnapshot),
  ];

  // Collect unique target stable IDs that need resolution
  const targetIds = new Set<string>();
  for (const edge of allEdges) {
    if (edge.targetStableId && !edge.targetLabel) targetIds.add(edge.targetStableId);
  }
  if (targetIds.size === 0) return;

  // Cache metamodel → display_identifier_attrs to avoid repeated DB queries
  const metamodelDisplayCache = new Map<string, string[]>();

  async function getDisplayAttrs(metamodel: string): Promise<string[]> {
    if (metamodelDisplayCache.has(metamodel)) return metamodelDisplayCache.get(metamodel)!;
    const rows = await dbModule.runQuery(
      `MATCH (mm:RIA_META_Metamodel {name: $metamodel}) RETURN mm.profile_metadata AS profile_metadata`,
      { metamodel },
    );
    let attrs: string[] = [];
    const raw = rows[0]?.profile_metadata;
    if (raw) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const displayAttrs = parsed?.displayIdentifierAttrs;
        if (Array.isArray(displayAttrs)) attrs = displayAttrs.filter((v): v is string => typeof v === 'string');
      } catch { /* fall through to empty */ }
    }
    metamodelDisplayCache.set(metamodel, attrs);
    return attrs;
  }

  // Resolve each target node individually (cross-NS target counts are typically small)
  const targetInfoMap = new Map<string, EndpointInfo>();
  for (const stableId of targetIds) {
    try {
      const rows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.attributes CONTAINS $stableId
         RETURN ci.concept AS concept, ci.metamodel AS metamodel, ci.attributes AS attributes
         LIMIT 5`,
        { stableId },
      );
      for (const row of rows) {
        const attrs = JSON.parse(String(row.attributes ?? '{}')) as Record<string, unknown>;
        if (attrs.stable_path !== stableId) continue;
        const concept = String(row.concept ?? '');
        const displayAttrs = await getDisplayAttrs(String(row.metamodel ?? ''));
        const label = extractLabelWithConfig(attrs, concept, displayAttrs);
        if (label) { targetInfoMap.set(stableId, { label, conceptType: concept }); break; }
      }
    } catch {
      // Non-critical: leave label empty if lookup fails
    }
  }

  const applyTarget = (edge: CrossNsEdgeSnapshot | CrossNsEdgeModification): void => {
    if (!edge.targetStableId) return;
    const info = targetInfoMap.get(edge.targetStableId);
    if (!info) return;
    if (!edge.targetLabel) edge.targetLabel = info.label;
    if (!edge.targetConceptType) edge.targetConceptType = info.conceptType;
  };

  for (const edge of allEdges) applyTarget(edge);
  for (const mod of result.modifiedCrossNsEdges) {
    applyTarget(mod);
    applyTarget(mod.leftSnapshot);
    applyTarget(mod.rightSnapshot);
  }
}

// ── Three-way diff service ────────────────────────────────────────────────────

export interface IThreeWayDiffService {
  computeThreeWay(params: {
    baseNs: string;
    leftNs: string;
    rightNs: string;
    workingDir: string;
    opts?: DiffOptions;
  }): Promise<{ summary: ThreeWayDiffSummary; result: ThreeWayDiffResult }>;
}

export function createThreeWayDiffService(dbModule: IDbModule): IThreeWayDiffService {
  const diffSvc = createDiffService(dbModule);

  return {
    async computeThreeWay({ baseNs, leftNs, rightNs, opts }) {
      // Compute both pairwise diffs concurrently
      const [leftDiff, rightDiff] = await Promise.all([
        diffSvc.diffNamespaces({ leftNs: baseNs, rightNs: leftNs, workingDir: '', opts }),
        diffSvc.diffNamespaces({ leftNs: baseNs, rightNs: rightNs, workingDir: '', opts }),
      ]);

      const conflicts: ConflictRecord[] = [];
      const nonConflictingLeftChanges: ChangeReference[] = [];
      const nonConflictingRightChanges: ChangeReference[] = [];

      classifyConflicts(
        leftDiff.result,
        rightDiff.result,
        conflicts,
        nonConflictingLeftChanges,
        nonConflictingRightChanges,
      );

      const diffId = randomUUID();
      const computedAt = new Date().toISOString();

      const result: ThreeWayDiffResult = {
        diffId,
        baseNamespace: baseNs,
        leftVariant: leftNs,
        rightVariant: rightNs,
        metamodel: leftDiff.result.metamodel,
        computedAt,
        leftChanges: leftDiff.result,
        rightChanges: rightDiff.result,
        conflicts,
        nonConflictingLeftChanges,
        nonConflictingRightChanges,
      };

      const totalElements =
        leftDiff.result.addedNodes.length +
        leftDiff.result.deletedNodes.length +
        leftDiff.result.modifiedNodes.length +
        rightDiff.result.addedNodes.length +
        rightDiff.result.deletedNodes.length +
        rightDiff.result.modifiedNodes.length;

      const summary: ThreeWayDiffSummary = {
        diffId,
        baseNamespace: baseNs,
        leftVariant: leftNs,
        rightVariant: rightNs,
        metamodel: result.metamodel,
        computedAt,
        leftAddedNodesCount: leftDiff.result.addedNodes.length,
        leftDeletedNodesCount: leftDiff.result.deletedNodes.length,
        leftModifiedNodesCount: leftDiff.result.modifiedNodes.length,
        rightAddedNodesCount: rightDiff.result.addedNodes.length,
        rightDeletedNodesCount: rightDiff.result.deletedNodes.length,
        rightModifiedNodesCount: rightDiff.result.modifiedNodes.length,
        conflictCount: conflicts.length,
        nonConflictingLeftCount: nonConflictingLeftChanges.length,
        nonConflictingRightCount: nonConflictingRightChanges.length,
        largeDatasetWarning: totalElements > LARGE_DATASET_THRESHOLD,
      };

      return { summary, result };
    },
  };
}

// ── Core diff algorithm ───────────────────────────────────────────────────────

function runDiff(
  left: SerializedNamespace,
  right: SerializedNamespace,
  opts?: DiffOptions,
): { summary: DiffSummary; result: NamespaceDiffResult } {
  // Metamodel constraint
  if (left.metamodel !== right.metamodel) {
    throw new Error(
      `Cannot diff namespaces with different metamodels: ` +
      `'${left.namespace}' uses '${left.metamodel}', ` +
      `'${right.namespace}' uses '${right.metamodel}'. ` +
      `Only namespaces sharing the same immediate metamodel can be compared.`,
    );
  }

  // Optional sub-tree filtering
  let lFiltered = left;
  let rFiltered = right;
  if (opts?.leftRootStableId) {
    const containment = opts.containmentRelationshipTypes ?? [];
    lFiltered = filterToSubtree(left, opts.leftRootStableId, containment);
  }
  if (opts?.rightRootStableId) {
    const containment = opts.containmentRelationshipTypes ?? [];
    rFiltered = filterToSubtree(right, opts.rightRootStableId, containment);
  }

  // Compute diffs
  const nodeDiff = diffNodes(lFiltered, rFiltered);
  const edgeDiff = diffEdges(
    lFiltered,
    rFiltered,
    opts?.includeCrossNamespaceEdges !== false,
  );

  const diffId = randomUUID();
  const computedAt = new Date().toISOString();

  const scope = (opts?.leftRootStableId || opts?.rightRootStableId)
    ? {
        leftRootStableId: opts.leftRootStableId ?? '',
        rightRootStableId: opts.rightRootStableId ?? '',
        containmentRelationshipTypes: opts.containmentRelationshipTypes ?? [],
      }
    : undefined;

  const result: NamespaceDiffResult = {
    diffId,
    leftNamespace: left.namespace,
    rightNamespace: right.namespace,
    metamodel: left.metamodel,
    computedAt,
    addedNodes: nodeDiff.addedNodes,
    deletedNodes: nodeDiff.deletedNodes,
    modifiedNodes: nodeDiff.modifiedNodes,
    addedEdges: edgeDiff.addedEdges,
    deletedEdges: edgeDiff.deletedEdges,
    modifiedEdges: edgeDiff.modifiedEdges,
    addedCrossNsEdges: edgeDiff.addedCrossNsEdges,
    deletedCrossNsEdges: edgeDiff.deletedCrossNsEdges,
    modifiedCrossNsEdges: edgeDiff.modifiedCrossNsEdges,
    skippedNodes: nodeDiff.skippedNodes,
    scope,
  };

  // Resolve human-readable endpoints for every edge change. Indexes the
  // *unfiltered* namespaces on purpose: endpoints that are not themselves
  // changes — and, under a sub-tree scope, endpoints outside the scope — still
  // need to render as names rather than raw stable IDs.
  enrichEdgeEndpoints(result, left, right);

  const totalChanged =
    result.addedNodes.length +
    result.deletedNodes.length +
    result.modifiedNodes.length +
    result.addedEdges.length +
    result.deletedEdges.length +
    result.modifiedEdges.length;

  const summary: DiffSummary = {
    diffId,
    leftNamespace: left.namespace,
    rightNamespace: right.namespace,
    metamodel: left.metamodel,
    computedAt,
    addedNodesCount: result.addedNodes.length,
    deletedNodesCount: result.deletedNodes.length,
    modifiedNodesCount: result.modifiedNodes.length,
    addedEdgesCount: result.addedEdges.length,
    deletedEdgesCount: result.deletedEdges.length,
    modifiedEdgesCount: result.modifiedEdges.length,
    addedCrossNsEdgesCount: result.addedCrossNsEdges.length,
    deletedCrossNsEdgesCount: result.deletedCrossNsEdges.length,
    modifiedCrossNsEdgesCount: result.modifiedCrossNsEdges.length,
    skippedNodesCount: result.skippedNodes.length,
    largeDatasetWarning: totalChanged > LARGE_DATASET_THRESHOLD,
    scope,
  };

  return { summary, result };
}

// ── Three-way conflict classification ────────────────────────────────────────

function classifyConflicts(
  leftChanges: NamespaceDiffResult,
  rightChanges: NamespaceDiffResult,
  conflicts: ConflictRecord[],
  nonConflictingLeft: ChangeReference[],
  nonConflictingRight: ChangeReference[],
): void {
  // Build quick lookup maps for right changes
  const rightDeletedNodes = new Set(rightChanges.deletedNodes.map(n => n.stableId));
  const rightModifiedNodes = new Map(rightChanges.modifiedNodes.map(n => [n.stableId, n]));
  const leftDeletedNodes = new Set(leftChanges.deletedNodes.map(n => n.stableId));
  const leftModifiedNodes = new Map(leftChanges.modifiedNodes.map(n => [n.stableId, n]));

  // Track which left/right changes ended up in a conflict
  const conflictedLeftIds = new Set<string>();
  const conflictedRightIds = new Set<string>();

  // ── Node conflicts ────────────────────────────────────────────────────────

  // Left deleted, right modified
  for (const lDel of leftChanges.deletedNodes) {
    if (rightModifiedNodes.has(lDel.stableId)) {
      conflicts.push({
        conflictType: 'node-deleted-in-left-modified-in-right',
        elementKind: 'node',
        stableId: lDel.stableId,
        baseValue: lDel.attributes,
        leftValue: undefined, // deleted
        rightValue: rightModifiedNodes.get(lDel.stableId)!.rightSnapshot.attributes,
      });
      conflictedLeftIds.add(lDel.stableId);
      conflictedRightIds.add(lDel.stableId);
    }
  }

  // Right deleted, left modified
  for (const rDel of rightChanges.deletedNodes) {
    if (leftModifiedNodes.has(rDel.stableId)) {
      conflicts.push({
        conflictType: 'node-deleted-in-right-modified-in-left',
        elementKind: 'node',
        stableId: rDel.stableId,
        baseValue: rDel.attributes,
        leftValue: leftModifiedNodes.get(rDel.stableId)!.rightSnapshot.attributes,
        rightValue: undefined, // deleted
      });
      conflictedLeftIds.add(rDel.stableId);
      conflictedRightIds.add(rDel.stableId);
    }
  }

  // Attribute-level conflicts (same node modified in both, conflicting attributes)
  for (const lMod of leftChanges.modifiedNodes) {
    const rMod = rightModifiedNodes.get(lMod.stableId);
    if (!rMod) continue;

    const lAttrMap = new Map(lMod.propertyChanges.map(pc => [pc.attribute, pc]));
    const rAttrMap = new Map(rMod.propertyChanges.map(pc => [pc.attribute, pc]));

    let hasAttrConflict = false;
    for (const [attr, lPc] of lAttrMap) {
      const rPc = rAttrMap.get(attr);
      if (!rPc) continue;
      // Both sides changed the same attribute — check if the change is compatible
      const lSer = JSON.stringify(lPc.rightValue);
      const rSer = JSON.stringify(rPc.rightValue);
      if (lSer !== rSer) {
        conflicts.push({
          conflictType: 'node-attribute-conflict',
          elementKind: 'node',
          stableId: lMod.stableId,
          attribute: attr,
          baseValue: lPc.leftValue,
          leftValue: lPc.rightValue,
          rightValue: rPc.rightValue,
        });
        hasAttrConflict = true;
        conflictedLeftIds.add(lMod.stableId);
        conflictedRightIds.add(lMod.stableId);
      }
    }
    // If there was a conflict for this node, mark it (already done above)
    void hasAttrConflict;
  }

  // ── Edge conflicts ────────────────────────────────────────────────────────

  classifyEdgeConflicts(
    leftChanges.deletedEdges,
    leftChanges.modifiedEdges,
    rightChanges.deletedEdges,
    rightChanges.modifiedEdges,
    'edge',
    conflicts,
    conflictedLeftIds,
    conflictedRightIds,
  );

  // ── Non-conflicting changes ───────────────────────────────────────────────

  for (const n of leftChanges.addedNodes) {
    nonConflictingLeft.push({ elementKind: 'node', stableId: n.stableId, changeKind: 'added' });
  }
  for (const n of leftChanges.deletedNodes) {
    if (!conflictedLeftIds.has(n.stableId)) {
      nonConflictingLeft.push({ elementKind: 'node', stableId: n.stableId, changeKind: 'deleted' });
    }
  }
  for (const n of leftChanges.modifiedNodes) {
    if (!conflictedLeftIds.has(n.stableId)) {
      nonConflictingLeft.push({ elementKind: 'node', stableId: n.stableId, changeKind: 'modified' });
    }
  }

  for (const n of rightChanges.addedNodes) {
    nonConflictingRight.push({ elementKind: 'node', stableId: n.stableId, changeKind: 'added' });
  }
  for (const n of rightChanges.deletedNodes) {
    if (!conflictedRightIds.has(n.stableId)) {
      nonConflictingRight.push({ elementKind: 'node', stableId: n.stableId, changeKind: 'deleted' });
    }
  }
  for (const n of rightChanges.modifiedNodes) {
    if (!conflictedRightIds.has(n.stableId)) {
      nonConflictingRight.push({ elementKind: 'node', stableId: n.stableId, changeKind: 'modified' });
    }
  }
}

function classifyEdgeConflicts(
  leftDeleted: EdgeDiffItem[],
  leftModified: EdgeDiffItem[],
  rightDeleted: EdgeDiffItem[],
  rightModified: EdgeDiffItem[],
  elementKind: 'edge' | 'crossNsEdge',
  conflicts: ConflictRecord[],
  conflictedLeftIds: Set<string>,
  conflictedRightIds: Set<string>,
): void {
  const edgeKey = (e: EdgeDiffItem) =>
    'namespace' in e
      ? `${(e as EdgeModification).sourceStableId}::${(e as EdgeModification).targetStableId}::${(e as EdgeModification).relationshipType}`
      : '';

  const rightDeletedKeys = new Set(rightDeleted.map(edgeKey));
  const rightModifiedMap = new Map(rightModified.map(e => [edgeKey(e), e]));
  const leftDeletedKeys = new Set(leftDeleted.map(edgeKey));
  const leftModifiedMap = new Map(leftModified.map(e => [edgeKey(e), e]));

  // Left deleted, right modified
  for (const lDel of leftDeleted) {
    const key = edgeKey(lDel);
    if (rightModifiedMap.has(key)) {
      conflicts.push({
        conflictType: `${elementKind}-deleted-in-left-modified-in-right` as ConflictType,
        elementKind,
        stableId: key,
        baseValue: (lDel as EdgeModification).leftSnapshot?.attributes,
        leftValue: undefined,
        rightValue: (rightModifiedMap.get(key) as EdgeModification)?.rightSnapshot?.attributes,
      });
      conflictedLeftIds.add(key);
      conflictedRightIds.add(key);
    }
  }

  // Right deleted, left modified
  for (const rDel of rightDeleted) {
    const key = edgeKey(rDel);
    if (leftModifiedMap.has(key)) {
      conflicts.push({
        conflictType: `${elementKind}-deleted-in-right-modified-in-left` as ConflictType,
        elementKind,
        stableId: key,
        baseValue: (rDel as EdgeModification).leftSnapshot?.attributes,
        leftValue: (leftModifiedMap.get(key) as EdgeModification)?.rightSnapshot?.attributes,
        rightValue: undefined,
      });
      conflictedLeftIds.add(key);
      conflictedRightIds.add(key);
    }
  }

  // Attribute conflicts
  for (const lMod of leftModified) {
    const key = edgeKey(lMod);
    const rMod = rightModifiedMap.get(key);
    if (!rMod) continue;

    const lMC = lMod as EdgeModification;
    const rMC = rMod as EdgeModification;

    const lAttrMap = new Map(lMC.propertyChanges.map(pc => [pc.attribute, pc]));
    for (const [attr, lPc] of lAttrMap) {
      const rPc = rMC.propertyChanges.find(pc => pc.attribute === attr);
      if (!rPc) continue;
      if (JSON.stringify(lPc.rightValue) !== JSON.stringify(rPc.rightValue)) {
        conflicts.push({
          conflictType: `${elementKind}-attribute-conflict` as ConflictType,
          elementKind,
          stableId: key,
          attribute: attr,
          baseValue: lPc.leftValue,
          leftValue: lPc.rightValue,
          rightValue: rPc.rightValue,
        });
        conflictedLeftIds.add(key);
        conflictedRightIds.add(key);
      }
    }
  }
}

// TypeScript helper union for edge diff items
type EdgeDiffItem = EdgeModification | CrossNsEdgeModification | { stableId?: string; attributes?: unknown };
