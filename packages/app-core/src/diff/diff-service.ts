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
} from '@riacore/app-contracts';
import { loadLiveNamespace, loadSnapshotNamespace } from './namespace-loader.js';
import { diffNodes } from './diff-nodes.js';
import { diffEdges } from './diff-edges.js';
import { filterToSubtree } from './subtree-filter.js';
import type { SerializedNamespace } from './diff-types.js';
import { extractNodeName } from '../dispatch/utils/node-name.js';

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
      const { summary, result } = runDiff(left, right, opts);
      enrichCrossNsSourceLabels(result, left, right);
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

// ── Cross-NS label enrichment ─────────────────────────────────────────────────

/**
 * Build a stablePath → human-readable label map from a serialized namespace's
 * concept instances. Used to resolve source-side labels for cross-NS edges.
 */
function buildSourceLabelMap(ns: SerializedNamespace): Map<string, string> {
  const map = new Map<string, string>();
  for (const ci of ns.conceptInstances) {
    const stablePath = (() => {
      try {
        const attrs = typeof ci.attributes === 'object' && ci.attributes !== null
          ? ci.attributes as Record<string, unknown>
          : JSON.parse(String(ci.attributes ?? '{}')) as Record<string, unknown>;
        return typeof attrs.stable_path === 'string' ? attrs.stable_path : '';
      } catch { return ''; }
    })();
    if (!stablePath) continue;
    const attrs = (() => {
      try {
        return typeof ci.attributes === 'object' && ci.attributes !== null
          ? ci.attributes as Record<string, unknown>
          : JSON.parse(String(ci.attributes ?? '{}')) as Record<string, unknown>;
      } catch { return {}; }
    })();
    const label = extractNodeName(attrs, String(ci.concept ?? ''));
    if (label) map.set(stablePath, label);
  }
  return map;
}

/** Apply source labels to all cross-NS edge snapshots using the pre-built map. */
function applySourceLabels(edges: CrossNsEdgeSnapshot[], sourceLabelMap: Map<string, string>): void {
  for (const edge of edges) {
    if (!edge.sourceLabel && edge.sourceStableId) {
      const label = sourceLabelMap.get(edge.sourceStableId);
      if (label) edge.sourceLabel = label;
    }
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
 * Enrich cross-NS edge snapshots with human-readable labels by querying the DB.
 * Source labels come from the loaded namespace data; target labels are DB-resolved.
 */
async function enrichCrossNsLabels(
  result: NamespaceDiffResult,
  left: SerializedNamespace,
  right: SerializedNamespace,
  dbModule: IDbModule,
): Promise<void> {
  // Build source label maps from both namespace datasets
  const leftMap = buildSourceLabelMap(left);
  const rightMap = buildSourceLabelMap(right);
  const sourceLabelMap = new Map([...leftMap, ...rightMap]);

  const allEdges: CrossNsEdgeSnapshot[] = [
    ...result.addedCrossNsEdges,
    ...result.deletedCrossNsEdges,
    ...result.modifiedCrossNsEdges.map(m => m.rightSnapshot ?? m.leftSnapshot),
  ];

  applySourceLabels(allEdges, sourceLabelMap);
  // Also apply to the individual snapshots inside modifiedCrossNsEdges
  for (const mod of result.modifiedCrossNsEdges) {
    if (mod.leftSnapshot && !mod.leftSnapshot.sourceLabel) {
      const label = sourceLabelMap.get(mod.leftSnapshot.sourceStableId);
      if (label) mod.leftSnapshot.sourceLabel = label;
    }
    if (mod.rightSnapshot && !mod.rightSnapshot.sourceLabel) {
      const label = sourceLabelMap.get(mod.rightSnapshot.sourceStableId);
      if (label) mod.rightSnapshot.sourceLabel = label;
    }
  }

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

  // Resolve each target node label individually (cross-NS target counts are typically small)
  const targetLabelMap = new Map<string, string>();
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
        const displayAttrs = await getDisplayAttrs(String(row.metamodel ?? ''));
        const label = extractLabelWithConfig(attrs, String(row.concept ?? ''), displayAttrs);
        if (label) { targetLabelMap.set(stableId, label); break; }
      }
    } catch {
      // Non-critical: leave label empty if lookup fails
    }
  }

  // Apply target labels
  for (const edge of allEdges) {
    if (edge.targetStableId && !edge.targetLabel) {
      const label = targetLabelMap.get(edge.targetStableId);
      if (label) edge.targetLabel = label;
    }
  }
  for (const mod of result.modifiedCrossNsEdges) {
    for (const snap of [mod.leftSnapshot, mod.rightSnapshot]) {
      if (snap && snap.targetStableId && !snap.targetLabel) {
        const label = targetLabelMap.get(snap.targetStableId);
        if (label) snap.targetLabel = label;
      }
    }
  }
}

/**
 * Snapshot-only variant: enrich only source labels (no DB access for targets).
 */
function enrichCrossNsSourceLabels(
  result: NamespaceDiffResult,
  left: SerializedNamespace,
  right: SerializedNamespace,
): void {
  const sourceLabelMap = new Map([...buildSourceLabelMap(left), ...buildSourceLabelMap(right)]);
  const allEdges: CrossNsEdgeSnapshot[] = [
    ...result.addedCrossNsEdges,
    ...result.deletedCrossNsEdges,
    ...result.modifiedCrossNsEdges.map(m => m.rightSnapshot ?? m.leftSnapshot),
  ];
  applySourceLabels(allEdges, sourceLabelMap);
  for (const mod of result.modifiedCrossNsEdges) {
    for (const snap of [mod.leftSnapshot, mod.rightSnapshot]) {
      if (snap && !snap.sourceLabel) {
        const label = sourceLabelMap.get(snap.sourceStableId);
        if (label) snap.sourceLabel = label;
      }
    }
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
