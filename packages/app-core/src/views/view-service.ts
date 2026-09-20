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
 * IViewService — view definition CRUD, evaluation, and materialization
 * (docs/coreSpecs/RiaViews.md). Never writes view content to the graph;
 * evaluation is a pure read, materialization is the one deliberate write path.
 */
import type {
  Result,
  ViewDefinition,
  CreateViewParams,
  UpdateViewParams,
  EvaluateViewParams,
  EvaluationResult,
  Representative,
  RepresentativeRelationship,
  SourceReference,
  MaterializeViewParams,
  MaterializeResult,
  TraversalDirection,
} from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import type { IMappingRegistry, MappingDescriptor } from './mapping-registry.js';
import { DEFAULT_MAX_TRAVERSAL_DEPTH, createMappingRegistry } from './mapping-registry.js';
import { registerBuiltInMappings } from './builtin-mappings.js';
import { COMMON_MODEL_METAMODEL, isPermittedOwnership } from './common-model-rules.js';
import { loadCatalog, resolveQuery, resolveQuerySeries, WRITE_STATEMENT_PATTERN, type ResolvedQuery } from './query-catalog.js';
import { createOrReplaceNamespace } from '../importers/import-write-service.js';
import { batchInsertNodes, createInstanceRelEdges, createCrossNsInstanceRelEdges } from '../persistor/persistor-helpers.js';

export interface IViewService {
  listViews(): Promise<Result<ViewDefinition[]>>;
  getView(name: string): Promise<Result<ViewDefinition>>;
  createView(params: CreateViewParams): Promise<Result<ViewDefinition>>;
  updateView(params: UpdateViewParams): Promise<Result<ViewDefinition>>;
  deleteView(name: string): Promise<Result<void>>;
  /**
   * `workingDir` locates the repository query-catalog override — never crosses IPC.
   * Evaluates either a saved view (`params.view`) or an unsaved definition
   * supplied inline (`params.definition`); exactly one of the two is required.
   * Read-only either way — an ad-hoc definition is never written to the graph.
   */
  evaluateView(workingDir: string, params: EvaluateViewParams): Promise<Result<EvaluationResult>>;
  materializeView(workingDir: string, params: MaterializeViewParams): Promise<Result<MaterializeResult>>;
  /**
   * Ensure every imported namespace that a mapping can read has a default view
   * over it, creating the missing ones. Idempotent, so it is safe to call on
   * every workspace open and after every import.
   *
   * A namespace whose metamodel no mapping reads is skipped silently — that is
   * not an error, just a source `CommonModel` has no projection for yet.
   *
   * Returns the views it created (not the ones that already existed).
   */
  ensureDefaultViews(): Promise<Result<ViewDefinition[]>>;
}

/**
 * Name of the default view over an imported namespace. Deterministic, so
 * `ensureDefaultViews` recognises its own earlier work and a consumer can
 * predict the name; suffixed rather than bare because a view's name must be
 * unique across *both* views and namespaces.
 */
export function defaultViewNameFor(namespace: string): string {
  return `${namespace} Model`;
}

/**
 * Seed default views using a self-contained view service.
 *
 * Deliberately takes only an `IDbModule`, so it can be called from the layers
 * every entry point actually shares — workspace open and import completion —
 * rather than from the dispatcher. The CLI builds its own services and calls
 * `workspaceService.open()` and `orchestration.runImport()` directly, never
 * going through a channel, so a dispatcher-level hook covers the desktop app
 * and silently misses the CLI. That is exactly how `views list` came to report
 * nothing after a CLI import.
 *
 * Best-effort by contract: it logs and returns rather than throwing, because
 * neither opening a workspace nor completing an import may fail on account of
 * view seeding.
 */
