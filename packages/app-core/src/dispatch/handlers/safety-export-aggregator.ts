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
import type { ServiceDependencies } from '../types.js';
import type { ConceptInstanceData } from '../../namespaces/instance-service.js';
import type { RiskRatingData, MalfunctionExportData, RequirementExportData, SafetyTaskExportData, SafetyNoteExportData, ReviewExportData, ComponentExportData, SafetyExportData, PortExportData } from '@riacore/app-contracts';

// ── ID generation helpers ────────────────────────────────────────────────────

/**
 * Normalize a component name for use as a Sphinx-Needs ID prefix.
 * Strips all non-alphanumeric characters and converts to uppercase.
 * Example: "My-Component_v2" → "MYCOMPONENTV2"
 */
export function normalizeComponentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Zero-pad a counter to the given width. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// ── Attribute parsing helpers ────────────────────────────────────────────────

function parseAttrs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  try {
    return JSON.parse(String(raw ?? '{}'));
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return v != null ? String(v) : '';
}

// ── Required-call wrapper ────────────────────────────────────────────────────

async function required<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Query '${name}' failed: ${msg}`);
  }
}

// ── Optional-call wrapper ────────────────────────────────────────────────────

async function optional<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[safety-export-aggregator] Optional call '${name}' failed (continuing with empty result): ${msg}`);
    return fallback;
  }
}

// ── Propagation Cypher query ─────────────────────────────────────────────────

/**
 * Fetch all propagates_to edges between malfunction nodes in a namespace.
 * Returns rows with source and target node IDs.
 *
 * The WHERE clause constrains the **target** malfunction's namespace, not
 * the source. Both ends of a propagation edge live in the same authored
 * safety namespace, so pinning the target captures the identical set.
 */
const PROPAGATION_QUERY = `
MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
WHERE r.relationship = 'propagates_to'
  AND src.concept = 'malfunction'
  AND tgt.concept = 'malfunction'
  AND tgt.namespace = $namespace
RETURN src.node_id AS source, tgt.node_id AS target
`;

// ── Port connector Cypher query ──────────────────────────────────────────────

/**
 * Fetch all ports per SWC/SysML component by node ID.
 * Returns individual port rows with name and relationship type (kind).
 * Supports both ARXML (has_p_port/has_r_port/has_pr_port) and
 * SysML v2 (owns_element with port_usage concept) port patterns.
 */
const PORT_QUERY = `
MATCH (owner:RIA_UNIV_ConceptInstance)-[op:RIA_UNIV_INSTANCE_REL]->(port:RIA_UNIV_ConceptInstance)
WHERE owner.node_id IN $nodeIds
  AND (
    op.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port']
    OR (op.relationship = 'owns_element' AND port.concept = 'port_usage')
  )
RETURN owner.node_id AS owner_node_id, port.node_id AS port_node_id,
       port.attributes AS port_attrs, op.relationship AS port_rel,
       port.concept AS port_concept
`;

// ── Main aggregation function ────────────────────────────────────────────────

/**
 * Aggregate all safety export data for a namespace into a format-agnostic
 * SafetyExportData object. Required calls throw on failure; optional calls
 * log a warning and substitute an empty array.
 */
