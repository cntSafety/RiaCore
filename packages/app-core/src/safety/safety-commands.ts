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
import { createHash } from 'crypto';
import type { Result } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { IInstanceService, ConceptInstanceData } from '../namespaces/instance-service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SAFETY_METAMODEL = 'SAFETY_ANALYSIS';

const SAFETY_CONCEPTS = [
  'malfunction',
  'risk_rating',
  'requirement',
  'safety_task',
  'safety_note',
  'review_item',
  'tag',
] as const;

export type SafetyConcept = (typeof SAFETY_CONCEPTS)[number];

// ---------------------------------------------------------------------------
// Domain Types
// ---------------------------------------------------------------------------

export interface CreateMalfunctionParams {
  namespace: string;
  name: string;
  description: string;
  occursAtNodeId?: number;
  asil?: string;
}

export interface MalfunctionData extends ConceptInstanceData {
  riskRating?: ConceptInstanceData | null;
  occursAtTarget?: { node_id: number; namespace: string; concept: string; name?: string } | null;
  propagationScope?: {
    rootNodeId: number;
    structuralNodeIds: number[];
  } | null;
}

export interface PropagationMalfunctionData extends ConceptInstanceData {
  occursAtTarget?: { node_id: number; namespace: string; concept: string; name?: string } | null;
}

export interface CreateTagParams {
  namespace: string;
  name: string;
  description?: string;
  color?: string;
}

export interface CreateRiskRatingParams {
  failureModeNodeId: number;
  severity: string;
  occurrence: string;
  detection: string;
  note?: string;
}

export interface ReviewItemData extends ConceptInstanceData {
  suspect?: boolean;
}

export interface DeleteImpactPreview {
  element: { node_id: number; concept: string; name: string };
  ownedChildren: { node_id: number; concept: string; name: string }[];
  reviewItems: { node_id: number; name: string }[];
  relationships: { edge_id: number; relationship: string; type: 'intra' | 'cross' }[];
  totalElements: number;
  totalRelationships: number;
}

// ---------------------------------------------------------------------------
// ISafetyCommands Interface
// ---------------------------------------------------------------------------

