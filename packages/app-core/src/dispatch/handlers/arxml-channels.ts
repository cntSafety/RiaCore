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
  MalfunctionInfo,
  PortInfo,
  ConnectorInfo,
  PortConnectorResult,
  NamespacePortConnectorsResult,
  ComponentPortConnectorsResult,
  GetComponentPortConnectorsInput,
} from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';

const CATEGORY = 'arxml';

// ── Concept arrays ───────────────────────────────────────────────────────────

export const PORT_CONCEPTS = ['p_port', 'r_port', 'pr_port'];
export const SWC_CONCEPTS = [
  'application_swc',
  'composition_swc',
  'service_swc',
  'ecu_abstraction_swc',
  'cdd_swc',
  'sensor_actuator_swc',
  'nv_block_swc',
  'parameter_swc',
  'service_proxy_swc',
];

// ── Cypher query constants ───────────────────────────────────────────────────

/**
 * Query 1: Single port — assembly connectors (with nodeId filter)
 *
 * Every forward `INSTANCE_REL` traversal is expressed as a join through the
 * `RIA_UNIV_RelationshipInstance` node table (`source_node_id` / `target_node_id`)
 * instead of `(a)-[:RIA_UNIV_INSTANCE_REL]->(b)`. The connector is the
 * anchor, reached via the pinned port's provider/requester edge. The RETURN
 * column shape is unchanged so `transformConnectorRow` is untouched.
 */
export const SINGLE_PORT_ASSEMBLY_QUERY = `
MATCH (anchor:RIA_UNIV_RelationshipInstance)
WHERE anchor.relationship IN ['provider_port', 'requester_port'] AND anchor.target_node_id = $nodeId
MATCH (conn:RIA_UNIV_ConceptInstance)
WHERE conn.node_id = anchor.source_node_id AND conn.concept = 'assembly_connector'
MATCH (hc:RIA_UNIV_RelationshipInstance)
WHERE hc.relationship = 'has_connector' AND hc.target_node_id = conn.node_id
MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = hc.source_node_id
MATCH (pp:RIA_UNIV_RelationshipInstance)
WHERE pp.relationship = 'provider_port' AND pp.source_node_id = conn.node_id
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = pp.target_node_id
MATCH (rp:RIA_UNIV_RelationshipInstance)
WHERE rp.relationship = 'requester_port' AND rp.source_node_id = conn.node_id
MATCH (tgt:RIA_UNIV_ConceptInstance) WHERE tgt.node_id = rp.target_node_id
MATCH (sop:RIA_UNIV_RelationshipInstance)
WHERE sop.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND sop.target_node_id = src.node_id
MATCH (srcOwner:RIA_UNIV_ConceptInstance) WHERE srcOwner.node_id = sop.source_node_id
MATCH (top_:RIA_UNIV_RelationshipInstance)
WHERE top_.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND top_.target_node_id = tgt.node_id
MATCH (tgtOwner:RIA_UNIV_ConceptInstance) WHERE tgtOwner.node_id = top_.source_node_id
OPTIONAL MATCH (srcFm:RIA_UNIV_ConceptInstance)-[srcOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(src)
WHERE srcOcc.relationship = 'occurs_at' AND srcFm.concept = 'malfunction'
OPTIONAL MATCH (tgtFm:RIA_UNIV_ConceptInstance)-[tgtOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt)
WHERE tgtOcc.relationship = 'occurs_at' AND tgtFm.concept = 'malfunction'
RETURN conn.node_id AS connector_node_id,
       conn.concept AS connector_concept,
       conn.attributes AS connector_attrs,
       comp.node_id AS comp_node_id,
       comp.attributes AS comp_attrs,
       src.node_id AS src_port_node_id,
       src.concept AS src_port_concept,
       src.attributes AS src_port_attrs,
       srcOwner.node_id AS src_owner_node_id,
       srcOwner.concept AS src_owner_concept,
       srcOwner.namespace AS src_owner_namespace,
       srcOwner.attributes AS src_owner_attrs,
       tgt.node_id AS tgt_port_node_id,
       tgt.concept AS tgt_port_concept,
       tgt.attributes AS tgt_port_attrs,
       tgtOwner.node_id AS tgt_owner_node_id,
       tgtOwner.concept AS tgt_owner_concept,
       tgtOwner.namespace AS tgt_owner_namespace,
       tgtOwner.attributes AS tgt_owner_attrs,
       srcFm.node_id AS src_fm_node_id,
       srcFm.attributes AS src_fm_attrs,
       tgtFm.node_id AS tgt_fm_node_id,
       tgtFm.attributes AS tgt_fm_attrs
`;

