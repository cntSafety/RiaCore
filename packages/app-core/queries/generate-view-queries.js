/**
 * Optional authoring tool that regenerates `view-queries.json`.
 *
 * ── Read this before using it ───────────────────────────────────────────────
 *
 * `view-queries.json` is the authoritative artifact. It ships with the software,
 * is read on demand at evaluation time, and is meant to stay hand-editable —
 * being correctable after deployment without a release is the entire point of
 * the catalog (docs/coreSpecs/RiaViews.md, "The Query Catalog"). Nothing in the
 * build runs this script.
 *
 * It exists because the CommonModel concept/relationship CASE expressions repeat
 * across all 15 entries and the canonical 12-column row shape has to be
 * identical in every UNION ALL branch. Regenerating is safer than hand-editing
 * 15 copies of the same CASE.
 *
 * **Drift warning:** this script overwrites the whole file. If you hand-edit
 * `view-queries.json`, either port the edit here or delete this script — do not
 * leave the two disagreeing. Whatever you do, `catalog-queries.test.ts`
 * validates the JSON itself and does not care how it was produced.
 *
 * Run: node packages/app-core/queries/generate-view-queries.js <repo-root>
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.argv[2];
if (!repoRoot) throw new Error('usage: node gen-view-queries.js <repo-root>');

// ---------------------------------------------------------------------------
// Canonical row shape (spec-view.md Phase 3.1.1). Every entry of every kind
// returns these twelve STRING columns in this order.
// ---------------------------------------------------------------------------
// Two notes, both learned the hard way:
//
// 1. Kuzu collapses two projections of the *same* expression into a single
//    output column, keeping the last alias. `CAST(x.node_id AS STRING) AS id`
//    beside `CAST(x.node_id AS STRING) AS source_node_id` therefore silently
//    loses `id`. Keeping `source_node_id` as INT64 makes the two expressions
//    genuinely different, and is better typed besides. A CAST to a column's
//    existing type is folded away and does NOT differentiate.
// 2. `node_id` is a SERIAL column, and SERIAL does not union with an INT64
//    literal ("has data type INT64 but SERIAL was expected"), so the
//    representative branch casts to INT64 explicitly rather than projecting
//    the column raw.
function repRow(alias, conceptExpr, nsExpr) {
  return `RETURN 'representative' AS row_type,
  CAST(${alias}.node_id AS STRING) AS id,
  ${conceptExpr} AS concept,
  ${alias}.concept AS source_concept,
  ${alias}.attributes AS attributes,
  ${nsExpr} AS source_namespace,
  CAST(${alias}.node_id AS INT64) AS source_node_id,
  '' AS source_property_path,
  '' AS sources_json,
  '' AS relationship, '' AS source_id, '' AS target_id`;
}

function relRow(relExpr, srcExpr, tgtExpr) {
  return `RETURN 'relationship' AS row_type,
  '' AS id, '' AS concept, '' AS source_concept, '' AS attributes,
  '' AS source_namespace, CAST(0 AS INT64) AS source_node_id, '' AS source_property_path, '' AS sources_json,
  ${relExpr} AS relationship, ${srcExpr} AS source_id, ${tgtExpr} AS target_id`;
}

const list = (values) => `[${values.map((v) => `'${v}'`).join(', ')}]`;

function caseExpr(alias, prop, map, indent = '  ') {
  const arms = Object.entries(map)
    .map(([from, to]) => `${indent}  WHEN '${from}' THEN '${to}'`)
    .join('\n');
  return `CASE ${alias}.${prop}\n${arms}\n${indent}END`;
}

// ---------------------------------------------------------------------------
// ARXML
// ---------------------------------------------------------------------------
const ARXML_CONCEPTS = {
  ar_package: 'StructuralElement',
  application_swc: 'ActiveElement',
  composition_swc: 'ActiveElement',
  ecu_abstraction_swc: 'ActiveElement',
  service_swc: 'ActiveElement',
  cdd_swc: 'ActiveElement',
  sensor_actuator_swc: 'ActiveElement',
  nv_block_swc: 'ActiveElement',
  parameter_swc: 'ActiveElement',
  service_proxy_swc: 'ActiveElement',
  p_port: 'OutPort',
  r_port: 'InPort',
  pr_port: 'InOutPort',
  assembly_connector: 'Connection',
  delegation_connector: 'Connection',
};
const ARXML_RELS = {
  contains_package: 'Ownership',
  contains_swc_type: 'Ownership',
  has_p_port: 'Expose',
  has_r_port: 'Expose',
  has_pr_port: 'Expose',
  provider_port: 'ConnectionSource',
  inner_port: 'ConnectionSource',
  requester_port: 'ConnectionTarget',
  outer_port: 'ConnectionTarget',
};
/**
 * ARXML models connector ownership as `composition_swc -[has_connector]-> connector`,
 * which is the opposite direction from CommonModel's `ConnectionOwner`
 * (`Connection -> Element`). It therefore cannot join `ARXML_RELS`, whose entries
 * all keep the source relation's own direction; it gets its own branch with the
 * endpoints swapped, in `whole`, in `edges`, and in traversal.
 */
