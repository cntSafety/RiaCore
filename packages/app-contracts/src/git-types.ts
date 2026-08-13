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
// Re-export git types from git-service for use in IPC contracts and renderer
export type {
  GitRepoStatus,
  GitFileStatus,
  CommitParams,
  CommitResult,
  BranchInfo,
  TagInfo,
  LogParams,
  CommitEntry,
  CommitLog,
  RemoteInfo,
  FetchParams,
  FetchResult,
  PullParams,
  PullResult,
  PushParams,
  PushResult,
  CheckoutTempParams,
  GitUserConfig,
  GitError,
  GitErrorKind,
} from '@riacore/git-service';

import type { DiffOptions, NamespaceDiffResult, DiffSummary } from './diff-types.js';

export interface GitSemanticDiffParams {
  repoDir: string;
  /**
   * Absolute path to the RIA workspace working directory.
   * Defaults to repoDir when omitted (i.e. workspace is at the repo root).
   * When the workspace lives in a subdirectory of the repo, the relative
   * offset is used to locate ria-data/ and ria-config/ inside the repo tree.
   */
  workingDir?: string;
  /** Git ref (commit hash, branch, tag) for the "from" side (older/left) */
  fromRef: string;
  /** Git ref (commit hash, branch, tag) for the "to" side (newer/right) */
  toRef: string;
  namespace: string;
  opts?: DiffOptions;
}

export interface GitSemanticDiffResult {
  summary: DiffSummary;
  result: NamespaceDiffResult;
  fromRef: string;
  toRef: string;
  namespace: string;
}

export interface GitEnsureGitignoreResult {
  created: boolean;
  updated: boolean;
}

export interface WorkspaceGitConfig {
  /** Absolute path to the git repo root. If unset, defaults to the workspace working dir. */
  repoDir?: string;
  /** Auto-stage ria-data/ and commit after a successful persistor.store */
  autoCommitOnStore: boolean;
  /** Commit message template. Variables: {{date}}, {{namespaces}}, {{fileCount}} */
  autoCommitMessageTemplate: string;
  /** Override the commit author identity for auto-commits */
  commitAuthor?: { name: string; email: string };
}

export const DEFAULT_AUTO_COMMIT_TEMPLATE =
  'chore: store snapshot [{{date}}]\n\nNamespaces: {{namespaces}}\nFiles written: {{fileCount}}\nAuto-committed by RIACore persistor.store';
