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
 * cgraph-schema.ts — the CGraph schema as this importer understands it.
 *
 * A transcription of `importer-data/metamodel/cgraph.linkml.yaml`, kept here so
 * the runtime can resolve element selection without parsing LinkML. The parser
 * lives in app-core, which sits *above* importers, so an importer cannot reach
 * it; the alternative is a second LinkML parser inside this package, which is a
 * lot of code to answer two questions.
 *
 * The risk of a transcription is drift, so `cgraph-schema.test.ts` reads the
 * vendored YAML and asserts every table below matches it: the concept list, the
 * slot list, each slot's declared domain and range, the abstract-class
 * expansions, and the schema version. A schema change that this file has not
 * been updated for fails that test rather than silently importing a wrong graph.
 */

/** Concrete, instantiable concepts — one `nodes/<name>.jsonl` file each. */
export const CGRAPH_CONCEPTS = [
  'c_component',
  'c_file',
  'c_function',
  'c_variable',
  'c_external_symbol',
  'c_parameter',
  'c_return',
  'c_member',
  'c_record',
  'c_enum',
  'c_typedef',
  'c_builtin_type',
  'c_asm_site',
  'c_indirect_call_site',
  'c_absolute_region',
] as const;

export type CgraphConcept = typeof CGRAPH_CONCEPTS[number];

/** Relationship slots — one `edges/<name>.jsonl` file each. */
export const CGRAPH_SLOTS = [
  'contains_component',
  'owns_file',
  'defines',
  'contains_asm',
  'has_return',
  'has_indirect_call_site',
  'owns_region',
  'defines_type',
  'has_parameter',
  'has_member',
  'declares_external',
  'declares_type',
  'declares',
  'includes',
  'calls',
  'calls_external',
  'takes_address_of',
  'reads',
  'writes',
  'read_writes',
  'has_type',
  'returns',
  'aliases',
  'has_member_type',
  'references',
  'registers',
  'may_read',
  'may_write',
  'may_dispatch_to',
  'binds',
  'flows_to',
  'dispatches_through',
] as const;

export type CgraphSlot = typeof CGRAPH_SLOTS[number];

/**
 * Concrete concepts each abstract class admits.
 *
 * Slot domains and ranges are frequently declared against an abstract base —
 * `declares` ranges over `c_referenceable`, `has_type` over `c_type` — so
 * deciding whether a slot is importable means expanding those bases first.
 */
export const CGRAPH_ABSTRACT_EXPANSIONS: Record<string, readonly CgraphConcept[]> = {
  c_element: CGRAPH_CONCEPTS,
  // c_member joined in 2.5.0. The expansion is what closure reads, so the
  // access slots became importable against a members-only selection the moment
  // this line changed — no access slot's declared range moved.
  // c_return and c_absolute_region joined in 2.6.0: the return port is an
  // endpoint of `binds` / `flows_to`, a fixed-address region a target of
  // `may_read` / `may_write` / `flows_to`.
  c_referenceable: [
    'c_function', 'c_variable', 'c_external_symbol', 'c_parameter', 'c_return',
    'c_member', 'c_absolute_region',
  ],
  c_symbol: ['c_function', 'c_variable'],
  c_type: ['c_record', 'c_enum', 'c_typedef', 'c_builtin_type'],
};

/** Declared `domain:` and `range:` for every slot, verbatim from the schema. */
export const CGRAPH_SLOT_ENDPOINTS: Record<CgraphSlot, { domain: string; range: string }> = {
  // Self-containment: this is what gives the namespace tree its directory
  // hierarchy. Without it every component is a root, because nothing else in
  // the schema contains a component.
  contains_component: { domain: 'c_component',    range: 'c_component' },
  owns_file:        { domain: 'c_component',      range: 'c_file' },
  defines:          { domain: 'c_file',           range: 'c_symbol' },
  contains_asm:     { domain: 'c_file',           range: 'c_asm_site' },
  // The three 2.6.0 containment slots: the return port hangs from its
  // function, an indirect call site from the function whose body holds it, and
  // a configured fixed-address region from the component that drives it.
  has_return:       { domain: 'c_function',       range: 'c_return' },
  has_indirect_call_site: { domain: 'c_function', range: 'c_indirect_call_site' },
  owns_region:      { domain: 'c_component',      range: 'c_absolute_region' },
  defines_type:     { domain: 'c_file',           range: 'c_type' },
  has_parameter:    { domain: 'c_function',       range: 'c_parameter' },
  // 2.5.0. Containment, like has_parameter: a member's parent is the record
  // that declares it, and the record is emitted only where its definition was
  // seen — so a members selection without `types` has nothing to hang from,
  // which closure enforces rather than this table.
  has_member:       { domain: 'c_record',         range: 'c_member' },
  // The two 2.4.0 containment slots. They are what give a declared-but-not-
  // defined node a place in the tree: without them every external symbol and
  // every type whose definition is outside the corpus is a root, which on a
  // full ECU build was 1 317 roots against the 3 the generator intends.
  // Emitted only where the corresponding `defines` / `defines_type` edge is
  // absent, so containment stays single-valued.
  declares_external: { domain: 'c_file',          range: 'c_external_symbol' },
  declares_type:    { domain: 'c_file',           range: 'c_type' },
  declares:         { domain: 'c_file',           range: 'c_referenceable' },
  includes:         { domain: 'c_file',           range: 'c_file' },
  calls:            { domain: 'c_function',       range: 'c_function' },
  calls_external:   { domain: 'c_function',       range: 'c_external_symbol' },
  takes_address_of: { domain: 'c_function',       range: 'c_referenceable' },
  reads:            { domain: 'c_function',       range: 'c_referenceable' },
  writes:           { domain: 'c_function',       range: 'c_referenceable' },
  read_writes:      { domain: 'c_function',       range: 'c_referenceable' },
  has_type:         { domain: 'c_referenceable',  range: 'c_type' },
  returns:          { domain: 'c_function',       range: 'c_type' },
  aliases:          { domain: 'c_typedef',        range: 'c_type' },
  has_member_type:  { domain: 'c_record',         range: 'c_type' },
  references:       { domain: 'c_variable',       range: 'c_referenceable' },
  registers:        { domain: 'c_variable',       range: 'c_referenceable' },
  // 2.6.0 value-analysis facts. Declared ranges are deliberately broad
  // (`c_referenceable`); the schema narrows the real targets in prose — e.g.
  // `may_read` never targets a parameter or member — which closure cannot see.
  may_read:         { domain: 'c_function',       range: 'c_referenceable' },
  may_write:        { domain: 'c_function',       range: 'c_referenceable' },
  may_dispatch_to:  { domain: 'c_indirect_call_site', range: 'c_referenceable' },
  // 2.6.0 data flow between functions through ports. `binds` is an AST fact,
  // `flows_to` a value-analysis fact.
  binds:            { domain: 'c_function',       range: 'c_referenceable' },
  flows_to:         { domain: 'c_referenceable',  range: 'c_referenceable' },
  // 2.6.0 AST fact: the member, variable or parameter a function pointer is
  // read from at an indirect call site.
  dispatches_through: { domain: 'c_indirect_call_site', range: 'c_referenceable' },
};

