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
 * Element_Safety_Bundle assembly for the LLM Review_Run feature.
 *
 * Given a single Eligible_Element_Node (the Selected_Element or one of
 * its Context_Elements) and the resolved {@link LlmReviewProfile}, this
 * module produces the {@link ElementSafetyBundle} that downstream prompt
 * assembly serialises into the `user`-role message sent to AWS Bedrock.
 *
 * The assembler orchestrates the existing `safety.*` and `arxml.*`
 * dispatch operations rather than issuing raw Cypher queries
 * (Requirement 6.6):
 *
 * | Bundle field                              | Source operation                                         |
 * |-------------------------------------------|----------------------------------------------------------|
 * | metadata (`name`, `stable_path`, `uuid`)  | `safety.getInstance` via {@link IInstanceService}         |
 * | element-direct malfunctions               | `safety.getMalfunctionsForElement` (cypher in handler)    |
 * | per-malfunction propagations              | `safety.getPropagations` via {@link ISafetyCommands}      |
 * | per-malfunction safety notes              | `safety.getNotesForFm` (cypher in handler)                |
 * | per-malfunction requirements              | `safety.getRequirementsForFm` (cypher in handler)         |
 * | per-malfunction safety tasks              | `safety.getSafetyTasks` via {@link ISafetyCommands}       |
 * | per-malfunction risk rating               | `safety.getRiskRating` via {@link ISafetyCommands}        |
 * | element-direct safety notes               | `safety.getNotesForElement` (cypher in handler)           |
 * | element-direct requirements               | `safety.getRequirements` via {@link ISafetyCommands},     |
 * |                                           |   filtered by `req_linked_to == element.uuid`             |
 * | `ports[]` (sw_arxml only)                 | `arxml.getComponentPortConnectors` via                    |
 * |                                           |   {@link getComponentPortConnectorsImpl}                  |
 *
 * The Cypher-only handlers (`safety.getMalfunctionsForElement`,
 * `safety.getNotesForFm`, `safety.getRequirementsForFm`,
 * `safety.getNotesForElement`) are reproduced as private helpers in
 * this module — every helper here is the verbatim body of the matching
 * registered handler in `safety-channels.ts`. This is the "internal
 * dispatch pattern" the design refers to: the bundle assembler reads
 * directly through the same service interfaces (`ISafetyCommands`,
 * `IInstanceService`, `IDbModule`) the channel handlers use, instead of
 * round-tripping through the registry.
 *
 * Cross-namespace references inside the bundle use only `{ name, uuid }`
 * — the ephemeral numeric `node_id` is never embedded for cross-namespace
 * elements (Requirement 6.5). The bundle's own `node_id` is included
 * because the prompt is regenerated per Review_Run and never persisted.
 *
 * Per-element fetches run in parallel via `Promise.all` (Requirement 6).
 *
 * The assembler is pure with respect to the safety database and
 * persistor — no writes are issued (Requirement 8.11).
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type {
  ConceptInstanceData,
  ElementSafetyBundle,
  LlmReviewProfile,
  BundleMalfunction,
  BundleDirectPropagationMalfunction,
  BundleOwnedElementStructure,
  BundlePort,
  SafetyElementRef,
} from '@riacore/app-contracts';

import type { IDbModule } from '../db/db-module.js';
import type { IInstanceService } from '../namespaces/instance-service.js';
import type { ISafetyCommands } from '../safety/safety-commands.js';
import { getComponentPortConnectorsImpl } from '../dispatch/handlers/arxml-channels.js';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Reference to one Eligible_Element_Node — the Selected_Element or a
 * Context_Element returned by the collectors. The shape mirrors
 * {@link ContextElementRef} from `context-collectors.ts`; both
 * collectors produce values assignable to this type so the bundle
 * assembler can be invoked uniformly across `sw_arxml` and
 * `system_sysml`.
 */
export interface BundleElementRef {
  nodeId: number;
  namespace: string;
  concept: string;
  name: string;
  stablePath: string;
}

