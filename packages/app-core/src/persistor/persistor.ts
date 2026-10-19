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
 * Persistor Service — barrel module.
 *
 * Re-exports all public API from the split modules and contains the
 * `computeNamespaceHashFromFiles()` utility and `createPersistorService()` factory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import { parseTable } from './serializer.js';
import { computeNamespaceHashFromFileContents } from './hash-computer.js';
import type { NamespaceSectionFile } from './hash-computer.js';
import type {
  PersistorStoreParams,
  PersistorLoadParams,
  PersistorRepairParams,
  StoreResult,
  LoadResult,
  RepairManifestResult,
  IPersistorService,
} from './persistor-types.js';
import { store } from './persistor-store.js';
import { load } from './persistor-load.js';
import { repairManifest, prepareManifestForExplicitLoad } from './persistor-repair.js';
import { setPendingSyncDecision, stampBaseline } from '../workspace/snapshot-baseline.js';

// ── Re-exports: types ──────────────────────────────────────────────────────────

export type {
  PersistorStoreParams,
  PersistorLoadParams,
  PersistorRepairParams,
  StoreResult,
  LoadResult,
  RepairManifestResult,
  Manifest,
  IPersistorService,
  LoadProgressEvent,
  OnLoadProgress,
  NodeKeyAttrMap,
  EdgeKeyAttrMap,
} from './persistor-types.js';

export { LOAD_BATCH_SIZE } from './persistor-types.js';

// ── Re-exports: sort functions ─────────────────────────────────────────────────

export { sortConceptInstances, sortRelationshipInstances, sortCrossNsRelationshipInstances, sortCrossNsInstanceRelEdges } from './persistor-sort.js';

// ── computeNamespaceHashFromFiles ──────────────────────────────────────────────

/**
 * Read the `*.json` files of one namespace section directory, paired with their
 * exact on-disk content.
 *
 * Read as a UTF-8 string rather than a `Buffer` on purpose: the store side has
 * only the string it is about to write, and
 * `computeNamespaceHashFromFileContents` must give both sides the same digest.
 */
function readSectionFiles(dir: string): NamespaceSectionFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(fileName => ({
      fileName,
      content: fs.readFileSync(path.join(dir, fileName), 'utf-8'),
    }));
}

/**
 * Recompute the content hash for a namespace from the exported JSON files on
 * disk. Pass an optional `debugLog` function to emit per-section hash
 * diagnostics.
 *
 * This is the file-side half of the namespace-hash contract: it reads the bytes
 * and delegates every decision about how they are digested to
 * `computeNamespaceHashFromFileContents`, whose doc comment defines the
 * contract that the store side must match. Note that it no longer parses the
 * records — the digest covers the file bytes — which is what lets it reproduce
 * a recorded hash even for content the write loop declined to write a record
 * for.
 *
 * The cross-namespace section is the one exception and stays record-based,
 * filtered by `source_namespace`, because its file is shared across every
 * namespace.
 */
export function computeNamespaceHashFromFiles(
  namespace: string,
  nsDir: string,
  exportDir: string,
  debugLog?: (msg: string) => void,
): string {
  const crossNsPath = path.join(exportDir, 'cross_namespace', 'RIA_UNIV_CrossNSRelationshipInstance.json');

  const conceptFiles = readSectionFiles(path.join(nsDir, 'concepts'));
  const relationshipFiles = readSectionFiles(path.join(nsDir, 'relationships'));

  const crossNsEdgesAsSource: Record<string, unknown>[] = [];
  if (fs.existsSync(crossNsPath)) {
    const allEdges = parseTable(fs.readFileSync(crossNsPath, 'utf-8'));
    crossNsEdgesAsSource.push(...allEdges.filter(r => String(r.source_namespace ?? '') === namespace));
  }

  return computeNamespaceHashFromFileContents({
    namespace,
    conceptFiles,
    relationshipFiles,
    crossNsEdgesAsSource,
    debugLog,
  });
}

// ── computeMetaHash ────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash over all meta layer JSON files in `metaDir`.
 *
 * The hash covers the sorted file names and their contents, so any change to
 * metamodel definitions, DEFINEDBY, or CATEGORIZEDBY edges is detected.
 * Files are sorted by name for determinism across platforms.
 */
export function computeMetaHash(metaDir: string): string {
  if (!fs.existsSync(metaDir)) return 'sha256:empty';
  const files = fs.readdirSync(metaDir)
    .filter(f => f.endsWith('.json'))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    // Include the file name so renaming a file changes the hash
    hash.update(file);
    // Digest the UTF-8 string, matching the idiom used for the other carriers.
    // Equivalent to digesting the raw bytes for any valid UTF-8 input, so
    // recorded values stayed comparable and needed no epoch bump.
    hash.update(fs.readFileSync(path.join(metaDir, file), 'utf-8'), 'utf-8');
  }
  return `sha256:${hash.digest('hex')}`;
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createPersistorService(dbModule: IDbModule, logger: ImportLogger): IPersistorService {
  return {
    async store(params: PersistorStoreParams): Promise<StoreResult> {
      try {
        return await store(params, dbModule, logger);
      } catch (err) {
        logger.error(`store failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    async load(params: PersistorLoadParams): Promise<LoadResult> {
      try {
        if (params.acceptFileChanges) {
          if (params.plan !== undefined) throw new Error('Accepting file changes requires a full load');
          // File-only preparation: do not advance DB origins or the session
          // baseline until load succeeds. Failed loads keep the decision pending.
          prepareManifestForExplicitLoad(params, logger);
        }
        const result = await load(params, dbModule, logger);
        // The DB now holds exactly what is on disk, so the files become the new
        // baseline.
        //
        // Without this, "Load from ria-data" could not resolve snapshot drift:
        // the load rebuilt the DB but left the OLD baseline in place, so the very
        // next drift check compared the (restored) files against a baseline they
        // were never going to match, re-reported drift, and re-raised the dialog
        // — an unbreakable loop. A load is deliberately NOT fenced, because it is
        // the resolution for drift, not a writer of it.
        stampBaseline(params.workingDir, undefined, { reason: 'load' });
        if (params.plan === undefined) setPendingSyncDecision(params.workingDir, null);
        return result;
      } catch (err) {
        logger.error(`load failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    async repairManifest(params: PersistorRepairParams): Promise<RepairManifestResult> {
      const result = await Promise.resolve(repairManifest(params, logger));
      // Repair changes M to match F, but does not load any data. Preserve every
      // database origin row, including the manifest digest: advancing D here
      // would classify unloaded incoming content as S1 and let the next save
      // overwrite it. Only a successful load or store records a new origin.
      // For S4, D already equals F, so repair still converges to S1 without a
      // database write. S3/S5 instead becomes S2 and is loaded on reopen.
      // Repair rewrites manifest.json to match the on-disk files, which changes
      // the very hashes the baseline is compared against. Re-stamp for the same
      // reason as load: otherwise accepting a repair immediately looks like drift.
      // This in-memory session baseline is distinct from the persistent DB origin.
      stampBaseline(params.workingDir, undefined, { reason: 'repair' });
      return result;
    },
  };
}