const ARXML_CONNECTION_OWNER_REL = 'has_connector';

/**
 * Which source relationships each CommonModel relationship traverses.
 *
 * `invert: true` means the source relation runs opposite to the CommonModel one,
 * so an `outgoing` CommonModel walk is an `incoming` walk over the source edge.
 *
 * **Every branch is bounded at exactly one hop, including `Ownership`**
 * (spec-view.md Phase 5.1.5). Four of the five relationships are single-hop by
 * their own definition — a `Port` exposes nothing, a `Port` is the source of no
 * `ConnectionSource`, an `Element` owns no connection *through* another
 * connection — so for those the bound is exact rather than approximate.
 *
 * `Ownership` genuinely nests, and used to be emitted as a `1..20` recursive
 * pattern. That form could not be made correct:
 *
 *  - the inline lambda `(r, n | WHERE r.relationship IN [...])` does not
 *    reliably filter (it was believed to apply whenever the anchor bound a
 *    single row — it does not), so the walk returned neighbours reached over
 *    relationships of every type; and
 *  - the `ALL(rel IN rels(r) ...)` predicate that *does* filter reliably forces
 *    the matched path to be materialized, which at a 20-hop bound over a
 *    containment tree exhausts the buffer pool outright.
 *
 * There is no third option inside one query, so the recursion moved out of the
 * catalog: evaluation walks a single-hop entry once per hop, feeding each hop's
 * results in as the next hop's anchors. That is correct by construction, costs
 * one query per hop rather than one per start element, and incidentally
 * disposes of the wasted 20-hop expansion at depth 1 recorded under 3.1.8.
 */
const SINGLE_HOP = 1;

/**
 * The relationship filter that actually works.
 *
 * The inline lambda beside it is NOT reliable on its own — it is silently
 * ignored under conditions that are not worth predicting — so this explicit
 * predicate is what guarantees a walk follows only the intended relationships.
 *
 * `rels(r)` materializes the matched path, which is affordable here and only
 * here: every branch is bounded at one hop, so the list holds one element. This
 * is the reason the recursive `Ownership` bound had to go; the guard could not
 * follow it there (see {@link SINGLE_HOP}).
 *
 * `rels(r)` is required — `ALL(rel IN r ...)` fails to bind, because `r` is a
 * RECURSIVE_REL rather than a LIST.
 */
const relFilterGuard = (spec) => ` AND ALL(rel IN rels(r) WHERE rel.relationship IN ${list(spec.rels)})`;

const ARXML_TRAVERSAL = {
  Ownership: { rels: ['contains_package', 'contains_swc_type'] },
  Expose: { rels: ['has_p_port', 'has_r_port', 'has_pr_port'] },
  ConnectionSource: { rels: ['provider_port', 'inner_port'] },
  ConnectionTarget: { rels: ['requester_port', 'outer_port'] },
  ConnectionOwner: { rels: [ARXML_CONNECTION_OWNER_REL], invert: true },
};

const arxmlConcepts = Object.keys(ARXML_CONCEPTS);
const arxmlCase = (a) => caseExpr(a, 'concept', ARXML_CONCEPTS);

// ---------------------------------------------------------------------------
// SysML v2
// ---------------------------------------------------------------------------
const SYSML_CONCEPTS = {
  package: 'StructuralElement',
  library_package: 'StructuralElement',
  part_usage: 'ActiveElement',
  action_usage: 'ActiveElement',
  state_usage: 'ActiveElement',
  requirement_usage: 'Requirement',
  port_usage: 'Port',
  connection_usage: 'Connection',
};
const sysmlConcepts = Object.keys(SYSML_CONCEPTS);
const sysmlCase = (a) => caseExpr(a, 'concept', SYSML_CONCEPTS);

const SYSML_OWNABLE = ['package', 'library_package', 'part_usage', 'action_usage', 'state_usage', 'requirement_usage'];
const SYSML_STRUCTURAL = ['package', 'library_package'];
const SYSML_ACTIVE = ['part_usage', 'action_usage', 'state_usage'];

/** Anything that can own a connection_usage: a package or an active element. */
const SYSML_CONNECTION_OWNERS = [...SYSML_STRUCTURAL, ...SYSML_ACTIVE];

/**
 * Per-CommonModel-relationship traversal shape: source relation + target filter.
 * `invert: true` — as in ARXML — means the source relation runs opposite to the
 * CommonModel one, so the caller still states direction in CommonModel terms.
 */