/**
 * Minimal slice of {@link ServiceDependencies} required by the bundle
 * assembler. Keeping the constraint local lets unit tests substitute
 * hand-rolled fakes without pulling the full dispatcher graph.
 */
export interface BundleAssemblyDeps {
  dbModule: Pick<IDbModule, 'runQuery'>;
  instanceService: IInstanceService;
  safetyCommands: ISafetyCommands;
}

const SYSML_STRUCTURE_MAX_DEPTH = 4;
const SYSML_STRUCTURE_MAX_NODES = 80;

// ── Attribute-extraction helpers ────────────────────────────────────────────

/**
 * Read the `has_name` attribute from a parsed attributes map, falling
 * back to the empty string. The bundle uses the human-readable name
 * for cross-namespace references (Requirement 6.5).
 */
function readName(attributes: Record<string, unknown> | undefined): string {
  if (!attributes) return '';
  const value = attributes.has_name ?? attributes.short_name ?? attributes.name ?? attributes.title ?? attributes.id;
  return value == null ? '' : String(value);
}

/**
 * Read the stable `uuid` attribute from a parsed attributes map,
 * falling back to `id` or `stable_path` for imported requirements.
 * The bundle uses the uuid for cross-namespace references (Requirement 6.5).
 */
function readUuid(attributes: Record<string, unknown> | undefined): string {
  if (!attributes) return '';
  const value = attributes.uuid ?? attributes.id ?? attributes.stable_path;
  return value == null ? '' : String(value);
}

/** Read the `stable_path` attribute, falling back to the empty string. */
function readStablePath(attributes: Record<string, unknown> | undefined): string {
  if (!attributes) return '';
  const value = attributes.stable_path;
  return value == null ? '' : String(value);
}

