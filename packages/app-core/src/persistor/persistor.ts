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
import { computeNamespaceHash } from './hash-computer.js';
import { loadAttributeMetadataFromFiles } from './persistor-helpers.js';
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
import { repairManifest } from './persistor-repair.js';

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
 * Recompute the content hash for a namespace from exported JSON files on disk.
 * Pass an optional `debugLog` function to emit per-section hash diagnostics.
 */
export function computeNamespaceHashFromFiles(
  namespace: string,
  nsDir: string,
  exportDir: string,
  debugLog?: (msg: string) => void,
): string {
  const conceptsDir = path.join(nsDir, 'concepts');
  const relsDir     = path.join(nsDir, 'relationships');
  const crossNsPath = path.join(exportDir, 'cross_namespace', 'RIA_UNIV_CrossNSRelationshipInstance.json');

  const { nodeKeyAttrs, edgeKeyAttrs } = loadAttributeMetadataFromFiles(exportDir);

  const conceptInstances: Record<string, unknown>[] = [];
  if (fs.existsSync(conceptsDir)) {
    for (const file of fs.readdirSync(conceptsDir).filter(f => f.endsWith('.json'))) {
      conceptInstances.push(...parseTable(fs.readFileSync(path.join(conceptsDir, file), 'utf-8')));
    }
  }

  const relationshipInstances: Record<string, unknown>[] = [];
  if (fs.existsSync(relsDir)) {
    for (const file of fs.readdirSync(relsDir).filter(f => f.endsWith('.json'))) {
      relationshipInstances.push(...parseTable(fs.readFileSync(path.join(relsDir, file), 'utf-8')));
    }
  }

  const crossNsEdgesAsSource: Record<string, unknown>[] = [];
  if (fs.existsSync(crossNsPath)) {
    const allEdges = parseTable(fs.readFileSync(crossNsPath, 'utf-8'));
    crossNsEdgesAsSource.push(...allEdges.filter(r => String(r.source_namespace ?? '') === namespace));
  }

  return computeNamespaceHash({ namespace, conceptInstances, relationshipInstances, crossNsEdgesAsSource, nodeKeyAttrs, edgeKeyAttrs, debugLog });
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
    hash.update(fs.readFileSync(path.join(metaDir, file)));
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
        return await load(params, dbModule, logger);
      } catch (err) {
        logger.error(`load failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
    repairManifest(params: PersistorRepairParams): Promise<RepairManifestResult> {
      return Promise.resolve(repairManifest(params, logger));
    },
  };
}
