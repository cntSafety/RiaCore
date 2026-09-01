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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { aggregateExportData } from './safety-export-aggregator.js';
import { generateSphinxNeedsRst } from './sphinx-needs-generator.js';
import { generateSafetyXlsx } from './safety-xlsx-generator.js';

/**
 * Register all safety channels.
 * All require an open workspace.
 *
 * Most channels delegate directly to `deps.safetyCommands` methods and unwrap
 * the `Result<T>` return value. A few (getMalfunctionsForElement,
 * getRequirementsForFm, getNotesForFm, createNoteForFm, getNoteParent) use direct Cypher
 * queries or mixed approaches, ported from worker-dispatch.ts.
 */
export function registerSafetyChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  const CATEGORY = 'safety';

  // ── Malfunction CRUD ────────────────────────────────────────────────────────

  registry.register('safety.getMalfunctions', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getMalfunctions(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunction', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getMalfunction(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.createMalfunction', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createMalfunction(payload);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateMalfunction', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateMalfunction(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteMalfunction', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteMalfunction(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Occurs-At relationships ──────────────────────────────────────────────────

  registry.register('safety.attachOccursAt', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.attachOccursAt(payload.failureModeNodeId, payload.targetNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.detachOccursAt', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.detachOccursAt(payload.failureModeNodeId, payload.targetNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.moveOccursAt', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.moveOccursAt(
      payload.failureModeNodeId, payload.oldTargetNodeId, payload.newTargetNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Propagation ──────────────────────────────────────────────────────────────

  registry.register('safety.addPropagation', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.addPropagation(
      payload.sourceFailureModeNodeId, payload.targetFailureModeNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.removePropagation', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.removePropagation(
      payload.sourceFailureModeNodeId, payload.targetFailureModeNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getPropagations', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getPropagations(payload.failureModeNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Scoped Propagation (component + descendants) ─────────────────────────────

  registry.register('safety.getPropagationsForComponent', async (payload, deps, _ctx) => {
    const { structuralNodeId } = payload;
    const analysisScope = {
      allAnalyses: payload.safetyNamespace === undefined,
      safetyNamespace: payload.safetyNamespace ?? '',
    };

    const containmentRelRows = await deps.dbModule.runQuery(
      `MATCH (r:RIA_META_Relationship)
       WHERE r.is_containment = true
       RETURN r.name AS name`,
      {},
    );
    const containmentRels = containmentRelRows.map((row) => String(row.name));

    // Step 1: Find the structural node and its direct children (one level of containment).
    // We include the node itself plus all nodes reachable via a single containment edge.
    // This covers the common case: SWC → ports, composition → sub-components.
    // Child ids are resolved via the RIA_UNIV_RelationshipInstance node table.
    const childRows = containmentRels.length > 0
      ? await deps.dbModule.runQuery(
          `MATCH (ri:RIA_UNIV_RelationshipInstance)
           WHERE ri.source_node_id = $nodeId AND ri.relationship IN $containmentRels
           RETURN ri.target_node_id AS node_id`,
          { nodeId: structuralNodeId, containmentRels },
        )
      : [];
    const structuralNodeIds = [...new Set([
      structuralNodeId,
      ...childRows.map(r => Number(r.node_id)),
    ])];

    if (structuralNodeIds.length === 0) {
      return { internalNodes: [], boundaryNodes: [], internalEdges: [], boundaryEdges: [], structuralNodes: [] };
    }

    // Step 1b: Fetch attributes of all structural nodes so we can return their names
    // and know which ones are children (ports) vs the root component.
    function extractName(rawAttributes: unknown): string | undefined {
      if (!rawAttributes) return undefined;
      try {
        const attrs = typeof rawAttributes === 'string' ? JSON.parse(rawAttributes) : rawAttributes;
        return String(attrs.short_name || attrs.has_name || attrs.name || '') || undefined;
      } catch { return undefined; }
    }

    const structuralAttrRows = await deps.dbModule.runQuery(
      `MATCH (n:RIA_UNIV_ConceptInstance)
       WHERE n.node_id IN $nodeIds
       RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept, n.attributes AS attributes`,
      { nodeIds: structuralNodeIds },
    );

    // Build a lookup: node_id → { name, namespace, concept }
    const structuralAttrMap = new Map<number, { name: string; namespace: string; concept: string }>();
    for (const row of structuralAttrRows) {
      const nid = Number(row.node_id);
      structuralAttrMap.set(nid, {
        name: extractName(row.attributes) ?? String(nid),
        namespace: String(row.namespace),
        concept: String(row.concept),
      });
    }

    const rootInfo = structuralAttrMap.get(structuralNodeId);
    const rootName = rootInfo?.name ?? String(structuralNodeId);

    const childNodeIds = childRows.map(r => Number(r.node_id));

    const structuralNodes = [
      // Root node itself
      {
        node_id: structuralNodeId,
        namespace: rootInfo?.namespace ?? '',
        concept: rootInfo?.concept ?? '',
        name: rootName,
        parentNodeId: null as number | null,
        parentName: null as string | null,
      },
      // Direct children (ports / sub-components)
      ...childNodeIds.map(cid => {
        const info = structuralAttrMap.get(cid);
        return {
          node_id: cid,
          namespace: info?.namespace ?? '',
          concept: info?.concept ?? '',
          name: info?.name ?? String(cid),
          parentNodeId: structuralNodeId,
          parentName: rootName,
        };
      }),
    ];

    // Step 2: Find this analysis's malfunctions on the shared structural nodes.
    const fmRows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE oa.relationship = 'occurs_at' AND tgt.node_id IN $structuralIds AND fm.concept = 'malfunction'
         AND ($allAnalyses OR fm.namespace = $safetyNamespace)
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes,
              tgt.node_id AS oa_node_id, tgt.namespace AS oa_namespace, tgt.concept AS oa_concept, tgt.attributes AS oa_attributes`,
      { structuralIds: structuralNodeIds, ...analysisScope },
    );

    const internalNodeIds = new Set(fmRows.map(r => Number(r.node_id)));

    const internalNodes = fmRows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
      occursAtTarget: row.oa_node_id != null
        ? { node_id: Number(row.oa_node_id), namespace: String(row.oa_namespace), concept: String(row.oa_concept), name: extractName(row.oa_attributes) }
        : null,
    }));

    if (internalNodeIds.size === 0) {
      return { internalNodes: [], boundaryNodes: [], internalEdges: [], boundaryEdges: [], structuralNodes };
    }

    // Step 3: Find all propagation edges involving internal malfunctions.
    const internalIdsArray = Array.from(internalNodeIds);
    const edgeRows = await deps.dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.relationship = 'propagates_to'
         AND (ri.source_node_id IN $internalIds OR ri.target_node_id IN $internalIds)
       RETURN ri.source_node_id AS source, ri.target_node_id AS target`,
      { internalIds: internalIdsArray },
    );

    const internalEdges: Array<{ source: number; target: number }> = [];
    const boundaryEdges: Array<{ source: number; target: number }> = [];
    const boundaryNodeIds = new Set<number>();

    for (const row of edgeRows) {
      const source = Number(row.source);
      const target = Number(row.target);
      const srcInternal = internalNodeIds.has(source);
      const tgtInternal = internalNodeIds.has(target);

      if (srcInternal && tgtInternal) {
        internalEdges.push({ source, target });
      } else {
        boundaryEdges.push({ source, target });
        if (!srcInternal) boundaryNodeIds.add(source);
        if (!tgtInternal) boundaryNodeIds.add(target);
      }
    }

    // Step 4: Fetch boundary node data
    let boundaryNodes: Array<{
      node_id: number; namespace: string; concept: string; metamodel: string;
      attributes: Record<string, unknown>;
      occursAtTarget: { node_id: number; namespace: string; concept: string; name?: string } | null;
    }> = [];
    if (boundaryNodeIds.size > 0) {
      const boundaryRows = await deps.dbModule.runQuery(
        `MATCH (fm:RIA_UNIV_ConceptInstance)
         WHERE fm.node_id IN $boundaryIds AND fm.concept = 'malfunction'
           AND ($allAnalyses OR fm.namespace = $safetyNamespace)
         OPTIONAL MATCH (fm)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(oaTgt:RIA_UNIV_ConceptInstance)
           WHERE oa.relationship = 'occurs_at'
         RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
                fm.metamodel AS metamodel, fm.attributes AS attributes,
                oaTgt.node_id AS oa_node_id, oaTgt.namespace AS oa_namespace, oaTgt.concept AS oa_concept, oaTgt.attributes AS oa_attributes`,
        { boundaryIds: Array.from(boundaryNodeIds), ...analysisScope },
      );
      boundaryNodes = boundaryRows.map(row => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
        occursAtTarget: row.oa_node_id != null
          ? { node_id: Number(row.oa_node_id), namespace: String(row.oa_namespace), concept: String(row.oa_concept), name: extractName(row.oa_attributes) }
          : null,
      }));
    }

    // Structural boundary nodes remain visible within the analysis; a link to
    // a malfunction in a different analysis must not reintroduce it or leave
    // an edge whose endpoint was filtered out.
    const visibleIds = new Set([...internalNodeIds, ...boundaryNodes.map(node => node.node_id)]);
    return {
      internalNodes, boundaryNodes, internalEdges, structuralNodes,
      boundaryEdges: boundaryEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    };
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Risk Rating ──────────────────────────────────────────────────────────────

  registry.register('safety.createRiskRating', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createRiskRating(payload);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getRiskRating', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getRiskRating(payload.failureModeNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateRiskRating', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateRiskRating(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteRiskRating', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteRiskRating(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Safety Tasks ─────────────────────────────────────────────────────────────

  registry.register('safety.createSafetyTask', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createSafetyTask(
      payload.namespace, payload.name, payload.description, payload.status, payload.type,
      payload.responsible, payload.reference,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkSafetyTaskToFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.linkSafetyTaskToFm(
      payload.failureModeNodeId, payload.safetyTaskNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkSafetyTaskFromFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkSafetyTaskFromFm(
      payload.failureModeNodeId, payload.safetyTaskNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getSafetyTasks', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getSafetyTasks(payload.failureModeNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunctionForTask', async (payload, deps, _ctx) => {
    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(task:RIA_UNIV_ConceptInstance)
       WHERE task.node_id = $nodeId AND r.relationship = 'has_safety_tasks' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       LIMIT 1`,
      { nodeId: payload.safetyTaskNodeId },
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    };
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunctionForRiskRating', async (payload, deps, _ctx) => {
    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(rr:RIA_UNIV_ConceptInstance)
       WHERE rr.node_id = $nodeId AND r.relationship = 'has_risk_rating' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       LIMIT 1`,
      { nodeId: payload.riskRatingNodeId },
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    };
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunctionForReviewItem', async (payload, deps, _ctx) => {
    // Primary path: review_item attached directly to malfunction.
    const directRows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(ri:RIA_UNIV_ConceptInstance)
       WHERE ri.node_id = $nodeId AND r.relationship = 'has_review' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       LIMIT 1`,
      { nodeId: payload.reviewItemNodeId },
    );
    if (directRows.length > 0) {
      const row = directRows[0];
      return {
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
      };
    }

    // Secondary path: review_item attached to risk_rating; resolve its parent malfunction.
    const viaRiskRatingRows = await deps.dbModule.runQuery(
      `MATCH (rr:RIA_UNIV_ConceptInstance)-[rev:RIA_UNIV_INSTANCE_REL]->(ri:RIA_UNIV_ConceptInstance)
       WHERE ri.node_id = $nodeId AND rev.relationship = 'has_review' AND rr.concept = 'risk_rating'
       MATCH (fm:RIA_UNIV_ConceptInstance)-[parent:RIA_UNIV_INSTANCE_REL]->(rr)
       WHERE parent.relationship = 'has_risk_rating' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       LIMIT 1`,
      { nodeId: payload.reviewItemNodeId },
    );
    if (viaRiskRatingRows.length === 0) return null;
    const row = viaRiskRatingRows[0];
    return {
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    };
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getAllSafetyTasks', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getAllSafetyTasks(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateSafetyTask', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateSafetyTask(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteSafetyTask', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteSafetyTask(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── SOTIF: Functional Insufficiencies (shared node, 1-to-n to malfunctions) ──

  registry.register('safety.createFunctionalInsufficiency', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createFunctionalInsufficiency(
      payload.namespace, payload.name, payload.description, payload.source,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkFunctionalInsufficiencyToFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.linkFunctionalInsufficiencyToFm(
      payload.failureModeNodeId, payload.functionalInsufficiencyNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkFunctionalInsufficiencyFromFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkFunctionalInsufficiencyFromFm(
      payload.failureModeNodeId, payload.functionalInsufficiencyNodeId,
    );
    if (!result.ok) throw new Error(result.error);
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getFunctionalInsufficiencies', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getFunctionalInsufficiencies(payload.failureModeNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getAllFunctionalInsufficiencies', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getAllFunctionalInsufficiencies(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunctionsForFunctionalInsufficiency', async (payload, deps, _ctx) => {
    // Reverse 1-to-n query: which malfunctions reference this functional
    // insufficiency. Union intra- and cross-namespace edges (mirrors
    // getMalfunctionsForRequirement).
    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(fi:RIA_UNIV_ConceptInstance)
       WHERE fi.node_id = $nodeId AND r.relationship = 'has_functional_insufficiencies' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       UNION
       MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(fi:RIA_UNIV_ConceptInstance)
       WHERE fi.node_id = $nodeId AND r.relationship = 'has_functional_insufficiencies' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes`,
      { nodeId: payload.functionalInsufficiencyNodeId },
    );
    return rows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateFunctionalInsufficiency', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateFunctionalInsufficiency(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteFunctionalInsufficiency', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteFunctionalInsufficiency(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── SOTIF: Triggering Conditions (shared node, 1-to-n to malfunctions) ───────

  registry.register('safety.createTriggeringCondition', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createTriggeringCondition(
      payload.namespace, payload.name, payload.description, payload.source,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkTriggeringConditionToFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.linkTriggeringConditionToFm(
      payload.failureModeNodeId, payload.triggeringConditionNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkTriggeringConditionFromFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkTriggeringConditionFromFm(
      payload.failureModeNodeId, payload.triggeringConditionNodeId,
    );
    if (!result.ok) throw new Error(result.error);
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getTriggeringConditions', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getTriggeringConditions(payload.failureModeNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getAllTriggeringConditions', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getAllTriggeringConditions(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunctionsForTriggeringCondition', async (payload, deps, _ctx) => {
    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tc:RIA_UNIV_ConceptInstance)
       WHERE tc.node_id = $nodeId AND r.relationship = 'has_triggering_conditions' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       UNION
       MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tc:RIA_UNIV_ConceptInstance)
       WHERE tc.node_id = $nodeId AND r.relationship = 'has_triggering_conditions' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes`,
      { nodeId: payload.triggeringConditionNodeId },
    );
    return rows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateTriggeringCondition', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateTriggeringCondition(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteTriggeringCondition', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteTriggeringCondition(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Requirements ─────────────────────────────────────────────────────────────

  registry.register('safety.createRequirement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createRequirement(
      payload.namespace, payload.name, payload.reqId, payload.reqText, payload.asil, payload.linkedToUrl,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getRequirement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getRequirement(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getRequirements', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getRequirements(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkRequirementFromFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkRequirementFromFm(
      payload.failureModeNodeId, payload.requirementNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateRequirement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateRequirement(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteRequirement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteRequirement(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Safety Notes ─────────────────────────────────────────────────────────────

  registry.register('safety.createSafetyNote', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createSafetyNote(
      payload.namespace, payload.noteText, payload.targetNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getSafetyNote', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getSafetyNote(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getSafetyNotes', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getSafetyNotes(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateSafetyNote', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateSafetyNote(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteSafetyNote', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteSafetyNote(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Review Items ─────────────────────────────────────────────────────────────

  registry.register('safety.createReviewItem', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createReviewItem(
      payload.namespace, payload.reviewerComment, payload.reviewedElementId, payload.name,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getReviewItem', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getReviewItem(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getReviewItems', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getReviewItems(payload.reviewedElementNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getAllReviewItems', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getAllReviewItems(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateReviewItem', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateReviewItem(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteReviewItem', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteReviewItem(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Direct-query handlers (ported from worker-dispatch.ts) ───────────────────

  registry.register('safety.getMalfunctionsForElement', async (payload, deps, _ctx) => {
    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE tgt.node_id = $targetNodeId AND r.relationship = 'occurs_at' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes`,
      { targetNodeId: payload.targetNodeId },
    );
    return rows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  /**
   * Batch peer of `safety.getMalfunctionsForElement`.
   *
   * The view-based connection diagram resolves malfunctions for every port and
   * component it draws from `rep.sources[].nodeId` — safety data is outside
   * `CommonModel` by design (spec-view.md Phase 4.3), so it is fetched
   * alongside rather than through the view. Doing that one node at a time would
   * be one round trip per pin on the diagram; this is the same query with `IN`.
   * An analysis view supplies its authored safety namespace: the same imported
   * element can have unrelated malfunctions in several analyses. Omitting the
   * namespace retains the aggregate lookup used outside an analysis context.
   *
   * Every requested node id appears in the result, mapping to an empty array
   * when it has no malfunctions, so a caller never has to distinguish "none"
   * from "not asked for".
   */
  registry.register('safety.getMalfunctionsForElements', async (payload, deps, _ctx) => {
    const targetNodeIds = [...new Set(payload.targetNodeIds ?? [])].filter((id) => Number.isFinite(id));
    const result: Record<number, ConceptInstanceData[]> = {};
    for (const nodeId of targetNodeIds) result[nodeId] = [];
    if (targetNodeIds.length === 0) return result;

    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE tgt.node_id IN $targetNodeIds AND r.relationship = 'occurs_at' AND fm.concept = 'malfunction'
         AND ($allAnalyses OR fm.namespace = $safetyNamespace)
       RETURN tgt.node_id AS target_node_id, fm.node_id AS node_id, fm.namespace AS namespace,
              fm.concept AS concept, fm.metamodel AS metamodel, fm.attributes AS attributes`,
      {
        targetNodeIds,
        allAnalyses: payload.safetyNamespace === undefined,
        safetyNamespace: payload.safetyNamespace ?? '',
      },
    );
    for (const row of rows) {
      const targetNodeId = Number(row.target_node_id);
      const list = result[targetNodeId];
      if (!list) continue;
      list.push({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
      });
    }
    return result;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getRequirementsForFm', async (payload, deps, _ctx) => {
    // Resolve requirement ids via RelationshipInstance, then fetch the nodes by id.
    const idRows = await deps.dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId AND ri.relationship = 'has_safety_requirements'
       RETURN ri.target_node_id AS node_id`,
      { nodeId: payload.failureModeNodeId },
    );
    const reqIds = [...new Set(idRows.map(r => Number(r.node_id)))];
    const rows = reqIds.length > 0
      ? await deps.dbModule.runQuery(
          `MATCH (req:RIA_UNIV_ConceptInstance)
           WHERE req.node_id IN $ids AND req.concept = 'requirement'
           RETURN req.node_id AS node_id, req.namespace AS namespace, req.concept AS concept,
                  req.metamodel AS metamodel, req.attributes AS attributes`,
          { ids: reqIds },
        )
      : [];
    return rows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getMalfunctionsForRequirement', async (payload, deps, _ctx) => {
    // Match both same-namespace (INSTANCE_REL) and cross-namespace (CROSSNS_INSTANCE_REL) edges
    const rows = await deps.dbModule.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(req:RIA_UNIV_ConceptInstance)
       WHERE req.node_id = $nodeId AND r.relationship IN ['has_safety_requirements', 'has_direct_requirements'] AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes
       UNION
       MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req:RIA_UNIV_ConceptInstance)
       WHERE req.node_id = $nodeId AND r.relationship IN ['has_safety_requirements', 'has_direct_requirements'] AND fm.concept = 'malfunction'
       RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
              fm.metamodel AS metamodel, fm.attributes AS attributes`,
      { nodeId: payload.requirementNodeId },
    );
    return rows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkRequirementToFm', async (payload, deps, _ctx) => {
    if (!deps.instanceService) throw new Error('Instance service not configured');
    const result = await deps.instanceService.createRelationship(
      payload.failureModeNodeId, payload.requirementNodeId, 'has_safety_requirements',
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkDirectRequirementToFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.linkDirectRequirementToFm(
      payload.failureModeNodeId, payload.requirementNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkDirectRequirementFromFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkDirectRequirementFromFm(
      payload.failureModeNodeId, payload.requirementNodeId,
    );
    if (!result.ok) throw new Error(result.error);
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getDirectRequirementsForFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getDirectRequirementsForFm(payload.failureModeNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.searchRequirementsAcrossNamespaces', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.searchRequirementsAcrossNamespaces(payload.query ?? '');
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getNotesForFm', async (payload, deps, _ctx) => {
    // Resolve note ids via RelationshipInstance, then fetch the nodes by id.
    const idRows = await deps.dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId AND ri.relationship = 'has_notes'
       RETURN ri.target_node_id AS node_id`,
      { nodeId: payload.failureModeNodeId },
    );
    const noteIds = [...new Set(idRows.map(r => Number(r.node_id)))];
    const rows = noteIds.length > 0
      ? await deps.dbModule.runQuery(
          `MATCH (n:RIA_UNIV_ConceptInstance)
           WHERE n.node_id IN $ids AND n.concept = 'safety_note'
           RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
                  n.metamodel AS metamodel, n.attributes AS attributes`,
          { ids: noteIds },
        )
      : [];
    return rows.map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.createNoteForFm', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createSafetyNote(
      payload.namespace, payload.noteText, payload.failureModeNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Element-scoped notes ─────────────────────────────────────────────────────

  registry.register('safety.getNotesForElement', async (payload, deps, _ctx) => {
    // Intra-namespace: element -[has_notes]-> note. Resolve ids via
    // RelationshipInstance then fetch the nodes by id.
    const intraIdRows = await deps.dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId AND ri.relationship = 'has_notes'
       RETURN ri.target_node_id AS node_id`,
      { nodeId: payload.elementNodeId },
    );
    const noteIds = [...new Set(intraIdRows.map(r => Number(r.node_id)))];
    const intraRows = noteIds.length > 0
      ? await deps.dbModule.runQuery(
          `MATCH (n:RIA_UNIV_ConceptInstance)
           WHERE n.node_id IN $ids AND n.concept = 'safety_note'
           RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
                  n.metamodel AS metamodel, n.attributes AS attributes`,
          { ids: noteIds },
        )
      : [];
    // Cross-namespace: imported element -[has_notes]-> note via CROSSNS_INSTANCE_REL
    const crossRows = await deps.dbModule.runQuery(
      `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(n:RIA_UNIV_ConceptInstance)
       WHERE elem.node_id = $nodeId AND r.relationship = 'has_notes' AND n.concept = 'safety_note'
       RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
              n.metamodel AS metamodel, n.attributes AS attributes`,
      { nodeId: payload.elementNodeId },
    );
    return [...intraRows, ...crossRows].map(row => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.createNoteForElement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createSafetyNote(
      payload.namespace, payload.noteText, payload.elementNodeId,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getNoteParent', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getNoteParent(payload.noteNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Delete impact preview & instance lookup ──────────────────────────────────

  registry.register('safety.previewDeleteImpact', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.previewDeleteImpact(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getInstance', async (payload, deps, _ctx) => {
    if (!deps.instanceService) throw new Error('Instance service not configured');
    const result = await deps.instanceService.getInstance(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getInstanceByUuid', async (payload, deps, _ctx) => {
    if (!deps.instanceService) throw new Error('Instance service not configured');
    const result = await deps.instanceService.getInstanceByUuid(payload.uuid);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Tags ─────────────────────────────────────────────────────────────────────

  registry.register('safety.createTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.createTag(payload);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getTag(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getAllTags', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getAllTags(payload.namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.updateTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.updateTag(payload.nodeId, payload.updates);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.deleteTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.deleteTag(payload.nodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.linkTag(payload.elementNodeId, payload.tagNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkTag(payload.elementNodeId, payload.tagNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getTagsForElement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getTagsForElement(payload.elementNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getElementsForTag', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getElementsForTag(payload.tagNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.linkTagCrossNs', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.linkTagCrossNs(payload.tagNodeId, payload.importedElementNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.unlinkTagCrossNs', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.unlinkTagCrossNs(payload.tagNodeId, payload.importedElementNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getTagsForImportedElement', async (payload, deps, _ctx) => {
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    const result = await deps.safetyCommands.getTagsForImportedElement(payload.importedElementNodeId);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Sphinx-Needs RST Export ──────────────────────────────────────────────────

  registry.register('safety.exportSphinxNeeds', async (payload, deps, _ctx) => {
    const { namespace, outputDir } = payload;

    // Validate namespace
    if (!namespace || !namespace.trim()) {
      throw new Error('Namespace must be a non-empty string.');
    }

    // Aggregate data
    const exportData = await aggregateExportData(namespace, deps);

    if (exportData.components.length === 0) {
      throw new Error('No Sphinx-Needs data available to export.');
    }

    // Generate RST
    const { files } = generateSphinxNeedsRst(exportData);

    // Write files
    const resolvedOutputDir = path.resolve(outputDir);
    const exportedFiles: string[] = [];

    for (const [relativePath, content] of files) {
      const absolutePath = path.join(resolvedOutputDir, relativePath);
      try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, 'utf8');
        exportedFiles.push(relativePath);
      } catch (err) {
        throw new Error(
          `Failed to write export file: ${relativePath} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    exportedFiles.sort();
    return { exportedFiles, outputDir: resolvedOutputDir };
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── Excel (.xlsx) Safety Export ───────────────────────────────────────────────

  registry.register('safety.exportXlsx', async (payload, deps, _ctx) => {
    const { namespace, outputPath } = payload;

    // Validate inputs
    if (!namespace || !namespace.trim()) {
      throw new Error('Namespace must be a non-empty string.');
    }
    if (!outputPath || !outputPath.trim()) {
      throw new Error('Output path must be a non-empty string.');
    }

    // Aggregate the same data the .rst report uses
    const exportData = await aggregateExportData(namespace, deps);

    if (exportData.components.length === 0) {
      throw new Error('No safety data available to export.');
    }

    // Generate the workbook (in memory) and write it to disk
    const buffer = await generateSafetyXlsx(exportData);

    const resolvedOutputPath = path.resolve(outputPath);
    try {
      await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await fs.writeFile(resolvedOutputPath, buffer);
    } catch (err) {
      throw new Error(
        `Failed to write export file: ${resolvedOutputPath} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { outputPath: resolvedOutputPath };
  }, { requiresWorkspace: true, category: CATEGORY });

  registry.register('safety.getSafetyData', async (payload, deps, _ctx) => {
    if (!payload.namespace || payload.namespace.trim() === '') {
      throw new Error('namespace must be a non-empty string');
    }
    if (!deps.safetyCommands) throw new Error('Safety commands not configured');
    return aggregateExportData(payload.namespace, deps);
  }, { requiresWorkspace: true, category: CATEGORY });
}
