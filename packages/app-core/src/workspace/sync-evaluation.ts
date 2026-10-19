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
 * The open-time per-domain sync evaluation: classify `ria-data/`, then compare
 * M, F and D for every domain and resolve one outcome.
 *
 * Feature: persistor-shared-layer-sync, tasks 8.1, 9.1, 9.2, 9.4.
 *
 * This module replaces the layer-by-layer special cases that `checkConsistency`
 * grew (namespace integrity, then `meta_hash`, then namespace-hash-versus-DB)
 * with one rule applied uniformly per domain. The rule itself is pure and lives
 * in `sync-state.ts`; everything here is the I/O that feeds it.
 *
 * Two named invariants are implemented here and carry their rationale inline:
 * the unusable-manifest state (in `classifyRiaData`) and the manifest
 * short-circuit (Invariant 2, in `evaluateSyncStates`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppCoreLogger, IDbModule } from '../db/db-module.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import {
  classifySchemaCompatibility,
  describeIncompatibleSchema,
  type SchemaCompatibility,
} from '../db/schema-compat.js';
import type { Manifest } from '../persistor/persistor-types.js';
import { computeNamespaceHashFromFiles, computeMetaHash } from '../persistor/persistor.js';
import { computeUniverseFileHash } from '../persistor/hash-computer.js';
import { MANIFEST_ORIGIN_KEY, readSnapshotOrigin } from '../persistor/snapshot-origin.js';
import type { SnapshotOrigin } from '../persistor/snapshot-origin.js';
import { getTablesByLayer } from '../persistor/table-registry.js';
import { writeFileAtomic } from '../persistor/persistor-helpers.js';
import { serializeMetadata } from '../persistor/serializer.js';
import {
  classifySyncState,
  planLoad,
  resolveOutcome,
  type DomainStateEntry,
  type SyncOutcome,
} from './sync-state.js';

/** The id used for the single meta domain, which has no path of its own. */
export const META_DOMAIN_ID = '(meta)';

// ── ria-data classification (task 8.1) ───────────────────────────────────────

export type RiaDataClassification =
  /** A parseable manifest. Case D. */
  | { kind: 'readable'; manifest: Manifest; bytes: string }
  /** No manifest AND no snapshot content. A genuinely new snapshot. Case C/A. */
  | { kind: 'absent_empty' }
  /**
   * A manifest that is missing or unparseable WHILE other `ria-data/` content is
   * present. F cannot be computed and M does not exist, so the database is the
   * sole authority — and the only recoveries are an explicit save from the
   * database, or restoring the file from version control.
   *
   * `repairManifest` cannot help: it starts by parsing the manifest.
   * A load cannot help: the manifest IS the index of what to load.
   *
   * This is its own state rather than a variety of drift because the previous
   * boolean `hasValidManifest` collapsed it into "no snapshot yet", and open
   * then stored from the database over committed content before any drift could
   * be reported — the most severe defect in the measured state matrix (row 10).
   */
  | { kind: 'unusable'; reason: string }
  /**
   * A manifest that parses, but declares a `schema_version` this code must not
   * read: a different major generation, newer than this build writes, older than
   * `MIN_READABLE_SCHEMA_VERSION`, or unparseable. See `db/schema-compat.ts` for
   * why each of those is refused rather than migrated.
   *
   * Its own state, and NOT folded into `unusable`, for two reasons.
   *
   * First, the recovery is different in kind. An unusable manifest is a local
   * accident with local fixes (save from the database, restore the file). An
   * incompatible one is a statement about which *build* of RiaCore this snapshot
   * belongs to, and the only honest advice names a different build. Reusing
   * `unusable`'s wording would tell a user to repair a file that is not broken.
   *
   * Second, and the reason this is not merely cosmetic: `unusable` degrades to
   * `absent_empty` when `ria-data/` holds nothing besides the manifest, on the
   * grounds that there is then nothing a store could destroy. That reasoning does
   * not transfer. A manifest declaring a version from another generation is
   * itself the thing to protect — degrading would let Case A/C treat the
   * directory as a new workspace and stamp a current-schema snapshot over it,
   * which is exactly the downgrade this state exists to prevent. So this kind is
   * returned unconditionally, content or no content.
   */
  | { kind: 'incompatible'; compatibility: Extract<SchemaCompatibility, { kind: 'incompatible' }> };

