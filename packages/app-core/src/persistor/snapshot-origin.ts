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
 * Reading and writing **D** — the file version this database was synced from.
 *
 * Feature: persistor-shared-layer-sync, task 4.1.
 *
 * The three-hash rule of `docs/coreSpecs/persistorStates.md` compares, per
 * domain, M (recorded in the manifest), F (computed from the files now) and D
 * (what the database was synced to). Namespaces already have a D in
 * `RIA_UNIV_Namespace.content_hash`; the shared domains — `sourcemaster/`,
 * `universe/`, `cross_namespace/` and the manifest itself — had nowhere to
 * record one, which is why a committed change to any of them could be silently
 * overwritten by the next save. `RIA_UNIV_SnapshotOrigin` is that storage.
 *
 * **Invariant 1 — origin rows are never invalidated.** No create, update or
 * delete of *content* touches an origin row. The row answers "which file
 * version did this database consume?", and an unsaved edit does not change that
 * answer; it changes what the database *holds*, which is a different question.
 * This is deliberately the opposite of `RIA_UNIV_Namespace.content_hash`, which
 * is blanked on every edit so an unsaved namespace change presents as S2 and a
 * load acts as undo.
 *
 * Unifying the two the other way — blanking origin rows on write — would make
 * every unsaved import-source, canvas, view and cross-namespace edit present as
 * S2, and the next open would load over it. Preserving unsaved shared-layer work
 * is exactly what this invariant buys.
 */

import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import { computeUniverseFileHash } from './hash-computer.js';
import type { Manifest } from './persistor-types.js';

/** The D of every covered domain, keyed exactly as the manifest keys it. */
export type SnapshotOrigin = Record<string, string>;

/**
 * The literal key for the manifest's own digest.
 *
 * Not a path, unlike every other key: the manifest has no M (a digest stored
 * inside a file cannot validate that file), so its entry here is the only
 * recorded value it has.
 */
export const MANIFEST_ORIGIN_KEY = 'manifest';

const ORIGIN_TABLE = 'RIA_UNIV_SnapshotOrigin';

/**
 * Build the origin record from a manifest and the bytes it was read from or
 * written as.
 *
 * Pure. The manifest's own digest uses `computeUniverseFileHash`, the same
 * primitive every other carrier uses, so there is exactly one hashing idiom
 * across store, load, repair and evaluation.
 *
 * It covers `sourcemaster_hashes`, `universe_hashes`, `cross_namespace_hashes`
 * and `MANIFEST_ORIGIN_KEY`, and deliberately does **not** read
 * `namespace_hashes` or `meta_hash`:
 *
 * - namespaces have their own D in `RIA_UNIV_Namespace.content_hash`, with the
 *   opposite invalidation semantics (see Invariant 1 above). A second D for the
 *   same domain would eventually disagree with the first.
 * - meta is regenerated from the shipped profiles on every open, so there is no
 *   authored content to protect and nothing a D would license.
 *
 * Carriers are read defensively (`?? {}`) because `Manifest` is a parse
 * assertion rather than runtime validation: an older-epoch file on disk may
 * genuinely lack a field this interface declares required.
 */
export function originFromManifest(manifest: Manifest, manifestBytes: string): SnapshotOrigin {
  const origin: SnapshotOrigin = {};
  for (const carrier of [
    manifest.sourcemaster_hashes,
    manifest.universe_hashes,
    manifest.cross_namespace_hashes,
  ]) {
    for (const [key, hash] of Object.entries(carrier ?? {})) {
      if (typeof hash === 'string' && hash.length > 0) origin[key] = hash;
    }
  }
  origin[MANIFEST_ORIGIN_KEY] = computeUniverseFileHash(manifestBytes);
  return origin;
}

/**
 * Read every origin row. An empty result means no record exists — a database
 * that predates the table, or was reset — which the classifier resolves as a
 * null D: never towards a write.
 *
 * Fail-safe: a read failure (table absent on a database opened read-only before
 * migration, for instance) yields an empty record rather than throwing, because
 * every caller is a diagnostic that must not block a workspace open.
 */
export async function readSnapshotOrigin(dbModule: IDbModule): Promise<SnapshotOrigin> {
  try {
    const rows = await dbModule.runQuery(
      `MATCH (o:${ORIGIN_TABLE}) RETURN o.key AS key, o.hash AS hash`,
    );
    const origin: SnapshotOrigin = {};
    for (const row of rows) {
      const key = row.key == null ? '' : String(row.key);
      const hash = row.hash == null ? '' : String(row.hash);
      if (key) origin[key] = hash;
    }
    return origin;
  } catch {
    return {};
  }
}

/**
 * Replace the origin record wholesale, in **one transaction**.
 *
 * Atomicity is load-bearing, not hygiene. The manifest short-circuit
 * (Invariant 2, in `workspace-service.ts`) reasons: "the manifest digest matches
 * the recorded `manifest` value, therefore the recorded per-key values are that
 * manifest's own values, therefore D equals M for every covered key without
 * reading them". A partially written set would make that inference false, and
 * the short-circuit would then skip a domain whose D belongs to an older
 * manifest — resolving a real divergence as S1.
 *
 * Written at the end of a successful load and every store path. Manifest
 * repair never writes an origin: it changes the index, not the database's
 * content. Recording repaired hashes here would hide data still needing load.
 *
 * A failed write is logged at ERROR and does **not** throw. At the point this
 * runs the files are already correct; a stale D costs one unnecessary load at
 * the next open, which is the cheapest failure mode available. Failing the
 * surrounding store or load would instead abandon work that succeeded.
 */
export async function writeSnapshotOrigin(
  dbModule: IDbModule,
  origin: SnapshotOrigin,
  logger?: ImportLogger,
): Promise<void> {
  const entries = Object.entries(origin);
  try {
    if (dbModule.beginTransaction) {
      const txn = await dbModule.beginTransaction();
      try {
        await txn.runQuery(`MATCH (o:${ORIGIN_TABLE}) DELETE o`);
        for (const [key, hash] of entries) {
          await txn.runQuery(
            `CREATE (:${ORIGIN_TABLE} {key: $key, hash: $hash})`,
            { key, hash },
          );
        }
        await txn.commit();
      } catch (err) {
        await txn.rollback().catch(() => undefined);
        throw err;
      }
    } else {
      // No transaction support (a stub module in a test, for instance). The
      // wholesale replacement is still the right shape; it simply loses the
      // atomicity guarantee, and the only cost of losing it is an extra load.
      await dbModule.runQuery(`MATCH (o:${ORIGIN_TABLE}) DELETE o`);
      for (const [key, hash] of entries) {
        await dbModule.runQuery(
          `CREATE (:${ORIGIN_TABLE} {key: $key, hash: $hash})`,
          { key, hash },
        );
      }
    }
    logger?.debug?.(
      `snapshot-origin: recorded ${entries.length} origin row(s)`,
      { keys: entries.length },
    );
  } catch (err) {
    logger?.error?.(
      `snapshot-origin: failed to record the file version this database was synced from — ` +
      `the next workspace open will reload from ria-data/ unnecessarily, but no data is at risk: ` +
      (err instanceof Error ? err.message : String(err)),
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
