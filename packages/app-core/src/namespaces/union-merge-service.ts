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
 * IUnionMergeService — applies a union (non-destructive) merge of a diff result
 * into a live namespace.
 *
 * Union merge rules (UC-13, UC-14):
 *  - Incoming nodes not in live    → CREATE
 *  - Incoming nodes already in live → UPDATE with { ...live, ...incoming } attrs
 *  - Live nodes absent in incoming → KEEP (never deleted)
 *  - Incoming within-ns edges not in live    → CREATE (only if both endpoints exist)
 *  - Incoming within-ns edges already in live → UPDATE attrs with same union rule
 *  - Live within-ns edges absent in incoming → KEEP (never deleted)
 *  - Incoming cross-ns edges not in live → CREATE (only if both endpoints exist)
 *  - Incoming cross-ns edges already in live → UPDATE attrs with union rule
 *  - Live cross-ns edges absent in incoming → KEEP (never deleted)
 *  - CATEGORIZEDBY wiring re-derived from existing per-pair connections (idempotent)
 */

import type { IDbModule } from '../db/db-module.js';
import type {
  NamespaceDiffResult,
  UnionMergeResult,
  NodeSnapshot,
  CrossNsEdgeSnapshot,
} from '@riacore/app-contracts';
import { createConnectionService } from './connection-service.js';

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
 * Build a stableId → nodeId map for a single namespace.
 * StableId is resolved from the first non-empty value of:
 *   stable_path, sysml_id, or uuid in the node's attributes.
 */
async function buildStableIdIndex(
  dbModule: IDbModule,
  namespace: string,
): Promise<Map<string, number>> {
  const rows = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
     RETURN ci.node_id AS node_id, ci.attributes AS attributes`,
    { namespace },
  );

  const index = new Map<string, number>();
  for (const row of rows) {
    const attrs: Record<string, unknown> = JSON.parse(String(row.attributes ?? '{}'));
    const stableId =
      String(attrs.stable_path ?? attrs.sysml_id ?? attrs.uuid ?? '').trim();
    if (stableId) {
      index.set(stableId, Number(row.node_id));
    }
  }
  return index;
}

/**
 * Build a combined stableId → nodeId map for multiple namespaces.
 * Keys are `${namespace}::${stableId}` to avoid cross-namespace collisions.
 */
async function buildMultiNamespaceIndex(
  dbModule: IDbModule,
  namespaces: string[],
): Promise<Map<string, number>> {
  const combined = new Map<string, number>();
  for (const ns of [...new Set(namespaces)]) {
    const nsIndex = await buildStableIdIndex(dbModule, ns);
    for (const [stableId, nodeId] of nsIndex) {
      combined.set(`${ns}::${stableId}`, nodeId);
    }
  }
  return combined;
}

type OpResult = { ok: true; nodeId: number } | { ok: false; error: string };
type VoidOpResult = { ok: true } | { ok: false; error: string };

async function createNode(
  dbModule: IDbModule,
  namespace: string,
  metamodel: string,
  node: NodeSnapshot,
): Promise<OpResult> {
  try {
    const attrsJson = JSON.stringify(node.attributes);
    const rows = await dbModule.runQuery(
      `CREATE (ci:RIA_UNIV_ConceptInstance {
         namespace:  $namespace,
         concept:    $conceptType,
         metamodel:  $metamodel,
         attributes: $attrsJson
       }) RETURN ci.node_id AS node_id`,
      { namespace, conceptType: node.conceptType, metamodel, attrsJson },
    );
    const nodeId = Number(rows[0]?.node_id);
    return { ok: true, nodeId };
  } catch (err) {
    return { ok: false, error: `Failed to create node '${node.stableId}': ${String(err)}` };
  }
}

async function updateNodeAttributes(
  dbModule: IDbModule,
  nodeId: number,
  incomingAttrs: Record<string, unknown>,
): Promise<VoidOpResult> {
  try {
    const existing = await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id = $nodeId
       RETURN ci.attributes AS attributes`,
      { nodeId },
    );
    const existingAttrs: Record<string, unknown> = JSON.parse(
      String(existing[0]?.attributes ?? '{}'),
    );
    const merged = { ...existingAttrs, ...incomingAttrs };
    await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id = $nodeId
       SET ci.attributes = $attrsJson`,
      { nodeId, attrsJson: JSON.stringify(merged) },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to update node ${nodeId}: ${String(err)}` };
  }
}

