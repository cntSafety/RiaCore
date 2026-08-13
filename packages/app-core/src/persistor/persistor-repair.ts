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
 * state of the meta layer files (metamodel definitions, DEFINEDBY, CATEGORIZEDBY).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImportLogger } from '../infra/logger.js';
import { serializeMetadata } from './serializer.js';
import type { PersistorRepairParams, RepairManifestResult, Manifest } from './persistor-types.js';
import { computeNamespaceHashFromFiles, computeMetaHash } from './persistor.js';
import { computeUniverseFileHash } from './hash-computer.js';

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
  // mismatch (canvas-layout-auto-save Req 6.4, 6.5) just as it clears a
  // namespace mismatch. Hashes are computed with the same shared helper used at
  // store and load time so store/load/repair always agree byte-for-byte.
  const universeFilesRepaired: string[] = [];
  let universeHashesUpdated = false;
  const universeHashes = manifest.universe_hashes ?? {};
  for (const relPath of Object.keys(universeHashes)) {
    const recordedHash = universeHashes[relPath] ?? '';
    const universeFilePath = path.join(exportDir, relPath);

    if (!fs.existsSync(universeFilePath)) {
      // Cannot recompute a hash for a file that is not on disk. Leave the
      // recorded hash untouched — the load-time integrity check surfaces the
      // missing file to the user (Req 6.5); repair only rewrites hashes for
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

  // ── Write manifest if anything changed ────────────────────────────────────
  const updated = namespacesRepaired.length > 0 || metaHashUpdated || universeHashesUpdated;
  if (updated) {
    fs.writeFileSync(manifestPath, serializeMetadata(manifest as unknown as Record<string, unknown>), 'utf-8');
    logger.info(
      `repair-manifest: manifest.json updated` +
      ` — repaired=[${namespacesRepaired.join(', ')}]` +
      ` unchanged=[${namespacesUnchanged.join(', ')}]` +
      (metaHashUpdated ? ' meta_hash=updated' : ' meta_hash=unchanged') +
      (universeFilesRepaired.length > 0 ? ` universe_hashes=[${universeFilesRepaired.join(', ')}]` : ' universe_hashes=unchanged'),
    );
  } else {
    logger.info(
      `repair-manifest: manifest.json unchanged` +
      ` — all ${namespacesUnchanged.length} namespace hash(es) and meta_hash already match`,
    );
  }

  return { namespaces_repaired: namespacesRepaired, namespaces_unchanged: namespacesUnchanged, manifest_updated: updated };
}