/** Query 2: Single port — delegation connectors (with nodeId filter) */
export const SINGLE_PORT_DELEGATION_QUERY = `
MATCH (anchor:RIA_UNIV_RelationshipInstance)
WHERE anchor.relationship IN ['inner_port', 'outer_port'] AND anchor.target_node_id = $nodeId
MATCH (conn:RIA_UNIV_ConceptInstance)
WHERE conn.node_id = anchor.source_node_id AND conn.concept = 'delegation_connector'
MATCH (hc:RIA_UNIV_RelationshipInstance)
WHERE hc.relationship = 'has_connector' AND hc.target_node_id = conn.node_id
MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = hc.source_node_id
MATCH (ip:RIA_UNIV_RelationshipInstance)
WHERE ip.relationship = 'inner_port' AND ip.source_node_id = conn.node_id
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = ip.target_node_id
MATCH (op:RIA_UNIV_RelationshipInstance)
WHERE op.relationship = 'outer_port' AND op.source_node_id = conn.node_id
MATCH (tgt:RIA_UNIV_ConceptInstance) WHERE tgt.node_id = op.target_node_id
MATCH (sop:RIA_UNIV_RelationshipInstance)
WHERE sop.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND sop.target_node_id = src.node_id
MATCH (srcOwner:RIA_UNIV_ConceptInstance) WHERE srcOwner.node_id = sop.source_node_id
MATCH (top_:RIA_UNIV_RelationshipInstance)
WHERE top_.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND top_.target_node_id = tgt.node_id
MATCH (tgtOwner:RIA_UNIV_ConceptInstance) WHERE tgtOwner.node_id = top_.source_node_id
OPTIONAL MATCH (srcFm:RIA_UNIV_ConceptInstance)-[srcOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(src)
WHERE srcOcc.relationship = 'occurs_at' AND srcFm.concept = 'malfunction'
OPTIONAL MATCH (tgtFm:RIA_UNIV_ConceptInstance)-[tgtOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt)
WHERE tgtOcc.relationship = 'occurs_at' AND tgtFm.concept = 'malfunction'
RETURN conn.node_id AS connector_node_id,
       conn.concept AS connector_concept,
       conn.attributes AS connector_attrs,
       comp.node_id AS comp_node_id,
       comp.attributes AS comp_attrs,
       src.node_id AS src_port_node_id,
       src.concept AS src_port_concept,
       src.attributes AS src_port_attrs,
       srcOwner.node_id AS src_owner_node_id,
       srcOwner.concept AS src_owner_concept,
       srcOwner.namespace AS src_owner_namespace,
       srcOwner.attributes AS src_owner_attrs,
       tgt.node_id AS tgt_port_node_id,
       tgt.concept AS tgt_port_concept,
       tgt.attributes AS tgt_port_attrs,
       tgtOwner.node_id AS tgt_owner_node_id,
       tgtOwner.concept AS tgt_owner_concept,
       tgtOwner.namespace AS tgt_owner_namespace,
       tgtOwner.attributes AS tgt_owner_attrs,
       srcFm.node_id AS src_fm_node_id,
       srcFm.attributes AS src_fm_attrs,
       tgtFm.node_id AS tgt_fm_node_id,
       tgtFm.attributes AS tgt_fm_attrs
`;

/** Query 3: Namespace batch — assembly connectors (with namespace filter) */
export const NAMESPACE_ASSEMBLY_QUERY = `
MATCH (conn:RIA_UNIV_ConceptInstance)
WHERE conn.concept = 'assembly_connector' AND conn.namespace = $namespace
MATCH (hc:RIA_UNIV_RelationshipInstance)
WHERE hc.relationship = 'has_connector' AND hc.target_node_id = conn.node_id
MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = hc.source_node_id
MATCH (pp:RIA_UNIV_RelationshipInstance)
WHERE pp.relationship = 'provider_port' AND pp.source_node_id = conn.node_id
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = pp.target_node_id
MATCH (rp:RIA_UNIV_RelationshipInstance)
WHERE rp.relationship = 'requester_port' AND rp.source_node_id = conn.node_id
MATCH (tgt:RIA_UNIV_ConceptInstance) WHERE tgt.node_id = rp.target_node_id
MATCH (sop:RIA_UNIV_RelationshipInstance)
WHERE sop.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND sop.target_node_id = src.node_id
MATCH (srcOwner:RIA_UNIV_ConceptInstance) WHERE srcOwner.node_id = sop.source_node_id
MATCH (top_:RIA_UNIV_RelationshipInstance)
WHERE top_.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND top_.target_node_id = tgt.node_id
MATCH (tgtOwner:RIA_UNIV_ConceptInstance) WHERE tgtOwner.node_id = top_.source_node_id
OPTIONAL MATCH (srcFm:RIA_UNIV_ConceptInstance)-[srcOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(src)
WHERE srcOcc.relationship = 'occurs_at' AND srcFm.concept = 'malfunction'
OPTIONAL MATCH (tgtFm:RIA_UNIV_ConceptInstance)-[tgtOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt)
WHERE tgtOcc.relationship = 'occurs_at' AND tgtFm.concept = 'malfunction'
RETURN conn.node_id AS connector_node_id,
       conn.concept AS connector_concept,
       conn.attributes AS connector_attrs,
       comp.node_id AS comp_node_id,
       comp.attributes AS comp_attrs,
       src.node_id AS src_port_node_id,
       src.concept AS src_port_concept,
       src.attributes AS src_port_attrs,
       srcOwner.node_id AS src_owner_node_id,
       srcOwner.concept AS src_owner_concept,
       srcOwner.namespace AS src_owner_namespace,
       srcOwner.attributes AS src_owner_attrs,
       tgt.node_id AS tgt_port_node_id,
       tgt.concept AS tgt_port_concept,
       tgt.attributes AS tgt_port_attrs,
       tgtOwner.node_id AS tgt_owner_node_id,
       tgtOwner.concept AS tgt_owner_concept,
       tgtOwner.namespace AS tgt_owner_namespace,
       tgtOwner.attributes AS tgt_owner_attrs,
       srcFm.node_id AS src_fm_node_id,
       srcFm.attributes AS src_fm_attrs,
       tgtFm.node_id AS tgt_fm_node_id,
       tgtFm.attributes AS tgt_fm_attrs
`;

