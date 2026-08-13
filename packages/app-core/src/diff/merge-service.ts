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
 * IMergeService — applies a computed NamespaceDiffResult (two-way) or a
 * ThreeWayDiffResult (three-way with resolved conflicts) to the live graph
 * database.
 *
 * This service performs full DB writes. It:
 *  - Looks up existing nodes by stable ID (scanning namespace attributes)
 *  - Creates, updates, or deletes ConceptInstance nodes
 *  - Creates or deletes RelationshipInstance and CrossNSRelationshipInstance nodes
 *  - Invalidates namespace content hashes so the persistor picks up changes
 *
 * The caller must pass a `targetNamespace` because the diff result stores
 * changes relative to `leftNamespace` / `rightNamespace`; the merge can
 * be applied to either side (e.g., applying right changes into left).
 *
 * Optional `selectionIds`: when provided only changes whose `stableId` is
 * in the set are applied (partial / cherry-pick merge).
 */

import type { IDbModule } from '../db/db-module.js';
import type {
  NamespaceDiffResult,
  MergeResult,
  ThreeWayDiffResult,
  ConflictResolution,
  NodeSnapshot,
  CrossNsEdgeSnapshot,
} from '@riacore/app-contracts';

// ── helpers ────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function invalidateHash(dbModule: IDbModule, namespace: string): Promise<void> {
  await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) SET ns.content_hash = ''`,
    { namespace },
  );
}

/**
 * Build a map from stableId → node_id for every ConceptInstance in `namespace`.
 * Stable IDs are the first non-empty value across common identity attribute
 * names: stable_path, sysml_id, uuid.
 *
 * When two nodes share the same stableId (e.g. the real SW_ARXML node and a
 * cross-namespace reference copy with a different metamodel), prefer the node
 * whose metamodel matches the namespace's own metamodel. This prevents the
 * merge service from deleting the wrong node when applying a rename diff.
 */
async function buildStableIdIndex(
  dbModule: IDbModule,
  namespace: string,
): Promise<Map<string, number>> {
  // Resolve the namespace's own metamodel so we can prefer native nodes over
  // cross-namespace reference copies that share the same stable_path.
  const nsRows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) RETURN ns.metamodel AS metamodel`,
    { namespace },
  );
  const nativeMetamodel = String(nsRows[0]?.metamodel ?? '');

  const rows = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
     RETURN ci.node_id AS node_id, ci.attributes AS attributes, ci.metamodel AS metamodel`,
    { namespace },
  );

  const index = new Map<string, number>();
  for (const row of rows) {
    const attrs: Record<string, unknown> = JSON.parse(String(row.attributes ?? '{}'));
    const stableId =
      String(attrs.stable_path ?? attrs.sysml_id ?? attrs.uuid ?? '').trim();
    if (!stableId) continue;

    // If this stableId is already in the index, only overwrite if the current
    // entry is a cross-namespace reference copy (metamodel ≠ nativeMetamodel)
    // and the incoming row is the native node (metamodel === nativeMetamodel).
    if (index.has(stableId)) {
      const rowMetamodel = String(row.metamodel ?? '');
      if (nativeMetamodel && rowMetamodel === nativeMetamodel) {
        // Prefer the native node — overwrite the cross-NS reference copy.
        index.set(stableId, Number(row.node_id));
      }
      // Otherwise keep the existing entry (already native, or no preference possible).
    } else {
      index.set(stableId, Number(row.node_id));
    }
  }
  return index;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IMergeService {
  /**
   * Apply changes from a two-way diff into `targetNamespace`.
   *
   * `direction`:
   *   - 'left-into-right'  — apply the left state to the right namespace
   *   - 'right-into-left'  — apply the right state to the left namespace
   *
   * The convention matches the app-contracts MergeResult direction field.
   */
  applyMerge(params: {
    diffResult: NamespaceDiffResult;
    targetNamespace: string;
    direction: 'left-into-right' | 'right-into-left';
    selectionIds?: string[];
  }): Promise<MergeResult>;

  /**
   * Apply a three-way diff merge using the provided conflict resolutions.
   * Non-conflicting left/right changes are applied automatically.
   * Conflicting changes are only applied when a matching ConflictResolution
   * is provided with `resolution !== 'skip'`.
   */
  applyThreeWayMerge(params: {
    threeWayResult: ThreeWayDiffResult;
    targetNamespace: string;
    conflictResolutions: ConflictResolution[];
    selectionIds?: string[];
  }): Promise<MergeResult>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMergeService(dbModule: IDbModule): IMergeService {
  return {
    async applyMerge({ diffResult, targetNamespace, direction, selectionIds }) {
      const selSet = selectionIds ? new Set(selectionIds) : null;

      const expectedTarget = direction === 'right-into-left'
        ? diffResult.leftNamespace
        : diffResult.rightNamespace;
      if (targetNamespace !== expectedTarget) {
        throw new Error(
          `Merge direction '${direction}' targets '${expectedTarget}', not '${targetNamespace}'`,
        );
      }

      // right-into-left: apply right-side additions to left namespace
      //   addedNodes (in right, absent in left)  → CREATE in left
      //   deletedNodes (absent in right, in left) → DELETE from left
      //   modifiedNodes                           → UPDATE left with right attrs
      //
      // left-into-right: reverse semantics (apply left state into right namespace)
      const applyRightToLeft = direction === 'right-into-left';

      const warnings: string[] = [];
      let nodesAdded = 0;
      let nodesDeleted = 0;
      let nodesModified = 0;
      let edgesAdded = 0;
      let edgesDeleted = 0;
      let edgesModified = 0;
      let skipped = 0;

      const index = await buildStableIdIndex(dbModule, targetNamespace);

      // Resolve the namespace's metamodel once — used when creating edges so
      // RelationshipInstance nodes get the correct metamodel (mirrors the
      // pattern in union-merge-service.ts and createNode above).
      const nsMetaRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
         RETURN ns.metamodel AS metamodel LIMIT 1`,
        { namespace: targetNamespace },
      );
      const metamodel = String(nsMetaRows[0]?.metamodel ?? '');

      if (applyRightToLeft) {
        for (const node of diffResult.addedNodes) {
          if (selSet && !selSet.has(node.stableId)) { skipped++; continue; }
          const r = await createNode(dbModule, targetNamespace, node);
          if (!r.ok) { warnings.push(r.error); } else { nodesAdded++; index.set(node.stableId, r.nodeId); }
        }
        await rebindCrossNsForRenamedNodes(
          dbModule,
          diffResult.deletedNodes.filter(node => !selSet || selSet.has(node.stableId)),
          diffResult.addedNodes.filter(node => !selSet || selSet.has(node.stableId)),
          index,
        );
        for (const mod of diffResult.modifiedNodes) {
          if (selSet && !selSet.has(mod.stableId)) { skipped++; continue; }
          const nodeId = index.get(mod.stableId);
          if (nodeId === undefined) { warnings.push(`Node '${mod.stableId}' not found in ${targetNamespace}`); continue; }
          const r = await updateNodeAttributes(dbModule, nodeId, mod.rightSnapshot.attributes);
          if (!r.ok) { warnings.push(r.error); } else { nodesModified++; }
        }
      } else {
        for (const node of diffResult.deletedNodes) {
          if (selSet && !selSet.has(node.stableId)) { skipped++; continue; }
          const r = await createNode(dbModule, targetNamespace, node);
          if (!r.ok) { warnings.push(r.error); } else { nodesAdded++; index.set(node.stableId, r.nodeId); }
        }
        await rebindCrossNsForRenamedNodes(
          dbModule,
          diffResult.addedNodes.filter(node => !selSet || selSet.has(node.stableId)),
          diffResult.deletedNodes.filter(node => !selSet || selSet.has(node.stableId)),
          index,
        );
        for (const mod of diffResult.modifiedNodes) {
          if (selSet && !selSet.has(mod.stableId)) { skipped++; continue; }
          const nodeId = index.get(mod.stableId);
          if (nodeId === undefined) { warnings.push(`Node '${mod.stableId}' not found in ${targetNamespace}`); continue; }
          const r = await updateNodeAttributes(dbModule, nodeId, mod.leftSnapshot.attributes);
          if (!r.ok) { warnings.push(r.error); } else { nodesModified++; }
        }
      }

      // ── Apply intra-namespace edge changes ────────────────────────────────

      if (applyRightToLeft) {
        for (const edge of diffResult.addedEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          const tgtId = index.get(edge.targetStableId);
          if (!srcId || !tgtId) { warnings.push(`Edge endpoints not found: ${key}`); continue; }
          const r = await createEdge(dbModule, srcId, tgtId, edge.relationshipType, targetNamespace, metamodel, edge.attributes);
          if (!r.ok) { warnings.push(r.error); } else { edgesAdded++; }
        }
        for (const edge of diffResult.deletedEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          const tgtId = index.get(edge.targetStableId);
          if (!srcId || !tgtId) { warnings.push(`Edge endpoints not found: ${key}`); continue; }
          const r = await deleteEdge(dbModule, srcId, tgtId, edge.relationshipType);
          if (!r.ok) { warnings.push(r.error); } else { edgesDeleted++; }
        }
        for (const mod of diffResult.modifiedEdges) {
          const key = `${mod.sourceStableId}::${mod.targetStableId}::${mod.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(mod.sourceStableId);
          const tgtId = index.get(mod.targetStableId);
          if (!srcId || !tgtId) { warnings.push(`Edge endpoints not found: ${key}`); continue; }
          const r = await updateEdgeAttributes(dbModule, srcId, tgtId, mod.relationshipType, mod.rightSnapshot.attributes);
          if (!r.ok) { warnings.push(r.error); } else { edgesModified++; }
        }
      } else {
        for (const edge of diffResult.deletedEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          const tgtId = index.get(edge.targetStableId);
          if (!srcId || !tgtId) { warnings.push(`Edge endpoints not found: ${key}`); continue; }
          const r = await createEdge(dbModule, srcId, tgtId, edge.relationshipType, targetNamespace, metamodel, edge.attributes);
          if (!r.ok) { warnings.push(r.error); } else { edgesAdded++; }
        }
        for (const edge of diffResult.addedEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          const tgtId = index.get(edge.targetStableId);
          if (!srcId || !tgtId) { warnings.push(`Edge endpoints not found: ${key}`); continue; }
          const r = await deleteEdge(dbModule, srcId, tgtId, edge.relationshipType);
          if (!r.ok) { warnings.push(r.error); } else { edgesDeleted++; }
        }
        for (const mod of diffResult.modifiedEdges) {
          const key = `${mod.sourceStableId}::${mod.targetStableId}::${mod.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(mod.sourceStableId);
          const tgtId = index.get(mod.targetStableId);
          if (!srcId || !tgtId) { warnings.push(`Edge endpoints not found: ${key}`); continue; }
          const r = await updateEdgeAttributes(dbModule, srcId, tgtId, mod.relationshipType, mod.leftSnapshot.attributes);
          if (!r.ok) { warnings.push(r.error); } else { edgesModified++; }
        }
      }

      await invalidateHash(dbModule, targetNamespace);

      // ── Apply cross-namespace edge changes ────────────────────────────────
      // Cross-namespace edges (occurs_at, has_direct_requirements, etc.) are
      // tracked as CrossNSRelationshipInstance nodes in the DB. applyMerge must
      // create/delete them so that the next persistor.store produces the correct
      // cross_namespace/ layer. Without this, the edges are shown in the diff UI
      // but silently dropped, causing a staged/unstaged split on the next store.

      if (applyRightToLeft) {
        for (const edge of diffResult.addedCrossNsEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          if (!srcId) { warnings.push(`Cross-NS edge source '${edge.sourceStableId}' not found in ${targetNamespace}`); continue; }
          const tgtId = await resolveTargetNodeId(dbModule, edge.targetNamespace, edge.targetStableId);
          if (!tgtId) { warnings.push(`Cross-NS edge target '${edge.targetStableId}' not found in ${edge.targetNamespace}`); continue; }
          const r = await createCrossNsEdge(dbModule, edge, metamodel, srcId, tgtId);
          if (!r.ok) { warnings.push(r.error); } else { edgesAdded++; }
        }
        for (const edge of diffResult.deletedCrossNsEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          if (!srcId) { warnings.push(`Cross-NS edge source '${edge.sourceStableId}' not found in ${targetNamespace}`); continue; }
          const tgtId = await resolveTargetNodeId(dbModule, edge.targetNamespace, edge.targetStableId);
          if (!tgtId) { warnings.push(`Cross-NS edge target '${edge.targetStableId}' not found in ${edge.targetNamespace}`); continue; }
          const r = await deleteCrossNsEdge(dbModule, srcId, tgtId, edge.relationshipType);
          if (!r.ok) { warnings.push(r.error); } else { edgesDeleted++; }
        }
      } else {
        // left-into-right: deleted in diff = present in left → create in target
        for (const edge of diffResult.deletedCrossNsEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          if (!srcId) { warnings.push(`Cross-NS edge source '${edge.sourceStableId}' not found in ${targetNamespace}`); continue; }
          const tgtId = await resolveTargetNodeId(dbModule, edge.targetNamespace, edge.targetStableId);
          if (!tgtId) { warnings.push(`Cross-NS edge target '${edge.targetStableId}' not found in ${edge.targetNamespace}`); continue; }
          const r = await createCrossNsEdge(dbModule, edge, metamodel, srcId, tgtId);
          if (!r.ok) { warnings.push(r.error); } else { edgesAdded++; }
        }
        for (const edge of diffResult.addedCrossNsEdges) {
          const key = `${edge.sourceStableId}::${edge.targetStableId}::${edge.relationshipType}`;
          if (selSet && !selSet.has(key)) { skipped++; continue; }
          const srcId = index.get(edge.sourceStableId);
          if (!srcId) { warnings.push(`Cross-NS edge source '${edge.sourceStableId}' not found in ${targetNamespace}`); continue; }
          const tgtId = await resolveTargetNodeId(dbModule, edge.targetNamespace, edge.targetStableId);
          if (!tgtId) { warnings.push(`Cross-NS edge target '${edge.targetStableId}' not found in ${edge.targetNamespace}`); continue; }
          const r = await deleteCrossNsEdge(dbModule, srcId, tgtId, edge.relationshipType);
          if (!r.ok) { warnings.push(r.error); } else { edgesDeleted++; }
        }
      }

      // Delete obsolete nodes only after all intra- and cross-namespace edge
      // changes have been applied. Kuzu does not allow deleting a node while
      // INSTANCE_REL edges are still attached, and edge deletion needs the old
      // stable-id lookup to remain available until this point.
      const nodesToDelete = applyRightToLeft
        ? diffResult.deletedNodes
        : diffResult.addedNodes;
      for (const node of nodesToDelete) {
        if (selSet && !selSet.has(node.stableId)) { skipped++; continue; }
        const nodeId = index.get(node.stableId);
        if (nodeId === undefined) {
          warnings.push(`Node '${node.stableId}' not found in ${targetNamespace}`);
          continue;
        }
        const r = await deleteNode(dbModule, nodeId);
        if (!r.ok) {
          warnings.push(r.error);
        } else {
          nodesDeleted++;
          index.delete(node.stableId);
        }
      }

      return {
        targetNamespace,
        direction,
        appliedAt: new Date().toISOString(),
        nodesAdded,
        nodesDeleted,
        nodesModified,
        edgesAdded,
        edgesDeleted,
        edgesModified,
        skipped,
        warnings,
        mergeApplied: warnings.length === 0,
      } satisfies MergeResult;
    },

    async applyThreeWayMerge({ threeWayResult, targetNamespace, conflictResolutions, selectionIds }) {
      const selSet = selectionIds ? new Set(selectionIds) : null;
      const resolutionMap = new Map(conflictResolutions.map(cr => [cr.stableId, cr]));
      const warnings: string[] = [];
      let nodesAdded = 0;
      let nodesDeleted = 0;
      let nodesModified = 0;
      const edgesAdded = 0;
      const edgesDeleted = 0;
      const edgesModified = 0;
      let skipped = 0;

      const index = await buildStableIdIndex(dbModule, targetNamespace);

      const leftChanges = threeWayResult.leftChanges;
      const rightChanges = threeWayResult.rightChanges;
      const conflictIds = new Set(threeWayResult.conflicts.map(c => c.stableId));

      for (const ref of threeWayResult.nonConflictingLeftChanges) {
        if (selSet && !selSet.has(ref.stableId)) { skipped++; continue; }
        if (conflictIds.has(ref.stableId)) continue;
        const r = await applyNodeChange(dbModule, leftChanges, ref.stableId, ref.changeKind, 'right', index, targetNamespace);
        if (!r.ok) { warnings.push(r.error); } else {
          if (ref.changeKind === 'added') nodesAdded++;
          else if (ref.changeKind === 'deleted') nodesDeleted++;
          else nodesModified++;
        }
      }

      for (const ref of threeWayResult.nonConflictingRightChanges) {
        if (selSet && !selSet.has(ref.stableId)) { skipped++; continue; }
        if (conflictIds.has(ref.stableId)) continue;
        const r = await applyNodeChange(dbModule, rightChanges, ref.stableId, ref.changeKind, 'right', index, targetNamespace);
        if (!r.ok) { warnings.push(r.error); } else {
          if (ref.changeKind === 'added') nodesAdded++;
          else if (ref.changeKind === 'deleted') nodesDeleted++;
          else nodesModified++;
        }
      }

      for (const conflict of threeWayResult.conflicts) {
        const resolution = resolutionMap.get(conflict.stableId);
        if (!resolution || resolution.resolution === 'manual' && resolution.resolvedValue === undefined) { skipped++; continue; }
        if (selSet && !selSet.has(conflict.stableId)) { skipped++; continue; }

        let attrs: Record<string, unknown> | undefined;
        if (resolution.resolution === 'accept-left') {
          attrs = (conflict.leftValue ?? conflict.baseValue) as Record<string, unknown>;
        } else if (resolution.resolution === 'accept-right') {
          attrs = conflict.rightValue as Record<string, unknown>;
        } else if (resolution.resolution === 'manual') {
          attrs = resolution.resolvedValue as Record<string, unknown>;
        }

        if (!attrs) { skipped++; continue; }

        const nodeId = index.get(conflict.stableId);
        if (nodeId === undefined) {
          warnings.push(`Node '${conflict.stableId}' not found in ${targetNamespace}`);
          continue;
        }
        const r = await updateNodeAttributes(dbModule, nodeId, attrs);
        if (!r.ok) { warnings.push(r.error); } else { nodesModified++; }
      }

      await invalidateHash(dbModule, targetNamespace);

      return {
        targetNamespace,
        direction: 'left-into-right' as const,
        appliedAt: new Date().toISOString(),
        nodesAdded,
        nodesDeleted,
        nodesModified,
        edgesAdded,
        edgesDeleted,
        edgesModified,
        skipped,
        warnings,
        mergeApplied: warnings.length === 0,
      } satisfies MergeResult;
    },
  };
}

