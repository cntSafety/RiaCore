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
 * The concept presentation catalog (spec-view.md Phase 4.1).
 *
 * Structurally a mirror of `query-catalog.ts`, and deliberately so: presentation
 * metadata has the same lifecycle problem the query catalog was built for. It
 * must be correctable and extensible after deployment without a new release, it
 * must not live in the graph (that would cost a `SCHEMA_VERSION` bump and a
 * persistor round-trip extension for data that is not model content), and it
 * must be readable by more than the renderer.
 *
 * It also keeps `RiaViews.md`'s P6 intact: a view stores no presentation state,
 * and `CommonModel` declares no presentation attributes. Both remain true
 * because the presentation lives here instead.
 *
 * Shipped file: `packages/app-core/presentation/concept-presentation.json`.
 * Repository override: `<repo>/ria-config/concept-presentation.json`, merged by
 * `id` with whole-entry replacement (never field by field), repo wins.
 *
 * Read on demand rather than cached for the process lifetime, so an edited
 * catalog takes effect without a restart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConceptPresentation } from '@riacore/app-contracts';

export type PresentationEntrySource = 'repo' | 'shipped';

export interface ResolvedPresentation {
  entry: ConceptPresentation;
  source: PresentationEntrySource;
}

export interface PresentationCatalog {
  /** All entries, already merged by id (repo wins whole-entry). */
  entries: ConceptPresentation[];
  /** For diagnosability: which catalog a given id was resolved from. */
  sourceById: Map<string, PresentationEntrySource>;
}

export const REPO_PRESENTATION_RELATIVE_PATH = path.join('ria-config', 'concept-presentation.json');

/** Default when an entry omits `labelAttribute` — every CommonModel concept has `name`. */
const DEFAULT_LABEL_ATTRIBUTE = 'name';

/**
 * Resolve the shipped catalog's directory, mirroring `query-catalog.ts`'s
 * `resolveShippedQueriesRoot()` dev/packaged path search. `__dirname` is
 * `dist/views/` in the compiled output.
 */
function resolveShippedPresentationRoot(): string {
  const envRoot = process.env.RIACORE_PRESENTATION_ROOT;
  const candidates = [
    envRoot,
    path.resolve(__dirname, '..', '..', 'presentation'),
    path.resolve(__dirname, '..', '..', '..', 'presentation'),
    path.resolve(__dirname, '..', '..', '..', '..', 'presentation'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.resolve(__dirname, '..', '..', 'presentation');
}

/**
 * Validate one raw entry. A malformed catalog throws with a message naming the
 * offending entry rather than silently degrading to an empty catalog — a
 * renderer driving its concept classification off this would otherwise treat
 * *every* concept as unknown, which looks like a data problem rather than a
 * configuration one.
 */
function validateEntry(raw: unknown, sourceLabel: string): ConceptPresentation {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Malformed concept presentation catalog (${sourceLabel}): entry is not an object`);
  }
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Malformed concept presentation catalog (${sourceLabel}): entry missing a non-empty 'id'`);
  }
  for (const field of ['metamodel', 'concept', 'icon', 'color', 'shape'] as const) {
    if (typeof entry[field] !== 'string') {
      throw new Error(`Malformed concept presentation entry '${id}' (${sourceLabel}): '${field}' must be a string`);
    }
  }
  if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) {
    throw new Error(`Malformed concept presentation entry '${id}' (${sourceLabel}): 'order' must be a finite number`);
  }
  if (entry.labelAttribute !== undefined && typeof entry.labelAttribute !== 'string') {
    throw new Error(`Malformed concept presentation entry '${id}' (${sourceLabel}): 'labelAttribute' must be a string when present`);
  }
  if (entry.badgeAttributes !== undefined
    && (!Array.isArray(entry.badgeAttributes) || entry.badgeAttributes.some((value) => typeof value !== 'string'))) {
    throw new Error(`Malformed concept presentation entry '${id}' (${sourceLabel}): 'badgeAttributes' must be a string array when present`);
  }

  const metamodel = entry.metamodel as string;
  const concept = entry.concept as string;
  // The id is the composite key, so it has to agree with its two parts or a
  // repository override keyed by id would silently shadow a different concept.
  const expectedId = `${metamodel}/${concept}`;
  if (id !== expectedId) {
    throw new Error(
      `Malformed concept presentation entry '${id}' (${sourceLabel}): 'id' must be '<metamodel>/<concept>', i.e. '${expectedId}'`,
    );
  }

  return {
    id,
    metamodel,
    concept,
    icon: entry.icon as string,
    color: entry.color as string,
    shape: entry.shape as string,
    order: entry.order as number,
    labelAttribute: (entry.labelAttribute as string | undefined) ?? DEFAULT_LABEL_ATTRIBUTE,
    badgeAttributes: (entry.badgeAttributes as string[] | undefined) ?? [],
  };
}

function readCatalogFile(filePath: string, sourceLabel: string): ConceptPresentation[] {
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    // Strip a UTF-8 BOM — see the same note in `query-catalog.ts`. A repository
    // catalog is hand-authored, and Windows editors commonly write one.
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(
      `Malformed concept presentation catalog (${sourceLabel}) at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed concept presentation catalog (${sourceLabel}) at ${filePath}: expected a JSON array`);
  }
  return parsed.map((raw) => validateEntry(raw, sourceLabel));
}

/**
 * Load and merge the shipped and repository-provided presentation catalogs.
 * Read on demand — not cached — so an edited repo catalog takes effect on the
 * next call without a restart.
 */
export function loadPresentationCatalog(workingDir: string): PresentationCatalog {
  const shippedPath = path.join(resolveShippedPresentationRoot(), 'concept-presentation.json');
  const repoPath = path.join(workingDir, REPO_PRESENTATION_RELATIVE_PATH);

  const shippedEntries = readCatalogFile(shippedPath, 'shipped');
  const repoEntries = readCatalogFile(repoPath, 'repository');

  const sourceById = new Map<string, PresentationEntrySource>();
  const byId = new Map<string, ConceptPresentation>();
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

/** Resolve one entry by id, reporting which catalog it came from. */
export function resolvePresentation(catalog: PresentationCatalog, id: string): ResolvedPresentation | undefined {
  const entry = catalog.entries.find((e) => e.id === id);
  if (!entry) return undefined;
  const source = catalog.sourceById.get(id) ?? 'shipped';
  return { entry, source };
}

/**
 * Every entry for one metamodel, ordered by `order` then `concept` so a
 * consumer rendering a legend or a palette gets a stable sequence without
 * sorting it itself.
 */
export function presentationForMetamodel(catalog: PresentationCatalog, metamodel: string): ConceptPresentation[] {
  return catalog.entries
    .filter((entry) => entry.metamodel === metamodel)
    .sort((a, b) => (a.order - b.order) || a.concept.localeCompare(b.concept));
}