/**
 * Top-level `ria-data/` entries that are NOT snapshot content.
 *
 * `checks.json` is the one that matters: `workspace.create` writes it before any
 * store has run, so a brand-new workspace has a `ria-data/` directory with one
 * file in it. Counting that as content would classify every new workspace's
 * second open as `unusable` and refuse to ever write its first snapshot.
 */
const NON_SNAPSHOT_ENTRIES = new Set(['checks.json', 'manifest.json']);

/**
 * Does `ria-data/` hold snapshot content besides the manifest?
 *
 * The discriminator between `absent_empty` and `unusable`. A missing manifest
 * beside populated namespace directories is not a new workspace.
 */
function hasSnapshotContent(riaDataDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(riaDataDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (NON_SNAPSHOT_ENTRIES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      // A directory counts only when it actually holds something: an empty
      // `meta/` left behind by a failed store is not content to protect.
      try {
        if (fs.readdirSync(path.join(riaDataDir, entry.name)).length > 0) return true;
      } catch { /* unreadable — treat as empty */ }
      continue;
    }
    if (entry.isFile()) return true;
  }
  return false;
}

export async function classifyRiaData(workingDir: string): Promise<RiaDataClassification> {
  const riaDataDir = path.join(workingDir, 'ria-data');
  const manifestPath = path.join(riaDataDir, 'manifest.json');

  let bytes: string;
  try {
    bytes = await fs.promises.readFile(manifestPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!hasSnapshotContent(riaDataDir)) return { kind: 'absent_empty' };
    return {
      kind: 'unusable',
      reason:
        code === 'ENOENT'
          ? 'ria-data/manifest.json is missing, but ria-data/ holds snapshot content'
          : `ria-data/manifest.json cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }


  // A manifest that is present but cannot be used is `unusable` only when there
  // is other content to protect. With nothing else in `ria-data/` there is
  // nothing a store could destroy, and the directory is what a workspace whose
  // first store never completed looks like — so it stays `absent_empty` and Case
  // A/C proceeds, exactly as before this feature.
  const unusable = (reason: string): RiaDataClassification =>
    hasSnapshotContent(riaDataDir) ? { kind: 'unusable', reason } : { kind: 'absent_empty' };

  try {
    const parsed = JSON.parse(bytes) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return unusable('ria-data/manifest.json is not a JSON object');
    }
    const manifest = parsed as Manifest;
    // `namespaces` is the one field every downstream consumer dereferences
    // without a guard, including the epoch-independent identity check in
    // `persistor.load`. A file that parses but has no namespaces array is not a
    // manifest, and treating it as readable only moves the failure later.
    if (!Array.isArray(manifest.namespaces)) {
      return unusable('ria-data/manifest.json carries no namespaces[] array');
    }
    // The version gate, placed here — at classification — rather than inside
    // `load`. By the time `load` runs, the stale-DB path has already deleted the
    // database it meant to rebuild, so a refusal there leaves the user with
    // neither a database nor an opened workspace. Refusing at classification
    // happens before any database is opened, deleted or written, which is what
    // makes "nothing has been touched" true in the message the user sees.
    //
    // Deliberately NOT routed through `unusable()`: see the `incompatible` doc
    // comment for why degrading to `absent_empty` would reintroduce the
    // overwrite this gate prevents.
    const compatibility = classifySchemaCompatibility(manifest.schema_version);
    if (compatibility.kind === 'incompatible') {
      return { kind: 'incompatible', compatibility };
    }
    return { kind: 'readable', manifest, bytes };
  } catch (err) {
    return unusable(
      `ria-data/manifest.json is not parseable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The user-facing text for `opened_manifest_unusable`.
 *
 * Exported so the one wording lives in one place: the workspace service puts it
 * on `lifecycleWarning`, and the tests assert the three claims it has to make —
 * the condition, the two recoveries that work, and the two that cannot.
 */
export function describeUnusableManifest(reason: string): string {
  return (
    `${reason}. The database is the only coherent copy of this workspace, so nothing has been ` +
    `written to ria-data/. Two recoveries work: save from the database (Store to ria-data with ` +
    `"allowSnapshotMismatch", which rewrites manifest.json wholesale), or restore ` +
    `ria-data/manifest.json from version control. Loading from ria-data and "Repair Manifest" ` +
    `both cannot help — each begins by parsing the same unreadable file. Saves are refused until ` +
    `one of the two recoveries is taken.`
  );
}

// ── Per-domain evaluation (tasks 9.1, 9.2, 9.4) ──────────────────────────────

export interface SyncEvaluation {
  entries: DomainStateEntry[];
  outcome: SyncOutcome;
  /** True when the epoch differed and every comparison was suspended. */
  epochSuspended: boolean;
  /** True when the manifest digest matched its origin row and the D reads were skipped. */
  shortCircuited: boolean;
}

/** Read a ria-data-relative file's bytes, or null when it cannot be read. */
function readRelFile(exportDir: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(exportDir, relPath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The ria-data-relative key set for a shared layer, taken from the table
 * registry rather than from the manifest's keys.
 *
 * Same reasoning as `repairManifest`: enumerating the manifest would mean a file
 * absent from a carrier is never evaluated, so a manifest whose carrier was lost
 * would evaluate as entirely consistent. The registry is the set `exportLayer`
 * iterates at store time, so the two cannot disagree about which files the layer
 * consists of.
 */
function layerKeys(layer: 'sourcemaster' | 'cross_namespace'): string[] {
  return getTablesByLayer(layer).map((t) => `${layer}/${t.name}.json`);
}

/**
 * Evaluate every domain of a readable snapshot and resolve one outcome.
 *
 * Order of operations matters and is load-bearing:
 *
 * 1. **Epoch guard first.** `Manifest` is a parse assertion rather than runtime
 *    validation, so a field declared required may be absent in an older-epoch
 *    file and dereferencing a carrier would throw. Across an epoch difference no
 *    domain is S3, S4 or S5, no integrity failure is reported, and the outcome is
 *    a full load — the workspace stays writable and the first store re-stamps
 *    every carrier at the current epoch.
 * 2. **Manifest domain.** F is the digest of the manifest bytes; D is the
 *    `manifest` origin row. There is no M and no self-hash field is added to
 *    `manifest.json` (a digest stored inside a file cannot validate that file).
 * 3. **Short-circuit** on F === D, per Invariant 2 below.
 * 4. **Every other domain**, then `resolveOutcome`.
 */
export async function evaluateSyncStates(
  workingDir: string,
  manifest: Manifest,
  manifestBytes: string,
  dbModule: IDbModule,
  logger?: AppCoreLogger,
): Promise<SyncEvaluation> {
  const exportDir = path.join(workingDir, 'ria-data');

  // ── 1. Epoch guard ─────────────────────────────────────────────────────────
  //
  // Only versions inside the supported range reach this function: both callers
  // (`workspaceService.open` and `buildSyncReport`) run `classifyRiaData` first,
  // which refuses an incompatible version outright. Asserted rather than assumed,
  // because the alternative — falling through to the suspend-and-load outcome
  // below — is precisely the unconditional auto-migration the floor exists to
  // stop. `persistor.load` carries the same guard, so even a degraded path that
  // swallows this throw cannot write.
  const compatibility = classifySchemaCompatibility(manifest.schema_version);
  if (compatibility.kind === 'incompatible') {
    throw new Error(
      `internal: evaluateSyncStates reached with an incompatible schema_version — ` +
      `${compatibility.summary}. Callers must handle the 'incompatible' classification first.`,
    );
  }

  if (!compatibility.exact) {
    logger?.warn?.(
      `ria-data manifest schema_version (${String(manifest.schema_version)}) differs from the current ` +
      `schema (${SCHEMA_VERSION}) — every hash comparison is suspended and the database is treated ` +
      `as stale rather than the files as corrupt`,
      { manifest_schema_version: manifest.schema_version, current_schema_version: SCHEMA_VERSION },
    );
    return {
      entries: [],
      // A full load: every layer, every namespace in the manifest. Not computed
      // by `planLoad`, which would see no entries and plan nothing.
      outcome: {
        kind: 'load',
        plan: {
          meta: true,
          sourcemaster: true,
          universe: true,
          crossNamespace: true,
          namespaces: (manifest.namespaces ?? []).map((n) => n.name).filter((n) => !!n),
        },
      },
      epochSuspended: true,
      shortCircuited: false,
    };
  }

  const entries: DomainStateEntry[] = [];

  // ── 2. Manifest domain ─────────────────────────────────────────────────────
  const manifestF = computeUniverseFileHash(manifestBytes);
  // One read of the origin table serves both the manifest row and, when the
  // short-circuit does not apply, every shared domain's D. They live in the same
  // table, so the manifest domain cannot be evaluated without it — which means
  // what the short-circuit saves is the per-domain comparisons and the special
  // cases around an absent or stale key, not a query. Stated plainly here
  // because Requirement 4.3 describes the saving as "the database read", and a
  // reader expecting a second query to disappear would look for it in vain.
  const origin: SnapshotOrigin = await readSnapshotOrigin(dbModule);
  const manifestD = origin[MANIFEST_ORIGIN_KEY] ?? null;

  // ── 3. Invariant 2 — the short-circuit skips D, never F ────────────────────
  //
  // When the manifest's F equals its D, the per-domain D lookups for the SHARED
  // domains are skipped and each is classified by M against F alone: S1 when
  // they agree, S3 when they differ.
  //
  // The soundness argument, written down because the obvious reading of "skip
  // every per-domain check" is wrong. D changes only at the end of a load or
  // store, and each writes the whole origin record in ONE
  // transaction from ONE manifest version (see `writeSnapshotOrigin`). So a
  // manifest file that still digests to the recorded `manifest` value *is* the
  // version whose M values were recorded as D — hence D equals M for every
  // covered key, with no read required.
  //
  // What that argument says nothing about is F: a file can be edited without the
  // manifest being rewritten, which is exactly the condition row 08 of the
  // measured matrix reported as consistent. So M-against-F is computed for every
  // domain on every open, short-circuit or not. The saving is the origin read and
  // the per-layer special cases, not the hashing.
  //
  // Deliberate narrowing against Requirement 4.3, which says the short-circuit
  // covers "every other domain": it does NOT cover namespaces. A namespace's D
  // is `RIA_UNIV_Namespace.content_hash`, which is BLANKED on every edit, so it
  // is not written by the atomic origin write the argument above rests on.
  // Requirement 2.5 is the more specific rule — an unsaved namespace edit must
  // still present as S2 so a load acts as undo — and it would be silently broken
  // by taking D === M for namespaces. The namespace hash query runs on every
  // open regardless; it is one query, and it is the one the old
  // `checkConsistency` already made.
  const shortCircuited = manifestD !== null && manifestD === manifestF;
  /**
   * D for one shared-layer file.
   *
   * Under the short-circuit this is M, provably and without consulting the
   * recorded value — which is what makes a key missing from the origin record
   * (a layer added since the last store, say) harmless on the common path
   * instead of a spurious S2.
   */
  const sharedD = (key: string, m: string | null): string | null =>
    shortCircuited ? m : origin[key] ?? null;

  entries.push({
    domain: { kind: 'manifest', id: 'manifest.json' },
    hashes: { m: null, f: manifestF, d: manifestD },
    // The manifest carries no action of its own — `resolveOutcome` excludes it,
    // see the comment there. S1 when the database synced from this exact file,
    // S2 when it did not; the latter only disables the short-circuit.
    state: shortCircuited ? 'S1' : 'S2',
  });

  // ── 4a. Namespaces ─────────────────────────────────────────────────────────
  const dbNamespaceHashes = new Map<string, string>();
  try {
    const rows = await dbModule.runQuery(
      'MATCH (n:RIA_UNIV_Namespace) RETURN n.name AS name, n.content_hash AS hash',
    );
    for (const row of rows) {
      if (row.name != null) dbNamespaceHashes.set(String(row.name), String(row.hash ?? ''));
    }
  } catch (err) {
    logger?.warn?.('sync evaluation: namespace hash query failed, treating every D as unknown', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const manifestNamespaceHashes: Record<string, string> = manifest.namespace_hashes ?? {};
  // The union of both manifest sources, not just `namespaces[]`. A name recorded
  // in `namespace_hashes` but missing from `namespaces[]` is a defective
  // manifest, and the previous `checkConsistency` detected it — it compared the
  // carrier's keys against the database — so iterating only `namespaces[]` here
  // would silently start reporting such a workspace as consistent.
  const namespaceNames: string[] = [];
  for (const entry of manifest.namespaces) {
    if (entry.name && !namespaceNames.includes(entry.name)) namespaceNames.push(entry.name);
  }
  for (const name of Object.keys(manifestNamespaceHashes)) {
    if (name && !namespaceNames.includes(name)) namespaceNames.push(name);
  }

  for (const namespace of namespaceNames) {
    const nsEntry = manifest.namespaces.find((n) => n.name === namespace);
    const m = manifestNamespaceHashes[namespace] ?? null;
    const nsDir = path.join(exportDir, (nsEntry as { directory?: string } | undefined)?.directory ?? namespace);
    let f: string | null = null;
    const sectionLines: string[] = [];
    try {
      f = computeNamespaceHashFromFiles(namespace, nsDir, exportDir, (msg) => sectionLines.push(msg));
    } catch (err) {
      logger?.warn?.(`sync evaluation: cannot hash namespace '${namespace}' from disk`, {
        namespace, error: err instanceof Error ? err.message : String(err),
      });
    }
    // A namespace with no recorded hash cannot be compared; treat M as equal to
    // F so it reads as intact, leaving the DB-side comparison to decide. This is
    // the old `if (!manifestHash) continue` integrity skip, preserved.
    const hashes = m === null ? { m: f, f, d: dbNamespaceHashes.get(namespace) ?? null }
      : { m, f, d: dbNamespaceHashes.get(namespace) ?? null };
    // An empty `content_hash` is the write-invalidation marker, not a hash:
    // normalise it to "unknown D" so an edited namespace lands in S2 (load as
    // undo) rather than S5.
    if (hashes.d === '') hashes.d = null;
    const state = classifySyncState(hashes);
    if (state !== 'S1' && sectionLines.length > 0 && hashes.m !== hashes.f) {
      for (const line of sectionLines) logger?.warn?.(`  [integrity/section] ${line}`, { namespace });
    }
    entries.push({ domain: { kind: 'namespace', id: namespace }, hashes, state });
  }

  // DB-only namespaces are local work, not incoming snapshot content. There is
  // no M/F pair to compare or namespace file to load. Do not synthesize S2 for
  // them: that would trigger a load which skips the absent namespace but clears
  // its newly registered metamodel and cross-namespace edges from the DB.
  // The next store exports these namespaces together with their metadata.
  // Entries in either manifest carrier are still evaluated above, including a
  // namespace_hashes entry whose namespaces[] record is missing.

  // ── 4b. The three per-file shared layers ───────────────────────────────────
  const perFileLayers: Array<{
    kind: 'sourcemaster' | 'universe' | 'cross_namespace';
    keys: string[];
    carrier: Record<string, string>;
  }> = [
    {
      kind: 'sourcemaster',
      keys: layerKeys('sourcemaster'),
      carrier: manifest.sourcemaster_hashes ?? {},
    },
    {
      // The universe layer is written by bespoke store steps rather than the
      // registry-driven `exportLayer`, so the registry is NOT its key set; the
      // manifest carrier is the only authoritative list of what was written.
      kind: 'universe',
      keys: Object.keys(manifest.universe_hashes ?? {}),
      carrier: manifest.universe_hashes ?? {},
    },
    {
      kind: 'cross_namespace',
      keys: layerKeys('cross_namespace'),
      carrier: manifest.cross_namespace_hashes ?? {},
    },
  ];

  for (const layer of perFileLayers) {
    for (const relPath of layer.keys) {
      const m = layer.carrier[relPath] ?? null;
      const content = readRelFile(exportDir, relPath);
      const f = content === null ? null : computeUniverseFileHash(content);
      if (m === null && f === null) {
        // Neither recorded nor present. Nothing to compare and nothing at risk —
        // a layer this store never wrote, which is how a fresh workspace reads.
        continue;
      }
      const hashes = { m, f, d: sharedD(relPath, m) };
      const state = classifySyncState(hashes);
      if (state !== 'S1') {
        logger?.warn?.(
          `sync evaluation: ${layer.kind} '${relPath}' is ${state} ` +
          `(manifest=${(m ?? '(none)').slice(0, 20)}… disk=${(f ?? '(absent)').slice(0, 20)}… ` +
          `database=${(hashes.d ?? '(unrecorded)').slice(0, 20)}…)`,
          { layer: layer.kind, file: relPath, state, manifest_hash: m, disk_hash: f, origin_hash: hashes.d },
        );
      }
      entries.push({ domain: { kind: layer.kind, id: relPath }, hashes, state });
    }
  }

  // ── 4c. Meta ───────────────────────────────────────────────────────────────
  //
  // Meta keeps its M-versus-F comparison, acquires no D, and stays out of the
  // per-save drift fence. Recorded here because this is where a future reader
  // will look for it: the meta layer is REGENERATED from the shipped profiles
  // and the metamodel YAML on every workspace open, so there is no authored
  // content to protect and a D would license nothing. It is excluded from the
  // save fence for the mirror-image reason — the application rewrites `meta/`
  // itself at open, so gating saves on it would refuse a save because of a
  // change RiaCore made seconds earlier.
  //
  // It therefore does NOT go through `classifySyncState`: with D null, M === F
  // would classify S2 and every open would load. S1/S2 by M-versus-F alone is
  // the existing behaviour and the one Requirement 11.3 asks for.
  if (manifest.meta_hash) {
    const diskMetaHash = computeMetaHash(path.join(exportDir, 'meta'));
    const metaState = diskMetaHash === manifest.meta_hash ? 'S1' : 'S2';
    if (metaState !== 'S1') {
      logger?.warn?.(
        `meta layer differs from the manifest — treating the database as stale ` +
        `(manifest=${manifest.meta_hash.slice(0, 20)}… disk=${diskMetaHash.slice(0, 20)}…)`,
        { manifest_meta_hash: manifest.meta_hash, disk_meta_hash: diskMetaHash },
      );
    }
    entries.push({
      domain: { kind: 'meta', id: META_DOMAIN_ID },
      hashes: { m: manifest.meta_hash, f: diskMetaHash, d: null },
      state: metaState,
    });
  }

  const outcome = resolveOutcome(entries);
  logger?.info?.(
    `sync evaluation: ${entries.length} domain(s), outcome=${outcome.kind}` +
    (shortCircuited ? ' (manifest short-circuit)' : ''),
    { outcome: outcome.kind, domains: entries.length, shortCircuited },
  );
  return { entries, outcome, epochSuspended: false, shortCircuited };
}

/**
 * Repair only the proven S4 entries before an S2 load. This must be file-only:
 * recording the entire repaired manifest as D would claim that the S2 data was
 * already consumed, even if the following load fails or the process exits.
 * S4's D already equals F and needs no update. Successful load records the new
 * origin through its usual path.
 */
export function repairStaleManifestBeforeLoad(
  workingDir: string,
  evaluation: SyncEvaluation,
  logger?: AppCoreLogger,
): void {
  if (evaluation.outcome.kind !== 'load') return;
  const stale = evaluation.entries.filter(e => e.state === 'S4');
  if (stale.length === 0) return;

  const exportDir = path.join(workingDir, 'ria-data');
  const manifestPath = path.join(exportDir, 'manifest.json');
  const bytes = fs.readFileSync(manifestPath, 'utf-8');
  const evaluatedHash = evaluation.entries.find(e => e.domain.kind === 'manifest')?.hashes.f;
  if (computeUniverseFileHash(bytes) !== evaluatedHash) {
    throw new Error('Manifest changed during sync evaluation; reopen the workspace before loading');
  }
  const manifest = JSON.parse(bytes) as Manifest;
  for (const entry of stale) {
    const { kind, id } = entry.domain;
    let carrier: Record<string, string>;
    let diskHash: string | null;
    if (kind === 'namespace') {
      const ns = manifest.namespaces.find(n => n.name === id);
      const dir = (ns as { directory?: string } | undefined)?.directory ?? id;
      diskHash = computeNamespaceHashFromFiles(id, path.join(exportDir, dir), exportDir);
      carrier = manifest.namespace_hashes ??= {};
    } else if (kind === 'universe' || kind === 'sourcemaster' || kind === 'cross_namespace') {
      const content = readRelFile(exportDir, id);
      diskHash = content === null ? null : computeUniverseFileHash(content);
      carrier = manifest[`${kind}_hashes`] ??= {};
    } else {
      throw new Error(`Cannot repair unexpected S4 domain: ${kind}:${id}`);
    }
    if (diskHash === null || diskHash !== entry.hashes.f || diskHash !== entry.hashes.d) {
      throw new Error(`Files changed during sync evaluation for ${kind}:${id}; reopen before loading`);
    }
    carrier[id] = diskHash;
  }

  writeFileAtomic(manifestPath, serializeMetadata(manifest as unknown as Record<string, unknown>));
  logger?.info?.('Repaired stale manifest entries before loading incoming data; database origin unchanged', {
    repaired_domains: stale.map(e => `${e.domain.kind}:${e.domain.id}`),
  });
}

// There is deliberately no `planLoadFor(workingDir)` helper here.
//
// An earlier draft had `persistor.load` call one whenever no plan was passed,
// so that "a direct caller behaves like the open path". That is the wrong
// default: a load with no plan is an explicit request to rebuild from the files
// — `performFreshLoad`, the CLI's `persistor load`, the renderer's "Load from
// ria-data" — and narrowing it makes the button do nothing precisely when the
// user pressed it to discard a database that had diverged without the files
// changing. The open path is the only caller with a basis for narrowing, and it
// evaluates the states itself and passes the plan. See the plan comment in
// `persistor-load.ts`.