const SYSML_TRAVERSAL = {
  Ownership: { rels: ['owns_element'], filter: `b.concept IN ${list(SYSML_OWNABLE)}` },
  Expose: { rels: ['owns_element'], filter: `b.concept = 'port_usage'` },
  ConnectionSource: { rels: ['connects'], filter: `b.concept IN ['connection_usage', 'port_usage']` },
  ConnectionTarget: { rels: ['connects'], filter: `b.concept IN ['connection_usage', 'port_usage']` },
  ConnectionOwner: { rels: ['owns_element'], filter: `b.concept IN ${list(SYSML_CONNECTION_OWNERS)}`, invert: true },
};

// ---------------------------------------------------------------------------
// Sphinx-Needs — the source metamodel is per-project dynamic (SN_<namespace>),
// so needs are resolved structurally through RIA_META_CONCEPT_SUBTYPEOF against
// `need_base` rather than by a literal concept list, and need-to-need relations
// through RIA_META_Relationship's source/target concepts.
// ---------------------------------------------------------------------------
const SN_NEED_GUARD = (alias) => `MATCH (parent:RIA_META_Concept) WHERE parent.metamodel = ${alias}.metamodel AND parent.name = 'need_base'
MATCH (child:RIA_META_Concept)-[:RIA_META_CONCEPT_SUBTYPEOF]->(parent) WHERE child.metamodel = ${alias}.metamodel AND child.name = ${alias}.concept`;

const SN_LINK_GUARD = (relAlias, riAlias) => `MATCH (${relAlias}:RIA_META_Relationship) WHERE ${relAlias}.metamodel = ${riAlias}.metamodel AND ${relAlias}.name = ${riAlias}.relationship AND ${relAlias}.source_concept = 'need_base' AND ${relAlias}.target_concept = 'need_base'`;

/** Sphinx traversal is unrolled per hop: a dynamic relationship name cannot be
 *  used inside a recursive relationship pattern, which is why MAX depth is 3. */
const SN_MAX_DEPTH = 3;

