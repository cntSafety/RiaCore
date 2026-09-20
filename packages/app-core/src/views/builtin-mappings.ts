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
 * Phase 3 built-in mappings — ARXML, SysML v2, and Sphinx-Needs projected onto
 * `CommonModel` (docs/coreSpecs/RiaViews.md, spec-view.md — "Phase 3: Mapping
 * Functions").
 *
 * Each mapping pairs a query-catalog id per evaluation mode (see
 * `packages/app-core/queries/view-queries.json`) with an {@link AttributeShaper}
 * that reshapes a source element's opaque `attributes` JSON into CommonModel's
 * attribute shape — a step the catalog Cypher cannot do itself, because
 * `RIA_UNIV_ConceptInstance.attributes` is an unparsed JSON-string column and
 * the query engine's JSON support requires installing a network-fetched
 * extension (rejected here to keep evaluation working offline).
 */
import type { IMappingRegistry, RawRepresentativeRow, ShapedRepresentative } from './mapping-registry.js';
import { COMMON_MODEL_METAMODEL } from './common-model-rules.js';

export const ARXML_MAPPING_ID = 'arxml-common-model';
export const SYSML_V2_MAPPING_ID = 'sysml-v2-common-model';
export const SPHINX_NEEDS_MAPPING_ID = 'sphinx-needs-common-model';

export const ARXML_QUERY_IDS = {
  whole: 'arxml.common_model.whole',
  element: 'arxml.common_model.element',
  elements: 'arxml.common_model.elements',
  traversal: 'arxml.common_model.traversal',
} as const;

export const SYSML_V2_QUERY_IDS = {
  whole: 'sysml_v2.common_model.whole',
  element: 'sysml_v2.common_model.element',
  elements: 'sysml_v2.common_model.elements',
  traversal: 'sysml_v2.common_model.traversal',
} as const;

export const SPHINX_NEEDS_QUERY_IDS = {
  whole: 'sphinx_needs.common_model.whole',
  element: 'sphinx_needs.common_model.element',
  elements: 'sphinx_needs.common_model.elements',
  traversal: 'sphinx_needs.common_model.traversal',
} as const;

/** Edges among an already-resolved representative set — see `MappingDescriptor.edgeQueryId`. */
export const ARXML_EDGE_QUERY_ID = 'arxml.common_model.edges';
export const SYSML_V2_EDGE_QUERY_ID = 'sysml_v2.common_model.edges';
export const SPHINX_NEEDS_EDGE_QUERY_ID = 'sphinx_needs.common_model.edges';

/**
 * Sphinx-Needs traversal cannot use a recursive relationship pattern: the
 * relationship name is per-project dynamic and is resolved through
 * `RIA_META_Relationship` at query time, which a recursive pattern's filter
 * cannot do. Each hop is therefore unrolled as its own UNION ALL branch, and
 * the catalog stops at three.
 */
export const SPHINX_NEEDS_MAX_TRAVERSAL_DEPTH = 3;

/**
 * The SysML v2 catalog queries test `concept IN $connectionConcepts` rather than
 * naming `connection_usage` outright, and this is what binds that parameter:
 * `connection_usage` plus every subtype of it the source namespace's metamodel
 * declares (see `MappingDescriptor.conceptGroups`).
 *
 * SysML has four such subtypes across the two importers — `interface_usage`,
 * `allocation_usage`, `flow_usage` and `binding_connector_as_usage` — and each was
 * previously absent from the projection simply because the Cypher spelled out
 * one name. A `flow` declaration therefore imported as a node with endpoints and
 * still drew nothing. Resolving the set from the metamodel means the next
 * subtype anyone adds is projected without a Cypher edit.
 */
export const SYSML_V2_CONCEPT_GROUPS = {
  connectionConcepts: 'connection_usage',
} as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * ARXML: `name` <- `short_name`, `qualified_name` <- `stable_path` (the ARXML
 * importer's only two identity-bearing attributes on every concept — see
 * `sw-arxml.linkml.yaml`'s `named_element` mixin and `arxml-mapper.ts`).
 * `kind` <- the raw ARXML concept name, preserving the discriminator the CASE
 * expression in the catalog Cypher collapsed away (RiaViews.md — "`kind` is
 * where that distinction survives").
 */
export function shapeArxmlAttributes(row: RawRepresentativeRow): ShapedRepresentative {
  const name = asString(row.rawAttributes.short_name);
  const qualifiedName = asString(row.rawAttributes.stable_path);
  switch (row.concept) {
    case 'StructuralElement':
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '', kind: 'package' } };
    case 'ActiveElement':
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '', kind: row.sourceConcept } };
    case 'InPort':
    case 'OutPort':
    case 'InOutPort':
      return { concept: row.concept, attributes: { name, kind: row.sourceConcept } };
    case 'Connection':
      return { concept: row.concept, attributes: { name, kind: row.sourceConcept } };
    default:
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '' } };
  }
}

