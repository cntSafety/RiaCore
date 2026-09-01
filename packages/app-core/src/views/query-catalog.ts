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

/** Same write-statement shape IDbModule.runQuery uses to route reads vs. writes. */
export const WRITE_STATEMENT_PATTERN = /\b(CREATE|MERGE|DELETE|SET|DROP|ALTER|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|DETACH)\b/i;

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