export interface ISafetyCommands {
  // --- Malfunction CRUD ---
  createMalfunction(params: CreateMalfunctionParams): Promise<Result<{ node_id: number }>>;
  getMalfunction(nodeId: number): Promise<Result<MalfunctionData>>;
  getMalfunctions(namespace: string): Promise<Result<ConceptInstanceData[]>>;
  updateMalfunction(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteMalfunction(nodeId: number): Promise<Result<void>>;

  // --- Malfunction occurs_at management ---
  attachOccursAt(failureModeNodeId: number, targetNodeId: number): Promise<Result<{ edge_id: number }>>;
  detachOccursAt(failureModeNodeId: number, targetNodeId: number): Promise<Result<void>>;
  moveOccursAt(failureModeNodeId: number, oldTargetNodeId: number, newTargetNodeId: number): Promise<Result<void>>;

  // --- Malfunction propagation management ---
  addPropagation(sourceFailureModeNodeId: number, targetFailureModeNodeId: number): Promise<Result<{ edge_id: number }>>;
  removePropagation(sourceFailureModeNodeId: number, targetFailureModeNodeId: number): Promise<Result<void>>;
  getPropagations(failureModeNodeId: number): Promise<Result<{ propagatesTo: PropagationMalfunctionData[]; propagatesFrom: PropagationMalfunctionData[] }>>;

  // --- Risk Rating CRUD ---
  createRiskRating(params: CreateRiskRatingParams): Promise<Result<{ node_id: number }>>;
  getRiskRating(failureModeNodeId: number): Promise<Result<ConceptInstanceData | null>>;
  updateRiskRating(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteRiskRating(nodeId: number): Promise<Result<void>>;

  // --- Safety Task CRUD ---
  createSafetyTask(
    namespace: string,
    name: string,
    description: string,
    status: string,
    type: string,
    responsible?: string,
    reference?: string,
  ): Promise<Result<{ node_id: number }>>;
  linkSafetyTaskToFm(failureModeNodeId: number, safetyTaskNodeId: number): Promise<Result<{ edge_id: number }>>;
  unlinkSafetyTaskFromFm(failureModeNodeId: number, safetyTaskNodeId: number): Promise<Result<void>>;
  getSafetyTasks(failureModeNodeId: number): Promise<Result<ConceptInstanceData[]>>;
  getAllSafetyTasks(namespace: string): Promise<Result<ConceptInstanceData[]>>;
  updateSafetyTask(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteSafetyTask(nodeId: number): Promise<Result<void>>;

  // --- Requirement CRUD ---
  createRequirement(
    namespace: string,
    name: string,
    reqId: string,
    reqText: string,
    asil?: string,
    linkedToUrl?: string,
  ): Promise<Result<{ node_id: number }>>;
  getRequirement(nodeId: number): Promise<Result<ConceptInstanceData>>;
  getRequirements(namespace: string): Promise<Result<ConceptInstanceData[]>>;
  unlinkRequirementFromFm(failureModeNodeId: number, requirementNodeId: number): Promise<Result<void>>;
  updateRequirement(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteRequirement(nodeId: number): Promise<Result<void>>;

  // --- Safety Note CRUD ---
  createSafetyNote(
    namespace: string,
    noteText: string,
    targetNodeId: number,
  ): Promise<Result<{ node_id: number }>>;
  getNoteParent(noteNodeId: number): Promise<Result<ConceptInstanceData | null>>;
  getSafetyNote(nodeId: number): Promise<Result<ConceptInstanceData>>;
  getSafetyNotes(namespace: string): Promise<Result<ConceptInstanceData[]>>;
  updateSafetyNote(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteSafetyNote(nodeId: number): Promise<Result<void>>;

  // --- Review Item CRUD ---
  createReviewItem(
    namespace: string,
    reviewerComment: string,
    reviewedElementId: number,
    name?: string,
  ): Promise<Result<{ node_id: number }>>;
  getReviewItem(nodeId: number): Promise<Result<ReviewItemData>>;
  getReviewItems(reviewedElementNodeId: number): Promise<Result<ReviewItemData[]>>;
  getAllReviewItems(namespace: string): Promise<Result<ConceptInstanceData[]>>;
  updateReviewItem(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteReviewItem(nodeId: number): Promise<Result<void>>;
  isReviewSuspect(reviewItemNodeId: number): Promise<Result<{ suspect: boolean }>>;

  // --- Bulk Review Operations ---
  createBulkReview(
    namespace: string,
    elementNodeIds: number[],
    reviewerComment: string,
    name?: string,
  ): Promise<Result<{ elementNodeId: number; reviewItemNodeId: number }[]>>;
  bulkResolveReviews(
    reviewItemNodeIds: number[],
    authorComment?: string,
  ): Promise<Result<{ resolvedCount: number }>>;

  // --- Tag CRUD ---
  createTag(params: CreateTagParams): Promise<Result<{ node_id: number }>>;
  getTag(nodeId: number): Promise<Result<ConceptInstanceData>>;
  getAllTags(namespace: string): Promise<Result<ConceptInstanceData[]>>;
  updateTag(nodeId: number, updates: Record<string, unknown>): Promise<Result<void>>;
  deleteTag(nodeId: number): Promise<Result<void>>;

  // --- Intra-namespace tag linking ---
  linkTag(elementNodeId: number, tagNodeId: number): Promise<Result<{ edge_id: number }>>;
  unlinkTag(elementNodeId: number, tagNodeId: number): Promise<Result<void>>;
  getTagsForElement(elementNodeId: number): Promise<Result<ConceptInstanceData[]>>;
  getElementsForTag(tagNodeId: number): Promise<Result<ConceptInstanceData[]>>;

  // --- Cross-namespace tag linking ---
  linkTagCrossNs(tagNodeId: number, importedElementNodeId: number): Promise<Result<{ edge_id: number }>>;
  unlinkTagCrossNs(tagNodeId: number, importedElementNodeId: number): Promise<Result<void>>;
  getTagsForImportedElement(importedElementNodeId: number): Promise<Result<ConceptInstanceData[]>>;

  // --- Direct (cross-namespace) requirement linking ---
  linkDirectRequirementToFm(failureModeNodeId: number, requirementNodeId: number): Promise<Result<{ edge_id: number }>>;
  unlinkDirectRequirementFromFm(failureModeNodeId: number, requirementNodeId: number): Promise<Result<void>>;
  getDirectRequirementsForFm(failureModeNodeId: number): Promise<Result<ConceptInstanceData[]>>;
  searchRequirementsAcrossNamespaces(query: string): Promise<Result<ConceptInstanceData[]>>;

  // --- Delete with Domain Semantics ---
  previewDeleteImpact(nodeId: number): Promise<Result<DeleteImpactPreview>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 hash of an attributes map.
 * Keys are sorted alphabetically for canonical JSON serialization.
 */
export function computeContentHash(attributes: Record<string, unknown>): string {
  const sorted = Object.keys(attributes)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = attributes[key];
      return acc;
    }, {});
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Severity weights for RPN computation.
 */
const SEVERITY_WEIGHTS: Record<string, number> = {
  'Safety-Impact': 2,
  'QM-Impact': 1,
};

/**
 * Level numbers for occurrence and detection in RPN computation.
 */
const LEVEL_NUMBERS: Record<string, number> = {
  Level1: 1,
  Level2: 2,
  Level3: 3,
  Level4: 4,
  Level5: 5,
};

/**
 * Compute Risk Priority Number: severity × occurrence × detection.
 */
export function computeRPN(severity: string, occurrence: string, detection: string): number {
  const s = SEVERITY_WEIGHTS[severity] ?? 0;
  const o = LEVEL_NUMBERS[occurrence] ?? 0;
  const d = LEVEL_NUMBERS[detection] ?? 0;
  return s * o * d;
}

/**
 * Verify that a ConceptInstance is of the expected concept type.
 * Returns the instance data on success, or an error Result if the concept doesn't match.
 */
export async function assertConcept(
  instanceService: IInstanceService,
  nodeId: number,
  expectedConcept: SafetyConcept,
): Promise<Result<ConceptInstanceData>> {
  const result = await instanceService.getInstance(nodeId);
  if (!result.ok) return result;
  if (result.data.concept !== expectedConcept) {
    return {
      ok: false,
      error: `Node ${nodeId} is not a ${expectedConcept} (found: ${result.data.concept})`,
    };
  }
  return result;
}

/**
 * Check whether a given concept name is a valid safety concept.
 */
export function isSafetyConcept(concept: string): concept is SafetyConcept {
  return (SAFETY_CONCEPTS as readonly string[]).includes(concept);
}

/**
 * Verify that `namespace` is the *authored* namespace for the safety
 * metamodel — i.e. it has a `RIA_META_DEFINEDBY` edge to a metamodel.
 *
 * Imported namespaces only have `RIA_META_CATEGORIZEDBY` edges (added during
 * connection wiring so cross-NS edges are allowed). They must NOT host
 * authored safety instances (malfunction, safety_note, safety_task,
 * requirement, tag, review_item, risk_rating).
 *
 * Without this guard the renderer can mis-route a `create*` call to an
 * imported namespace (e.g. when an `editorOverrides` entry routes the
 * SafetyEditor to an imported namespace), and `instanceService.createInstance`
 * silently accepts the write because the `DEFINEDBY|CATEGORIZEDBY` lookup
 * resolves the metamodel via the CATEGORIZEDBY edge.
 */
export async function assertAuthoredNamespace(
  dbModule: IDbModule,
  namespace: string,
  concept: string,
): Promise<Result<void>> {
  const rows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})-[:RIA_META_DEFINEDBY]->(:RIA_META_Metamodel)
     RETURN count(*) AS cnt`,
    { namespace },
  );
  if (Number(rows[0]?.cnt ?? 0) === 0) {
    return {
      ok: false,
      error: `Cannot create '${concept}' in namespace '${namespace}': not an authored namespace. Authored safety content must live in an authored namespace defined by a safety metamodel (e.g. SAFETY_ANALYSIS or SYSTEM_SAFETY_ANALYSIS).`,
    };
  }
  return { ok: true, data: undefined };
}

/**
 * Resolve the metamodel that defines an authored safety namespace via its
 * `RIA_META_DEFINEDBY` binding.
 *
 * Cross-namespace safety edges (occurs_at, has_notes, has_tag,
 * has_direct_requirements) store the owning metamodel so they attribute to the
 * correct safety profile. Multiple profiles share the 'Safety-Analysis' owning
 * application and the same editor while registering distinct metamodels — the
 * SW-level `SAFETY_ANALYSIS` and the system-level `SYSTEM_SAFETY_ANALYSIS`. The
 * relationship types are defined in whichever metamodel the authored namespace
 * is bound to, so the edge must carry that name rather than a hard-coded one.
 * Falls back to the SW metamodel if the binding cannot be resolved.
 */
export async function resolveAuthoredMetamodel(
  dbModule: IDbModule,
  namespace: string,
): Promise<string> {
  const rows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
     RETURN mm.name AS name LIMIT 1`,
    { namespace },
  );
  const name = rows[0]?.name;
  return typeof name === 'string' && name.length > 0 ? name : SAFETY_METAMODEL;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSafetyCommands(
  instanceService: IInstanceService,
  dbModule: IDbModule,
): ISafetyCommands {

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Forward-edge lookup helpers
  //
  // Resolve forward edges via the RIA_UNIV_RelationshipInstance node table
  // rather than traversing INSTANCE_REL directly. This avoids touching the
  // CSR adjacency structures and is the standard pattern for source-pinned
  // outgoing-edge lookups in this codebase.
  // -----------------------------------------------------------------------

  /** Returns target node_ids of `relationship` edges leaving `sourceNodeId`. */
  async function forwardTargetIds(sourceNodeId: number, relationship: string): Promise<number[]> {
    const rows = await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId AND ri.relationship = $rel
       RETURN ri.target_node_id AS node_id`,
      { nodeId: sourceNodeId, rel: relationship },
    );
    return rows.map((r) => Number(r.node_id));
  }

  /**
   * Returns edge_ids of `relationship` edges leaving `sourceNodeId`.
   * The RelationshipInstance `edge_id` equals the value stored as
   * `edge_instance_id` on the INSTANCE_REL graph edge.
   */
  async function forwardEdgeIds(sourceNodeId: number, relationship: string): Promise<number[]> {
    const rows = await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId AND ri.relationship = $rel
       RETURN ri.edge_id AS edge_id`,
      { nodeId: sourceNodeId, rel: relationship },
    );
    return rows.map((r) => Number(r.edge_id));
  }

  /**
   * Fetches full node data for a set of node_ids, optionally filtered by concept.
   * Returns [] for an empty id set without hitting the DB.
   */
  async function fetchNodesByIds(ids: number[], concept?: string): Promise<ConceptInstanceData[]> {
    if (ids.length === 0) return [];
    const conceptClause = concept ? ` AND ci.concept = $concept` : '';
    const rows = await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance)
       WHERE ci.node_id IN $ids${conceptClause}
       RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
              ci.metamodel AS metamodel, ci.attributes AS attributes`,
      concept ? { ids, concept } : { ids },
    );
    return rows.map((row) => ({
      node_id: Number(row.node_id),
      namespace: String(row.namespace),
      concept: String(row.concept),
      metamodel: String(row.metamodel),
      attributes: JSON.parse(String(row.attributes || '{}')),
    }));
  }

  async function getContainmentRelationships(metamodel: string): Promise<string[]> {
    const rows = await dbModule.runQuery(
      `MATCH (r:RIA_META_Relationship)
       WHERE r.metamodel = $metamodel AND r.is_containment = true
       RETURN r.name AS name`,
      { metamodel },
    );
    return rows.map((row) => String(row.name));
  }

  async function resolvePropagationScope(
    structuralNodeId: number,
    structuralConcept: string,
    structuralMetamodel: string,
  ): Promise<{ rootNodeId: number; structuralNodeIds: number[] }> {
    let rootNodeId = structuralNodeId;
    const containmentRels = await getContainmentRelationships(structuralMetamodel);

    if (structuralConcept === 'p_port' || structuralConcept === 'r_port' || structuralConcept === 'pr_port') {
      if (containmentRels.length > 0) {
        const parentRows = await dbModule.runQuery(
          `MATCH (parent:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(child:RIA_UNIV_ConceptInstance {node_id: $nodeId})
           WHERE r.relationship IN $relationships
           RETURN parent.node_id AS node_id
           LIMIT 1`,
          { nodeId: structuralNodeId, relationships: containmentRels },
        );
        if (parentRows.length > 0) {
          rootNodeId = Number(parentRows[0].node_id);
        }
      }
    }

    const childRows = containmentRels.length > 0
      ? await dbModule.runQuery(
          `MATCH (ri:RIA_UNIV_RelationshipInstance)
           WHERE ri.source_node_id = $nodeId AND ri.relationship IN $relationships
           RETURN ri.target_node_id AS node_id`,
          { nodeId: rootNodeId, relationships: containmentRels },
        )
      : [];

    return {
      rootNodeId,
      structuralNodeIds: [...new Set([
        rootNodeId,
        ...childRows.map((row) => Number(row.node_id)),
      ])],
    };
  }

  /** Query review_item node_ids linked to an element via has_review. */
  async function queryReviewItemIds(elementNodeId: number): Promise<number[]> {
    const targetIds = await forwardTargetIds(elementNodeId, 'has_review');
    const items = await fetchNodesByIds(targetIds, 'review_item');
    return items.map((i) => i.node_id);
  }

  /** Delete all review_items attached to an element (best-effort). */
  async function cascadeDeleteReviewItems(elementNodeId: number): Promise<void> {
    const riIds = await queryReviewItemIds(elementNodeId);
    for (const riId of riIds) {
      try {
        await instanceService.deleteInstance(riId);
      } catch {
        // Review cascade errors are logged, not thrown (Req 9o-1.3)
      }
    }
  }

  /** Compute suspect flag for a review_item instance. */
  async function computeSuspect(reviewData: ConceptInstanceData): Promise<boolean> {
    const attrs = reviewData.attributes;
    // A review is only meaningful once the reviewer has given a verdict.
    // If no verdict has been recorded yet, it cannot be suspect.
    const hasVerdict = String(attrs.reviewer_verdict ?? '').length > 0;
    if (!hasVerdict) return false;
    const storedHash = String(attrs.reviewed_content_hash ?? '');
    // No hash stored yet → treat as suspect (hash should have been written with verdict).
    if (!storedHash) return true;
    // reviewed_element_id is stored as a stable UUID (not an ephemeral node_id).
    const elementUuid = String(attrs.reviewed_element_id ?? '');
    const elemResult = await instanceService.getInstanceByUuid(elementUuid);
    if (!elemResult.ok) return true;
    const currentHash = computeContentHash(elemResult.data.attributes);
    return currentHash !== storedHash;
  }

  return {
    // -----------------------------------------------------------------
    // Malfunction CRUD (Task 3.2)
    // -----------------------------------------------------------------
    async createMalfunction(
      params: CreateMalfunctionParams,
    ): Promise<Result<{ node_id: number }>> {
      const guard = await assertAuthoredNamespace(dbModule, params.namespace, 'malfunction');
      if (!guard.ok) return guard;

      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        has_name: params.name,
        malfunction_description: params.description,
      };
      if (params.asil !== undefined) {
        attributes.malfunction_asil = params.asil;
      }

      const createResult = await instanceService.createInstance(
        params.namespace,
        'malfunction',
        attributes,
      );
      if (!createResult.ok) return createResult;

      if (params.occursAtNodeId !== undefined) {
        // Resolve target namespace
        const tgtResult = await instanceService.getInstance(params.occursAtNodeId);
        if (!tgtResult.ok) {
          return {
            ok: false,
            error: `Cross-namespace relationship failed: ${tgtResult.error}. Malfunction created with node_id ${createResult.data.node_id}`,
          };
        }
        const crossResult = await instanceService.createCrossNsRelationship(
          createResult.data.node_id,
          params.occursAtNodeId,
          'occurs_at',
          await resolveAuthoredMetamodel(dbModule, params.namespace),
          params.namespace,
          tgtResult.data.namespace,
        );
        if (!crossResult.ok) {
          return {
            ok: false,
            error: `Cross-namespace relationship failed: ${crossResult.error}. Malfunction created with node_id ${createResult.data.node_id}`,
          };
        }
      }

      return createResult;
    },

    async getMalfunction(nodeId: number): Promise<Result<MalfunctionData>> {
      const fmResult = await assertConcept(instanceService, nodeId, 'malfunction');
      if (!fmResult.ok) return fmResult;

      const data: MalfunctionData = {
        ...fmResult.data,
        riskRating: null,
        occursAtTarget: null,
        propagationScope: null,
      };

      // Enrich with linked risk_rating.
      const rrIds = await forwardTargetIds(nodeId, 'has_risk_rating');
      const rrNodes = await fetchNodesByIds(rrIds, 'risk_rating');
      if (rrNodes.length > 0) {
        data.riskRating = rrNodes[0];
      }

      // Enrich with occurs_at target
      const oaRows = await dbModule.runQuery(
        `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         WHERE fm.node_id = $nodeId AND r.relationship = 'occurs_at'
         RETURN tgt.node_id AS node_id, tgt.namespace AS namespace, tgt.concept AS concept, tgt.metamodel AS metamodel, tgt.attributes AS attributes`,
        { nodeId },
      );
      if (oaRows.length > 0) {
        let targetName: string | undefined;
        try {
          const tgtAttrs = JSON.parse(String(oaRows[0].attributes || '{}'));
          targetName = String(tgtAttrs.short_name || tgtAttrs.has_name || tgtAttrs.name || '') || undefined;
        } catch { /* ignore parse errors */ }
        data.occursAtTarget = {
          node_id: Number(oaRows[0].node_id),
          namespace: String(oaRows[0].namespace),
          concept: String(oaRows[0].concept),
          name: targetName,
        };
        data.propagationScope = await resolvePropagationScope(
          Number(oaRows[0].node_id),
          String(oaRows[0].concept),
          String(oaRows[0].metamodel),
        );
      }

      return { ok: true, data };
    },

    async getMalfunctions(namespace: string): Promise<Result<ConceptInstanceData[]>> {
      return instanceService.getInstances(namespace, 'malfunction');
    },

    async updateMalfunction(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'malfunction');
      if (!check.ok) return check;
      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteMalfunction(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'malfunction');
      if (!check.ok) return check;

      // Find owned risk_ratings → delete their review_items → delete risk_ratings.
      const rrIds = await forwardTargetIds(nodeId, 'has_risk_rating');
      const ownedRiskRatings = await fetchNodesByIds(rrIds, 'risk_rating');
      for (const rr of ownedRiskRatings) {
        const rrId = rr.node_id;
        await cascadeDeleteReviewItems(rrId);
        await instanceService.deleteInstance(rrId);
      }

      // Delete malfunction's own review_items
      await cascadeDeleteReviewItems(nodeId);

      // Delete the malfunction itself (InstanceService cascades remaining edges)
      return instanceService.deleteInstance(nodeId);
    },

    // -----------------------------------------------------------------
    // occurs_at management (Task 3.3)
    // -----------------------------------------------------------------
    async attachOccursAt(
      failureModeNodeId: number,
      targetNodeId: number,
    ): Promise<Result<{ edge_id: number }>> {
      const fmCheck = await assertConcept(instanceService, failureModeNodeId, 'malfunction');
      if (!fmCheck.ok) return fmCheck;

      const tgtResult = await instanceService.getInstance(targetNodeId);
      if (!tgtResult.ok) return tgtResult;

      return instanceService.createCrossNsRelationship(
        failureModeNodeId,
        targetNodeId,
        'occurs_at',
        await resolveAuthoredMetamodel(dbModule, fmCheck.data.namespace),
        fmCheck.data.namespace,
        tgtResult.data.namespace,
      );
    },

    async detachOccursAt(
      failureModeNodeId: number,
      targetNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
         WHERE cri.source_node_id = $srcId AND cri.target_node_id = $tgtId AND cri.relationship = 'occurs_at'
         RETURN cri.edge_id AS edge_id`,
        { srcId: failureModeNodeId, tgtId: targetNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No occurs_at edge found between ${failureModeNodeId} and ${targetNodeId}`,
        };
      }
      return instanceService.deleteCrossNsRelationship(Number(rows[0].edge_id));
    },

    async moveOccursAt(
      failureModeNodeId: number,
      oldTargetNodeId: number,
      newTargetNodeId: number,
    ): Promise<Result<void>> {
      const detachResult = await this.detachOccursAt(failureModeNodeId, oldTargetNodeId);
      if (!detachResult.ok) return detachResult;
      const attachResult = await this.attachOccursAt(failureModeNodeId, newTargetNodeId);
      if (!attachResult.ok) return attachResult;
      return { ok: true, data: undefined };
    },

    // -----------------------------------------------------------------
    // Malfunction propagation management (Req 7d)
    // -----------------------------------------------------------------
    async addPropagation(
      sourceFailureModeNodeId: number,
      targetFailureModeNodeId: number,
    ): Promise<Result<{ edge_id: number }>> {
      const srcCheck = await assertConcept(instanceService, sourceFailureModeNodeId, 'malfunction');
      if (!srcCheck.ok) return srcCheck;
      const tgtCheck = await assertConcept(instanceService, targetFailureModeNodeId, 'malfunction');
      if (!tgtCheck.ok) return tgtCheck;

      return instanceService.createRelationship(
        sourceFailureModeNodeId,
        targetFailureModeNodeId,
        'propagates_to',
      );
    },

    async removePropagation(
      sourceFailureModeNodeId: number,
      targetFailureModeNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId AND ri.relationship = 'propagates_to'
         RETURN ri.edge_id AS edge_id`,
        { srcId: sourceFailureModeNodeId, tgtId: targetFailureModeNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No propagates_to edge found between ${sourceFailureModeNodeId} and ${targetFailureModeNodeId}`,
        };
      }
      return instanceService.deleteRelationship(Number(rows[0].edge_id));
    },

    async getPropagations(
      failureModeNodeId: number,
    ): Promise<Result<{ propagatesTo: PropagationMalfunctionData[]; propagatesFrom: PropagationMalfunctionData[] }>> {
      const check = await assertConcept(instanceService, failureModeNodeId, 'malfunction');
      if (!check.ok) return check;

      /** Extract a display name from a raw attributes JSON string. */
      function extractName(rawAttributes: unknown): string | undefined {
        if (!rawAttributes) return undefined;
        try {
          const attrs = typeof rawAttributes === 'string' ? JSON.parse(rawAttributes) : rawAttributes;
          return String(attrs.short_name || attrs.has_name || attrs.name || '') || undefined;
        } catch {
          return undefined;
        }
      }

      // Outgoing: this FM propagates to...
      const outIdRows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $nodeId AND ri.relationship = 'propagates_to'
         RETURN ri.target_node_id AS node_id`,
        { nodeId: failureModeNodeId },
      );
      const outTargetIds = outIdRows.map(r => Number(r.node_id));

      const outRows = outTargetIds.length > 0
        ? await dbModule.runQuery(
            `MATCH (tgt:RIA_UNIV_ConceptInstance)
             WHERE tgt.node_id IN $nodeIds AND tgt.concept = 'malfunction'
             OPTIONAL MATCH (tgt)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(oaTgt:RIA_UNIV_ConceptInstance)
               WHERE oa.relationship = 'occurs_at'
             RETURN tgt.node_id AS node_id, tgt.namespace AS namespace, tgt.concept AS concept,
                    tgt.metamodel AS metamodel, tgt.attributes AS attributes,
                    oaTgt.node_id AS oa_node_id, oaTgt.namespace AS oa_namespace, oaTgt.concept AS oa_concept,
                    oaTgt.attributes AS oa_attributes`,
            { nodeIds: outTargetIds },
          )
        : [];
      const propagatesTo: PropagationMalfunctionData[] = outRows.map((row) => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
        occursAtTarget: row.oa_node_id != null
          ? {
              node_id: Number(row.oa_node_id),
              namespace: String(row.oa_namespace),
              concept: String(row.oa_concept),
              name: extractName(row.oa_attributes),
            }
          : null,
      }));

      // Incoming: ...propagates to this FM
      const inRows = await dbModule.runQuery(
        `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
         WHERE tgt.node_id = $nodeId AND r.relationship = 'propagates_to' AND src.concept = 'malfunction'
         OPTIONAL MATCH (src)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(oaTgt:RIA_UNIV_ConceptInstance)
           WHERE oa.relationship = 'occurs_at'
         RETURN src.node_id AS node_id, src.namespace AS namespace, src.concept AS concept,
                src.metamodel AS metamodel, src.attributes AS attributes,
                oaTgt.node_id AS oa_node_id, oaTgt.namespace AS oa_namespace, oaTgt.concept AS oa_concept,
                oaTgt.attributes AS oa_attributes`,
        { nodeId: failureModeNodeId },
      );
      const propagatesFrom: PropagationMalfunctionData[] = inRows.map((row) => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
        occursAtTarget: row.oa_node_id != null
          ? {
              node_id: Number(row.oa_node_id),
              namespace: String(row.oa_namespace),
              concept: String(row.oa_concept),
              name: extractName(row.oa_attributes),
            }
          : null,
      }));

      return { ok: true, data: { propagatesTo, propagatesFrom } };
    },

