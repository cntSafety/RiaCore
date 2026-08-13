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
import { computeNamespaceHash, computeUniverseFileHash } from './hash-computer.js';
import { sanitizeDirectoryName, detectDirectoryConflicts } from './sanitize-directory.js';
import type { PersistorStoreParams, StoreResult, Manifest } from './persistor-types.js';
import { e, exportLayer, loadAttributeMetadata, writeFileAtomic } from './persistor-helpers.js';
import { sortConceptInstances, sortRelationshipInstances } from './persistor-sort.js';
import { computeMetaHash, computeNamespaceHashFromFiles } from './persistor.js';

/**
 * Universe-layer file paths, relative to the ria-data export directory. Shared
 * between the universe-scoped store path and the full/namespace store path so
 * both write and hash exactly the same files (Req 6.1, 6.2, 10.1).
 */
export const UNIVERSE_CANVAS_LAYOUT_REL = 'universe/RIA_UNIV_CanvasLayout.json';
export const UNIVERSE_NAMESPACE_CONNECTION_REL = 'universe/RIA_UNIV_NamespaceConnection.json';

/**
 * Re-export the shared per-file Universe_Hash helper (now owned by
 * `hash-computer.ts`, alongside the other hashing functions) so existing
 * importers of `./persistor-store.js` keep working. Both the universe-scoped
 * store path (task 2.1) and the full/namespace store path (task 2.2) use this
 * single helper for hash computation.
 */
