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
 * DTOs for the RIA_UNIV_View concept (docs/coreSpecs/RiaViews.md).
 *
 * A view is a named, saved, metamodel-typed virtual projection over one or more
 * source namespaces. Content is never stored; only the definition crosses the IPC
 * boundary as data, evaluation results are computed on demand and session-scoped.
 *
 * These types cross the IPC boundary, so they are defined here in app-contracts.
 * app-core imports them from `@riacore/app-contracts`; app-contracts must never
 * depend on app-core.
 */

/** The four first-class evaluation modes (RiaViews.md — Evaluation Modes). */
export type EvaluationMode = 'whole' | 'element' | 'elements' | 'traversal';

/**
 * What a catalog entry may serve. `'edges'` is a catalog-internal query kind,
 * not a public evaluation mode: `element`, `elements`, and `traversal` resolve
 * representatives but cannot also return the relationships between them, so
 * evaluation completes those results with a mapping's `edges` entry. It is
 * deliberately absent from {@link EvaluationMode}, which stays at four values,
 * so `EvaluateViewParams.mode` cannot name it.
 */
export type QueryCatalogEntryMode = EvaluationMode | 'edges';

export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

/**
 * A view definition — the only thing about a view that is ever persisted.
 * `parameters` is the mapping-specific recipe (scope, filters, depth, element
 * selection); together with `mapping` it is the complete recipe for recomputing
 * content, so no view content is ever stored.
 */
export interface ViewDefinition {
  /** Primary key. Unique across both views and namespaces. */
  name: string;
  /** Empty string when not human-visible. */
  description: string;
  /** Denormalized immediate metamodel name (RIA_UNIV_VIEW_DEFINEDBY target). */
  metamodel: string;
  /** Identifier of the mapping that computes this view's content. */
  mapping: string;
  /** Mapping parameters — scope, filters, depth, element selection. */
  parameters: Record<string, unknown>;
  /** Source namespace names (RIA_UNIV_VIEW_SOURCE). At least one. */
  sources: string[];
  /** Categorizational metamodel names (RIA_UNIV_VIEW_CATEGORIZEDBY). May be empty. */
  categorizedBy: string[];
}

export interface CreateViewParams {
  name: string;
  description?: string;
  metamodel: string;
  mapping: string;
  parameters?: Record<string, unknown>;
  sources: string[];
  categorizedBy?: string[];
}

/**
 * Changing `name` or `metamodel` is identity-bearing and is handled as
 * delete-and-create by the service; both are accepted here for that reason.
 */
export interface UpdateViewParams {
  name: string;
  newName?: string;
  description?: string;
  metamodel?: string;
  mapping?: string;
  parameters?: Record<string, unknown>;
  sources?: string[];
  categorizedBy?: string[];
}

/** `{ namespace, node_id, property_path? }` — traceability back to the source element. */
export interface SourceReference {
  namespace: string;
  nodeId: number;
  propertyPath?: string;
}

/**
 * A computed element of a view's content. Direct representatives have exactly one
 * `sources` entry with no `propertyPath`; abstracted representatives have zero or
 * more, each optionally with a `propertyPath`. Never a stored node.
 */
export interface Representative {
  /** Unique within the evaluation result. For a direct representative, the source node_id. */
  id: string;
  /** The concept (of the view's immediate metamodel) this representative instantiates. */
  concept: string;
  attributes: Record<string, unknown>;
  sources: SourceReference[];
  /** Inherited from sources, filtered to metamodels declared via categorizedBy. */
  categories: string[];
}

/** A relationship between two representatives in the same evaluation result. */
export interface RepresentativeRelationship {
  relationship: string;
  sourceRepresentativeId: string;
  targetRepresentativeId: string;
}

export interface EvaluationResult {
  representatives: Representative[];
  relationships: RepresentativeRelationship[];
  /** Non-fatal issues encountered during evaluation (e.g. an omitted invalid ownership edge). */
  diagnostics: string[];
}

/**
 * An unsaved view definition, evaluated without ever being persisted.
 *
 * A view's content is virtual by design, so evaluating one requires nothing
 * beyond the recipe — metamodel, mapping, sources, parameters. Naming that
 * recipe inline lets a consumer that has a namespace but no saved view (the
 * connection view opens from a tree selection, not from a view) evaluate it
 * without a write: `views.evaluate` acquires no write lock, and an implicitly
 * created view would both fail in a read-only workspace and add a row to
 * `ria-data/universe/` on mere browsing.
 *
 * Validated exactly as a persisted definition is — the mapping must resolve and
 * must be able to read every source namespace's metamodel — so an ad-hoc
 * definition cannot do anything a saved one could not.
 */
export interface AdHocViewDefinition {
  /** Immediate metamodel, e.g. `COMMON_MODEL`. Must exist. */
  metamodel: string;
  /**
   * Mapping identifier. Must resolve in the mapping registry when given.
   *
   * Omit it and the service resolves the single registered mapping that
   * produces `metamodel` content and can read every source namespace, failing
   * with a named error when none or several qualify. That is the normal case
   * for a consumer that has a namespace and a target metamodel but no reason
   * to know which mapping connects them.
   */
  mapping?: string;
  /** Source namespace names. At least one. */
  sources: string[];
  /** Categorizational metamodel names. May be omitted. */
  categorizedBy?: string[];
  /** Mapping parameters, bound as `p_<key>` exactly as for a saved view. */
  parameters?: Record<string, unknown>;
}

export interface EvaluateViewParams {
  /**
   * Name of a saved view. Omit it and supply {@link definition} instead to
   * evaluate an unsaved definition. Exactly one of the two is required.
   */
  view?: string;
  /** An unsaved definition to evaluate. Exactly one of this and `view` is required. */
  definition?: AdHocViewDefinition;
  /**
   * Capability-probe mode for an ad-hoc definition with an implicit mapping.
   * When no registered mapping can read the source metamodel(s), return an
   * empty successful evaluation instead of throwing. Explicit mappings, saved
   * views, ambiguous mappings, and all other failures remain errors.
   */
  allowUnavailableMapping?: boolean;
  mode: EvaluationMode;
  /** 'element' mode: the single source node id to resolve. */
  elementNodeId?: number;
  /** 'elements' mode: the source node ids to resolve. */
  elementNodeIds?: number[];
  /** 'traversal' mode: representative ids to start from. */
  representativeIds?: string[];
  /** 'traversal' mode: the CommonModel (or immediate-metamodel) relationship to walk. */
  relationship?: string;
  direction?: TraversalDirection;
  depth?: number;
  /** Bounded result size, applied inside the query. */
  maxResults?: number;
}

export interface MaterializeViewParams {
  view: string;
  targetNamespace: string;
  withSourceLinks: boolean;
}

export interface MaterializeResult {
  targetNamespace: string;
  metamodel: string;
  representativesWritten: number;
  relationshipsWritten: number;
  sourceLinksWritten: number;
}

/**
 * One entry in the JSON query catalog. Not compiled into the software — read on
 * demand at evaluation time from a shipped file, optionally overridden whole-entry
 * by a repository-provided catalog of the same `id`.
 */
export interface QueryCatalogEntry {
  id: string;
  description: string;
  /** Empty when the mapping's source metamodel name is per-project dynamic. */
  sourceMetamodel: string;
  mode: QueryCatalogEntryMode;
  parameters: string[];
  cypher: string;
}