function snHop(depth, forward) {
  const lines = [];
  let prev = 'a';
  for (let i = 1; i <= depth; i++) {
    const rel = `rel${i}`, ri = `ri${i}`, n = `n${i}`;
    lines.push(`MATCH (${rel}:RIA_META_Relationship) WHERE ${rel}.metamodel = ${prev}.metamodel AND ${rel}.source_concept = 'need_base' AND ${rel}.target_concept = 'need_base'`);
    lines.push(`MATCH (${ri}:RIA_UNIV_RelationshipInstance) WHERE ${ri}.relationship = ${rel}.name AND ${ri}.metamodel = ${prev}.metamodel AND ${ri}.${forward ? 'source' : 'target'}_node_id = ${prev}.node_id`);
    lines.push(`MATCH (${n}:RIA_UNIV_ConceptInstance) WHERE ${n}.node_id = ${ri}.${forward ? 'target' : 'source'}_node_id`);
    prev = n;
  }
  lines.push(`WITH DISTINCT ${prev} AS b`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------
const entries = [];
const add = (e) => entries.push(e);

/**
 * One traversal entry per `(relationship, direction)` pair, id
 * `<base>.<Relationship>.<direction>`.
 *
 * **This is not a stylistic choice — a single entry holding every pair as
 * `UNION ALL` branches is unusable.** Every branch runs regardless of which
 * `$relationship`/`$direction` was asked for: the leading
 * `WHERE $relationship = '...'` prunes a branch's *rows*, not its execution. So
 * one pathological branch poisons every traversal, whatever it asked for.
 * Measured on a 73-node ARXML import: `Expose/outgoing` alone is 48 ms, and the
 * combined entry is 251 s followed by `Buffer manager exception: the buffer
 * pool is full`. Splitting the entries is what makes traversal work on real
 * data at all, and it also removes ~90% of the per-call planning cost.
 *
 * **Only `outgoing` and `incoming` are generated; there is no `both` entry.**
 * An *undirected* variable-length pattern is the pathological case above: at a
 * 1..20 bound it enumerates paths that zig-zag back and forth across the same
 * edges, which on a containment tree is combinatorial. `Ownership/both` was
 * that branch. Evaluation serves `both` by running the two directed entries and
 * merging, which is cheaper *and* better defined: the union of ancestors and
 * descendants, rather than everything reachable by alternating up and down.
 */
function addTraversalEntries(baseId, sourceMetamodel, traversalSpec, conceptCase, extraFilter) {
  for (const [commonRel, spec] of Object.entries(traversalSpec)) {
    for (const dir of ['outgoing', 'incoming']) {
      // `invert` flips which way the source edge is walked, so the caller always
      // states the direction in CommonModel terms.
      const walk = spec.invert ? (dir === 'outgoing' ? 'incoming' : 'outgoing') : dir;
      const bound = `1..${SINGLE_HOP}`;
      const pattern = walk === 'outgoing'
        ? `MATCH (a)-[r:RIA_UNIV_INSTANCE_REL* ${bound} (r, n | WHERE r.relationship IN ${list(spec.rels)})]->(b:RIA_UNIV_ConceptInstance)`
        : `MATCH (a)<-[r:RIA_UNIV_INSTANCE_REL* ${bound} (r, n | WHERE r.relationship IN ${list(spec.rels)})]-(b:RIA_UNIV_ConceptInstance)`;
      const filter = spec.filter ? ` AND ${spec.filter}` : (extraFilter ? ` AND ${extraFilter}` : '');
      // Two rules here, both learned the hard way:
      //  - The namespace predicate MUST live in the WITH..WHERE below, never in
      //    a WHERE attached directly to the recursive MATCH (3.1.10).
      //  - The inline lambda cannot be relied on to filter at all, so
      //    `relFilterGuard` is what actually constrains the walk. It is
      //    affordable only because the bound is one hop (5.1.5); multi-hop
      //    walks are assembled by evaluation, one hop per call.
      //
      // The `$relationship`/`$direction` guard is kept even though the entry id
      // already names the pair: it costs one constant comparison and makes a
      // mis-resolved entry return nothing rather than the wrong walk.
      add({
        id: `${baseId}.${commonRel}.${dir}`,
        description: `Walks ${commonRel} ${dir} from CommonModel representatives of ${sourceMetamodel || 'source'} elements, bounded by depth and result size. `
          + `One entry per (relationship, direction) pair: a combined entry executes every branch whatever was asked for, which makes one expensive branch fatal for all of them. `
          + `'both' is served by evaluation running this entry and its counterpart, never by an undirected pattern.`,
        sourceMetamodel,
        mode: 'traversal',
        parameters: ['representativeIds', 'relationship', 'direction', 'depth', 'maxResults', 'sourceNamespaces'],
        cypher: `UNWIND $representativeIds AS ridStr
WITH CAST(ridStr AS INT64) AS rid
WHERE $relationship = '${commonRel}' AND $direction = '${dir}'
MATCH (a:RIA_UNIV_ConceptInstance) WHERE a.node_id = rid
${pattern}
WITH DISTINCT b, r, length(r) AS hops
WHERE hops <= $depth AND b.namespace IN $sourceNamespaces${filter}${relFilterGuard(spec)}
WITH DISTINCT b
${repRow('b', conceptCase('b'), 'b.namespace')}
LIMIT $maxResults`,
      });
    }
  }
}

// ── ARXML ───────────────────────────────────────────────────────────────────
add({
  id: 'arxml.common_model.whole',
  description: 'Whole-view projection of an SW_ARXML namespace onto CommonModel: structural elements, active elements, ports, connections, and their Ownership/Expose/ConnectionSource/ConnectionTarget/ConnectionOwner relationships. ConnectionOwner is derived from has_connector with its endpoints swapped, because ARXML models it composition -> connector while CommonModel anchors it at the Connection.',
  sourceMetamodel: 'SW_ARXML',
  mode: 'whole',
  parameters: ['sourceNamespaces'],
  cypher: `UNWIND $sourceNamespaces AS ns
MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.namespace = ns AND ci.concept IN ${list(arxmlConcepts)}
${repRow('ci', arxmlCase('ci'), 'ns')}
UNION ALL
UNWIND $sourceNamespaces AS ns2
MATCH (ri:RIA_UNIV_RelationshipInstance)
WHERE ri.namespace = ns2 AND ri.relationship IN ${list(Object.keys(ARXML_RELS))}
${relRow(caseExpr('ri', 'relationship', ARXML_RELS), 'CAST(ri.source_node_id AS STRING)', 'CAST(ri.target_node_id AS STRING)')}
UNION ALL
UNWIND $sourceNamespaces AS ns3
MATCH (rio:RIA_UNIV_RelationshipInstance)
WHERE rio.namespace = ns3 AND rio.relationship = '${ARXML_CONNECTION_OWNER_REL}'
${relRow(`'ConnectionOwner'`, 'CAST(rio.target_node_id AS STRING)', 'CAST(rio.source_node_id AS STRING)')}`,
});

add({
  id: 'arxml.common_model.element',
  description: 'Resolves a single SW_ARXML source element to its CommonModel representative, without loading the rest of the namespace.',
  sourceMetamodel: 'SW_ARXML',
  mode: 'element',
  parameters: ['elementNodeId', 'sourceNamespaces'],
  cypher: `MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.node_id = $elementNodeId AND ci.namespace IN $sourceNamespaces AND ci.concept IN ${list(arxmlConcepts)}
${repRow('ci', arxmlCase('ci'), 'ci.namespace')}`,
});

add({
  id: 'arxml.common_model.elements',
  description: 'Resolves a list of SW_ARXML source elements to their CommonModel representatives, without loading the rest of the namespace.',
  sourceMetamodel: 'SW_ARXML',
  mode: 'elements',
  parameters: ['elementNodeIds', 'sourceNamespaces'],
  cypher: `UNWIND $elementNodeIds AS nid
MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.node_id = nid AND ci.namespace IN $sourceNamespaces AND ci.concept IN ${list(arxmlConcepts)}
${repRow('ci', arxmlCase('ci'), 'ci.namespace')}`,
});

addTraversalEntries('arxml.common_model.traversal', 'SW_ARXML', ARXML_TRAVERSAL, arxmlCase, null);

add({
  id: 'arxml.common_model.edges',
  description: 'Returns the CommonModel relationships whose source and target are both in $nodeIds. Completes element/elements/traversal results with their edges, which those modes cannot return themselves. ConnectionOwner is emitted with has_connector\'s endpoints swapped, matching arxml.common_model.whole.',
  sourceMetamodel: 'SW_ARXML',
  mode: 'edges',
  parameters: ['nodeIds', 'sourceNamespaces'],
  cypher: `MATCH (ri:RIA_UNIV_RelationshipInstance)
WHERE ri.namespace IN $sourceNamespaces AND ri.relationship IN ${list(Object.keys(ARXML_RELS))}
  AND ri.source_node_id IN $nodeIds AND ri.target_node_id IN $nodeIds
${relRow(caseExpr('ri', 'relationship', ARXML_RELS), 'CAST(ri.source_node_id AS STRING)', 'CAST(ri.target_node_id AS STRING)')}
UNION ALL
MATCH (rio:RIA_UNIV_RelationshipInstance)
WHERE rio.namespace IN $sourceNamespaces AND rio.relationship = '${ARXML_CONNECTION_OWNER_REL}'
  AND rio.source_node_id IN $nodeIds AND rio.target_node_id IN $nodeIds
${relRow(`'ConnectionOwner'`, 'CAST(rio.target_node_id AS STRING)', 'CAST(rio.source_node_id AS STRING)')}`,
});

// ── SysML v2 ────────────────────────────────────────────────────────────────
const sysmlOwnershipPairs = `((src.concept IN ${list(SYSML_STRUCTURAL)} AND tgt.concept IN ${list(SYSML_OWNABLE)})
       OR (src.concept IN ${list(SYSML_ACTIVE)} AND tgt.concept IN ${list(SYSML_ACTIVE)}))`;

add({
  id: 'sysml_v2.common_model.whole',
  description: 'Whole-view projection of a SysMLv2 namespace onto CommonModel. Ownership and Expose are both derived from the single generic owns_element relation, discriminated by the concept of its two endpoints (SysML v2 has no separate containment relation per pair, unlike ARXML). ConnectionSource/ConnectionTarget are derived from connects edges out of a connection_usage to its (at least two) port_usage endpoints, ordered by node_id — SysML v2\'s connects relation does not itself distinguish source from target, so the ordering is an accepted v1 simplification. Refinement and Implements are not produced: the imported SysMLv2 metamodel captures no satisfy/allocate-style relation to derive them from.',
  sourceMetamodel: 'SysMLv2',
  mode: 'whole',
  parameters: ['sourceNamespaces'],
  cypher: `UNWIND $sourceNamespaces AS ns
MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.namespace = ns AND ci.concept IN ${list(sysmlConcepts)}
${repRow('ci', sysmlCase('ci'), 'ns')}
UNION ALL
UNWIND $sourceNamespaces AS ns2
MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = ns2 AND ri.relationship = 'owns_element'
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = ri.source_node_id
MATCH (tgt:RIA_UNIV_ConceptInstance) WHERE tgt.node_id = ri.target_node_id
  AND ${sysmlOwnershipPairs}
${relRow(`'Ownership'`, 'CAST(ri.source_node_id AS STRING)', 'CAST(ri.target_node_id AS STRING)')}
UNION ALL
UNWIND $sourceNamespaces AS ns3
MATCH (ri2:RIA_UNIV_RelationshipInstance) WHERE ri2.namespace = ns3 AND ri2.relationship = 'owns_element'
MATCH (src2:RIA_UNIV_ConceptInstance) WHERE src2.node_id = ri2.source_node_id AND src2.concept = 'part_usage'
MATCH (tgt2:RIA_UNIV_ConceptInstance) WHERE tgt2.node_id = ri2.target_node_id AND tgt2.concept = 'port_usage'
${relRow(`'Expose'`, 'CAST(ri2.source_node_id AS STRING)', 'CAST(ri2.target_node_id AS STRING)')}
UNION ALL
UNWIND $sourceNamespaces AS ns4
MATCH (ri3:RIA_UNIV_RelationshipInstance) WHERE ri3.namespace = ns4 AND ri3.relationship = 'connects'
MATCH (conn:RIA_UNIV_ConceptInstance) WHERE conn.node_id = ri3.source_node_id AND conn.concept = 'connection_usage'
MATCH (endpoint:RIA_UNIV_ConceptInstance) WHERE endpoint.node_id = ri3.target_node_id AND endpoint.concept = 'port_usage'
WITH conn, min(endpoint.node_id) AS lo, count(DISTINCT endpoint.node_id) AS endpointCount
WHERE endpointCount >= 2
${relRow(`'ConnectionSource'`, 'CAST(conn.node_id AS STRING)', 'CAST(lo AS STRING)')}
UNION ALL
UNWIND $sourceNamespaces AS ns5
MATCH (ri4:RIA_UNIV_RelationshipInstance) WHERE ri4.namespace = ns5 AND ri4.relationship = 'connects'
MATCH (conn2:RIA_UNIV_ConceptInstance) WHERE conn2.node_id = ri4.source_node_id AND conn2.concept = 'connection_usage'
MATCH (endpoint2:RIA_UNIV_ConceptInstance) WHERE endpoint2.node_id = ri4.target_node_id AND endpoint2.concept = 'port_usage'
WITH conn2, max(endpoint2.node_id) AS hi2, count(DISTINCT endpoint2.node_id) AS endpointCount2
WHERE endpointCount2 >= 2
${relRow(`'ConnectionTarget'`, 'CAST(conn2.node_id AS STRING)', 'CAST(hi2 AS STRING)')}
UNION ALL
UNWIND $sourceNamespaces AS ns6
MATCH (ri5:RIA_UNIV_RelationshipInstance) WHERE ri5.namespace = ns6 AND ri5.relationship = 'owns_element'
MATCH (owner:RIA_UNIV_ConceptInstance) WHERE owner.node_id = ri5.source_node_id AND owner.concept IN ${list(SYSML_CONNECTION_OWNERS)}
MATCH (ownedConn:RIA_UNIV_ConceptInstance) WHERE ownedConn.node_id = ri5.target_node_id AND ownedConn.concept = 'connection_usage'
${relRow(`'ConnectionOwner'`, 'CAST(ri5.target_node_id AS STRING)', 'CAST(ri5.source_node_id AS STRING)')}`,
});

add({
  id: 'sysml_v2.common_model.element',
  description: 'Resolves a single SysMLv2 source element to its CommonModel representative, without loading the rest of the namespace.',
  sourceMetamodel: 'SysMLv2',
  mode: 'element',
  parameters: ['elementNodeId', 'sourceNamespaces'],
  cypher: `MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.node_id = $elementNodeId AND ci.namespace IN $sourceNamespaces AND ci.concept IN ${list(sysmlConcepts)}
${repRow('ci', sysmlCase('ci'), 'ci.namespace')}`,
});

add({
  id: 'sysml_v2.common_model.elements',
  description: 'Resolves a list of SysMLv2 source elements to their CommonModel representatives, without loading the rest of the namespace.',
  sourceMetamodel: 'SysMLv2',
  mode: 'elements',
  parameters: ['elementNodeIds', 'sourceNamespaces'],
  cypher: `UNWIND $elementNodeIds AS nid
MATCH (ci:RIA_UNIV_ConceptInstance)
WHERE ci.node_id = nid AND ci.namespace IN $sourceNamespaces AND ci.concept IN ${list(sysmlConcepts)}
${repRow('ci', sysmlCase('ci'), 'ci.namespace')}`,
});

addTraversalEntries('sysml_v2.common_model.traversal', 'SysMLv2', SYSML_TRAVERSAL, sysmlCase, null);

add({
  id: 'sysml_v2.common_model.edges',
  description: 'Returns the CommonModel relationships whose source and target are both in $nodeIds. Connection endpoint ordering matches sysml_v2.common_model.whole: min/max node_id over ALL of the connection\'s endpoints, so an edge is reported identically whether or not the other endpoint happens to be in $nodeIds.',
  sourceMetamodel: 'SysMLv2',
  mode: 'edges',
  parameters: ['nodeIds', 'sourceNamespaces'],
  cypher: `MATCH (ri:RIA_UNIV_RelationshipInstance)
WHERE ri.namespace IN $sourceNamespaces AND ri.relationship = 'owns_element'
  AND ri.source_node_id IN $nodeIds AND ri.target_node_id IN $nodeIds
MATCH (src:RIA_UNIV_ConceptInstance) WHERE src.node_id = ri.source_node_id
MATCH (tgt:RIA_UNIV_ConceptInstance) WHERE tgt.node_id = ri.target_node_id
  AND ${sysmlOwnershipPairs}
${relRow(`'Ownership'`, 'CAST(ri.source_node_id AS STRING)', 'CAST(ri.target_node_id AS STRING)')}
UNION ALL
MATCH (ri2:RIA_UNIV_RelationshipInstance)
WHERE ri2.namespace IN $sourceNamespaces AND ri2.relationship = 'owns_element'
  AND ri2.source_node_id IN $nodeIds AND ri2.target_node_id IN $nodeIds
MATCH (src2:RIA_UNIV_ConceptInstance) WHERE src2.node_id = ri2.source_node_id AND src2.concept = 'part_usage'
MATCH (tgt2:RIA_UNIV_ConceptInstance) WHERE tgt2.node_id = ri2.target_node_id AND tgt2.concept = 'port_usage'
${relRow(`'Expose'`, 'CAST(ri2.source_node_id AS STRING)', 'CAST(ri2.target_node_id AS STRING)')}
UNION ALL
MATCH (ri3:RIA_UNIV_RelationshipInstance) WHERE ri3.namespace IN $sourceNamespaces AND ri3.relationship = 'connects'
MATCH (conn:RIA_UNIV_ConceptInstance) WHERE conn.node_id = ri3.source_node_id AND conn.concept = 'connection_usage' AND conn.node_id IN $nodeIds
MATCH (endpoint:RIA_UNIV_ConceptInstance) WHERE endpoint.node_id = ri3.target_node_id AND endpoint.concept = 'port_usage'
WITH conn, min(endpoint.node_id) AS lo, count(DISTINCT endpoint.node_id) AS endpointCount
WHERE endpointCount >= 2 AND lo IN $nodeIds
${relRow(`'ConnectionSource'`, 'CAST(conn.node_id AS STRING)', 'CAST(lo AS STRING)')}
UNION ALL
MATCH (ri4:RIA_UNIV_RelationshipInstance) WHERE ri4.namespace IN $sourceNamespaces AND ri4.relationship = 'connects'
MATCH (conn2:RIA_UNIV_ConceptInstance) WHERE conn2.node_id = ri4.source_node_id AND conn2.concept = 'connection_usage' AND conn2.node_id IN $nodeIds
MATCH (endpoint2:RIA_UNIV_ConceptInstance) WHERE endpoint2.node_id = ri4.target_node_id AND endpoint2.concept = 'port_usage'
WITH conn2, max(endpoint2.node_id) AS hi2, count(DISTINCT endpoint2.node_id) AS endpointCount2
WHERE endpointCount2 >= 2 AND hi2 IN $nodeIds
${relRow(`'ConnectionTarget'`, 'CAST(conn2.node_id AS STRING)', 'CAST(hi2 AS STRING)')}
UNION ALL
MATCH (ri5:RIA_UNIV_RelationshipInstance)
WHERE ri5.namespace IN $sourceNamespaces AND ri5.relationship = 'owns_element'
  AND ri5.source_node_id IN $nodeIds AND ri5.target_node_id IN $nodeIds
MATCH (owner:RIA_UNIV_ConceptInstance) WHERE owner.node_id = ri5.source_node_id AND owner.concept IN ${list(SYSML_CONNECTION_OWNERS)}
MATCH (ownedConn:RIA_UNIV_ConceptInstance) WHERE ownedConn.node_id = ri5.target_node_id AND ownedConn.concept = 'connection_usage'
${relRow(`'ConnectionOwner'`, 'CAST(ri5.target_node_id AS STRING)', 'CAST(ri5.source_node_id AS STRING)')}`,
});

// ── Sphinx-Needs ────────────────────────────────────────────────────────────
add({
  id: 'sphinx_needs.common_model.whole',
  description: 'Whole-view projection of a Sphinx-Needs namespace onto CommonModel: every need becomes a Requirement, every need-to-need link becomes a Refinement. The source metamodel name is per-project dynamic (SN_<namespace>), so needs and links are resolved structurally through RIA_META_CONCEPT_SUBTYPEOF and RIA_META_Relationship rather than by literal name lists.',
  sourceMetamodel: '',
  mode: 'whole',
  parameters: ['sourceNamespaces'],
  cypher: `UNWIND $sourceNamespaces AS ns
MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = ns
${SN_NEED_GUARD('ci')}
${repRow('ci', `'Requirement'`, 'ns')}
UNION ALL
UNWIND $sourceNamespaces AS ns2
MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = ns2
${SN_LINK_GUARD('rel', 'ri')}
${relRow(`'Refinement'`, 'CAST(ri.source_node_id AS STRING)', 'CAST(ri.target_node_id AS STRING)')}`,
});

add({
  id: 'sphinx_needs.common_model.element',
  description: 'Resolves a single Sphinx-Needs need to its CommonModel Requirement representative, without loading the rest of the namespace.',
  sourceMetamodel: '',
  mode: 'element',
  parameters: ['elementNodeId', 'sourceNamespaces'],
  cypher: `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id = $elementNodeId AND ci.namespace IN $sourceNamespaces
${SN_NEED_GUARD('ci')}
${repRow('ci', `'Requirement'`, 'ci.namespace')}`,
});

add({
  id: 'sphinx_needs.common_model.elements',
  description: 'Resolves a list of Sphinx-Needs needs to their CommonModel Requirement representatives, without loading the rest of the namespace.',
  sourceMetamodel: '',
  mode: 'elements',
  parameters: ['elementNodeIds', 'sourceNamespaces'],
  cypher: `UNWIND $elementNodeIds AS nid
MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id = nid AND ci.namespace IN $sourceNamespaces
${SN_NEED_GUARD('ci')}
${repRow('ci', `'Requirement'`, 'ci.namespace')}`,
});

// Sphinx-Needs, like the other two, gets one entry per (relationship,
// direction) — here a single relationship, so two entries. Its hops are still
// unrolled *within* an entry, because a dynamic relationship name cannot appear
// in a recursive pattern; that unrolling is bounded by SN_MAX_DEPTH and each
// branch is a plain join, so it carries none of the recursive-expansion risk
// that made a combined entry fatal for ARXML/SysML.
for (const dir of ['outgoing', 'incoming']) {
  const branches = [];
  for (let d = 1; d <= SN_MAX_DEPTH; d++) {
    branches.push(`UNWIND $representativeIds AS ridStr
WITH CAST(ridStr AS INT64) AS rid
WHERE $relationship = 'Refinement' AND $direction = '${dir}' AND $depth >= ${d}
MATCH (a:RIA_UNIV_ConceptInstance) WHERE a.node_id = rid
${snHop(d, dir === 'outgoing')}
WHERE b.namespace IN $sourceNamespaces
${repRow('b', `'Requirement'`, 'b.namespace')}
LIMIT $maxResults`);
  }
  add({
    id: `sphinx_needs.common_model.traversal.Refinement.${dir}`,
    description: `Walks Refinement ${dir} between Sphinx-Needs needs, bounded by depth and result size. A dynamic relationship name cannot be used inside a recursive relationship pattern, so each hop is unrolled explicitly and the maximum depth is ${SN_MAX_DEPTH}. 'both' is served by evaluation running this entry and its counterpart. Edges between the returned representatives come from sphinx_needs.common_model.edges.`,
    sourceMetamodel: '',
    mode: 'traversal',
    parameters: ['representativeIds', 'relationship', 'direction', 'depth', 'maxResults', 'sourceNamespaces'],
    cypher: branches.join('\nUNION ALL\n'),
  });
}

add({
  id: 'sphinx_needs.common_model.edges',
  description: 'Returns the Refinement relationships whose source and target are both in $nodeIds. Completes element/elements/traversal results with their edges.',
  sourceMetamodel: '',
  mode: 'edges',
  parameters: ['nodeIds', 'sourceNamespaces'],
  cypher: `MATCH (ri:RIA_UNIV_RelationshipInstance)
WHERE ri.namespace IN $sourceNamespaces AND ri.source_node_id IN $nodeIds AND ri.target_node_id IN $nodeIds
${SN_LINK_GUARD('rel', 'ri')}
${relRow(`'Refinement'`, 'CAST(ri.source_node_id AS STRING)', 'CAST(ri.target_node_id AS STRING)')}`,
});

// ---------------------------------------------------------------------------
// Self-checks before writing: every branch of every entry must return the same
// twelve columns in the same order, or Kuzu rejects the UNION ALL at runtime.
// ---------------------------------------------------------------------------
const CANONICAL = ['row_type', 'id', 'concept', 'source_concept', 'attributes',
  'source_namespace', 'source_node_id', 'source_property_path', 'sources_json',
  'relationship', 'source_id', 'target_id'];

for (const entry of entries) {
  const returns = entry.cypher.split(/\bRETURN\b/).slice(1);
  if (returns.length === 0) throw new Error(`${entry.id}: no RETURN clause`);
  returns.forEach((clause, i) => {
    const head = clause.split(/\bUNION ALL\b/)[0];
    const cols = [...head.matchAll(/\bAS\s+([a-z_]+)/g)].map((m) => m[1]);
    const shape = cols.filter((c) => CANONICAL.includes(c));
    if (JSON.stringify(shape) !== JSON.stringify(CANONICAL)) {
      throw new Error(`${entry.id}: RETURN #${i + 1} shape mismatch\n  got: ${shape.join(',')}`);
    }
  });
  if (/\b(CREATE|MERGE|DELETE|SET|DROP|ALTER|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|DETACH)\b/i.test(entry.cypher)) {
    throw new Error(`${entry.id}: write-shaped statement`);
  }
  for (const p of entry.parameters) {
    if (!entry.cypher.includes('$' + p)) throw new Error(`${entry.id}: declares unused parameter '${p}'`);
  }
  for (const used of new Set([...entry.cypher.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]))) {
    if (!entry.parameters.includes(used)) throw new Error(`${entry.id}: uses undeclared parameter '${used}'`);
  }
}

const out = path.join(repoRoot, 'packages', 'app-core', 'queries', 'view-queries.json');
fs.writeFileSync(out, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
console.log(`wrote ${entries.length} entries to ${out}`);
for (const e of entries) console.log(`  ${e.id.padEnd(36)} ${e.mode.padEnd(10)} ${e.cypher.length} chars`);