    // -----------------------------------------------------------------
    // Risk Rating CRUD (Task 3.4)
    // -----------------------------------------------------------------
    async createRiskRating(
      params: CreateRiskRatingParams,
    ): Promise<Result<{ node_id: number }>> {
      const fmCheck = await assertConcept(instanceService, params.failureModeNodeId, 'malfunction');
      if (!fmCheck.ok) return fmCheck;

      const guard = await assertAuthoredNamespace(dbModule, fmCheck.data.namespace, 'risk_rating');
      if (!guard.ok) return guard;

      const rpn = computeRPN(params.severity, params.occurrence, params.detection);
      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        has_name: `Risk Rating`,
        has_severity: params.severity,
        has_occurrence_level: params.occurrence,
        has_detection_level: params.detection,
        risk_priority_number: String(rpn),
        risk_rating_note: params.note ?? '',
      };

      const createResult = await instanceService.createInstance(
        fmCheck.data.namespace,
        'risk_rating',
        attributes,
      );
      if (!createResult.ok) return createResult;

      const relResult = await instanceService.createRelationship(
        params.failureModeNodeId,
        createResult.data.node_id,
        'has_risk_rating',
      );
      if (!relResult.ok) return relResult;

      return createResult;
    },

    async getRiskRating(
      failureModeNodeId: number,
    ): Promise<Result<ConceptInstanceData | null>> {
      const fmCheck = await assertConcept(instanceService, failureModeNodeId, 'malfunction');
      if (!fmCheck.ok) return fmCheck;

      // Resolve the risk_rating via RelationshipInstance, then fetch by id.
      const rrIds = await forwardTargetIds(failureModeNodeId, 'has_risk_rating');
      const rrNodes = await fetchNodesByIds(rrIds, 'risk_rating');
      if (rrNodes.length === 0) {
        return { ok: true, data: null };
      }
      return { ok: true, data: rrNodes[0] };
    },

    async updateRiskRating(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'risk_rating');
      if (!check.ok) return check;

      // Merge updates to determine if RPN needs recomputation
      const merged = { ...check.data.attributes, ...updates };
      const severity = String(merged.has_severity ?? '');
      const occurrence = String(merged.has_occurrence_level ?? '');
      const detection = String(merged.has_detection_level ?? '');

      if (
        updates.has_severity !== undefined ||
        updates.has_occurrence_level !== undefined ||
        updates.has_detection_level !== undefined
      ) {
        updates.risk_priority_number = String(computeRPN(severity, occurrence, detection));
      }

      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteRiskRating(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'risk_rating');
      if (!check.ok) return check;
      await cascadeDeleteReviewItems(nodeId);
      return instanceService.deleteInstance(nodeId);
    },

    // -----------------------------------------------------------------
    // Safety Task CRUD (Task 3.5)
    // -----------------------------------------------------------------
    async createSafetyTask(
      namespace: string,
      name: string,
      description: string,
      status: string,
      type: string,
      responsible?: string,
      reference?: string,
    ): Promise<Result<{ node_id: number }>> {
      const guard = await assertAuthoredNamespace(dbModule, namespace, 'safety_task');
      if (!guard.ok) return guard;

      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        has_name: name,
        task_description: description,
        task_status: status,
        task_type: type,
        task_responsible: responsible ?? '',
        task_reference: reference ?? '',
      };

      return instanceService.createInstance(namespace, 'safety_task', attributes);
    },

    async linkSafetyTaskToFm(
      failureModeNodeId: number,
      safetyTaskNodeId: number,
    ): Promise<Result<{ edge_id: number }>> {
      const fmCheck = await assertConcept(instanceService, failureModeNodeId, 'malfunction');
      if (!fmCheck.ok) return fmCheck;
      const taskCheck = await assertConcept(instanceService, safetyTaskNodeId, 'safety_task');
      if (!taskCheck.ok) return taskCheck;

      return instanceService.createRelationship(
        failureModeNodeId,
        safetyTaskNodeId,
        'has_safety_tasks',
      );
    },

    async unlinkSafetyTaskFromFm(
      failureModeNodeId: number,
      safetyTaskNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId AND ri.relationship = 'has_safety_tasks'
         RETURN ri.edge_id AS edge_id`,
        { srcId: failureModeNodeId, tgtId: safetyTaskNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No has_safety_tasks edge found between ${failureModeNodeId} and ${safetyTaskNodeId}`,
        };
      }
      return instanceService.deleteRelationship(Number(rows[0].edge_id));
    },

    async getSafetyTasks(
      failureModeNodeId: number,
    ): Promise<Result<ConceptInstanceData[]>> {
      // Resolve linked safety_tasks via RelationshipInstance, then fetch by id.
      const taskIds = await forwardTargetIds(failureModeNodeId, 'has_safety_tasks');
      const tasks = await fetchNodesByIds(taskIds, 'safety_task');
      return { ok: true, data: tasks };
    },

    async getAllSafetyTasks(namespace: string): Promise<Result<ConceptInstanceData[]>> {
      return instanceService.getInstances(namespace, 'safety_task');
    },

    async updateSafetyTask(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'safety_task');
      if (!check.ok) return check;
      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteSafetyTask(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'safety_task');
      if (!check.ok) return check;
      await cascadeDeleteReviewItems(nodeId);
      return instanceService.deleteInstance(nodeId);
    },

    // -----------------------------------------------------------------
    // Requirement CRUD (Task 3.6)
    // -----------------------------------------------------------------
    async createRequirement(
      namespace: string,
      name: string,
      reqId: string,
      reqText: string,
      asil?: string,
      linkedToUrl?: string,
    ): Promise<Result<{ node_id: number }>> {
      const guard = await assertAuthoredNamespace(dbModule, namespace, 'requirement');
      if (!guard.ok) return guard;

      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        req_name: name,
        req_id: reqId,
        req_text: reqText,
      };
      if (asil !== undefined) attributes.req_asil = asil;
      if (linkedToUrl !== undefined) attributes.req_linked_to = linkedToUrl;

      return instanceService.createInstance(namespace, 'requirement', attributes);
    },

    async getRequirement(nodeId: number): Promise<Result<ConceptInstanceData>> {
      return assertConcept(instanceService, nodeId, 'requirement');
    },

    async getRequirements(namespace: string): Promise<Result<ConceptInstanceData[]>> {
      return instanceService.getInstances(namespace, 'requirement');
    },

    async unlinkRequirementFromFm(
      failureModeNodeId: number,
      requirementNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId AND ri.relationship = 'has_safety_requirements'
         RETURN ri.edge_id AS edge_id`,
        { srcId: failureModeNodeId, tgtId: requirementNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No has_safety_requirements edge found between ${failureModeNodeId} and ${requirementNodeId}`,
        };
      }
      return instanceService.deleteRelationship(Number(rows[0].edge_id));
    },

    // -----------------------------------------------------------------
    // Direct (cross-namespace) requirement linking
    // -----------------------------------------------------------------

    async linkDirectRequirementToFm(
      failureModeNodeId: number,
      requirementNodeId: number,
    ): Promise<Result<{ edge_id: number }>> {
      const fmCheck = await assertConcept(instanceService, failureModeNodeId, 'malfunction');
      if (!fmCheck.ok) return fmCheck;

      const reqResult = await instanceService.getInstance(requirementNodeId);
      if (!reqResult.ok) return reqResult;

      return instanceService.createCrossNsRelationship(
        failureModeNodeId,
        requirementNodeId,
        'has_direct_requirements',
        await resolveAuthoredMetamodel(dbModule, fmCheck.data.namespace),
        fmCheck.data.namespace,
        reqResult.data.namespace,
      );
    },

    async unlinkDirectRequirementFromFm(
      failureModeNodeId: number,
      requirementNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
         WHERE cri.source_node_id = $srcId AND cri.target_node_id = $tgtId AND cri.relationship = 'has_direct_requirements'
         RETURN cri.edge_id AS edge_id`,
        { srcId: failureModeNodeId, tgtId: requirementNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No has_direct_requirements edge found between ${failureModeNodeId} and ${requirementNodeId}`,
        };
      }
      return instanceService.deleteCrossNsRelationship(Number(rows[0].edge_id));
    },

    async getDirectRequirementsForFm(
      failureModeNodeId: number,
    ): Promise<Result<ConceptInstanceData[]>> {
      const rows = await dbModule.runQuery(
        `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req:RIA_UNIV_ConceptInstance)
         WHERE fm.node_id = $nodeId AND r.relationship = 'has_direct_requirements'
         RETURN req.node_id AS node_id, req.namespace AS namespace, req.concept AS concept,
                req.metamodel AS metamodel, req.attributes AS attributes`,
        { nodeId: failureModeNodeId },
      );
      return {
        ok: true,
        data: rows.map(row => ({
          node_id: Number(row.node_id),
          namespace: String(row.namespace),
          concept: String(row.concept),
          metamodel: String(row.metamodel),
          attributes: JSON.parse(String(row.attributes || '{}')),
        })),
      };
    },

    async searchRequirementsAcrossNamespaces(
      query: string,
    ): Promise<Result<ConceptInstanceData[]>> {
      const lower = query.trim().toLowerCase();

      // When a search term is provided, filter inside Cypher so we don't miss
      // results that fall outside an arbitrary LIMIT applied before filtering.
      const cypher = lower
        ? `MATCH (req:RIA_UNIV_ConceptInstance)
           WHERE (req.concept IN ['RequirementUsage', 'RequirementDefinition']
              OR (req.concept STARTS WITH 'need_' AND req.concept <> 'need_document'))
             AND toLower(req.attributes) CONTAINS $search
           RETURN req.node_id AS node_id, req.namespace AS namespace, req.concept AS concept,
                  req.metamodel AS metamodel, req.attributes AS attributes
           LIMIT 50`
        : `MATCH (req:RIA_UNIV_ConceptInstance)
           WHERE req.concept IN ['RequirementUsage', 'RequirementDefinition']
              OR (req.concept STARTS WITH 'need_' AND req.concept <> 'need_document')
           RETURN req.node_id AS node_id, req.namespace AS namespace, req.concept AS concept,
                  req.metamodel AS metamodel, req.attributes AS attributes
           LIMIT 500`;

      const rows = await dbModule.runQuery(cypher, lower ? { search: lower } : {});

      const all: ConceptInstanceData[] = rows.map(row => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
      }));

      // For the no-query case we already limited in Cypher; for the query case
      // the Cypher CONTAINS on the raw JSON attribute string is a broad match,
      // so refine client-side against the specific attribute fields.
      const filtered = lower
        ? all.filter(r => {
            const attrs = r.attributes as Record<string, unknown>;
            const searchable = [
              attrs.id, attrs.elementId, attrs.title, attrs.name, attrs.has_name, attrs.req_id,
              attrs.type, attrs.type_name,
            ].filter(Boolean).join(' ').toLowerCase();
            return searchable.includes(lower);
          })
        : all;

      return { ok: true, data: filtered.slice(0, 50) };
    },

    async updateRequirement(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'requirement');
      if (!check.ok) return check;
      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteRequirement(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'requirement');
      if (!check.ok) return check;
      await cascadeDeleteReviewItems(nodeId);
      return instanceService.deleteInstance(nodeId);
    },

    // -----------------------------------------------------------------
    // Safety Note CRUD (Task 3.7)
    // -----------------------------------------------------------------
    async createSafetyNote(
      namespace: string,
      noteText: string,
      targetNodeId: number,
    ): Promise<Result<{ node_id: number }>> {
      const guard = await assertAuthoredNamespace(dbModule, namespace, 'safety_note');
      if (!guard.ok) return guard;

      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        note_text: noteText,
      };

      const createResult = await instanceService.createInstance(namespace, 'safety_note', attributes);
      if (!createResult.ok) return createResult;

      // Create a has_notes edge from the parent element to this note —
      // same pattern as has_review / has_safety_tasks (tag pattern: no parent ID in attributes).
      //   Same namespace  → RIA_UNIV_INSTANCE_REL     (element → note)
      //   Cross-namespace → RIA_UNIV_CROSSNS_INSTANCE_REL (element → note)
      const tgtResult = await instanceService.getInstance(targetNodeId);
      if (tgtResult.ok) {
        if (tgtResult.data.namespace !== namespace) {
          const crossResult = await instanceService.createCrossNsRelationship(
            targetNodeId,
            createResult.data.node_id,
            'has_notes',
            await resolveAuthoredMetamodel(dbModule, namespace),
            tgtResult.data.namespace,
            namespace,
          );
          if (!crossResult.ok) {
            return {
              ok: false,
              error: `Cross-namespace has_notes edge failed: ${crossResult.error}. Safety note created with node_id ${createResult.data.node_id}`,
            };
          }
        } else {
          const relResult = await instanceService.createRelationship(
            targetNodeId,
            createResult.data.node_id,
            'has_notes',
          );
          if (!relResult.ok) {
            return {
              ok: false,
              error: `has_notes edge failed: ${relResult.error}. Safety note created with node_id ${createResult.data.node_id}`,
            };
          }
        }
      }

      return createResult;
    },

    async getNoteParent(noteNodeId: number): Promise<Result<ConceptInstanceData | null>> {
      // Traverse has_notes edge backwards to find the parent element.
      const intraRows = await dbModule.runQuery(
        `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(note:RIA_UNIV_ConceptInstance)
         WHERE note.node_id = $noteNodeId AND r.relationship = 'has_notes'
         RETURN elem.node_id AS node_id, elem.namespace AS namespace, elem.concept AS concept,
                elem.metamodel AS metamodel, elem.attributes AS attributes`,
        { noteNodeId },
      );
      if (intraRows.length > 0) {
        const row = intraRows[0];
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
      }
      const crossRows = await dbModule.runQuery(
        `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(note:RIA_UNIV_ConceptInstance)
         WHERE note.node_id = $noteNodeId AND r.relationship = 'has_notes'
         RETURN elem.node_id AS node_id, elem.namespace AS namespace, elem.concept AS concept,
                elem.metamodel AS metamodel, elem.attributes AS attributes`,
        { noteNodeId },
      );
      if (crossRows.length > 0) {
        const row = crossRows[0];
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
      }
      return { ok: true, data: null };
    },

    async getSafetyNote(nodeId: number): Promise<Result<ConceptInstanceData>> {
      return assertConcept(instanceService, nodeId, 'safety_note');
    },

    async getSafetyNotes(namespace: string): Promise<Result<ConceptInstanceData[]>> {
      return instanceService.getInstances(namespace, 'safety_note');
    },

    async updateSafetyNote(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'safety_note');
      if (!check.ok) return check;
      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteSafetyNote(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'safety_note');
      if (!check.ok) return check;
      await cascadeDeleteReviewItems(nodeId);
      return instanceService.deleteInstance(nodeId);
    },

    // -----------------------------------------------------------------
    // Review Item CRUD (Task 4.1)
    // -----------------------------------------------------------------
    async createReviewItem(
      namespace: string,
      reviewerComment: string,
      reviewedElementId: number,
      name?: string,
    ): Promise<Result<{ node_id: number }>> {
      const guard = await assertAuthoredNamespace(dbModule, namespace, 'review_item');
      if (!guard.ok) return guard;

      // Verify reviewed element exists
      const elemResult = await instanceService.getInstance(reviewedElementId);
      if (!elemResult.ok) {
        return {
          ok: false,
          error: `Reviewed element with node_id ${reviewedElementId} not found in namespace`,
        };
      }

      // Auto-generate name from reviewed element if not provided
      const reviewName = name ?? `Review: ${String(elemResult.data.attributes.has_name ?? elemResult.data.attributes.req_name ?? '')}`;

      // Store the stable UUID of the reviewed element, not its ephemeral node_id.
      // node_ids are reassigned on every re-import; the UUID is stable across
      // persistor store/load cycles and is the correct durable reference.
      const reviewedElementUuid = String(elemResult.data.attributes.uuid ?? '');
      if (!reviewedElementUuid) {
        return {
          ok: false,
          error: `Reviewed element with node_id ${reviewedElementId} has no uuid — cannot create review item`,
        };
      }

      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        has_name: reviewName,
        reviewer_comment: reviewerComment,
        review_status: 'open',
        author_comment: '',
        reviewed_element_id: reviewedElementUuid,
        reviewed_content_hash: '',
      };

      const createResult = await instanceService.createInstance(
        namespace,
        'review_item',
        attributes,
      );
      if (!createResult.ok) return createResult;

      // Create has_review relationship: reviewed element → review_item
      const relResult = await instanceService.createRelationship(
        reviewedElementId,
        createResult.data.node_id,
        'has_review',
      );
      if (!relResult.ok) return relResult;

      return createResult;
    },

    async getReviewItem(nodeId: number): Promise<Result<ReviewItemData>> {
      const check = await assertConcept(instanceService, nodeId, 'review_item');
      if (!check.ok) return check;

      const suspect = await computeSuspect(check.data);
      return {
        ok: true,
        data: { ...check.data, suspect },
      };
    },

    async getReviewItems(
      reviewedElementNodeId: number,
    ): Promise<Result<ReviewItemData[]>> {
      // Resolve review_items via RelationshipInstance, then fetch by id.
      const riIds = await forwardTargetIds(reviewedElementNodeId, 'has_review');
      const rows = await fetchNodesByIds(riIds, 'review_item');

      const items: ReviewItemData[] = [];
      for (const data of rows) {
        const suspect = await computeSuspect(data);
        items.push({ ...data, suspect });
      }
      return { ok: true, data: items };
    },

    async getAllReviewItems(namespace: string): Promise<Result<ConceptInstanceData[]>> {
      return instanceService.getInstances(namespace, 'review_item');
    },

    async updateReviewItem(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'review_item');
      if (!check.ok) return check;

      const merged = { ...check.data.attributes, ...updates };

      // Determine whether this update should write or clear the content hash.
      //
      // Hash is WRITTEN when:
      //   - The reviewer sets a verdict (OK / NOK / OK_with_comment) — records
      //     what was reviewed at the moment the verdict was given.
      //   - The author sets author_status to 'resolved' — records what the
      //     element looked like when the author acknowledged the finding.
      //
      // Hash is CLEARED when the author reopens the review (open / in_analysis),
      // meaning the previous verdict snapshot is no longer valid.
      //
      // Note: the legacy `review_status` field is not used for this decision —
      // the UI drives the workflow via `reviewer_verdict` and `author_status`.

      const verdictChanged = 'reviewer_verdict' in updates;
      const newVerdict = String(merged.reviewer_verdict ?? '');
      const authorStatusChanged = 'author_status' in updates;
      const newAuthorStatus = String(merged.author_status ?? '');

      const shouldWriteHash =
        (verdictChanged && newVerdict.length > 0) ||
        (authorStatusChanged && newAuthorStatus === 'resolved');

      const shouldClearHash =
        authorStatusChanged &&
        (newAuthorStatus === 'open' || newAuthorStatus === 'in_analysis');

      if (shouldWriteHash) {
        const elementUuid = String(merged.reviewed_element_id ?? '');
        const elemResult = await instanceService.getInstanceByUuid(elementUuid);
        if (elemResult.ok) {
          updates.reviewed_content_hash = computeContentHash(elemResult.data.attributes);
        }
      } else if (shouldClearHash) {
        updates.reviewed_content_hash = '';
      }

      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteReviewItem(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'review_item');
      if (!check.ok) return check;
      return instanceService.deleteInstance(nodeId);
    },

    async isReviewSuspect(
      reviewItemNodeId: number,
    ): Promise<Result<{ suspect: boolean }>> {
      const check = await assertConcept(instanceService, reviewItemNodeId, 'review_item');
      if (!check.ok) return check;

      const suspect = await computeSuspect(check.data);
      return { ok: true, data: { suspect } };
    },

    // -----------------------------------------------------------------
    // Bulk Review Operations (Task 4.2)
    // -----------------------------------------------------------------
    async createBulkReview(
      namespace: string,
      elementNodeIds: number[],
      reviewerComment: string,
      name?: string,
    ): Promise<Result<{ elementNodeId: number; reviewItemNodeId: number }[]>> {
      // Validate all elements exist upfront
      const invalidIds: number[] = [];
      for (const elemId of elementNodeIds) {
        const result = await instanceService.getInstance(elemId);
        if (!result.ok) invalidIds.push(elemId);
      }
      if (invalidIds.length > 0) {
        return { ok: false, error: `Invalid element node_ids: ${invalidIds.join(', ')}` };
      }

      // Create one review_item per element
      const results: { elementNodeId: number; reviewItemNodeId: number }[] = [];
      for (const elemId of elementNodeIds) {
        const createResult = await this.createReviewItem(namespace, reviewerComment, elemId, name);
        if (!createResult.ok) return createResult;
        results.push({ elementNodeId: elemId, reviewItemNodeId: createResult.data.node_id });
      }

      return { ok: true, data: results };
    },

    async bulkResolveReviews(
      reviewItemNodeIds: number[],
      authorComment?: string,
    ): Promise<Result<{ resolvedCount: number }>> {
      // Validate all are review_items upfront
      const invalidIds: number[] = [];
      for (const riId of reviewItemNodeIds) {
        const check = await assertConcept(instanceService, riId, 'review_item');
        if (!check.ok) invalidIds.push(riId);
      }
      if (invalidIds.length > 0) {
        return { ok: false, error: `Invalid review_item node_ids: ${invalidIds.join(', ')}` };
      }

      // Resolve each
      let resolvedCount = 0;
      for (const riId of reviewItemNodeIds) {
        const updates: Record<string, unknown> = {
          review_status: 'resolved',
          author_comment: authorComment ?? '',
        };
        const result = await this.updateReviewItem(riId, updates);
        if (result.ok) resolvedCount++;
      }

      return { ok: true, data: { resolvedCount } };
    },

    // -----------------------------------------------------------------
    // Tag CRUD (Task 2.2)
    // -----------------------------------------------------------------
    async createTag(
      params: CreateTagParams,
    ): Promise<Result<{ node_id: number }>> {
      const guard = await assertAuthoredNamespace(dbModule, params.namespace, 'tag');
      if (!guard.ok) return guard;

      const attributes: Record<string, unknown> = {
        uuid: crypto.randomUUID(),
        has_name: params.name,
      };
      if (params.description !== undefined) {
        attributes.tag_description = params.description;
      }
      if (params.color !== undefined) {
        attributes.tag_color = params.color;
      }

      return instanceService.createInstance(params.namespace, 'tag', attributes);
    },

    async getTag(nodeId: number): Promise<Result<ConceptInstanceData>> {
      return assertConcept(instanceService, nodeId, 'tag');
    },

    async getAllTags(namespace: string): Promise<Result<ConceptInstanceData[]>> {
      return instanceService.getInstances(namespace, 'tag');
    },

    async updateTag(
      nodeId: number,
      updates: Record<string, unknown>,
    ): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'tag');
      if (!check.ok) return check;
      return instanceService.updateInstance(nodeId, updates);
    },

    async deleteTag(nodeId: number): Promise<Result<void>> {
      const check = await assertConcept(instanceService, nodeId, 'tag');
      if (!check.ok) return check;

      // 1. Query and delete all intra-NS has_tag edges (elements → this tag)
      const intraRows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.target_node_id = $nodeId AND ri.relationship = 'has_tag'
         RETURN ri.edge_id AS edge_id`,
        { nodeId },
      );
      for (const row of intraRows) {
        await instanceService.deleteRelationship(Number(row.edge_id));
      }

      // 2. Query and delete all cross-NS has_tag edges (imported elements → this tag)
      const crossRows = await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
         WHERE cri.target_node_id = $nodeId AND cri.relationship = 'has_tag'
         RETURN cri.edge_id AS edge_id`,
        { nodeId },
      );
      for (const row of crossRows) {
        await instanceService.deleteCrossNsRelationship(Number(row.edge_id));
      }

      // 3. Cascade delete review items attached to the tag
      await cascadeDeleteReviewItems(nodeId);

      // 4. Delete the tag node itself
      return instanceService.deleteInstance(nodeId);
    },

    // -----------------------------------------------------------------
    // Intra-namespace tag linking (Task 2.4)
    // -----------------------------------------------------------------
    async linkTag(
      elementNodeId: number,
      tagNodeId: number,
    ): Promise<Result<{ edge_id: number }>> {
      // 1. Validate element exists
      const elemResult = await instanceService.getInstance(elementNodeId);
      if (!elemResult.ok) return elemResult;

      // 2. Validate tag exists and is a 'tag' concept
      const tagCheck = await assertConcept(instanceService, tagNodeId, 'tag');
      if (!tagCheck.ok) return tagCheck;

      // 3. Validate both are in the same namespace
      if (elemResult.data.namespace !== tagCheck.data.namespace) {
        return {
          ok: false,
          error: 'Source and target instances must be in the same namespace',
        };
      }

      // 4. Check for duplicate has_tag edge
      const dupRows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId AND ri.relationship = 'has_tag'
         RETURN ri.edge_id AS edge_id`,
        { srcId: elementNodeId, tgtId: tagNodeId },
      );
      if (dupRows.length > 0) {
        return {
          ok: false,
          error: 'Tag link already exists',
        };
      }

      // 5. Create the has_tag relationship
      return instanceService.createRelationship(elementNodeId, tagNodeId, 'has_tag');
    },

    async unlinkTag(
      elementNodeId: number,
      tagNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (ri:RIA_UNIV_RelationshipInstance)
         WHERE ri.source_node_id = $srcId AND ri.target_node_id = $tgtId AND ri.relationship = 'has_tag'
         RETURN ri.edge_id AS edge_id`,
        { srcId: elementNodeId, tgtId: tagNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No has_tag edge found between ${elementNodeId} and ${tagNodeId}`,
        };
      }
      return instanceService.deleteRelationship(Number(rows[0].edge_id));
    },

    async getTagsForElement(
      elementNodeId: number,
    ): Promise<Result<ConceptInstanceData[]>> {
      // Resolve linked tags via RelationshipInstance, then fetch by id.
      const tagIds = await forwardTargetIds(elementNodeId, 'has_tag');
      const tags = await fetchNodesByIds(tagIds, 'tag');
      return { ok: true, data: tags };
    },

    async getElementsForTag(
      tagNodeId: number,
    ): Promise<Result<ConceptInstanceData[]>> {
      // Intra-NS: elements that link to this tag within the same namespace
      const intraRows = await dbModule.runQuery(
        `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tag:RIA_UNIV_ConceptInstance)
         WHERE tag.node_id = $nodeId AND r.relationship = 'has_tag'
         RETURN elem.node_id AS node_id, elem.namespace AS namespace, elem.concept AS concept,
                elem.metamodel AS metamodel, elem.attributes AS attributes`,
        { nodeId: tagNodeId },
      );

      // Cross-NS: imported elements that point to this tag (imported element → tag)
      const crossRows = await dbModule.runQuery(
        `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tag:RIA_UNIV_ConceptInstance)
         WHERE tag.node_id = $nodeId AND r.relationship = 'has_tag'
         RETURN elem.node_id AS node_id, elem.namespace AS namespace, elem.concept AS concept,
                elem.metamodel AS metamodel, elem.attributes AS attributes`,
        { nodeId: tagNodeId },
      );

      const allRows = [...intraRows, ...crossRows];
      const elements: ConceptInstanceData[] = allRows.map((row) => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
      }));
      return { ok: true, data: elements };
    },

    // -----------------------------------------------------------------
    // Cross-namespace tag linking (Task 2.5)
    // -----------------------------------------------------------------
    async linkTagCrossNs(
      tagNodeId: number,
      importedElementNodeId: number,
    ): Promise<Result<{ edge_id: number }>> {
      // 1. Validate tag exists and is a 'tag' concept
      const tagCheck = await assertConcept(instanceService, tagNodeId, 'tag');
      if (!tagCheck.ok) return tagCheck;

      // 2. Validate imported element exists
      const tgtResult = await instanceService.getInstance(importedElementNodeId);
      if (!tgtResult.ok) return tgtResult;

      // 3. Validate they are in different namespaces
      if (tagCheck.data.namespace === tgtResult.data.namespace) {
        return {
          ok: false,
          error: 'Tag and target must be in different namespaces for cross-namespace linking',
        };
      }

      // 4. Create cross-NS relationship: imported element → tag
      return instanceService.createCrossNsRelationship(
        importedElementNodeId,
        tagNodeId,
        'has_tag',
        await resolveAuthoredMetamodel(dbModule, tagCheck.data.namespace),
        tgtResult.data.namespace,
        tagCheck.data.namespace,
      );
    },

    async unlinkTagCrossNs(
      tagNodeId: number,
      importedElementNodeId: number,
    ): Promise<Result<void>> {
      const rows = await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
         WHERE cri.source_node_id = $srcId AND cri.target_node_id = $tgtId AND cri.relationship = 'has_tag'
         RETURN cri.edge_id AS edge_id`,
        { srcId: importedElementNodeId, tgtId: tagNodeId },
      );
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No cross-namespace has_tag edge found between ${importedElementNodeId} and ${tagNodeId}`,
        };
      }
      return instanceService.deleteCrossNsRelationship(Number(rows[0].edge_id));
    },

    async getTagsForImportedElement(
      importedElementNodeId: number,
    ): Promise<Result<ConceptInstanceData[]>> {
      const rows = await dbModule.runQuery(
        `MATCH (tgt:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tag:RIA_UNIV_ConceptInstance)
         WHERE tgt.node_id = $nodeId AND r.relationship = 'has_tag' AND tag.concept = 'tag'
         RETURN tag.node_id AS node_id, tag.namespace AS namespace, tag.concept AS concept,
                tag.metamodel AS metamodel, tag.attributes AS attributes`,
        { nodeId: importedElementNodeId },
      );
      const tags: ConceptInstanceData[] = rows.map((row) => ({
        node_id: Number(row.node_id),
        namespace: String(row.namespace),
        concept: String(row.concept),
        metamodel: String(row.metamodel),
        attributes: JSON.parse(String(row.attributes || '{}')),
      }));
      return { ok: true, data: tags };
    },

    // -----------------------------------------------------------------
    // Delete with Domain Semantics (Task 4.3)
    // -----------------------------------------------------------------
    async previewDeleteImpact(
      nodeId: number,
    ): Promise<Result<DeleteImpactPreview>> {
      const elemResult = await instanceService.getInstance(nodeId);
      if (!elemResult.ok) return elemResult;

      const concept = elemResult.data.concept;
      const attrs = elemResult.data.attributes;
      const elemName = String(attrs.has_name ?? attrs.req_name ?? '');

      const preview: DeleteImpactPreview = {
        element: { node_id: nodeId, concept, name: elemName },
        ownedChildren: [],
        reviewItems: [],
        relationships: [],
        totalElements: 1,
        totalRelationships: 0,
      };

      // Review items on this element
      const riIds = await queryReviewItemIds(nodeId);
      for (const riId of riIds) {
        const riResult = await instanceService.getInstance(riId);
        if (riResult.ok) {
          const riName = String(riResult.data.attributes.has_name ?? '');
          preview.reviewItems.push({ node_id: riId, name: riName });
        }
      }

      if (concept === 'malfunction') {
        // Owned risk_ratings — resolve via RelationshipInstance, fetch by id.
        const rrIds = await forwardTargetIds(nodeId, 'has_risk_rating');
        const ownedRiskRatings = await fetchNodesByIds(rrIds, 'risk_rating');
        for (const rr of ownedRiskRatings) {
          const rrId = rr.node_id;
          const rrName = String(rr.attributes.has_name ?? '');
          preview.ownedChildren.push({ node_id: rrId, concept: 'risk_rating', name: rrName });

          // Review items on the risk_rating
          const rrRiIds = await queryReviewItemIds(rrId);
          for (const rrRiId of rrRiIds) {
            const rrRiResult = await instanceService.getInstance(rrRiId);
            if (rrRiResult.ok) {
              preview.reviewItems.push({
                node_id: rrRiId,
                name: String(rrRiResult.data.attributes.has_name ?? ''),
              });
            }
          }
        }

        // occurs_at cross-NS edges
        const oaRows = await dbModule.runQuery(
          `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
           WHERE fm.node_id = $nodeId AND r.relationship = 'occurs_at'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of oaRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'occurs_at',
            type: 'cross',
          });
        }

        // has_safety_tasks edges from malfunctions to reusable safety_tasks.
        // Resolve edge_ids via RelationshipInstance (the edge_id equals the
        // INSTANCE_REL edge_instance_id).
        const ltEdgeIds = await forwardEdgeIds(nodeId, 'has_safety_tasks');
        for (const edgeId of ltEdgeIds) {
          preview.relationships.push({
            edge_id: edgeId,
            relationship: 'has_safety_tasks',
            type: 'intra',
          });
        }
      } else if (concept === 'risk_rating') {
        // has_risk_rating edge to parent
        const hrRows = await dbModule.runQuery(
          `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(rr:RIA_UNIV_ConceptInstance)
           WHERE rr.node_id = $nodeId AND r.relationship = 'has_risk_rating'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of hrRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'has_risk_rating',
            type: 'intra',
          });
        }
      } else if (concept === 'safety_task') {
        // has_safety_tasks edges from all referencing malfunctions
        const ltRows = await dbModule.runQuery(
          `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(st:RIA_UNIV_ConceptInstance)
           WHERE st.node_id = $nodeId AND r.relationship = 'has_safety_tasks'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of ltRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'has_safety_tasks',
            type: 'intra',
          });
        }
      } else if (concept === 'requirement') {
        // has_safety_requirements references from malfunctions
        const hsrRows = await dbModule.runQuery(
          `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(req:RIA_UNIV_ConceptInstance)
           WHERE req.node_id = $nodeId AND r.relationship = 'has_safety_requirements'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of hsrRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'has_safety_requirements',
            type: 'intra',
          });
        }
      } else if (concept === 'review_item') {
        // has_review edge
        const hrRows = await dbModule.runQuery(
          `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(ri:RIA_UNIV_ConceptInstance)
           WHERE ri.node_id = $nodeId AND r.relationship = 'has_review'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of hrRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'has_review',
            type: 'intra',
          });
        }
      } else if (concept === 'tag') {
        // Intra-NS has_tag edges (elements → this tag)
        const intraRows = await dbModule.runQuery(
          `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tag:RIA_UNIV_ConceptInstance)
           WHERE tag.node_id = $nodeId AND r.relationship = 'has_tag'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of intraRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'has_tag',
            type: 'intra',
          });
        }

        // Cross-NS has_tag edges (imported elements → this tag)
        const crossRows = await dbModule.runQuery(
          `MATCH (tgt:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tag:RIA_UNIV_ConceptInstance)
           WHERE tag.node_id = $nodeId AND r.relationship = 'has_tag'
           RETURN r.edge_instance_id AS edge_id`,
          { nodeId },
        );
        for (const row of crossRows) {
          preview.relationships.push({
            edge_id: Number(row.edge_id),
            relationship: 'has_tag',
            type: 'cross',
          });
        }
      }
      // safety_note: only review_items (already collected above)

      preview.totalElements = 1 + preview.ownedChildren.length + preview.reviewItems.length;
      preview.totalRelationships = preview.relationships.length;

      return { ok: true, data: preview };
    },
  };
}
