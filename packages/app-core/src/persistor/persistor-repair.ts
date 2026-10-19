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
﻿/**
 * Persistor repairManifest() — recomputes namespace hashes from on-disk JSON
 * files and updates manifest.json when hashes have drifted.
 *
 * Also recomputes meta_hash so the manifest accurately reflects the current
 * state of the meta layer files (metamodel definitions, DEFINEDBY, CATEGORIZEDBY),
 * and the per-file `universe_hashes` / `sourcemaster_hashes` /
 * `cross_namespace_hashes` carriers.
 *
 * Deliberately synchronous, with no `dbModule`: every digest here is recomputed
 * from files on disk, so repair needs no database. See the note on
 * `RepairManifestResult.sourcemaster_files_repaired` for the DB-backed namespace
 * identity backfill that was considered and cut.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImportLogger } from '../infra/logger.js';
import { serializeMetadata } from './serializer.js';
import type { PersistorRepairParams, RepairManifestResult, Manifest } from './persistor-types.js';
import { computeNamespaceHashFromFiles, computeMetaHash } from './persistor.js';
import { computeUniverseFileHash } from './hash-computer.js';
import { getTablesByLayer } from './table-registry.js';
import { SCHEMA_VERSION } from '../db/schema.js';

/**
 * The user's explicit Load choice accepts file content, including S3 edits.
 * Validate table JSON before blessing its hashes: ordinary load checks hashes,
 * but can otherwise discover malformed rows only after clearing shared tables.
 * This preparation never writes the database, origins, or session baseline.
 */
export function prepareManifestForExplicitLoad(
  params: PersistorRepairParams,
  logger: ImportLogger,
): void {
  const exportDir = path.join(params.workingDir, 'ria-data');
  const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8')) as Manifest;
  // Hashes from another epoch cannot be repaired using this epoch's algorithm.
  // Leave version acceptance/rejection to the normal load path.
  if (manifest.schema_version !== SCHEMA_VERSION) return;

  const files = new Set([
    ...Object.keys(manifest.file_inventory ?? {}),
    ...Object.keys(manifest.universe_hashes ?? {}),
    ...Object.keys(manifest.sourcemaster_hashes ?? {}),
    ...Object.keys(manifest.cross_namespace_hashes ?? {}),
  ]);
  const directories = ['meta', 'sourcemaster', 'universe', 'cross_namespace'];
  for (const ns of manifest.namespaces) {
    const directory = ns.directory ?? ns.name;
    if (!fs.statSync(path.join(exportDir, directory)).isDirectory()) {
      throw new Error(`Namespace directory '${directory}' is missing`);
    }
    directories.push(`${directory}/concepts`, `${directory}/relationships`);
  }
  // Include newly added files even when a stale inventory does not list them.
  for (const directory of directories) {
    const absolute = path.join(exportDir, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const file of fs.readdirSync(absolute)) {
      if (file.endsWith('.json')) files.add(`${directory}/${file}`);
    }
  }
  for (const file of files) {
    // Legacy namespace identity metadata is an object, not a graph table.
    if (path.basename(file) === 'namespace.json') continue;
    const rows: unknown = JSON.parse(fs.readFileSync(path.join(exportDir, file), 'utf8'));
    if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`Cannot load '${file}': expected a JSON array of records`);
    }
  }
  repairManifest(params, logger);
}

