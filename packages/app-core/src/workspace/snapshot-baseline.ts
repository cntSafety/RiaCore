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
 * Snapshot baseline — the record of WHAT CONTENT the in-memory database was
 * loaded from, and the drift check built on top of it.
 *
 * See docs/coreSpecs/RiaDataChangeDetection.md (Steps 1 and 2).
 *
 * ## Why this exists
 *
 * `ria-data/` is a per-branch artifact; `db` is a branch-agnostic cache at a
 * fixed path. Without a record of which snapshot the DB was built from, a
 * `persistor.store` cannot tell these two situations apart:
 *
 *   1. "The files on disk moved under me"  → must refuse (git checkout, pull,
 *      reset, stash pop, a restore from backup, a concurrent CLI store).
 *   2. "I have unsaved changes"            → must write (the normal save path).
 *
 * The DB's own `content_hash` cannot serve as that record, because the instance
 * service deliberately invalidates it (`content_hash = ''`) the moment the user
 * edits anything — precisely when the baseline is needed most. Hence a separate,
 * explicitly stamped baseline.
 *
 * ## Why a module-level store rather than DI
 *
 * The writer is `workspace-service.ts` and the reader is `persistor-store.ts`.
 * Routing the baseline through constructor injection would mean threading it
 * through `persistorFactory` at six call sites (worker, web-dev-server, CLI
 * `_shared`, three CLI commands) and would still leave the hole that matters:
 * the auto-save coordinator calls `persistorFactory(wd).store(...)` DIRECTLY,
 * bypassing the command dispatcher. A caller that forgets to pass the baseline
 * silently loses the protection, and auto-save is the exact path the reported
 * bug travels. A module-level store keyed by working directory cannot be
 * bypassed by forgetting a parameter.
 *
 * Keyed by resolved working directory so parallel tests on separate temp
 * directories cannot collide.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SNAPSHOT_DRIFT_CODE,
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
  /** Branch the DB content belongs to. Null outside a repository. */
  dbBranch: string | null;
  /** Branch checked out right now. Null outside a repository. */
  diskBranch: string | null;
  /** HEAD commit the DB content was loaded at. Null outside a repository. */
  dbCommit: string | null;
  /** HEAD commit checked out right now. Null outside a repository. */
  diskCommit: string | null;
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
  metaHash: string | null;
}

// ── Baseline store ───────────────────────────────────────────────────────────

const baselines = new Map<string, SnapshotBaseline>();

function keyFor(workingDir: string): string {
  return path.resolve(workingDir);
}

/**
 * Read the hashes out of `{workingDir}/ria-data/manifest.json`.
 *
 * Returns null when there is no manifest or it is unreadable — which is a
 * legitimate state (Case A, a brand-new workspace), not an error.
 *
 * Cheap by construction: no file hashing. The manifest already carries the
 * hashes. The expensive integrity check that recomputes hashes FROM the files
 * (`computeNamespaceHashFromFiles`) stays where it belongs, in
 * `checkConsistency` at open time.
 */