/** Query 4: Namespace batch — delegation connectors (with namespace filter) */
export const NAMESPACE_DELEGATION_QUERY = `
MATCH (conn:RIA_UNIV_ConceptInstance)
WHERE conn.concept = 'delegation_connector' AND conn.namespace = $namespace
MATCH (hc:RIA_UNIV_RelationshipInstance)
WHERE hc.relationship = 'has_connector' AND hc.target_node_id = conn.node_id
MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = hc.source_node_id
MATCH (ip:RIA_UNIV_RelationshipInstance)
WHERE ip.relationship = 'inner_port' AND ip.source_node_id = conn.node_id
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = ip.target_node_id
MATCH (op:RIA_UNIV_RelationshipInstance)
WHERE op.relationship = 'outer_port' AND op.source_node_id = conn.node_id
MATCH (tgt:RIA_UNIV_ConceptInstance) WHERE tgt.node_id = op.target_node_id
MATCH (sop:RIA_UNIV_RelationshipInstance)
WHERE sop.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND sop.target_node_id = src.node_id
MATCH (srcOwner:RIA_UNIV_ConceptInstance) WHERE srcOwner.node_id = sop.source_node_id
MATCH (top_:RIA_UNIV_RelationshipInstance)
WHERE top_.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND top_.target_node_id = tgt.node_id
MATCH (tgtOwner:RIA_UNIV_ConceptInstance) WHERE tgtOwner.node_id = top_.source_node_id
OPTIONAL MATCH (srcFm:RIA_UNIV_ConceptInstance)-[srcOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(src)
WHERE srcOcc.relationship = 'occurs_at' AND srcFm.concept = 'malfunction'
OPTIONAL MATCH (tgtFm:RIA_UNIV_ConceptInstance)-[tgtOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt)
WHERE tgtOcc.relationship = 'occurs_at' AND tgtFm.concept = 'malfunction'
RETURN conn.node_id AS connector_node_id,
       conn.concept AS connector_concept,
       conn.attributes AS connector_attrs,
       comp.node_id AS comp_node_id,
       comp.attributes AS comp_attrs,
       src.node_id AS src_port_node_id,
       src.concept AS src_port_concept,
       src.attributes AS src_port_attrs,
       srcOwner.node_id AS src_owner_node_id,
       srcOwner.concept AS src_owner_concept,
       srcOwner.namespace AS src_owner_namespace,
       srcOwner.attributes AS src_owner_attrs,
       tgt.node_id AS tgt_port_node_id,
       tgt.concept AS tgt_port_concept,
       tgt.attributes AS tgt_port_attrs,
       tgtOwner.node_id AS tgt_owner_node_id,
       tgtOwner.concept AS tgt_owner_concept,
       tgtOwner.namespace AS tgt_owner_namespace,
       tgtOwner.attributes AS tgt_owner_attrs,
       srcFm.node_id AS src_fm_node_id,
       srcFm.attributes AS src_fm_attrs,
       tgtFm.node_id AS tgt_fm_node_id,
       tgtFm.attributes AS tgt_fm_attrs
`;

/**
 * Query 4b: Fetch all ports (p_port, r_port, pr_port) of a component, with their
 * malfunctions. Used to detect ports that have no connector so they can still be
 * shown in the diagram as unconnected pins.
 *
 * Forward `has_*_port` edges resolved via `RIA_UNIV_RelationshipInstance` (`op`);
 * the owner is the pinned node and the ports are fetched by id.
 */
export const COMPONENT_ALL_PORTS_QUERY = `
MATCH (op:RIA_UNIV_RelationshipInstance)
WHERE op.source_node_id = $nodeId
  AND op.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port']
MATCH (owner:RIA_UNIV_ConceptInstance) WHERE owner.node_id = $nodeId
MATCH (port:RIA_UNIV_ConceptInstance) WHERE port.node_id = op.target_node_id
OPTIONAL MATCH (fm:RIA_UNIV_ConceptInstance)-[occ:RIA_UNIV_CROSSNS_INSTANCE_REL]->(port)
WHERE occ.relationship = 'occurs_at' AND fm.concept = 'malfunction'
RETURN port.node_id AS port_node_id,
       port.concept AS port_concept,
       port.attributes AS port_attrs,
       owner.node_id AS owner_node_id,
       owner.concept AS owner_concept,
       owner.namespace AS owner_namespace,
       owner.attributes AS owner_attrs,
       fm.node_id AS fm_node_id,
       fm.attributes AS fm_attrs
`;

