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
 * Persistor store() — exports the complete graph database state to
 * git-friendly JSON files in `{workingDir}/ria-data/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import { serializeTable, serializeMetadata, parseTable } from './serializer.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { getTablesByLayer } from './table-registry.js';
import { replaceNodeIdsWithStableIds, resolveStableIdFromMeta } from './stable-id.js';
import { computeNamespaceHashFromFileContents, computeUniverseFileHash } from './hash-computer.js';
import { sanitizeDirectoryName, detectDirectoryConflicts } from './sanitize-directory.js';
import type {
  PersistorStoreParams,
  StoreResult,
  Manifest,
  SkippedTypeReport,
  NodeKeyAttrMap,
  EdgeKeyAttrMap,
} from './persistor-types.js';
import { assertNoSnapshotDrift, setPendingSyncDecision, stampBaseline } from '../workspace/snapshot-baseline.js';
import { e, exportLayer, loadAttributeMetadata, writeFileAtomic } from './persistor-helpers.js';
import { sortConceptInstances, sortRelationshipInstances } from './persistor-sort.js';
import { computeMetaHash, computeNamespaceHashFromFiles } from './persistor.js';
import { originFromManifest, writeSnapshotOrigin } from './snapshot-origin.js';

/**
 * Universe-layer file paths, relative to the ria-data export directory. Shared
 * between the universe-scoped store path and the full/namespace store path so
 * both write and hash exactly the same files.
 */
export const UNIVERSE_CANVAS_LAYOUT_REL = 'universe/RIA_UNIV_CanvasLayout.json';
export const UNIVERSE_NAMESPACE_CONNECTION_REL = 'universe/RIA_UNIV_NamespaceConnection.json';
export const UNIVERSE_VIEW_REL = 'universe/RIA_UNIV_View.json';
export const UNIVERSE_VIEW_SOURCE_REL = 'universe/RIA_UNIV_VIEW_SOURCE.json';
export const UNIVERSE_VIEW_DEFINEDBY_REL = 'universe/RIA_UNIV_VIEW_DEFINEDBY.json';
export const UNIVERSE_VIEW_CATEGORIZEDBY_REL = 'universe/RIA_UNIV_VIEW_CATEGORIZEDBY.json';

/**
 * Re-export the shared per-file Universe_Hash helper (now owned by
 * `hash-computer.ts`, alongside the other hashing functions) so existing
 * importers of `./persistor-store.js` keep working. Both the universe-scoped
 * store path (task 2.1) and the full/namespace store path (task 2.2) use this
 * single helper for hash computation.
 */
export { computeUniverseFileHash };

// ── Namespace export plan ────────────────────────────────────────────────────

/**
 * Everything the store has decided about one namespace's `concepts/` and
 * `relationships/` directories, computed once before anything is hashed or
 * written.
 *
 * The plan exists so the recorded hash and the written files cannot be derived
 * independently: the hash is taken over the `content` of the entries it holds,
 * and the write loop writes exactly those. A declined type lands in `skipped`,
 * outside both the hash and the files. `content` is the exact serialized UTF-8
 * string handed to `fs.writeFileSync`, which is what lets the file side of the
 * contract reproduce the digest.
 */
interface NamespaceExportPlan {
  /** One entry per file that WILL be written, with its serialized content. */
  conceptFiles: Array<{ conceptType: string; content: string; count: number }>;
  relationshipFiles: Array<{ relType: string; content: string; count: number }>;
  /** Types deliberately not written, with the reason. Reported, never silent. */
  skipped: Array<{ kind: 'concept' | 'relationship'; type: string; reason: string; count: number }>;
  /** Instances dropped for an empty type field, counted so the drop is visible. */
  droppedUntyped: { concepts: number; relationships: number };
}

/**
 * Decide what one namespace's export will contain and serialize it.
 *
 * Pure: it reads rows and metadata and returns a plan. It does not log, write,
 * or hash — the caller does all three from the single plan, which is the point.
 *
 * `relInstances` must already carry `source_stable_id` / `target_stable_id`
 * (i.e. have been through `replaceNodeIdsWithStableIds`), because that is the
 * shape the relationship files are serialized from.
 */
function buildNamespaceExportPlan(
  conceptInstances: Record<string, unknown>[],
  relInstances: Record<string, unknown>[],
  nodeKeyAttrs: NodeKeyAttrMap,
  edgeKeyAttrs: EdgeKeyAttrMap,
): NamespaceExportPlan {
  const plan: NamespaceExportPlan = {
    conceptFiles: [],
    relationshipFiles: [],
    skipped: [],
    droppedUntyped: { concepts: 0, relationships: 0 },
  };

  // ── Concepts ───────────────────────────────────────────────────────────────
  const conceptsByType = new Map<string, Record<string, unknown>[]>();
  for (const ci of conceptInstances) {
    const conceptType = String(ci.concept ?? '');
    if (!conceptType) {
      plan.droppedUntyped.concepts++;
      continue;
    }
    // node_id is a DB-assigned ephemeral integer that changes across DB
    // recreations. Stripping it here keeps the serialized JSON stable and
    // prevents false diffs when the same logical data gets new node_ids.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { node_id, ...rest } = ci;
    const group = conceptsByType.get(conceptType);
    if (group) {
      group.push(rest as Record<string, unknown>);
    } else {
      conceptsByType.set(conceptType, [rest as Record<string, unknown>]);
    }
  }

  for (const conceptType of [...conceptsByType.keys()].sort()) {
    const instances = conceptsByType.get(conceptType)!;

    let sorted: Record<string, unknown>[];
    try {
      sorted = sortConceptInstances(instances, conceptType, nodeKeyAttrs);
    } catch (err) {
      plan.skipped.push({
        kind: 'concept',
        type: conceptType,
        reason: err instanceof Error ? err.message : String(err),
        count: instances.length,
      });
      continue;
    }

    plan.conceptFiles.push({
      conceptType,
      content: serializeTable(sorted, 'attributes', ['attributes'], []),
      count: instances.length,
    });
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  const relsByType = new Map<string, Record<string, unknown>[]>();
  for (const ri of relInstances) {
    const relType = String(ri.relationship ?? '');
    if (!relType) {
      plan.droppedUntyped.relationships++;
      continue;
    }
    const group = relsByType.get(relType);
    if (group) {
      group.push(ri);
    } else {
      relsByType.set(relType, [ri]);
    }
  }

  for (const relType of [...relsByType.keys()].sort()) {
    const instances = relsByType.get(relType)!;
    // Unlike sortConceptInstances this cannot throw: an undeclared type falls
    // back to (source_stable_id, target_stable_id). Relationship entries in
    // `skipped` therefore stay empty today; the field exists so a future
    // decline is reported through the same channel rather than a new one.
    const sorted = sortRelationshipInstances(instances, relType, edgeKeyAttrs);
    plan.relationshipFiles.push({
      relType,
      content: serializeTable(sorted, 'source_stable_id', ['attributes'], []),
      count: instances.length,
    });
  }

  return plan;
}

/**
 * Report a plan's declined writes: a WARN per skipped type and per dropped
 * untyped group, naming the type and the count, plus the `StoreResult` entries.
 *
 * Called on both the write path and the delta-skip path. On the skip path the
 * files on disk are the previous store's, so the types the plan declines are
 * just as absent from `ria-data/` as they would be after a write — the report
 * is about what the snapshot is missing, not about what this particular run
 * wrote.
 */
function reportPlanOmissions(
  namespace: string,
  plan: NamespaceExportPlan,
  logger: ImportLogger,
  into: SkippedTypeReport[],
): void {
  for (const s of plan.skipped) {
    logger.warn(
      `${namespace}: skipping ${s.kind} type '${s.type}' (${s.count} instance(s)) — ${s.reason}`,
      { namespace, kind: s.kind, type: s.type, count: s.count },
    );
    into.push({ namespace, kind: s.kind, type: s.type, reason: s.reason, count: s.count });
  }

  const untyped: Array<['concept' | 'relationship', number, string]> = [
    ['concept', plan.droppedUntyped.concepts, 'concept'],
    ['relationship', plan.droppedUntyped.relationships, 'relationship'],
  ];
  for (const [kind, count, field] of untyped) {
    if (count === 0) continue;
    const reason = `instance has an empty '${field}' field, so it belongs to no file`;
    logger.warn(
      `${namespace}: dropping ${count} ${kind} instance(s) with an empty '${field}' field`,
      { namespace, kind, count },
    );
    into.push({ namespace, kind, type: '', reason, count });
  }
}

/**
 * Read the current `RIA_UNIV_NamespaceConnection` rows from the DB, in the
 * canonical order used for serialization. Shared with the full store path.
 */
async function queryConnectionRows(dbModule: IDbModule): Promise<Record<string, unknown>[]> {
  return dbModule.runQuery(
    `MATCH (src:RIA_UNIV_Namespace)-[:RIA_UNIV_NamespaceConnection]->(dst:RIA_UNIV_Namespace)
     RETURN src.name AS src_name, dst.name AS dst_name
     ORDER BY src_name, dst_name`
  );
}

/**
 * Read the current `RIA_UNIV_CanvasLayout` rows from the DB, in the canonical
 * order used for serialization. Shared with the full store path.
 */
async function queryLayoutRows(dbModule: IDbModule): Promise<Record<string, unknown>[]> {
  return dbModule.runQuery(
    `MATCH (l:RIA_UNIV_CanvasLayout)
     RETURN l.layout_id AS layout_id, l.element_kind AS element_kind,
            l.element_key AS element_key, l.x AS x, l.y AS y
     ORDER BY layout_id`
  );
}

/**
 * Read the current `RIA_UNIV_View` rows from the DB, in the canonical order used
 * for serialization. Shared with the full store path.
 */
async function queryViewRows(dbModule: IDbModule): Promise<Record<string, unknown>[]> {
  return dbModule.runQuery(
    `MATCH (v:RIA_UNIV_View)
     RETURN v.name AS name, v.description AS description, v.metamodel AS metamodel,
            v.mapping AS mapping, v.parameters AS parameters
     ORDER BY name`
  );
}

/**
 * Read the current `RIA_UNIV_VIEW_SOURCE` / `RIA_UNIV_VIEW_DEFINEDBY` /
 * `RIA_UNIV_VIEW_CATEGORIZEDBY` rows from the DB, in the canonical order used for
 * serialization. Shared with the full store path.
 */
async function queryViewSourceRows(dbModule: IDbModule): Promise<Record<string, unknown>[]> {
  return dbModule.runQuery(
    `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_SOURCE]->(ns:RIA_UNIV_Namespace)
     RETURN v.name AS src_name, ns.name AS dst_name
     ORDER BY src_name, dst_name`
  );
}

async function queryViewDefinedByRows(dbModule: IDbModule): Promise<Record<string, unknown>[]> {
  return dbModule.runQuery(
    `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_DEFINEDBY]->(mm:RIA_META_Metamodel)
     RETURN v.name AS src_name, mm.name AS dst_name
     ORDER BY src_name, dst_name`
  );
}

async function queryViewCategorizedByRows(dbModule: IDbModule): Promise<Record<string, unknown>[]> {
  return dbModule.runQuery(
    `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_CATEGORIZEDBY]->(mm:RIA_META_Metamodel)
     RETURN v.name AS src_name, mm.name AS dst_name
     ORDER BY src_name, dst_name`
  );
}

/**
 * Universe-scoped store.
 *
 * Writes ONLY the two universe-layer files, reading the current DB rows at
 * execution time (never a snapshot captured at scheduling time). Each file is
 * written atomically (temp-file + fsync + rename) so an interrupted save never
 * corrupts it. Only the `universe_hashes` and `file_inventory` entries for the
 * two written files are updated in the manifest — every `namespace_hashes`
 * entry, `meta_hash`, `sourcemaster_hashes`, `cross_namespace_hashes` and every
 * other inventory entry is preserved byte-identical by parsing the existing
 * manifest and mutating only those two nested maps before re-serializing.
 *
 * ## The carrier-preservation invariant
 *
 * This path writes no namespace, meta, sourcemaster or cross-namespace file, so
 * it must record no hash for one either. Preservation is achieved by
 * *omission*: the parsed
 * manifest is mutated in place and re-serialized, so any carrier this function
 * does not name survives with its exact recorded value. Nothing extra is
 * needed — which is precisely what makes the invariant fragile, because a
 * future edit that adds a carrier write here (or recomputes one "for
 * consistency") would silently record a hash for a file this store never
 * touched, and the next load would verify fresh hashes against stale files.
 * The only carrier this function may touch is `universe_hashes`, and only for
 * the files it just wrote.
 */
async function storeUniverseOnly(
  params: PersistorStoreParams,
  dbModule: IDbModule,
  logger: ImportLogger,
): Promise<StoreResult> {
  const storeStart = Date.now();
  const exportedAt = new Date().toISOString();
  const exportDir = path.join(params.workingDir, 'ria-data');
  const universeDir = path.join(exportDir, 'universe');
  fs.mkdirSync(universeDir, { recursive: true });

  // Read current DB rows at execution time, then serialize with the
  // same primitives / sort keys as the full store path so bytes are identical.
  const connectionRows = await queryConnectionRows(dbModule);
  const layoutRows = await queryLayoutRows(dbModule);
  const viewRows = await queryViewRows(dbModule);
  const viewSourceRows = await queryViewSourceRows(dbModule);
  const viewDefinedByRows = await queryViewDefinedByRows(dbModule);
  const viewCategorizedByRows = await queryViewCategorizedByRows(dbModule);

  const connectionContent = serializeTable(connectionRows, 'src_name', [], []);
  const layoutContent = serializeTable(layoutRows, 'layout_id', [], []);
  const viewContent = serializeTable(viewRows, 'name', ['parameters'], []);
  const viewSourceContent = serializeTable(viewSourceRows, 'src_name', [], []);
  const viewDefinedByContent = serializeTable(viewDefinedByRows, 'src_name', [], []);
  const viewCategorizedByContent = serializeTable(viewCategorizedByRows, 'src_name', [], []);

  const connectionFilePath = path.join(exportDir, UNIVERSE_NAMESPACE_CONNECTION_REL);
  const layoutFilePath = path.join(exportDir, UNIVERSE_CANVAS_LAYOUT_REL);
  const viewFilePath = path.join(exportDir, UNIVERSE_VIEW_REL);
  const viewSourceFilePath = path.join(exportDir, UNIVERSE_VIEW_SOURCE_REL);
  const viewDefinedByFilePath = path.join(exportDir, UNIVERSE_VIEW_DEFINEDBY_REL);
  const viewCategorizedByFilePath = path.join(exportDir, UNIVERSE_VIEW_CATEGORIZEDBY_REL);

  // Atomic writes: an interrupted or failed write leaves the previous complete
  // file untouched. A failure rethrows so the caller's failure
  // path engages.
  writeFileAtomic(layoutFilePath, layoutContent);
  writeFileAtomic(connectionFilePath, connectionContent);
  writeFileAtomic(viewFilePath, viewContent);
  writeFileAtomic(viewSourceFilePath, viewSourceContent);
  writeFileAtomic(viewDefinedByFilePath, viewDefinedByContent);
  writeFileAtomic(viewCategorizedByFilePath, viewCategorizedByContent);

  // Load the existing manifest and mutate ONLY the universe entries written here.
  // This preserves namespace_hashes, meta_hash, sourcemaster_hashes,
  // cross_namespace_hashes, and every other inventory entry byte-identical. A
  // universe-scoped store only runs on a loaded workspace, which always has a
  // manifest on disk.
  //
  // Do not add a carrier write below. `sourcemaster_hashes`,
  // `cross_namespace_hashes`, `namespace_hashes` and `meta_hash` are preserved
  // because nothing here assigns to them; see the carrier-preservation
  // invariant in this function's doc comment.
  const manifestPath = path.join(exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `universe-scope store requires an existing manifest.json; none found at ${manifestPath}`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;

  const universeHashes: Record<string, string> = { ...(manifest.universe_hashes ?? {}) };
  universeHashes[UNIVERSE_CANVAS_LAYOUT_REL] = computeUniverseFileHash(layoutContent);
  universeHashes[UNIVERSE_NAMESPACE_CONNECTION_REL] = computeUniverseFileHash(connectionContent);
  universeHashes[UNIVERSE_VIEW_REL] = computeUniverseFileHash(viewContent);
  universeHashes[UNIVERSE_VIEW_SOURCE_REL] = computeUniverseFileHash(viewSourceContent);
  universeHashes[UNIVERSE_VIEW_DEFINEDBY_REL] = computeUniverseFileHash(viewDefinedByContent);
  universeHashes[UNIVERSE_VIEW_CATEGORIZEDBY_REL] = computeUniverseFileHash(viewCategorizedByContent);
  manifest.universe_hashes = universeHashes;

  manifest.file_inventory[UNIVERSE_CANVAS_LAYOUT_REL] = layoutRows.length;
  manifest.file_inventory[UNIVERSE_NAMESPACE_CONNECTION_REL] = connectionRows.length;
  manifest.file_inventory[UNIVERSE_VIEW_REL] = viewRows.length;
  manifest.file_inventory[UNIVERSE_VIEW_SOURCE_REL] = viewSourceRows.length;
  manifest.file_inventory[UNIVERSE_VIEW_DEFINEDBY_REL] = viewDefinedByRows.length;
  manifest.file_inventory[UNIVERSE_VIEW_CATEGORIZEDBY_REL] = viewCategorizedByRows.length;

  const manifestBytes = serializeMetadata(manifest as unknown as Record<string, unknown>);
  writeFileAtomic(manifestPath, manifestBytes);

  // Third write point for D (task 5.2). This path is easy to overlook because it
  // writes no namespace content — but it rewrites `manifest.json`, so it moves
  // both the manifest's own digest and the universe entries. Omitting it would
  // leave the manifest domain in S2 after every canvas auto-save: harmless in
  // itself, because the next open then runs a cheap full evaluation and finds
  // everything S1, but it would retire the manifest short-circuit permanently
  // after the first auto-save of a session.
  await writeSnapshotOrigin(dbModule, originFromManifest(manifest, manifestBytes), logger);

  const totalRecords = layoutRows.length + connectionRows.length + viewRows.length +
    viewSourceRows.length + viewDefinedByRows.length + viewCategorizedByRows.length;
  const universeFilesWritten = [
    UNIVERSE_CANVAS_LAYOUT_REL, UNIVERSE_NAMESPACE_CONNECTION_REL,
    UNIVERSE_VIEW_REL, UNIVERSE_VIEW_SOURCE_REL, UNIVERSE_VIEW_DEFINEDBY_REL, UNIVERSE_VIEW_CATEGORIZEDBY_REL,
  ];

  const elapsed = Date.now() - storeStart;
  logger.info(
    `store [scope=universe] done — ${UNIVERSE_CANVAS_LAYOUT_REL} (${layoutRows.length} record(s)), ` +
    `${UNIVERSE_NAMESPACE_CONNECTION_REL} (${connectionRows.length} record(s)), ` +
    `${UNIVERSE_VIEW_REL} (${viewRows.length} record(s)), elapsed=${elapsed}ms`
  );

  return {
    exported_at: exportedAt,
    // Six universe files + the manifest.
    files_written: universeFilesWritten.length + 1,
    namespaces_skipped: [],
    namespaces_written: [],
    total_records: totalRecords,
    universe_files_written: universeFilesWritten,
  };
}

// ── Store serialization ──────────────────────────────────────────────────────
// All store() executions for the same workspace are serialized through a
// per-workingDir promise chain. Every store variant (full, namespace-scoped,
// universe-scoped) reads manifest.json, mutates its own slice, and writes the
// whole file back. With Auto_Save now firing scoped stores from several
// independent sources (per-import, authored-namespace creation, the safety
// editor's useAutoSave, and the debounced canvas universe save), two
// overlapping stores could each read the manifest and then write back — the
// second clobbering the first's just-added namespace/universe hash (symptom: a
// namespace missing from manifest.namespace_hashes). Serializing per workspace
// makes each read-modify-write of the manifest atomic with respect to other
// stores, without needing a lock inside every write site.
const storeChains = new Map<string, Promise<unknown>>();

export function store(
  params: PersistorStoreParams,
  dbModule: IDbModule,
  logger: ImportLogger,
): Promise<StoreResult> {
  const key = path.resolve(params.workingDir);
  const prior = storeChains.get(key) ?? Promise.resolve();
  const run = prior.then(async () => {
    // ── Write fence ──────────────────────────
    // Refuse to write when ria-data/ no longer matches the snapshot the DB was
    // loaded from — a git checkout, a pull on the same branch, a reset, a stash
    // pop, a restore from backup, or a concurrent CLI store. Throwing here also
    // means runStoreCommitHook never runs, so a drifted write cannot be
    // auto-committed.
    //
    // Deliberately INSIDE the serialisation chain: a check outside it could be
    // overtaken by a concurrent store for the same workspace, leaving a window
    // between "verified" and "written".
    assertNoSnapshotDrift(params.workingDir, params.allowSnapshotMismatch, logger);

    const result = await storeImpl(params, dbModule, logger);

    // The files on disk are now exactly what we just wrote, so they become the
    // new baseline. Doing this here rather than in the dispatch handler covers
    // the auto-save coordinator too, which calls the persistor directly and
    // never passes through the dispatcher.
    //
    // CONFIRMED BEHAVIOUR the hash-epoch migration depends on: the re-stamp is
    // unconditional, so the store that moves a workspace into a new epoch also
    // replaces a baseline holding previous-epoch hashes. Without it the next
    // detectDrift would compare across epochs and report drift for files this
    // store just wrote.
    stampBaseline(params.workingDir, undefined, { reason: 'store' });
    // The dialog's explicit full Store resolves the open-time decision as well
    // as file drift. Clear it only after export succeeds, inside this queue, so
    // the next save can proceed. A scoped store may leave disputed domains
    // untouched and must not dismiss their decision.
    if (params.allowSnapshotMismatch && params.namespace === undefined && params.scope === undefined) {
      setPendingSyncDecision(params.workingDir, null);
    }
    return result;
  });
  // Keep the chain alive regardless of this run's outcome so a failed store
  // never wedges subsequent stores for the same workspace.
  storeChains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

async function storeImpl(
  params: PersistorStoreParams,
  dbModule: IDbModule,
  logger: ImportLogger,
): Promise<StoreResult> {
  // Universe-scoped store: write only the two universe-layer files and touch
  // only their manifest entries. Handled by a dedicated path so
  // frequent auto-saves never re-serialize or re-hash namespace layers.
  //
  // Bootstrap guard: storeUniverseOnly requires an existing manifest.json (it
  // mutates only the two universe entries and preserves everything else). On a
  // fresh workspace the very first auto-save can fire before any full store has
  // written a manifest — in that case fall through to the FULL store path,
  // which (with no params.namespace) writes all namespaces + the universe files
  // + a complete manifest. Once a manifest exists, subsequent universe-scoped
  // saves take the cheap dedicated path.
  if (params.scope === 'universe') {
    const manifestPath = path.join(params.workingDir, 'ria-data', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      return storeUniverseOnly(params, dbModule, logger);
    }
    logger.info(
      'store [scope=universe]: no manifest yet — bootstrapping with a full store'
    );
    // Fall through to the full-store body below. params.namespace is undefined
    // for a universe-scoped call, so this performs a complete full store.
  }

  const storeStart = Date.now();
  const exportedAt = new Date().toISOString();
  const exportDir = path.join(params.workingDir, 'ria-data');

  // Step 1: Ensure export directory exists
  fs.mkdirSync(exportDir, { recursive: true });

  // Step 1a: Ensure .gitattributes enforces LF line endings for ria-data/ files.
  // This prevents cross-platform line-ending noise when the persistor (which always
  // writes LF) runs on Windows where core.autocrlf may be true.
  const gitattributesPath = path.join(exportDir, '.gitattributes');
  const gitattributesContent = [
    '# Auto-generated by RIACore persistor — do not edit.',
    '# Enforce LF line endings for all serialized data files.',
    '*.json text eol=lf',
    '.gitattributes text eol=lf',
    '',
    '# Merge driver: RiaCore tooling handles all JSON merges manually.',
    '# Git must not attempt to auto-merge these files.',
    '# Register the driver locally with: git config merge.riacore.driver true',
    '*.json merge=riacore',
    '',
  ].join('\n');
  let gitattributesChanged = false;
  if (!fs.existsSync(gitattributesPath) || fs.readFileSync(gitattributesPath, 'utf-8') !== gitattributesContent) {
    fs.writeFileSync(gitattributesPath, gitattributesContent, 'utf-8');
    gitattributesChanged = true;
  }

  // Step 1b: Determine whether schema version requires a full re-export.
  // Also capture the on-disk namespace hashes so the delta-skip can detect
  // external changes (e.g. git checkout) that replaced files behind the app.
  //
  // CONFIRMED BEHAVIOUR the hash-epoch migration depends on: a manifest written
  // in a previous epoch sets `forceFullReExport`, so this one store rewrites
  // every file and every carrier and stamps `schema_version` at the current
  // value — which is what moves the workspace into the current epoch and makes
  // the comparisons `persistor-load` and `checkConsistency` suspended live
  // again. Do not narrow this to a delta: a delta-skipped namespace would keep
  // its previous-epoch hash in the manifest and stay unverifiable forever
  const existingManifestPath = path.join(exportDir, 'manifest.json');
  let forceFullReExport = false;
  // Tracked separately from forceFullReExport, which is also set for
  // line-ending normalization. Only an epoch difference invalidates the hashes
  // of namespaces this store is not writing, so only it may promote a scope.
  let epochMismatch = false;
  let onDiskNamespaceHashes: Record<string, string> = {};
  if (!fs.existsSync(existingManifestPath)) {
    forceFullReExport = true;
  } else {
    try {
      const existingManifest = JSON.parse(fs.readFileSync(existingManifestPath, 'utf-8')) as Partial<Manifest>;
      const existingSchemaVersion = String(existingManifest.schema_version ?? '');
      if (existingSchemaVersion !== SCHEMA_VERSION) {
        forceFullReExport = true;
        epochMismatch = true;
        logger.info(
          `full re-export triggered: schema version mismatch (manifest=${existingSchemaVersion || 'unknown'}, code=${SCHEMA_VERSION})`
        );
      }
      // Capture on-disk hashes regardless of schema version — used below to
      // detect external file changes (git checkout, manual edits, etc.).
      onDiskNamespaceHashes = (existingManifest.namespace_hashes as Record<string, string> | undefined) ?? {};
    } catch {
      forceFullReExport = true;
      logger.warn('existing manifest.json is unreadable; forcing full re-export');
    }
  }

  // If .gitattributes was just created or updated, force a full re-export so that
  // all existing files are rewritten with LF line endings (eliminating CRLF noise).
  if (gitattributesChanged) {
    forceFullReExport = true;
    logger.info('full re-export triggered: .gitattributes created/updated — normalizing line endings');
  }

  // Step 1c: Detect CRLF in existing files. If the manifest (or any sampled file)
  // contains \r\n, force a full re-export to normalize all files to LF.
  // This handles the case where .gitattributes exists but files were checked out
  // before it was committed (so they still have CRLF from core.autocrlf=true).
  if (!forceFullReExport && fs.existsSync(existingManifestPath)) {
    const sample = fs.readFileSync(existingManifestPath, 'utf-8');
    if (sample.includes('\r\n')) {
      forceFullReExport = true;
      logger.info('full re-export triggered: existing files contain CRLF — normalizing to LF');
    }
  }

  // Step 2: Query all namespaces (including their stored content_hash)
  const nsRows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace)
     RETURN ns.name AS name,
            ns.metamodel AS metamodel,
            ns.namespace_role AS namespace_role,
            ns.namespace_owning_application AS namespace_owning_application,
            ns.content_hash AS content_hash
     ORDER BY ns.name`
  );
  const allNamespaces = nsRows.map(r => ({
    name: String(r.name ?? ''),
    metamodel: String(r.metamodel ?? ''),
    namespace_role: String(r.namespace_role ?? ''),
    namespace_owning_application: String(r.namespace_owning_application ?? ''),
    content_hash: String(r.content_hash ?? ''),
  }));

  // An epoch change must rewrite EVERY namespace hash, so a scoped store is
  // promoted to a full export. Honouring the scope would stamp the manifest at
  // the current SCHEMA_VERSION while seeding every other namespace's hash from
  // the previous-epoch manifest. Those hashes then no longer suspend comparison
  // and cannot be recomputed from the files, so the next open reports the
  // untouched namespaces corrupt and the workspace opens read-only with Save
  // blocked. Auto-save issues namespace-scoped stores, so that is the ordinary
  // path after a bump, not an edge case.
  const scopeNamespace =
    epochMismatch && params.namespace !== undefined ? undefined : params.namespace;
  if (scopeNamespace === undefined && params.namespace !== undefined) {
    logger.info(
      `scoped store promoted to a full export: the manifest was written in a ` +
      `different hash epoch, so every namespace hash must be rewritten ` +
      `(requested: ${params.namespace})`
    );
  }

  // When a specific namespace is requested, filter to only that namespace.
  // The full allNamespaces list is still needed for manifest metadata.
  const namespaces = scopeNamespace
    ? allNamespaces.filter(ns => ns.name === scopeNamespace)
    : allNamespaces;

  const scopedStore = scopeNamespace !== undefined;

  logger.info(`store started — ${namespaces.length} namespace(s) to export (${allNamespaces.length} total in DB)${scopedStore ? ` [scoped to: ${scopeNamespace}]` : ''}`);

  // Step 2b: Compute sanitized directory names and detect conflicts
  const nsDirMap = new Map<string, string>();
  for (const ns of allNamespaces) {
    nsDirMap.set(ns.name, sanitizeDirectoryName(ns.name));
  }
  detectDirectoryConflicts(
    allNamespaces.map(ns => ({ name: ns.name, directory: nsDirMap.get(ns.name)! }))
  );

  // Step 2c: Pre-load attribute metadata for sort order
  const { nodeKeyAttrs, edgeKeyAttrs } = await loadAttributeMetadata(dbModule);

  // Step 2d: Pre-load all metamodel versions (small table, needed for manifest
  // regardless of which namespaces are skipped)
  const allMmRows = await dbModule.runQuery(
    `MATCH (mm:RIA_META_Metamodel) RETURN mm.name AS name, mm.version AS version`
  );
  const allMetamodelVersions = new Map<string, string>();
  for (const row of allMmRows) {
    allMetamodelVersions.set(String(row.name ?? ''), String(row.version ?? ''));
  }

  const fileInventory: Record<string, number> = {};
  let filesWritten = 0;
  let totalRecords = 0;
  const namespacesWritten: string[] = [];
  const namespacesSkipped: string[] = [];
  const namespaceHashes: Record<string, string> = {};
  /** Declined writes across every namespace, surfaced on StoreResult. */
  const allSkippedTypes: SkippedTypeReport[] = [];

  // For a scoped store, seed namespaceHashes AND fileInventory with existing
  // values from the manifest for all namespaces that are NOT being stored.
  // This preserves the hashes and file counts of untouched namespaces in the
  // updated manifest — without this, a scoped store would drop all other
  // namespace entries from file_inventory, causing a large spurious diff.
  if (scopedStore && fs.existsSync(existingManifestPath)) {
    try {
      const existingManifest = JSON.parse(fs.readFileSync(existingManifestPath, 'utf-8')) as Partial<Manifest>;
      const existingHashes = existingManifest.namespace_hashes ?? {};
      for (const [ns, hash] of Object.entries(existingHashes)) {
        if (ns !== scopeNamespace) {
          namespaceHashes[ns] = hash;
        }
      }
      // Seed file_inventory for all entries that belong to other namespaces.
      // Entries for the targeted namespace and shared layers (meta/,
      // sourcemaster/, cross_namespace/) are excluded — they will be
      // rewritten by this store run.
      const existingInventory = existingManifest.file_inventory ?? {};
      const targetDirPrefix = (nsDirMap.get(scopeNamespace ?? '') ?? scopeNamespace ?? '') + '/';
      const sharedPrefixes = ['meta/', 'sourcemaster/', 'cross_namespace/'];
      for (const [filePath, count] of Object.entries(existingInventory)) {
        const isTargetNs = filePath.startsWith(targetDirPrefix);
        const isShared = sharedPrefixes.some(p => filePath.startsWith(p));
        if (!isTargetNs && !isShared) {
          fileInventory[filePath] = count;
        }
      }
    } catch {
      // If we can't read the existing manifest, proceed without seeding —
      // the scoped store will write only the targeted namespace's entries.
    }
  }

  // Build metamodel_versions from the pre-loaded map, keyed by metamodels
  // actually used by namespaces in the DB.
  const metamodelVersions: Record<string, string> = {};
  for (const ns of allNamespaces) {
    if (!metamodelVersions[ns.metamodel]) {
      metamodelVersions[ns.metamodel] = allMetamodelVersions.get(ns.metamodel) ?? '';
    }
  }

  // Step 3: Export meta layer
  const metaDir = path.join(exportDir, 'meta');
  // `meta_hash` deliberately does not use the returned file content: it stays a
  // whole-directory digest via computeMetaHash(metaDir), because
  // checkConsistency must be able to recompute it from disk with no store in
  // progress.
  const { totalRecords: metaRecords } =
    await exportLayer('meta', metaDir, dbModule, fileInventory, exportDir);
  totalRecords += metaRecords;
  filesWritten += getTablesByLayer('meta').length;

  // Step 4: Export sourcemaster layer
  const sourcemasterDir = path.join(exportDir, 'sourcemaster');
  // The returned `files` carry the exact bytes written to each sourcemaster
  // file. The per-file hash carrier is built from them rather than from a
  // read-back, so what gets recorded is what the writer intended to write —
  // see ExportedLayerFile in persistor-helpers.ts.
  const { totalRecords: sourcemasterRecords, files: sourcemasterFiles } =
    await exportLayer('sourcemaster', sourcemasterDir, dbModule, fileInventory, exportDir);
  totalRecords += sourcemasterRecords;
  filesWritten += getTablesByLayer('sourcemaster').length;

  // The carrier for the sourcemaster layer. Keyed by the same
  // ria-data-relative forward-slash path `exportLayer` put in `fileInventory`,
  // and hashed with `computeUniverseFileHash` — the one helper load and
  // repairManifest also use — so all three agree byte-for-byte.
  const sourcemasterHashes: Record<string, string> = {};
  for (const file of sourcemasterFiles) {
    sourcemasterHashes[file.relPath] = computeUniverseFileHash(file.content);
  }

  // Step 5: Export cross_namespace layer
  const crossNsDir = path.join(exportDir, 'cross_namespace');
  const crossNsFilePath = path.join(crossNsDir, 'RIA_UNIV_CrossNSRelationshipInstance.json');
  const crossNsSourceNamespaces = new Set<string>();
  // Retain the previous sources before overwriting the shared table. A deleted
  // last edge removes its source from the new file, but still changes its hash.
  if (scopedStore && fs.existsSync(crossNsFilePath)) {
    try {
      for (const edge of parseTable(fs.readFileSync(crossNsFilePath, 'utf-8'))) {
        const source = String(edge.source_namespace ?? '');
        if (source && source !== scopeNamespace) crossNsSourceNamespaces.add(source);
      }
    } catch {
      // The DB will replace the damaged file. Since its previous sources cannot
      // be determined, refresh every non-targeted hash after the replacement.
      for (const ns of allNamespaces) {
        if (ns.name !== scopeNamespace) crossNsSourceNamespaces.add(ns.name);
      }
    }
  }
  const { totalRecords: crossNsRecords, files: crossNsFiles } =
    await exportLayer('cross_namespace', crossNsDir, dbModule, fileInventory, exportDir);
  totalRecords += crossNsRecords;
  filesWritten += getTablesByLayer('cross_namespace').length;

  // The carrier for the cross-namespace layer, built exactly like the
  // sourcemaster one above: keyed by the same ria-data-relative forward-slash
  // path `exportLayer` put in `fileInventory`, and hashed with
  // `computeUniverseFileHash` over the exact bytes that were written — the one
  // helper load and repairManifest also use, so all three agree byte-for-byte.
  // Deliberately NOT the per-namespace record-based cross-NS digest inside
  // computeNamespaceHashFromFileContents: that answers a different question
  // (does this namespace's slice agree?) at a different granularity.
  const crossNamespaceHashes: Record<string, string> = {};
  for (const file of crossNsFiles) {
    crossNamespaceHashes[file.relPath] = computeUniverseFileHash(file.content);
  }

  // Step 5b: Export per-pair namespace connections (RIA_UNIV_NamespaceConnection).
  // This universe-layer rel table is keyed by namespace name and is global (not
  // scoped to a single namespace), so it is exported once here alongside the other
  // shared layers. Written for both full and scoped stores so the on-disk file
  // always reflects the complete current connection set. Restored on load with
  // dangling-reference handling.
  const universeDir = path.join(exportDir, 'universe');
  fs.mkdirSync(universeDir, { recursive: true });
  const connectionRows = await dbModule.runQuery(
    `MATCH (src:RIA_UNIV_Namespace)-[:RIA_UNIV_NamespaceConnection]->(dst:RIA_UNIV_Namespace)
     RETURN src.name AS src_name, dst.name AS dst_name
     ORDER BY src_name, dst_name`
  );
  const connectionFilePath = path.join(universeDir, 'RIA_UNIV_NamespaceConnection.json');
  const connectionContent = serializeTable(connectionRows, 'src_name', [], []);
  fs.writeFileSync(connectionFilePath, connectionContent, 'utf-8');
  const connectionRelPath = path.relative(exportDir, connectionFilePath).replace(/\\/g, '/');
  fileInventory[connectionRelPath] = connectionRows.length;
  totalRecords += connectionRows.length;
  filesWritten++;

  // Step 5c: Export the global canvas layout (RIA_UNIV_CanvasLayout).
  // This universe-layer node table is keyed by layout_id and is global (not scoped to
  // a single namespace), so — like RIA_UNIV_NamespaceConnection — it is exported once
  // here alongside the other shared layers, NOT by any generic layer export. Written for
  // both full and scoped stores so the on-disk file always reflects the complete current
  // layout set.
  const layoutRows = await dbModule.runQuery(
    `MATCH (l:RIA_UNIV_CanvasLayout)
     RETURN l.layout_id AS layout_id, l.element_kind AS element_kind,
            l.element_key AS element_key, l.x AS x, l.y AS y
     ORDER BY layout_id`
  );
  const layoutFilePath = path.join(universeDir, 'RIA_UNIV_CanvasLayout.json');
  const layoutContent = serializeTable(layoutRows, 'layout_id', [], []);
  fs.writeFileSync(layoutFilePath, layoutContent, 'utf-8');
  const layoutRelPath = path.relative(exportDir, layoutFilePath).replace(/\\/g, '/');
  fileInventory[layoutRelPath] = layoutRows.length;
  totalRecords += layoutRows.length;
  filesWritten++;

  // Step 5d: Export view definitions (RIA_UNIV_View) and their three relationship
  // tables. Global (not scoped to a single namespace), like RIA_UNIV_CanvasLayout /
  // RIA_UNIV_NamespaceConnection above — exported once here, NOT by any generic
  // layer export, for both full and scoped stores.
  const viewRows = await queryViewRows(dbModule);
  const viewSourceRows = await queryViewSourceRows(dbModule);
  const viewDefinedByRows = await queryViewDefinedByRows(dbModule);
  const viewCategorizedByRows = await queryViewCategorizedByRows(dbModule);

  const viewContent = serializeTable(viewRows, 'name', ['parameters'], []);
  const viewSourceContent = serializeTable(viewSourceRows, 'src_name', [], []);
  const viewDefinedByContent = serializeTable(viewDefinedByRows, 'src_name', [], []);
  const viewCategorizedByContent = serializeTable(viewCategorizedByRows, 'src_name', [], []);

  fs.writeFileSync(path.join(universeDir, 'RIA_UNIV_View.json'), viewContent, 'utf-8');
  fs.writeFileSync(path.join(universeDir, 'RIA_UNIV_VIEW_SOURCE.json'), viewSourceContent, 'utf-8');
  fs.writeFileSync(path.join(universeDir, 'RIA_UNIV_VIEW_DEFINEDBY.json'), viewDefinedByContent, 'utf-8');
  fs.writeFileSync(path.join(universeDir, 'RIA_UNIV_VIEW_CATEGORIZEDBY.json'), viewCategorizedByContent, 'utf-8');

  fileInventory[UNIVERSE_VIEW_REL] = viewRows.length;
  fileInventory[UNIVERSE_VIEW_SOURCE_REL] = viewSourceRows.length;
  fileInventory[UNIVERSE_VIEW_DEFINEDBY_REL] = viewDefinedByRows.length;
  fileInventory[UNIVERSE_VIEW_CATEGORIZEDBY_REL] = viewCategorizedByRows.length;
  totalRecords += viewRows.length + viewSourceRows.length + viewDefinedByRows.length + viewCategorizedByRows.length;
  filesWritten += 4;

  // Record a Universe_Hash for each universe-layer file over the exact same
  // serialized bytes just written (reused, not re-read from disk), using the
  // shared hash-computation path (task 2.1 / 2.2) so store, load, and repair
  // all produce identical values.
  const universeHashes: Record<string, string> = {
    [UNIVERSE_CANVAS_LAYOUT_REL]: computeUniverseFileHash(layoutContent),
    [UNIVERSE_NAMESPACE_CONNECTION_REL]: computeUniverseFileHash(connectionContent),
    [UNIVERSE_VIEW_REL]: computeUniverseFileHash(viewContent),
    [UNIVERSE_VIEW_SOURCE_REL]: computeUniverseFileHash(viewSourceContent),
    [UNIVERSE_VIEW_DEFINEDBY_REL]: computeUniverseFileHash(viewDefinedByContent),
    [UNIVERSE_VIEW_CATEGORIZEDBY_REL]: computeUniverseFileHash(viewCategorizedByContent),
  };

  // Step 6: Export each namespace
  for (const ns of namespaces) {
    const namespace = ns.name;
    const dirName = nsDirMap.get(namespace)!;
    const nsDir = path.join(exportDir, dirName);

    const conceptInstances = await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
       RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
              ci.metamodel AS metamodel, ci.attributes AS attributes
       ORDER BY ci.node_id`,
      { namespace }
    );

    const relationshipInstances = await dbModule.runQuery(
      `MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = $namespace
       RETURN ri.namespace AS namespace, ri.relationship AS relationship,
              ri.metamodel AS metamodel, ri.source_node_id AS source_node_id,
              ri.target_node_id AS target_node_id, ri.attributes AS attributes`,
      { namespace }
    );

    const crossNsEdgesAsSource = await dbModule.runQuery(
      `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance) WHERE x.source_namespace = $namespace
       RETURN x.source_namespace AS source_namespace,
              x.target_namespace AS target_namespace, x.metamodel AS metamodel,
              x.relationship AS relationship, x.source_node_id AS source_node_id,
              x.target_node_id AS target_node_id, x.attributes AS attributes`,
      { namespace }
    );

    // Build node_id → stableId lookup.
    //
    // Guard, not try/catch: this tests the same condition `resolveIdentityAttr`
    // and `sortConceptInstances` throw on (no key attributes), so the instances
    // skipped here are exactly the ones the export plan declines and reports via
    // `plan.skipped` / `StoreResult.skipped_types`. A catch would also swallow an
    // unrelated failure in stable-id resolution. No declared identity attribute
    // means there is no stable id to resolve, not that something went wrong.
    const nodeIdToStableId = new Map<number, string>();
    for (const ci of conceptInstances) {
      const conceptType = String(ci.concept ?? '');
      const keyAttrs = nodeKeyAttrs.get(conceptType);
      if (!keyAttrs || keyAttrs.length === 0) continue;

      const nodeId = Number(ci.node_id);
      const stableId = resolveStableIdFromMeta(
        String(ci.attributes ?? '{}'),
        conceptType,
        nodeKeyAttrs,
      );
      if (stableId !== '') nodeIdToStableId.set(nodeId, stableId);
    }

    // Replace ephemeral IDs with stable IDs in relationship instances
    const relInstancesWithStableIds = relationshipInstances.map(ri => {
      const sourceStableId = nodeIdToStableId.get(Number(ri.source_node_id)) ?? '';
      const targetStableId = nodeIdToStableId.get(Number(ri.target_node_id)) ?? '';
      return replaceNodeIdsWithStableIds(ri, sourceStableId, targetStableId);
    });

    // Decide the whole export for this namespace up front: which files will be
    // written, with what bytes, and which types are declined. Both the hash
    // below and the write loop further down read this one plan, so they cannot
    // disagree about what the namespace contains.
    const plan = buildNamespaceExportPlan(
      conceptInstances,
      relInstancesWithStableIds,
      nodeKeyAttrs,
      edgeKeyAttrs,
    );

    // Declined writes are reported before either branch below is taken, so a
    // delta-skipped namespace reports them too.
    reportPlanOmissions(namespace, plan, logger, allSkippedTypes);

    // Compute the namespace hash BEFORE writing files, over the plan's
    // serialized content — the exact bytes the write loop will put on disk.
    // That makes the recorded value reproducible by
    // `computeNamespaceHashFromFiles`, which is both the delta-skip comparison
    // below and the integrity check at load. The cross-NS section stays
    // record-based and filtered by `source_namespace`; see
    // `computeNamespaceHashFromFileContents` for why.
    const hash = computeNamespaceHashFromFileContents({
      namespace,
      conceptFiles: plan.conceptFiles.map(f => ({
        fileName: `${f.conceptType}.json`,
        content: f.content,
      })),
      relationshipFiles: plan.relationshipFiles.map(f => ({
        fileName: `${f.relType}.json`,
        content: f.content,
      })),
      crossNsEdgesAsSource,
    });

    // `<namespace>/namespace.json` is no longer written. It duplicated identity
    // from `manifest.namespaces[]` and carried `categorizational_metamodels`
    // derived from category edges, unhashed -- so connecting an analysis to an
    // imported namespace changed the derived value without changing the hash, and
    // a delta-skip then left the stale value on disk. Identity now comes from the
    // manifest alone; the category edges are covered by `meta_hash` at source.
    //
    // An older store's file is deleted on both paths below so a workspace
    // converges. Safe on the skip path: the file is not part of the digest.

    // Delta skip: hash matches AND files exist on disk.
    //
    // "Previously written" is `concepts/` existing. The write path mkdirs both
    // `concepts/` and `relationships/` unconditionally before writing anything,
    // so the directory is present iff a prior store wrote this namespace —
    // including a namespace with zero instances, which a probe for any
    // particular file gets wrong. Everything past "was it written at all" is
    // covered by the per-type file checks and the two hash guards below.
    const nsDirHasFiles = fs.existsSync(path.join(nsDir, 'concepts'));
    // Also verify that all expected data files are present — if someone
    // manually deleted a file, we must re-export rather than skip.
    //
    // "Expected" means the plan's files, NOT every type present in the DB rows
    // A type the plan declined has no file on disk *by design*, so
    // probing for it would find it missing on every single store and force a
    // full re-export of the namespace forever — a permanent delta-skip
    // regression caused by nothing being wrong.
    let allFilesIntact = nsDirHasFiles;
    if (allFilesIntact) {
      for (const f of plan.conceptFiles) {
        if (!fs.existsSync(path.join(nsDir, 'concepts', `${f.conceptType}.json`))) {
          logger.warn(`${namespace}: missing file on disk concepts/${f.conceptType}.json — forcing re-export`);
          allFilesIntact = false;
          break;
        }
      }
    }
    if (allFilesIntact) {
      for (const f of plan.relationshipFiles) {
        if (!fs.existsSync(path.join(nsDir, 'relationships', `${f.relType}.json`))) {
          logger.warn(`${namespace}: missing file on disk relationships/${f.relType}.json — forcing re-export`);
          allFilesIntact = false;
          break;
        }
      }
    }

    if (!forceFullReExport && ns.content_hash === hash && allFilesIntact) {
      // Final guard: verify the on-disk files actually match the DB content.
      // Two checks:
      //  1. Manifest hash vs DB hash — catches git checkout / git pull that
      //     replaced files AND updated the manifest.
      //  2. Actual file content hash vs DB hash — catches manual edits to JSON
      //     files that did NOT update the manifest (file corruption scenario).
      // If either check fails, the DB is authoritative — force a full re-export
      // so the files end up in a consistent state that matches the live DB.
      const onDiskManifestHash = onDiskNamespaceHashes[namespace] ?? '';
      if (onDiskManifestHash !== hash) {
        logger.info(
          `${namespace}: on-disk manifest hash differs from DB hash — external change detected, forcing re-export` +
          ` (db=${hash.slice(0, 20)}... manifest=${onDiskManifestHash.slice(0, 20) || '(none)'}...)`
        );
        // Fall through to the full re-export path below.
      } else {
        // Manifest hash matches DB — but files may have been edited without
        // updating the manifest. Recompute the actual file hash to be sure.
        const actualFileHash = computeNamespaceHashFromFiles(namespace, nsDir, exportDir);
        if (actualFileHash !== hash) {
          logger.info(
            `${namespace}: on-disk file content differs from DB hash — files edited without manifest update, forcing re-export` +
            ` (db=${hash.slice(0, 20)}... files=${actualFileHash.slice(0, 20)}...)`
          );
          // Fall through to the full re-export path below.
        } else {
          logger.debug(`skip ${namespace}: hash match (${hash.slice(0, 20)}...)`);
          namespacesSkipped.push(namespace);
          namespaceHashes[namespace] = hash;

          // Populate file_inventory from the plan. The files on disk are
          // unchanged, but the manifest needs complete counts — and they must
          // come from the same plan the write path uses, or a skipped type
          // would gain an inventory entry for a file that is not there.
          for (const f of plan.conceptFiles) {
            fileInventory[`${dirName}/concepts/${f.conceptType}.json`] = f.count;
          }
          for (const f of plan.relationshipFiles) {
            fileInventory[`${dirName}/relationships/${f.relType}.json`] = f.count;
          }

          // Converge a workspace written by an older store even though its
          // content is unchanged — a skipped namespace would
          // otherwise keep its stale `namespace.json` until some unrelated
          // content change forced a re-export.
          fs.rmSync(path.join(nsDir, 'namespace.json'), { force: true });

          continue;
        }
      }
    }

    // Write exactly the plan's files. Grouping, sorting and serialization all
    // happened in buildNamespaceExportPlan, whose `content` strings are what
    // the hash above was taken over — so nothing here may add, omit or
    // re-serialize a file.
    const conceptsDir = path.join(nsDir, 'concepts');
    const relationshipsDir = path.join(nsDir, 'relationships');
    fs.mkdirSync(conceptsDir, { recursive: true });
    fs.mkdirSync(relationshipsDir, { recursive: true });

    // Remove stale concept/relationship JSON files from a previous store.
    // If a concept type or relationship type no longer has instances in the DB
    // (e.g. all risk_ratings were deleted), the old .json file would linger on
    // disk and cause a hash mismatch on the next load. Cleaning up here keeps
    // the on-disk state consistent with the DB.
    //
    // The active set is the plan's files, so a declined type's file is removed
    // rather than left behind. That is not merely tidiness: a lingering file
    // would be read back by `computeNamespaceHashFromFiles` and would make the
    // on-disk digest differ from the one recorded above, which is the very
    // store/verify disagreement this change exists to end.
    const activeConceptFiles = new Set(plan.conceptFiles.map(f => `${f.conceptType}.json`));
    for (const file of fs.readdirSync(conceptsDir).filter(f => f.endsWith('.json'))) {
      if (!activeConceptFiles.has(file)) {
        fs.unlinkSync(path.join(conceptsDir, file));
        logger.debug(`${namespace}: removed stale concept file ${file}`);
      }
    }
    const activeRelFiles = new Set(plan.relationshipFiles.map(f => `${f.relType}.json`));
    for (const file of fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'))) {
      if (!activeRelFiles.has(file)) {
        fs.unlinkSync(path.join(relationshipsDir, file));
        logger.debug(`${namespace}: removed stale relationship file ${file}`);
      }
    }

    let conceptFilesWritten = 0;
    for (const f of plan.conceptFiles) {
      const filePath = path.join(conceptsDir, `${f.conceptType}.json`);
      fs.writeFileSync(filePath, f.content, 'utf-8');

      const relPath = path.relative(exportDir, filePath).replace(/\\/g, '/');
      fileInventory[relPath] = f.count;
      totalRecords += f.count;
      filesWritten++;
      conceptFilesWritten++;
    }

    // Write relationship files
    let relFilesWritten = 0;
    for (const f of plan.relationshipFiles) {
      const filePath = path.join(relationshipsDir, `${f.relType}.json`);
      fs.writeFileSync(filePath, f.content, 'utf-8');

      const relPath = path.relative(exportDir, filePath).replace(/\\/g, '/');
      fileInventory[relPath] = f.count;
      totalRecords += f.count;
      filesWritten++;
      relFilesWritten++;
    }

    // Delete a `namespace.json` left by an older store. Not written
    // any more, and not in `file_inventory`.
    fs.rmSync(path.join(nsDir, 'namespace.json'), { force: true });

    // Update content_hash in DB
    await dbModule.runQuery(
      `MATCH (ns2:RIA_UNIV_Namespace) WHERE ns2.name = '${e(namespace)}' SET ns2.content_hash = '${e(hash)}'`
    );

    logger.info(`write ${namespace}: ${conceptFilesWritten} concept file(s), ${relFilesWritten} relationship file(s)`);
    namespacesWritten.push(namespace);
    namespaceHashes[namespace] = hash;
  }

  // Fill in hashes for skipped namespaces (full store only — scoped store
  // preserves other namespace hashes via the seed step above)
  if (!scopedStore) {
    for (const ns of allNamespaces) {
      if (!(ns.name in namespaceHashes)) {
        namespaceHashes[ns.name] = ns.content_hash;
      }
    }
  }

  // ── Scoped-store cross-NS hash fixup ────────────────────────────────────────
  // When a scoped store runs (params.namespace is set), the cross_namespace/
  // shared file is always rewritten in full. This means that ANY namespace
  // that has cross-NS edges in that file (as source_namespace) can have its
  // content hash change — even if none of its own concept/relationship files
  // were touched. The seed step above copies the OLD hash from the manifest
  // for every non-targeted namespace, which leaves those hashes stale.
  //
  // Fix: after the cross_namespace layer has been written, recompute the hash
  // for every non-targeted namespace whose cross-NS edges appear in the old OR
  // new shared file, including sources whose last edge was deleted.
  if (scopedStore) {
    // Read the freshly-written cross_namespace file once (it's already on disk).
    let allCrossNsEdges: Record<string, unknown>[] = [];
    if (fs.existsSync(crossNsFilePath)) {
      allCrossNsEdges = parseTable(fs.readFileSync(crossNsFilePath, 'utf-8'));
    }

    // Include new sources alongside the sources captured before the export.
    for (const edge of allCrossNsEdges) {
      const srcNs = String(edge.source_namespace ?? '');
      if (srcNs && srcNs !== scopeNamespace) {
        crossNsSourceNamespaces.add(srcNs);
      }
    }

    if (crossNsSourceNamespaces.size > 0) {
      logger.debug(
        `scoped store: recomputing hashes for ${crossNsSourceNamespaces.size} namespace(s)` +
        ` affected by cross-NS edge changes: [${[...crossNsSourceNamespaces].join(', ')}]`
      );
    }

    for (const ns of allNamespaces) {
      // Skip the targeted namespace (already handled above) and any namespace
      // that had no cross-NS edges before or after this store.
      if (ns.name === scopeNamespace) continue;
      if (!crossNsSourceNamespaces.has(ns.name)) continue;

      const dirName = nsDirMap.get(ns.name)!;
      const nsDir = path.join(exportDir, dirName);

      // Recompute hash from the on-disk files that were NOT changed by this
      // store run. Use computeNamespaceHashFromFiles so we read the actual
      // serialized bytes — the same path used by repair-manifest and the
      // consistency checker, guaranteeing the same hash value.
      try {
        // Collect per-section lines on the single hash pass; emit only if changed.
        const sectionLines: string[] = [];
        const freshHash = computeNamespaceHashFromFiles(
          ns.name, nsDir, exportDir,
          (msg) => sectionLines.push(msg),
        );
        const previousHash = namespaceHashes[ns.name] ?? '';
        if (freshHash !== previousHash) {
          logger.info(
            `scoped store: cross-NS hash updated for '${ns.name}'` +
            ` old=${previousHash.slice(0, 20) || '(none)'}...` +
            ` new=${freshHash.slice(0, 20)}...`,
            { namespace: ns.name, old_hash: previousHash, new_hash: freshHash },
          );
          // Per-section breakdown shows exactly which section (concepts /
          // relationships / cross-ns) changed — logged at DEBUG to keep INFO clean.
          for (const line of sectionLines) {
            logger.debug(`  [cross-ns-fixup/section] ${line}`, { namespace: ns.name });
          }
          namespaceHashes[ns.name] = freshHash;
          // Also update the DB content_hash so the next store() delta-skip
          // comparison is based on the correct value.
          await dbModule.runQuery(
            `MATCH (ns2:RIA_UNIV_Namespace) WHERE ns2.name = '${e(ns.name)}' SET ns2.content_hash = '${e(freshHash)}'`
          );
        }
      } catch (err) {
        // Recomputation can fail if the namespace directory doesn't exist on
        // disk yet (first-ever store). Log a warning and leave the seeded hash
        // as-is — the next full store will correct it.
        logger.warn(
          `scoped store: could not recompute hash for '${ns.name}' — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Write manifest.json
  // Sort file_inventory keys for deterministic output regardless of processing order
  const sortedFileInventory: Record<string, number> = {};
  for (const key of Object.keys(fileInventory).sort()) {
    sortedFileInventory[key] = fileInventory[key];
  }

  const manifest: Manifest = {
    file_inventory: sortedFileInventory,
    meta_hash: computeMetaHash(metaDir),
    metamodel_versions: metamodelVersions,
    namespace_hashes: namespaceHashes,
    // Built in Step 4 from the exact bytes exportLayer wrote. Complete on a
    // scoped store too: the sourcemaster layer is shared, so it is rewritten in
    // full on every store regardless of `params.namespace`.
    sourcemaster_hashes: sourcemasterHashes,
    // Built in Step 5 from the exact bytes exportLayer wrote. Complete on a
    // scoped store too: the cross-namespace layer is shared, so it is rewritten
    // in full on every store regardless of `params.namespace`.
    cross_namespace_hashes: crossNamespaceHashes,
    // Universe_Hash for the two universe-layer files written in Steps 5b/5c,
    // computed over the exact serialized bytes via the shared hash path
    // (task 2.2) so full/namespace stores also protect the universe layer
    universe_hashes: universeHashes,
    namespaces: allNamespaces.map(ns => ({
      directory: nsDirMap.get(ns.name)!,
      metamodel: ns.metamodel,
      metamodel_version: metamodelVersions[ns.metamodel] ?? '',
      name: ns.name,
      namespace_owning_application: ns.namespace_owning_application,
      namespace_role: ns.namespace_role,
    })),
    schema_version: SCHEMA_VERSION,
  };
  const manifestPath = path.join(exportDir, 'manifest.json');
  const manifestBytes = serializeMetadata(manifest as unknown as Record<string, unknown>);
  fs.writeFileSync(manifestPath, manifestBytes, 'utf-8');
  filesWritten++;

  // Record D — the file version this database is now synced to (task 5.2).
  // Covers the full store and the namespace-scoped store alike: both rewrite the
  // whole manifest and both rewrite the shared layers in full, so the origin
  // record they produce is complete either way. Written after the manifest is on
  // disk, so a crash between the two leaves D stale rather than ahead of the
  // files — stale costs one extra load, ahead would license skipping a real
  // divergence.
  await writeSnapshotOrigin(dbModule, originFromManifest(manifest, manifestBytes), logger);

  // Remove directories for namespaces that no longer exist in the DB.
  // Without this cleanup, a deleted namespace would linger on disk and
  // reappear on the next load(), effectively resurrecting deleted data.
  // Skip this cleanup for scoped stores — we only touched one namespace.
  if (!scopedStore) {
    const reservedDirs = new Set(['meta', 'sourcemaster', 'cross_namespace', 'universe']);
    const currentDirNames = new Set(nsDirMap.values());
    try {
      const entries = fs.readdirSync(exportDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (reservedDirs.has(entry.name)) continue;
        if (!currentDirNames.has(entry.name)) {
          fs.rmSync(path.join(exportDir, entry.name), { recursive: true, force: true });
        }
      }
    } catch { /* ignore cleanup errors */ }
  }

  const elapsed = Date.now() - storeStart;
  logger.info(`store done — written=${namespacesWritten.length}, skipped=${namespacesSkipped.length}, files=${filesWritten}, records=${totalRecords}, elapsed=${elapsed}ms`);

  return {
    exported_at: exportedAt,
    files_written: filesWritten,
    namespaces_skipped: namespacesSkipped,
    namespaces_written: namespacesWritten,
    total_records: totalRecords,
    // Omitted entirely when nothing was declined, so its presence is the signal
    ...(allSkippedTypes.length > 0 ? { skipped_types: allSkippedTypes } : {}),
  };
}