/**
 * Schema version vendored in this package.
 *
 * The importer accepts any generator output whose major version matches, which
 * is why the minor history below has all been absorbed without a metamodel
 * rename:
 *   2.6.0  The value-analysis layer. Added `c_return`, `c_indirect_call_site`
 *          and `c_absolute_region`; the containment slots `has_return`,
 *          `has_indirect_call_site` and `owns_region`; the AST facts `binds`
 *          and `dispatches_through`; and the value-analysis facts `may_read`,
 *          `may_write`, `may_dispatch_to` and `flows_to`. Value-analysis facts
 *          are sound over-approximations within an analysis unit; which
 *          analyser produced them is in the manifest's `value_analysis`
 *          block, which the runtime logs. Additive, no identity change for an
 *          existing node — but like 2.4.0/2.5.0 the new containment slots need
 *          version-aware re-registration before the tree can use them.
 *          `c_variable` now also covers block-scope statics (new identity
 *          shape `file::function::name`, new nodes only), and three attributes
 *          were added (`c_variable.is_volatile`, `c_function.analysis_reached`,
 *          `c_external_symbol.has_contract`), which pass through unchanged.
 *   2.5.0  Added `c_member` and the containment slot `has_member`, and widened
 *          `reads`/`writes`/`read_writes` in practice by admitting a member as
 *          an access target. Only the concept, the slot and the
 *          `c_referenceable` expansion change below; the three access slots
 *          already declared `c_referenceable` as their range, so nothing about
 *          them moved. Like 2.4.0 this is additive but NOT absorbable by
 *          moving the pin alone — `has_member` needs a
 *          `RIA_META_Relationship` row before `is_containment` exists for it,
 *          which version-aware re-registration now handles.
 *          Shipped with two generator corrections that need no schema change:
 *          `*(&E)` resolves to `E`, and a transparent wrapper is stripped to
 *          its first expression child. Output carries fewer
 *          `takes_address_of` edges and more access edges than 2.4.1 did.
 *   2.4.1  Generator corrections only; no schema shape change.
 *   2.4.0  Added `declares_external` and `declares_type`, the containment
 *          slots for a symbol or a type whose definition is outside the
 *          corpus. Additive in the schema, but NOT absorbable by simply
 *          moving the pin: a new slot has to reach the registered metamodel
 *          before `is_containment` exists for it, which is why
 *          `registerMetamodelFromSchema` now re-registers on a version
 *          change instead of skipping by name. A workspace that imports 2.4.0
 *          output against a metamodel registered at 2.3.0 loads the edges and
 *          still shows the orphans, because nothing told the tree these two
 *          slots are containment.
 *   2.3.0  Reversed the 2.1.0 invariant that `reads`/`writes`/`read_writes`
 *          never target a `c_parameter`. They now do, for the accessing
 *          function's own parameters. No table below changes: the declared
 *          range was already `c_referenceable`, which expands to include
 *          `c_parameter`, so only the generator's invariant moved. Output
 *          carries access edges that did not exist before.
 *   2.2.0  Added `contains_component`, the self-containment slot the tree uses
 *          to nest components by directory.
 *   2.1.0  Widened `reads`/`writes`/`read_writes` from `c_variable` to
 *          `c_referenceable`; marked the `c_located` mixin abstract.
 * All are additive, so output from an older 2.x generator still imports — it
 * simply carries no `contains_component`, `declares_external`, `declares_type`
 * or `has_member` edges, and the tree is correspondingly flatter. Output from a
 * pre-2.6 generator carries no value-analysis collections; absent collections
 * with no manifest count are not an error.
 */
export const CGRAPH_SCHEMA_NAME = 'CGraph';
export const CGRAPH_SCHEMA_VERSION = '2.6.0';
export const CGRAPH_SCHEMA_MAJOR = 2;

/** Metamodel name registered in the graph. Carries the major version only. */
export const CGRAPH_METAMODEL_NAME = 'CGraphV2';

/** Expand an abstract class to its concrete concepts; a concrete name maps to itself. */
export function expandConcepts(className: string): readonly CgraphConcept[] {
  const expansion = CGRAPH_ABSTRACT_EXPANSIONS[className];
  if (expansion) return expansion;
  return (CGRAPH_CONCEPTS as readonly string[]).includes(className)
    ? [className as CgraphConcept]
    : [];
}