export async function seedDefaultViews(
  dbModule: IDbModule,
  logger?: ImportLogger,
  label = 'seedDefaultViews',
): Promise<void> {
  try {
    const registry = createMappingRegistry();
    registerBuiltInMappings(registry);
    const result = await createViewService(registry, dbModule, logger).ensureDefaultViews();
    if (!result.ok) {
      logger?.warn?.(`${label}: default view seeding failed: ${result.error}`);
    } else if (result.data.length > 0) {
      logger?.info?.(`${label}: created default view(s): ${result.data.map((v) => v.name).join(', ')}`);
    }
  } catch (err) {
    logger?.warn?.(`${label}: default view seeding failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RESERVED_CATEGORIZATIONAL_METAMODEL = COMMON_MODEL_METAMODEL;

/** Applied when a traversal request omits depth/maxResults, so a bound is always in force. */
const DEFAULT_TRAVERSAL_DEPTH = 10;
const DEFAULT_MAX_RESULTS = 1000;

/**
 * A view parameter key becomes the query parameter `p_<key>`, so it has to be
 * a legal Cypher parameter name.
 */
const PARAMETER_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * How many start elements one traversal query may anchor on (spec-view.md
 * Phase 5.1.3). Only entries carrying the explicit `ALL(rel IN rels(r) ...)`
 * guard are batched at all; the chunk keeps one bound parameter list from
 * growing without limit when a consumer walks from a very large set.
 */
const TRAVERSAL_ANCHOR_CHUNK = 256;

/**
 * The explicit, engine-behaviour-independent relationship guard a single-hop
 * catalog branch carries (spec-view.md Phase 5.1.5).
 *
 * Its presence is what makes a *multi-anchor* traversal safe. The inline
 * `(r, n | WHERE ...)` lambda of a variable-length pattern cannot be relied on
 * to filter — Phase 4.0 believed it applied whenever the anchor bound a single
 * row, and that turned out to be wrong too — whereas this predicate is an
 * ordinary `WHERE` and always applies. An entry carrying it can therefore be
 * issued once for a whole chunk of start elements; an entry without it is
 * issued one anchor per call, which is the most that can be done for it.
 */
const EXPLICIT_RELATIONSHIP_GUARD = /ALL\s*\(\s*rel\s+IN\s+rels\s*\(/i;

/**
 * A variable-length pattern bounded at exactly one hop.
 *
 * Such an entry answers "the neighbours one step away", so a walk deeper than
 * one step is assembled by *evaluation* — running the entry once per hop, with
 * each hop's results as the next hop's anchors — rather than by a recursive
 * bound inside the query. See {@link EXPLICIT_RELATIONSHIP_GUARD} for why a
 * recursive bound could not be made to filter correctly, and the generator
 * comment on `SINGLE_HOP` for the full reasoning.
 *
 * An entry that bounds its own depth some other way — Sphinx-Needs unrolls its
 * hops explicitly, because a dynamic relationship name cannot appear in a
 * recursive pattern — matches neither shape and is called exactly once, with
 * `$depth` left for it to interpret.
 */
const SINGLE_HOP_PATTERN = /RIA_UNIV_INSTANCE_REL\*\s*1\.\.1\s/;

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** Values the query engine can bind. Nested objects cannot be bound at all. */
function isBindableParameterValue(value: unknown): boolean {
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    const elementType = typeof value[0];
    if (elementType !== 'string' && elementType !== 'number' && elementType !== 'boolean') return false;
    return value.every((element) => typeof element === elementType);
  }
  return false;
}

/**
 * Rejects a `parameters` object that could not be bound at evaluation time, so
 * an unusable view is never persisted in the first place.
 */
function validateParameters(parameters: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(parameters)) {
    if (!PARAMETER_KEY_PATTERN.test(key)) {
      return `View parameter key '${key}' is invalid: keys are bound as the query parameter 'p_${key}' and must match ${PARAMETER_KEY_PATTERN.source}`;
    }
    if (!isBindableParameterValue(value)) {
      return `View parameter '${key}' must be a string, number, boolean, or a homogeneous array of those — other values cannot be bound as query parameters`;
    }
  }
  return null;
}

/**
 * Whether a mapping can actually read a source namespace. Without this a view
 * pairing, say, the ARXML mapping with a SysML namespace is accepted and then
 * evaluates to silently empty content.
 */
function mappingSourceMismatch(descriptor: MappingDescriptor, namespace: string, namespaceMetamodel: string): string | null {
  if (descriptor.sourceMetamodel !== undefined) {
    return namespaceMetamodel === descriptor.sourceMetamodel
      ? null
      : `Mapping '${descriptor.id}' reads '${descriptor.sourceMetamodel}' namespaces, but source namespace '${namespace}' has metamodel '${namespaceMetamodel}'`;
  }
  if (descriptor.sourceMetamodelPattern !== undefined) {
    return new RegExp(descriptor.sourceMetamodelPattern).test(namespaceMetamodel)
      ? null
      : `Mapping '${descriptor.id}' reads namespaces whose metamodel matches /${descriptor.sourceMetamodelPattern}/, but source namespace '${namespace}' has metamodel '${namespaceMetamodel}'`;
  }
  // A mapping declaring neither imposes no constraint on its sources.
  return null;
}

/**
 * Reads a representative's source references from a catalog row.
 *
 * The direct case — one source, no property path, which is every representative
 * every v1 mapping produces — travels in typed columns. `sources_json` is used
 * only by an abstracted representative, which may stand for zero or several
 * source elements and may carry property paths.
 */
function readSourceReferences(row: Record<string, unknown>): SourceReference[] {
  const json = String(row.sources_json ?? '');
  if (json !== '') {
    const parsed = JSON.parse(json) as Array<{ namespace: string; node_id: number; property_path?: string }>;
    return parsed.map((source) => ({
      namespace: source.namespace,
      nodeId: Number(source.node_id),
      propertyPath: source.property_path,
    }));
  }
  const namespace = String(row.source_namespace ?? '');
  if (namespace === '') return [];
  const propertyPath = String(row.source_property_path ?? '');
  return [{
    namespace,
    nodeId: Number(row.source_node_id),
    propertyPath: propertyPath === '' ? undefined : propertyPath,
  }];
}

export function createViewService(
  mappingRegistry: IMappingRegistry,
  dbModule: IDbModule,
  logger?: ImportLogger,
): IViewService {
  type MappingResolution =
    | { mapping: string }
    | { error: string; kind: 'source_missing' | 'unavailable' | 'ambiguous' };
  const MAPPING_UNAVAILABLE = Symbol('mapping-unavailable');

  /**
   * What an evaluation resolved its definition to, plus any work already done
   * that a later step would otherwise repeat.
   */
  type EvaluationTarget = {
    view: ViewDefinition;
    /**
     * Source namespace -> its metamodel, present only for an ad-hoc definition
     * (whose validation reads exactly these rows). Absent for a saved view.
     */
    namespaceMetamodels?: Map<string, string>;
  };

  async function namespaceOrViewNameTaken(name: string): Promise<boolean> {
    const rows = await dbModule.runQuery(
      `OPTIONAL MATCH (v:RIA_UNIV_View) WHERE v.name = $name
       OPTIONAL MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $name
       RETURN count(v) + count(ns) AS cnt`,
      { name },
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  }

  async function metamodelExists(name: string): Promise<boolean> {
    const rows = await dbModule.runQuery(
      `MATCH (mm:RIA_META_Metamodel) WHERE mm.name = $name RETURN count(mm) AS cnt`,
      { name },
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  }

  async function namespaceExists(name: string): Promise<boolean> {
    const rows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $name RETURN count(ns) AS cnt`,
      { name },
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  }

  /** The namespace's immediate metamodel, or `null` when it does not exist. */
  async function namespaceMetamodel(name: string): Promise<string | null> {
    const rows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $name RETURN ns.metamodel AS metamodel`,
      { name },
    );
    return rows.length === 0 ? null : String(rows[0].metamodel ?? '');
  }

  /**
   * Everything a definition check needs to know about names, in ONE query:
   * which of `namespaces` exist and with what immediate metamodel, and which of
   * `metamodels` exist.
   *
   * Folded together because every `runQuery` opens, prepares on, and closes its
   * own connection — roughly 6 ms of fixed cost each, regardless of how little
   * data comes back. Validating an ad-hoc definition asked three of these
   * separately, two of which re-read what the first had already fetched, so a
   * nine-evaluation walk paid that overhead twenty-seven times
   * (spec-view.md Phase 5.1.1).
   */
  async function resolveNames(
    namespaces: string[],
    metamodels: string[],
  ): Promise<{ namespaceMetamodels: Map<string, string>; existingMetamodels: Set<string> }> {
    const namespaceMetamodels = new Map<string, string>();
    const existingMetamodels = new Set<string>();
    if (namespaces.length === 0 && metamodels.length === 0) {
      return { namespaceMetamodels, existingMetamodels };
    }
    // Kuzu requires identical column lists across UNION ALL branches, so both
    // branches project `kind`/`name`/`metamodel`; an empty list simply matches
    // nothing rather than needing the branch to be dropped.
    const rows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name IN $namespaces
       RETURN 'namespace' AS kind, ns.name AS name, ns.metamodel AS metamodel
       UNION ALL
       MATCH (mm:RIA_META_Metamodel) WHERE mm.name IN $metamodels
       RETURN 'metamodel' AS kind, mm.name AS name, '' AS metamodel`,
      { namespaces, metamodels },
    );
    for (const row of rows) {
      if (String(row.kind) === 'namespace') namespaceMetamodels.set(String(row.name), String(row.metamodel ?? ''));
      else existingMetamodels.add(String(row.name));
    }
    return { namespaceMetamodels, existingMetamodels };
  }

  /**
   * Resolve a mapping's {@link MappingDescriptor.conceptGroups} into query
   * parameters: each base concept becomes the set containing itself plus every
   * transitive subtype of it, as declared by the metamodels of the view's own
   * source namespaces.
   *
   * This is what lets a catalog query test `ci.concept IN $connectionConcepts`
   * rather than spell out `'connection_usage', 'interface_usage',
   * 'flow_usage', ...`. The literal list is the bug: a metamodel that
   * declares a new subtype — SysML v2's flow and allocation connections are
   * exactly this case — is silently dropped from the projection, and nothing
   * reports it, because a concept the query never names simply produces no rows.
   *
   * The closure is walked here rather than in Cypher on purpose. The edges are
   * `RIA_META_CONCEPT_SUBTYPEOF` between `RIA_META_Concept` nodes, so a
   * recursive pattern would express it, but every catalog query is a long chain
   * of `UNION ALL` branches that cannot share a `WITH`: the resolution would be
   * repeated per branch, joining the meta layer against every projected row.
   * One flat read of the metamodel's subtype edges plus a walk over a handful of
   * names costs a single query for the whole evaluation instead.
   *
   * Scoped to the source namespaces' metamodels because concept names are
   * metamodel-local: two metamodels may both declare `connection_usage` without
   * agreeing on what specialises it.
   */
  async function resolveConceptGroups(
    conceptGroups: Record<string, string> | undefined,
    sources: string[],
    /**
     * The source namespaces' metamodels, when the caller has already resolved
     * them. `resolveEvaluationTarget` reads exactly these rows to validate an
     * ad-hoc definition, so re-reading them here cost every evaluation a second
     * round trip for an answer it was already holding.
     */
    knownNamespaceMetamodels?: Map<string, string>,
  ): Promise<Record<string, string[]>> {
    const groups = Object.entries(conceptGroups ?? {});
    if (groups.length === 0 || sources.length === 0) return {};

    const namespaceMetamodels = knownNamespaceMetamodels
      ?? (await resolveNames(sources, [])).namespaceMetamodels;
    const metamodels = [...new Set([...namespaceMetamodels.values()].filter((mm) => mm.length > 0))];
    // A base concept always resolves to at least itself, so an unknown
    // metamodel degrades to the literal behaviour instead of matching nothing.
    if (metamodels.length === 0) {
      return Object.fromEntries(groups.map(([parameter, base]) => [parameter, [base]]));
    }

    const rows = await dbModule.runQuery(
      `MATCH (child:RIA_META_Concept)-[:RIA_META_CONCEPT_SUBTYPEOF]->(parent:RIA_META_Concept)
       WHERE child.metamodel IN $metamodels AND parent.metamodel = child.metamodel
       RETURN DISTINCT parent.name AS parent, child.name AS child`,
      { metamodels },
    );
    const childrenByParent = new Map<string, string[]>();
    for (const row of rows) {
      const parent = String(row.parent ?? '');
      const child = String(row.child ?? '');
      if (!parent || !child) continue;
      const existing = childrenByParent.get(parent);
      if (existing) existing.push(child);
      else childrenByParent.set(parent, [child]);
    }

    const resolved: Record<string, string[]> = {};
    for (const [parameter, base] of groups) {
      // Breadth-first over the subtype edges. `seen` also terminates a cyclic
      // hierarchy, which is malformed rather than impossible.
      const seen = new Set<string>([base]);
      const queue = [base];
      while (queue.length > 0) {
        for (const child of childrenByParent.get(queue.shift()!) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      resolved[parameter] = [...seen];
    }
    return resolved;
  }

  /**
   * The source-vs-mapping check of 3.1.5, against metamodels already resolved.
   * Kept separate from the queries so both the create/update path and the
   * evaluation path can run it without re-reading the same rows.
   */
  function checkSourcesAgainstMapping(
    sources: string[],
    mappingId: string,
    namespaceMetamodels: Map<string, string>,
  ): string | null {
    const descriptor = mappingRegistry.resolve(mappingId);
    if (!descriptor) return `Mapping '${mappingId}' is not resolvable`;
    for (const ns of sources) {
      const metamodel = namespaceMetamodels.get(ns);
      if (metamodel === undefined) return `Source namespace '${ns}' does not exist`;
      const mismatch = mappingSourceMismatch(descriptor, ns, metamodel);
      if (mismatch) return mismatch;
    }
    return null;
  }

  /** Shared by create and the in-place update path. */
  async function validateSourcesAgainstMapping(sources: string[], mappingId: string): Promise<string | null> {
    const { namespaceMetamodels } = await resolveNames(sources, []);
    return checkSourcesAgainstMapping(sources, mappingId, namespaceMetamodels);
  }

  async function readView(name: string): Promise<ViewDefinition | null> {
    const rows = await dbModule.runQuery(
      `MATCH (v:RIA_UNIV_View) WHERE v.name = $name
       RETURN v.description AS description, v.metamodel AS metamodel, v.mapping AS mapping, v.parameters AS parameters`,
      { name },
    );
    if (rows.length === 0) return null;

    // Both edge sets in one query, for the reason given on `resolveNames`: the
    // cost of a query here is the connection it opens, not the rows it returns.
    const edgeRows = await dbModule.runQuery(
      `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_SOURCE]->(ns:RIA_UNIV_Namespace) WHERE v.name = $name
       RETURN 'source' AS kind, ns.name AS name
       UNION ALL
       MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_CATEGORIZEDBY]->(mm:RIA_META_Metamodel) WHERE v.name = $name
       RETURN 'categorizedBy' AS kind, mm.name AS name`,
      { name },
    );
    const sortByName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const sourceRows = edgeRows.filter((r) => String(r.kind) === 'source');
    const categorizedByRows = edgeRows.filter((r) => String(r.kind) === 'categorizedBy');

    let parameters: Record<string, unknown> = {};
    try {
      parameters = JSON.parse(String(rows[0].parameters ?? '{}'));
    } catch {
      parameters = {};
    }

    return {
      name,
      description: String(rows[0].description ?? ''),
      metamodel: String(rows[0].metamodel ?? ''),
      mapping: String(rows[0].mapping ?? ''),
      parameters,
      // Ordered here rather than by the query: a UNION ALL has one ORDER BY for
      // the whole statement, and the two halves are ordered independently.
      sources: sourceRows.map((r) => String(r.name)).sort(sortByName),
      categorizedBy: categorizedByRows.map((r) => String(r.name)).sort(sortByName),
    };
  }

  async function writeViewRelationships(
    name: string,
    metamodel: string,
    sources: string[],
    categorizedBy: string[],
  ): Promise<void> {
    await dbModule.runQuery(
      `MATCH (v:RIA_UNIV_View), (mm:RIA_META_Metamodel) WHERE v.name = $name AND mm.name = $mm
       CREATE (v)-[:RIA_UNIV_VIEW_DEFINEDBY]->(mm)`,
      { name, mm: metamodel },
    );
    for (const ns of sources) {
      await dbModule.runQuery(
        `MATCH (v:RIA_UNIV_View), (ns:RIA_UNIV_Namespace) WHERE v.name = $name AND ns.name = $ns
         CREATE (v)-[:RIA_UNIV_VIEW_SOURCE]->(ns)`,
        { name, ns },
      );
    }
    for (const mm of categorizedBy) {
      await dbModule.runQuery(
        `MATCH (v:RIA_UNIV_View), (mm:RIA_META_Metamodel) WHERE v.name = $name AND mm.name = $mm
         CREATE (v)-[:RIA_UNIV_VIEW_CATEGORIZEDBY]->(mm)`,
        { name, mm },
      );
    }
  }

  /**
   * The single registered mapping that produces `targetMetamodel` content and
   * can read every one of `sources`.
   *
   * Discriminated rather than returning a bare string, because a mapping id and
   * an error message are both strings and conflating them silently turns a
   * successful resolution into a reported failure.
   *
   * An ambiguous choice is reported rather than guessed: picking the wrong one
   * of two applicable mappings yields plausible-looking but wrong content,
   * which is worse than an error naming both.
   */
  function resolveMappingForResolvedSources(
    targetMetamodel: string,
    sources: string[],
    namespaceMetamodels: Map<string, string>,
  ): MappingResolution {
    const metamodels: string[] = [];
    for (const ns of sources) {
      const metamodel = namespaceMetamodels.get(ns);
      if (metamodel === undefined) {
        return { error: `Source namespace '${ns}' does not exist`, kind: 'source_missing' };
      }
      metamodels.push(metamodel);
    }

    const candidates = mappingRegistry.listAvailable().filter((descriptor) => {
      if (descriptor.targetMetamodel !== targetMetamodel) return false;
      return sources.every((ns, index) => mappingSourceMismatch(descriptor, ns, metamodels[index]) === null);
    });

    if (candidates.length === 1) return { mapping: candidates[0].id };
    if (candidates.length === 0) {
      const distinct = [...new Set(metamodels)].join(', ');
      return {
        error: `No mapping produces '${targetMetamodel}' content from namespaces of metamodel(s) [${distinct}] — name one explicitly`,
        kind: 'unavailable',
      };
    }
    return {
      error: `Several mappings produce '${targetMetamodel}' content from these sources (${candidates.map((c) => c.id).join(', ')}) — name one explicitly`,
      kind: 'ambiguous',
    };
  }

  /** {@link resolveMappingForResolvedSources}, reading the metamodels itself. */
  async function resolveMappingForSources(
    targetMetamodel: string,
    sources: string[],
  ): Promise<MappingResolution> {
    const { namespaceMetamodels } = await resolveNames(sources, []);
    return resolveMappingForResolvedSources(targetMetamodel, sources, namespaceMetamodels);
  }

  /**
   * What an `evaluate` request is actually evaluating: either a saved view read
   * back from the graph, or an ad-hoc definition supplied inline. Returns the
   * resolved definition, or an error message string.
   *
   * An ad-hoc definition is validated exactly as a saved one is — the mapping
   * must resolve, and it must be able to read every source namespace — so
   * evaluating inline cannot reach anything creating a view first would not.
   * It deliberately does *not* go through the name-uniqueness check: an ad-hoc
   * definition has no name and claims none.
   */
  async function resolveEvaluationTarget(
    params: EvaluateViewParams,
  ): Promise<EvaluationTarget | string | typeof MAPPING_UNAVAILABLE> {
    if (params.definition !== undefined) {
      if (params.view !== undefined) {
        return `Evaluate accepts either a view name or an ad-hoc definition, not both`;
      }
      const definition = params.definition;
      const metamodel = definition.metamodel?.trim() ?? '';
      let mapping = definition.mapping?.trim() ?? '';
      const sources = definition.sources ?? [];
      const categorizedBy = definition.categorizedBy ?? [];
      const parameters = definition.parameters ?? {};

      if (!metamodel) return 'Ad-hoc view definition requires a non-empty metamodel';
      if (sources.length === 0) return 'Ad-hoc view definition requires at least one source namespace';

      // One query answers every name question this validation asks. It used to
      // be three (mapping resolution, metamodel existence, source-vs-mapping),
      // the last two re-reading rows the first had already fetched — and this
      // runs on every single evaluation (spec-view.md Phase 5.1.1).
      const { namespaceMetamodels, existingMetamodels } =
        await resolveNames(sources, [metamodel, ...categorizedBy]);

      if (!mapping) {
        // Omitting the mapping is the normal case for a consumer that has a
        // namespace and a target metamodel but no reason to know which mapping
        // connects them — resolving it here is what keeps registry knowledge
        // out of consumers instead of duplicating it in each one.
        const resolvedMapping = resolveMappingForResolvedSources(metamodel, sources, namespaceMetamodels);
        if ('error' in resolvedMapping) {
          if (params.allowUnavailableMapping && resolvedMapping.kind === 'unavailable') {
            return MAPPING_UNAVAILABLE;
          }
          return resolvedMapping.error;
        }
        mapping = resolvedMapping.mapping;
      }
      if (!existingMetamodels.has(metamodel)) return `Metamodel '${metamodel}' does not exist`;
      if (categorizedBy.includes(RESERVED_CATEGORIZATIONAL_METAMODEL)) {
        return `'${RESERVED_CATEGORIZATIONAL_METAMODEL}' is purely an immediate metamodel and cannot be attached as a categorizational metamodel`;
      }
      for (const mm of categorizedBy) {
        if (!existingMetamodels.has(mm)) return `Categorizational metamodel '${mm}' does not exist`;
      }
      const sourceError = checkSourcesAgainstMapping(sources, mapping, namespaceMetamodels);
      if (sourceError) return sourceError;
      const parameterError = validateParameters(parameters);
      if (parameterError) return parameterError;

      return {
        view: {
          // An ad-hoc definition is never persisted and never named. The empty
          // name is inert here: nothing below reads it except diagnostics.
          name: '',
          description: '',
          metamodel, mapping, parameters, sources, categorizedBy,
        },
        // Handed on so concept-group resolution does not re-read the rows this
        // validation just read.
        namespaceMetamodels,
      };
    }

    const name = params.view ?? '';
    if (!name) return 'Evaluate requires either a view name or an ad-hoc definition';
    const view = await readView(name);
    if (!view) return `View '${name}' not found`;
    // A saved view's sources were not resolved here, so concept-group resolution
    // reads them for itself.
    return { view };
  }

  async function validateCreateOrReplace(
    name: string,
    metamodel: string,
    sources: string[],
    categorizedBy: string[],
    mapping: string,
    parameters: Record<string, unknown>,
    skipNameCheckAgainst?: string,
  ): Promise<string | null> {
    if (!name) return 'View name must be non-empty';
    if (name !== skipNameCheckAgainst && (await namespaceOrViewNameTaken(name))) {
      return `A view or namespace named '${name}' already exists`;
    }
    if (sources.length === 0) return 'A view requires at least one source namespace';
    if (!mapping) return 'View mapping must be non-empty';
    const sourceError = await validateSourcesAgainstMapping(sources, mapping);
    if (sourceError) return sourceError;
    const parameterError = validateParameters(parameters);
    if (parameterError) return parameterError;
    if (!metamodel) return 'View immediate metamodel must be non-empty';
    if (!(await metamodelExists(metamodel))) return `Metamodel '${metamodel}' does not exist`;
    if (categorizedBy.includes(RESERVED_CATEGORIZATIONAL_METAMODEL)) {
      return `'${RESERVED_CATEGORIZATIONAL_METAMODEL}' is purely an immediate metamodel and cannot be attached as a categorizational metamodel`;
    }
    for (const mm of categorizedBy) {
      if (!(await metamodelExists(mm))) return `Categorizational metamodel '${mm}' does not exist`;
    }
    return null;
  }

  const service: IViewService = {
    async listViews(): Promise<Result<ViewDefinition[]>> {
      try {
        const rows = await dbModule.runQuery(`MATCH (v:RIA_UNIV_View) RETURN v.name AS name ORDER BY name`);
        const views: ViewDefinition[] = [];
        for (const row of rows) {
          const view = await readView(String(row.name));
          if (view) views.push(view);
        }
        return { ok: true, data: views };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async getView(name: string): Promise<Result<ViewDefinition>> {
      try {
        const view = await readView(name);
        if (!view) return err(`View '${name}' not found`);
        return { ok: true, data: view };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async createView(params: CreateViewParams): Promise<Result<ViewDefinition>> {
      const name = params.name?.trim() ?? '';
      const metamodel = params.metamodel?.trim() ?? '';
      const mapping = params.mapping?.trim() ?? '';
      const sources = params.sources ?? [];
      const categorizedBy = params.categorizedBy ?? [];

      const validationError = await validateCreateOrReplace(
        name, metamodel, sources, categorizedBy, mapping, params.parameters ?? {},
      );
      if (validationError) return err(validationError);

      try {
        await dbModule.runQuery(
          `CREATE (:RIA_UNIV_View {name: $name, description: $description, metamodel: $metamodel, mapping: $mapping, parameters: $parameters})`,
          {
            name,
            description: params.description ?? '',
            metamodel,
            mapping,
            parameters: JSON.stringify(params.parameters ?? {}),
          },
        );
        await writeViewRelationships(name, metamodel, sources, categorizedBy);

        const view = await readView(name);
        return { ok: true, data: view! };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async updateView(params: UpdateViewParams): Promise<Result<ViewDefinition>> {
      try {
        const existing = await readView(params.name);
        if (!existing) return err(`View '${params.name}' not found`);

        const identityChange =
          (params.newName !== undefined && params.newName !== existing.name) ||
          (params.metamodel !== undefined && params.metamodel !== existing.metamodel);

        if (identityChange) {
          // Name or immediate metamodel is identity-bearing — delete and re-create.
          const merged: CreateViewParams = {
            name: params.newName ?? existing.name,
            description: params.description ?? existing.description,
            metamodel: params.metamodel ?? existing.metamodel,
            mapping: params.mapping ?? existing.mapping,
            parameters: params.parameters ?? existing.parameters,
            sources: params.sources ?? existing.sources,
            categorizedBy: params.categorizedBy ?? existing.categorizedBy,
          };
          const validationError = await validateCreateOrReplace(
            merged.name, merged.metamodel, merged.sources, merged.categorizedBy ?? [], merged.mapping,
            merged.parameters ?? {}, existing.name,
          );
          if (validationError) return err(validationError);

          await dbModule.runQuery(`MATCH (v:RIA_UNIV_View) WHERE v.name = $name DETACH DELETE v`, { name: existing.name });
          await dbModule.runQuery(
            `CREATE (:RIA_UNIV_View {name: $name, description: $description, metamodel: $metamodel, mapping: $mapping, parameters: $parameters})`,
            {
              name: merged.name,
              description: merged.description ?? '',
              metamodel: merged.metamodel,
              mapping: merged.mapping,
              parameters: JSON.stringify(merged.parameters ?? {}),
            },
          );
          await writeViewRelationships(merged.name, merged.metamodel, merged.sources, merged.categorizedBy ?? []);

          const view = await readView(merged.name);
          return { ok: true, data: view! };
        }

        // In-place update: description / parameters / sources / categorizedBy only.
        const nextSources = params.sources ?? existing.sources;
        const nextCategorizedBy = params.categorizedBy ?? existing.categorizedBy;
        const nextMapping = params.mapping ?? existing.mapping;
        // Either a new source set or a new mapping can break the pairing, so
        // re-check whenever either changes.
        if (params.sources !== undefined || params.mapping !== undefined) {
          if (nextSources.length === 0) return err('A view requires at least one source namespace');
          const sourceError = await validateSourcesAgainstMapping(nextSources, nextMapping);
          if (sourceError) return err(sourceError);
        }
        if (params.parameters !== undefined) {
          const parameterError = validateParameters(params.parameters);
          if (parameterError) return err(parameterError);
        }
        if (params.categorizedBy !== undefined) {
          if (nextCategorizedBy.includes(RESERVED_CATEGORIZATIONAL_METAMODEL)) {
            return err(`'${RESERVED_CATEGORIZATIONAL_METAMODEL}' is purely an immediate metamodel and cannot be attached as a categorizational metamodel`);
          }
          for (const mm of nextCategorizedBy) {
            if (!(await metamodelExists(mm))) return err(`Categorizational metamodel '${mm}' does not exist`);
          }
        }
        await dbModule.runQuery(
          `MATCH (v:RIA_UNIV_View) WHERE v.name = $name
           SET v.description = $description, v.mapping = $mapping, v.parameters = $parameters`,
          {
            name: existing.name,
            description: params.description ?? existing.description,
            mapping: params.mapping ?? existing.mapping,
            parameters: JSON.stringify(params.parameters ?? existing.parameters),
          },
        );

        if (params.sources !== undefined) {
          await dbModule.runQuery(
            `MATCH (v:RIA_UNIV_View)-[r:RIA_UNIV_VIEW_SOURCE]->() WHERE v.name = $name DELETE r`,
            { name: existing.name },
          );
          for (const ns of nextSources) {
            await dbModule.runQuery(
              `MATCH (v:RIA_UNIV_View), (ns:RIA_UNIV_Namespace) WHERE v.name = $name AND ns.name = $ns
               CREATE (v)-[:RIA_UNIV_VIEW_SOURCE]->(ns)`,
              { name: existing.name, ns },
            );
          }
        }
        if (params.categorizedBy !== undefined) {
          await dbModule.runQuery(
            `MATCH (v:RIA_UNIV_View)-[r:RIA_UNIV_VIEW_CATEGORIZEDBY]->() WHERE v.name = $name DELETE r`,
            { name: existing.name },
          );
          for (const mm of nextCategorizedBy) {
            await dbModule.runQuery(
              `MATCH (v:RIA_UNIV_View), (mm:RIA_META_Metamodel) WHERE v.name = $name AND mm.name = $mm
               CREATE (v)-[:RIA_UNIV_VIEW_CATEGORIZEDBY]->(mm)`,
              { name: existing.name, mm },
            );
          }
        }

        const view = await readView(existing.name);
        return { ok: true, data: view! };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async ensureDefaultViews(): Promise<Result<ViewDefinition[]>> {
      try {
        // Imported namespaces only. An authored namespace is the user's own
        // content and gets a view when they ask for one; a `supervised_update_temp`
        // scratch namespace must not get one at all, since the cleanup routine
        // would immediately cascade-delete it again.
        const namespaceRows = await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.namespace_role = 'imported'
           RETURN ns.name AS name ORDER BY name`,
        );

        const created: ViewDefinition[] = [];
        for (const row of namespaceRows) {
          const namespace = String(row.name ?? '');
          if (!namespace) continue;

          // Already covered? Any view sourcing this namespace counts, not just
          // one under the default name — a user who built their own view over
          // this namespace should not also get an automatic one.
          const existing = await dbModule.runQuery(
            `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_SOURCE]->(ns:RIA_UNIV_Namespace)
             WHERE ns.name = $namespace RETURN count(v) AS cnt`,
            { namespace },
          );
          if (Number(existing[0]?.cnt ?? 0) > 0) continue;

          // No mapping for this namespace's metamodel is not an error: it just
          // has no CommonModel projection yet.
          const mapping = await resolveMappingForSources(COMMON_MODEL_METAMODEL, [namespace]);
          if ('error' in mapping) continue;

          const name = defaultViewNameFor(namespace);
          if (await namespaceOrViewNameTaken(name)) continue;

          const result = await service.createView({
            name,
            description: `Default CommonModel view over the imported namespace '${namespace}'.`,
            metamodel: COMMON_MODEL_METAMODEL,
            mapping: mapping.mapping,
            sources: [namespace],
          });
          if (result.ok) {
            created.push(result.data);
            logger?.info?.(`created default view '${name}' for imported namespace '${namespace}'`);
          } else {
            logger?.warn?.(`could not create default view for '${namespace}': ${result.error}`);
          }
        }
        return { ok: true, data: created };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async deleteView(name: string): Promise<Result<void>> {
      try {
        await dbModule.runQuery(`MATCH (v:RIA_UNIV_View) WHERE v.name = $name DETACH DELETE v`, { name });
        // A view has no stored *content*, but a consumer may have persisted
        // canvas positions for it, keyed by the Element_Kind 'view:<name>'
        // (spec-view.md Phase 4.2). That kind has no reconcile resolver — by
        // design, so a position is never dropped just because its source is
        // momentarily absent — so nothing else would ever remove these.
        await dbModule.runQuery(
          `MATCH (l:RIA_UNIV_CanvasLayout) WHERE l.element_kind = $element_kind DELETE l`,
          { element_kind: `view:${name}` },
        );
        return { ok: true, data: undefined };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async evaluateView(workingDir: string, params: EvaluateViewParams): Promise<Result<EvaluationResult>> {
      try {
        const target = await resolveEvaluationTarget(params);
        if (target === MAPPING_UNAVAILABLE) {
          return {
            ok: true,
            data: { representatives: [], relationships: [], diagnostics: [] },
          };
        }
        if (typeof target === 'string') return err(target);
        const view = target.view;

        const mapping = mappingRegistry.resolve(view.mapping);
        if (!mapping) return err(`Mapping '${view.mapping}' is not resolvable`);

        const baseQueryId = mapping.queryIdByMode[params.mode];
        if (!baseQueryId) return err(`Mapping '${view.mapping}' has no catalog entry for mode '${params.mode}'`);

        const catalog = loadCatalog(workingDir);
        const diagnostics: string[] = [];

        // Traversal resolves ONE catalog entry per (relationship, direction),
        // id `<base>.<Relationship>.<direction>`.
        //
        // A single entry holding every pair as UNION ALL branches is unusable:
        // every branch executes regardless of which pair was requested, so one
        // expensive branch is fatal for all of them. Measured on a 73-node ARXML
        // import, `Expose/outgoing` alone is 48ms while the combined entry ran
        // 251s and then died with a buffer-pool exhaustion.
        //
        // `both` runs the two directed entries and merges. There is deliberately
        // no `both` entry: an undirected variable-length pattern is exactly the
        // pathological case, since it enumerates paths that alternate direction.
        const queryIds: string[] = [];
        if (params.mode === 'traversal') {
          const relationship = params.relationship ?? '';
          if (!relationship) return err(`Traversal requires a relationship to walk`);
          const directions: TraversalDirection[] = params.direction === 'both'
            ? ['outgoing', 'incoming']
            : [params.direction ?? 'outgoing'];
          for (const direction of directions) {
            const specificId = `${baseQueryId}.${relationship}.${direction}`;
            if (resolveQuery(catalog, specificId)) {
              queryIds.push(specificId);
            } else if (resolveQuery(catalog, baseQueryId)) {
              // Falling back to the base id keeps a repository catalog that
              // overrides the whole traversal entry working unchanged.
              queryIds.push(baseQueryId);
            } else {
              // The mapping's source data simply never produces this
              // relationship — e.g. Sphinx-Needs has no `Ownership` hierarchy,
              // only `Refinement`. Zero reachable neighbours is a legitimate
              // traversal answer, not a fatal error: erroring here is what used
              // to surface as "Catalog entry '<mapping>.traversal' ... was not
              // found" the moment a user opened the model view on a Sphinx-Needs
              // element, since the view seeds every non-port focus by walking
              // `Ownership` regardless of the source metamodel.
              diagnostics.push(`Mapping '${view.mapping}' has no traversal entry for relationship '${relationship}' (${direction}) — treated as no reachable elements`);
            }
          }
        } else {
          queryIds.push(baseQueryId);
        }

        const resolvedQueries: ResolvedQuery[] = [];
        for (const queryId of [...new Set(queryIds)]) {
          // One id may name a *series* of entries — see `resolveQuerySeries`.
          // A projection whose branches would otherwise put several copies of
          // one expensive resolution in a single statement is split across
          // continuations, because that copy count is what drives a statement's
          // buffer-pool peak. Every member contributes rows to this result.
          const series = resolveQuerySeries(catalog, queryId);
          if (series.length === 0) return err(`Catalog entry '${queryId}' (resolved via mapping '${view.mapping}') was not found`);
          for (const resolved of series) {
            // Defense in depth: never execute a write-shaped statement, even if it
            // somehow slipped past catalog validation — evaluation acquires no write
            // lock (docs/coreSpecs/RiaViews.md).
            if (WRITE_STATEMENT_PATTERN.test(resolved.entry.cypher)) {
              return err(`Catalog entry '${resolved.entry.id}' is write-shaped — refusing to evaluate (evaluation must be read-only)`);
            }
            resolvedQueries.push(resolved);
          }
        }

        // Traversal depth is clamped to what the mapping's query can actually
        // serve. Only an explicit over-request is reported: the default would
        // otherwise produce a diagnostic on every ordinary Sphinx-Needs
        // traversal, whose unrolled hops cap out well below the default.
        const maxDepth = mapping.maxTraversalDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
        const depth = Math.min(params.depth ?? DEFAULT_TRAVERSAL_DEPTH, maxDepth);
        if (params.depth !== undefined && params.depth > maxDepth) {
          diagnostics.push(`Requested traversal depth ${params.depth} exceeds the maximum of ${maxDepth} served by mapping '${view.mapping}' — clamped to ${maxDepth}`);
        }

        // Kuzu's LIMIT clause rejects a null parameter (it must be a real
        // literal/parameter number), so traversal bounds are defaulted here
        // rather than left null — this also means a bound is always applied,
        // never "unbounded by default" (RiaViews.md — traversal bounds
        // requirement).
        const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
        // Resolved once per evaluation and bound to every query this evaluation
        // runs, including the edge query below — a concept group that applied to
        // only some of them would report an edge whose endpoint was never
        // projected.
        const conceptGroups = await resolveConceptGroups(mapping.conceptGroups, view.sources, target.namespaceMetamodels);
        const queryParams: Record<string, unknown> = {
          sourceNamespaces: view.sources,
          elementNodeId: params.elementNodeId ?? null,
          elementNodeIds: params.elementNodeIds ?? null,
          representativeIds: params.representativeIds ?? null,
          relationship: params.relationship ?? null,
          direction: params.direction ?? null,
          depth,
          maxResults,
          ...conceptGroups,
        };
        // Each view parameter is bound individually as `p_<key>`. Create/update
        // validation rejects unbindable keys and values, but a definition
        // persisted before that check existed can still carry one, so evaluation
        // skips rather than fails on it.
        for (const [key, value] of Object.entries(view.parameters)) {
          if (!PARAMETER_KEY_PATTERN.test(key)) {
            diagnostics.push(`View parameter key '${key}' is not a legal query parameter name — ignored`);
            continue;
          }
          if (!isBindableParameterValue(value)) {
            diagnostics.push(`View parameter '${key}' holds a value that cannot be bound as a query parameter — ignored`);
            continue;
          }
          queryParams[`p_${key}`] = value;
        }

        const representatives: Representative[] = [];
        const relationships: RepresentativeRelationship[] = [];

        /** Splits catalog rows into representatives and relationships. */
        function collectRows(rows: Record<string, unknown>[]): void {
          for (const row of rows) {
            const rowType = String(row.row_type ?? '');
            if (rowType === 'representative') {
              try {
                // A missing `id` column almost always means the catalog query
                // projected the same expression under two aliases: the query
                // engine collapses those into one output column, keeping the
                // last alias. Naming the cause here because the symptom
                // otherwise reads as an empty result rather than a broken query.
                if (row.id === undefined) {
                  diagnostics.push('Representative row has no \'id\' column — a catalog query must not project the same expression under two aliases, because only the last one survives');
                  continue;
                }
                const rawAttributes = JSON.parse(String(row.attributes ?? '{}'));
                const rawConcept = String(row.concept);
                const shaped = mapping!.shapeAttributes
                  ? mapping!.shapeAttributes({
                    concept: rawConcept,
                    sourceConcept: String(row.source_concept ?? rawConcept),
                    rawAttributes,
                  })
                  : { concept: rawConcept, attributes: rawAttributes };
                representatives.push({
                  id: String(row.id),
                  concept: shaped.concept,
                  attributes: shaped.attributes,
                  sources: readSourceReferences(row),
                  categories: [],
                });
              } catch (parseErr) {
                diagnostics.push(`Malformed representative row (id=${String(row.id)}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
              }
            } else if (rowType === 'relationship') {
              relationships.push({
                relationship: String(row.relationship),
                sourceRepresentativeId: String(row.source_id),
                targetRepresentativeId: String(row.target_id),
              });
            } else {
              diagnostics.push(`Unrecognized catalog row_type '${rowType}' — row omitted`);
            }
          }
        }

        // Traversal is issued ONE start element at a time, never with the whole
        // list bound at once.
        //
        // A variable-length pattern's inline relationship filter — the
        // `(r, n | WHERE r.relationship IN [...])` lambda in every traversal
        // branch — cannot be relied on to apply at all. Only the explicit
        // `ALL(rel IN rels(r) ...)` predicate after the match filters
        // dependably, and that predicate materializes the matched path, so it
        // is affordable only at a one-hop bound (spec-view.md Phase 5.1.5).
        //
        // Hence the shape below: catalog entries answer "one step out", and a
        // deeper walk is assembled here, one hop per call, feeding each hop's
        // results in as the next hop's anchors. Correct by construction, and
        // bounded at one query per hop rather than one per start element.
        //
        // `resolvedQueries` holds one entry per requested direction, so a
        // `both` traversal runs both directed entries here and their rows merge.
        if (params.mode === 'traversal') {
          // Normalised for the same reason as `startIds` below: a caller may
          // send numbers, and the catalog's `CAST(ridStr AS INT64)` accepts
          // either, so nothing else would notice.
          const startIdList = [...new Set((params.representativeIds ?? []).map(String))];
          for (const resolvedQuery of resolvedQueries) {
            // The entry's own `$relationship`/`$direction` guard must see the
            // direction *this* entry was resolved for, not the caller's 'both'.
            // A numbered continuation (`....outgoing.2`) carries its parent's
            // direction, so the suffix is stripped before the test — otherwise a
            // split traversal entry would silently fall back to the caller's
            // direction and its guard would gate the wrong branch.
            const entryId = resolvedQuery.entry.id.replace(/\.\d+$/, '');
            const entryDirection = entryId.endsWith('.incoming') ? 'incoming'
              : entryId.endsWith('.outgoing') ? 'outgoing'
                : (params.direction ?? 'outgoing');

            // An entry carrying the explicit guard filters correctly however
            // many rows its anchor binds, so it is issued once per chunk of
            // start elements rather than once per start element (5.1.3).
            const anchorsPerCall = EXPLICIT_RELATIONSHIP_GUARD.test(resolvedQuery.entry.cypher)
              ? TRAVERSAL_ANCHOR_CHUNK
              : 1;
            // A single-hop entry is stepped `depth` times; anything else states
            // its own depth semantics and is called once with `$depth` bound.
            const hopsToWalk = SINGLE_HOP_PATTERN.test(resolvedQuery.entry.cypher) ? depth : 1;

            let anchorsForHop = startIdList;
            const reached = new Set(startIdList);
            for (let hop = 0; hop < hopsToWalk && anchorsForHop.length > 0; hop += 1) {
              const discovered: string[] = [];
              for (let offset = 0; offset < anchorsForHop.length; offset += anchorsPerCall) {
                const anchors = anchorsForHop.slice(offset, offset + anchorsPerCall);
                const rows = await dbModule.runQuery(resolvedQuery.entry.cypher, {
                  ...queryParams,
                  direction: entryDirection,
                  representativeIds: anchors,
                });
                // `LIMIT $maxResults` bounds a *call*, so batching moves the
                // bound from per-anchor to per-chunk. Saying so is the point:
                // silently returning a truncated neighbourhood is precisely the
                // failure a consumer cannot detect for itself.
                if (anchors.length > 1 && rows.length >= maxResults) {
                  diagnostics.push(
                    `Traversal '${resolvedQuery.entry.id}' returned the maximum of ${maxResults} rows for ${anchors.length} start elements — the result may be truncated`,
                  );
                }
                for (const row of rows) {
                  // Only genuinely new nodes anchor the next hop, so a cycle in
                  // the source data terminates the walk instead of circling.
                  const id = row.id === undefined ? undefined : String(row.id);
                  if (id !== undefined && !reached.has(id)) {
                    reached.add(id);
                    discovered.push(id);
                  }
                }
                collectRows(rows);
              }
              anchorsForHop = discovered;
            }
          }
        } else {
          // Every member of the resolved series, not just the first: a split
          // projection returns the same rows as the unsplit one only if all of
          // its continuations run.
          for (const resolvedQuery of resolvedQueries) {
            collectRows(await dbModule.runQuery(resolvedQuery.entry.cypher, queryParams));
          }
        }

        // The representatives the caller already holds. A traversal returns the
        // *neighbours* of these, so they are not in the result but their edges
        // to it are exactly what makes the result a tree rather than a bag.
        // Every branch normalises to strings, because a representative id is a
        // string everywhere else in the result. `representativeIds` is typed
        // `string[]`, but a JSON caller readily sends `[5]` rather than `["5"]`
        // — the CLI does exactly that — and the query casts it happily, so the
        // walk succeeds while the *edges* back to the start elements are then
        // dropped as dangling: `Set([5]).has('5')` is false. That failure is
        // silent apart from a diagnostic, and it costs a consumer the one edge
        // that connects a traversal result to what it was walked from.
        const startIds: string[] =
          params.mode === 'element' ? (params.elementNodeId !== undefined ? [String(params.elementNodeId)] : [])
            : params.mode === 'elements' ? (params.elementNodeIds ?? []).map(String)
              : params.mode === 'traversal' ? (params.representativeIds ?? []).map(String)
                : [];

        // `element`, `elements`, and `traversal` resolve nodes only; their edges
        // come from the mapping's edge query (spec-view.md Phase 3.1.1). `whole`
        // returns its edges inline and needs no completion.
        //
        // A caller that reads only `representatives` opts out with
        // `includeRelationships: false` — edge completion is the dominant cost of
        // these modes, and computing an edge set the caller discards is the
        // largest single piece of waste on the model view's load path.
        if (params.mode !== 'whole' && params.includeRelationships !== false) {
          if (!mapping.edgeQueryId) {
            diagnostics.push(`Mapping '${view.mapping}' declares no edge query, so '${params.mode}' evaluation returns no relationships`);
          } else {
            const edgeSeries = resolveQuerySeries(catalog, mapping.edgeQueryId);
            const writeShaped = edgeSeries.find((resolved) => WRITE_STATEMENT_PATTERN.test(resolved.entry.cypher));
            if (edgeSeries.length === 0) {
              diagnostics.push(`Edge catalog entry '${mapping.edgeQueryId}' (resolved via mapping '${view.mapping}') was not found — '${params.mode}' evaluation returns no relationships`);
            } else if (writeShaped) {
              diagnostics.push(`Edge catalog entry '${writeShaped.entry.id}' is write-shaped — refusing to run it (evaluation must be read-only)`);
            } else {
              const nodeIds = [...new Set([
                ...representatives.map((rep) => Number(rep.id)),
                ...startIds.map(Number),
              ])].filter((nodeId) => Number.isFinite(nodeId));
              if (nodeIds.length > 0) {
                const edgeParams = {
                  nodeIds,
                  sourceNamespaces: view.sources,
                  ...conceptGroups,
                };
                for (const resolvedEdges of edgeSeries) {
                  collectRows(await dbModule.runQuery(resolvedEdges.entry.cypher, edgeParams));
                }
              }
            }
          }
        }

        // A representative id is unique within an evaluation result
        // (RiaViews.md — Traceability). A traversal reaching one element by two
        // paths of different length yields it once per path length, so the
        // result is deduplicated here rather than in every catalog query.
        const uniqueRepresentatives = new Map<string, Representative>();
        for (const rep of representatives) {
          if (!uniqueRepresentatives.has(rep.id)) uniqueRepresentatives.set(rep.id, rep);
        }

        // What the view's immediate metamodel declares — concepts and
        // relationships in one query, for the reason given on `resolveNames`.
        const declarationRows = await dbModule.runQuery(
          `MATCH (c:RIA_META_Concept) WHERE c.metamodel = $mm
           RETURN 'concept' AS kind, c.name AS name
           UNION ALL
           MATCH (r:RIA_META_Relationship) WHERE r.metamodel = $mm
           RETURN 'relationship' AS kind, r.name AS name`,
          { mm: view.metamodel },
        );

        // Concept typing: report and omit any representative whose concept is
        // not declared by the view's immediate metamodel.
        const declaredConcepts = new Set(
          declarationRows.filter((r) => String(r.kind) === 'concept').map((r) => String(r.name)),
        );
        const typedRepresentatives: Representative[] = [];
        for (const rep of uniqueRepresentatives.values()) {
          if (!declaredConcepts.has(rep.concept)) {
            diagnostics.push(`Representative '${rep.id}' has concept '${rep.concept}', not declared by metamodel '${view.metamodel}' — omitted`);
            continue;
          }
          typedRepresentatives.push(rep);
        }

        // Relationship typing, dangling-endpoint removal, and the CommonModel
        // ownership direction constraint — in that order, because the pair check
        // needs both endpoints to be known content.
        const declaredRelationships = new Set(
          declarationRows.filter((r) => String(r.kind) === 'relationship').map((r) => String(r.name)),
        );
        const conceptByRepresentativeId = new Map(typedRepresentatives.map((rep) => [rep.id, rep.concept]));
        const knownRepresentativeIds = new Set([...conceptByRepresentativeId.keys(), ...startIds]);
        const typedRelationships: RepresentativeRelationship[] = [];
        const seenRelationships = new Set<string>();
        for (const rel of relationships) {
          if (!declaredRelationships.has(rel.relationship)) {
            diagnostics.push(`Relationship '${rel.relationship}' is not declared by metamodel '${view.metamodel}' — omitted`);
            continue;
          }
          const danglingEnd = !knownRepresentativeIds.has(rel.sourceRepresentativeId)
            ? rel.sourceRepresentativeId
            : !knownRepresentativeIds.has(rel.targetRepresentativeId)
              ? rel.targetRepresentativeId
              : undefined;
          if (danglingEnd !== undefined) {
            diagnostics.push(`Relationship '${rel.relationship}' references representative '${danglingEnd}', which is not part of the content — omitted`);
            continue;
          }
          if (view.metamodel === COMMON_MODEL_METAMODEL && rel.relationship === 'Ownership') {
            const sourceConcept = conceptByRepresentativeId.get(rel.sourceRepresentativeId);
            const targetConcept = conceptByRepresentativeId.get(rel.targetRepresentativeId);
            if (!isPermittedOwnership(sourceConcept, targetConcept)) {
              diagnostics.push(`Ownership edge '${rel.sourceRepresentativeId}' -> '${rel.targetRepresentativeId}' is ${sourceConcept} -> ${targetConcept}, not a permitted ownership pair — omitted`);
              continue;
            }
          }
          const key = `${rel.relationship}|${rel.sourceRepresentativeId}|${rel.targetRepresentativeId}`;
          if (seenRelationships.has(key)) continue;
          seenRelationships.add(key);
          typedRelationships.push(rel);
        }

        // Categorization: a representative inherits the categories of its
        // sources, filtered to metamodels declared via categorizedBy.
        if (view.categorizedBy.length > 0) {
          const allNodeIds = [...new Set(typedRepresentatives.flatMap((r) => r.sources.map((s) => s.nodeId)))];
          if (allNodeIds.length > 0) {
            const categoryRows = await dbModule.runQuery(
              `MATCH (l:RIA_UNIV_CategoryLink) WHERE l.node_id IN $ids AND l.category_metamodel IN $mms
               RETURN l.node_id AS node_id, l.category AS category`,
              { ids: allNodeIds, mms: view.categorizedBy },
            );
            const categoriesByNodeId = new Map<number, string[]>();
            for (const row of categoryRows) {
              const nodeId = Number(row.node_id);
              const list = categoriesByNodeId.get(nodeId) ?? [];
              list.push(String(row.category));
              categoriesByNodeId.set(nodeId, list);
            }
            for (const rep of typedRepresentatives) {
              const categories = new Set<string>();
              for (const source of rep.sources) {
                for (const category of categoriesByNodeId.get(source.nodeId) ?? []) {
                  categories.add(category);
                }
              }
              rep.categories = [...categories];
            }
          }
        }

        return { ok: true, data: { representatives: typedRepresentatives, relationships: typedRelationships, diagnostics } };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async materializeView(workingDir: string, params: MaterializeViewParams): Promise<Result<MaterializeResult>> {
      try {
        const view = await readView(params.view);
        if (!view) return err(`View '${params.view}' not found`);

        const targetNamespace = params.targetNamespace?.trim() ?? '';
        if (!targetNamespace) return err('targetNamespace must be non-empty');
        if (await namespaceOrViewNameTaken(targetNamespace)) {
          return err(`A view or namespace named '${targetNamespace}' already exists. Re-materializing requires a different target name.`);
        }

        const evaluated = await service.evaluateView(workingDir, { view: params.view, mode: 'whole' });
        if (!evaluated.ok) return err(evaluated.error);
        const { representatives, relationships } = evaluated.data;

        await createOrReplaceNamespace(dbModule, {
          namespace: targetNamespace,
          metamodel: view.metamodel,
          namespaceRole: 'authored',
          namespaceOwningApplication: 'Views',
          replaceExisting: false,
        });

        // Assign a fresh uuid/stable_path to every materialized concept instance
        // (Authored node stable_path rule — CoreArchPrinciples.md), and keep a
        // representative id -> uuid map so relationships/Represents edges below
        // can be wired up after node_ids are assigned on CREATE.
        const repIdToUuid = new Map<string, string>();
        const conceptRows = representatives.map((rep) => {
          const uuid = crypto.randomUUID();
          repIdToUuid.set(rep.id, uuid);
          return {
            namespace: targetNamespace,
            concept: rep.concept,
            metamodel: view.metamodel,
            attributes: JSON.stringify({ ...rep.attributes, uuid, stable_path: uuid }),
          };
        });

        if (conceptRows.length > 0) {
          await batchInsertNodes(
            `UNWIND $rows AS row
             CREATE (:RIA_UNIV_ConceptInstance {namespace: row.namespace, concept: row.concept, metamodel: row.metamodel, attributes: row.attributes})`,
            conceptRows,
            dbModule,
          );
        }

        const insertedRows = await dbModule.runQuery(
          `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $ns RETURN ci.node_id AS node_id, ci.attributes AS attributes`,
          { ns: targetNamespace },
        );
        const uuidToNodeId = new Map<string, number>();
        for (const row of insertedRows) {
          try {
            const attrs = JSON.parse(String(row.attributes ?? '{}')) as Record<string, unknown>;
            if (typeof attrs.uuid === 'string') uuidToNodeId.set(attrs.uuid, Number(row.node_id));
          } catch { /* ignore */ }
        }
        const repIdToNodeId = new Map<string, number>();
        for (const [repId, uuid] of repIdToUuid) {
          const nodeId = uuidToNodeId.get(uuid);
          if (nodeId !== undefined) repIdToNodeId.set(repId, nodeId);
        }

        // Each relationship between representatives becomes a relationship
        // instance in the target namespace.
        let relationshipsWritten = 0;
        const relRows: Array<{ namespace: string; relationship: string; metamodel: string; source_node_id: number; target_node_id: number; attributes: string }> = [];
        for (const rel of relationships) {
          const sourceNodeId = repIdToNodeId.get(rel.sourceRepresentativeId);
          const targetNodeId = repIdToNodeId.get(rel.targetRepresentativeId);
          if (sourceNodeId === undefined || targetNodeId === undefined) continue;
          relRows.push({
            namespace: targetNamespace, relationship: rel.relationship, metamodel: view.metamodel,
            source_node_id: sourceNodeId, target_node_id: targetNodeId, attributes: '{}',
          });
        }
        if (relRows.length > 0) {
          await batchInsertNodes(
            `UNWIND $rows AS row
             CREATE (:RIA_UNIV_RelationshipInstance {namespace: row.namespace, relationship: row.relationship, metamodel: row.metamodel, source_node_id: row.source_node_id, target_node_id: row.target_node_id, attributes: row.attributes})`,
            relRows,
            dbModule,
          );
          const edgeIdRows = await dbModule.runQuery(
            `MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = $ns
             RETURN ri.source_node_id AS source_node_id, ri.target_node_id AS target_node_id, ri.edge_id AS edge_id, ri.relationship AS relationship, ri.metamodel AS metamodel`,
            { ns: targetNamespace },
          );
          await createInstanceRelEdges(
            edgeIdRows.map((r) => ({
              source_node_id: Number(r.source_node_id), target_node_id: Number(r.target_node_id),
              edge_id: Number(r.edge_id), relationship: String(r.relationship), metamodel: String(r.metamodel),
            })),
            dbModule,
          );
          relationshipsWritten = relRows.length;
        }

        // Source links: one Represents edge per represented source element, none
        // for representatives with no source (docs/coreSpecs/RiaViews.md).
        let sourceLinksWritten = 0;
        if (params.withSourceLinks) {
          const distinctSourceNodeIds = [...new Set(representatives.flatMap((r) => r.sources.map((s) => s.nodeId)))];
          const sourceAttrRows = distinctSourceNodeIds.length > 0
            ? await dbModule.runQuery(
              `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id IN $ids RETURN ci.node_id AS node_id, ci.attributes AS attributes`,
              { ids: distinctSourceNodeIds },
            )
            : [];
          const sourceNodeIdToStablePath = new Map<number, string>();
          for (const row of sourceAttrRows) {
            try {
              const attrs = JSON.parse(String(row.attributes ?? '{}')) as Record<string, unknown>;
              if (typeof attrs.stable_path === 'string') sourceNodeIdToStablePath.set(Number(row.node_id), attrs.stable_path);
            } catch { /* ignore */ }
          }

          const crossNsRows: Array<{ source_namespace: string; target_namespace: string; metamodel: string; relationship: string; source_node_id: number; target_node_id: number; attributes: string }> = [];
          for (const rep of representatives) {
            const repNodeId = repIdToNodeId.get(rep.id);
            if (repNodeId === undefined) continue;
            const repUuid = repIdToUuid.get(rep.id) ?? '';
            for (const source of rep.sources) {
              crossNsRows.push({
                source_namespace: targetNamespace,
                target_namespace: source.namespace,
                metamodel: view.metamodel,
                relationship: 'Represents',
                source_node_id: repNodeId,
                target_node_id: source.nodeId,
                attributes: JSON.stringify({
                  source_external_id: repUuid,
                  target_external_id: sourceNodeIdToStablePath.get(source.nodeId) ?? '',
                }),
              });
            }
          }
          if (crossNsRows.length > 0) {
            await batchInsertNodes(
              `UNWIND $rows AS row
               CREATE (:RIA_UNIV_CrossNSRelationshipInstance {source_namespace: row.source_namespace, target_namespace: row.target_namespace, metamodel: row.metamodel, relationship: row.relationship, source_node_id: row.source_node_id, target_node_id: row.target_node_id, attributes: row.attributes})`,
              crossNsRows,
              dbModule,
            );
            const crossNsEdgeIdRows = await dbModule.runQuery(
              `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance) WHERE x.source_namespace = $ns AND x.relationship = 'Represents'
               RETURN x.source_node_id AS source_node_id, x.target_node_id AS target_node_id, x.edge_id AS edge_id,
                      x.relationship AS relationship, x.metamodel AS metamodel, x.source_namespace AS source_namespace, x.target_namespace AS target_namespace`,
              { ns: targetNamespace },
            );
            await createCrossNsInstanceRelEdges(
              crossNsEdgeIdRows.map((r) => ({
                source_node_id: Number(r.source_node_id), target_node_id: Number(r.target_node_id),
                edge_id: Number(r.edge_id), relationship: String(r.relationship), metamodel: String(r.metamodel),
                source_namespace: String(r.source_namespace), target_namespace: String(r.target_namespace),
              })),
              dbModule,
            );
            sourceLinksWritten = crossNsRows.length;
          }
        }

        logger?.info?.(`materialized view '${params.view}' into namespace '${targetNamespace}'`, {
          representatives: representatives.length, relationships: relationshipsWritten, sourceLinks: sourceLinksWritten,
        });

        return {
          ok: true,
          data: {
            targetNamespace,
            metamodel: view.metamodel,
            representativesWritten: representatives.length,
            relationshipsWritten,
            sourceLinksWritten,
          },
        };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return service;
}