async function edgeExists(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relType: string,
): Promise<boolean> {
  const rows = await dbModule.runQuery(
    `MATCH (ri:RIA_UNIV_RelationshipInstance)
     WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId
       AND ri.relationship = $relType
     RETURN count(ri) AS cnt`,
    { srcId, tgtId, relType },
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function createEdge(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relType: string,
  namespace: string,
  metamodel: string,
  attrs: Record<string, unknown>,
): Promise<VoidOpResult> {
  try {
    const attrsJson = JSON.stringify(attrs);
    // Create the RIA_UNIV_RelationshipInstance node (the persistor queries this
    // table to serialize relationships to ria-data/ files).
    const riRows = await dbModule.runQuery(
      `CREATE (ri:RIA_UNIV_RelationshipInstance {
        namespace: '${esc(namespace)}',
        relationship: '${esc(relType)}',
        metamodel: '${esc(metamodel)}',
        source_node_id: ${srcId},
        target_node_id: ${tgtId},
        attributes: '${esc(attrsJson)}'
      }) RETURN ri.edge_id AS edgeId`,
    );
    const edgeId = Number(riRows[0]?.edgeId);

    // Create the INSTANCE_REL graph edge for graph traversal queries.
    await dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
       WHERE src.node_id = ${srcId} AND tgt.node_id = ${tgtId}
       CREATE (src)-[:RIA_UNIV_INSTANCE_REL {
         edge_instance_id: ${edgeId},
         relationship: '${esc(relType)}',
         metamodel: '${esc(metamodel)}'
       }]->(tgt)`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to create edge ${srcId}->${tgtId} (${relType}): ${String(err)}` };
  }
}

async function updateEdgeAttributes(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relType: string,
  incomingAttrs: Record<string, unknown>,
): Promise<VoidOpResult> {
  try {
    const existing = await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId
         AND ri.relationship = $relType
       RETURN ri.attributes AS attributes`,
      { srcId, tgtId, relType },
    );
    const existingAttrs: Record<string, unknown> = JSON.parse(
      String(existing[0]?.attributes ?? '{}'),
    );
    const merged = { ...existingAttrs, ...incomingAttrs };
    await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId
         AND ri.relationship = $relType
       SET ri.attributes = $attrsJson`,
      { srcId, tgtId, relType, attrsJson: JSON.stringify(merged) },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to update edge ${srcId}->${tgtId} (${relType}): ${String(err)}` };
  }
}

// ── Cross-namespace helpers ────────────────────────────────────────────────────

/**
 * Check whether a CROSSNS_INSTANCE_REL edge already exists between two nodes
 * for a given relationship type.
 */
async function crossNsEdgeExists(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relationship: string,
): Promise<boolean> {
  const rows = await dbModule.runQuery(
    `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance)
     WHERE a.node_id = $srcId AND b.node_id = $tgtId AND r.relationship = $rel
     RETURN count(r) AS cnt`,
    { srcId, tgtId, rel: relationship },
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

/**
 * Create a cross-namespace edge: both the CrossNSRelationshipInstance node and
 * the CROSSNS_INSTANCE_REL graph edge.
 */
async function createCrossNsEdge(
  dbModule: IDbModule,
  edge: CrossNsEdgeSnapshot,
  metamodel: string,
  srcId: number,
  tgtId: number,
): Promise<VoidOpResult> {
  try {
    // Attributes follow the convention from instance-service.ts: always include
    // source/target external IDs for persistor round-trip, merged with any
    // additional domain attributes from the snapshot.
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
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create cross-ns edge '${edge.sourceNamespace}/${edge.sourceStableId}→${edge.targetNamespace}/${edge.targetStableId}' (${edge.relationshipType}): ${String(err)}`,
    };
  }
}

/**
 * Update the attributes of an existing cross-namespace edge (union rule).
 */