/**
 * Query 5: Component batch — assembly connectors (with portIds pattern).
 * Resolves the owner's ports via `RIA_UNIV_RelationshipInstance` (`op`), then
 * every connector hop via the same node table.
 */
export const COMPONENT_ASSEMBLY_QUERY = `
MATCH (op:RIA_UNIV_RelationshipInstance)
WHERE op.source_node_id = $nodeId
  AND op.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port']
WITH collect(op.target_node_id) AS portIds
MATCH (conn:RIA_UNIV_ConceptInstance) WHERE conn.concept = 'assembly_connector'
MATCH (pp:RIA_UNIV_RelationshipInstance)
WHERE pp.relationship = 'provider_port' AND pp.source_node_id = conn.node_id
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = pp.target_node_id
MATCH (rp:RIA_UNIV_RelationshipInstance)
WHERE rp.relationship = 'requester_port' AND rp.source_node_id = conn.node_id
MATCH (tgt:RIA_UNIV_ConceptInstance)
WHERE tgt.node_id = rp.target_node_id
  AND (src.node_id IN portIds OR tgt.node_id IN portIds)
MATCH (hc:RIA_UNIV_RelationshipInstance)
WHERE hc.relationship = 'has_connector' AND hc.target_node_id = conn.node_id
MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = hc.source_node_id
MATCH (sop:RIA_UNIV_RelationshipInstance)
WHERE sop.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND sop.target_node_id = src.node_id
MATCH (srcOwner:RIA_UNIV_ConceptInstance) WHERE srcOwner.node_id = sop.source_node_id
MATCH (top_:RIA_UNIV_RelationshipInstance)
WHERE top_.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND top_.target_node_id = tgt.node_id
MATCH (tgtOwner:RIA_UNIV_ConceptInstance) WHERE tgtOwner.node_id = top_.source_node_id
OPTIONAL MATCH (srcFm:RIA_UNIV_ConceptInstance)-[srcOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(src)
WHERE srcOcc.relationship = 'occurs_at' AND srcFm.concept = 'malfunction'
OPTIONAL MATCH (tgtFm:RIA_UNIV_ConceptInstance)-[tgtOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt)
WHERE tgtOcc.relationship = 'occurs_at' AND tgtFm.concept = 'malfunction'
RETURN conn.node_id AS connector_node_id,
       conn.concept AS connector_concept,
       conn.attributes AS connector_attrs,
       comp.node_id AS comp_node_id,
       comp.attributes AS comp_attrs,
       src.node_id AS src_port_node_id,
       src.concept AS src_port_concept,
       src.attributes AS src_port_attrs,
       srcOwner.node_id AS src_owner_node_id,
       srcOwner.concept AS src_owner_concept,
       srcOwner.namespace AS src_owner_namespace,
       srcOwner.attributes AS src_owner_attrs,
       tgt.node_id AS tgt_port_node_id,
       tgt.concept AS tgt_port_concept,
       tgt.attributes AS tgt_port_attrs,
       tgtOwner.node_id AS tgt_owner_node_id,
       tgtOwner.concept AS tgt_owner_concept,
       tgtOwner.namespace AS tgt_owner_namespace,
       tgtOwner.attributes AS tgt_owner_attrs,
       srcFm.node_id AS src_fm_node_id,
       srcFm.attributes AS src_fm_attrs,
       tgtFm.node_id AS tgt_fm_node_id,
       tgtFm.attributes AS tgt_fm_attrs
`;

/**
 * Query 6: Component batch — delegation connectors (with portIds pattern).
 * Same structure as Query 5 but for delegation connectors.
 */
