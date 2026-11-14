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
import type {
  Result, RelationshipData, AggregatedRelationshipsResult,
  AggregatedRelationshipContainer, AggregatedRelationshipEdge,
} from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';

export type { RelationshipData, AggregatedRelationshipsResult } from '@riacore/app-contracts';

/** Safety caps for {@link createInstanceService}'s `getAggregatedRelationships`. */
const AGGREGATION_MAX_SUBTREE_NODES = 20000;
const AGGREGATION_MAX_ANCESTOR_HOPS = 64;
/**
 * Deepest level `getAggregatedRelationships` will report an endpoint at.
 *
 * 5 is where CGraph's chains stop saying anything new. Measured on a reference
 * `CGraphV2` import, a driver component yields 87 containers at depth 5, 90 at
 * 6 and 92 at 8: the chain has bottomed out at symbol level and the remaining
 * levels reach parameters and types. Deep *directory* nesting is what consumes
 * the budget — a component three `contains_component` levels down needs 5 to
 * reach the function inside it, which is the case this ceiling is set for.
 *
 * A request above it is clamped rather than rejected, so a caller asking for
 * "everything" gets the most this can give instead of an error. Raising it is
 * safe for cost now that {@link AGGREGATION_MAX_CONTAINERS} bounds the result
 * independently; the limit here is usefulness, not performance.
 */
const AGGREGATION_MAX_DEPTH = 5;

/**
 * Size budget the *applied* depth is reduced to fit — see
 * {@link AggregatedRelationshipsResult.requestedDepth}.
 *
 * Depth alone cannot bound this result, because what a level costs depends
 * entirely on the selection. Measured on the same import at the same depth 4,
 * one driver component produces 71 containers and another 1017, and the
 * difference is whether the subtree happens to contain a generated tree. So the
 * depth is reduced per selection until the result is something a client can
 * actually draw, rather than the ceiling being set low enough for the worst
 * selection and useless for every other one.
 *
 * Both figures come from laying the payloads out: 192 containers with 837
 * grouped edges settled in 1.2s, 780 with 1768 took 6.4s, and 1017 with 2606
 * took 17s. The pair admits the first and excludes the other two. The edge
 * figure is the larger of the two because grouped edges collapse further in the
 * client, which draws one line per container pair rather than per relationship.
 *
 * Level 1 is always accepted whatever its size: it is what this channel
 * returned before `depth` existed, and silently changing that result would be a
 * regression for every existing caller.
 */