// ── Low-level DB operations ──────────────────────────────────────────────────

async function createNode(
  dbModule: IDbModule,
  namespace: string,
  node: NodeSnapshot,
): Promise<{ ok: boolean; nodeId: number; error: string }> {
  try {
    const nsRows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
       RETURN ns.metamodel AS metamodel LIMIT 1`,
      { namespace },
    );
    const metamodel = String(nsRows[0]?.metamodel ?? '');
    const attrsJson = JSON.stringify(node.attributes);
    const rows = await dbModule.runQuery(
      `CREATE (ci:RIA_UNIV_ConceptInstance {
        namespace: '${esc(namespace)}',
        concept: '${esc(node.conceptType)}',
        metamodel: '${esc(metamodel)}',
        attributes: '${esc(attrsJson)}'
      }) RETURN ci.node_id AS nodeId`,
    );
    return { ok: true, nodeId: Number(rows[0]?.nodeId), error: '' };
  } catch (err: unknown) {
    return { ok: false, nodeId: -1, error: `createNode(${node.stableId}): ${String(err)}` };
  }
}

/**
 * Preserve CrossNS relationships when an importer rename is represented as a
 * deleted node plus an added node. ARXML stable paths contain the short name,
 * while the UUID survives a rename, so UUID + concept type is the reliable
 * bridge between the two diff entries.
 */
async function rebindCrossNsForRenamedNodes(
  dbModule: IDbModule,
  removedNodes: NodeSnapshot[],
  addedNodes: NodeSnapshot[],
  index: Map<string, number>,
): Promise<void> {
  const addedByIdentity = new Map<string, NodeSnapshot>();
  const duplicateIdentities = new Set<string>();

  for (const node of addedNodes) {
    const uuid = typeof node.attributes.uuid === 'string' ? node.attributes.uuid.trim() : '';
    if (!uuid) continue;
    const identity = `${node.conceptType}::${uuid}`;
    if (addedByIdentity.has(identity)) {
      addedByIdentity.delete(identity);
      duplicateIdentities.add(identity);
    } else if (!duplicateIdentities.has(identity)) {
      addedByIdentity.set(identity, node);
    }
  }

  for (const removed of removedNodes) {
    const uuid = typeof removed.attributes.uuid === 'string' ? removed.attributes.uuid.trim() : '';
    if (!uuid) continue;
    const replacement = addedByIdentity.get(`${removed.conceptType}::${uuid}`);
    if (!replacement) continue;

    const oldNodeId = index.get(removed.stableId);
    const newNodeId = index.get(replacement.stableId);
    if (oldNodeId === undefined || newNodeId === undefined || oldNodeId === newNodeId) continue;

    await rebindCrossNsNode(
      dbModule,
      oldNodeId,
      newNodeId,
      replacement.stableId,
    );
  }
}

async function rebindCrossNsNode(
  dbModule: IDbModule,
  oldNodeId: number,
  newNodeId: number,
  newStableId: string,
): Promise<void> {
  const rows = await dbModule.runQuery(
    `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance)
     WHERE x.source_node_id = $oldNodeId OR x.target_node_id = $oldNodeId
     RETURN x.edge_id AS edge_id, x.source_namespace AS source_namespace,
            x.target_namespace AS target_namespace, x.metamodel AS metamodel,
            x.relationship AS relationship, x.source_node_id AS source_node_id,
            x.target_node_id AS target_node_id, x.attributes AS attributes`,
    { oldNodeId },
  );

  const touchedSourceNamespaces = new Set<string>();
  for (const row of rows) {
    const edgeId = Number(row.edge_id);
    const relationship = String(row.relationship ?? '');
    const sourceNamespace = String(row.source_namespace ?? '');
    const targetNamespace = String(row.target_namespace ?? '');
    const metamodel = String(row.metamodel ?? '');
    const oldSourceNodeId = Number(row.source_node_id);
    const oldTargetNodeId = Number(row.target_node_id);
    const sourceNodeId = oldSourceNodeId === oldNodeId ? newNodeId : oldSourceNodeId;
    const targetNodeId = oldTargetNodeId === oldNodeId ? newNodeId : oldTargetNodeId;
    const attributes = parseJsonObject(row.attributes);
    if (oldSourceNodeId === oldNodeId) attributes.source_external_id = newStableId;
    if (oldTargetNodeId === oldNodeId) attributes.target_external_id = newStableId;

    // Remove the old graph edge before changing the backing record. Some older
    // data lacks edge_instance_id, so match by endpoints and relationship too.
    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE (r.edge_instance_id = $edgeId OR
              (src.node_id = $oldSourceNodeId AND tgt.node_id = $oldTargetNodeId AND
               r.relationship = $relationship AND r.source_namespace = $sourceNamespace AND
               r.target_namespace = $targetNamespace))
       DELETE r`,
      { edgeId, oldSourceNodeId, oldTargetNodeId, relationship, sourceNamespace, targetNamespace },
    );

    await dbModule.runQuery(
      `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance {edge_id: $edgeId})
       SET x.source_node_id = $sourceNodeId, x.target_node_id = $targetNodeId,
           x.attributes = $attributes`,
      {
        edgeId,
        sourceNodeId,
        targetNodeId,
        attributes: JSON.stringify(attributes),
      },
    );

    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance {node_id: $sourceNodeId}),
             (tgt:RIA_UNIV_ConceptInstance {node_id: $targetNodeId})
       CREATE (src)-[:RIA_UNIV_CROSSNS_INSTANCE_REL {
         edge_instance_id: $edgeId,
         relationship: $relationship,
         metamodel: $metamodel,
         source_namespace: $sourceNamespace,
         target_namespace: $targetNamespace
       }]->(tgt)`,
      { edgeId, sourceNodeId, targetNodeId, relationship, metamodel, sourceNamespace, targetNamespace },
    );

    if (sourceNamespace) touchedSourceNamespaces.add(sourceNamespace);
  }

  for (const namespace of touchedSourceNamespaces) {
    await invalidateHash(dbModule, namespace);
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function deleteNode(
  dbModule: IDbModule,
  nodeId: number,
): Promise<{ ok: boolean; error: string }> {
  try {
    // Remove intra-NS relationship instances
    await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId OR ri.target_node_id = $nodeId DELETE ri`,
      { nodeId },
    );
    // Remove cross-NS relationship instances
    await dbModule.runQuery(
      `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance)
       WHERE x.source_node_id = $nodeId OR x.target_node_id = $nodeId DELETE x`,
      { nodeId },
    );
    await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId}) DETACH DELETE ci`,
      { nodeId },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return { ok: false, error: `deleteNode(${nodeId}): ${String(err)}` };
  }
}

async function updateNodeAttributes(
  dbModule: IDbModule,
  nodeId: number,
  attributes: Record<string, unknown>,
): Promise<{ ok: boolean; error: string }> {
  try {
    const rows = await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId}) RETURN ci.attributes AS attrs`,
      { nodeId },
    );
    if (rows.length === 0) return { ok: false, error: `Node ${nodeId} not found` };
    const existing = JSON.parse(String(rows[0]?.attrs ?? '{}'));
    const merged = { ...existing, ...attributes };
    const mergedJson = JSON.stringify(merged);
    await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId}) SET ci.attributes = '${esc(mergedJson)}'`,
      { nodeId },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return { ok: false, error: `updateNodeAttributes(${nodeId}): ${String(err)}` };
  }
}

async function createEdge(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relationship: string,
  namespace: string,
  metamodel: string,
  attributes: Record<string, unknown>,
): Promise<{ ok: boolean; error: string }> {
  try {
    const attrsJson = JSON.stringify(attributes);
    const rows = await dbModule.runQuery(
      `CREATE (ri:RIA_UNIV_RelationshipInstance {
        namespace: '${esc(namespace)}',
        relationship: '${esc(relationship)}',
        metamodel: '${esc(metamodel)}',
        source_node_id: ${srcId},
        target_node_id: ${tgtId},
        attributes: '${esc(attrsJson)}'
      }) RETURN ri.edge_id AS edgeId`,
    );
    const edgeId = Number(rows[0]?.edgeId);
    if (!Number.isFinite(edgeId)) {
      throw new Error('created RelationshipInstance did not return an edge_id');
    }
    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
       WHERE src.node_id = $srcId AND tgt.node_id = $tgtId
       CREATE (src)-[:RIA_UNIV_INSTANCE_REL {
         edge_instance_id: $edgeId,
         relationship: $relationship,
         metamodel: $metamodel
       }]->(tgt)`,
      { srcId, tgtId, edgeId, relationship, metamodel },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return { ok: false, error: `createEdge(${srcId}->${tgtId} ${relationship}): ${String(err)}` };
  }
}

