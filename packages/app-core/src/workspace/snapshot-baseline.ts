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
 * Snapshot baseline -- the record of WHAT CONTENT the in-memory database was
 * loaded from, and the drift check built on top of it.
 *
 * `ria-data/` is a per-branch artifact; `db` is a branch-agnostic cache at a
 * fixed path. Without a record of which snapshot the DB was built from, a store
 * cannot tell "the files on disk moved under me" (refuse) from "I have unsaved
 * changes" (write). The DB's own `content_hash` cannot serve as that record: the
 * instance service invalidates it on the first edit, precisely when the baseline
 * matters most.
 *
 * A module-level store keyed by resolved working directory rather than DI: the
 * auto-save coordinator calls `persistorFactory(wd).store(...)` directly,
 * bypassing the dispatcher, so a parameter a caller can forget would silently
 * lose the protection on the exact path the bug travels.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SNAPSHOT_DRIFT_CODE,
  type PendingSyncDecision,
  type SnapshotDriftInfo,
  type SnapshotSyncReason,
} from '@riacore/app-contracts';
import type { AppCoreLogger, IDbModule } from '../db/db-module.js';

/**
 * Namespace role for scratch namespaces that must never be persisted, and so
 * must not count as unsaved work. Mirrors the constant in
 * `persistor/auto-save-coordinator.ts`, which owns the same exclusion.
 */
const TEMP_NAMESPACE_ROLE = 'supervised_update_temp';

/** Identifies the content the in-memory DB was established from. */
export interface SnapshotBaseline {
  // ── The key: content identity. Present in every workspace, git or not. ─────
  /** `manifest.json` → `namespace_hashes` as of the stamp. */
  namespaceHashes: Record<string, string>;
  /** `manifest.json` → `universe_hashes` as of the stamp. */
  universeHashes: Record<string, string>;
  /**
   * `manifest.json` → `sourcemaster_hashes` as of the stamp. Compared, like the
   * namespace and universe maps: a branch switch that changed only import-source
   * configuration is a real content change, and before this layer was hashed the
   * next store overwrote the committed config with no warning.
   */
  sourcemasterHashes: Record<string, string>;
  /** Cross-namespace file hashes, including relation metadata independent of namespace content. */
  crossNamespaceHashes: Record<string, string>;
  /** `manifest.json` → `meta_hash` as of the stamp. Recorded, not gated — see `detectDrift`. */
  metaHash: string | null;

  // ── Descriptive metadata: why the content is what it is. Git only. ─────────
  /** Resolved git repository root, or null when the workspace is not in a repo. */
  repoDir: string | null;
  /** Branch name; null for a detached HEAD or outside a repository. */
  branch: string | null;
  /** HEAD commit id when the DB content was established. Null outside a repo. */
  headCommit: string | null;

  /**
   * When the workspace was opened.
   *
   * Carried forward across re-stamps, unlike `stampedAt`. A store re-stamps the
   * baseline on every save, so without a separate field the "opened at" moment
   * would be overwritten by the first auto-save and the UI could not tell the
   * user when the session began.
   */
  openedAt: string;

  /**
   * When the database and `ria-data/` were last known to agree — i.e. the moment
   * of the open, or of the most recent successful store or load.
   *
   * This is the timestamp that matters for the undo case: the database still
   * holds what was saved at `stampedAt`, while the files were replaced later.
   */
  stampedAt: string;

  /**
   * Which event produced `stampedAt`, recorded because it cannot be recovered
   * afterwards. Branch and commit drift can be re-derived at any time by
   * comparing the baseline against git; "was that a save or a load?" cannot be
   * derived from anything — only the caller knows, and only at the moment it
   * calls. Null when a caller did not say.
   */
  stampReason: SnapshotSyncReason | null;
}