export async function aggregateExportData(
  namespace: string,
  deps: ServiceDependencies,
): Promise<SafetyExportData> {
  if (!deps.safetyCommands) throw new Error('Safety commands not configured');
  const sc = deps.safetyCommands;
  const db = deps.dbModule;

  // ── Step 1: Required bulk queries ─────────────────────────────────────────

  const rawMalfunctions = await required('getMalfunctions', async () => {
    const result = await sc.getMalfunctions(namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });

  const rawRequirements = await required('getRequirements', async () => {
    const result = await sc.getRequirements(namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });

  const rawSafetyNotes = await required('getSafetyNotes', async () => {
    const result = await sc.getSafetyNotes(namespace);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });

  // ── Step 2: Optional bulk queries ─────────────────────────────────────────

  const rawSafetyTasks = await optional(
    'getAllSafetyTasks',
    async () => {
      const result = await sc.getAllSafetyTasks(namespace);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    [] as ConceptInstanceData[],
  );

  const propagationRows = await optional(
    'propagation query',
    () => db.runQuery(PROPAGATION_QUERY, { namespace }),
    [] as Record<string, unknown>[],
  );

  const rawAllTags = await optional(
    'getAllTags',
    async () => {
      const result = await sc.getAllTags(namespace);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    [] as ConceptInstanceData[],
  );

  // Bulk review-item query: fetch all review_items in the namespace together with
  // their parent malfunction node_id via the RIA_UNIV_RelationshipInstance secondary
  // table (target-pinned).
  const reviewItemRows = await optional(
    'bulk review-item query',
    () => db.runQuery(
      `MATCH (ri:RIA_UNIV_ConceptInstance)
       WHERE ri.namespace = $namespace AND ri.concept = 'review_item'
       MATCH (ri2:RIA_UNIV_RelationshipInstance)
         WHERE ri2.target_node_id = ri.node_id AND ri2.relationship = 'has_review'
       RETURN ri2.source_node_id AS fm_node_id,
              ri.node_id AS node_id,
              ri.attributes AS attributes`,
      { namespace },
    ),
    [] as Record<string, unknown>[],
  );

  // ── Step 3: Build lookup maps ──────────────────────────────────────────────

  // Map nodeId → ConceptInstanceData for requirements and tasks
  const requirementById = new Map<number, ConceptInstanceData>();
  for (const req of rawRequirements) {
    requirementById.set(req.node_id, req);
  }

  const safetyTaskById = new Map<number, ConceptInstanceData>();
  for (const task of rawSafetyTasks) {
    safetyTaskById.set(task.node_id, task);
  }

  // Map malfunction nodeId → review items attached to it
  const reviewsByFm = new Map<number, ReviewExportData[]>();
  for (const row of reviewItemRows) {
    const fmId = Number(row.fm_node_id);
    const attrs = parseAttrs(row.attributes);
    const review: ReviewExportData = {
      nodeId: Number(row.node_id),
      name: str(attrs.has_name),
      status: str(attrs.review_status),
      reviewerComment: str(attrs.reviewer_comment),
      authorComment: str(attrs.author_comment),
      verdict: str(attrs.reviewer_verdict),
    };
    if (!reviewsByFm.has(fmId)) reviewsByFm.set(fmId, []);
    reviewsByFm.get(fmId)!.push(review);
  }

  // Map nodeId → tag has_name values (all tags in namespace)
  const tagById = new Map<number, string>();
  for (const tag of rawAllTags) {
    const attrs = parseAttrs(tag.attributes);
    const name = str(attrs.has_name);
    if (name) tagById.set(tag.node_id, name);
  }

  // Port count per component node_id — populated after step 5 once componentNodeIds is known
  const portCountByNodeId = new Map<number, number>();

  // Propagation: target nodeId → set of source nodeIds (propagatesFrom direction)
  const causationByTarget = new Map<number, Set<number>>();
  // Propagation: source nodeId → set of target nodeIds (propagatesTo direction)
  const propagatesToBySource = new Map<number, Set<number>>();
  for (const row of propagationRows) {
    const src = Number(row.source);
    const tgt = Number(row.target);
    if (!causationByTarget.has(tgt)) causationByTarget.set(tgt, new Set());
    causationByTarget.get(tgt)!.add(src);
    if (!propagatesToBySource.has(src)) propagatesToBySource.set(src, new Set());
    propagatesToBySource.get(src)!.add(tgt);
  }

  // ── Step 4: Resolve occurs_at targets for all malfunctions ────────────────
  // We need to know which component each malfunction belongs to, and whether
  // it's a functional MF or a port-level MF (receiver/provider).

  interface MalfunctionWithTarget {
    raw: ConceptInstanceData;
    targetNodeId: number | null;
    targetNamespace: string | null;
    targetConcept: string | null;
    targetAttrs: Record<string, unknown>;
    portName?: string;
    portKind?: 'receiver' | 'provider';
    ownerNodeId: number | null;
    ownerAttrs: Record<string, unknown>;
  }

  // Fetch occurs_at targets for all malfunctions in one query
  const occursAtRows = await required('occurs_at query', () =>
    db.runQuery(
      `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND r.relationship = 'occurs_at'
       OPTIONAL MATCH (owner:RIA_UNIV_ConceptInstance)-[op:RIA_UNIV_INSTANCE_REL]->(tgt)
       WHERE op.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port']
       RETURN fm.node_id AS fm_node_id,
              tgt.node_id AS tgt_node_id,
              tgt.namespace AS tgt_namespace,
              tgt.concept AS tgt_concept,
              tgt.attributes AS tgt_attrs,
              op.relationship AS port_rel,
              owner.node_id AS owner_node_id,
              owner.attributes AS owner_attrs`,
      { namespace },
    ),
  );

  // Build a map from fm nodeId → target info
  const occursAtByFm = new Map<number, MalfunctionWithTarget>();
  for (const row of occursAtRows) {
    const fmId = Number(row.fm_node_id);
    const tgtConcept = str(row.tgt_concept);
    const portRel = str(row.port_rel);
    const isPort = ['p_port', 'r_port', 'pr_port'].includes(tgtConcept);

    let portKind: 'receiver' | 'provider' | undefined;
    let portName: string | undefined;
    let ownerNodeId: number | null = null;
    let ownerAttrs: Record<string, unknown> = {};

    if (isPort) {
      const tgtAttrs = parseAttrs(row.tgt_attrs);
      portName = str(tgtAttrs.short_name || tgtAttrs.has_name || tgtAttrs.name) || undefined;
      // r_port = receiver, p_port = provider, pr_port = provider (bidirectional treated as provider)
      if (tgtConcept === 'r_port' || portRel === 'has_r_port') {
        portKind = 'receiver';
      } else {
        portKind = 'provider';
      }
      ownerNodeId = row.owner_node_id != null ? Number(row.owner_node_id) : null;
      ownerAttrs = parseAttrs(row.owner_attrs);
    }

    occursAtByFm.set(fmId, {
      raw: rawMalfunctions.find(m => m.node_id === fmId)!,
      targetNodeId: Number(row.tgt_node_id),
      targetNamespace: str(row.tgt_namespace),
      targetConcept: tgtConcept,
      targetAttrs: parseAttrs(row.tgt_attrs),
      portName,
      portKind,
      ownerNodeId,
      ownerAttrs,
    });
  }

  // ── Step 5: Fetch SWC component nodes from the imported namespace ──────────
  // We need to group malfunctions by their owning SWC component.
  // For functional MFs: occurs_at → SWC directly
  // For port MFs: occurs_at → port → owner SWC

  // Collect all unique component node IDs referenced by malfunctions
  const componentNodeIds = new Set<number>();
  for (const fm of rawMalfunctions) {
    const oa = occursAtByFm.get(fm.node_id);
    if (!oa) continue;
    if (oa.portKind) {
      // Port-level MF: owner is the SWC
      if (oa.ownerNodeId != null) componentNodeIds.add(oa.ownerNodeId);
    } else {
      // Functional MF: target is the SWC
      if (oa.targetNodeId != null) componentNodeIds.add(oa.targetNodeId);
    }
  }

  // Also collect component node IDs from safety notes (notes can be attached to components)
  // We'll handle notes separately below.

  // Fetch component data for all referenced SWC nodes
  interface ComponentInfo {
    nodeId: number;
    name: string;
    uuid: string;
    componentType: string;
    arxmlPath?: string;
    namespace: string;
  }

  const componentInfoById = new Map<number, ComponentInfo>();

  if (componentNodeIds.size > 0) {
    const compRows = await required('component query', () =>
      db.runQuery(
        `MATCH (c:RIA_UNIV_ConceptInstance)
         WHERE c.node_id IN $nodeIds
         RETURN c.node_id AS node_id, c.concept AS concept, c.namespace AS namespace,
                c.attributes AS attributes`,
        { nodeIds: Array.from(componentNodeIds) },
      ),
    );

    for (const row of compRows) {
      const attrs = parseAttrs(row.attributes);
      const stablePath = str(attrs.stable_path);
      const segments = stablePath.split('/');
      const shortName = segments[segments.length - 1] ?? str(attrs.short_name || attrs.has_name || attrs.name || attrs.declared_name);
      componentInfoById.set(Number(row.node_id), {
        nodeId: Number(row.node_id),
        name: shortName || str(attrs.short_name || attrs.has_name || attrs.name || attrs.declared_name) || `Component_${row.node_id}`,
        uuid: str(attrs.uuid || attrs.sysml_id || attrs.stable_path || ''),
        componentType: str(row.concept),
        arxmlPath: stablePath || undefined,
        namespace: str(row.namespace),
      });
    }
  }

  // ── Step 5b: Fetch port data for all known component node IDs ──────────────
  interface PortData { nodeId: number; name: string; kind: 'receiver' | 'provider' }
  const portsByComponent = new Map<number, PortData[]>();

  if (componentNodeIds.size > 0) {
    const portRows = await optional(
      'port query',
      () => db.runQuery(PORT_QUERY, { nodeIds: Array.from(componentNodeIds) }),
      [] as Record<string, unknown>[],
    );
    for (const row of portRows) {
      const ownerId = Number(row.owner_node_id);
      const portNodeId = Number(row.port_node_id);
      const portAttrs = parseAttrs(row.port_attrs);
      const portRel = str(row.port_rel);
      const portConcept = str(row.port_concept);
      const portName = str(portAttrs.short_name || portAttrs.has_name || portAttrs.name || portAttrs.declared_name) || `port_${portNodeId}`;

      // Determine port kind:
      // ARXML: has_r_port = receiver, has_p_port/has_pr_port = provider
      // SysML v2: direction attribute (in = receiver, out/inout = provider)
      let kind: 'receiver' | 'provider';
      if (portConcept === 'port_usage') {
        const direction = str(portAttrs.direction).toLowerCase();
        kind = direction === 'in' ? 'receiver' : 'provider';
      } else {
        kind = portRel === 'has_r_port' ? 'receiver' : 'provider';
      }

      if (!portsByComponent.has(ownerId)) portsByComponent.set(ownerId, []);
      portsByComponent.get(ownerId)!.push({ nodeId: portNodeId, name: portName, kind });

      // Also maintain portCount map for backward compat
      portCountByNodeId.set(ownerId, (portCountByNodeId.get(ownerId) ?? 0) + 1);
    }
  }

  // ── Step 6: Per-malfunction required queries ───────────────────────────────

  // For each malfunction: getRiskRating, getRequirementsForFm, getDirectRequirementsForFm
  interface MalfunctionEnriched {
    raw: ConceptInstanceData;
    riskRating: ConceptInstanceData | null;
    linkedReqIds: number[];
    oa: MalfunctionWithTarget | undefined;
  }

  // ── Bulk target-side relationship maps ────────────────────────────────────
  // Instead of N per-malfunction source-pinned queries, we run one bulk query
  // per relationship pinned on the target's namespace.

  // malfunction nodeId → risk_rating ConceptInstanceData
  const riskRatingByFm = new Map<number, ConceptInstanceData>();
  const riskRatingRows = await required('bulk risk-rating query', () =>
    db.runQuery(
      `MATCH (rr:RIA_UNIV_ConceptInstance)<-[r:RIA_UNIV_INSTANCE_REL]-(fm:RIA_UNIV_ConceptInstance)
       WHERE rr.namespace = $namespace AND rr.concept = 'risk_rating'
         AND r.relationship = 'has_risk_rating' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS fm_node_id, rr.node_id AS node_id, rr.namespace AS namespace,
              rr.concept AS concept, rr.metamodel AS metamodel, rr.attributes AS attributes`,
      { namespace },
    ),
  );
  for (const row of riskRatingRows) {
    const fmId = Number(row.fm_node_id);
    // A malfunction has at most one risk rating; keep the first if duplicated.
    if (riskRatingByFm.has(fmId)) continue;
    riskRatingByFm.set(fmId, {
      node_id: Number(row.node_id),
      namespace: str(row.namespace),
      concept: str(row.concept),
      metamodel: str(row.metamodel),
      attributes: parseAttrs(row.attributes),
    });
  }

  // malfunction nodeId → intra-namespace requirement nodeIds (has_safety_requirements)
  const linkedReqsByFm = new Map<number, number[]>();
  const linkedReqRows = await required('bulk has_safety_requirements query', () =>
    db.runQuery(
      `MATCH (req:RIA_UNIV_ConceptInstance)<-[r:RIA_UNIV_INSTANCE_REL]-(fm:RIA_UNIV_ConceptInstance)
       WHERE req.namespace = $namespace AND req.concept = 'requirement'
         AND r.relationship = 'has_safety_requirements' AND fm.concept = 'malfunction'
       RETURN fm.node_id AS fm_node_id, req.node_id AS req_node_id`,
      { namespace },
    ),
  );
  for (const row of linkedReqRows) {
    const fmId = Number(row.fm_node_id);
    if (!linkedReqsByFm.has(fmId)) linkedReqsByFm.set(fmId, []);
    linkedReqsByFm.get(fmId)!.push(Number(row.req_node_id));
  }

  const enrichedMalfunctions: MalfunctionEnriched[] = [];

  for (const fm of rawMalfunctions) {
    const riskRating = riskRatingByFm.get(fm.node_id) ?? null;

    const linkedReqs = linkedReqsByFm.get(fm.node_id) ?? [];

    const directReqs = await required(`getDirectRequirementsForFm(${fm.node_id})`, async () => {
      const result = await sc.getDirectRequirementsForFm(fm.node_id);
      if (!result.ok) throw new Error(result.error);
      return result.data.map(r => r.node_id);
    });

    // Merge and deduplicate requirement IDs
    const allReqIds = [...new Set([...linkedReqs, ...directReqs])];

    enrichedMalfunctions.push({
      raw: fm,
      riskRating,
      linkedReqIds: allReqIds,
      oa: occursAtByFm.get(fm.node_id),
    });
  }

  // ── Step 7: Fetch safety tasks linked to each malfunction ─────────────────
  // Build a map from malfunction nodeId → safety task nodeIds.
  const tasksByFm = new Map<number, number[]>();
  if (rawSafetyTasks.length > 0) {
    // Query which tasks are linked to which malfunctions
    const taskLinkRows = await optional(
      'task-fm link query',
      () => db.runQuery(
        `MATCH (task:RIA_UNIV_ConceptInstance)<-[r:RIA_UNIV_INSTANCE_REL]-(fm:RIA_UNIV_ConceptInstance)
         WHERE task.namespace = $namespace AND task.concept = 'safety_task'
           AND r.relationship = 'has_safety_tasks' AND fm.concept = 'malfunction'
         RETURN fm.node_id AS fm_node_id, task.node_id AS task_node_id`,
        { namespace },
      ),
      [] as Record<string, unknown>[],
    );
    for (const row of taskLinkRows) {
      const fmId = Number(row.fm_node_id);
      const taskId = Number(row.task_node_id);
      if (!tasksByFm.has(fmId)) tasksByFm.set(fmId, []);
      tasksByFm.get(fmId)!.push(taskId);
    }
  }

  // ── Step 8: Fetch tags for each SWC component ─────────────────────────────
  const tagsByComponent = new Map<number, string[]>();
  if (rawAllTags.length > 0) {
    for (const compId of componentNodeIds) {
      const compTags = await optional(
        `getTagsForImportedElement(${compId})`,
        async () => {
          const result = await sc.getTagsForImportedElement(compId);
          if (!result.ok) throw new Error(result.error);
          return result.data;
        },
        [] as ConceptInstanceData[],
      );
      const tagNames = compTags
        .map(t => str(parseAttrs(t.attributes).has_name))
        .filter(n => n.length > 0);
      if (tagNames.length > 0) tagsByComponent.set(compId, tagNames);
    }
  }

  // ── Step 9: Fetch safety notes attached to each component ─────────────────
  // Notes can be attached to components via cross-namespace has_notes edges
  const notesByComponent = new Map<number, ConceptInstanceData[]>();
  if (rawSafetyNotes.length > 0 && componentNodeIds.size > 0) {
    const noteCompRows = await optional(
      'notes-component link query',
      () => db.runQuery(
        `MATCH (comp:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(note:RIA_UNIV_ConceptInstance)
         WHERE comp.node_id IN $nodeIds AND r.relationship = 'has_notes' AND note.concept = 'safety_note'
         RETURN comp.node_id AS comp_node_id, note.node_id AS note_node_id,
                note.namespace AS note_namespace, note.concept AS note_concept,
                note.metamodel AS note_metamodel, note.attributes AS note_attributes`,
        { nodeIds: Array.from(componentNodeIds) },
      ),
      [] as Record<string, unknown>[],
    );
    for (const row of noteCompRows) {
      const compId = Number(row.comp_node_id);
      if (!notesByComponent.has(compId)) notesByComponent.set(compId, []);
      notesByComponent.get(compId)!.push({
        node_id: Number(row.note_node_id),
        namespace: str(row.note_namespace),
        concept: str(row.note_concept),
        metamodel: str(row.note_metamodel),
        attributes: parseAttrs(row.note_attributes),
      });
    }
  }

  // ── Step 10: Group malfunctions by owning component ───────────────────────

  interface ComponentAccumulator {
    info: ComponentInfo;
    functionalMFs: MalfunctionEnriched[];
    receiverPortMFs: MalfunctionEnriched[];
    providerPortMFs: MalfunctionEnriched[];
  }

  const componentAccumulators = new Map<number, ComponentAccumulator>();

  function getOrCreateAccumulator(compId: number): ComponentAccumulator | null {
    const info = componentInfoById.get(compId);
    if (!info) return null;
    if (!componentAccumulators.has(compId)) {
      componentAccumulators.set(compId, {
        info,
        functionalMFs: [],
        receiverPortMFs: [],
        providerPortMFs: [],
      });
    }
    return componentAccumulators.get(compId)!;
  }

  for (const em of enrichedMalfunctions) {
    const oa = em.oa;
    if (!oa) continue; // Skip orphaned malfunctions (no occurs_at)

    if (oa.portKind) {
      // Port-level MF
      const compId = oa.ownerNodeId;
      if (compId == null) continue;
      const acc = getOrCreateAccumulator(compId);
      if (!acc) continue;
      if (oa.portKind === 'receiver') {
        acc.receiverPortMFs.push(em);
      } else {
        acc.providerPortMFs.push(em);
      }
    } else {
      // Functional MF
      const compId = oa.targetNodeId;
      if (compId == null) continue;
      const acc = getOrCreateAccumulator(compId);
      if (!acc) continue;
      acc.functionalMFs.push(em);
    }
  }

  // ── Step 11: Assign Sphinx-Needs IDs and build ComponentExportData ─────────

  const components: ComponentExportData[] = [];

  for (const [compId, acc] of componentAccumulators) {
    const prefix = normalizeComponentName(acc.info.name);

    // Build a nodeId → Sphinx-Needs ID map for all MFs in this component
    // (needed to resolve causation IDs and task/req cross-references)
    const mfIdMap = new Map<number, string>();

    let funcCounter = 1;
    for (const em of acc.functionalMFs) {
      mfIdMap.set(em.raw.node_id, `${prefix}_MF_${pad(funcCounter++, 3)}`);
    }
    let rpCounter = 1;
    for (const em of acc.receiverPortMFs) {
      mfIdMap.set(em.raw.node_id, `${prefix}_MF_RP_${pad(rpCounter++, 3)}`);
    }
    let ppCounter = 1;
    for (const em of acc.providerPortMFs) {
      mfIdMap.set(em.raw.node_id, `${prefix}_MF_PP_${pad(ppCounter++, 3)}`);
    }

    // Build requirement ID map for this component
    // Collect all requirement nodeIds referenced by MFs in this component
    const allReqNodeIds = new Set<number>();
    for (const em of [...acc.functionalMFs, ...acc.receiverPortMFs, ...acc.providerPortMFs]) {
      for (const reqId of em.linkedReqIds) allReqNodeIds.add(reqId);
    }

    const reqIdMap = new Map<number, string>();
    let reqCounter = 1;
    for (const reqNodeId of allReqNodeIds) {
      reqIdMap.set(reqNodeId, `${prefix}_REQ_${pad(reqCounter++, 3)}`);
    }

    // Build safety task ID map for this component
    const allTaskNodeIds = new Set<number>();
    for (const em of [...acc.functionalMFs, ...acc.receiverPortMFs, ...acc.providerPortMFs]) {
      const tasks = tasksByFm.get(em.raw.node_id) ?? [];
      for (const taskId of tasks) allTaskNodeIds.add(taskId);
    }

    const taskIdMap = new Map<number, string>();
    let taskCounter = 1;
    for (const taskNodeId of allTaskNodeIds) {
      taskIdMap.set(taskNodeId, `${prefix}_ST_${pad(taskCounter++, 3)}`);
    }

    // Build safety note ID map for this component
    const compNotes = notesByComponent.get(compId) ?? [];
    const noteIdMap = new Map<number, string>();
    let noteCounter = 1;
    for (const note of compNotes) {
      noteIdMap.set(note.node_id, `${prefix}_SN_${pad(noteCounter++, 2)}`);
    }

    // Helper to build MalfunctionExportData
    function buildMfExport(em: MalfunctionEnriched): MalfunctionExportData {
      const attrs = parseAttrs(em.raw.attributes);
      const mfId = mfIdMap.get(em.raw.node_id) ?? `${prefix}_MF_???`;
      const oa = em.oa;

      // Propagates From: which MFs propagate TO this one (incoming)
      const causeSrcIds = causationByTarget.get(em.raw.node_id) ?? new Set<number>();
      const propagatesFromIds: string[] = [];
      for (const srcId of causeSrcIds) {
        const causeMfId = mfIdMap.get(srcId);
        if (causeMfId) propagatesFromIds.push(causeMfId);
      }

      // Propagates To: which MFs this one propagates to (outgoing)
      const causeTgtIds = propagatesToBySource.get(em.raw.node_id) ?? new Set<number>();
      const propagatesToIds: string[] = [];
      for (const tgtId of causeTgtIds) {
        const tgtMfId = mfIdMap.get(tgtId);
        if (tgtMfId) propagatesToIds.push(tgtMfId);
      }

      // Task IDs
      const linkedTaskNodeIds = tasksByFm.get(em.raw.node_id) ?? [];
      const taskIds = linkedTaskNodeIds
        .map(tid => taskIdMap.get(tid))
        .filter((id): id is string => id != null);

      // Requirement IDs
      const reqIds = em.linkedReqIds
        .map(rid => reqIdMap.get(rid))
        .filter((id): id is string => id != null);

      // Risk rating
      let riskRating: RiskRatingData | null = null;
      if (em.riskRating) {
        const rrAttrs = parseAttrs(em.riskRating.attributes);
        riskRating = {
          has_severity: str(rrAttrs.has_severity),
          has_occurrence_level: str(rrAttrs.has_occurrence_level),
          has_detection_level: str(rrAttrs.has_detection_level),
          risk_priority_number: str(rrAttrs.risk_priority_number),
          risk_rating_note: str(rrAttrs.risk_rating_note),
        };
      }

      return {
        nodeId: em.raw.node_id,
        id: mfId,
        name: str(attrs.has_name),
        description: str(attrs.malfunction_description),
        asil: str(attrs.malfunction_asil),
        portName: oa?.portName,
        portKind: oa?.portKind,
        propagatesFromIds,
        propagatesToIds,
        taskIds,
        reqIds,
        riskRating,
        reviews: reviewsByFm.get(em.raw.node_id) ?? [],
      };
    }

    const functionalMFs = acc.functionalMFs.map(buildMfExport);
    const receiverPortMFs = acc.receiverPortMFs.map(buildMfExport);
    const providerPortMFs = acc.providerPortMFs.map(buildMfExport);

    // Build RequirementExportData
    // Some requirements may be imported from other namespaces (e.g. Jama/sphinx-needs)
    // and won't be in requirementById (which only covers the safety namespace).
    // Collect the missing node IDs and fetch them in one query.
    const missingReqNodeIds = [...allReqNodeIds].filter(id => !requirementById.has(id));
    if (missingReqNodeIds.length > 0) {
      const missingRows = await optional(
        'fetch imported requirements',
        () => db.runQuery(
          `MATCH (r:RIA_UNIV_ConceptInstance)
           WHERE r.node_id IN $nodeIds
           RETURN r.node_id AS node_id, r.namespace AS namespace,
                  r.concept AS concept, r.metamodel AS metamodel,
                  r.attributes AS attributes`,
          { nodeIds: missingReqNodeIds },
        ),
        [] as Record<string, unknown>[],
      );
      for (const row of missingRows) {
        requirementById.set(Number(row.node_id), {
          node_id: Number(row.node_id),
          namespace: str(row.namespace),
          concept: str(row.concept),
          metamodel: str(row.metamodel),
          attributes: parseAttrs(row.attributes),
        });
      }
    }

    const requirements: RequirementExportData[] = [];
    for (const [reqNodeId, reqSphinxId] of reqIdMap) {
      const rawReq = requirementById.get(reqNodeId);
      if (!rawReq) continue;
      const attrs = parseAttrs(rawReq.attributes);
      // Support both safety-authored requirements (req_name, req_id, req_text, req_asil)
      // and imported requirements from other namespaces (e.g. sphinx-needs: id, title/content)
      const name = str(attrs.req_name || attrs.has_name || attrs.title || attrs.id || attrs.name);
      const reqId = str(attrs.req_id || attrs.id || '');
      const reqText = str(attrs.req_text || attrs.content || attrs.description || attrs.title || '');
      const reqAsil = str(attrs.req_asil || attrs.asil || attrs.safety_level || '');
      const reqLinkedTo = str(attrs.req_linked_to || attrs.links || attrs.url || '') || undefined;
      requirements.push({
        nodeId: reqNodeId,
        id: reqSphinxId,
        name,
        reqId,
        reqText,
        reqAsil,
        reqLinkedTo,
      });
    }

    // Build SafetyTaskExportData
    const safetyTasks: SafetyTaskExportData[] = [];
    for (const [taskNodeId, taskSphinxId] of taskIdMap) {
      const rawTask = safetyTaskById.get(taskNodeId);
      if (!rawTask) continue;
      const attrs = parseAttrs(rawTask.attributes);
      safetyTasks.push({
        nodeId: taskNodeId,
        id: taskSphinxId,
        name: str(attrs.has_name),
        description: str(attrs.task_description),
        status: str(attrs.task_status),
        type: str(attrs.task_type),
        responsible: str(attrs.task_responsible) || undefined,
        reference: str(attrs.task_reference) || undefined,
      });
    }

    // Build SafetyNoteExportData
    const safetyNotes: SafetyNoteExportData[] = [];
    for (const note of compNotes) {
      const noteSphinxId = noteIdMap.get(note.node_id);
      if (!noteSphinxId) continue;
      const attrs = parseAttrs(note.attributes);
      safetyNotes.push({
        nodeId: note.node_id,
        id: noteSphinxId,
        noteText: str(attrs.note_text),
      });
    }

    // Check if this component has any safety elements
    const hasSafetyElements =
      functionalMFs.length > 0 ||
      receiverPortMFs.length > 0 ||
      providerPortMFs.length > 0 ||
      requirements.length > 0 ||
      safetyTasks.length > 0 ||
      safetyNotes.length > 0;

    if (!hasSafetyElements) continue; // Exclude components with zero safety elements

    components.push({
      nodeId: compId,
      name: acc.info.name,
      uuid: acc.info.uuid,
      componentType: acc.info.componentType,
      namespace: acc.info.namespace,
      arxmlPath: acc.info.arxmlPath,
      functionalMFs,
      receiverPortMFs,
      providerPortMFs,
      requirements,
      safetyTasks,
      safetyNotes,
      portCount: portCountByNodeId.get(compId) ?? 0,
      ports: (portsByComponent.get(compId) ?? []).map(p => ({ nodeId: p.nodeId, name: p.name, kind: p.kind })),
      tags: tagsByComponent.get(compId) ?? [],
    });
  }

  // Sort components alphabetically by name for deterministic output
  components.sort((a, b) => a.name.localeCompare(b.name));

  return {
    namespace,
    components,
    generatedAt: new Date().toISOString(),
  };
}
