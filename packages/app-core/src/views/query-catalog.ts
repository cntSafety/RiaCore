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
 * The view query catalog (docs/coreSpecs/RiaViews.md — "The Query Catalog").
 *
 * Mapping queries are not compiled into the software: they live in a JSON
 * catalog that ships alongside the software and is read on demand at
 * evaluation time, so it can be corrected or extended after deployment without
 * a new release. A project may additionally supply its own catalog in the
 * repository directory, whose entries replace shipped entries of the same
 * `id` in full (never merged field by field).
 *
 * Read on demand rather than cached for the process lifetime, so an updated
 * catalog takes effect without a restart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QueryCatalogEntryMode, QueryCatalogEntry } from '@riacore/app-contracts';

export type CatalogEntrySource = 'repo' | 'shipped';

export interface ResolvedQuery {
  entry: QueryCatalogEntry;
  source: CatalogEntrySource;
}

export interface ViewQueryCatalog {
  /** All entries, already merged by id (repo wins whole-entry). */
  entries: QueryCatalogEntry[];
  /** For diagnosability: which catalog a given id was resolved from. */
  sourceById: Map<string, CatalogEntrySource>;
}

/** `'edges'` is a catalog query kind, not a public evaluation mode — see
 *  `QueryCatalogEntryMode`. */
const CATALOG_MODES: QueryCatalogEntryMode[] = ['whole', 'element', 'elements', 'traversal', 'edges'];

/**
 * Same write-statement shape IDbModule.runQuery uses to route reads vs. writes.
 *
 * Note it is matched against the whole entry, comments included: a `--` or `//`
 * line mentioning one of these words in passing ("...belongs to neither set;")
 * rejects the entry at load. Word your comments around it.
 */
export const WRITE_STATEMENT_PATTERN = /\b(CREATE|MERGE|DELETE|SET|DROP|ALTER|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|DETACH)\b/i;

