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
  | 'load_failed';

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
// See docs/coreSpecs/RiaDataChangeDetection.md

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
   * the same commit, so branch and commit are useless as discriminators and only
   * time distinguishes them:
   *
   *   openedAt       the session began                        (07:50)
   *   syncedAt       database and files last agreed           (07:55, a save)
   *   filesChangedAt the files on disk were last written      (07:57, the undo)
   *
   * All ISO strings, or null when unavailable.
   *
   * **Each moment is an event, never a bare time.** A moment on its own invites
   * the reader to supply the missing half themselves, and they supply it wrong:
   * a time beside a commit chip gets read as the commit's date, and a time with
   * no verb gets read as whichever event the reader had in mind. So every one of
   * the three is paired with what happened, and the pairing is the contract — not
   * a presentation choice the UI is free to drop:
   *
   *   openedAt       'open' or 'create' — implicit, it is the session start
   *   syncedAt       `syncedReason` below
   *   filesChangedAt derived by the consumer from the branch/commit pairs above
   *                  (switched branch / moved commit / rewritten in place)
   *
   * Only the middle one needs transporting: the other two are recoverable from
   * data already here.
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