export const AGGREGATION_MAX_CONTAINERS = 500;
export const AGGREGATION_MAX_EDGES = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConceptInstanceData {
  node_id: number;
  namespace: string;
  concept: string;
  metamodel: string;
  attributes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IInstanceService {
  /** Create a concept instance validated against the metamodel. */
  createInstance(
    namespace: string,
    concept: string,
    attributes: Record<string, unknown>,
  ): Promise<Result<{ node_id: number }>>;

  /** Read a single concept instance by node_id. */
  getInstance(nodeId: number): Promise<Result<ConceptInstanceData>>;

  /** Resolve a UUID (stable_path) to a node_id. */
  getInstanceByUuid(uuid: string): Promise<Result<ConceptInstanceData>>;

  /** Query instances by namespace, optionally filtered by concept. */
  getInstances(
    namespace: string,
    concept?: string,
  ): Promise<Result<ConceptInstanceData[]>>;

  /** Update attributes of an existing concept instance (merge semantics). */
  updateInstance(
    nodeId: number,
    attributes: Record<string, unknown>,
  ): Promise<Result<void>>;

  /** Delete a concept instance and cascade-remove all edges. */
  deleteInstance(nodeId: number): Promise<Result<void>>;

  /** Create an intra-namespace relationship between two instances. */
  createRelationship(
    sourceNodeId: number,
    targetNodeId: number,
    relationship: string,
  ): Promise<Result<{ edge_id: number }>>;

  /** Create a cross-namespace relationship between instances in different namespaces. */
  createCrossNsRelationship(
    sourceNodeId: number,
    targetNodeId: number,
    relationship: string,
    metamodel: string,
    sourceNamespace: string,
    targetNamespace: string,
  ): Promise<Result<{ edge_id: number }>>;

  /** Delete an intra-namespace relationship by edge_id. */
  deleteRelationship(edgeId: number): Promise<Result<void>>;

  /** Delete a cross-namespace relationship by edge_id. */
  deleteCrossNsRelationship(edgeId: number): Promise<Result<void>>;

  /** Query all relationships (intra + cross-NS) connected to a node. */
  getRelationships(nodeId: number): Promise<Result<RelationshipData[]>>;

  /**
   * Roll up a container's cross-boundary relationships (e.g. CGraph `calls`/
   * `reads`/`writes`) to its sibling containers, for a layered-architecture
   * style diagram. See {@link AggregatedRelationshipsResult}.
   *
   * `depth` (default 1, clamped to 1..{@link AGGREGATION_MAX_DEPTH}) reports
   * each endpoint that many containment levels deeper, with the ancestors
   * needed to nest it, so a consumer can draw "which file in `BSw` calls which
   * file in `CDD_ADS_NEW`" rather than one edge between the two modules.
   *
   * The depth actually applied can be lower than the one asked for: see
   * {@link AGGREGATION_MAX_CONTAINERS} and the result's `requestedDepth`.
   */
  getAggregatedRelationships(nodeId: number, depth?: number): Promise<Result<AggregatedRelationshipsResult>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Labels for imported and authored elements; blank attributes must not hide a fallback. */
function relationshipNodeLabel(attrs: Record<string, unknown>, concept: string, nodeId: number) {
  const firstText = (keys: string[]) => keys
    .map((key) => attrs[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
  const noteText = concept === 'safety_note' ? firstText(['note_text'])?.replace(/\s+/g, ' ') : undefined;
  const notePreview = noteText ? (noteText.length > 80 ? `${noteText.slice(0, 80).trimEnd()}…` : noteText) : undefined;
  return {
    name: notePreview ?? firstText(['has_name', 'title', 'declared_name', 'short_name', 'name', 'qualified_name', 'id', 'stable_path'])
      ?? `${concept} #${nodeId}`,
    identifier: firstText(['id', 'short_name', 'stable_path', 'uuid']),
    ...(concept === 'malfunction' ? { asil: firstText(['malfunction_asil']) ?? '' } : {}),
  };
}

/** Escape single-quotes and backslashes for Cypher string literals. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Invalidate the stored content_hash for a namespace by setting it to ''.
 * This signals to the persistor's load() that the DB content has been modified
 * since the last store/load, so the namespace must be re-imported from the
 * serialized JSON files (enabling "load as undo" for unsaved changes).
 */
async function invalidateNamespaceHash(dbModule: IDbModule, namespace: string): Promise<void> {
  await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) SET ns.content_hash = ''`,
    { namespace },
  );
}

/**
 * Resolve the namespace of a ConceptInstance by node_id and invalidate its hash.
 * Convenience wrapper for write operations that only have a node_id.
 */
async function invalidateHashForNode(dbModule: IDbModule, nodeId: number): Promise<void> {
  const rows = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId}) RETURN ci.namespace AS ns`,
    { nodeId },
  );
  if (rows.length > 0) {
    await invalidateNamespaceHash(dbModule, String(rows[0].ns));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInstanceService(dbModule: IDbModule, logger?: ImportLogger): IInstanceService {
  return {
    // -----------------------------------------------------------------------
    // createInstance
    // -----------------------------------------------------------------------
    async createInstance(
      namespace: string,
      concept: string,
      attributes: Record<string, unknown>,
    ): Promise<Result<{ node_id: number }>> {
      // 1. Verify namespace exists
      const nsRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) RETURN ns.name AS name`,
        { namespace },
      );
      if (nsRows.length === 0) {
        return { ok: false, error: `Namespace '${namespace}' not found` };
      }

      // 2. Resolve metamodel via DEFINEDBY/CATEGORIZEDBY and verify concept
      const conceptRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})-[:RIA_META_DEFINEDBY|RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel)-[:RIA_META_DEFINES_CONCEPT]->(c:RIA_META_Concept {name: $concept})
         RETURN mm.name AS metamodel, c.name AS conceptName`,
        { namespace, concept },
      );
      if (conceptRows.length === 0) {
        return {
          ok: false,
          error: `Concept '${concept}' not found in metamodel for namespace '${namespace}'`,
        };
      }
      const metamodel = String(conceptRows[0].metamodel);

      // 3. Validate attribute keys against RIA_META_NodeAttribute
      const attrKeys = Object.keys(attributes);
      if (attrKeys.length > 0) {
        const validAttrRows = await dbModule.runQuery(
          `MATCH (c:RIA_META_Concept {name: $concept, metamodel: $metamodel})-[:RIA_META_CONCEPT_ATTRIBUTE]->(a:RIA_META_NodeAttribute)
           RETURN a.name AS attrName`,
          { concept, metamodel },
        );
        const validAttrs = new Set(validAttrRows.map((r) => String(r.attrName)));
        const invalid = attrKeys.filter((k) => !validAttrs.has(k));
        if (invalid.length > 0) {
          return {
            ok: false,
            error: `Unrecognized attributes for concept '${concept}': ${invalid.join(', ')}`,
          };
        }
      }

      // 4. Auto-generate stable_path from uuid if not provided (authored concept instances)
      if (!attributes.stable_path) {
        if (typeof attributes.uuid === 'string' && attributes.uuid) {
          attributes = { stable_path: attributes.uuid, ...attributes };
        } else {
          logger?.error(`createInstance: authored concept '${concept}' in namespace '${namespace}' is missing a uuid attribute — stable_path cannot be generated`, { concept, namespace });
        }
      }

      // 5. Create ConceptInstance node
      const attrsJson = JSON.stringify(attributes);
      const createRows = await dbModule.runQuery(
        `CREATE (ci:RIA_UNIV_ConceptInstance {
          namespace: '${esc(namespace)}',
          concept: '${esc(concept)}',
          metamodel: '${esc(metamodel)}',
          attributes: '${esc(attrsJson)}'
        }) RETURN ci.node_id AS nodeId`,
      );
      const nodeId = Number(createRows[0].nodeId);

      await invalidateNamespaceHash(dbModule, namespace);
      return { ok: true, data: { node_id: nodeId } };
    },

    // -----------------------------------------------------------------------
    // getInstance
    // -----------------------------------------------------------------------
    async getInstance(nodeId: number): Promise<Result<ConceptInstanceData>> {
      const rows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
                ci.metamodel AS metamodel, ci.attributes AS attributes`,
        { nodeId },
      );
      if (rows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${nodeId} not found` };
      }
      const row = rows[0];
      return {
        ok: true,
        data: {
          node_id: Number(row.node_id),
          namespace: String(row.namespace),
          concept: String(row.concept),
          metamodel: String(row.metamodel),
          attributes: JSON.parse(String(row.attributes || '{}')),
        },
      };
    },

    // -----------------------------------------------------------------------
    // getInstanceByUuid
    // -----------------------------------------------------------------------
    async getInstanceByUuid(uuid: string): Promise<Result<ConceptInstanceData>> {
      if (typeof uuid !== 'string' || uuid.trim().length === 0) {
        return { ok: false, error: 'UUID or stable path must be a non-empty string' };
      }
      // Use CONTAINS for initial filtering, then exact-match in JS.
      // This works because stable_path and uuid are stored inside the JSON attributes string.
      // Not capped: other elements quote the id too (references), and a cap before
      // the exact match could drop the element itself. Reject ambiguous identities
      // instead of selecting an arbitrary object from another namespace.
      const rows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance)
         WHERE ci.attributes CONTAINS $uuid
         RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
                ci.metamodel AS metamodel, ci.attributes AS attributes
         ORDER BY node_id`,
        { uuid },
      );

      const matches = rows.map(row => ({
        node_id: Number(row.node_id), namespace: String(row.namespace),
        concept: String(row.concept), metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>,
      })).filter(node => node.attributes.stable_path === uuid || node.attributes.uuid === uuid);
      if (matches.length > 1) {
        return { ok: false, error: `Ambiguous UUID or stable path "${uuid}": found ${matches.length} nodes; resolve the target within its namespace` };
      }
      if (matches.length === 1) return { ok: true, data: matches[0] };

      return { ok: false, error: `No node found with UUID "${uuid}"` };
    },

    // -----------------------------------------------------------------------
    // getInstances
    // -----------------------------------------------------------------------
    async getInstances(
      namespace: string,
      concept?: string,
    ): Promise<Result<ConceptInstanceData[]>> {
      let query: string;
      let params: Record<string, unknown>;

      if (concept) {
        query = `MATCH (ci:RIA_UNIV_ConceptInstance)
                 WHERE ci.namespace = $namespace AND ci.concept = $concept
                 RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
                        ci.metamodel AS metamodel, ci.attributes AS attributes`;
        params = { namespace, concept };
      } else {
        query = `MATCH (ci:RIA_UNIV_ConceptInstance)
                 WHERE ci.namespace = $namespace
                 RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
                        ci.metamodel AS metamodel, ci.attributes AS attributes`;
        params = { namespace };
      }

      const rows = await dbModule.runQuery(query, params);
      const instances: ConceptInstanceData[] = rows.map((row) => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
      }));

      return { ok: true, data: instances };
    },

    // -----------------------------------------------------------------------
    // updateInstance
    // -----------------------------------------------------------------------
    async updateInstance(
      nodeId: number,
      attributes: Record<string, unknown>,
    ): Promise<Result<void>> {
      // 1. Verify instance exists
      const existRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.concept AS concept, ci.metamodel AS metamodel, ci.attributes AS attributes`,
        { nodeId },
      );
      if (existRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${nodeId} not found` };
      }
      const concept = String(existRows[0].concept);
      const metamodel = String(existRows[0].metamodel);
      const existingAttrs: Record<string, unknown> = JSON.parse(
        String(existRows[0].attributes || '{}'),
      );

      // 2. Validate attribute keys
      const attrKeys = Object.keys(attributes);
      if (attrKeys.length > 0) {
        const validAttrRows = await dbModule.runQuery(
          `MATCH (c:RIA_META_Concept {name: $concept, metamodel: $metamodel})-[:RIA_META_CONCEPT_ATTRIBUTE]->(a:RIA_META_NodeAttribute)
           RETURN a.name AS attrName`,
          { concept, metamodel },
        );
        const validAttrs = new Set(validAttrRows.map((r) => String(r.attrName)));
        const invalid = attrKeys.filter((k) => !validAttrs.has(k));
        if (invalid.length > 0) {
          return {
            ok: false,
            error: `Unrecognized attributes for concept '${concept}': ${invalid.join(', ')}`,
          };
        }
      }

      // 3. Merge attributes (existing preserved, new keys overwrite/add)
      const merged = { ...existingAttrs, ...attributes };
      const mergedJson = JSON.stringify(merged);

      await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         SET ci.attributes = '${esc(mergedJson)}'`,
        { nodeId },
      );

      await invalidateHashForNode(dbModule, nodeId);
      return { ok: true, data: undefined };
    },

    // -----------------------------------------------------------------------
    // deleteInstance
    // -----------------------------------------------------------------------
    async deleteInstance(nodeId: number): Promise<Result<void>> {
      // 1. Verify instance exists and capture namespace for hash invalidation
      const existRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.node_id AS node_id, ci.namespace AS namespace`,
        { nodeId },
      );
      if (existRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${nodeId} not found` };
      }
      const deletedNamespace = String(existRows[0].namespace);

      // 2. Delete intra-namespace relationship edges
      await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         WHERE src.node_id = $nodeId OR tgt.node_id = $nodeId
         DELETE r`,
        { nodeId },
      );

      // 3. Delete intra-namespace relationship records
      await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $nodeId OR ri.target_node_id = $nodeId
         DELETE ri`,
        { nodeId },
      );

      // 4. Delete cross-namespace relationship edges
      await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         WHERE src.node_id = $nodeId OR tgt.node_id = $nodeId
         DELETE r`,
        { nodeId },
      );

      // 5. Delete cross-namespace relationship records
      await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
         WHERE cri.source_node_id = $nodeId OR cri.target_node_id = $nodeId
         DELETE cri`,
        { nodeId },
      );

      // 6. Delete the ConceptInstance node
      await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         DELETE ci`,
        { nodeId },
      );

      await invalidateNamespaceHash(dbModule, deletedNamespace);
      return { ok: true, data: undefined };
    },

    // -----------------------------------------------------------------------
    // createRelationship
    // -----------------------------------------------------------------------
    async createRelationship(
      sourceNodeId: number,
      targetNodeId: number,
      relationship: string,
    ): Promise<Result<{ edge_id: number }>> {
      // 1. Verify both instances exist and are in the same namespace
      const srcRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.namespace AS namespace, ci.concept AS concept, ci.metamodel AS metamodel`,
        { nodeId: sourceNodeId },
      );
      if (srcRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${sourceNodeId} not found` };
      }
      const tgtRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.namespace AS namespace, ci.concept AS concept`,
        { nodeId: targetNodeId },
      );
      if (tgtRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${targetNodeId} not found` };
      }

      const srcNamespace = String(srcRows[0].namespace);
      const tgtNamespace = String(tgtRows[0].namespace);
      if (srcNamespace !== tgtNamespace) {
        return { ok: false, error: 'Source and target instances must be in the same namespace' };
      }

      const srcConcept = String(srcRows[0].concept);
      const tgtConcept = String(tgtRows[0].concept);
      const metamodel = String(srcRows[0].metamodel);

      // 2. Validate relationship exists in metamodel
      const relRows = await dbModule.runQuery(
        `MATCH (mm:RIA_META_Metamodel {name: $metamodel})-[:RIA_META_DEFINES_RELATIONSHIP]->(r:RIA_META_Relationship {name: $relationship})
         RETURN r.source_concept AS source_concept, r.target_concept AS target_concept`,
        { metamodel, relationship },
      );
      if (relRows.length === 0) {
        return { ok: false, error: `Relationship '${relationship}' not found in metamodel '${metamodel}'` };
      }

      // 3. Verify source/target concept compatibility
      // Skip compatibility check when the metamodel's expected concept is a
      // primitive type (e.g. 'string', 'integer') rather than a registered concept.
      const expectedSrc = String(relRows[0].source_concept);
      const expectedTgt = String(relRows[0].target_concept);
      if (expectedSrc && srcConcept !== expectedSrc) {
        // Check if expectedSrc is a registered concept (not a primitive type)
        const srcConceptRows = await dbModule.runQuery(
          `MATCH (c:RIA_META_Concept {name: $concept, metamodel: $metamodel}) RETURN c.name AS name`,
          { concept: expectedSrc, metamodel },
        );
        if (srcConceptRows.length > 0) {
          return { ok: false, error: `Source concept '${srcConcept}' does not match expected '${expectedSrc}' for relationship '${relationship}'` };
        }
      }
      if (expectedTgt && tgtConcept !== expectedTgt) {
        // Check if expectedTgt is a registered concept (not a primitive type)
        const tgtConceptRows = await dbModule.runQuery(
          `MATCH (c:RIA_META_Concept {name: $concept, metamodel: $metamodel}) RETURN c.name AS name`,
          { concept: expectedTgt, metamodel },
        );
        if (tgtConceptRows.length > 0) {
          return { ok: false, error: `Target concept '${tgtConcept}' does not match expected '${expectedTgt}' for relationship '${relationship}'` };
        }
      }

      // 4. Create RelationshipInstance node
      const riRows = await dbModule.runQuery(
        `CREATE (ri:RIA_UNIV_RelationshipInstance {
          namespace: '${esc(srcNamespace)}',
          relationship: '${esc(relationship)}',
          metamodel: '${esc(metamodel)}',
          source_node_id: ${sourceNodeId},
          target_node_id: ${targetNodeId},
          attributes: '{}'
        }) RETURN ri.edge_id AS edgeId`,
      );
      const edgeId = Number(riRows[0].edgeId);

      // 5. Create INSTANCE_REL graph edge
      await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
         WHERE src.node_id = ${sourceNodeId} AND tgt.node_id = ${targetNodeId}
         CREATE (src)-[:RIA_UNIV_INSTANCE_REL {
           edge_instance_id: ${edgeId},
           relationship: '${esc(relationship)}',
           metamodel: '${esc(metamodel)}'
         }]->(tgt)`,
      );

      await invalidateNamespaceHash(dbModule, srcNamespace);
      return { ok: true, data: { edge_id: edgeId } };
    },

    // -----------------------------------------------------------------------
    // createCrossNsRelationship
    // -----------------------------------------------------------------------
    async createCrossNsRelationship(
      sourceNodeId: number,
      targetNodeId: number,
      relationship: string,
      metamodel: string,
      sourceNamespace: string,
      targetNamespace: string,
    ): Promise<Result<{ edge_id: number }>> {
      // 1. Verify both instances exist and fetch their attributes for stable ID storage
      const srcRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.namespace AS namespace, ci.attributes AS attributes`,
        { nodeId: sourceNodeId },
      );
      if (srcRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${sourceNodeId} not found` };
      }
      if (String(srcRows[0].namespace) !== sourceNamespace) {
        return { ok: false, error: `Source instance ${sourceNodeId} is not in namespace '${sourceNamespace}'` };
      }

      const tgtRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.namespace AS namespace, ci.attributes AS attributes`,
        { nodeId: targetNodeId },
      );
      if (tgtRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${targetNodeId} not found` };
      }
      if (String(tgtRows[0].namespace) !== targetNamespace) {
        return { ok: false, error: `Target instance ${targetNodeId} is not in namespace '${targetNamespace}'` };
      }

      // Extract stable_path from both nodes for persistor round-trip
      const srcAttrs = JSON.parse(String(srcRows[0].attributes ?? '{}')) as Record<string, unknown>;
      const tgtAttrs = JSON.parse(String(tgtRows[0].attributes ?? '{}')) as Record<string, unknown>;
      const sourceExternalId = typeof srcAttrs.stable_path === 'string' ? srcAttrs.stable_path : '';
      const targetExternalId = typeof tgtAttrs.stable_path === 'string' ? tgtAttrs.stable_path : '';

      // 2. Validate an explicit per-pair connection exists between the two namespaces.
      //    The single source of truth is the direction-agnostic per-pair
      //    RIA_UNIV_NamespaceConnection edge (imported -> authored); either ordering may be
      //    passed here, so the check matches the pair in both directions.
      const connRows = await dbModule.runQuery(
        `MATCH (i:RIA_UNIV_Namespace)-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace)
         WHERE (i.name = $sourceNs AND a.name = $targetNs)
            OR (i.name = $targetNs AND a.name = $sourceNs)
         RETURN count(*) AS cnt`,
        { sourceNs: sourceNamespace, targetNs: targetNamespace },
      );
      if (Number(connRows[0].cnt) === 0) {
        return { ok: false, error: `No connection exists between namespaces '${sourceNamespace}' and '${targetNamespace}'. Connect them first.` };
      }

      // 3. Create CrossNSRelationshipInstance node with stable paths for persistor round-trip
      const criAttrs = JSON.stringify({
        source_external_id: sourceExternalId,
        target_external_id: targetExternalId,
      });
      const criRows = await dbModule.runQuery(
        `CREATE (r:RIA_UNIV_CrossNSRelationshipInstance {
          source_namespace: '${esc(sourceNamespace)}',
          target_namespace: '${esc(targetNamespace)}',
          metamodel: '${esc(metamodel)}',
          relationship: '${esc(relationship)}',
          source_node_id: ${sourceNodeId},
          target_node_id: ${targetNodeId},
          attributes: '${esc(criAttrs)}'
        }) RETURN r.edge_id AS edgeId`,
      );
      const edgeId = Number(criRows[0].edgeId);

      // 4. Create CROSSNS_INSTANCE_REL graph edge
      await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
         WHERE src.node_id = ${sourceNodeId} AND tgt.node_id = ${targetNodeId}
         CREATE (src)-[:RIA_UNIV_CROSSNS_INSTANCE_REL {
           edge_instance_id: ${edgeId},
           relationship: '${esc(relationship)}',
           metamodel: '${esc(metamodel)}',
           source_namespace: '${esc(sourceNamespace)}',
           target_namespace: '${esc(targetNamespace)}'
         }]->(tgt)`,
      );

      await invalidateNamespaceHash(dbModule, sourceNamespace);
      return { ok: true, data: { edge_id: edgeId } };
    },

    // -----------------------------------------------------------------------
    // deleteRelationship
    // -----------------------------------------------------------------------
    async deleteRelationship(edgeId: number): Promise<Result<void>> {
      // 1. Find RelationshipInstance by edge_id
      const riRows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance {edge_id: $edgeId})
         RETURN ri.source_node_id AS srcId, ri.target_node_id AS tgtId`,
        { edgeId },
      );
      if (riRows.length === 0) {
        return { ok: false, error: `Relationship with edge_id ${edgeId} not found` };
      }

      const srcId = Number(riRows[0].srcId);
      const tgtId = Number(riRows[0].tgtId);

      // 2. Delete the INSTANCE_REL edge with matching edge_instance_id
      await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         WHERE src.node_id = ${srcId} AND tgt.node_id = ${tgtId} AND r.edge_instance_id = ${edgeId}
         DELETE r`,
      );

      // 3. Delete the RelationshipInstance record
      await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance {edge_id: $edgeId})
         DELETE ri`,
        { edgeId },
      );

      await invalidateHashForNode(dbModule, srcId);
      return { ok: true, data: undefined };
    },

    // -----------------------------------------------------------------------
    // deleteCrossNsRelationship
    // -----------------------------------------------------------------------
    async deleteCrossNsRelationship(edgeId: number): Promise<Result<void>> {
      // 1. Find CrossNSRelationshipInstance by edge_id
      const criRows = await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance {edge_id: $edgeId})
         RETURN cri.source_node_id AS srcId, cri.target_node_id AS tgtId`,
        { edgeId },
      );
      if (criRows.length === 0) {
        return { ok: false, error: `Relationship with edge_id ${edgeId} not found` };
      }

      const srcId = Number(criRows[0].srcId);
      const tgtId = Number(criRows[0].tgtId);

      // 2. Delete the CROSSNS_INSTANCE_REL edge with matching edge_instance_id
      await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         WHERE src.node_id = ${srcId} AND tgt.node_id = ${tgtId} AND r.edge_instance_id = ${edgeId}
         DELETE r`,
      );

      // 3. Delete the CrossNSRelationshipInstance record
      await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance {edge_id: $edgeId})
         DELETE cri`,
        { edgeId },
      );

      await invalidateHashForNode(dbModule, srcId);
      return { ok: true, data: undefined };
    },

    // -----------------------------------------------------------------------
    // getRelationships
    // -----------------------------------------------------------------------
    async getRelationships(nodeId: number): Promise<Result<RelationshipData[]>> {
      // 1. Verify node exists
      const existRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.node_id AS node_id`,
        { nodeId },
      );
      if (existRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${nodeId} not found` };
      }

      const results: RelationshipData[] = [];

      // 2. Outgoing INSTANCE_REL edges.
      // Resolve outgoing edges via the RIA_UNIV_RelationshipInstance node table,
      // then fetch connected node data by id.
      // RelationshipInstance.edge_id equals the graph edge's edge_instance_id.
      const outIntraEdges = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $nodeId
         RETURN ri.edge_id AS edge_id, ri.relationship AS relationship, ri.metamodel AS metamodel,
                ri.target_node_id AS connected_node_id`,
        { nodeId },
      );
      const outConnectedIds = [...new Set(outIntraEdges.map(r => Number(r.connected_node_id)))];
      const outConnectedById = new Map<number, Record<string, unknown>>();
      if (outConnectedIds.length > 0) {
        const connRows = await dbModule.runQuery(
          `MATCH (ci:RIA_UNIV_ConceptInstance)
           WHERE ci.node_id IN $ids
           RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept, ci.attributes AS attributes`,
          { ids: outConnectedIds },
        );
        for (const row of connRows) outConnectedById.set(Number(row.node_id), row);
      }
      for (const row of outIntraEdges) {
        const connectedId = Number(row.connected_node_id);
        const connNode = outConnectedById.get(connectedId);
        if (!connNode) continue;
        const attrs = JSON.parse(String(connNode.attributes || '{}'));
        results.push({
          edge_id: Number(row.edge_id),
          relationship: String(row.relationship),
          metamodel: String(row.metamodel),
          direction: 'outgoing',
          type: 'intra',
          connectedNode: {
            node_id: connectedId,
            namespace: String(connNode.namespace),
            concept: String(connNode.concept),
            ...relationshipNodeLabel(attrs, String(connNode.concept), connectedId),
          },
        });
      }

      // 3. Incoming INSTANCE_REL edges
      const inIntraRows = await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN r.edge_instance_id AS edge_id, r.relationship AS relationship, r.metamodel AS metamodel,
                src.node_id AS connected_node_id, src.namespace AS connected_ns, src.concept AS connected_concept,
                src.attributes AS connected_attrs`,
        { nodeId },
      );
      for (const row of inIntraRows) {
        const attrs = JSON.parse(String(row.connected_attrs || '{}'));
        results.push({
          edge_id: Number(row.edge_id),
          relationship: String(row.relationship),
          metamodel: String(row.metamodel),
          direction: 'incoming',
          type: 'intra',
          connectedNode: {
            node_id: Number(row.connected_node_id),
            namespace: String(row.connected_ns),
            concept: String(row.connected_concept),
            ...relationshipNodeLabel(attrs, String(row.connected_concept), Number(row.connected_node_id)),
          },
        });
      }

      // 4. Outgoing CROSSNS_INSTANCE_REL edges
      const outCrossRows = await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance {node_id: $nodeId})-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         RETURN r.edge_instance_id AS edge_id, r.relationship AS relationship, r.metamodel AS metamodel,
                tgt.node_id AS connected_node_id, tgt.namespace AS connected_ns, tgt.concept AS connected_concept,
                tgt.attributes AS connected_attrs`,
        { nodeId },
      );
      for (const row of outCrossRows) {
        const attrs = JSON.parse(String(row.connected_attrs || '{}'));
        results.push({
          edge_id: Number(row.edge_id),
          relationship: String(row.relationship),
          metamodel: String(row.metamodel),
          direction: 'outgoing',
          type: 'cross',
          connectedNode: {
            node_id: Number(row.connected_node_id),
            namespace: String(row.connected_ns),
            concept: String(row.connected_concept),
            ...relationshipNodeLabel(attrs, String(row.connected_concept), Number(row.connected_node_id)),
          },
        });
      }

      // 5. Incoming CROSSNS_INSTANCE_REL edges
      const inCrossRows = await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN r.edge_instance_id AS edge_id, r.relationship AS relationship, r.metamodel AS metamodel,
                src.node_id AS connected_node_id, src.namespace AS connected_ns, src.concept AS connected_concept,
                src.attributes AS connected_attrs`,
        { nodeId },
      );
      for (const row of inCrossRows) {
        const attrs = JSON.parse(String(row.connected_attrs || '{}'));
        results.push({
          edge_id: Number(row.edge_id),
          relationship: String(row.relationship),
          metamodel: String(row.metamodel),
          direction: 'incoming',
          type: 'cross',
          connectedNode: {
            node_id: Number(row.connected_node_id),
            namespace: String(row.connected_ns),
            concept: String(row.connected_concept),
            ...relationshipNodeLabel(attrs, String(row.connected_concept), Number(row.connected_node_id)),
          },
        });
      }

      return { ok: true, data: results };
    },

    // -----------------------------------------------------------------------
    // getAggregatedRelationships
    // -----------------------------------------------------------------------
    async getAggregatedRelationships(nodeId: number, depth?: number): Promise<Result<AggregatedRelationshipsResult>> {
      // A non-finite or fractional request is a caller bug, not a reason to
      // fail a read: `Math.trunc(NaN)` is NaN and `Math.max` propagates it, so
      // the default is applied before clamping rather than after.
      const requested = Number.isFinite(depth) ? Math.trunc(depth as number) : 1;
      const levels = Math.min(AGGREGATION_MAX_DEPTH, Math.max(1, requested));
      const rootRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
         RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept, ci.attributes AS attributes`,
        { nodeId },
      );
      if (rootRows.length === 0) {
        return { ok: false, error: `ConceptInstance with node_id ${nodeId} not found` };
      }
      const rootAttrs = JSON.parse(String(rootRows[0].attributes || '{}'));
      const root: AggregatedRelationshipContainer = {
        node_id: nodeId,
        namespace: String(rootRows[0].namespace),
        concept: String(rootRows[0].concept),
        ...relationshipNodeLabel(rootAttrs, String(rootRows[0].concept), nodeId),
      };

      // 1. Containment relationship names, global: who-contains-whom is a fixed
      // per-metamodel property of the relationship, not of any particular edge.
      const containmentRows = await dbModule.runQuery(
        `MATCH (r:RIA_META_Relationship) WHERE r.is_containment = true RETURN r.name AS name`,
      );
      const containmentRels = [...new Set(containmentRows.map((row) => String(row.name)))];

      // 2. Walk the subtree down from the root through containment edges, so
      // every descendant's own relationships can be rolled up to the root.
      const subtreeIds = new Set<number>([nodeId]);
      let frontier = [nodeId];
      let truncated = false;
      while (frontier.length > 0 && containmentRels.length > 0) {
        if (subtreeIds.size >= AGGREGATION_MAX_SUBTREE_NODES) { truncated = true; break; }
        const childRows = await dbModule.runQuery(
          `MATCH (ri:RIA_UNIV_RelationshipInstance)
           WHERE ri.source_node_id IN $ids AND ri.relationship IN $containmentRels
           RETURN DISTINCT ri.target_node_id AS node_id`,
          { ids: frontier, containmentRels },
        );
        const next: number[] = [];
        for (const row of childRows) {
          const id = Number(row.node_id);
          if (!subtreeIds.has(id)) { subtreeIds.add(id); next.push(id); }
        }
        frontier = next;
      }

      // 3. Every relationship crossing the subtree boundary, in either
      // direction, excluding anything purely internal to the subtree.
      //
      // All three conditions are the engine's to apply, which is the point:
      // both queries used to select everything touching the subtree and discard
      // the internal and containment rows in JS. On a 30k-node subtree that
      // marshalled 196,532 rows to keep 42,667 — and after grouping, to show
      // 837. Measured on that selection: the outgoing query falls from 3.3s to
      // 1.5s and the incoming from 2.4s to 1.0s. A narrower selection gains the
      // same proportion (167ms to 69ms for an 811-node subtree).
      //
      // An empty `containmentRels` is safe here: `NOT x IN []` is true, so a
      // metamodel declaring no containment filters nothing, which is correct.
      //
      // Both directions now read `RIA_UNIV_RelationshipInstance`. The incoming
      // one used to traverse the `RIA_UNIV_INSTANCE_REL` graph edges instead,
      // which made the two directions disagree about which table is
      // authoritative — and that table is the derived one, rebuilt from these
      // rows on load. Verified on the reference corpus: both return the same
      // 88,487 incoming rows for this subtree.
      //
      // Intra-namespace only for now (CGraph, the first consumer, never
      // crosses a namespace) — extend with the CROSSNS_INSTANCE_REL tables,
      // mirrored the same way getRelationships does, if a cross-namespace
      // caller needs this later.
      const subtreeIdList = [...subtreeIds];
      const outRows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id IN $ids
           AND NOT ri.relationship IN $containmentRels
           AND NOT ri.target_node_id IN $ids
         RETURN ri.source_node_id AS source, ri.target_node_id AS target, ri.relationship AS relationship`,
        { ids: subtreeIdList, containmentRels },
      );
      const inRows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.target_node_id IN $ids
           AND NOT ri.relationship IN $containmentRels
           AND NOT ri.source_node_id IN $ids
         RETURN ri.source_node_id AS source, ri.target_node_id AS target, ri.relationship AS relationship`,
        { ids: subtreeIdList, containmentRels },
      );
      // Every row is boundary-crossing and non-containment by construction, so
      // the only thing left to do is collapse parallel instances of the same
      // (source, target, relationship) triple — the grouping below counts
      // relationships, not stored edges.
      const crossing: { source: number; target: number; relationship: string }[] = [];
      const seenEdge = new Set<string>();
      for (const row of [...outRows, ...inRows]) {
        const source = Number(row.source);
        const target = Number(row.target);
        const relationship = String(row.relationship);
        const key = `${source}:${target}:${relationship}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        crossing.push({ source, target, relationship });
      }

      if (crossing.length === 0) {
        return { ok: true, data: { root, containers: [], edges: [], truncated, depth: levels, requestedDepth: levels } };
      }

      // 4. Containment parents for every endpoint and everything above it, one
      // query per *level* of the chain rather than one per node.
      //
      // This used to be a per-node `LIMIT 1` lookup behind a cache, awaited in
      // sequence. It is the same number of table scans as nodes asked about, and
      // the table holds every relationship in the namespace, so the cost grew
      // with the corpus times the neighbourhood. Measured on a 264k-edge
      // `CGraphV2` import at ~5-7ms per lookup: selecting `PowertrainManagement`
      // spent 5.9s here across 955 lookups, and selecting `BSw` spent 178s
      // across 31,795 — the rest of the read, including both boundary queries,
      // was under 200ms. Batching the same work by level makes it 7-9 queries
      // and 100-800ms, because a scan that resolves one id resolves ten thousand
      // for the same effort.
      //
      // Deliberately seeded from the endpoints rather than loading the whole
      // containment forest in a single query, which was the other candidate:
      // the forest is 68,901 rows on that corpus and marshalling it costs 1.3s,
      // more than the level-batched walk even for the widest selection.
      const parents = new Map<number, number | null>();
      if (containmentRels.length > 0) {
        let wanted = [...new Set([...crossing.flatMap((edge) => [edge.source, edge.target]), nodeId])];
        for (let hop = 0; hop < AGGREGATION_MAX_ANCESTOR_HOPS && wanted.length > 0; hop++) {
          const parentRows = await dbModule.runQuery(
            `MATCH (ri:RIA_UNIV_RelationshipInstance)
             WHERE ri.target_node_id IN $ids AND ri.relationship IN $containmentRels
             RETURN ri.target_node_id AS child, ri.source_node_id AS parent`,
            { ids: wanted, containmentRels },
          );
          // Recorded before the rows are read, so an id the query returned
          // nothing for is known to have no containment parent rather than
          // being asked about again on the next level.
          for (const id of wanted) if (!parents.has(id)) parents.set(id, null);
          const next: number[] = [];
          for (const row of parentRows) {
            const child = Number(row.child);
            const parent = Number(row.parent);
            // First parent wins, which is what the old `LIMIT 1` did for an
            // element with more than one containment parent.
            if (parents.get(child) === null) parents.set(child, parent);
            if (!parents.has(parent)) next.push(parent);
          }
          wanted = [...new Set(next)];
        }
      }
      const parentOf = (id: number): number | null => parents.get(id) ?? null;
      // The root's own containment parent: the "sibling level" every external
      // partner gets rolled up to. It is in the closure above because `nodeId`
      // seeds it.
      const rootParentId = parentOf(nodeId);

      // 5. Resolve each endpoint to its *containment path*: the chain of
      // containers it is reportable under, outermost first.
      //
      // The outermost element is what the flat rollup has always used — for an
      // external endpoint, the ancestor whose immediate containment parent is
      // the same as the root's (both `null`, meaning top-level, included), i.e.
      // a sibling of the root; for an internal one, the root itself. The rest
      // of the chain is the part the previous implementation computed and threw
      // away, and it is the only thing `depth` needs: level *n* terminates an
      // edge at `path[n - 1]`, and the elements before it are the frames that
      // have to be drawn around it.
      //
      // An endpoint whose chain never reaches the sibling level (e.g. an
      // external symbol with no owning file) tops out at its own topmost
      // ancestor instead, so its path is shorter and a deeper request simply
      // has nothing further to descend to.

      /**
       * Containment path for one endpoint, outermost first.
       *
       * The two cases differ in where the walk stops, not in how it walks: an
       * internal endpoint stops *at* the root, an external one stops at the
       * node whose parent is the root's parent. Both are capped by
       * `AGGREGATION_MAX_ANCESTOR_HOPS`, after which whatever was reached is
       * treated as the outermost container — the same fallback the flat rollup
       * used, and the reason a cycle in containment data cannot hang this.
       */
      const pathOf = (endpointId: number): number[] => {
        const internal = subtreeIds.has(endpointId);
        const upward = [endpointId];
        for (let hop = 0; hop < AGGREGATION_MAX_ANCESTOR_HOPS; hop++) {
          const current = upward[upward.length - 1];
          if (internal && current === nodeId) break;
          const parent = parentOf(current);
          if (parent === null) break;
          if (!internal && parent === rootParentId) break;
          upward.push(parent);
          if (internal && parent === nodeId) break;
        }
        // An internal endpoint is reportable under the root by definition —
        // the subtree walk found it from there. Anchoring the path explicitly
        // keeps that invariant even when the upward walk disagrees, which it
        // can where an element has more than one containment parent and the
        // first-parent-wins rule picks the other one. Without this, such an
        // endpoint would be reported outside the root at `depth: 1`, which the
        // flat rollup never did.
        if (internal && upward[upward.length - 1] !== nodeId) upward.push(nodeId);
        return upward.reverse();
      };

      // The paths themselves do not depend on `depth` — the walk goes all the
      // way up either way — so this is computed once and every candidate depth
      // is then just an index into it. That is what makes the size guard below
      // affordable: trying a shallower level costs no further queries.
      const pathCache = new Map<number, number[]>();
      for (const endpointId of new Set(crossing.flatMap((edge) => [edge.source, edge.target]))) {
        pathCache.set(endpointId, pathOf(endpointId));
      }

      /**
       * What one candidate level produces: the containers it reaches, how they
       * nest, and the grouped edges between them.
       *
       * Grouping lives here rather than in a later step because its size is
       * half of what the budget is checked against, and the chosen level's
       * groups are exactly what the result needs — so nothing is recomputed.
       */
      const resolveAtDepth = (candidate: number) => {
        const parentById = new Map<number, number>();
        const reachable = new Set<number>();
        for (const path of pathCache.values()) {
          const limit = Math.min(candidate, path.length);
          for (let index = 0; index < limit; index++) {
            reachable.add(path[index]);
            if (index > 0) parentById.set(path[index], path[index - 1]);
          }
        }
        // The root is reported separately, so it is not a partner — but it
        // remains a legitimate `parentContainerId` for the boxes inside it.
        reachable.delete(nodeId);

        /** The box an endpoint's edge terminates at: the deepest container this level allows. */
        const containerFor = (endpointId: number): number => {
          const path = pathCache.get(endpointId)!;
          return path[Math.min(candidate, path.length) - 1];
        };
        const groups = new Map<string, AggregatedRelationshipEdge>();
        for (const edge of crossing) {
          const sourceContainerId = containerFor(edge.source);
          const targetContainerId = containerFor(edge.target);
          // A partner whose own container resolves back to the root (e.g. the
          // partner's "sibling" ancestor search bottomed out inside the root's
          // own chain) collapses to a self-loop-free internal edge; skip it.
          if (sourceContainerId === targetContainerId) continue;
          const key = `${sourceContainerId}:${targetContainerId}:${edge.relationship}`;
          const existing = groups.get(key);
          if (existing) { existing.count += 1; } else {
            groups.set(key, { sourceContainerId, targetContainerId, relationship: edge.relationship, count: 1 });
          }
        }
        return { reachable, parentById, groups };
      };

      // 6. Settle on the deepest level that fits the budget, then fetch display
      // data for the containers it reaches — the terminating boxes and the
      // frames around them.
      //
      // Downwards from the request rather than upwards from 1, because the
      // common case is that the request fits and costs one pass. The loop
      // cannot run past level 1, which is accepted unconditionally.
      let depthApplied = levels;
      let resolved = resolveAtDepth(depthApplied);
      while (
        depthApplied > 1
        && (resolved.reachable.size > AGGREGATION_MAX_CONTAINERS || resolved.groups.size > AGGREGATION_MAX_EDGES)
      ) {
        depthApplied -= 1;
        resolved = resolveAtDepth(depthApplied);
      }
      const { reachable, parentById, groups } = resolved;
      const containerIds = [...reachable];
      const containerAttrRows = containerIds.length > 0
        ? await dbModule.runQuery(
            `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id IN $ids
             RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept, ci.attributes AS attributes`,
            { ids: containerIds },
          )
        : [];
      const containers: AggregatedRelationshipContainer[] = containerAttrRows.map((row) => {
        const attrs = JSON.parse(String(row.attributes || '{}'));
        const concept = String(row.concept);
        const containerId = Number(row.node_id);
        const parentContainerId = parentById.get(containerId);
        return {
          node_id: containerId,
          namespace: String(row.namespace),
          concept,
          ...relationshipNodeLabel(attrs, concept, containerId),
          // Omitted rather than set to `undefined` so a `depth: 1` payload is
          // byte-identical to what this returned before the parameter existed.
          ...(parentContainerId !== undefined ? { parentContainerId } : {}),
        };
      });

      return {
        ok: true,
        data: {
          root,
          containers,
          edges: [...groups.values()],
          truncated,
          depth: depthApplied,
          requestedDepth: levels,
        },
      };
    },
  };
}