/**
 * Query-engine defects a catalog entry has to be written around.
 *
 * All five are reproduced against the shipped `@ladybugdb/core` with the real
 * schema (`node_id`/`edge_id` are `SERIAL` primary keys); 1–4 on 0.19.1/0.20.1,
 * 5 on the shipped 0.19.1. Upstream reports: LadybugDB/ladybug#887, #888, #889
 * (defects 1–3); defect 5 is not yet reported upstream. They are recorded here
 * rather than in a commit message because each one fails in a way that does not
 * look like a bug in the entry you are editing.
 *
 * 1. **`UNWIND` feeding a primary-key lookup whose properties you project.**
 *    `UNWIND $ns AS n / MATCH (ri) WHERE ri.namespace = n / MATCH (src) WHERE
 *    src.node_id = ri.source_node_id / RETURN src.attributes` raises
 *    "Cannot evaluate expression with type PROPERTY" on 0.19.1, and on 0.20.1
 *    silently returns zero rows instead. It is specifically *projecting* a
 *    property of the looked-up node that breaks it — filtering on one is fine,
 *    which is exactly why the `Ownership`/`Expose` branches here filter on
 *    `src`/`tgt` but project only `ri.*`. That is load-bearing. Safe forms:
 *    `WHERE x.namespace IN $sourceNamespaces` with no `UNWIND`, or one
 *    comma-joined `MATCH (a), (b)` under a single `WHERE` (the workaround
 *    `import-write-service.ts` already applies on the write side).
 *
 * 2. **A predicate that depends on no variable is silently dropped.**
 *    `MATCH (a) WHERE $direction = 'incoming' RETURN a` returns *every* row; in
 *    `WHERE $direction = 'incoming' AND a.concept = 'port_usage'` only the second
 *    conjunct survives. So the `$relationship`/`$direction`/`$depth` guards
 *    inside the traversal branches do nothing — they are documentation. Every
 *    branch must therefore be anchored by a predicate over a real column
 *    (`CAST(x.node_id AS STRING) IN $representativeIds`), and correctness must
 *    not depend on those parameter-only conjuncts. The *leading*
 *    `UNWIND ... / WITH ... / WHERE $relationship = ...` guard does work, because
 *    a projection-body `WHERE` takes a different planner path.
 *
 * 3. **A constant-only leading `WITH` followed by `WHERE` terminates the
 *    process.** `WITH 1 AS gate WHERE gate >= 2 RETURN gate` exits with an access
 *    violation — not an error the caller can catch. A `WITH` preceded by a
 *    `MATCH`/`UNWIND`, or one projecting a variable, is fine.
 *
 * 4. **A list parameter inside a `CASE` makes the column `ANY`,** which then
 *    fails `UNION ALL` column-type checking with "<col> has data type STRING but
 *    ANY was expected". Neither `CAST(... AS STRING)` around the `CASE` nor
 *    `list_contains()` avoids it. Resolve membership into a boolean in a `WITH`
 *    first and let the `CASE` test that (`WITH ci, (ci.concept IN $group) AS
 *    isConnection`), or split into branches so the parameter only appears in a
 *    `WHERE`. The same applies to anything derived from a parameter:
 *    `UNWIND $sourceNamespaces AS ns` makes `ns` parameter-typed, so project
 *    `ci.namespace` rather than `ns`.
 *
 * 5. **An `UNWIND`-bound scalar anchor collapses a variable-length plan.**
 *    `UNWIND $representativeIds AS ridStr / WITH CAST(ridStr AS INT64) AS rid /
 *    MATCH (a) WHERE a.node_id = rid / MATCH (a)-[r:...* 1..1 ...]->(b)` costs
 *    **~1.7s per call** on a 38k-node graph — and does so for *any* anchor set,
 *    including one that matches nothing, so the cost is not in the traversal.
 *    Anchoring the same walk by list membership over the same column,
 *    `WHERE CAST(a.node_id AS STRING) IN $representativeIds`, costs ~25ms for
 *    an identical row multiset. `PROFILE` gives the reason: the `UNWIND` form
 *    plans a `HASH_JOIN_BUILD` over a full `SCAN_NODE_TABLE` of all 37,658
 *    nodes on the recursive join's build side, where the membership form keeps
 *    the anchor a selective scan. It is the same family as defect 1 —
 *    `UNWIND` feeding a primary-key lookup — but it fails as latency rather
 *    than as wrong rows, which is strictly harder to notice: the results are
 *    correct and no error is raised.
 *
 *    So anchor a traversal branch with `IN $representativeIds`, never with an
 *    `UNWIND`-bound scalar. Note this is also exactly the form defect 2 already
 *    requires for a different reason, so there is no tension between them. The
 *    `$relationship`/`$direction` guard is kept in a `WITH a WHERE ...` after
 *    the anchor: that keeps it a projection-body `WHERE` (the placement defect 2
 *    says is the only one that works) while projecting a real variable, so
 *    defect 3 is not reached. `catalog-queries.test.ts` asserts the anchor shape
 *    structurally.
 *
 * One more constraint that is not a defect: these entries run close to the
 * buffer-pool ceiling, and what a statement's peak tracks is **how many copies of
 * an expensive resolution it carries** — NOT its `UNION ALL` branch count.
 *
 * That distinction was measured, because the branch-count reading of it was
 * wrong and cost real effort. Under the 512 MB cap the integration tests impose,
 * on the reference model, with peak inferred from how many concurrent copies of a
 * statement survive:
 *
 *   twelve copies of a *cheap* branch in one statement   ~64 MB
 *   one copy of the SysML contextual-endpoint resolution ~64 MB
 *   three copies (`edges`, 10 branches)                 ~256 MB
 *   four copies (`whole`, 12 branches)                  ~512 MB
 *
 * It is a step at the second copy, not a slope, and each such branch is cheap in
 * isolation. So `whole` at four copies sat exactly on the ceiling, and what was
 * recorded here as "failed outright at 14 branches" was really a fifth copy.
 *
 * Prefer widening an existing branch's predicates over adding another branch that
 * repeats the same joins — the advice is unchanged, but the reason is the repeated
 * *resolution*, not the branch. When a projection genuinely needs several, split it
 * into a base entry plus numbered continuations rather than growing one statement:
 * see {@link resolveQuerySeries}. `catalog-queries.test.ts` asserts the one-copy
 * limit structurally, because exceeding it makes some *other* concurrent
 * evaluation fail with "the buffer pool is full and no memory could be freed".
 *
 * Full measurements: docs/particular/SysMLViewBufferPoolExhaustion.md.
 */

export const REPO_CATALOG_RELATIVE_PATH = path.join('ria-config', 'view-queries.json');

/**
 * Resolve the shipped catalog's directory, mirroring
 * `profile-registry.ts`'s `resolveProfilesRoot()` dev/packaged path search.
 * `__dirname` is `dist/views/` in the compiled output.
 */