/**
 * SysML v2: `name` <- `declared_name` (falling back to `name`, mirroring the
 * importer's own `display_identifier_attrs: [declared_name, name]`),
 * `qualified_name` <- `qualified_name`. Port direction is resolved here from
 * the source element's `direction` attribute ('in'/'out'/'inout') — the
 * catalog Cypher can only emit the placeholder concept `'Port'`, because
 * choosing among InPort/OutPort/InOutPort requires reading a JSON attribute
 * value, which is exactly the transformation Cypher cannot express (the open
 * point flagged in spec-view.md: "Port direction must be derived per source
 * metamodel").
 *
 * Qualified endpoints are projected in the query catalog, not in this shaper.
 * Their representative ID is the lowest imported endpoint Feature node_id for
 * that owner/pin pair; their attributes and source reference come from the
 * declared pin. Several connections therefore share a pin, while two usages of
 * the same definition remain distinct. A directly owned pin keeps its original
 * ID. Nothing is written to the model.
 *
 * That covers two kinds of endpoint, because the catalog resolves both through
 * one rule. A connection end (`battery.dcPowerPort`) names a port. A flow end
 * (`convertDcToThreePhase.dcPower`) names a *feature inside* its container — an
 * action definition's parameter or a port definition's item — so the pin is that
 * feature, and it reaches this shaper as a `Port` like any other. Which is why
 * the direction lookup above matters more than it looks: a parameter's `in`/`out`
 * is the only thing that makes a flow render with a direction at all.
 */
export function shapeSysmlV2Attributes(row: RawRepresentativeRow): ShapedRepresentative {
  const name = asString(row.rawAttributes.declared_name) || asString(row.rawAttributes.name);
  const qualifiedName = asString(row.rawAttributes.qualified_name);
  if (row.concept === 'Port') {
    const direction = asString(row.rawAttributes.direction).toLowerCase();
    const resolvedConcept = direction === 'in' ? 'InPort' : direction === 'out' ? 'OutPort' : 'InOutPort';
    return { concept: resolvedConcept, attributes: { name, kind: row.sourceConcept } };
  }
  switch (row.concept) {
    case 'StructuralElement':
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '', kind: 'package' } };
    case 'ActiveElement':
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '', kind: row.sourceConcept } };
    case 'Requirement': {
      const text = asString(row.rawAttributes.body);
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '', requirement_id: qualifiedName, text } };
    }
    case 'Connection':
      return { concept: row.concept, attributes: { name, kind: row.sourceConcept } };
    default:
      return { concept: row.concept, attributes: { name, qualified_name: qualifiedName, description: '' } };
  }
}

/**
 * Sphinx-Needs: static v1 mapping (spec-view.md — "start with the
 * implementation of a static mapping function"). `name` <- `title`, falling
 * back to `id` when a need has no title. `requirement_id` <- `id`, `text` <-
 * `content` (the Sphinx-Needs body field — see `needs.json`). The source
 * concept names (`need_req`, `need_test`, ...) are per-project dynamic
 * (`sn-core/schema-generator.ts`), which is why the catalog Cypher resolves
 * them structurally via `RIA_META_CONCEPT_SUBTYPEOF` rather than a literal
 * list, and this shaper needs no concept refinement — every matched row is
 * already `Requirement`.
 */
export function shapeSphinxNeedsAttributes(row: RawRepresentativeRow): ShapedRepresentative {
  const id = asString(row.rawAttributes.id);
  const title = asString(row.rawAttributes.title) || id;
  const text = asString(row.rawAttributes.content);
  return { concept: row.concept, attributes: { name: title, qualified_name: id, description: '', requirement_id: id, text } };
}

/**
 * Registers the Phase 3 built-in mappings. Call once per `IMappingRegistry`
 * instance — `createMappingRegistry()` ships empty so that tests can register
 * fixture mappings without pulling in these production ones.
 */
export function registerBuiltInMappings(registry: IMappingRegistry): void {
  registry.register({
    id: ARXML_MAPPING_ID,
    description: 'Projects an SW_ARXML namespace onto CommonModel (structural elements, active elements, ports, connections).',
    sourceMetamodel: 'SW_ARXML',
    targetMetamodel: COMMON_MODEL_METAMODEL,
    queryIdByMode: ARXML_QUERY_IDS,
    edgeQueryId: ARXML_EDGE_QUERY_ID,
    shapeAttributes: shapeArxmlAttributes,
  });
  registry.register({
    id: SYSML_V2_MAPPING_ID,
    description: 'Projects a SysMLv2 namespace onto CommonModel (packages, part/action/state definitions and usages, ports, connections, requirements). ' +
      'Matches both the JSON importer (metamodel \'SysMLv2\') and the textual importer (\'SysMLv2Textual\'): the two importers ' +
      'populate the same concept and relationship names (see sysml-v2.linkml.yaml / sysml-v2-textual.linkml.yaml), so one mapping ' +
      'reads both, by metamodel-name pattern rather than an exact match.',
    sourceMetamodelPattern: '^SysMLv2',
    targetMetamodel: COMMON_MODEL_METAMODEL,
    queryIdByMode: SYSML_V2_QUERY_IDS,
    edgeQueryId: SYSML_V2_EDGE_QUERY_ID,
    conceptGroups: { ...SYSML_V2_CONCEPT_GROUPS },
    shapeAttributes: shapeSysmlV2Attributes,
  });
  registry.register({
    id: SPHINX_NEEDS_MAPPING_ID,
    description: 'Projects a Sphinx-Needs namespace onto CommonModel (every need as a Requirement, every need-to-need link as a Refinement). ' +
      'Source metamodel name is per-project dynamic (SN_<namespace>), so it is matched by pattern rather than by an exact name.',
    sourceMetamodelPattern: '^SN_',
    targetMetamodel: COMMON_MODEL_METAMODEL,
    queryIdByMode: SPHINX_NEEDS_QUERY_IDS,
    edgeQueryId: SPHINX_NEEDS_EDGE_QUERY_ID,
    maxTraversalDepth: SPHINX_NEEDS_MAX_TRAVERSAL_DEPTH,
    shapeAttributes: shapeSphinxNeedsAttributes,
  });
}
