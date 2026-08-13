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
 * Predefined Cypher query templates for the Graph-Core viewer.
 *
 * Each template carries a human-readable label, the Cypher text, and an
 * optional `paramHint` that tells the UI to prompt the user for a value
 * before executing (e.g. a namespace name or element id).
 *
 * To add a new template, just append an entry to `QUERY_TEMPLATES`.
 */

export interface QueryTemplate {
  /** Short label shown in the button / dropdown. */
  label: string;
  /** Optional grouping category for future menu organisation. */
  category: 'meta' | 'universe' | 'source' | 'cross-namespace' | 'custom';
  /** Cypher query text. Use `$param` as placeholder when `paramHint` is set. */
  cypher: string;
  /**
   * When set, the UI should prompt the user for a value that replaces every
   * occurrence of `$param` in `cypher` before execution.
   */
  paramHint?: { placeholder: string; label: string };
}

export const QUERY_TEMPLATES: QueryTemplate[] = [
  // ── Meta layer ──────────────────────────────────────────────────────────────
  {
    label: 'Metamodels → Concepts',
    category: 'meta',
    cypher: 'MATCH (m:RIA_META_Metamodel)-[r:RIA_META_DEFINES_CONCEPT]->(c:RIA_META_Concept) RETURN m, r, c',
  },
  {
    label: 'Metamodels → Relationships',
    category: 'meta',
    cypher: 'MATCH (m:RIA_META_Metamodel)-[r:RIA_META_DEFINES_RELATIONSHIP]->(rel:RIA_META_Relationship) RETURN m, r, rel',
  },
  {
    label: 'Concept hierarchy',
    category: 'meta',
    cypher: 'MATCH (child:RIA_META_Concept)-[r:RIA_META_CONCEPT_SUBTYPEOF]->(parent:RIA_META_Concept) RETURN child, r, parent',
  },
  {
    label: 'Concept → Attributes',
    category: 'meta',
    cypher: 'MATCH (c:RIA_META_Concept)-[r:RIA_META_CONCEPT_ATTRIBUTE]->(a:RIA_META_NodeAttribute) RETURN c, r, a',
  },
  {
    label: 'Relationship → Source/Target',
    category: 'meta',
    cypher: 'MATCH (rel:RIA_META_Relationship)-[rs:RIA_META_REL_SOURCE]->(src:RIA_META_Concept), (rel)-[rt:RIA_META_REL_TARGET]->(tgt:RIA_META_Concept) RETURN rel, rs, src, rt, tgt',
  },

  // ── Universe layer ──────────────────────────────────────────────────────────
  {
    label: 'Namespaces → Metamodels',
    category: 'universe',
    cypher: 'MATCH (ns:RIA_UNIV_Namespace)-[r:RIA_META_DEFINEDBY]->(m:RIA_META_Metamodel) RETURN ns, r, m',
  },
  {
    label: 'Instances + rels by namespace',
    category: 'universe',
    cypher: 'MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance) WHERE a.namespace = "$param" RETURN a, r, b LIMIT 500',
    paramHint: { placeholder: 'e.g. MyNamespace', label: 'Namespace' },
  },
  {
    label: 'Instances (nodes only) by namespace',
    category: 'universe',
    cypher: 'MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = "$param" RETURN ci LIMIT 200',
    paramHint: { placeholder: 'e.g. MyNamespace', label: 'Namespace' },
  },
  {
    label: 'Element by ID',
    category: 'universe',
    cypher: 'MATCH (n:RIA_UNIV_ConceptInstance) WHERE n.node_id = $param RETURN n',
    paramHint: { placeholder: 'e.g. 42', label: 'Element node_id' },
  },
  {
    label: 'Search by attribute',
    category: 'universe',
    cypher: 'MATCH (ci:RIA_UNIV_ConceptInstance) WHERE CONTAINS(LOWER(ci.attributes), LOWER("$param")) RETURN ci LIMIT 100',
    paramHint: { placeholder: 'e.g. camCmd', label: 'Search text (name, ar_path, uuid…)' },
  },
  {
    label: 'Search + relationships',
    category: 'universe',
    cypher: 'MATCH (ci:RIA_UNIV_ConceptInstance) WHERE CONTAINS(LOWER(ci.attributes), LOWER("$param")) WITH ci OPTIONAL MATCH (ci)-[r:RIA_UNIV_INSTANCE_REL]-(other:RIA_UNIV_ConceptInstance) RETURN ci, r, other LIMIT 200',
    paramHint: { placeholder: 'e.g. camCmd', label: 'Search text (name, ar_path, uuid…)' },
  },

  // ── Cross-namespace ─────────────────────────────────────────────────────────
  {
    label: 'Cross-NS instance rels (multi-namespace only)',
    category: 'cross-namespace',
    cypher: 'MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance) RETURN a, r, b LIMIT 200',
  },
  {
    label: 'Namespace relations (multi-namespace only)',
    category: 'cross-namespace',
    cypher: 'MATCH (nr:RIA_UNIV_NamespaceRelation)-[rs:RIA_UNIV_NSR_SOURCE]->(src:RIA_UNIV_Namespace), (nr)-[rt:RIA_UNIV_NSR_TARGET]->(tgt:RIA_UNIV_Namespace) RETURN nr, rs, src, rt, tgt',
  },
  {
    label: 'Failure modes → occurs_at targets',
    category: 'cross-namespace',
    cypher: 'MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance) WHERE fm.concept = \'failure_mode\' AND r.relationship = \'occurs_at\' RETURN fm, r, tgt LIMIT 200',
  },

  // ── Source layer ────────────────────────────────────────────────────────────
  {
    label: 'Sources → Namespaces',
    category: 'source',
    cypher: 'MATCH (s:RIA_SRC_Source)-[r:RIA_SRC_TARGETS_NS]->(ns:RIA_UNIV_Namespace) RETURN s, r, ns',
  },
  {
    label: 'Import runs → Sources',
    category: 'source',
    cypher: 'MATCH (run:RIA_SRC_ImportRun)-[r:RIA_SRC_RUN_FOR]->(s:RIA_SRC_Source) RETURN run, r, s',
  },
  {
    label: 'Full source chain',
    category: 'source',
    cypher: 'MATCH (run:RIA_SRC_ImportRun)-[r1:RIA_SRC_RUN_FOR]->(s:RIA_SRC_Source)-[r2:RIA_SRC_TARGETS_NS]->(ns:RIA_UNIV_Namespace) RETURN run, r1, s, r2, ns',
  },
];

/**
 * Resolve `$param` placeholders in a template's cypher text.
 * Returns the ready-to-execute query string.
 */
export function resolveTemplate(template: QueryTemplate, paramValue?: string): string {
  if (!template.paramHint || paramValue === undefined) return template.cypher;
  return template.cypher.replaceAll('$param', paramValue);
}