async function deleteEdge(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relationship: string,
): Promise<{ ok: boolean; error: string }> {
  try {
    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE src.node_id = $srcId AND tgt.node_id = $tgtId
         AND r.relationship = $relationship
       DELETE r`,
      { srcId, tgtId, relationship },
    );
    await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId
         AND ri.relationship = $relationship
       DELETE ri`,
      { srcId, tgtId, relationship },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return { ok: false, error: `deleteEdge(${srcId}->${tgtId} ${relationship}): ${String(err)}` };
  }
}

async function updateEdgeAttributes(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relationship: string,
  attributes: Record<string, unknown>,
): Promise<{ ok: boolean; error: string }> {
  try {
    const rows = await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId
         AND ri.relationship = $relationship
       RETURN ri.attributes AS attrs`,
      { srcId, tgtId, relationship },
    );
    if (rows.length === 0) return { ok: false, error: `Edge ${srcId}->${tgtId} ${relationship} not found` };
    const existing = JSON.parse(String(rows[0]?.attrs ?? '{}'));
    const merged = { ...existing, ...attributes };
    const mergedJson = JSON.stringify(merged);
    await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId
         AND ri.relationship = $relationship
       SET ri.attributes = '${esc(mergedJson)}'`,
      { srcId, tgtId, relationship },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return { ok: false, error: `updateEdgeAttributes(${srcId}->${tgtId}): ${String(err)}` };
  }
}

