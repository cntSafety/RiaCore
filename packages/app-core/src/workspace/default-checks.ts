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
 * Built-in "Check Model" definitions written to `{workingDir}/ria-data/checks.json`
 * for new (or check-less) workspaces, and merged by id into existing files by
 * `writeDefaultChecks` in `workspace-service.ts`.
 *
 * Kept as a typed TypeScript module rather than a raw .json asset because the
 * package is built with plain `tsc`, which compiles .ts but does not copy .json
 * files into `dist/`. A data module is emitted like any other source and works
 * identically in dev and in the packaged app, while giving type-checking and
 * removing the JSON-in-a-template-literal escaping.
 *
 * Each check's Cypher `query` must be read-only and return a single integer
 * column named `violation`; `$namespace` is injected automatically by the
 * check engine. `metamodel` is the allowlist of analysis metamodels the check
 * applies to (SAFETY_ANALYSIS = SW safety, SYSTEM_SAFETY_ANALYSIS = system
 * safety, MONITORING_ANALYSIS = monitoring, SOTIF_ANALYSIS = SOTIF).
 */
import type { UserCheckDefinition } from '@riacore/app-contracts';

export const DEFAULT_CHECKS: UserCheckDefinition[] = [
  {
    "id": "sa-orphaned-malfunctions",
    "name": "Orphaned malfunctions",
    "description": "Malfunctions in the safety namespace that do not have an 'occurs_at' target.",
    "severity": "Error",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' OPTIONAL MATCH (fm)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance) WHERE r.relationship = 'occurs_at' WITH fm, tgt WHERE tgt IS NULL RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "malfunction_asil": "ASIL"
      }
    ],
    "category": "Orphaned elements",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-orphaned-safety-tasks",
    "name": "Orphaned safety tasks",
    "description": "Safety tasks that are not linked from any malfunction (missing 'has_safety_tasks').",
    "severity": "Warning",
    "query": "MATCH (task:RIA_UNIV_ConceptInstance) WHERE task.namespace = $namespace AND task.concept = 'safety_task' OPTIONAL MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(task) WHERE r.relationship = 'has_safety_tasks' AND fm.concept = 'malfunction' WITH task, fm WHERE fm IS NULL RETURN task.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Orphaned elements",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-orphaned-requirements",
    "name": "Orphaned requirements",
    "description": "Requirements that are not linked from any malfunction (missing 'has_safety_requirements' or 'has_direct_requirements').",
    "severity": "Warning",
    "query": "MATCH (req:RIA_UNIV_ConceptInstance) WHERE req.namespace = $namespace AND req.concept = 'requirement' OPTIONAL MATCH (fm1:RIA_UNIV_ConceptInstance)-[r1:RIA_UNIV_INSTANCE_REL]->(req) WHERE r1.relationship = 'has_safety_requirements' AND fm1.concept = 'malfunction' WITH req, fm1 WHERE fm1 IS NULL OPTIONAL MATCH (fm2:RIA_UNIV_ConceptInstance)-[r2:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req) WHERE r2.relationship = 'has_direct_requirements' AND fm2.concept = 'malfunction' WITH req, fm2 WHERE fm2 IS NULL RETURN req.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Orphaned elements",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-orphaned-safety-notes",
    "name": "Orphaned safety notes",
    "description": "Safety notes that are not referenced by any element (intra- or cross-namespace).",
    "severity": "Hint",
    "query": "MATCH (note:RIA_UNIV_ConceptInstance) WHERE note.namespace = $namespace AND note.concept = 'safety_note' OPTIONAL MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(note) WHERE r.relationship = 'has_notes' OPTIONAL MATCH (elem2:RIA_UNIV_ConceptInstance)-[r2:RIA_UNIV_CROSSNS_INSTANCE_REL]->(note) WHERE r2.relationship = 'has_notes' WITH note, elem, elem2 WHERE elem IS NULL AND elem2 IS NULL RETURN note.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "note_text": "Note Text"
      }
    ],
    "category": "Orphaned elements",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-orphaned-review-items",
    "name": "Orphaned review items",
    "description": "Review items that are not attached via 'has_review' to any element.",
    "severity": "Warning",
    "query": "MATCH (ri:RIA_UNIV_ConceptInstance) WHERE ri.namespace = $namespace AND ri.concept = 'review_item' OPTIONAL MATCH (elem:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(ri) WHERE r.relationship = 'has_review' WITH ri, elem WHERE elem IS NULL RETURN ri.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "reviewer_verdict": "Verdict"
      }
    ],
    "category": "Orphaned elements",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-components-without-malfunctions",
    "name": "Components without malfunctions",
    "description": "Application, ECU-abstraction and CDD software components that have no associated malfunctions (no incoming 'occurs_at').",
    "severity": "Error",
    "query": "MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.concept IN ['application_swc', 'ecu_abstraction_swc', 'cdd_swc'] OPTIONAL MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(comp) WHERE r.relationship = 'occurs_at' AND fm.concept = 'malfunction' AND fm.namespace = $namespace WITH comp, count(fm) AS fmCount WHERE fmCount = 0 RETURN comp.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Structural completeness",
    "metamodel": [
      "SAFETY_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-ports-without-malfunctions",
    "name": "Ports without malfunctions",
    "description": "R-Ports and P-Ports that have no malfunctions occurring at them.",
    "severity": "Warning",
    "query": "MATCH (portRel:RIA_UNIV_RelationshipInstance) WHERE portRel.relationship IN ['has_r_port', 'has_p_port'] MATCH (comp:RIA_UNIV_ConceptInstance) WHERE comp.node_id = portRel.source_node_id AND comp.concept IN ['application_swc', 'ecu_abstraction_swc'] MATCH (port:RIA_UNIV_ConceptInstance) WHERE port.node_id = portRel.target_node_id AND port.concept IN ['r_port', 'p_port'] OPTIONAL MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(port) WHERE r.relationship = 'occurs_at' AND fm.concept = 'malfunction' AND fm.namespace = $namespace WITH port, count(fm) AS fmCount WHERE fmCount = 0 RETURN port.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Structural completeness",
    "metamodel": [
      "SAFETY_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-malfunctions-missing-asil",
    "name": "Malfunctions without ASIL",
    "description": "Malfunctions that have no ASIL set — either the attribute is absent or explicitly cleared to 'Not set' (empty).",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND (fm.attributes IS NULL OR NOT fm.attributes CONTAINS 'malfunction_asil' OR fm.attributes CONTAINS 'malfunction_asil\\\":\\\"\\\"') RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Malfunction completeness",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-component-malfunctions-missing-requirement",
    "name": "Component malfunctions without a requirement",
    "description": "Malfunctions that occur at a software component (not a port) and have no linked requirement, considering both safety-internal requirements (has_safety_requirements) and imported requirements (has_direct_requirements).",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(comp:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND oa.relationship = 'occurs_at' AND comp.concept IN ['application_swc', 'ecu_abstraction_swc', 'cdd_swc'] WITH DISTINCT fm OPTIONAL MATCH (r1:RIA_UNIV_RelationshipInstance) WHERE r1.source_node_id = fm.node_id AND r1.relationship = 'has_safety_requirements' WITH fm, count(r1) AS intraReqCount OPTIONAL MATCH (fm)-[r2:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req2:RIA_UNIV_ConceptInstance) WHERE r2.relationship = 'has_direct_requirements' WITH fm, intraReqCount, count(req2) AS crossReqCount WHERE (intraReqCount + crossReqCount) = 0 RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "malfunction_asil": "ASIL"
      }
    ],
    "category": "Malfunction completeness",
    "metamodel": [
      "SAFETY_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-malfunctions-not-reviewed",
    "name": "Malfunctions not reviewed",
    "description": "Malfunctions that have no linked review item.",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction'   AND NOT EXISTS { MATCH (rel:RIA_UNIV_RelationshipInstance) WHERE rel.source_node_id = fm.node_id AND rel.relationship = 'has_review' } RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "malfunction_asil": "ASIL"
      }
    ],
    "category": "Review coverage",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-rport-asil-below-partner-pport",
    "name": "R-Port ASIL lower than partner P-Port",
    "description": "An R-Port has a malfunction with ASIL > QM, but the connected P-Port (via assembly connector) has no malfunction or its highest ASIL is lower than the R-Port's highest ASIL. The provider must cover at least the same ASIL level as the consumer.",
    "severity": "Warning",
    "query": "MATCH (fm_r:RIA_UNIV_ConceptInstance)-[oa_r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(rport:RIA_UNIV_ConceptInstance) WHERE fm_r.namespace = $namespace AND fm_r.concept = 'malfunction' AND oa_r.relationship = 'occurs_at' AND rport.concept = 'r_port' WITH rport, max(CASE WHEN fm_r.attributes CONTAINS 'malfunction_asil\\\":\\\"D' THEN 4 WHEN fm_r.attributes CONTAINS 'malfunction_asil\\\":\\\"C' THEN 3 WHEN fm_r.attributes CONTAINS 'malfunction_asil\\\":\\\"B' THEN 2 WHEN fm_r.attributes CONTAINS 'malfunction_asil\\\":\\\"A' THEN 1 ELSE 0 END) AS rportMaxAsilRank WHERE rportMaxAsilRank > 0 MATCH (rq:RIA_UNIV_RelationshipInstance) WHERE rq.relationship = 'requester_port' AND rq.target_node_id = rport.node_id MATCH (conn:RIA_UNIV_ConceptInstance) WHERE conn.node_id = rq.source_node_id AND conn.concept = 'assembly_connector' MATCH (pv:RIA_UNIV_RelationshipInstance) WHERE pv.relationship = 'provider_port' AND pv.source_node_id = conn.node_id MATCH (pport:RIA_UNIV_ConceptInstance) WHERE pport.node_id = pv.target_node_id OPTIONAL MATCH (fm_p:RIA_UNIV_ConceptInstance)-[oa_p:RIA_UNIV_CROSSNS_INSTANCE_REL]->(pport) WHERE fm_p.namespace = $namespace AND fm_p.concept = 'malfunction' AND oa_p.relationship = 'occurs_at' WITH rport, rportMaxAsilRank, pport, max(CASE WHEN fm_p IS NULL THEN -1 WHEN fm_p.attributes CONTAINS 'malfunction_asil\\\":\\\"D' THEN 4 WHEN fm_p.attributes CONTAINS 'malfunction_asil\\\":\\\"C' THEN 3 WHEN fm_p.attributes CONTAINS 'malfunction_asil\\\":\\\"B' THEN 2 WHEN fm_p.attributes CONTAINS 'malfunction_asil\\\":\\\"A' THEN 1 ELSE 0 END) AS pportMaxAsilRank WHERE pportMaxAsilRank < rportMaxAsilRank RETURN rport.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "ASIL consistency",
    "metamodel": [
      "SAFETY_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-severity-asil-mismatch-fm",
    "name": "Risk rating severity inconsistent with malfunction ASIL",
    "description": "Malfunction has an ASIL level (A/B/C/D) but its risk rating severity is set to 'QM-Impact'. A non-QM malfunction must use 'Safety-Impact' in the risk rating.",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND (fm.attributes CONTAINS 'malfunction_asil\\\":\\\"A' OR fm.attributes CONTAINS 'malfunction_asil\\\":\\\"B' OR fm.attributes CONTAINS 'malfunction_asil\\\":\\\"C' OR fm.attributes CONTAINS 'malfunction_asil\\\":\\\"D') MATCH (r:RIA_UNIV_RelationshipInstance) WHERE r.source_node_id = fm.node_id AND r.relationship = 'has_risk_rating' MATCH (rr:RIA_UNIV_ConceptInstance) WHERE rr.node_id = r.target_node_id AND rr.concept = 'risk_rating' AND rr.attributes CONTAINS 'has_severity\\\":\\\"QM-Impact' RETURN DISTINCT fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "malfunction_asil": "ASIL"
      }
    ],
    "category": "ASIL consistency",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-mf-asil-mismatch-req-asil",
    "name": "Malfunction ASIL Level inconsistent with linked requirements ASIL Level",
    "description": "Malfunction ASIL does not match the ASIL of its linked requirements (intra-namespace 'has_safety_requirements' or cross-namespace 'has_direct_requirements'). Flags both directions: malfunction ASIL higher than the highest requirement ASIL, or malfunction ASIL lower than the highest requirement ASIL.",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' WITH fm, CASE WHEN fm.attributes CONTAINS 'malfunction_asil\\\":\\\"D' THEN 4 WHEN fm.attributes CONTAINS 'malfunction_asil\\\":\\\"C' THEN 3 WHEN fm.attributes CONTAINS 'malfunction_asil\\\":\\\"B' THEN 2 WHEN fm.attributes CONTAINS 'malfunction_asil\\\":\\\"A' THEN 1 WHEN fm.attributes CONTAINS 'malfunction_asil\\\":\\\"QM' THEN 0 ELSE -1 END AS fmRank WHERE fmRank >= 0 OPTIONAL MATCH (r1:RIA_UNIV_RelationshipInstance) WHERE r1.source_node_id = fm.node_id AND r1.relationship = 'has_safety_requirements' OPTIONAL MATCH (req1:RIA_UNIV_ConceptInstance) WHERE req1.node_id = r1.target_node_id AND req1.concept = 'requirement' OPTIONAL MATCH (fm)-[r2:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req2:RIA_UNIV_ConceptInstance) WHERE r2.relationship = 'has_direct_requirements' WITH fm, fmRank, CASE WHEN req1 IS NOT NULL THEN CASE WHEN req1.attributes CONTAINS 'req_asil\\\":\\\"D' THEN 4 WHEN req1.attributes CONTAINS 'req_asil\\\":\\\"C' THEN 3 WHEN req1.attributes CONTAINS 'req_asil\\\":\\\"B' THEN 2 WHEN req1.attributes CONTAINS 'req_asil\\\":\\\"A' THEN 1 ELSE 0 END ELSE -1 END AS intraRank, CASE WHEN req2 IS NOT NULL THEN CASE WHEN req2.attributes CONTAINS 'req_asil\\\":\\\"D' THEN 4 WHEN req2.attributes CONTAINS 'req_asil\\\":\\\"C' THEN 3 WHEN req2.attributes CONTAINS 'req_asil\\\":\\\"B' THEN 2 WHEN req2.attributes CONTAINS 'req_asil\\\":\\\"A' THEN 1 WHEN req2.attributes CONTAINS '\\\"asil\\\":\\\"D' THEN 4 WHEN req2.attributes CONTAINS '\\\"asil\\\":\\\"C' THEN 3 WHEN req2.attributes CONTAINS '\\\"asil\\\":\\\"B' THEN 2 WHEN req2.attributes CONTAINS '\\\"asil\\\":\\\"A' THEN 1 WHEN req2.attributes CONTAINS 'safety_level\\\":\\\"D' THEN 4 WHEN req2.attributes CONTAINS 'safety_level\\\":\\\"C' THEN 3 WHEN req2.attributes CONTAINS 'safety_level\\\":\\\"B' THEN 2 WHEN req2.attributes CONTAINS 'safety_level\\\":\\\"A' THEN 1 ELSE 0 END ELSE -1 END AS crossRank WITH fm, fmRank, max(intraRank) AS maxIntra, max(crossRank) AS maxCross WITH fm, fmRank, CASE WHEN maxIntra > maxCross THEN maxIntra ELSE maxCross END AS maxReqRank WHERE maxReqRank > 0 AND maxReqRank <> fmRank RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "malfunction_asil": "ASIL"
      },
      {
        "malfunction_description": "Description"
      }
    ],
    "category": "ASIL consistency",
    "metamodel": [
      "SAFETY_ANALYSIS",
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sa-malfunctions-missing-requirement",
    "name": "Malfunctions without a requirement",
    "description": "Malfunctions that have no linked requirement, considering both analysis-internal requirements (has_safety_requirements) and imported requirements (has_direct_requirements). System-level equivalent of the SW 'Component malfunctions without a requirement' check — it does not restrict the element the malfunction occurs at, since system and monitoring analyses attach malfunctions to system parts rather than software components.",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' OPTIONAL MATCH (r1:RIA_UNIV_RelationshipInstance) WHERE r1.source_node_id = fm.node_id AND r1.relationship = 'has_safety_requirements' WITH fm, count(r1) AS intraReqCount OPTIONAL MATCH (fm)-[r2:RIA_UNIV_CROSSNS_INSTANCE_REL]->(req2:RIA_UNIV_ConceptInstance) WHERE r2.relationship = 'has_direct_requirements' WITH fm, intraReqCount, count(req2) AS crossReqCount WHERE (intraReqCount + crossReqCount) = 0 RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      },
      {
        "malfunction_asil": "ASIL"
      }
    ],
    "category": "Malfunction completeness",
    "metamodel": [
      "SYSTEM_SAFETY_ANALYSIS",
      "MONITORING_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sotif-malfunctions-missing-functional-insufficiency",
    "name": "Malfunctions without functional insufficiencies",
    "description": "SOTIF malfunctions that have no linked functional insufficiency in the same namespace (at least one is required).",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND NOT EXISTS { MATCH (rel:RIA_UNIV_RelationshipInstance), (linked:RIA_UNIV_ConceptInstance) WHERE rel.source_node_id = fm.node_id AND rel.relationship = 'has_functional_insufficiencies' AND linked.node_id = rel.target_node_id AND linked.namespace = $namespace AND linked.concept = 'functional_insufficiency' } RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Malfunction completeness",
    "metamodel": [
      "SOTIF_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sotif-malfunctions-missing-triggering-condition",
    "name": "Malfunctions without triggering conditions",
    "description": "SOTIF malfunctions that have no linked triggering condition in the same namespace (at least one is required).",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND NOT EXISTS { MATCH (rel:RIA_UNIV_RelationshipInstance), (linked:RIA_UNIV_ConceptInstance) WHERE rel.source_node_id = fm.node_id AND rel.relationship = 'has_triggering_conditions' AND linked.node_id = rel.target_node_id AND linked.namespace = $namespace AND linked.concept = 'triggering_condition' } RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Malfunction completeness",
    "metamodel": [
      "SOTIF_ANALYSIS"
    ],
    "active": true
  },
  // Attributes are JSON strings; the regex handles quoted text and escaped whitespace
  // without requiring the optional JSON extension. Keep the backslash escaping intact
  // across TypeScript, Cypher and the database regex parser (covered by native DB tests).
  {
    "id": "sotif-malfunctions-missing-risk-rating-note",
    "name": "Malfunctions without a risk rating note",
    "description": "SOTIF malfunctions that have no linked risk rating with a non-blank Risk Rating Note. Missing, empty and whitespace-only notes are incomplete.",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND NOT EXISTS { MATCH (rel:RIA_UNIV_RelationshipInstance), (linked:RIA_UNIV_ConceptInstance) WHERE rel.source_node_id = fm.node_id AND rel.relationship = 'has_risk_rating' AND linked.node_id = rel.target_node_id AND linked.namespace = $namespace AND linked.concept = 'risk_rating' AND NOT regexp_matches(regexp_extract(coalesce(linked.attributes, '{}'), '\"risk_rating_note\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\\\\\\\\\\\\\]|\\\\\\\\\\\\\\\\.)*)\"', 1), '^([[:space:]]|\\\\\\\\\\\\\\\\[tnrfb])*$') } RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Malfunction completeness",
    "metamodel": [
      "SOTIF_ANALYSIS"
    ],
    "active": true
  },
  {
    "id": "sotif-malfunctions-not-reviewed",
    "name": "Malfunctions without a review verdict",
    "description": "SOTIF malfunctions that have no linked review item with a recorded verdict (OK, NOK or OK_with_comment). This checks review coverage only, not acceptance, comment resolution or review freshness.",
    "severity": "Warning",
    "query": "MATCH (fm:RIA_UNIV_ConceptInstance) WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND NOT EXISTS { MATCH (rel:RIA_UNIV_RelationshipInstance), (linked:RIA_UNIV_ConceptInstance) WHERE rel.source_node_id = fm.node_id AND rel.relationship = 'has_review' AND linked.node_id = rel.target_node_id AND linked.namespace = $namespace AND linked.concept = 'review_item' AND regexp_matches(coalesce(linked.attributes, '{}'), '\"reviewer_verdict\"[[:space:]]*:[[:space:]]*\"(OK|NOK|OK_with_comment)\"') } RETURN fm.node_id AS violation",
    "attributes": [
      {
        "has_name": "name"
      }
    ],
    "category": "Review coverage",
    "metamodel": [
      "SOTIF_ANALYSIS"
    ],
    "active": true
  }
];
