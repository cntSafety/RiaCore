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
import { z } from 'zod';
import { DbStatus } from './db.js';

export const WorkspaceConfigSchema = z.object({
  workingDir: z.string().min(1, 'Working directory path is required'),
  forceRecheck: z.boolean().optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export type LifecycleAction =
  | 'created'
  | 'opened_consistent'
  | 'loading_from_ria_data'
  | 'opened_loaded_from_ria_data'
  | 'opened_saved_to_ria_data'
  | 'opened_db_only'
  /**
   * `ria-data/manifest.json` is missing or unparseable WHILE other `ria-data/`
   * content is present.
   *
   * Its own action rather than a variety of drift, because the recoveries are
   * inverted: there is no M to compare and no F to compute, so the database is
   * the sole authority, and both of the ordinary remedies read the same
   * unreadable file — a load because the manifest *is* the index of what to
   * load, and `repairManifest` because it begins by parsing it. The workspace
   * opens and stays writable so the user can save from the database or restore
   * the file from version control; the existing drift fence refuses saves until
   * one of those happens.
   *
   * Previously this state was indistinguishable from "no snapshot yet" and
   * therefore stored from the database over content a colleague had committed
   * (row 10 of `qualification/persistor-state-matrix`).
   */
  | 'opened_manifest_unusable'
  | 'load_failed';

/*
 * There is deliberately no action for "schema version out of range". A snapshot
 * whose `schema_version` this build must not read causes `workspace.open` to FAIL
 * (`ok: false`, with the explanation on `error`) rather than to open in a
 * degraded state — so there is no opened workspace for an action to describe.
 * See `app-core/src/db/schema-compat.ts` for the policy and the reasoning.
 */

export interface WorkspaceInfo {
  workingDir: string;
  dbPath: string;
  dbStatus: DbStatus;
  lifecycleAction: LifecycleAction;
  lifecycleWarning?: string;
}

export type WorkspaceStatus =
  | { state: 'closed' }
  | { state: 'open'; info: WorkspaceInfo };

// ── Ria-Data change detection ────────────────────────────────────────────────

/**
 * Stable marker embedded in the `persistor.store` refusal message.
 *
 * Electron's `ipcRenderer.invoke` rejects with a plain Error whose message is a
 * flattened string, so neither `instanceof` nor a custom `kind` property
 * survives the boundary. The renderer matches on this token to tell "the user
 * must decide" apart from "the save genuinely failed", then strips it before
 * showing anything. UI text is composed from `SnapshotDriftInfo` instead of
 * from the message.
 */
export const SNAPSHOT_DRIFT_CODE = 'RIA_SNAPSHOT_DRIFT';

/** True when an error (or its message) is a snapshot-drift refusal. */
export function isSnapshotDriftError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.includes(SNAPSHOT_DRIFT_CODE);
}

/**
 * What last brought the database and `ria-data/` into agreement.
 *
 * A timestamp alone cannot be rendered honestly. `syncedAt` is stamped by five
 * different events, and they do not move content the same way: a store writes
 * the database out to the files, a load rebuilds the database from them, and a
 * manifest repair moves no content at all. A UI given only the moment has to
 * guess a verb, and every guess is wrong four times out of five.
 *
 *   'open'   | 'create'  the session began; no content crossed
 *   'store'  database → files (a save)
 *   'load'   files → database
 *   'repair' neither; `manifest.json` was recomputed from the files on disk
 */
export type SnapshotSyncReason = 'open' | 'create' | 'store' | 'load' | 'repair';

// ── Open-time per-domain sync evaluation ─────────────────────────────────────

/** The five states of `docs/coreSpecs/persistorStates.md`. */
export type SyncStateName = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

/** The kinds of domain the five-state rule is applied to. */
export type SyncDomainKindName =
  | 'manifest'
  | 'namespace'
  | 'sourcemaster'
  | 'universe'
  | 'cross_namespace'
  | 'meta';

/** Why a domain could not be resolved without a person. */
export type SyncDecisionReason = 'files_edited' | 'three_way' | 'manifest_unusable';

/**
 * Domains the last workspace open could not resolve automatically.
 *
 * Rides the existing drift report rather than a new channel because the two
 * answer different questions that end in the same user choice: `detectDrift`
 * asks "did the files move *during this session*?" and reports nothing at open
 * by construction, while the open-time evaluation asks "did this database come
 * from these files?". One report, one dialog, one decision.
 */
export interface PendingSyncDecision {
  reason: SyncDecisionReason;
  /** Each domain awaiting a decision, with the state that put it there. */
  domains: { kind: SyncDomainKindName; id: string; state: SyncStateName }[];
}

/** One domain's three hashes and the state they classify to. */
export interface SyncDomainReport {
  kind: SyncDomainKindName;
  /** Namespace name, or the ria-data-relative file path. `(meta)` for meta. */
  id: string;
  /** Recorded in the manifest. Null for the manifest domain, which has no M. */
  m: string | null;
  /** Computed from the files now. Null when the files could not be read. */
  f: string | null;
  /** The file version the database was synced from. Null when unrecorded. */
  d: string | null;
  state: SyncStateName;
}

/** Output of `workspace.getSyncReport`. */
export interface SyncReport {
  domains: SyncDomainReport[];
  /** The resolved action: what the system would do about this evaluation now. */
  action: 'consistent' | 'load' | 'repair_manifest' | 'needs_decision' | 'manifest_unusable';
  /** Present when `action` is `needs_decision`. */
  decision: PendingSyncDecision | null;
  /** True when the epoch differed and every comparison was suspended. */
  epochSuspended: boolean;
  /** True when the manifest digest matched its origin row and D reads were skipped. */
  shortCircuited: boolean;
  /** What a load would clear and re-import. Null when no load is called for. */
  plan: {
    meta: boolean;
    sourcemaster: boolean;
    universe: boolean;
    crossNamespace: boolean;
    namespaces: string[];
  } | null;
}

/**
 * Whether `ria-data/` still matches the snapshot the database was loaded from.
 *
 * Output of `workspace.getSnapshotDrift`. Everything the drift dialog needs to
 * explain the situation and let the user choose, without parsing an error
 * string.
 */
export interface SnapshotDriftInfo {
  /** True when any on-disk hash differs from the recorded baseline. */
  drifted: boolean;
  /** Namespaces whose on-disk hash no longer matches the baseline. */
  changedNamespaces: string[];
  /** True when a universe-layer file (connections / layout / views) changed. */
  universeChanged: boolean;
  /**
   * True when a sourcemaster-layer file changed — the serialized import-source
   * and import-run records. A branch switch that touched only import
   * configuration lands here with every other list empty, so a consumer that
   * renders only `changedNamespaces` and `universeChanged` would show a drift
   * warning naming nothing at all.
   */
  sourcemasterChanged: boolean;
  /** True when cross-namespace relation files changed independently of namespace content. */
  crossNamespaceChanged: boolean;
  /**
   * True when `ria-data/manifest.json` is present but could not be parsed.
   *
   * This is not "something changed" — it is "nothing could be compared", so
   * every change list is empty and no namespace is named. It also inverts the
   * available recoveries: Load and manifest repair both read the same
   * unparseable file and fail, leaving Store with `allowSnapshotMismatch` (which
   * rewrites the manifest from the database) as the only one that works. A
   * consumer offering the ordinary three-way choice here sends the user into two
   * dead ends first.
   */
  manifestUnreadable: boolean;
  /**
   * Set when the last workspace open's per-domain evaluation ended in
   * `needs_decision`; null otherwise.
   *
   * Independent of `drifted`: drift is "the files moved since this session
   * started", a pending decision is "this database did not come from these
   * files". The second is true at open, when the first is false by
   * construction — which is why every damaging row of the measured state matrix
   * reported no drift at all.
   */
  pendingDecision: PendingSyncDecision | null;
  /**
   * Namespaces holding DB content not yet written to `ria-data/`
   * (`content_hash = ''`). Non-empty means neither resolution is lossless:
   * Store overwrites the files, Load discards these edits.
   */
  dirtyNamespaces: string[];
  /** Branch the database content belongs to. Null outside a git repository. */
  dbBranch: string | null;
  /** Branch checked out right now. Null outside a git repository. */
  diskBranch: string | null;
  /**
   * HEAD commit the database content was loaded at, and the commit checked out
   * now. Used to label the two sides of the decision diagram with real git
   * state. Null outside a git repository, or when the ref cannot be resolved.
   */
  dbCommit: string | null;
  diskCommit: string | null;

  /**
   * The three moments that explain the change when git identity cannot.
   *
   * When the files are restored or undone, both sides sit on the same branch and
   * the same commit, so only time distinguishes them:
   *
   *   openedAt       the session began
   *   syncedAt       database and files last agreed (a save)
   *   filesChangedAt the files on disk were last written
   *
   * All ISO strings, or null when unavailable.
   *
   * Each moment must be presented as an event, never a bare time: a time with no
   * verb is read as whichever event the reader had in mind, and a time beside a
   * commit chip is read as the commit's date. `openedAt`'s verb is implicit,
   * `syncedAt`'s is `syncedReason` below, and `filesChangedAt`'s is derived by the
   * consumer from the branch/commit pairs above. The pairing is part of the
   * contract, not a presentation choice. Only `syncedReason` needs transporting;
   * the other two verbs are recoverable from data already here.
   */
  openedAt: string | null;
  syncedAt: string | null;
  filesChangedAt: string | null;

  /**
   * Which event stamped `syncedAt`. Null when no baseline has been recorded, or
   * when it was stamped by a caller that did not say — a label may degrade to
   * the neutral "synced", but must not invent a verb.
   */
  syncedReason: SnapshotSyncReason | null;
}