/** Why a store was refused. Shaped to be safe to serialise across IPC. */
export interface SnapshotDriftDetails {
  /** Namespaces whose on-disk hash no longer matches the baseline. */
  changedNamespaces: string[];
  /** True when a universe-layer file hash no longer matches the baseline. */
  universeChanged: boolean;
  /**
   * True when a sourcemaster-layer file hash (the serialized import-source and
   * import-run records) no longer matches the baseline.
   */
  sourcemasterChanged: boolean;
  /** True when cross-namespace relation files changed, even if namespaces did not. */
  crossNamespaceChanged: boolean;
  /** Branch the DB content belongs to. Null outside a repository. */
  dbBranch: string | null;
  /** Branch checked out right now. Null outside a repository. */
  diskBranch: string | null;
  /** HEAD commit the DB content was loaded at. Null outside a repository. */
  dbCommit: string | null;
  /** HEAD commit checked out right now. Null outside a repository. */
  diskCommit: string | null;
  /**
   * The manifest is present but could not be parsed. The change lists are empty
   * because nothing could be compared — the refusal rests on the unreadability
   * itself, not on an observed difference.
   */
  manifestUnreadable: boolean;
  /**
   * Set when the last workspace open's per-domain evaluation ended in
   * `needs_decision`. A store is refused on this alone, with every change list
   * empty: the open-time evaluation found that this database did not come from
   * these files, which `detectDrift` cannot see because the baseline it compares
   * against was stamped from the very same files moments earlier.
   */
  pendingDecision: PendingSyncDecision | null;
}

/**
 * Thrown by `persistor.store` when `ria-data/` no longer matches the snapshot
 * the database was loaded from.
 *
 * Carries `kind: 'snapshot-drift'` so callers can recognise it without
 * `instanceof`, which does not survive the worker/IPC boundary.
 */
export class SnapshotDriftError extends Error {
  readonly kind = 'snapshot-drift' as const;
  readonly details: SnapshotDriftDetails;

  constructor(details: SnapshotDriftDetails, message: string) {
    super(message);
    this.name = 'SnapshotDriftError';
    this.details = details;
  }

  static is(err: unknown): err is SnapshotDriftError {
    return (
      typeof err === 'object' && err !== null &&
      (err as { kind?: unknown }).kind === 'snapshot-drift'
    );
  }
}

/** Hashes as recorded in an on-disk `manifest.json`. */
export interface ManifestHashes {
  namespaceHashes: Record<string, string>;
  universeHashes: Record<string, string>;
  /**
   * Empty for a manifest written before `sourcemaster_hashes` existed. Both
   * sides of the comparison default the same way, so an older manifest compares
   * equal rather than reporting phantom drift on the whole layer.
   */
  sourcemasterHashes: Record<string, string>;
  /** Cross-namespace file hashes, including relation metadata independent of namespace content. */
  crossNamespaceHashes: Record<string, string>;
  metaHash: string | null;
}

/**
 * The outcome of reading `manifest.json` for drift purposes.
 *
 * Three outcomes, not two: the previous `ManifestHashes | null` conflated "no
 * manifest" (a legitimate Case A state) with "a manifest that cannot be
 * parsed". Callers read the collapsed `null` as "no comparison possible" and
 * let the store proceed, which turned the write fence OFF at exactly the moment
 * the on-disk evidence was least trustworthy.
 *
 * **Rejected: a `manifest.json` self-hash field.** A hash stored inside the
 * manifest is exactly as unreadable as the rest of the manifest in the failure
 * case this classifier exists to fix — it could only be checked after a
 * successful parse, which is the case that already works. Do not re-propose it.
 */
export type ManifestHashesRead =
  | { kind: 'ok'; hashes: ManifestHashes }
  /** Legitimate: Case A, a brand-new workspace whose first store has not run. */
  | { kind: 'absent' }
  /** Present but not parseable: truncated, half-written, or corrupt. Never fail open. */
  | { kind: 'unreadable'; reason: string };

// ── Baseline store ───────────────────────────────────────────────────────────

const baselines = new Map<string, SnapshotBaseline>();

function keyFor(workingDir: string): string {
  return path.resolve(workingDir);
}

/**
 * Read the hashes out of `{workingDir}/ria-data/manifest.json`, classifying the
 * read rather than collapsing every failure into one value.
 *
 * `absent` is a legitimate state (Case A, a brand-new workspace whose first
 * store has not run). `unreadable` is not: a truncated, half-written or corrupt
 * manifest means the on-disk state cannot be characterised at all, and callers
 * must not treat that as "nothing changed".
 *
 * Cheap by construction: no file hashing. The manifest already carries the
 * hashes. The expensive integrity check that recomputes hashes FROM the files
 * (`computeNamespaceHashFromFiles`) stays where it belongs, in
 * `checkConsistency` at open time.
 */