function resolveShippedQueriesRoot(): string {
  const envRoot = process.env.RIACORE_VIEW_QUERIES_ROOT;
  const candidates = [
    envRoot,
    path.resolve(__dirname, '..', '..', 'queries'),
    path.resolve(__dirname, '..', '..', '..', 'queries'),
    path.resolve(__dirname, '..', '..', '..', '..', 'queries'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.resolve(__dirname, '..', '..', 'queries');
}

function validateEntry(raw: unknown, sourceLabel: string): QueryCatalogEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Malformed view query catalog (${sourceLabel}): entry is not an object`);
  }
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Malformed view query catalog (${sourceLabel}): entry missing a non-empty 'id'`);
  }
  for (const field of ['description', 'sourceMetamodel', 'cypher'] as const) {
    if (typeof entry[field] !== 'string') {
      throw new Error(`Malformed view query catalog entry '${id}' (${sourceLabel}): '${field}' must be a string`);
    }
  }
  if (typeof entry.mode !== 'string' || !CATALOG_MODES.includes(entry.mode as QueryCatalogEntryMode)) {
    throw new Error(
      `Malformed view query catalog entry '${id}' (${sourceLabel}): 'mode' must be one of ${CATALOG_MODES.join(', ')}`,
    );
  }
  if (!Array.isArray(entry.parameters) || entry.parameters.some((p) => typeof p !== 'string')) {
    throw new Error(`Malformed view query catalog entry '${id}' (${sourceLabel}): 'parameters' must be a string array`);
  }
  const cypher = entry.cypher as string;
  if (WRITE_STATEMENT_PATTERN.test(cypher)) {
    throw new Error(
      `View query catalog entry '${id}' (${sourceLabel}) contains a write-shaped Cypher statement — ` +
      `view evaluation must be read-only (docs/coreSpecs/RiaViews.md)`,
    );
  }

  return {
    id,
    description: entry.description as string,
    sourceMetamodel: entry.sourceMetamodel as string,
    mode: entry.mode as QueryCatalogEntryMode,
    parameters: entry.parameters as string[],
    cypher,
  };
}

function readCatalogFile(filePath: string, sourceLabel: string): QueryCatalogEntry[] {
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    // Strip a UTF-8 BOM before parsing. `JSON.parse` rejects one outright
    // ("Unexpected token '﻿'"), and a repository catalog is a file a user
    // authors by hand — many Windows editors and PowerShell's own redirection
    // write a BOM by default, so this is the normal case there, not an edge one.
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(
      `Malformed view query catalog (${sourceLabel}) at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed view query catalog (${sourceLabel}) at ${filePath}: expected a JSON array`);
  }
  return parsed.map((raw) => validateEntry(raw, sourceLabel));
}

/**
 * Load and merge the shipped and repository-provided query catalogs. Read on
 * demand — not cached — so an edited repo catalog takes effect on the next
 * call without a restart.
 */
export function loadCatalog(workingDir: string): ViewQueryCatalog {
  const shippedPath = path.join(resolveShippedQueriesRoot(), 'view-queries.json');
  const repoPath = path.join(workingDir, REPO_CATALOG_RELATIVE_PATH);

  const shippedEntries = readCatalogFile(shippedPath, 'shipped');
  const repoEntries = readCatalogFile(repoPath, 'repository');

  const sourceById = new Map<string, CatalogEntrySource>();
  const byId = new Map<string, QueryCatalogEntry>();
  for (const entry of shippedEntries) {
    byId.set(entry.id, entry);
    sourceById.set(entry.id, 'shipped');
  }
  // Repository entries replace shipped entries of the same id in full.
  for (const entry of repoEntries) {
    byId.set(entry.id, entry);
    sourceById.set(entry.id, 'repo');
  }

  return { entries: [...byId.values()], sourceById };
}

/** Resolve one catalog entry by id, reporting which catalog it came from. */
export function resolveQuery(catalog: ViewQueryCatalog, id: string): ResolvedQuery | undefined {
  const entry = catalog.entries.find((e) => e.id === id);
  if (!entry) return undefined;
  const source = catalog.sourceById.get(id) ?? 'shipped';
  return { entry, source };
}

/**
 * Resolve a catalog id together with its numbered continuations — `<id>`,
 * `<id>.2`, `<id>.3`, ... — stopping at the first gap. Evaluation runs every
 * member and merges their rows into one result.
 *
 * This exists because a statement's buffer-pool peak tracks **how many copies
 * of an expensive resolution it carries**, not how many `UNION ALL` branches it
 * has. Measured on the reference model under the 512 MB cap the integration
 * tests impose: the SysML contextual-endpoint (`feature_chaining`) resolution
 * costs ~64 MB at one copy per statement, ~256 MB at three, and ~512 MB at
 * four — while twelve copies of a *cheap* branch still peak at ~64 MB. So
 * `sysml_v2.common_model.whole` at four copies sat exactly on the ceiling,
 * which is what "failed outright at 14 branches" actually was.
 *
 * Splitting such a projection into a base entry holding the copy-free branches
 * plus one continuation per expensive branch returns an identical row multiset
 * at roughly an eighth of the peak, at the cost of one extra round trip per
 * continuation. See docs/particular/SysMLViewBufferPoolExhaustion.md.
 *
 * Returns an empty array when the base id itself is absent, so a caller can
 * still tell "no such entry" from "an entry with no continuations".
 */
export function resolveQuerySeries(catalog: ViewQueryCatalog, id: string): ResolvedQuery[] {
  const base = resolveQuery(catalog, id);
  if (!base) return [];
  const series = [base];
  for (let n = 2; ; n += 1) {
    const next = resolveQuery(catalog, `${id}.${n}`);
    if (!next) return series;
    series.push(next);
  }
}