async function applyNodeChange(
  dbModule: IDbModule,
  changes: NamespaceDiffResult,
  stableId: string,
  changeKind: 'added' | 'deleted' | 'modified',
  side: 'left' | 'right',
  index: Map<string, number>,
  targetNamespace: string,
): Promise<{ ok: boolean; error: string }> {
  if (changeKind === 'added') {
    const node = changes.addedNodes.find(n => n.stableId === stableId);
    if (!node) return { ok: false, error: `Added node ${stableId} not found in changes` };
    const r = await createNode(dbModule, targetNamespace, node);
    if (r.ok) index.set(stableId, r.nodeId);
    return r;
  }

  if (changeKind === 'deleted') {
    const nodeId = index.get(stableId);
    if (nodeId === undefined) return { ok: false, error: `Node ${stableId} not found in ${targetNamespace}` };
    const r = await deleteNode(dbModule, nodeId);
    if (r.ok) index.delete(stableId);
    return r;
  }

  // modified
  const mod = changes.modifiedNodes.find(n => n.stableId === stableId);
  if (!mod) return { ok: false, error: `Modified node ${stableId} not found in changes` };
  const nodeId = index.get(stableId);
  if (nodeId === undefined) return { ok: false, error: `Node ${stableId} not found in ${targetNamespace}` };
  const attrs = side === 'left' ? mod.leftSnapshot.attributes : mod.rightSnapshot.attributes;
  return updateNodeAttributes(dbModule, nodeId, attrs);
}

