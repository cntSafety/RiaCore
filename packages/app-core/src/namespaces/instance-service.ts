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
import type { Result } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';

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
  };
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      // Use CONTAINS for initial filtering, then exact-match in JS.
      // This works because stable_path and uuid are stored inside the JSON attributes string.
      const rows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance)
         WHERE ci.attributes CONTAINS $uuid
         RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
                ci.metamodel AS metamodel, ci.attributes AS attributes
         LIMIT 10`,
        { uuid },
      );

      for (const row of rows) {
        const attrs = JSON.parse(String(row.attributes || '{}'));
        if (attrs.stable_path === uuid || attrs.uuid === uuid) {
          return {
            ok: true,
            data: {
              node_id: Number(row.node_id),
              namespace: String(row.namespace),
              concept: String(row.concept),
              metamodel: String(row.metamodel),
              attributes: attrs,
            },
          };
        }
      }

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
            name: String(attrs.has_name ?? ''),
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
            name: String(attrs.has_name ?? ''),
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
            name: String(attrs.has_name ?? ''),
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
            name: String(attrs.has_name ?? ''),
          },
        });
      }

      return { ok: true, data: results };
    },
  };
}
