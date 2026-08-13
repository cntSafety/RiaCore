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
 * Git service types — shared between the git-service package and consumers.
 */

export interface GitRepoStatus {
  isRepo: boolean;
  branch: string | null;
  /** Detached HEAD — at a commit, not a branch */
  isDetached: boolean;
  /** Commits ahead of tracking branch */
  ahead: number;
  /** Commits behind tracking branch */
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  hasConflicts: boolean;
  trackingBranch: string | null;
}

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unmerged';
  fromPath?: string;
}

export interface CommitParams {
  repoDir: string;
  message: string;
  author?: { name: string; email: string };
  stageModified?: boolean;
  stagePatterns?: string[];
}

export interface CommitResult {
  hash: string;
  shortHash: string;
  branch: string | null;
  summary: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  tracking?: string;
  ahead: number;
  behind: number;
  lastCommitHash?: string;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  isRemote: boolean;
}

export interface LogParams {
  repoDir: string;
  ref?: string;
  maxCount?: number;
  path?: string;
  from?: string;
  to?: string;
}

export interface CommitEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  isoDate: string;
  message: string;
  body: string;
  refs: string;
}

export interface CommitLog {
  entries: CommitEntry[];
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface FetchParams {
  repoDir: string;
  remote?: string;
  prune?: boolean;
}

export interface FetchResult {
  remote: string;
  updated: string[];
}

export interface PullParams {
  repoDir: string;
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface PullResult {
  mergeType: 'fast-forward' | 'merge-commit' | 'already-up-to-date' | 'rebase';
  filesChanged: number;
  summary: string;
}

export interface PushParams {
  repoDir: string;
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  force?: boolean;
}

export interface PushResult {
  remote: string;
  branch: string;
  success: boolean;
  summary: string;
}

export interface CheckoutTempParams {
  repoDir: string;
  commitHash: string;
  paths?: string[];
}

export interface TagInfo {
  name: string;
  /** Full commit hash the tag points to (or the tagged object for annotated tags). */
  commitHash?: string;
  /** ISO date string of the tag creation (annotated) or the tagged commit (lightweight). */
  date?: string;
  /** Annotated tags carry a separate message; lightweight tags do not. */
  isAnnotated: boolean;
}

export interface GitUserConfig {
  name?: string;
  email?: string;
}

export type GitErrorKind =
  | 'not-a-repo'
  | 'uncommitted-changes'
  | 'merge-conflict'
  | 'auth-failed'
  | 'network-error'
  | 'branch-not-found'
  | 'commit-not-found'
  /** Requested paths (files/directories) were not found in the specified commit. */
  | 'paths-not-found'
  | 'push-rejected'
  | 'unknown';

export interface GitError {
  kind: GitErrorKind;
  message: string;
  gitOutput?: string;
}