/**
 * Resolve the node_id of a target node in another namespace using its stable ID.
 * The stable ID is stored in the node's attributes as stable_path, sysml_id, or uuid.
 * Returns undefined if no matching node is found.
 */
async function resolveTargetNodeId(
  dbModule: IDbModule,
  targetNamespace: string,
  targetStableId: string,
): Promise<number | undefined> {
  // Query all ConceptInstances in the target namespace and find the one whose
  // stable ID matches. We can't filter by stable_path in Cypher directly since
  // the value is embedded in a JSON attributes string.
  const rows = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
     RETURN ci.node_id AS node_id, ci.attributes AS attributes`,
    { namespace: targetNamespace },
  );
  for (const row of rows) {
    try {
      const attrs: Record<string, unknown> = JSON.parse(String(row.attributes ?? '{}'));
      const stableId = String(attrs.stable_path ?? attrs.sysml_id ?? attrs.uuid ?? '').trim();
      if (stableId === targetStableId) return Number(row.node_id);
    } catch {
      // skip unparseable rows
    }
  }
  return undefined;
}

/**
 * Create a cross-namespace edge: both the CrossNSRelationshipInstance node and
 * the CROSSNS_INSTANCE_REL graph edge.
 * Mirrors the same helper in union-merge-service.ts.
 */
async function createCrossNsEdge(
  dbModule: IDbModule,
  edge: CrossNsEdgeSnapshot,
  metamodel: string,
  srcId: number,
  tgtId: number,
): Promise<{ ok: boolean; error: string }> {
  try {
    const criAttrs = JSON.stringify({
      source_external_id: edge.sourceStableId,
      target_external_id: edge.targetStableId,
      ...edge.attributes,
    });
    const criRows = await dbModule.runQuery(
      `CREATE (r:RIA_UNIV_CrossNSRelationshipInstance {
         source_namespace: $sourceNs,
         target_namespace: $targetNs,
         metamodel:        $metamodel,
         relationship:     $relationship,
         source_node_id:   $srcId,
         target_node_id:   $tgtId,
         attributes:       $attrsJson
       }) RETURN r.edge_id AS edgeId`,
      {
        sourceNs: edge.sourceNamespace,
        targetNs: edge.targetNamespace,
        metamodel,
        relationship: edge.relationshipType,
        srcId,
        tgtId,
        attrsJson: criAttrs,
      },
    );
    const edgeId = Number(criRows[0]?.edgeId);
    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance {node_id: $srcId}),
             (tgt:RIA_UNIV_ConceptInstance {node_id: $tgtId})
       CREATE (src)-[:RIA_UNIV_CROSSNS_INSTANCE_REL {
         edge_instance_id: $edgeId,
         relationship:     $relationship,
         metamodel:        $metamodel,
         source_namespace: $sourceNs,
         target_namespace: $targetNs
       }]->(tgt)`,
      {
        srcId,
        tgtId,
        edgeId,
        relationship: edge.relationshipType,
        metamodel,
        sourceNs: edge.sourceNamespace,
        targetNs: edge.targetNamespace,
      },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `createCrossNsEdge(${edge.sourceNamespace}/${edge.sourceStableId}→${edge.targetNamespace}/${edge.targetStableId} ${edge.relationshipType}): ${String(err)}`,
    };
  }
}

/**
 * Delete a cross-namespace edge by source/target node IDs and relationship type.
 * Removes both the CrossNSRelationshipInstance node and the CROSSNS_INSTANCE_REL graph edge.
 */
async function deleteCrossNsEdge(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relationship: string,
): Promise<{ ok: boolean; error: string }> {
  try {
    // Find and delete the CROSSNS_INSTANCE_REL graph edge
    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE src.node_id = $srcId AND tgt.node_id = $tgtId AND r.relationship = $relationship
       DELETE r`,
      { srcId, tgtId, relationship },
    );
    // Delete the CrossNSRelationshipInstance node
    await dbModule.runQuery(
      `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance)
       WHERE x.source_node_id = $srcId AND x.target_node_id = $tgtId AND x.relationship = $relationship
       DELETE x`,
      { srcId, tgtId, relationship },
    );
    return { ok: true, error: '' };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `deleteCrossNsEdge(${srcId}→${tgtId} ${relationship}): ${String(err)}`,
    };
  }
}
