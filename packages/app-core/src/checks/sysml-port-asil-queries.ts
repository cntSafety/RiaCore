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
import type { UserCheckDefinition } from '@riacore/app-contracts';

// One read-only statement captures the graph facts used by the shared evaluator.
// Keep rule logic in TypeScript: nested aggregation/list lambdas in the former
// query could lose valid endpoints when unresolved connectors shared a batch.
const scope = `MATCH (fm:RIA_UNIV_ConceptInstance)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(target:RIA_UNIV_ConceptInstance)
WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND oa.relationship = 'occurs_at'
  AND target.metamodel IN ['SysMLv2', 'SysMLv2Textual']
WITH DISTINCT target.namespace AS architecture`;
const assessment = `${scope}
MATCH (n:RIA_UNIV_ConceptInstance) WHERE n.namespace = architecture
RETURN 'node' AS rowType, CAST(n.node_id AS INT64) AS sourceId, -1 AS targetId,
  n.namespace AS namespace, n.concept AS concept, n.attributes AS attributes, '' AS relationship
UNION ALL
${scope}
MATCH (s:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(t:RIA_UNIV_ConceptInstance)
WHERE s.namespace = architecture AND t.namespace = architecture
  AND r.relationship IN ['references_source', 'references_target', 'connects', 'chains_feature', 'owns_element', 'has_type', 'has_definition', 'specializes']
RETURN 'edge' AS rowType, CAST(s.node_id AS INT64) AS sourceId, CAST(t.node_id AS INT64) AS targetId,
  s.namespace AS namespace, s.concept AS concept, '{}' AS attributes, r.relationship AS relationship
UNION ALL
MATCH (fm:RIA_UNIV_ConceptInstance)-[oa:RIA_UNIV_CROSSNS_INSTANCE_REL]->(target:RIA_UNIV_ConceptInstance)
WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND oa.relationship = 'occurs_at'
  AND target.metamodel IN ['SysMLv2', 'SysMLv2Textual']
RETURN 'allocation' AS rowType, CAST(fm.node_id AS INT64) AS sourceId, CAST(target.node_id AS INT64) AS targetId,
  target.namespace AS namespace, fm.concept AS concept, fm.attributes AS attributes, oa.relationship AS relationship`;

export const SYSML_PORT_ASIL_CHECKS: UserCheckDefinition[] = [
  {
    id: 'sa-sysml-port-asil-consistency',
    name: 'SysML producer port ASIL below connected consumer',
    description: 'Connected consumer ports whose analyzed ASIL is higher than their producer. Details show both endpoints and allocations. Uses only this safety analysis and applies each port maximum to supported transfers. Run the coverage check too; missing or unsupported analysis is reported separately.',
    severity: 'Warning',
    evaluator: 'sysml-port-asil-consistency',
    query: assessment,
    attributes: [{ check_affected: 'Affected connection' }, { check_assessment: 'Assessment' }, { check_message: 'Explanation' }],
    category: 'ASIL consistency', metamodel: ['SAFETY_ANALYSIS'], active: true,
  },
  {
    id: 'sa-sysml-port-asil-incomplete',
    name: 'SysML port ASIL coverage: connections not assessed',
    description: 'Connections that could not be assessed in architectures linked to this safety analysis. Results distinguish missing or invalid port analysis, unresolved endpoints or direction, and unsupported connections. These are coverage findings, not confirmed ASIL mismatches.',
    severity: 'Warning',
    evaluator: 'sysml-port-asil-incomplete',
    resultKind: 'coverage',
    query: assessment,
    attributes: [{ check_affected: 'Affected connection' }, { check_assessment: 'Assessment' }, { check_message: 'Explanation' }],
    category: 'ASIL consistency', metamodel: ['SAFETY_ANALYSIS'], active: true,
  },
];