async function updateCrossNsEdgeAttributes(
  dbModule: IDbModule,
  srcId: number,
  tgtId: number,
  relationship: string,
  incomingAttrs: Record<string, unknown>,
): Promise<VoidOpResult> {
  try {
    const existing = await dbModule.runQuery(
      `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
       WHERE cri.source_node_id = $srcId AND cri.target_node_id = $tgtId
         AND cri.relationship = $rel
       RETURN cri.attributes AS attributes`,
      { srcId, tgtId, rel: relationship },
    );
    const existingAttrs: Record<string, unknown> = JSON.parse(
      String(existing[0]?.attributes ?? '{}'),
    );
    const merged = { ...existingAttrs, ...incomingAttrs };
    await dbModule.runQuery(
      `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
       WHERE cri.source_node_id = $srcId AND cri.target_node_id = $tgtId
         AND cri.relationship = $rel
       SET cri.attributes = $attrsJson`,
      { srcId, tgtId, rel: relationship, attrsJson: JSON.stringify(merged) },
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to update cross-ns edge ${srcId}→${tgtId} (${relationship}): ${String(err)}`,
    };
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IUnionMergeService {
  /**
   * Apply a union (additive-only) merge from the right side of `diffResult`
   * into `targetNamespace`. The diff must have been computed with the live
   * namespace as left and the incoming snapshot as right (liveIsLeft: true).
   *
   * Cross-namespace edges (addedCrossNsEdges, modifiedCrossNsEdges) are merged,
   * and CATEGORIZEDBY wiring on the peer namespaces is auto-created (idempotent).
   *
   * NOTE: This method only updates the database. The caller must call store() to
   * write the changes back to ria-data/ files.
   *
   * Deleted nodes/edges in the diff are IGNORED — only additions and
   * modifications are applied.
   */
  applyUnionMerge(params: {
    diffResult: NamespaceDiffResult;
    targetNamespace: string;
    source: 'files' | 'branch';
    sourceBranch?: string;
  }): Promise<UnionMergeResult>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createUnionMergeService(dbModule: IDbModule): IUnionMergeService {
  return {
    async applyUnionMerge({ diffResult, targetNamespace, source, sourceBranch }) {
      const warnings: string[] = [];
      let nodesAdded = 0;
      let nodesUpdated = 0;
      let edgesAdded = 0;
      let edgesUpdated = 0;
      let edgesSkipped = 0;
      let crossNsEdgesAdded = 0;
      let crossNsEdgesUpdated = 0;
      let crossNsEdgesSkipped = 0;

      const metamodel = diffResult.metamodel;
      const index = await buildStableIdIndex(dbModule, targetNamespace);

      // ── Node additions: nodes in incoming but not in live ─────────────────
      for (const node of diffResult.addedNodes) {
        const r = await createNode(dbModule, targetNamespace, metamodel, node);
        if (!r.ok) {
          warnings.push(r.error);
        } else {
          nodesAdded++;
          index.set(node.stableId, r.nodeId);
        }
      }

      // ── Node updates: nodes in both, apply union attributes ───────────────
      for (const mod of diffResult.modifiedNodes) {
        const nodeId = index.get(mod.stableId);
        if (nodeId === undefined) {
          warnings.push(`Node '${mod.stableId}' not found in ${targetNamespace} for update`);
          continue;
        }
        const r = await updateNodeAttributes(dbModule, nodeId, mod.rightSnapshot.attributes);
        if (!r.ok) {
          warnings.push(r.error);
        } else {
          nodesUpdated++;
        }
      }

      // ── deletedNodes are intentionally skipped (union merge rule) ─────────

      // ── Edge additions: edges in incoming but not in live ─────────────────
      for (const edge of diffResult.addedEdges) {
        const srcId = index.get(edge.sourceStableId);
        const tgtId = index.get(edge.targetStableId);
        if (!srcId || !tgtId) {
          edgesSkipped++;
          warnings.push(
            `Skipped edge '${edge.sourceStableId}→${edge.targetStableId}' (${edge.relationshipType}): endpoint node(s) not found`,
          );
          continue;
        }
        const r = await createEdge(dbModule, srcId, tgtId, edge.relationshipType, targetNamespace, metamodel, edge.attributes);
        if (!r.ok) {
          warnings.push(r.error);
        } else {
          edgesAdded++;
        }
      }

      // ── Edge updates: edges in both, apply union attributes ───────────────
      for (const mod of diffResult.modifiedEdges) {
        const srcId = index.get(mod.sourceStableId);
        const tgtId = index.get(mod.targetStableId);
        if (!srcId || !tgtId) {
          edgesSkipped++;
          warnings.push(
            `Skipped edge update '${mod.sourceStableId}→${mod.targetStableId}' (${mod.relationshipType}): endpoint node(s) not found`,
          );
          continue;
        }
        const r = await updateEdgeAttributes(dbModule, srcId, tgtId, mod.relationshipType, mod.rightSnapshot.attributes);
        if (!r.ok) {
          warnings.push(r.error);
        } else {
          edgesUpdated++;
        }
      }

      // ── deletedEdges are intentionally skipped (union merge rule) ─────────

      // ── Cross-namespace edges ─────────────────────────────────────────────
      const allCrossNsEdges = [
        ...diffResult.addedCrossNsEdges,
        ...diffResult.modifiedCrossNsEdges.map(m => m.rightSnapshot),
      ];

      if (allCrossNsEdges.length > 0) {
        // Collect all unique peer namespaces (the ones that are NOT targetNamespace)
        const peerNamespaces = new Set<string>();
        for (const e of allCrossNsEdges) {
          if (e.sourceNamespace !== targetNamespace) peerNamespaces.add(e.sourceNamespace);
          if (e.targetNamespace !== targetNamespace) peerNamespaces.add(e.targetNamespace);
        }

        // Build a combined stableId index with `${namespace}::${stableId}` keys.
        // Seed with the target namespace index (includes newly added nodes).
        const multiIndex = new Map<string, number>();
        for (const [stableId, nodeId] of index) {
          multiIndex.set(`${targetNamespace}::${stableId}`, nodeId);
        }
        if (peerNamespaces.size > 0) {
          const peerIndex = await buildMultiNamespaceIndex(dbModule, [...peerNamespaces]);
          for (const [key, nodeId] of peerIndex) {
            multiIndex.set(key, nodeId);
          }
        }

        // Re-derive CATEGORIZEDBY wiring from existing per-pair connections only.
        // For each peer (imported) namespace, find the authored namespaces resolving
        // to `metamodel` that it is *already connected to* via surviving per-pair
        // RIA_UNIV_NamespaceConnection edges (which round-trip by name and therefore
        // survive the node-ID reassignment a merge performs), and route each through
        // ConnectionService.connect. connect() idempotently re-ensures the derived
        // RIA_META_CATEGORIZEDBY edge, so it stays a function of existing per-pair
        // edges — no blanket wiring is re-introduced.
        const connectionService = createConnectionService(dbModule);
        for (const peerNs of peerNamespaces) {
          let connectedAuthored: string[] = [];
          try {
            const rows = await dbModule.runQuery(
              `MATCH (i:RIA_UNIV_Namespace {name: $ns})-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace)
               OPTIONAL MATCH (a)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
               WITH a, coalesce(mm.name, a.metamodel) AS mmName
               WHERE mmName = $mm
               RETURN DISTINCT a.name AS authoredNs`,
              { ns: peerNs, mm: metamodel },
            );
            connectedAuthored = rows.map(r => String(r.authoredNs));
          } catch {
            warnings.push(`Could not resolve connections for namespace '${peerNs}' → '${metamodel}'`);
            continue;
          }
          for (const authoredNs of connectedAuthored) {
            const res = await connectionService.connect(peerNs, authoredNs);
            if (!res.ok) {
              warnings.push(`Could not wire connection '${peerNs}' → '${authoredNs}': ${res.error}`);
            }
          }
        }

        // ── Added cross-ns edges ────────────────────────────────────────────
        for (const edge of diffResult.addedCrossNsEdges) {
          const srcId = multiIndex.get(`${edge.sourceNamespace}::${edge.sourceStableId}`);
          const tgtId = multiIndex.get(`${edge.targetNamespace}::${edge.targetStableId}`);
          if (!srcId || !tgtId) {
            crossNsEdgesSkipped++;
            warnings.push(
              `Skipped cross-ns edge '${edge.sourceNamespace}/${edge.sourceStableId}→${edge.targetNamespace}/${edge.targetStableId}' (${edge.relationshipType}): endpoint node(s) not found`,
            );
            continue;
          }
          // Idempotent: skip if already exists
          const exists = await crossNsEdgeExists(dbModule, srcId, tgtId, edge.relationshipType);
          if (exists) {
            continue;
          }
          const r = await createCrossNsEdge(dbModule, edge, metamodel, srcId, tgtId);
          if (!r.ok) {
            warnings.push(r.error);
            crossNsEdgesSkipped++;
          } else {
            crossNsEdgesAdded++;
          }
        }

        // ── Modified cross-ns edges ─────────────────────────────────────────
        for (const mod of diffResult.modifiedCrossNsEdges) {
          const edge = mod.rightSnapshot;
          const srcId = multiIndex.get(`${edge.sourceNamespace}::${edge.sourceStableId}`);
          const tgtId = multiIndex.get(`${edge.targetNamespace}::${edge.targetStableId}`);
          if (!srcId || !tgtId) {
            crossNsEdgesSkipped++;
            warnings.push(
              `Skipped cross-ns edge update '${edge.sourceNamespace}/${edge.sourceStableId}→${edge.targetNamespace}/${edge.targetStableId}' (${edge.relationshipType}): endpoint node(s) not found`,
            );
            continue;
          }
          const r = await updateCrossNsEdgeAttributes(
            dbModule, srcId, tgtId, edge.relationshipType, edge.attributes,
          );
          if (!r.ok) {
            warnings.push(r.error);
            crossNsEdgesSkipped++;
          } else {
            crossNsEdgesUpdated++;
          }
        }
      }

      // Invalidate the content hash so that the subsequent store() call will
      // unconditionally re-export this namespace to ria-data/ files.
      await invalidateHash(dbModule, targetNamespace);

      return {
        namespace: targetNamespace,
        source,
        sourceBranch,
        mergedAt: new Date().toISOString(),
        nodesAdded,
        nodesUpdated,
        edgesAdded,
        edgesUpdated,
        edgesSkipped,
        crossNsEdgesAdded,
        crossNsEdgesUpdated,
        crossNsEdgesSkipped,
        warnings,
        mergeApplied: true,
      } satisfies UnionMergeResult;
    },
  };
}
