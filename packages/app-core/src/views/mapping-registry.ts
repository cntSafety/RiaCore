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
 * Mapping_Registry — resolves a view's `mapping` attribute to the catalog
 * entry ids that serve each evaluation mode (docs/coreSpecs/RiaViews.md,
 * CoreArchPrinciples.md — "mirroring how IImporterRegistry resolves importers
 * by source type").
 *
 * Phase 3 built-in mappings (ARXML, SysML v2, Sphinx-Needs) are registered by
 * `registerBuiltInMappings()` in `./builtin-mappings.js`. Tests may still
 * register fixture mappings directly against an empty registry.
 */
import type { EvaluationMode } from '@riacore/app-contracts';

/**
 * A single raw `representative` row as returned by a catalog Cypher query,
 * before shaping.
 */
export interface RawRepresentativeRow {
  /** The immediate-metamodel concept the catalog query resolved (may be a
   *  placeholder the shaper refines further — e.g. an abstract concept whose
   *  concrete subtype depends on an attribute value). */
  concept: string;
  /** The source element's own concept name (`RIA_UNIV_ConceptInstance.concept`). */
  sourceConcept: string;
  /** `JSON.parse(RIA_UNIV_ConceptInstance.attributes)` of the source element. */
  rawAttributes: Record<string, unknown>;
}

/** What a shaper resolves a raw representative row into. */
export interface ShapedRepresentative {
  concept: string;
  attributes: Record<string, unknown>;
}

/**
 * Reshapes a source element's opaque attributes JSON into the immediate
 * metamodel's attribute shape, and may refine a placeholder concept into its
 * concrete form (e.g. SysML v2's `Port` -> `InPort`/`OutPort`/`InOutPort` by
 * inspecting the source element's `direction` attribute).
 *
 * Procedural, not Cypher: `RIA_UNIV_ConceptInstance.attributes` is an opaque
 * JSON-string column, and the query engine has no built-in JSON parsing
 * without installing a network-fetched extension — a transformation Cypher
 * genuinely cannot express (docs/coreSpecs/RiaViews.md — "Procedural mapping
 * code is permitted only where a transformation cannot be expressed as a
 * query").
 */
export type AttributeShaper = (row: RawRepresentativeRow) => ShapedRepresentative;

export interface MappingDescriptor {
  id: string;
  description?: string;
  /**
   * The metamodel every source namespace of a view using this mapping must
   * have. Checked at create/update time so a mapping cannot be pointed at a
   * namespace it cannot read — which would otherwise evaluate to silently
   * empty content (spec-view.md Phase 3.1.5).
   */
  sourceMetamodel?: string;
  /**
   * Used instead of {@link sourceMetamodel} when the source metamodel name is
   * per-project dynamic (Sphinx-Needs names it `SN_<namespace>`). A regex
   * source string, anchored by the author. A mapping with neither field
   * imposes no constraint on its sources.
   */
  sourceMetamodelPattern?: string;
  /**
   * The immediate metamodel this mapping produces content for — `COMMON_MODEL`
   * for every v1 mapping. Used to resolve a mapping automatically when an
   * ad-hoc evaluation names its target metamodel and source namespaces but not
   * a mapping, which is what keeps registry knowledge out of consumers.
   * A mapping omitting it is never auto-resolved and must be named explicitly.
   */
  targetMetamodel?: string;
  /** Which catalog entry id serves each evaluation mode. */
  queryIdByMode: Partial<Record<EvaluationMode, string>>;
  /**
   * Catalog entry returning the relationships among an already-resolved set of
   * representatives. `element`, `elements`, and `traversal` resolve nodes only;
   * evaluation completes their results with this query, without which a
   * consumer receives a flat bag of representatives and cannot build a tree
   * (spec-view.md Phase 3.1.1). Takes `nodeIds` and `sourceNamespaces`.
   */
  edgeQueryId?: string;
  /**
   * Highest traversal depth this mapping's catalog query can actually serve.
   * Defaults to {@link DEFAULT_MAX_TRAVERSAL_DEPTH}. Sphinx-Needs is lower
   * because a dynamic relationship name cannot appear in a recursive pattern,
   * so its hops are unrolled explicitly. Evaluation clamps to this and reports
   * the clamp as a diagnostic rather than silently truncating.
   */
  maxTraversalDepth?: number;
  /** See {@link AttributeShaper}. Omitted mappings pass raw attributes through unchanged. */
  shapeAttributes?: AttributeShaper;
}

/**
 * Ceiling on traversal depth.
 *
 * It was originally the highest bound a *recursive* catalog pattern could
 * honour: Kuzu rejects a parameter inside a variable-length bound, so the bound
 * was the literal `1..20`, and a bound near 30 carries a ~400x performance
 * cliff. Catalog entries are single-hop now and evaluation walks depth one hop
 * per call (spec-view.md Phase 5.1.5), so the number no longer describes a
 * query limit — it caps how many round trips one traversal request may cost,
 * which is what a bound is for either way.
 */
export const DEFAULT_MAX_TRAVERSAL_DEPTH = 20;

export interface IMappingRegistry {
  register(descriptor: MappingDescriptor): void;
  resolve(mappingId: string): MappingDescriptor | undefined;
  listAvailable(): MappingDescriptor[];
}

export function createMappingRegistry(): IMappingRegistry {
  const mappings = new Map<string, MappingDescriptor>();

  return {
    register(descriptor: MappingDescriptor): void {
      mappings.set(descriptor.id, descriptor);
    },
    resolve(mappingId: string): MappingDescriptor | undefined {
      return mappings.get(mappingId);
    },
    listAvailable(): MappingDescriptor[] {
      return [...mappings.values()];
    },
  };
}