export function repairManifest(
  params: PersistorRepairParams,
  logger: ImportLogger,
): RepairManifestResult {
  const exportDir = path.join(params.workingDir, 'ria-data');
  const manifestPath = path.join(exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('No export found: manifest.json is missing');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
  const namespacesRepaired: string[] = [];
  const namespacesUnchanged: string[] = [];

  // ── Namespace hashes ───────────────────────────────────────────────────────
  for (const nsEntry of manifest.namespaces) {
    const namespace = nsEntry.name;
    const dirName = (nsEntry as { directory?: string }).directory ?? namespace;
    const nsDir = path.join(exportDir, dirName);
    const currentHash = manifest.namespace_hashes[namespace] ?? '';

    // Use the debug logger to emit per-section hashes so the repair log
    // shows exactly which section (concepts / relationships / cross-ns)
    // caused the hash to change — making mismatches diagnosable without
    // needing to rerun.
    const diskHash = computeNamespaceHashFromFiles(
      namespace, nsDir, exportDir,
      (msg) => logger.debug(`[repair/${namespace}] ${msg}`, { namespace }),
    );

    if (diskHash === currentHash) {
      namespacesUnchanged.push(namespace);
      logger.debug(`repair-manifest '${namespace}': hash unchanged (${diskHash.slice(0, 20)}...)`, { namespace });
    } else {
      manifest.namespace_hashes[namespace] = diskHash;
      namespacesRepaired.push(namespace);
      logger.info(
        `repair-manifest '${namespace}': hash updated` +
        ` old=${currentHash.slice(0, 20)}...` +
        ` new=${diskHash.slice(0, 20)}...`,
        { namespace, old_hash: currentHash, new_hash: diskHash },
      );
    }
  }

  // ── Meta hash ──────────────────────────────────────────────────────────────
  // Recompute the hash of all meta layer files (metamodel definitions,
  // DEFINEDBY, CATEGORIZEDBY, etc.) and update the manifest if it changed.
  const metaDir = path.join(exportDir, 'meta');
  const currentMetaHash = manifest.meta_hash ?? '';
  const diskMetaHash = computeMetaHash(metaDir);
  let metaHashUpdated = false;
  if (diskMetaHash !== currentMetaHash) {
    manifest.meta_hash = diskMetaHash;
    metaHashUpdated = true;
    logger.info(
      `repair-manifest meta_hash: updated` +
      ` old=${currentMetaHash.slice(0, 20) || '(none)'}...` +
      ` new=${diskMetaHash.slice(0, 20)}...`,
      { old_meta_hash: currentMetaHash, new_meta_hash: diskMetaHash },
    );
  } else {
    logger.debug(`repair-manifest meta_hash: unchanged (${diskMetaHash.slice(0, 20)}...)`);
  }

  // ── Universe hashes ────────────────────────────────────────────────────────
  // Recompute the Universe_Hash of each universe-layer file recorded in the
  // manifest from its on-disk bytes, mirroring the namespace-hash handling
  // above. This lets the existing "Repair Hash" affordance clear a universe
  // mismatch just as it clears a
  // namespace mismatch. Hashes are computed with the same shared helper used at
  // store and load time so store/load/repair always agree byte-for-byte.
  //
  // Known asymmetry, deliberately left as-is (follow-up): this loop enumerates
  // the manifest's *existing* keys, so a universe file that is absent from the
  // manifest never gains an entry — repair can correct a universe carrier but
  // not complete one. The sourcemaster block below enumerates the table
  // registry instead and therefore does complete its carrier. Bringing the
  // universe layer in line needs an authoritative key set for it (the universe
  // layer is exported by bespoke store steps, not by the generic registry-driven
  // `exportLayer`, so the registry is not that set) and was scoped out of the
  // hash-correctness-hardening change.
  const universeFilesRepaired: string[] = [];
  let universeHashesUpdated = false;
  const universeHashes = manifest.universe_hashes ?? {};
  for (const relPath of Object.keys(universeHashes)) {
    const recordedHash = universeHashes[relPath] ?? '';
    const universeFilePath = path.join(exportDir, relPath);

    if (!fs.existsSync(universeFilePath)) {
      // Cannot recompute a hash for a file that is not on disk. Leave the
      // recorded hash untouched — the load-time integrity check surfaces the
      // missing file to the user; repair only rewrites hashes for
      // files it can actually read.
      logger.warn(
        `repair-manifest universe '${relPath}': file absent on disk — hash left unchanged`,
        { universe_file: relPath },
      );
      continue;
    }

    const diskHash = computeUniverseFileHash(fs.readFileSync(universeFilePath, 'utf-8'));
    if (diskHash === recordedHash) {
      logger.debug(`repair-manifest universe '${relPath}': hash unchanged (${diskHash.slice(0, 20)}...)`, { universe_file: relPath });
    } else {
      manifest.universe_hashes[relPath] = diskHash;
      universeFilesRepaired.push(relPath);
      universeHashesUpdated = true;
      logger.info(
        `repair-manifest universe '${relPath}': hash updated` +
        ` old=${recordedHash.slice(0, 20) || '(none)'}...` +
        ` new=${diskHash.slice(0, 20)}...`,
        { universe_file: relPath, old_hash: recordedHash, new_hash: diskHash },
      );
    }
  }

  // ── Sourcemaster hashes ────────────────────────────────────────────────────
  // Recompute the content hash of each `sourcemaster/` file from its on-disk
  // bytes so the "Repair Hash" affordance can clear a sourcemaster mismatch,
  // which load treats as a hard failure.
  //
  // The key set is enumerated from `getTablesByLayer('sourcemaster')`, NOT from
  // the manifest's existing keys. That is the point of this block rather than an
  // implementation detail: enumerating the manifest would mean a file absent
  // from the carrier could never gain an entry, so repair could correct the
  // carrier but never complete it — leaving a manifest written by an older
  // store, or one whose keys were lost, permanently unloadable. The registry is
  // the same source `exportLayer` iterates at store time, so the two cannot
  // disagree about which files the layer consists of.
  const sourcemasterFilesRepaired: string[] = [];
  let sourcemasterHashesUpdated = false;
  // Assign back: unlike the universe loop above, this loop always runs, so an
  // absent carrier must become a real object before it is written into.
  const sourcemasterHashes = manifest.sourcemaster_hashes ?? {};
  manifest.sourcemaster_hashes = sourcemasterHashes;
  for (const table of getTablesByLayer('sourcemaster')) {
    const relPath = `sourcemaster/${table.name}.json`;
    const recordedHash = sourcemasterHashes[relPath] ?? '';
    const sourcemasterFilePath = path.join(exportDir, relPath);

    if (!fs.existsSync(sourcemasterFilePath)) {
      // Nothing to recompute from. Leave any recorded hash untouched — load's
      // integrity check is what surfaces the missing file to the user; repair
      // only rewrites hashes for files it can actually read.
      logger.warn(
        `repair-manifest sourcemaster '${relPath}': file absent on disk — hash left unchanged`,
        { sourcemaster_file: relPath },
      );
      continue;
    }

    const diskHash = computeUniverseFileHash(fs.readFileSync(sourcemasterFilePath, 'utf-8'));
    if (diskHash === recordedHash) {
      logger.debug(
        `repair-manifest sourcemaster '${relPath}': hash unchanged (${diskHash.slice(0, 20)}...)`,
        { sourcemaster_file: relPath },
      );
    } else {
      sourcemasterHashes[relPath] = diskHash;
      sourcemasterFilesRepaired.push(relPath);
      sourcemasterHashesUpdated = true;
      logger.info(
        `repair-manifest sourcemaster '${relPath}': hash updated` +
        ` old=${recordedHash.slice(0, 20) || '(none)'}...` +
        ` new=${diskHash.slice(0, 20)}...`,
        { sourcemaster_file: relPath, old_hash: recordedHash, new_hash: diskHash },
      );
    }
  }

  // ── Cross-namespace hashes ─────────────────────────────────────────────────
  // Recompute the content hash of each `cross_namespace/` file from its on-disk
  // bytes, with the same `computeUniverseFileHash` store and load use, so all
  // three agree byte-for-byte.
  //
  // The key set is enumerated from `getTablesByLayer('cross_namespace')`, NOT
  // from the manifest's existing keys — the sourcemaster reasoning above applies
  // unchanged, and it applies with extra force here: `cross_namespace_hashes` is
  // a new carrier, so every manifest written before it existed has no keys at
  // all. Enumerating the manifest would leave each of those manifests
  // permanently without a carrier, which is exactly the "correct but never
  // complete" failure. The registry is the same source `exportLayer` iterates at
  // store time, so the two cannot disagree about which files the layer consists
  // of.
  //
  // Nothing here reads the database, and nothing here re-derives a cross-NS
  // digest from DB rows: the per-namespace content hash answers a different
  // question at a different granularity (see the doc comment on
  // `Manifest.cross_namespace_hashes`).
  const crossNamespaceFilesRepaired: string[] = [];
  let crossNamespaceHashesUpdated = false;
  // Assign back, as in the sourcemaster loop: this loop always runs, so an
  // absent carrier must become a real object before it is written into.
  const crossNamespaceHashes = manifest.cross_namespace_hashes ?? {};
  manifest.cross_namespace_hashes = crossNamespaceHashes;
  for (const table of getTablesByLayer('cross_namespace')) {
    const relPath = `cross_namespace/${table.name}.json`;
    const recordedHash = crossNamespaceHashes[relPath] ?? '';
    const crossNamespaceFilePath = path.join(exportDir, relPath);

    if (!fs.existsSync(crossNamespaceFilePath)) {
      // Nothing to recompute from. Leave any recorded hash untouched — load's
      // integrity check is what surfaces the missing file to the user; repair
      // only rewrites hashes for files it can actually read.
      logger.warn(
        `repair-manifest cross_namespace '${relPath}': file absent on disk — hash left unchanged`,
        { cross_namespace_file: relPath },
      );
      continue;
    }

    const diskHash = computeUniverseFileHash(fs.readFileSync(crossNamespaceFilePath, 'utf-8'));
    if (diskHash === recordedHash) {
      logger.debug(
        `repair-manifest cross_namespace '${relPath}': hash unchanged (${diskHash.slice(0, 20)}...)`,
        { cross_namespace_file: relPath },
      );
    } else {
      crossNamespaceHashes[relPath] = diskHash;
      crossNamespaceFilesRepaired.push(relPath);
      crossNamespaceHashesUpdated = true;
      logger.info(
        `repair-manifest cross_namespace '${relPath}': hash updated` +
        ` old=${recordedHash.slice(0, 20) || '(none)'}...` +
        ` new=${diskHash.slice(0, 20)}...`,
        { cross_namespace_file: relPath, old_hash: recordedHash, new_hash: diskHash },
      );
    }
  }

  // ── Write manifest if anything changed ────────────────────────────────────
  const updated =
    namespacesRepaired.length > 0 || metaHashUpdated || universeHashesUpdated ||
    sourcemasterHashesUpdated || crossNamespaceHashesUpdated;
  if (updated) {
    fs.writeFileSync(manifestPath, serializeMetadata(manifest as unknown as Record<string, unknown>), 'utf-8');
    logger.info(
      `repair-manifest: manifest.json updated` +
      ` — repaired=[${namespacesRepaired.join(', ')}]` +
      ` unchanged=[${namespacesUnchanged.join(', ')}]` +
      (metaHashUpdated ? ' meta_hash=updated' : ' meta_hash=unchanged') +
      (universeFilesRepaired.length > 0 ? ` universe_hashes=[${universeFilesRepaired.join(', ')}]` : ' universe_hashes=unchanged') +
      (sourcemasterFilesRepaired.length > 0 ? ` sourcemaster_hashes=[${sourcemasterFilesRepaired.join(', ')}]` : ' sourcemaster_hashes=unchanged') +
      (crossNamespaceFilesRepaired.length > 0 ? ` cross_namespace_hashes=[${crossNamespaceFilesRepaired.join(', ')}]` : ' cross_namespace_hashes=unchanged'),
    );
  } else {
    logger.info(
      `repair-manifest: manifest.json unchanged` +
      ` — all ${namespacesUnchanged.length} namespace hash(es), meta_hash and per-file hashes already match`,
    );
  }

  return {
    namespaces_repaired: namespacesRepaired,
    namespaces_unchanged: namespacesUnchanged,
    manifest_updated: updated,
    sourcemaster_files_repaired: sourcemasterFilesRepaired,
  };
}