export const COMPONENT_DELEGATION_QUERY = `
MATCH (op:RIA_UNIV_RelationshipInstance)
WHERE op.source_node_id = $nodeId
  AND op.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port']
WITH collect(op.target_node_id) AS portIds
MATCH (conn:RIA_UNIV_ConceptInstance) WHERE conn.concept = 'delegation_connector'
MATCH (ip:RIA_UNIV_RelationshipInstance)
WHERE ip.relationship = 'inner_port' AND ip.source_node_id = conn.node_id
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = ip.target_node_id
MATCH (op2:RIA_UNIV_RelationshipInstance)
WHERE op2.relationship = 'outer_port' AND op2.source_node_id = conn.node_id
MATCH (tgt:RIA_UNIV_ConceptInstance)
WHERE tgt.node_id = op2.target_node_id
  AND (src.node_id IN portIds OR tgt.node_id IN portIds)
MATCH (hc:RIA_UNIV_RelationshipInstance)
WHERE hc.relationship = 'has_connector' AND hc.target_node_id = conn.node_id
MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = hc.source_node_id
MATCH (sop:RIA_UNIV_RelationshipInstance)
WHERE sop.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND sop.target_node_id = src.node_id
MATCH (srcOwner:RIA_UNIV_ConceptInstance) WHERE srcOwner.node_id = sop.source_node_id
MATCH (top_:RIA_UNIV_RelationshipInstance)
WHERE top_.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port'] AND top_.target_node_id = tgt.node_id
MATCH (tgtOwner:RIA_UNIV_ConceptInstance) WHERE tgtOwner.node_id = top_.source_node_id
OPTIONAL MATCH (srcFm:RIA_UNIV_ConceptInstance)-[srcOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(src)
WHERE srcOcc.relationship = 'occurs_at' AND srcFm.concept = 'malfunction'
OPTIONAL MATCH (tgtFm:RIA_UNIV_ConceptInstance)-[tgtOcc:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt)
WHERE tgtOcc.relationship = 'occurs_at' AND tgtFm.concept = 'malfunction'
RETURN conn.node_id AS connector_node_id,
       conn.concept AS connector_concept,
       conn.attributes AS connector_attrs,
       comp.node_id AS comp_node_id,
       comp.attributes AS comp_attrs,
       src.node_id AS src_port_node_id,
       src.concept AS src_port_concept,
       src.attributes AS src_port_attrs,
       srcOwner.node_id AS src_owner_node_id,
       srcOwner.concept AS src_owner_concept,
       srcOwner.namespace AS src_owner_namespace,
       srcOwner.attributes AS src_owner_attrs,
       tgt.node_id AS tgt_port_node_id,
       tgt.concept AS tgt_port_concept,
       tgt.attributes AS tgt_port_attrs,
       tgtOwner.node_id AS tgt_owner_node_id,
       tgtOwner.concept AS tgt_owner_concept,
       tgtOwner.namespace AS tgt_owner_namespace,
       tgtOwner.attributes AS tgt_owner_attrs,
       srcFm.node_id AS src_fm_node_id,
       srcFm.attributes AS src_fm_attrs,
       tgtFm.node_id AS tgt_fm_node_id,
       tgtFm.attributes AS tgt_fm_attrs
`;

/** Query 7: Port validation — used by single-port handler */
export const PORT_VALIDATION_QUERY = `
MATCH (p:RIA_UNIV_ConceptInstance)
WHERE p.node_id = $nodeId
  AND p.concept IN ['p_port', 'r_port', 'pr_port']
OPTIONAL MATCH (owner:RIA_UNIV_ConceptInstance)-[op:RIA_UNIV_INSTANCE_REL]->(p)
WHERE op.relationship IN ['has_p_port', 'has_r_port', 'has_pr_port']
RETURN p.node_id AS port_node_id,
       p.concept AS port_concept,
       p.attributes AS port_attrs,
       owner.node_id AS owner_node_id,
       owner.concept AS owner_concept,
       owner.namespace AS owner_namespace,
       owner.attributes AS owner_attrs
`;

/** Query 8: Component validation — used by component handler */
export const COMPONENT_VALIDATION_QUERY = `
MATCH (c:RIA_UNIV_ConceptInstance)
WHERE c.node_id = $nodeId
  AND c.concept IN [
    'application_swc', 'composition_swc', 'service_swc',
    'ecu_abstraction_swc', 'cdd_swc', 'sensor_actuator_swc',
    'nv_block_swc', 'parameter_swc', 'service_proxy_swc'
  ]
RETURN c.node_id AS node_id,
       c.concept AS concept,
       c.attributes AS attrs
`;

/**
 * Query 9: Component-level malfunctions — fetches malfunctions attached directly
 * to component nodes (not via ports) for a list of node IDs.
 * Used to surface component-level ASIL ratings in the port connector diagram.
 */
export const COMPONENT_MALFUNCTIONS_QUERY = `
MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(comp:RIA_UNIV_ConceptInstance)
WHERE comp.node_id IN $nodeIds
  AND r.relationship = 'occurs_at'
  AND fm.concept = 'malfunction'
RETURN comp.node_id AS owner_node_id,
       fm.node_id AS fm_node_id,
       fm.attributes AS fm_attrs
`;

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Parse a JSON attributes string and return the stable_path field.
 * Returns '' on parse error or if stable_path is absent.
 */
export function extractStablePath(attrsJson: string): string {
  try {
    const attrs = JSON.parse(attrsJson) as Record<string, unknown>;
    return (attrs.stable_path as string) ?? '';
  } catch {
    return '';
  }
}

/**
 * Extract the short name from a JSON attributes string by taking the last
 * '/'-separated segment of stable_path. Returns '' if stable_path is absent
 * or the JSON is malformed.
 */