function parseAttributes(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Build a {@link SafetyElementRef} from a {@link ConceptInstanceData}.
 * Cross-namespace items are referenced solely by `{ name, uuid }` so
 * downstream prompt assembly never embeds a numeric `node_id` for
 * cross-namespace elements (Requirement 6.5).
 */
function toSafetyRef(data: ConceptInstanceData): SafetyElementRef {
  return {
    name: readName(data.attributes),
    uuid: readUuid(data.attributes),
  };
}

async function toAttachedElementRef(
  target: { node_id: number; namespace: string; concept: string; name?: string } | null | undefined,
  deps: BundleAssemblyDeps,
): Promise<BundleDirectPropagationMalfunction['attached_to']> {
  if (!target) return null;
  const instanceResult = await deps.instanceService.getInstance(target.node_id);
  if (!instanceResult.ok) {
    return {
      node_id: target.node_id,
      namespace: target.namespace,
      concept: target.concept,
      name: target.name ?? '',
      uuid: '',
    };
  }
  return {
    node_id: target.node_id,
    namespace: target.namespace,
    concept: target.concept,
    ...toSafetyRef(instanceResult.data),
  };
}

// ── Cypher helpers ─ reproduced from safety-channels.ts ─────────────────────
//
// The following helpers are the verbatim bodies of the matching
// registered channel handlers (`safety.getMalfunctionsForElement`,
// `safety.getNotesForFm`, `safety.getRequirementsForFm`,
// `safety.getNotesForElement`). Reproducing them lets the bundle
// assembler invoke the operations through the same interfaces the
// channel handlers use, without going through registry dispatch — see
// the file-level comment ("internal dispatch pattern").

/** @see safety-channels.ts → `safety.getMalfunctionsForElement` */
async function getMalfunctionsForElement(
  targetNodeId: number,
  deps: BundleAssemblyDeps,
): Promise<ConceptInstanceData[]> {
  const rows = await deps.dbModule.runQuery(
    `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
     WHERE tgt.node_id = $targetNodeId AND r.relationship = 'occurs_at' AND fm.concept = 'malfunction'
     RETURN fm.node_id AS node_id, fm.namespace AS namespace, fm.concept AS concept,
            fm.metamodel AS metamodel, fm.attributes AS attributes`,
    { targetNodeId },
  );
  return rows.map((row) => ({
    node_id: Number(row.node_id),
    namespace: String(row.namespace),
    concept: String(row.concept),
    metamodel: String(row.metamodel),
    attributes: JSON.parse(String(row.attributes ?? '{}')),
  }));
}

/** @see safety-channels.ts → `safety.getRequirementsForFm` */
async function getRequirementsForFm(
  failureModeNodeId: number,
  deps: BundleAssemblyDeps,
): Promise<ConceptInstanceData[]> {
  // Intra-namespace requirements (same namespace as the malfunction).
  // Resolve ids via RelationshipInstance, then fetch nodes by id.
  const intraIdRows = await deps.dbModule.runQuery(
    `MATCH (ri:RIA_UNIV_RelationshipInstance)
     WHERE ri.source_node_id = $nodeId AND ri.relationship IN ['has_safety_requirements', 'has_direct_requirements']
     RETURN ri.target_node_id AS node_id`,
    { nodeId: failureModeNodeId },
  );
  const intraReqIds = [...new Set(intraIdRows.map(r => Number(r.node_id)))];
  const intraRows = intraReqIds.length > 0
    ? await deps.dbModule.runQuery(
        `MATCH (req:RIA_UNIV_ConceptInstance)
         WHERE req.node_id IN $ids
         RETURN req.node_id AS node_id, req.namespace AS namespace, req.concept AS concept,
                req.metamodel AS metamodel, req.attributes AS attributes`,
        { ids: intraReqIds },
      )
    : [];
  // Cross-namespace requirements (imported from Jama/sphinx-needs etc.)
  const crossRows = await deps.dbModule.runQuery(
    `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req:RIA_UNIV_ConceptInstance)
     WHERE fm.node_id = $nodeId AND r.relationship IN ['has_safety_requirements', 'has_direct_requirements']
     RETURN req.node_id AS node_id, req.namespace AS namespace, req.concept AS concept,
            req.metamodel AS metamodel, req.attributes AS attributes`,
    { nodeId: failureModeNodeId },
  );
  return [...intraRows, ...crossRows].map((row) => ({
    node_id: Number(row.node_id),
    namespace: String(row.namespace),
    concept: String(row.concept),
    metamodel: String(row.metamodel),
    attributes: JSON.parse(String(row.attributes ?? '{}')),
  }));
}

/** @see safety-channels.ts → `safety.getNotesForFm` */
async function getNotesForFm(
  failureModeNodeId: number,
  deps: BundleAssemblyDeps,
): Promise<ConceptInstanceData[]> {
  const rows = await (async () => {
    const idRows = await deps.dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance)
       WHERE ri.source_node_id = $nodeId AND ri.relationship = 'has_notes'
       RETURN ri.target_node_id AS node_id`,
      { nodeId: failureModeNodeId },
    );
    const noteIds = [...new Set(idRows.map(r => Number(r.node_id)))];
    return noteIds.length > 0
      ? await deps.dbModule.runQuery(
          `MATCH (n:RIA_UNIV_ConceptInstance)
           WHERE n.node_id IN $ids AND n.concept = 'safety_note'
           RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
                  n.metamodel AS metamodel, n.attributes AS attributes`,
          { ids: noteIds },
        )
      : [];
  })();
  return rows.map((row) => ({
    node_id: Number(row.node_id),
    namespace: String(row.namespace),
    concept: String(row.concept),
    metamodel: String(row.metamodel),
    attributes: JSON.parse(String(row.attributes ?? '{}')),
  }));
}

/** @see safety-channels.ts → `safety.getNotesForElement` */
async function getNotesForElement(
  elementNodeId: number,
  deps: BundleAssemblyDeps,
): Promise<ConceptInstanceData[]> {
  const intraIdRows = await deps.dbModule.runQuery(
    `MATCH (ri:RIA_UNIV_RelationshipInstance)
     WHERE ri.source_node_id = $nodeId AND ri.relationship = 'has_notes'
     RETURN ri.target_node_id AS node_id`,
    { nodeId: elementNodeId },
  );
  const intraNoteIds = [...new Set(intraIdRows.map(r => Number(r.node_id)))];
  const intraRows = intraNoteIds.length > 0
    ? await deps.dbModule.runQuery(
        `MATCH (n:RIA_UNIV_ConceptInstance)
         WHERE n.node_id IN $ids AND n.concept = 'safety_note'
         RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
                n.metamodel AS metamodel, n.attributes AS attributes`,
        { ids: intraNoteIds },
      )
    : [];
  const crossRows = await deps.dbModule.runQuery(
    `MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(n:RIA_UNIV_ConceptInstance)
     WHERE elem.node_id = $nodeId AND r.relationship = 'has_notes' AND n.concept = 'safety_note'
     RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
            n.metamodel AS metamodel, n.attributes AS attributes`,
    { nodeId: elementNodeId },
  );
  return [...intraRows, ...crossRows].map((row) => ({
    node_id: Number(row.node_id),
    namespace: String(row.namespace),
    concept: String(row.concept),
    metamodel: String(row.metamodel),
    attributes: JSON.parse(String(row.attributes ?? '{}')),
  }));
}

// ── Per-malfunction enrichment ──────────────────────────────────────────────

/**
 * Build the {@link BundleMalfunction} for a single malfunction by
 * fetching its propagations, linked safety notes, linked requirements,
 * linked safety tasks, and risk rating in parallel.
 *
 * All fetches go through {@link ISafetyCommands} or the file-private
 * cypher helpers above; no writes are issued.
 */
async function buildBundleMalfunction(
  malfunction: ConceptInstanceData,
  deps: BundleAssemblyDeps,
): Promise<BundleMalfunction> {
  const fmNodeId = malfunction.node_id;

  const [
    propagationsResult,
    notes,
    requirements,
    safetyTasksResult,
    riskRatingResult,
  ] = await Promise.all([
    deps.safetyCommands.getPropagations(fmNodeId),
    getNotesForFm(fmNodeId, deps),
    getRequirementsForFm(fmNodeId, deps),
    deps.safetyCommands.getSafetyTasks(fmNodeId),
    deps.safetyCommands.getRiskRating(fmNodeId),
  ]);

  // Propagations: surface the SafetyElementRefs with name+uuid only
  // (Requirement 6.5). When the underlying call returns `Result<{ ok:false }>`
  // we treat it as "no propagations" — the bundle is for read-only
  // prompt assembly and a transient lookup failure should not abort
  // the whole Review_Run.
  const propagationsTo = propagationsResult.ok
    ? propagationsResult.data.propagatesTo.map(toSafetyRef)
    : [];
  const propagationsFrom = propagationsResult.ok
    ? propagationsResult.data.propagatesFrom.map(toSafetyRef)
    : [];

  const safetyTasks: SafetyElementRef[] = safetyTasksResult.ok
    ? safetyTasksResult.data.map(toSafetyRef)
    : [];

  // Risk rating: extract the canonical attribute keys; values stay
  // optional so the bundle reflects "not set" without spurious empty
  // strings.
  let riskRating: BundleMalfunction['risk_rating'] = null;
  if (riskRatingResult.ok && riskRatingResult.data) {
    const attrs = riskRatingResult.data.attributes ?? {};
    riskRating = {};
    if (attrs.has_severity != null) riskRating.severity = String(attrs.has_severity);
    if (attrs.has_occurrence_level != null) riskRating.exposure = String(attrs.has_occurrence_level);
    if (attrs.has_detection_level != null) riskRating.controllability = String(attrs.has_detection_level);
    if (attrs.has_asil != null) riskRating.asil = String(attrs.has_asil);
    if (attrs.risk_rating_note != null) riskRating.rationale = String(attrs.risk_rating_note);
  }

  const attrs = malfunction.attributes ?? {};

  return {
    name: readName(attrs),
    uuid: readUuid(attrs),
    asil: attrs.malfunction_asil != null ? String(attrs.malfunction_asil) : '',
    description: attrs.malfunction_description != null ? String(attrs.malfunction_description) : '',
    propagations: {
      to: propagationsTo,
      from: propagationsFrom,
    },
    linked_safety_notes: notes.map(toSafetyRef),
    linked_safety_requirements: requirements.map(toSafetyRef),
    linked_safety_tasks: safetyTasks,
    risk_rating: riskRating,
  };
}

async function buildDirectPropagationMalfunctions(
  malfunctions: ConceptInstanceData[],
  deps: BundleAssemblyDeps,
): Promise<BundleDirectPropagationMalfunction[]> {
  const seen = new Set<string>();
  const entries = await Promise.all(
    malfunctions.map(async (source) => {
      const propagations = await deps.safetyCommands.getPropagations(source.node_id);
      if (!propagations.ok) return [];

      const outgoing = propagations.data.propagatesTo.map(async (target) => {
        const key = `outgoing:${source.node_id}->${target.node_id}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return {
          direction: 'outgoing' as const,
          scope_malfunction: toSafetyRef(source),
          malfunction: await buildBundleMalfunction(target, deps),
          attached_to: await toAttachedElementRef(target.occursAtTarget, deps),
        };
      });

      const incoming = propagations.data.propagatesFrom.map(async (target) => {
        const key = `incoming:${target.node_id}->${source.node_id}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return {
          direction: 'incoming' as const,
          scope_malfunction: toSafetyRef(source),
          malfunction: await buildBundleMalfunction(target, deps),
          attached_to: await toAttachedElementRef(target.occursAtTarget, deps),
        };
      });

      return Promise.all([...outgoing, ...incoming]);
    }),
  );

  return entries.flat().filter((entry): entry is BundleDirectPropagationMalfunction => entry !== null);
}

async function getOwnedElementChildren(
  nodeId: number,
  deps: BundleAssemblyDeps,
): Promise<ConceptInstanceData[]> {
  const rows = await deps.dbModule.runQuery(
    `MATCH (ri:RIA_UNIV_RelationshipInstance)
     WHERE ri.source_node_id = $nodeId AND ri.relationship = 'owns_element'
     MATCH (child:RIA_UNIV_ConceptInstance)
     WHERE child.node_id = ri.target_node_id
     RETURN DISTINCT child.node_id AS node_id, child.namespace AS namespace,
                     child.concept AS concept, child.metamodel AS metamodel,
                     child.attributes AS attributes
     ORDER BY node_id`,
    { nodeId },
  );
  return rows.map((row) => ({
    node_id: Number(row.node_id),
    namespace: String(row.namespace),
    concept: String(row.concept),
    metamodel: String(row.metamodel),
    attributes: parseAttributes(row.attributes),
  }));
}

async function buildOwnedElementStructure(
  rootNodeId: number,
  deps: BundleAssemblyDeps,
): Promise<BundleOwnedElementStructure[]> {
  const visited = new Set<number>([rootNodeId]);
  let emittedNodes = 0;

  async function buildChildren(parentNodeId: number, depth: number): Promise<BundleOwnedElementStructure[]> {
    if (depth >= SYSML_STRUCTURE_MAX_DEPTH || emittedNodes >= SYSML_STRUCTURE_MAX_NODES) return [];

    const children = await getOwnedElementChildren(parentNodeId, deps);
    const entries: BundleOwnedElementStructure[] = [];
    for (const child of children) {
      if (visited.has(child.node_id) || emittedNodes >= SYSML_STRUCTURE_MAX_NODES) continue;
      visited.add(child.node_id);
      emittedNodes += 1;

      const childAttrs = child.attributes ?? {};
      const childMalfunctions = await getMalfunctionsForElement(child.node_id, deps);
      entries.push({
        node_id: child.node_id,
        namespace: child.namespace,
        concept: child.concept,
        name: readName(childAttrs),
        stable_path: readStablePath(childAttrs),
        malfunctions: childMalfunctions.map((malfunction) => {
          const attrs = malfunction.attributes ?? {};
          return {
            ...toSafetyRef(malfunction),
            asil: attrs.malfunction_asil != null ? String(attrs.malfunction_asil) : '',
            description: attrs.malfunction_description != null ? String(attrs.malfunction_description) : '',
          };
        }),
        owned_elements: await buildChildren(child.node_id, depth + 1),
      });
    }
    return entries;
  }

  return buildChildren(rootNodeId, 0);
}

// ── Port assembly (sw_arxml only) ───────────────────────────────────────────

/**
 * Build the {@link BundlePort} list for the SWC component identified by
 * `elementRef`. Only invoked for the `sw_arxml` profile
 * (Requirement 6.3).
 *
 * The implementation reuses {@link getComponentPortConnectorsImpl} so
 * that port discovery, malfunction enrichment, and connector
 * deduplication go through the same code path that powers the
 * `arxml.getComponentPortConnectors` channel.
 *
 * For each port we then look up its full per-malfunction enrichment
 * (propagations, linked notes/requirements/tasks, risk rating) via
 * {@link buildBundleMalfunction} so the bundle's port-malfunctions
 * carry the same shape as element-direct malfunctions.
 */
async function buildPortsForSwArxml(
  elementRef: BundleElementRef,
  deps: BundleAssemblyDeps,
): Promise<BundlePort[]> {
  const portConnectors = await getComponentPortConnectorsImpl(
    { nodeId: elementRef.nodeId },
    { dbModule: deps.dbModule },
  );

  // Collect the union of ports owned by this component:
  //  - `unconnectedPorts` already filtered to ownerNodeId === elementRef.nodeId
  //    by the upstream impl;
  //  - each connector contributes either its sourcePort or targetPort
  //    when the port's owner is this component.
  const portsByNodeId = new Map<
    number,
    {
      portType: 'p_port' | 'r_port' | 'pr_port';
      name: string;
      malfunctionNodeIds: Set<number>;
    }
  >();

  function addPort(port: {
    nodeId: number;
    portType: 'p_port' | 'r_port' | 'pr_port';
    name: string;
    ownerNodeId: number;
    malfunctions: { nodeId: number }[];
  }): void {
    if (port.ownerNodeId !== elementRef.nodeId) return;
    let entry = portsByNodeId.get(port.nodeId);
    if (!entry) {
      entry = {
        portType: port.portType,
        name: port.name,
        malfunctionNodeIds: new Set<number>(),
      };
      portsByNodeId.set(port.nodeId, entry);
    }
    for (const m of port.malfunctions) {
      entry.malfunctionNodeIds.add(m.nodeId);
    }
  }

  for (const port of portConnectors.unconnectedPorts) addPort(port);
  for (const connector of portConnectors.connectors) {
    addPort(connector.sourcePort);
    addPort(connector.targetPort);
  }

  // Resolve malfunctions to full ConceptInstanceData via instance
  // service so we can run the same enrichment pipeline used for
  // element-direct malfunctions.
  const ports: BundlePort[] = await Promise.all(
    [...portsByNodeId.entries()].map(async ([_portNodeId, port]) => {
      const malfunctions = await Promise.all(
        [...port.malfunctionNodeIds].map(async (mNodeId) => {
          const result = await deps.instanceService.getInstance(mNodeId);
          if (!result.ok) return null;
          return buildBundleMalfunction(result.data, deps);
        }),
      );
      return {
        port_type: port.portType,
        name: port.name,
        malfunctions: malfunctions.filter((m): m is BundleMalfunction => m !== null),
      };
    }),
  );

  return ports;
}

// ── Element-direct requirement filter ───────────────────────────────────────

/**
 * Element-direct requirements: requirements declared in the element's
 * own namespace whose `req_linked_to` attribute points to the element's
 * `uuid`. Filters the namespace-scoped `safety.getRequirements` result.
 *
 * Returns an empty array when the namespace has no requirements or the
 * service call fails.
 */
async function getDirectRequirementsForElement(
  elementRef: BundleElementRef,
  elementUuid: string,
  deps: BundleAssemblyDeps,
): Promise<ConceptInstanceData[]> {
  if (!elementUuid) return [];
  const result = await deps.safetyCommands.getRequirements(elementRef.namespace);
  if (!result.ok) return [];
  return result.data.filter((req) => {
    const linkedTo = req.attributes?.req_linked_to;
    return linkedTo != null && String(linkedTo) === elementUuid;
  });
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Build the {@link ElementSafetyBundle} for one Eligible_Element_Node.
 *
 * Fetches the element instance, its element-direct malfunctions, its
 * element-direct safety notes, and its element-direct requirements in
 * parallel; then enriches each malfunction with propagations, linked
 * notes, linked requirements, linked safety tasks, and the risk rating;
 * and finally — for the `sw_arxml` profile only — appends the SWC
 * component's ports (each with its own malfunction list).
 *
 * The `ports` field is omitted entirely for `system_sysml` profile
 * (Requirement 6.4).
 *
 * No writes are issued (Requirement 8.11). All cross-namespace items
 * are referenced by `{ name, uuid }` only (Requirement 6.5).
 *
 * @param elementRef Reference to the Eligible_Element_Node.
 * @param profile    Resolved Review_Profile for the run.
 * @param deps       Subset of {@link ServiceDependencies} the assembler
 *                   needs.
 * @returns          The assembled bundle.
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export async function buildElementSafetyBundle(
  elementRef: BundleElementRef,
  profile: LlmReviewProfile,
  deps: BundleAssemblyDeps,
): Promise<ElementSafetyBundle> {
  // Step 1 — fetch the element instance plus the data sets that depend
  // only on the element (not on per-malfunction enrichment) in
  // parallel.
  const [instanceResult, malfunctions, notes] = await Promise.all([
    deps.instanceService.getInstance(elementRef.nodeId),
    getMalfunctionsForElement(elementRef.nodeId, deps),
    getNotesForElement(elementRef.nodeId, deps),
  ]);

  if (!instanceResult.ok) {
    throw new Error(
      `Failed to load element ${elementRef.nodeId} for bundle assembly: ${instanceResult.error}`,
    );
  }
  const instance = instanceResult.data;
  const instanceAttrs = instance.attributes ?? {};
  const elementUuid = readUuid(instanceAttrs);

  // Step 2 — element-direct requirements depend on the element uuid we
  // just resolved, so they fire as a separate parallel batch with the
  // per-malfunction enrichment.
  const [enrichedMalfunctions, directPropagationMalfunctions, directRequirements, ports, ownedElementStructure] = await Promise.all([
    Promise.all(malfunctions.map((m) => buildBundleMalfunction(m, deps))),
    buildDirectPropagationMalfunctions(malfunctions, deps),
    getDirectRequirementsForElement(elementRef, elementUuid, deps),
    profile === 'sw_arxml' ? buildPortsForSwArxml(elementRef, deps) : Promise.resolve(undefined),
    profile === 'system_sysml' ? buildOwnedElementStructure(elementRef.nodeId, deps) : Promise.resolve(undefined),
  ]);

  // Prefer attribute-derived `name` and `stable_path`; fall back to the
  // values in `elementRef` (which the collectors already populated from
  // the same attributes on the upstream traversal).
  const bundle: ElementSafetyBundle = {
    node_id: elementRef.nodeId,
    namespace: elementRef.namespace,
    concept: instance.concept || elementRef.concept,
    name: readName(instanceAttrs) || elementRef.name,
    stable_path: readStablePath(instanceAttrs) || elementRef.stablePath,
    uuid: elementUuid,
    malfunctions: enrichedMalfunctions,
    direct_propagation_malfunctions: directPropagationMalfunctions,
    safety_notes: notes.map(toSafetyRef),
    safety_requirements: directRequirements.map(toSafetyRef),
    risk_ratings: [],
  };

  if (profile === 'sw_arxml' && ports !== undefined) {
    bundle.ports = ports;
  }
  if (profile === 'system_sysml' && ownedElementStructure !== undefined) {
    bundle.owned_element_structure = ownedElementStructure;
  }

  return bundle;
}
