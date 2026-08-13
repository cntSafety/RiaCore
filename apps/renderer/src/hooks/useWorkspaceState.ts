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
import { useDbStats } from './useDbStats';
import { useWorkspaceStatus } from './useWorkspaceStatus';
import { useImportRunStore } from '../store/importRunStore';
import type { DbStats, DbStatus, LifecycleAction } from '@riacore/app-contracts';

/**
 * Workspace state machine — derived solely from workspace.getStatus, which
 * returns live DB status on every call (no separate db.probe needed).
 *
 * Phases:
 *   no_workspace  — nothing opened yet
 *   loading_from_ria_data — workspace open, DB open, persistor load in progress
 *   load_failed   — workspace open, Case B load failed; lifecycleWarning holds the error
 *   db_open       — workspace open and DB accessible; lifecycleAction describes
 *                   what happened during open (past tense — already complete):
 *                     'created'                    → new workspace
 *                     'opened_consistent'          → DB and ria-data in sync
 *                     'opened_loaded_from_ria_data'→ DB rebuilt from ria-data
 *                     'opened_saved_to_ria_data'   → ria-data exported from DB
 *                     'opened_db_only'             → ria-data export failed (warning)
 *                     'opened_db_only' + filesCorrupted → ria-data hashes don't match
 *                       files on disk; DB is authoritative but saving would overwrite
 *                       the files with potentially stale DB content
 *   db_error      — workspace open but DB is in an error state
 *   db_closed     — workspace open but DB is closed / missing on disk
 */
export type WorkspacePhase =
  | { phase: 'no_workspace' }
  | { phase: 'loading_from_ria_data'; workingDir: string; dbStatus: DbStatus; loadProgress: { namespaceName: string; namespaceIndex: number; totalNamespaces: number | null } | null }
  | { phase: 'load_failed'; workingDir: string; error: string }
  | { phase: 'db_open';   workingDir: string; dbStatus: DbStatus; dbStats: DbStats | undefined; lifecycleAction: LifecycleAction; lifecycleWarning?: string; filesCorrupted?: boolean }
  | { phase: 'db_error';  workingDir: string; dbStatus: DbStatus; lifecycleWarning?: string }
  | { phase: 'db_closed'; workingDir: string; dbStatus: DbStatus };

export function useWorkspaceState(): WorkspacePhase {
  const { data: wsStatus } = useWorkspaceStatus();
  const hasRunningImport = useImportRunStore((s) => s.hasAnyRunning());

  const isLoading = wsStatus?.state === 'open' && wsStatus.info.lifecycleAction === 'loading_from_ria_data';
  const isDbOpenFlag = wsStatus?.state === 'open' && wsStatus.info.dbStatus.state === 'open' && !isLoading;
  const { data: dbStats } = useDbStats(hasRunningImport, isDbOpenFlag);

  if (wsStatus?.state !== 'open') {
    return { phase: 'no_workspace' };
  }

  const { workingDir, dbStatus, lifecycleAction, lifecycleWarning } = wsStatus.info;

  if (lifecycleAction === 'loading_from_ria_data') {
    return { phase: 'loading_from_ria_data', workingDir, dbStatus, loadProgress: null };
  }

  if (lifecycleAction === 'load_failed') {
    return { phase: 'load_failed', workingDir, error: lifecycleWarning ?? 'Unknown error during ria-data load' };
  }

  if (dbStatus.state === 'error') {
    return { phase: 'db_error', workingDir, dbStatus, lifecycleWarning };
  }

  if (dbStatus.state !== 'open') {
    return { phase: 'db_closed', workingDir, dbStatus };
  }

  return { phase: 'db_open', workingDir, dbStatus, dbStats, lifecycleAction, lifecycleWarning,
    filesCorrupted: lifecycleAction === 'opened_db_only' && typeof lifecycleWarning === 'string' && lifecycleWarning.includes('file integrity check failed'),
  };
}

/** Convenience: true when the DB is open and usable. */
export function isDbOpen(phase: WorkspacePhase): phase is
  { phase: 'db_open'; workingDir: string; dbStatus: DbStatus; dbStats: DbStats | undefined; lifecycleAction: LifecycleAction; lifecycleWarning?: string } {
  return phase.phase === 'db_open';
}