export function readManifestHashes(workingDir: string): ManifestHashes | null {
  const manifestPath = path.join(workingDir, 'ria-data', 'manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as {
      namespace_hashes?: Record<string, string>;
      universe_hashes?: Record<string, string>;
      meta_hash?: string;
    };
    return {
      namespaceHashes: manifest.namespace_hashes ?? {},
      universeHashes: manifest.universe_hashes ?? {},
      metaHash: manifest.meta_hash ?? null,
    };
  } catch {
    // Missing, partially written, or corrupt. Callers treat null as
    // "no comparison possible", never as drift.
    return null;
  }
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
  const hashes = readManifestHashes(workingDir);
  const repoDir = findRepoRoot(workingDir);
  const now = new Date().toISOString();
  const previous = baselines.get(keyFor(workingDir));
  const sessionStart = opts?.reason === 'open' || opts?.reason === 'create';
  const baseline: SnapshotBaseline = {
    namespaceHashes: hashes?.namespaceHashes ?? {},
    universeHashes: hashes?.universeHashes ?? {},
    metaHash: hashes?.metaHash ?? null,
    repoDir,
    branch: repoDir ? readCurrentBranch(repoDir) : null,
    headCommit: repoDir ? readHeadCommit(repoDir) : null,
    openedAt: sessionStart ? now : previous?.openedAt ?? now,
    stampedAt: now,
    stampReason: opts?.reason ?? null,
  };
  baselines.set(keyFor(workingDir), baseline);
  logger?.debug?.('[baseline] stamped', {
    workingDir,
    namespaces: Object.keys(baseline.namespaceHashes).length,
    branch: baseline.branch,
    hadManifest: hashes !== null,
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
}

/** Forget every baseline. Test helper; not used in production code. */
export function clearAllBaselines(): void {
  baselines.clear();
}

// ── Drift detection ──────────────────────────────────────────────────────────

/**
 * Compare the on-disk `manifest.json` against the recorded baseline.
 *
 * Returns null when there is no drift, or when no comparison is possible.
 *
 * **Fail-open when there is no baseline.** A persistor constructed directly —
 * which several CLI commands and tests do — has never been through
 * `workspaceService.open()`, so nothing stamped a baseline. Refusing those
 * stores would break existing callers for no safety gain, because without a
 * baseline there is no evidence of drift either way. Every path that opens a
 * workspace through the workspace service stamps one, so in the running
 * application a baseline is always present.
 *
 * **What is compared:** namespace hashes and universe hashes. `metaHash` is
 * recorded on the baseline but deliberately not gated on in this first version:
 * `writeDefaultChecks` runs on every open and the meta layer is rewritten by
 * several open-time repair paths, so gating on it risks false refusals. The
 * trade is that an external change touching ONLY the meta layer is not caught
 * here; it is still caught by `checkConsistency` at the next open.
 */
export function detectDrift(workingDir: string): SnapshotDriftDetails | null {
  const baseline = getBaseline(workingDir);
  if (!baseline) return null;

  const onDisk = readManifestHashes(workingDir);
  // No manifest on disk: nothing to compare against. A brand-new workspace
  // whose first store has not run yet lands here.
  if (!onDisk) return null;

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

  if (changedNamespaces.length === 0 && !universeChanged) return null;

  return {
    changedNamespaces,
    universeChanged,
    dbBranch: baseline.branch,
    diskBranch: baseline.repoDir ? readCurrentBranch(baseline.repoDir) : null,
    dbCommit: baseline.headCommit,
    diskCommit: baseline.repoDir ? readHeadCommit(baseline.repoDir) : null,
  };
}

/**
 * Human-readable refusal message. The git fields make it actionable when
 * available and are simply absent outside a repository, where the message falls
 * back to naming what changed. The DECISION never depends on them.
 */
export function describeDrift(details: SnapshotDriftDetails): string {
  const { changedNamespaces, universeChanged, dbBranch, diskBranch } = details;

  const what: string[] = [];
  if (changedNamespaces.length > 0) {
    const shown = changedNamespaces.slice(0, 5).join(', ');
    const more = changedNamespaces.length > 5 ? ` (+${changedNamespaces.length - 5} more)` : '';
    what.push(`namespace(s): ${shown}${more}`);
  }
  if (universeChanged) what.push('universe layer (connections / layout / views)');

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
 * Throw a `SnapshotDriftError` when `ria-data/` no longer matches the baseline.
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
  const details = detectDrift(workingDir);
  if (!details) return;

  if (allowSnapshotMismatch) {
    logger?.warn(
      `[drift] proceeding despite snapshot drift (allowSnapshotMismatch) — ` +
      `changed namespaces: ${details.changedNamespaces.join(', ') || '(none)'}` +
      `${details.universeChanged ? ', universe layer' : ''}`,
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
  if (!details) {
    return {
      drifted: false,
      changedNamespaces: [],
      universeChanged: false,
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
    changedNamespaces: details.changedNamespaces,
    universeChanged: details.universeChanged,
    dirtyNamespaces: await readDirtyNamespaces(dbModule),
    dbBranch: details.dbBranch,
    diskBranch: details.diskBranch,
    dbCommit: details.dbCommit,
    diskCommit: details.diskCommit,
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
