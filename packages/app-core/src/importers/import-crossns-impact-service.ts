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
 * Import Cross-Namespace Impact Service — standalone domain service for
 * assessing the impact on cross-namespace relationships when an imported
 * namespace is updated.
 *
 * Snapshots boundary nodes before wipe, classifies them after import,
 * and produces an ImpactReport. Namespace-agnostic and reusable.
 */

import type {
  CrossNsSnapshot,
  BoundaryNodeSnapshot,
  AffectedEdge,
  ImpactReport,
  OrphanedEntry,
  ModifiedEntry,
} from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IImportCrossNsImpactService {
  snapshotBoundary(namespace: string): Promise<CrossNsSnapshot>;
  classifyImpact(
    snapshot: CrossNsSnapshot,
    namespace: string,
    runId: string,
  ): Promise<ImpactReport>;
  /**
   * Re-create cross-NS edges for stable and modified boundary nodes.
   * Uses the snapshot's affectedEdges and the new node IDs from classification.
   * Returns the number of edges reconnected.
   */
  reconnectEdges(
    snapshot: CrossNsSnapshot,
    report: ImpactReport,
    namespace: string,
  ): Promise<number>;
  /**
   * Reconnect a single orphaned boundary node to a new imported node ID.
   * Used when the user accepts a rename hint or manually selects a replacement.
   * Recreates all cross-NS edges from the orphaned entry's affectedEdges,
   * pointing them at newImportedNodeId instead of the old (now-missing) node.
   * Returns the number of edges reconnected.
   */
  reconnectOrphanedEntry(
    entry: OrphanedEntry,
    newImportedNodeId: number,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape single-quotes and backslashes for Cypher string literals. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Safely parse a JSON attributes string, returning {} on failure. */
function safeParseAttributes(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Extract authoredName from authored node attributes (short_name or name). */
function extractAuthoredName(attrs: Record<string, unknown>): string {
  if (typeof attrs.short_name === 'string' && attrs.short_name) return attrs.short_name;
  if (typeof attrs.name === 'string' && attrs.name) return attrs.name;
  if (typeof attrs.has_name === 'string' && attrs.has_name) return attrs.has_name;
  return '';
}

/**
 * Extract the stable identifier from authored node attributes.
 * Tries the common identity attribute names in priority order.
 * Used to populate `source_external_id` / `target_external_id` in the
 * CrossNSRelationshipInstance attributes so the persistor can sort and hash
 * cross-NS rows deterministically.
 */
function extractStableId(attrs: Record<string, unknown>): string {
  // SAFETY_ANALYSIS: uuid is the identity attribute
  if (typeof attrs.uuid === 'string' && attrs.uuid) return attrs.uuid;
  // SN_sw_requirements: id
  if (typeof attrs.id === 'string' && attrs.id) return attrs.id;
  // ARXML / TS-symbols: stable_path
  if (typeof attrs.stable_path === 'string' && attrs.stable_path) return attrs.stable_path;
  return '';
}

interface ResolvedConceptInstance {
  nodeId: number;
  namespace: string;
  concept: string;
  attributes: Record<string, unknown>;
  stableId: string;
}

async function resolveConceptInstance(
  dbModule: IDbModule,
  nodeId: number,
): Promise<ResolvedConceptInstance | null> {
  const rows = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
     RETURN ci.node_id AS nodeId, ci.namespace AS namespace,
            ci.concept AS concept, ci.attributes AS attributes`,
    { nodeId },
  );
  if (rows.length === 0) return null;
  const attributes = safeParseAttributes(rows[0].attributes);
  return {
    nodeId: Number(rows[0].nodeId),
    namespace: String(rows[0].namespace ?? ''),
    concept: String(rows[0].concept ?? ''),
    attributes,
    stableId: extractStableId(attributes),
  };
}

/**
 * Resolve the authored endpoint again at reconnect time. Import reports may
 * outlive a DB reload, so their numeric node IDs are hints only; the stable ID
 * captured in the report is the authoritative identity.
 */
async function resolveAuthoredEndpoint(
  dbModule: IDbModule,
  edge: AffectedEdge,
): Promise<ResolvedConceptInstance | null> {
  const rows = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance)
     WHERE ci.namespace = $namespace AND ci.concept = $concept
     RETURN ci.node_id AS nodeId, ci.namespace AS namespace,
            ci.concept AS concept, ci.attributes AS attributes`,
    { namespace: edge.authoredNamespace, concept: edge.authoredConcept },
  );

  let fallback: ResolvedConceptInstance | null = null;
  for (const row of rows) {
    const attributes = safeParseAttributes(row.attributes);
    const resolved: ResolvedConceptInstance = {
      nodeId: Number(row.nodeId),
      namespace: String(row.namespace ?? ''),
      concept: String(row.concept ?? ''),
      attributes,
      stableId: extractStableId(attributes),
    };
    if (edge.authoredStableId && resolved.stableId === edge.authoredStableId) {
      return resolved;
    }
    if (resolved.nodeId === edge.authoredNodeId) fallback = resolved;
  }

  // Older reports may not contain authoredStableId. In that case the captured
  // node ID is still usable, but only after namespace/concept validation above.
  return edge.authoredStableId ? null : fallback;
}

/**
 * Build the `attributes` JSON string for a CrossNSRelationshipInstance node.
 *
 * `source_external_id` and `target_external_id` encode the stable identifiers
 * of both endpoints. The persistor reads these to:
 *   1. Sort cross-NS rows deterministically when writing ria-data JSON files.
 *   2. Resolve node IDs when loading back from ria-data.
 *
 * Without them the rows are sorted in an arbitrary order, causing the
 * namespace hash to differ between runs and triggering false "file integrity
 * check failed" errors on the next workspace open.
 *
 * @param sourceStableId  Stable ID of the source node (imported side's stable_path or authored uuid/id).
 * @param targetStableId  Stable ID of the target node.
 */
function buildCrossNsAttributes(sourceStableId: string, targetStableId: string): string {
  return JSON.stringify({ source_external_id: sourceStableId, target_external_id: targetStableId });
}

// ---------------------------------------------------------------------------
// Snapshot Cypher — UNION of source and target cross-NS edges
// ---------------------------------------------------------------------------

const SNAPSHOT_QUERY = `
MATCH (ci:RIA_UNIV_ConceptInstance)-[:RIA_UNIV_CROSSNS_INSTANCE_REL]->(authored:RIA_UNIV_ConceptInstance)
WHERE ci.namespace = $namespace
  AND authored.namespace <> $namespace
MATCH (authNs:RIA_UNIV_Namespace {name: authored.namespace})
WHERE authNs.namespace_role = 'authored'
MATCH (xr:RIA_UNIV_CrossNSRelationshipInstance)
WHERE xr.source_namespace = $namespace
  AND xr.target_namespace = authored.namespace
  AND xr.source_node_id = ci.node_id
  AND xr.target_node_id = authored.node_id
RETURN ci.node_id AS boundaryNodeId,
       ci.concept AS concept,
       ci.attributes AS attributes,
       xr.relationship AS relationship,
       xr.metamodel AS metamodel,
       xr.source_namespace AS sourceNamespace,
       xr.target_namespace AS targetNamespace,
       authored.node_id AS authoredNodeId,
       authored.namespace AS authoredNamespace,
       authored.concept AS authoredConcept,
       authored.attributes AS authoredAttributes

UNION ALL

MATCH (authored:RIA_UNIV_ConceptInstance)-[:RIA_UNIV_CROSSNS_INSTANCE_REL]->(ci:RIA_UNIV_ConceptInstance)
WHERE ci.namespace = $namespace
  AND authored.namespace <> $namespace
MATCH (authNs:RIA_UNIV_Namespace {name: authored.namespace})
WHERE authNs.namespace_role = 'authored'
MATCH (xr:RIA_UNIV_CrossNSRelationshipInstance)
WHERE xr.target_namespace = $namespace
  AND xr.source_namespace = authored.namespace
  AND xr.target_node_id = ci.node_id
  AND xr.source_node_id = authored.node_id
RETURN ci.node_id AS boundaryNodeId,
       ci.concept AS concept,
       ci.attributes AS attributes,
       xr.relationship AS relationship,
       xr.metamodel AS metamodel,
       xr.source_namespace AS sourceNamespace,
       xr.target_namespace AS targetNamespace,
       authored.node_id AS authoredNodeId,
       authored.namespace AS authoredNamespace,
       authored.concept AS authoredConcept,
       authored.attributes AS authoredAttributes
`;

const CLASSIFICATION_QUERY = `
MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.namespace = $namespace
RETURN ci.node_id AS nodeId, ci.attributes AS attributes, ci.concept AS concept
`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createImportCrossNsImpactService(
  dbModule: IDbModule,
): IImportCrossNsImpactService {
  return {
    // -----------------------------------------------------------------
    // snapshotBoundary
    // -----------------------------------------------------------------
    async snapshotBoundary(namespace: string): Promise<CrossNsSnapshot> {
      // Check if namespace exists; return empty snapshot if not
      const nsRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $namespace RETURN count(ns) AS cnt`,
        { namespace },
      );
      if (Number(nsRows[0]?.cnt ?? 0) === 0) {
        return {
          namespace,
          boundaryNodes: [],
          capturedAt: new Date().toISOString(),
        };
      }

      const rows = await dbModule.runQuery(SNAPSHOT_QUERY, { namespace });

      // Group rows by boundaryNodeId
      const groupMap = new Map<
        number,
        {
          concept: string;
          attributes: Record<string, unknown>;
          edges: AffectedEdge[];
        }
      >();

      for (const row of rows) {
        const boundaryNodeId = Number(row.boundaryNodeId);
        const concept = String(row.concept ?? '');
        const attributes = safeParseAttributes(row.attributes);
        const authoredAttrs = safeParseAttributes(row.authoredAttributes);

        const edge: AffectedEdge = {
          relationship: String(row.relationship ?? ''),
          metamodel: String(row.metamodel ?? ''),
          sourceNamespace: String(row.sourceNamespace ?? ''),
          targetNamespace: String(row.targetNamespace ?? ''),
          authoredNodeId: Number(row.authoredNodeId),
          authoredNamespace: String(row.authoredNamespace ?? ''),
          authoredConcept: String(row.authoredConcept ?? ''),
          authoredName: extractAuthoredName(authoredAttrs),
          authoredStableId: extractStableId(authoredAttrs),
        };

        const existing = groupMap.get(boundaryNodeId);
        if (existing) {
          existing.edges.push(edge);
        } else {
          groupMap.set(boundaryNodeId, { concept, attributes, edges: [edge] });
        }
      }

      // Build BoundaryNodeSnapshot array
      const boundaryNodes: BoundaryNodeSnapshot[] = [];
      for (const [, entry] of groupMap) {
        const stablePath =
          typeof entry.attributes.stable_path === 'string'
            ? entry.attributes.stable_path
            : '';
        boundaryNodes.push({
          stablePath,
          concept: entry.concept,
          attributes: entry.attributes,
          affectedEdges: entry.edges,
        });
      }

      return {
        namespace,
        boundaryNodes,
        capturedAt: new Date().toISOString(),
      };
    },

    // -----------------------------------------------------------------
    // classifyImpact
    // -----------------------------------------------------------------
    async classifyImpact(
      snapshot: CrossNsSnapshot,
      namespace: string,
      runId: string,
    ): Promise<ImpactReport> {
      // Load all new namespace nodes
      const rows = await dbModule.runQuery(CLASSIFICATION_QUERY, { namespace });

      // Build stable_path → { nodeId, attributes, concept } map
      const newNsMap = new Map<
        string,
        { nodeId: number; attributes: Record<string, unknown>; concept: string }
      >();
      // Also build uuid → { stablePath, nodeId } map for rename hints
      const uuidMap = new Map<string, { stablePath: string; nodeId: number }>();

      for (const row of rows) {
        const attrs = safeParseAttributes(row.attributes);
        const nodeId = Number(row.nodeId);
        const concept = String(row.concept ?? '');
        const stablePath =
          typeof attrs.stable_path === 'string' ? attrs.stable_path : '';

        if (stablePath) {
          newNsMap.set(stablePath, { nodeId, attributes: attrs, concept });
        }

        // Index by uuid for rename hint lookups
        const uuid = typeof attrs.uuid === 'string' ? attrs.uuid : '';
        if (uuid) {
          uuidMap.set(uuid, { stablePath, nodeId });
        }
      }

      const orphaned: OrphanedEntry[] = [];
      const modified: ModifiedEntry[] = [];
      let stableCount = 0;

      for (const entry of snapshot.boundaryNodes) {
        const newNode = newNsMap.get(entry.stablePath);

        if (!newNode) {
          // Orphaned — check for uuid rename hint
          const orphanedEntry: OrphanedEntry = {
            stablePath: entry.stablePath,
            concept: entry.concept,
            attributes: entry.attributes,
            affectedEdges: entry.affectedEdges,
          };

          const uuid =
            typeof entry.attributes.uuid === 'string'
              ? entry.attributes.uuid
              : '';
          if (uuid) {
            const renameMatch = uuidMap.get(uuid);
            if (renameMatch) {
              orphanedEntry.possibleRenameTarget = {
                stablePath: renameMatch.stablePath,
                nodeId: renameMatch.nodeId,
              };
            }
          }

          orphaned.push(orphanedEntry);
        } else {
          // Match found — compare attributes
          const changedKeys = diffAttributeKeys(
            entry.attributes,
            newNode.attributes,
          );

          if (changedKeys.length > 0) {
            modified.push({
              stablePath: entry.stablePath,
              concept: entry.concept,
              changedKeys,
              oldAttributes: entry.attributes,
              newAttributes: newNode.attributes,
              newNodeId: newNode.nodeId,
              affectedEdges: entry.affectedEdges,
            });
          } else {
            stableCount++;
          }
        }
      }

      return {
        namespace,
        runId,
        orphaned,
        modified,
        stableCount,
      };
    },

    // -----------------------------------------------------------------
    // reconnectEdges
    // -----------------------------------------------------------------
    async reconnectEdges(
      snapshot: CrossNsSnapshot,
      report: ImpactReport,
      namespace: string,
    ): Promise<number> {
      // Build a map of stablePath → newNodeId for stable and modified nodes
      // For modified nodes, we have newNodeId directly
      // For stable nodes, we need to query the namespace

      // Load all new namespace nodes to resolve stable node IDs
      const rows = await dbModule.runQuery(CLASSIFICATION_QUERY, { namespace });
      const newNsMap = new Map<string, number>();
      for (const row of rows) {
        const attrs = safeParseAttributes(row.attributes);
        const sp = typeof attrs.stable_path === 'string' ? attrs.stable_path : '';
        if (sp) newNsMap.set(sp, Number(row.nodeId));
      }

      // Collect edges to reconnect: stable entries from snapshot + modified entries from report
      const edgesToReconnect: Array<{
        newImportedNodeId: number;
        importedStablePath: string;
        edge: AffectedEdge;
      }> = [];

      // Stable entries: nodes in snapshot that are NOT in orphaned or modified
      const orphanedPaths = new Set(report.orphaned.map(e => e.stablePath));
      const modifiedPaths = new Set(report.modified.map(e => e.stablePath));

      for (const entry of snapshot.boundaryNodes) {
        if (orphanedPaths.has(entry.stablePath) || modifiedPaths.has(entry.stablePath)) continue;
        // This is a stable entry
        const newNodeId = newNsMap.get(entry.stablePath);
        if (newNodeId == null) continue;
        for (const edge of entry.affectedEdges) {
          edgesToReconnect.push({ newImportedNodeId: newNodeId, importedStablePath: entry.stablePath, edge });
        }
      }

      // Modified entries: reconnect with the new node ID
      for (const entry of report.modified) {
        for (const edge of entry.affectedEdges) {
          edgesToReconnect.push({ newImportedNodeId: entry.newNodeId, importedStablePath: entry.stablePath, edge });
        }
      }

      let reconnected = 0;
      const touchedSourceNamespaces = new Set<string>();

      for (const { newImportedNodeId, importedStablePath, edge } of edgesToReconnect) {
        // Use metamodel and direction captured in the snapshot edge —
        // no need to look up NamespaceRelation gates.
        const metamodel = edge.metamodel;
        const sourceNodeId = edge.sourceNamespace === edge.authoredNamespace ? edge.authoredNodeId : newImportedNodeId;
        const targetNodeId = edge.targetNamespace === edge.authoredNamespace ? edge.authoredNodeId : newImportedNodeId;
        const sourceNamespace = edge.sourceNamespace;
        const targetNamespace = edge.targetNamespace;

        // Build stable-ID attributes for deterministic persistor sort and hash.
        // The source_external_id / target_external_id identify both endpoints by
        // their stable paths so the persistor can sort cross-NS rows consistently
        // and load them back without relying on ephemeral node IDs.
        const sourceStableId = edge.sourceNamespace === edge.authoredNamespace ? edge.authoredStableId : importedStablePath;
        const targetStableId = edge.targetNamespace === edge.authoredNamespace ? edge.authoredStableId : importedStablePath;
        const criAttrs = buildCrossNsAttributes(sourceStableId, targetStableId);

        // Create CrossNSRelationshipInstance node
        await dbModule.runQuery(
          `CREATE (:RIA_UNIV_CrossNSRelationshipInstance {
            source_namespace: '${esc(sourceNamespace)}',
            target_namespace: '${esc(targetNamespace)}',
            metamodel: '${esc(metamodel)}',
            relationship: '${esc(edge.relationship)}',
            source_node_id: ${sourceNodeId},
            target_node_id: ${targetNodeId},
            attributes: '${esc(criAttrs)}'
          })`,
        );

        // Create CROSSNS_INSTANCE_REL graph edge
        await dbModule.runQuery(
          `MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
           WHERE src.node_id = ${sourceNodeId} AND tgt.node_id = ${targetNodeId}
           CREATE (src)-[:RIA_UNIV_CROSSNS_INSTANCE_REL {
             relationship: '${esc(edge.relationship)}',
             metamodel: '${esc(metamodel)}',
             source_namespace: '${esc(sourceNamespace)}',
             target_namespace: '${esc(targetNamespace)}'
           }]->(tgt)`,
        );

        reconnected++;
        touchedSourceNamespaces.add(sourceNamespace);
      }

      // Match the normal createCrossNsRelationship write path: clearing the
      // source namespace hash marks the authored content dirty so autosave and
      // subsequent store/load cycles retain the repaired relationship.
      for (const namespace of touchedSourceNamespaces) {
        await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) SET ns.content_hash = ''`,
          { namespace },
        );
      }

      return reconnected;
    },

    // -----------------------------------------------------------------
    // reconnectOrphanedEntry
    // -----------------------------------------------------------------
    async reconnectOrphanedEntry(
      entry: OrphanedEntry,
      newImportedNodeId: number,
    ): Promise<number> {
      const importedTarget = await resolveConceptInstance(dbModule, newImportedNodeId);
      if (!importedTarget) {
        throw new Error(`Reconnect target with node_id ${newImportedNodeId} no longer exists`);
      }
      if (importedTarget.concept !== entry.concept) {
        throw new Error(
          `Reconnect target must be a '${entry.concept}', but '${importedTarget.concept}' was selected`,
        );
      }

      let reconnected = 0;
      const touchedSourceNamespaces = new Set<string>();

      for (const edge of entry.affectedEdges) {
        const importedNamespace = edge.sourceNamespace === edge.authoredNamespace
          ? edge.targetNamespace
          : edge.sourceNamespace;
        if (importedTarget.namespace !== importedNamespace) {
          throw new Error(
            `Reconnect target is in namespace '${importedTarget.namespace}', expected '${importedNamespace}'`,
          );
        }

        const authored = await resolveAuthoredEndpoint(dbModule, edge);
        // A historical report can refer to an authored artifact that has since
        // been deleted. It is no longer a reconnectable orphan, so ignore it.
        if (!authored) continue;

        const metamodel = edge.metamodel;
        // The orphaned node was the imported (non-authored) side.
        // Replace its old node ID with newImportedNodeId.
        const sourceNodeId = edge.sourceNamespace === edge.authoredNamespace
          ? authored.nodeId
          : newImportedNodeId;
        const targetNodeId = edge.targetNamespace === edge.authoredNamespace
          ? authored.nodeId
          : newImportedNodeId;
        const sourceNamespace = edge.sourceNamespace;
        const targetNamespace = edge.targetNamespace;

        // Only genuinely orphaned authored endpoints are candidates. This also
        // makes reconnect idempotent and prevents duplicate occurs_at edges when
        // an old import report remains in memory.
        const existingRows = await dbModule.runQuery(
          edge.sourceNamespace === edge.authoredNamespace
            ? `MATCH (authored:RIA_UNIV_ConceptInstance {node_id: $authoredNodeId})
               -[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(:RIA_UNIV_ConceptInstance)
               WHERE r.relationship = $relationship RETURN count(r) AS cnt`
            : `MATCH (:RIA_UNIV_ConceptInstance)
               -[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->
               (authored:RIA_UNIV_ConceptInstance {node_id: $authoredNodeId})
               WHERE r.relationship = $relationship RETURN count(r) AS cnt`,
          { authoredNodeId: authored.nodeId, relationship: edge.relationship },
        );
        if (Number(existingRows[0]?.cnt ?? 0) > 0) continue;

        // Build stable-ID attributes for deterministic persistor sort and hash.
        // Use the selected target's CURRENT stable ID. `entry.stablePath` is the
        // deleted path and is intentionally different after a rename.
        const sourceStableId = edge.sourceNamespace === edge.authoredNamespace ? authored.stableId : importedTarget.stableId;
        const targetStableId = edge.targetNamespace === edge.authoredNamespace ? authored.stableId : importedTarget.stableId;
        const criAttrs = buildCrossNsAttributes(sourceStableId, targetStableId);

        // Create CrossNSRelationshipInstance node
        const criRows = await dbModule.runQuery(
          `CREATE (cri:RIA_UNIV_CrossNSRelationshipInstance {
            source_namespace: '${esc(sourceNamespace)}',
            target_namespace: '${esc(targetNamespace)}',
            metamodel: '${esc(metamodel)}',
            relationship: '${esc(edge.relationship)}',
            source_node_id: ${sourceNodeId},
            target_node_id: ${targetNodeId},
            attributes: '${esc(criAttrs)}'
          }) RETURN cri.edge_id AS edgeId`,
        );
        if (criRows.length === 0 || criRows[0]?.edgeId == null) {
          throw new Error(`Failed to create '${edge.relationship}' relationship record`);
        }
        const edgeId = Number(criRows[0].edgeId);

        // Create CROSSNS_INSTANCE_REL graph edge
        const graphRows = await dbModule.runQuery(
          `MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
           WHERE src.node_id = ${sourceNodeId} AND tgt.node_id = ${targetNodeId}
           CREATE (src)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL {
             edge_instance_id: ${edgeId},
             relationship: '${esc(edge.relationship)}',
             metamodel: '${esc(metamodel)}',
             source_namespace: '${esc(sourceNamespace)}',
             target_namespace: '${esc(targetNamespace)}'
           }]->(tgt)
           RETURN r.edge_instance_id AS edgeId`,
        );

        if (graphRows.length === 0) {
          // Do not leave a phantom backing record behind when an endpoint was
          // concurrently removed between validation and edge creation.
          await dbModule.runQuery(
            `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance {edge_id: $edgeId}) DELETE cri`,
            { edgeId },
          );
          throw new Error(`Could not reconnect '${edge.authoredName}': an endpoint no longer exists`);
        }

        reconnected++;
        touchedSourceNamespaces.add(sourceNamespace);
      }

      for (const namespace of touchedSourceNamespaces) {
        await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) SET ns.content_hash = ''`,
          { namespace },
        );
      }

      return reconnected;
    },
  };
}

// ---------------------------------------------------------------------------
// Attribute diff helper
// ---------------------------------------------------------------------------

/** Compare two attribute objects key-by-key using JSON.stringify per value. */
function diffAttributeKeys(
  oldAttrs: Record<string, unknown>,
  newAttrs: Record<string, unknown>,
): string[] {
  const allKeys = new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)]);
  const changed: string[] = [];
  for (const key of allKeys) {
    if (JSON.stringify(oldAttrs[key]) !== JSON.stringify(newAttrs[key])) {
      changed.push(key);
    }
  }
  return changed;
}