export function readManifestHashes(workingDir: string): ManifestHashesRead {
  const manifestPath = path.join(workingDir, 'ria-data', 'manifest.json');

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    // ENOENT is the only outcome that means "there is no manifest". Anything
    // else (EACCES, EISDIR, EBUSY, an I/O error) means a manifest may well be
    // there and we simply cannot see it, which is the unreadable case.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', reason: `cannot read manifest.json: ${describeError(err)}` };
  }

  try {
    const manifest = JSON.parse(raw) as {
      namespace_hashes?: Record<string, string>;
      universe_hashes?: Record<string, string>;
      sourcemaster_hashes?: Record<string, string>;
      cross_namespace_hashes?: Record<string, string>;
      meta_hash?: string;
    } | null;
    // A JSON file whose top level is not an object carries no hashes and is not
    // a manifest, so reading its fields would silently yield empty maps.
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return { kind: 'unreadable', reason: 'manifest.json is not a JSON object' };
    }
    return {
      kind: 'ok',
      hashes: {
        namespaceHashes: manifest.namespace_hashes ?? {},
        universeHashes: manifest.universe_hashes ?? {},
        // Absent until the store writes it. Defaulting to `{}` on both the
        // baseline and the on-disk side is what keeps a pre-`sourcemaster_hashes`
        // manifest from reading as a whole-layer change.
        sourcemasterHashes: manifest.sourcemaster_hashes ?? {},
        crossNamespaceHashes: manifest.cross_namespace_hashes ?? {},
        metaHash: manifest.meta_hash ?? null,
      },
    };
  } catch (err) {
    return { kind: 'unreadable', reason: `manifest.json is not parseable: ${describeError(err)}` };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * When `ria-data/manifest.json` was last written, as an ISO string.
 *
 * Every well-formed rewrite of `ria-data/` updates the manifest, so its mtime is
 * when the files on disk last changed — whether that was a git checkout, a
 * restore, another tool, or our own store. One `stat`, no hashing.
 *
 * Null when it cannot be read; that only costs a label.
 */
export function readFilesChangedAt(workingDir: string): string | null {
  try {
    const stat = fs.statSync(path.join(workingDir, 'ria-data', 'manifest.json'));
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Record the current on-disk content as the baseline for `workingDir`.
 *
 * Call this at every point where DB content is established or synchronised with
 * `ria-data/`: Case A create, Case B load, Case D consistent / reload,
 * `performFreshLoad`, a `forceRecheck` open, and after every successful store.
 *
 * Deliberately NOT called on the already-open fast path in
 * `workspaceService.open()`. That path performs no data movement, so the
 * existing baseline is still the right one — and re-stamping there would defeat
 * the whole mechanism, because `persistor.store`'s implicit
 * `workspaceService.open({ workingDir })` takes exactly that path on every
 * save. Re-stamping would adopt the drifted content as the new baseline
 * microseconds before the check that is supposed to catch it.
 */
export function stampBaseline(
  workingDir: string,
  logger?: AppCoreLogger,
  opts?: {
    /**
     * What is being recorded. `'open'` and `'create'` start a new session clock;
     * every other reason carries the existing `openedAt` forward so a save
     * cannot erase when the session began.
     *
     * This replaced a bare `sessionStart: boolean`. The flag and the reason were
     * never independent — only an open or a create may restart the clock — so
     * two parameters meant two ways to describe one event and the possibility of
     * a caller setting them inconsistently. Deriving the clock from the reason
     * makes that unrepresentable, and the reason is needed anyway: the UI has no
     * other way to learn whether `stampedAt` was a save or a load.
     */
    reason?: SnapshotSyncReason;
  },
): SnapshotBaseline {
  const read = readManifestHashes(workingDir);
  const hashes = read.kind === 'ok' ? read.hashes : null;
  const repoDir = findRepoRoot(workingDir);
  const now = new Date().toISOString();
  const previous = baselines.get(keyFor(workingDir));
  const sessionStart = opts?.reason === 'open' || opts?.reason === 'create';
  const baseline: SnapshotBaseline = {
    namespaceHashes: hashes?.namespaceHashes ?? {},
    universeHashes: hashes?.universeHashes ?? {},
    // Must be read here, not left empty. `detectDrift` compares this map, so a
    // baseline that omitted it would hold `{}` against a populated on-disk map
    // and report sourcemaster drift on the very first check after every open.
    sourcemasterHashes: hashes?.sourcemasterHashes ?? {},
    crossNamespaceHashes: hashes?.crossNamespaceHashes ?? {},
    metaHash: hashes?.metaHash ?? null,
    repoDir,
    branch: repoDir ? readCurrentBranch(repoDir) : null,
    headCommit: repoDir ? readHeadCommit(repoDir) : null,
    openedAt: sessionStart ? now : previous?.openedAt ?? now,
    stampedAt: now,
    stampReason: opts?.reason ?? null,
  };
  baselines.set(keyFor(workingDir), baseline);
  if (read.kind === 'unreadable') {
    // Louder than the normal debug line: a baseline stamped from an unreadable
    // manifest holds empty hash maps, so it can compare against nothing. The
    // store fence catches the condition itself via `detectDrift`, but the only
    // record of WHY the baseline is empty is this line.
    logger?.warn?.('[baseline] stamped from an unreadable manifest — baseline has no hashes', {
      workingDir,
      reason: read.reason,
      stampReason: baseline.stampReason ?? '(unspecified)',
    });
  }
  logger?.debug?.('[baseline] stamped', {
    workingDir,
    namespaces: Object.keys(baseline.namespaceHashes).length,
    branch: baseline.branch,
    manifest: read.kind,
    reason: baseline.stampReason ?? '(unspecified)',
  });
  return baseline;
}

/** The recorded baseline for `workingDir`, or null when none has been stamped. */
export function getBaseline(workingDir: string): SnapshotBaseline | null {
  return baselines.get(keyFor(workingDir)) ?? null;
}

/** Forget the baseline for `workingDir`. Called on workspace close. */
export function clearBaseline(workingDir: string): void {
  baselines.delete(keyFor(workingDir));
  pendingDecisions.delete(keyFor(workingDir));
}

/** Forget every baseline. Test helper; not used in production code. */
export function clearAllBaselines(): void {
  baselines.clear();
  pendingDecisions.clear();
}

// ── Pending sync decision ────────────────────────────────────────────────────
//
// Held beside the baseline, and for the same reason: `persistor.store` is
// reached from the auto-save coordinator without going through the dispatcher,
// so a parameter a caller can forget would lose the protection on exactly the
// path the bug travels.
//
// The open path writes it (null when nothing is pending). A successful explicit
// full Store resolves it, and `clearBaseline` drops it on close.

const pendingDecisions = new Map<string, PendingSyncDecision>();

/**
 * Record — or clear, with null — the domains the last open could not resolve.
 * Set by the workspace open path; also cleared after an explicit full Store.
 */
export function setPendingSyncDecision(
  workingDir: string,
  decision: PendingSyncDecision | null,
): void {
  const key = keyFor(workingDir);
  if (decision === null || decision.domains.length === 0) pendingDecisions.delete(key);
  else pendingDecisions.set(key, decision);
}

/** The outstanding decision for `workingDir`, or null. */
export function getPendingSyncDecision(workingDir: string): PendingSyncDecision | null {
  return pendingDecisions.get(keyFor(workingDir)) ?? null;
}

// ── Drift detection ──────────────────────────────────────────────────────────

/**
 * Compare the on-disk `manifest.json` against the recorded baseline. Returns
 * null when there is no drift, or when no comparison is possible.
 *
 * Fail-closed when the manifest is present but unreadable: that is positive
 * evidence the on-disk state cannot be characterised, so the result is drift
 * with `manifestUnreadable` and empty change lists. An ABSENT manifest returns
 * null, since there is nothing on disk to overwrite.
 *
 * Fail-open when there is no baseline: a directly constructed persistor never
 * went through `workspaceService.open()`, and without a baseline there is no
 * evidence of drift either way.
 *
 * Compares namespace, universe, sourcemaster and cross-namespace hashes. `metaHash` is recorded
 * but deliberately not compared -- the application rewrites `meta/` at open, so
 * the fence would otherwise refuse saves for its own change. That difference is
 * caught at open as `db_stale` instead.
 */
export function detectDrift(workingDir: string): SnapshotDriftDetails | null {
  const baseline = getBaseline(workingDir);
  if (!baseline) return null;

  const read = readManifestHashes(workingDir);
  // No manifest on disk: nothing to compare against, and nothing to overwrite.
  // A brand-new workspace whose first store has not run yet lands here.
  if (read.kind === 'absent') return null;
  if (read.kind === 'unreadable') {
    // Drift with no named changes. The change lists are empty because nothing
    // could be compared, not because nothing changed — `describeDrift` and the
    // dialog read `manifestUnreadable` to tell those two apart.
    return {
      changedNamespaces: [],
      universeChanged: false,
      sourcemasterChanged: false,
      crossNamespaceChanged: false,
      dbBranch: baseline.branch,
      diskBranch: baseline.repoDir ? readCurrentBranch(baseline.repoDir) : null,
      dbCommit: baseline.headCommit,
      diskCommit: baseline.repoDir ? readHeadCommit(baseline.repoDir) : null,
      manifestUnreadable: true,
      pendingDecision: getPendingSyncDecision(workingDir),
    };
  }
  const onDisk = read.hashes;

  const changedNamespaces: string[] = [];
  // Union of both sides, so an externally ADDED or REMOVED namespace entry
  // counts as drift just as a changed hash does.
  const namespaces = new Set([
    ...Object.keys(baseline.namespaceHashes),
    ...Object.keys(onDisk.namespaceHashes),
  ]);
  for (const ns of namespaces) {
    if (baseline.namespaceHashes[ns] !== onDisk.namespaceHashes[ns]) {
      changedNamespaces.push(ns);
    }
  }
  changedNamespaces.sort();

  let universeChanged = false;
  const universeFiles = new Set([
    ...Object.keys(baseline.universeHashes),
    ...Object.keys(onDisk.universeHashes),
  ]);
  for (const file of universeFiles) {
    if (baseline.universeHashes[file] !== onDisk.universeHashes[file]) {
      universeChanged = true;
      break;
    }
  }

  // Same union-of-both-sides shape as the two maps above, so a sourcemaster file
  // added or removed on disk counts as drift and not only a changed hash. Both
  // maps default to `{}` when the manifest predates the carrier, so an older
  // manifest compares equal here rather than reporting the layer as changed.
  let sourcemasterChanged = false;
  const sourcemasterFiles = new Set([
    ...Object.keys(baseline.sourcemasterHashes),
    ...Object.keys(onDisk.sourcemasterHashes),
  ]);
  for (const file of sourcemasterFiles) {
    if (baseline.sourcemasterHashes[file] !== onDisk.sourcemasterHashes[file]) {
      sourcemasterChanged = true;
      break;
    }
  }

  // Cross-namespace metadata can change without changing any namespace hash.
  // Compare both key sets to protect additions and removals as well as edits.
  const crossNamespaceFiles = new Set([
    ...Object.keys(baseline.crossNamespaceHashes),
    ...Object.keys(onDisk.crossNamespaceHashes),
  ]);
  const crossNamespaceChanged = [...crossNamespaceFiles].some(
    file => baseline.crossNamespaceHashes[file] !== onDisk.crossNamespaceHashes[file],
  );

  if (changedNamespaces.length === 0 && !universeChanged && !sourcemasterChanged && !crossNamespaceChanged) return null;

  return {
    changedNamespaces,
    universeChanged,
    sourcemasterChanged,
    crossNamespaceChanged,
    dbBranch: baseline.branch,
    diskBranch: baseline.repoDir ? readCurrentBranch(baseline.repoDir) : null,
    dbCommit: baseline.headCommit,
    diskCommit: baseline.repoDir ? readHeadCommit(baseline.repoDir) : null,
    manifestUnreadable: false,
    pendingDecision: getPendingSyncDecision(workingDir),
  };
}

/**
 * Human-readable refusal message. The git fields make it actionable when
 * available and are simply absent outside a repository, where the message falls
 * back to naming what changed. The DECISION never depends on them.
 */
export function describeDrift(details: SnapshotDriftDetails): string {
  const {
    changedNamespaces,
    universeChanged,
    sourcemasterChanged,
    crossNamespaceChanged,
    manifestUnreadable,
    pendingDecision,
    dbBranch,
    diskBranch,
  } = details;

  if (
    pendingDecision &&
    changedNamespaces.length === 0 && !universeChanged && !sourcemasterChanged && !crossNamespaceChanged && !manifestUnreadable
  ) {
    // The decision-only refusal. Its own message because the ordinary one says
    // "the files have changed since this database was loaded", which is not what
    // happened: the files were already in this state when the workspace opened,
    // and the open-time evaluation is what established that this database did
    // not come from them. Saying "since loaded" would send the user looking for
    // a change they did not make.
    const listed = pendingDecision.domains
      .slice(0, 6)
      .map((d) => `${d.kind}:${d.id} (${d.state})`)
      .join(', ');
    const more = pendingDecision.domains.length > 6
      ? ` (+${pendingDecision.domains.length - 6} more)` : '';
    return (
      `Refusing to save: opening this workspace found that the database did not come from the ` +
      `files currently in ria-data/, and the difference is not one the app may resolve on its own. ` +
      `${pendingDecision.reason === 'three_way'
        ? 'manifest.json, the files and the database all disagree.'
        : pendingDecision.reason === 'manifest_unusable'
          ? 'ria-data/manifest.json cannot be read, so nothing can be compared.'
          : 'the files were changed without manifest.json being updated.'} ` +
      `Affected: ${listed}${more}. ` +
      `Choose "Load from ria-data" to adopt what is on disk, or "Store to ria-data" to ` +
      `deliberately write this session's content over it. ` +
      `See Help / Data Management.`
    );
  }

  if (manifestUnreadable) {
    // A separate message, not the ordinary one with a clause bolted on. The
    // ordinary text says "the files in ria-data/ have changed", which is not
    // what happened and is not even known here, and it offers two recoveries
    // that cannot work: Load and `repairManifest` both parse the same
    // manifest.json and throw on it. Naming them would send the user through
    // two failures before reaching the one action that does work.
    return (
      `Refusing to save: ria-data/manifest.json is present but cannot be read, so there is no ` +
      `way to tell whether the files on disk still match this database.${
        dbBranch && diskBranch && dbBranch !== diskBranch
          ? ` The database holds content from branch '${dbBranch}', but '${diskBranch}' is ` +
            `checked out now.`
          : ''
      } ` +
      `The only recovery is to store with "allowSnapshotMismatch", which rewrites manifest.json ` +
      `wholesale from this database — do that once you are satisfied this session's content is ` +
      `what you want on disk. Loading from ria-data and repairing the manifest both read the ` +
      `same unreadable file and will fail. ` +
      `See Help / Data Management.`
    );
  }

  const what: string[] = [];
  if (changedNamespaces.length > 0) {
    const shown = changedNamespaces.slice(0, 5).join(', ');
    const more = changedNamespaces.length > 5 ? ` (+${changedNamespaces.length - 5} more)` : '';
    what.push(`namespace(s): ${shown}${more}`);
  }
  if (universeChanged) what.push('universe layer (connections / layout / views)');
  if (sourcemasterChanged) what.push('import source configuration');
  if (crossNamespaceChanged) what.push('cross-namespace relations');

  const because =
    dbBranch && diskBranch && dbBranch !== diskBranch
      ? ` The database holds content from branch '${dbBranch}', but '${diskBranch}' is checked out now.`
      : '';

  return (
    `Refusing to save: the files in ria-data/ have changed since this database was loaded, ` +
    `so saving would overwrite content the database did not come from.${because} ` +
    `Changed ${what.join(' and ')}. ` +
    `Choose "Load from ria-data" to adopt what is on disk, or "Store to ria-data" to ` +
    `deliberately write this session's content to the current state. ` +
    `See Help / Data Management.`
  );
}

/**
 * Throw a `SnapshotDriftError` when `ria-data/` no longer matches the baseline,
 * or when its `manifest.json` is present but cannot be parsed.
 *
 * Must be called BEFORE any file is written, and inside the per-workspace store
 * serialisation chain so that the check and the write are atomic with respect to
 * other stores for the same workspace.
 */
export function assertNoSnapshotDrift(
  workingDir: string,
  allowSnapshotMismatch: boolean | undefined,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const fileDrift = detectDrift(workingDir);
  // A pending decision refuses on its own, with no file drift to point at.
  //
  // Without this the dispatcher's auto-save resolves an S3 in the files'
  // disfavour roughly 150 ms after the user's next keystroke: the open path
  // decided not to load and not to store, and the very next save would store
  // anyway and overwrite the committed content the decision exists to protect.
  //
  // `detectDrift` cannot see it. It compares the session baseline against the
  // manifest on disk, and at open those are equal by construction — which is
  // why it reported `none` in all twelve measured matrix rows, including every
  // damaging one.
  const pendingDecision = getPendingSyncDecision(workingDir);
  const details: SnapshotDriftDetails | null = fileDrift ?? (pendingDecision
    ? {
      changedNamespaces: [],
      universeChanged: false,
      sourcemasterChanged: false,
      crossNamespaceChanged: false,
      dbBranch: getBaseline(workingDir)?.branch ?? null,
      diskBranch: null,
      dbCommit: getBaseline(workingDir)?.headCommit ?? null,
      diskCommit: null,
      manifestUnreadable: false,
      pendingDecision,
    }
    : null);
  if (!details) return;

  if (allowSnapshotMismatch) {
    // Honouring the override on the `manifestUnreadable` path is deliberate, not
    // a hole in the fence. It is the ONE working recovery from an unreadable
    // manifest: `storeImpl` already treats one as `forceFullReExport` and
    // rewrites `manifest.json` wholesale from the database. Load and
    // `repairManifest` both parse the same manifest and throw, so refusing here
    // too would leave the workspace with no way out. The fence closes the
    // SILENT overwrite; the user's explicit, informed overwrite stays available.
    logger?.warn(
      details.manifestUnreadable
        ? `[drift] proceeding despite an unreadable ria-data/manifest.json ` +
          `(allowSnapshotMismatch) — the manifest will be rewritten from the database`
        : details.pendingDecision && details.changedNamespaces.length === 0
          ? `[drift] proceeding despite an unresolved sync decision (allowSnapshotMismatch) — ` +
            `overwriting: ${details.pendingDecision.domains
              .map((d) => `${d.kind}:${d.id}`).join(', ') || '(none)'}`
        : `[drift] proceeding despite snapshot drift (allowSnapshotMismatch) — ` +
          `changed namespaces: ${details.changedNamespaces.join(', ') || '(none)'}` +
          `${details.universeChanged ? ', universe layer' : ''}` +
          `${details.sourcemasterChanged ? ', import source configuration' : ''}` +
          `${details.crossNamespaceChanged ? ', cross-namespace relations' : ''}`,
    );
    return;
  }

  const message = describeDrift(details);
  logger?.warn(`[drift] ${message}`);
  // The code prefix is the only thing that survives Electron's IPC error
  // flattening, so the renderer can tell "user must decide" from "the save
  // broke". It strips the prefix before showing anything, and composes its own
  // text from SnapshotDriftInfo rather than from this message.
  throw new SnapshotDriftError(details, `${SNAPSHOT_DRIFT_CODE}: ${message}`);
}

/**
 * Namespaces whose DB content has not been written to `ria-data/` yet.
 *
 * The instance service blanks `content_hash` on every create / update / delete,
 * so an empty hash is the marker for unsaved work. Scratch namespaces used by
 * supervised update are excluded — they are never persisted, so they are not
 * work the user can lose.
 */
export async function readDirtyNamespaces(dbModule: IDbModule): Promise<string[]> {
  try {
    const rows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace)
       WHERE ns.content_hash = '' AND ns.namespace_role <> $tempRole
       RETURN ns.name AS name
       ORDER BY name`,
      { tempRole: TEMP_NAMESPACE_ROLE },
    );
    return rows.map((row) => String(row.name ?? '')).filter((name) => name !== '');
  } catch {
    // A drift report must never fail because the DB could not be queried; an
    // empty list only makes the warning less specific.
    return [];
  }
}

/**
 * Build the full drift report for `workspace.getSnapshotDrift`.
 *
 * `dirtyNamespaces` is only queried when there IS drift — when nothing changed
 * on disk there is no decision to take, so the extra DB round trip would be
 * pure cost on a query that polls every few seconds.
 */
export async function buildSnapshotDriftInfo(
  workingDir: string,
  dbModule: IDbModule,
): Promise<SnapshotDriftInfo> {
  const baseline = getBaseline(workingDir);
  const details = detectDrift(workingDir);
  const pendingDecision = getPendingSyncDecision(workingDir);
  // A pending decision counts as drifted even with no file drift, so the dialog
  // is raised: both questions end in the same user choice, and the one the user
  // has to answer here is the open-time one.
  if (!details && !pendingDecision) {
    return {
      drifted: false,
      changedNamespaces: [],
      universeChanged: false,
      sourcemasterChanged: false,
      crossNamespaceChanged: false,
      manifestUnreadable: false,
      pendingDecision: null,
      dirtyNamespaces: [],
      dbBranch: baseline?.branch ?? null,
      diskBranch: baseline?.repoDir ? readCurrentBranch(baseline.repoDir) : null,
      dbCommit: baseline?.headCommit ?? null,
      diskCommit: baseline?.repoDir ? readHeadCommit(baseline.repoDir) : null,
      openedAt: baseline?.openedAt ?? null,
      syncedAt: baseline?.stampedAt ?? null,
      syncedReason: baseline?.stampReason ?? null,
      filesChangedAt: readFilesChangedAt(workingDir),
    };
  }
  return {
    drifted: true,
    changedNamespaces: details?.changedNamespaces ?? [],
    universeChanged: details?.universeChanged ?? false,
    sourcemasterChanged: details?.sourcemasterChanged ?? false,
    crossNamespaceChanged: details?.crossNamespaceChanged ?? false,
    manifestUnreadable: details?.manifestUnreadable ?? false,
    pendingDecision,
    dirtyNamespaces: await readDirtyNamespaces(dbModule),
    dbBranch: details?.dbBranch ?? baseline?.branch ?? null,
    diskBranch: details?.diskBranch ?? (baseline?.repoDir ? readCurrentBranch(baseline.repoDir) : null),
    dbCommit: details?.dbCommit ?? baseline?.headCommit ?? null,
    diskCommit: details?.diskCommit ?? (baseline?.repoDir ? readHeadCommit(baseline.repoDir) : null),
    // The three moments that make the undo case legible: when the session began,
    // when the database last agreed with the files, and when the files changed
    // underneath it. In that case git identity is identical on both sides, so
    // time is the ONLY thing that distinguishes them.
    openedAt: baseline?.openedAt ?? null,
    syncedAt: baseline?.stampedAt ?? null,
    syncedReason: baseline?.stampReason ?? null,
    filesChangedAt: readFilesChangedAt(workingDir),
  };
}

// ── Git facts (message only, never the decision) ─────────────────────────────

/**
 * Walk up from `startDir` looking for `.git`. Handles `.git` being a FILE
 * (worktrees and submodules point at the real git dir via a `gitdir:` line),
 * because the nested-workspace layout in RiaGit.md means the workspace is
 * frequently not the repository root.
 *
 * Returns the directory CONTAINING `.git`, or null when there is none.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // Bounded walk: stop at the filesystem root.
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the real git directory for `repoDir`, following the `gitdir:` pointer
 * when `.git` is a file rather than a directory.
 */
function resolveGitDir(repoDir: string): string | null {
  const dotGit = path.join(repoDir, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    const contents = fs.readFileSync(dotGit, 'utf-8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(contents);
    if (!match) return null;
    const pointer = match[1].trim();
    return path.isAbsolute(pointer) ? pointer : path.resolve(repoDir, pointer);
  } catch {
    return null;
  }
}

/**
 * Current branch name by reading `HEAD` directly — no subprocess, no
 * dependency on the git service, so this is safe to call from the persistor.
 *
 * Returns null for a detached HEAD (bisect, a checked-out tag, a raw commit) and
 * when HEAD cannot be read. Null only degrades the message.
 */
export function readCurrentBranch(repoDir: string): string | null {
  const gitDir = resolveGitDir(repoDir);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Directories to search for refs: the git dir itself, then the *common* dir.
 *
 * A linked worktree's git dir (`.git/worktrees/<name>`) holds its own `HEAD` but
 * shares `refs/` and `packed-refs` with the main repository, located via the
 * `commondir` file. Without this, resolving a branch to a commit works in a
 * normal clone and silently returns null in a worktree.
 */
function gitRefSearchPath(gitDir: string): string[] {
  const dirs = [gitDir];
  try {
    const commonDirFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      const rel = fs.readFileSync(commonDirFile, 'utf-8').trim();
      if (rel) dirs.push(path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel));
    }
  } catch {
    // Ignore: the git dir alone is a correct, if incomplete, search path.
  }
  return dirs;
}

/**
 * The commit id HEAD currently points at, read from the filesystem — no
 * subprocess, so this stays callable from the persistor.
 *
 * Handles a detached HEAD (already a raw id), a loose ref under `refs/heads/`,
 * and a ref that has been packed into `packed-refs` (which is the normal state
 * after `git gc`, so skipping it would make the commit disappear from the UI on
 * older branches).
 *
 * Returns null when it cannot be determined; that only costs a label.
 */
export function readHeadCommit(repoDir: string): string | null {
  const gitDir = resolveGitDir(repoDir);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    if (!refMatch) {
      // Detached HEAD holds the object id directly.
      return /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
    }
    const ref = refMatch[1].trim();

    for (const dir of gitRefSearchPath(gitDir)) {
      const loosePath = path.join(dir, ref);
      if (fs.existsSync(loosePath)) {
        const sha = fs.readFileSync(loosePath, 'utf-8').trim();
        if (sha) return sha;
      }

      const packedPath = path.join(dir, 'packed-refs');
      if (fs.existsSync(packedPath)) {
        const packed = fs.readFileSync(packedPath, 'utf-8');
        for (const line of packed.split('\n')) {
          const trimmed = line.trim();
          // '#' is the header, '^' lines are peeled tag targets.
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
          const [sha, name] = trimmed.split(/\s+/);
          if (name === ref && sha) return sha;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