export function extractName(attrsJson: string): string {
  const stablePath = extractStablePath(attrsJson);
  if (!stablePath) return '';
  const segments = stablePath.split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * Extract a single MalfunctionInfo from OPTIONAL MATCH columns.
 * Returns an array with 0 or 1 element. The caller merges across rows.
 * When the OPTIONAL MATCH found no malfunction, fmNodeId is null/undefined.
 */
export function extractMalfunctions(
  fmNodeId: unknown,
  fmAttrs: unknown,
): MalfunctionInfo[] {
  if (fmNodeId == null) return [];
  const attrs = (() => {
    try {
      return JSON.parse(String(fmAttrs ?? '{}')) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  return [
    {
      nodeId: fmNodeId as number,
      name: String(attrs.has_name ?? ''),
      description: String(attrs.malfunction_description ?? ''),
      asil: String(attrs.malfunction_asil ?? ''),
    },
  ];
}

/**
 * Transform a raw KuzuDB row from a connector query into a ConnectorInfo object.
 * Each row may contain malfunction data from OPTIONAL MATCH. Because a port can
 * have 0..N malfunctions, the same connector may appear in multiple rows (one per
 * malfunction combination). The caller must deduplicate by connectorNodeId and
 * merge malfunctions across rows.
 */
export function transformConnectorRow(row: Record<string, unknown>): ConnectorInfo {
  const sourcePort: PortInfo = {
    nodeId: row.src_port_node_id as number,
    portType: row.src_port_concept as 'p_port' | 'r_port' | 'pr_port',
    stablePath: extractStablePath(row.src_port_attrs as string),
    name: extractName(row.src_port_attrs as string),
    ownerNodeId: row.src_owner_node_id as number,
    ownerConcept: row.src_owner_concept as string,
    ownerNamespace: row.src_owner_namespace as string ?? '',
    ownerStablePath: extractStablePath(row.src_owner_attrs as string),
    ownerName: extractName(row.src_owner_attrs as string),
    malfunctions: extractMalfunctions(row.src_fm_node_id, row.src_fm_attrs),
  };

  const targetPort: PortInfo = {
    nodeId: row.tgt_port_node_id as number,
    portType: row.tgt_port_concept as 'p_port' | 'r_port' | 'pr_port',
    stablePath: extractStablePath(row.tgt_port_attrs as string),
    name: extractName(row.tgt_port_attrs as string),
    ownerNodeId: row.tgt_owner_node_id as number,
    ownerConcept: row.tgt_owner_concept as string,
    ownerNamespace: row.tgt_owner_namespace as string ?? '',
    ownerStablePath: extractStablePath(row.tgt_owner_attrs as string),
    ownerName: extractName(row.tgt_owner_attrs as string),
    malfunctions: extractMalfunctions(row.tgt_fm_node_id, row.tgt_fm_attrs),
  };

  return {
    connectorNodeId: row.connector_node_id as number,
    connectorType: row.connector_concept as 'assembly_connector' | 'delegation_connector',
    connectorStablePath: extractStablePath(row.connector_attrs as string),
    compositionNodeId: row.comp_node_id as number,
    compositionStablePath: extractStablePath(row.comp_attrs as string),
    sourcePort,
    targetPort,
  };
}

/**
 * Deduplicate connectors by connectorNodeId. When a port has multiple malfunctions,
 * the OPTIONAL MATCH produces multiple rows per connector. This function merges
 * malfunction arrays across duplicate rows and deduplicates malfunctions by nodeId
 * within each port.
 */
export function deduplicateAndMergeConnectors(connectors: ConnectorInfo[]): ConnectorInfo[] {
  const map = new Map<number, ConnectorInfo>();

  for (const connector of connectors) {
    const existing = map.get(connector.connectorNodeId);
    if (!existing) {
      // Deep-clone the connector so we can safely mutate malfunctions arrays
      map.set(connector.connectorNodeId, {
        ...connector,
        sourcePort: { ...connector.sourcePort, malfunctions: [...connector.sourcePort.malfunctions] },
        targetPort: { ...connector.targetPort, malfunctions: [...connector.targetPort.malfunctions] },
      });
    } else {
      // Merge source port malfunctions
      for (const fm of connector.sourcePort.malfunctions) {
        if (!existing.sourcePort.malfunctions.some(m => m.nodeId === fm.nodeId)) {
          existing.sourcePort.malfunctions.push(fm);
        }
      }
      // Merge target port malfunctions
      for (const fm of connector.targetPort.malfunctions) {
        if (!existing.targetPort.malfunctions.some(m => m.nodeId === fm.nodeId)) {
          existing.targetPort.malfunctions.push(fm);
        }
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Compute summary counts from a deduplicated ConnectorInfo array.
 */
export function buildSummary(connectors: ConnectorInfo[]): {
  totalConnectors: number;
  assemblyConnectors: number;
  delegationConnectors: number;
  uniquePorts: number;
  portsWithMalfunctions: number;
  totalMalfunctions: number;
} {
  const portIds = new Set<number>();
  const portsWithFm = new Set<number>();
  let assembly = 0;
  let delegation = 0;
  let totalFm = 0;

  for (const c of connectors) {
    if (c.connectorType === 'assembly_connector') {
      assembly++;
    } else {
      delegation++;
    }

    portIds.add(c.sourcePort.nodeId);
    portIds.add(c.targetPort.nodeId);

    if (c.sourcePort.malfunctions.length > 0) {
      portsWithFm.add(c.sourcePort.nodeId);
      totalFm += c.sourcePort.malfunctions.length;
    }
    if (c.targetPort.malfunctions.length > 0) {
      portsWithFm.add(c.targetPort.nodeId);
      totalFm += c.targetPort.malfunctions.length;
    }
  }

  return {
    totalConnectors: connectors.length,
    assemblyConnectors: assembly,
    delegationConnectors: delegation,
    uniquePorts: portIds.size,
    portsWithMalfunctions: portsWithFm.size,
    totalMalfunctions: totalFm,
  };
}

// ── Channel registration ─────────────────────────────────────────────────────

/**
 * Fetch component-level malfunctions for a set of component node IDs.
 * Returns a map from owner node_id → MalfunctionInfo[].
 * Runs a single query for all node IDs to avoid N+1 queries.
 */
async function fetchComponentMalfunctions(
  nodeIds: number[],
  dbModule: { runQuery: (q: string, p: Record<string, unknown>) => Promise<Record<string, unknown>[]> },
): Promise<Record<number, MalfunctionInfo[]>> {
  if (nodeIds.length === 0) return {};
  const rows = await dbModule.runQuery(COMPONENT_MALFUNCTIONS_QUERY, { nodeIds });
  const result: Record<number, MalfunctionInfo[]> = {};
  for (const row of rows) {
    const ownerNodeId = Number(row.owner_node_id);
    const attrs = (() => {
      try { return JSON.parse(String(row.fm_attrs ?? '{}')) as Record<string, unknown>; }
      catch { return {} as Record<string, unknown>; }
    })();
    const fm: MalfunctionInfo = {
      nodeId: Number(row.fm_node_id),
      name: String(attrs.has_name ?? ''),
      description: String(attrs.malfunction_description ?? ''),
      asil: String(attrs.malfunction_asil ?? ''),
    };
    if (!result[ownerNodeId]) result[ownerNodeId] = [];
    result[ownerNodeId].push(fm);
  }
  return result;
}

/**
 * Reusable implementation of `arxml.getComponentPortConnectors`.
 *
 * The body of the registered channel handler delegates to this helper so
 * that internal callers (such as the LLM Context_Element collector in
 * `packages/app-core/src/llm/context-collectors.ts`) can reuse the same
 * SWC-component port/connector traversal without going through a full
 * dispatcher round-trip.
 *
 * Throws an `Error` when the node does not exist or is not an SWC type,
 * matching the behaviour of the registered channel.
 *
 * @see Requirement 5.1, 6.6 (Context_Element collection reuses `arxml.*`).
 */
export async function getComponentPortConnectorsImpl(
  payload: GetComponentPortConnectorsInput,
  deps: { dbModule: { runQuery: (q: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>[]> } },
): Promise<ComponentPortConnectorsResult> {
  // Step 1: Validate that the node exists and is an SWC type
  const validationRows = await deps.dbModule.runQuery(COMPONENT_VALIDATION_QUERY, {
    nodeId: payload.nodeId,
  });

  // Step 2: If no rows returned, the node doesn't exist or isn't an SWC type
  if (validationRows.length === 0) {
    throw new Error(
      `Component not found or not an SWC type: node_id ${payload.nodeId}`,
    );
  }

  // Step 3: Build component metadata from the first validation row
  const row = validationRows[0];
  const component = {
    nodeId: Number(row.node_id),
    concept: String(row.concept),
    stablePath: extractStablePath(String(row.attrs ?? '{}')),
    name: extractName(String(row.attrs ?? '{}')),
  };

  // Step 4: Run assembly, delegation, and all-ports queries in parallel
  const [assemblyRows, delegationRows, allPortRows] = await Promise.all([
    deps.dbModule.runQuery(COMPONENT_ASSEMBLY_QUERY, { nodeId: payload.nodeId }),
    deps.dbModule.runQuery(COMPONENT_DELEGATION_QUERY, { nodeId: payload.nodeId }),
    deps.dbModule.runQuery(COMPONENT_ALL_PORTS_QUERY, { nodeId: payload.nodeId }),
  ]);

  // Step 5: Combine all rows and transform each into a ConnectorInfo
  const allConnectors = [...assemblyRows, ...delegationRows].map(transformConnectorRow);

  // Step 6: Deduplicate and merge malfunctions
  const connectors = deduplicateAndMergeConnectors(allConnectors);

  // Step 7: Compute summary
  const summary = buildSummary(connectors);

  // Step 8: Determine which ports appear in at least one connector
  const connectedPortIds = new Set<number>(
    connectors.flatMap(c => [c.sourcePort.nodeId, c.targetPort.nodeId]),
  );

  // Step 9: Build unconnectedPorts from allPortRows — deduplicate by port nodeId,
  // merge malfunctions across rows (OPTIONAL MATCH produces one row per malfunction).
  const unconnectedPortMap = new Map<number, PortInfo>();
  for (const row of allPortRows) {
    const portNodeId = Number(row.port_node_id);
    if (connectedPortIds.has(portNodeId)) continue; // already shown via a connector

    const fm = extractMalfunctions(row.fm_node_id, row.fm_attrs);
    const existing = unconnectedPortMap.get(portNodeId);
    if (!existing) {
      unconnectedPortMap.set(portNodeId, {
        nodeId: portNodeId,
        portType: row.port_concept as 'p_port' | 'r_port' | 'pr_port',
        stablePath: extractStablePath(row.port_attrs as string),
        name: extractName(row.port_attrs as string),
        ownerNodeId: Number(row.owner_node_id),
        ownerConcept: row.owner_concept as string,
        ownerNamespace: (row.owner_namespace as string) ?? '',
        ownerStablePath: extractStablePath(row.owner_attrs as string),
        ownerName: extractName(row.owner_attrs as string),
        malfunctions: fm,
      });
    } else {
      // Merge malfunctions from additional rows
      for (const m of fm) {
        if (!existing.malfunctions.some(e => e.nodeId === m.nodeId)) {
          existing.malfunctions.push(m);
        }
      }
    }
  }
  const unconnectedPorts = Array.from(unconnectedPortMap.values());

  // Step 10: Fetch component-level malfunctions for all owner nodes (center + partners)
  const ownerNodeIds = [...new Set([
    component.nodeId,
    ...connectors.flatMap(c => [c.sourcePort.ownerNodeId, c.targetPort.ownerNodeId]),
  ])];
  const componentMalfunctions = await fetchComponentMalfunctions(ownerNodeIds, deps.dbModule);

  // Step 11: Return result
  return { component, connectors, unconnectedPorts, summary, componentMalfunctions };
}

/**
 * Register all arxml.* dispatch channels.
 * Full implementations are provided in tasks 2.3–2.5.
 */
export function registerArxmlChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register(
    'arxml.getPortConnectors',
    async (payload, deps, _ctx): Promise<PortConnectorResult> => {
      // Step 1: Validate that the node exists and is a port
      const validationRows = await deps.dbModule.runQuery(PORT_VALIDATION_QUERY, {
        nodeId: payload.nodeId,
      });

      // Step 2: If no rows returned, the node doesn't exist or isn't a port
      if (validationRows.length === 0) {
        throw new Error(`Port not found: node_id ${payload.nodeId}`);
      }

      // Step 3: Build PortInfo from the first validation row
      const row = validationRows[0];
      const port: PortInfo = {
        nodeId: Number(row.port_node_id),
        portType: String(row.port_concept) as 'p_port' | 'r_port' | 'pr_port',
        stablePath: extractStablePath(String(row.port_attrs ?? '{}')),
        name: extractName(String(row.port_attrs ?? '{}')),
        ownerNodeId: row.owner_node_id != null ? Number(row.owner_node_id) : 0,
        ownerConcept: row.owner_concept != null ? String(row.owner_concept) : '',
        ownerNamespace: row.owner_namespace != null ? String(row.owner_namespace) : '',
        ownerStablePath: row.owner_attrs != null ? extractStablePath(String(row.owner_attrs)) : '',
        ownerName: row.owner_attrs != null ? extractName(String(row.owner_attrs)) : '',
        malfunctions: [],
      };

      // Step 4 & 5: Run assembly and delegation connector queries in parallel
      const [assemblyRows, delegationRows] = await Promise.all([
        deps.dbModule.runQuery(SINGLE_PORT_ASSEMBLY_QUERY, { nodeId: payload.nodeId }),
        deps.dbModule.runQuery(SINGLE_PORT_DELEGATION_QUERY, { nodeId: payload.nodeId }),
      ]);

      // Step 6: Combine all rows and transform each into a ConnectorInfo
      const allConnectors = [...assemblyRows, ...delegationRows].map(transformConnectorRow);

      // Step 7: Deduplicate and merge malfunctions
      const connectors = deduplicateAndMergeConnectors(allConnectors);

      // Step 8: Fetch component-level malfunctions for all owner nodes
      const ownerNodeIds = [...new Set(connectors.flatMap(c => [
        c.sourcePort.ownerNodeId,
        c.targetPort.ownerNodeId,
        port.ownerNodeId,
      ]))];
      const componentMalfunctions = await fetchComponentMalfunctions(ownerNodeIds, deps.dbModule);

      // Step 9: Return result
      return { port, connectors, componentMalfunctions };
    },
    { requiresWorkspace: true, category: CATEGORY },
  );

  registry.register(
    'arxml.getNamespacePortConnectors',
    async (payload, deps, _ctx): Promise<NamespacePortConnectorsResult> => {
      // Step 1 & 2: Run assembly and delegation queries in parallel
      const [assemblyRows, delegationRows] = await Promise.all([
        deps.dbModule.runQuery(NAMESPACE_ASSEMBLY_QUERY, { namespace: payload.namespace }),
        deps.dbModule.runQuery(NAMESPACE_DELEGATION_QUERY, { namespace: payload.namespace }),
      ]);

      // Step 3: Combine all rows and transform each into a ConnectorInfo
      const allConnectors = [...assemblyRows, ...delegationRows].map(transformConnectorRow);

      // Step 4: Deduplicate and merge malfunctions
      const connectors = deduplicateAndMergeConnectors(allConnectors);

      // Step 5: Compute summary
      const summary = buildSummary(connectors);

      return { namespace: payload.namespace, connectors, summary };
    },
    { requiresWorkspace: true, category: CATEGORY },
  );

  registry.register(
    'arxml.getComponentPortConnectors',
    async (payload, deps, _ctx): Promise<ComponentPortConnectorsResult> => {
      return getComponentPortConnectorsImpl(payload, deps);
    },
    { requiresWorkspace: true, category: CATEGORY },
  );
}