export { computeUniverseFileHash };

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
 * Universe-scoped store (Req 1.4, 2.3, 4.4, 5.1, 5.2, 6.1, 6.2, 10.1–10.3).
 *
 * Writes ONLY the two universe-layer files, reading the current DB rows at
 * execution time (never a snapshot captured at scheduling time). Each file is
 * written atomically (temp-file + fsync + rename) so an interrupted save never
 * corrupts it. Only the `universe_hashes` and `file_inventory` entries for the
 * two written files are updated in the manifest — every `namespace_hashes`
 * entry, `meta_hash`, and every other inventory entry is preserved
 * byte-identical by parsing the existing manifest and mutating only those two
 * nested maps before re-serializing.
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

  // Read current DB rows at execution time (Req 4.4), then serialize with the
  // same primitives / sort keys as the full store path so bytes are identical.
  const connectionRows = await queryConnectionRows(dbModule);
  const layoutRows = await queryLayoutRows(dbModule);

  const connectionContent = serializeTable(connectionRows, 'src_name', [], []);
  const layoutContent = serializeTable(layoutRows, 'layout_id', [], []);

  const connectionFilePath = path.join(exportDir, UNIVERSE_NAMESPACE_CONNECTION_REL);
  const layoutFilePath = path.join(exportDir, UNIVERSE_CANVAS_LAYOUT_REL);

  // Atomic writes: an interrupted or failed write leaves the previous complete
  // file untouched (Req 5.1–5.4). A failure rethrows so the caller's failure
  // path engages.
  writeFileAtomic(layoutFilePath, layoutContent);
  writeFileAtomic(connectionFilePath, connectionContent);

  // Load the existing manifest and mutate ONLY the two universe entries. This
  // preserves namespace_hashes, meta_hash, and every other inventory entry
  // byte-identical (Req 10.2, 10.3). A universe-scoped store only runs on a
  // loaded workspace, which always has a manifest on disk.
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
  manifest.universe_hashes = universeHashes;

  manifest.file_inventory[UNIVERSE_CANVAS_LAYOUT_REL] = layoutRows.length;
  manifest.file_inventory[UNIVERSE_NAMESPACE_CONNECTION_REL] = connectionRows.length;

  writeFileAtomic(manifestPath, serializeMetadata(manifest as unknown as Record<string, unknown>));

  const elapsed = Date.now() - storeStart;
  logger.info(
    `store [scope=universe] done — ${UNIVERSE_CANVAS_LAYOUT_REL} (${layoutRows.length} record(s)), ` +
    `${UNIVERSE_NAMESPACE_CONNECTION_REL} (${connectionRows.length} record(s)), elapsed=${elapsed}ms`
  );

  return {
    exported_at: exportedAt,
    // Two universe files + the manifest.
    files_written: 3,
    namespaces_skipped: [],
    namespaces_written: [],
    total_records: layoutRows.length + connectionRows.length,
    universe_files_written: [UNIVERSE_CANVAS_LAYOUT_REL, UNIVERSE_NAMESPACE_CONNECTION_REL],
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
  const run = prior.then(() => storeImpl(params, dbModule, logger));
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
  // only their manifest entries (Req 10). Handled by a dedicated path so
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
  const existingManifestPath = path.join(exportDir, 'manifest.json');
  let forceFullReExport = false;
  let onDiskNamespaceHashes: Record<string, string> = {};
  if (!fs.existsSync(existingManifestPath)) {
    forceFullReExport = true;
  } else {
    try {
      const existingManifest = JSON.parse(fs.readFileSync(existingManifestPath, 'utf-8')) as Partial<Manifest>;
      const existingSchemaVersion = String(existingManifest.schema_version ?? '');
      if (existingSchemaVersion !== SCHEMA_VERSION) {
        forceFullReExport = true;
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

  // When a specific namespace is requested, filter to only that namespace.
  // The full allNamespaces list is still needed for manifest metadata.
  const namespaces = params.namespace
    ? allNamespaces.filter(ns => ns.name === params.namespace)
    : allNamespaces;

  const scopedStore = params.namespace !== undefined;

  logger.info(`store started — ${namespaces.length} namespace(s) to export (${allNamespaces.length} total in DB)${scopedStore ? ` [scoped to: ${params.namespace}]` : ''}`);

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
        if (ns !== params.namespace) {
          namespaceHashes[ns] = hash;
        }
      }
      // Seed file_inventory for all entries that belong to other namespaces.
      // Entries for the targeted namespace and shared layers (meta/,
      // sourcemaster/, cross_namespace/) are excluded — they will be
      // rewritten by this store run.
      const existingInventory = existingManifest.file_inventory ?? {};
      const targetDirPrefix = (nsDirMap.get(params.namespace ?? '') ?? params.namespace ?? '') + '/';
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
  const metaRecords = await exportLayer('meta', metaDir, dbModule, fileInventory, exportDir);
  totalRecords += metaRecords;
  filesWritten += getTablesByLayer('meta').length;

  // Step 4: Export sourcemaster layer
  const sourcemasterDir = path.join(exportDir, 'sourcemaster');
  const sourcemasterRecords = await exportLayer('sourcemaster', sourcemasterDir, dbModule, fileInventory, exportDir);
  totalRecords += sourcemasterRecords;
  filesWritten += getTablesByLayer('sourcemaster').length;

  // Step 5: Export cross_namespace layer
  const crossNsDir = path.join(exportDir, 'cross_namespace');
  const crossNsRecords = await exportLayer('cross_namespace', crossNsDir, dbModule, fileInventory, exportDir);
  totalRecords += crossNsRecords;
  filesWritten += getTablesByLayer('cross_namespace').length;

  // Step 5b: Export per-pair namespace connections (RIA_UNIV_NamespaceConnection).
  // This universe-layer rel table is keyed by namespace name and is global (not
  // scoped to a single namespace), so it is exported once here alongside the other
  // shared layers. Written for both full and scoped stores so the on-disk file
  // always reflects the complete current connection set. Restored on load with
  // dangling-reference handling (Requirements 8.1, 8.5).
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
  // layout set (Requirements 5.1, 5.7).
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

  // Record a Universe_Hash for each universe-layer file over the exact same
  // serialized bytes just written (reused, not re-read from disk), using the
  // shared hash-computation path (task 2.1 / 2.2) so store, load, and repair
  // all produce identical values (Req 6.1, 6.2).
  const universeHashes: Record<string, string> = {
    [UNIVERSE_CANVAS_LAYOUT_REL]: computeUniverseFileHash(layoutContent),
    [UNIVERSE_NAMESPACE_CONNECTION_REL]: computeUniverseFileHash(connectionContent),
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

    // Build node_id → stableId lookup
    const nodeIdToStableId = new Map<number, string>();
    for (const ci of conceptInstances) {
      const nodeId = Number(ci.node_id);
      const stableId = resolveStableIdFromMeta(
        String(ci.attributes ?? '{}'),
        String(ci.concept ?? ''),
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

    // Bottom-up relationship type grouping: group relInstancesWithStableIds by their relationship field
    const relsByType = new Map<string, Record<string, unknown>[]>();
    for (const ri of relInstancesWithStableIds) {
      const relType = String(ri.relationship ?? '');
      if (!relType) continue;
      const group = relsByType.get(relType);
      if (group) {
        group.push(ri);
      } else {
        relsByType.set(relType, [ri]);
      }
    }

    // Compute namespace hash BEFORE writing files. The hash captures the
    // canonical content that will be serialized, so on the next store() call
    // we can compare the DB's current hash against the on-disk hash and skip
    // namespaces whose content hasn't changed (delta-skip optimization).
    const hash = computeNamespaceHash({
      namespace,
      conceptInstances,
      relationshipInstances: relInstancesWithStableIds,
      crossNsEdgesAsSource,
      nodeKeyAttrs,
      edgeKeyAttrs,
      debugLog: (msg) => logger.debug(`[store/hash] ${msg}`, { namespace }),
    });

    // Delta skip: hash matches AND files exist on disk
    const nsDirHasFiles = fs.existsSync(path.join(nsDir, 'namespace.json'));
    // Also verify that all expected data files are present — if someone
    // manually deleted a file, we must re-export rather than skip.
    let allFilesIntact = nsDirHasFiles;
    if (allFilesIntact) {
      const conceptTypes = new Set<string>();
      for (const ci of conceptInstances) {
        const t = String(ci.concept ?? '');
        if (t) conceptTypes.add(t);
      }
      for (const t of conceptTypes) {
        if (!fs.existsSync(path.join(nsDir, 'concepts', `${t}.json`))) {
          logger.warn(`${namespace}: missing file on disk concepts/${t}.json — forcing re-export`);
          allFilesIntact = false;
          break;
        }
      }
    }
    if (allFilesIntact) {
      for (const relType of relsByType.keys()) {
        if (!fs.existsSync(path.join(nsDir, 'relationships', `${relType}.json`))) {
          logger.warn(`${namespace}: missing file on disk relationships/${relType}.json — forcing re-export`);
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

          // Populate file_inventory from the in-memory data we already queried.
          // The files on disk are unchanged, but the manifest needs complete counts.
          const conceptCounts = new Map<string, number>();
          for (const ci of conceptInstances) {
            const t = String(ci.concept ?? '');
            if (t) conceptCounts.set(t, (conceptCounts.get(t) ?? 0) + 1);
          }
          for (const [conceptType, count] of conceptCounts) {
            fileInventory[`${dirName}/concepts/${conceptType}.json`] = count;
          }
          for (const [relType, instances] of relsByType) {
            fileInventory[`${dirName}/relationships/${relType}.json`] = instances.length;
          }
          fileInventory[`${dirName}/namespace.json`] = 1;

          continue;
        }
      }
    }

    // Query categorizational metamodels
    const metamodelVersion = allMetamodelVersions.get(ns.metamodel) ?? '';

    const catRows = await dbModule.runQuery(
      `MATCH (ns2:RIA_UNIV_Namespace)-[:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel)
       WHERE ns2.name = '${e(namespace)}' AND mm.name <> '${e(ns.metamodel)}'
       RETURN mm.name AS name ORDER BY mm.name`
    );
    const categorizationalMetamodels = catRows.map(r => String(r.name ?? '')).filter(Boolean);

    // Group concept instances by type and sort within each group for
    // deterministic, diff-friendly JSON output. Grouping by type produces
    // one file per concept type; sorting by key attributes ensures that
    // re-exports of unchanged data produce byte-identical files.
    const conceptsByType = new Map<string, Record<string, unknown>[]>();
    for (const ci of conceptInstances) {
      const conceptType = String(ci.concept ?? '');
      if (!conceptType) continue;
      // node_id is a DB-assigned ephemeral integer that changes across
      // DB recreations. Stripping it here keeps the serialized JSON stable
      // and prevents false diffs when the same logical data gets new node_ids.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { node_id, ...rest } = ci;
      const group = conceptsByType.get(conceptType);
      if (group) {
        group.push(rest as Record<string, unknown>);
      } else {
        conceptsByType.set(conceptType, [rest as Record<string, unknown>]);
      }
    }

    // Write concept files
    const conceptsDir = path.join(nsDir, 'concepts');
    const relationshipsDir = path.join(nsDir, 'relationships');
    fs.mkdirSync(conceptsDir, { recursive: true });
    fs.mkdirSync(relationshipsDir, { recursive: true });

    // Remove stale concept/relationship JSON files from a previous store.
    // If a concept type or relationship type no longer has instances in the DB
    // (e.g. all risk_ratings were deleted), the old .json file would linger on
    // disk and cause a hash mismatch on the next load. Cleaning up here keeps
    // the on-disk state consistent with the DB.
    const activeConceptFiles = new Set([...conceptsByType.keys()].map(t => `${t}.json`));
    for (const file of fs.readdirSync(conceptsDir).filter(f => f.endsWith('.json'))) {
      if (!activeConceptFiles.has(file)) {
        fs.unlinkSync(path.join(conceptsDir, file));
        logger.debug(`${namespace}: removed stale concept file ${file}`);
      }
    }
    const activeRelFiles = new Set([...relsByType.keys()].map(t => `${t}.json`));
    for (const file of fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'))) {
      if (!activeRelFiles.has(file)) {
        fs.unlinkSync(path.join(relationshipsDir, file));
        logger.debug(`${namespace}: removed stale relationship file ${file}`);
      }
    }

    let conceptFilesWritten = 0;
    for (const conceptType of [...conceptsByType.keys()].sort()) {
      const instances = conceptsByType.get(conceptType)!;

      let sorted: Record<string, unknown>[];
      try {
        sorted = sortConceptInstances(instances, conceptType, nodeKeyAttrs);
      } catch (err) {
        logger.warn(
          `${namespace}: skipping concept type '${conceptType}' — ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      const content = serializeTable(sorted, 'attributes', ['attributes'], []);
      const filePath = path.join(conceptsDir, `${conceptType}.json`);
      fs.writeFileSync(filePath, content, 'utf-8');

      const relPath = path.relative(exportDir, filePath).replace(/\\/g, '/');
      fileInventory[relPath] = instances.length;
      totalRecords += instances.length;
      filesWritten++;
      conceptFilesWritten++;
    }

    // Write relationship files
    let relFilesWritten = 0;
    for (const relType of [...relsByType.keys()].sort()) {
      const instances = relsByType.get(relType)!;

      const sorted = sortRelationshipInstances(instances, relType, edgeKeyAttrs);
      const content = serializeTable(sorted, 'source_stable_id', ['attributes'], []);
      const filePath = path.join(relationshipsDir, `${relType}.json`);
      fs.writeFileSync(filePath, content, 'utf-8');

      const relPath = path.relative(exportDir, filePath).replace(/\\/g, '/');
      fileInventory[relPath] = instances.length;
      totalRecords += instances.length;
      filesWritten++;
      relFilesWritten++;
    }

    // Write namespace.json
    const namespaceMetadata = {
      categorizational_metamodels: categorizationalMetamodels,
      directory: dirName,
      metamodel: ns.metamodel,
      metamodel_version: metamodelVersion,
      name: namespace,
      namespace_owning_application: ns.namespace_owning_application,
      namespace_role: ns.namespace_role,
    };
    const nsMetaPath = path.join(nsDir, 'namespace.json');
    fs.writeFileSync(nsMetaPath, serializeMetadata(namespaceMetadata as Record<string, unknown>), 'utf-8');
    const nsMetaRelPath = path.relative(exportDir, nsMetaPath).replace(/\\/g, '/');
    fileInventory[nsMetaRelPath] = 1;
    filesWritten++;

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
  // for every non-targeted namespace whose cross-NS edges appear in the shared
  // file, and update namespaceHashes if the recomputed value differs.
  if (scopedStore) {
    // Read the freshly-written cross_namespace file once (it's already on disk).
    const crossNsFilePath = path.join(crossNsDir, 'RIA_UNIV_CrossNSRelationshipInstance.json');
    let allCrossNsEdges: Record<string, unknown>[] = [];
    if (fs.existsSync(crossNsFilePath)) {
      allCrossNsEdges = parseTable(fs.readFileSync(crossNsFilePath, 'utf-8'));
    }

    // Determine which non-targeted namespaces appear as source_namespace in the file.
    const crossNsSourceNamespaces = new Set<string>();
    for (const edge of allCrossNsEdges) {
      const srcNs = String(edge.source_namespace ?? '');
      if (srcNs && srcNs !== params.namespace) {
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
      // that has no cross-NS edges in the shared file (hash cannot change).
      if (ns.name === params.namespace) continue;
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
    // Universe_Hash for the two universe-layer files written in Steps 5b/5c,
    // computed over the exact serialized bytes via the shared hash path
    // (task 2.2) so full/namespace stores also protect the universe layer
    // (Req 6.1, 6.2).
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
  fs.writeFileSync(manifestPath, serializeMetadata(manifest as unknown as Record<string, unknown>), 'utf-8');
  filesWritten++;

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
  };
}
