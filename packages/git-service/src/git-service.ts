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
import type {
  GitRepoStatus,
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
} from './git-types.js';

export type GitResult<T> = { ok: true; data: T } | { ok: false; error: GitError };

export interface IGitService {
  // ── Repository lifecycle ──────────────────────────────────────────────────
  isRepo(dir: string): Promise<GitResult<boolean>>;
  init(dir: string, initialBranch?: string): Promise<GitResult<void>>;

  // ── Repository status ─────────────────────────────────────────────────────
  getStatus(repoDir: string): Promise<GitResult<GitRepoStatus>>;

  // ── Staging ───────────────────────────────────────────────────────────────
  stageFiles(repoDir: string, patterns: string[]): Promise<GitResult<void>>;
  stageAll(repoDir: string): Promise<GitResult<void>>;
  unstageAll(repoDir: string): Promise<GitResult<void>>;

  // ── Commit ────────────────────────────────────────────────────────────────
  commit(params: CommitParams): Promise<GitResult<CommitResult>>;

  // ── Branches ──────────────────────────────────────────────────────────────
  getCurrentBranch(repoDir: string): Promise<GitResult<string | null>>;
  listBranches(repoDir: string): Promise<GitResult<BranchInfo[]>>;
  createBranch(repoDir: string, name: string, from?: string): Promise<GitResult<void>>;
  checkoutBranch(repoDir: string, name: string): Promise<GitResult<void>>;
  deleteBranch(repoDir: string, name: string, force?: boolean): Promise<GitResult<void>>;
  renameBranch(repoDir: string, oldName: string, newName: string): Promise<GitResult<void>>;

  // ── Tags ──────────────────────────────────────────────────────────────────
  listTags(repoDir: string): Promise<GitResult<TagInfo[]>>;

  // ── Repo root ─────────────────────────────────────────────────────────────
  /** Returns the absolute path to the repo root, or null if the dir is not inside a repo. */
  getRepoRoot(dir: string): Promise<GitResult<string | null>>;

  // ── History ───────────────────────────────────────────────────────────────
  getLog(params: LogParams): Promise<GitResult<CommitLog>>;
  getCommit(repoDir: string, ref: string): Promise<GitResult<CommitEntry | null>>;

  // ── Remotes ───────────────────────────────────────────────────────────────
  listRemotes(repoDir: string): Promise<GitResult<RemoteInfo[]>>;
  addRemote(repoDir: string, name: string, url: string): Promise<GitResult<void>>;
  removeRemote(repoDir: string, name: string): Promise<GitResult<void>>;
  setRemoteUrl(repoDir: string, name: string, url: string): Promise<GitResult<void>>;

  // ── Remote sync ───────────────────────────────────────────────────────────
  fetch(params: FetchParams): Promise<GitResult<FetchResult>>;
  pull(params: PullParams): Promise<GitResult<PullResult>>;
  push(params: PushParams): Promise<GitResult<PushResult>>;

  // ── Semantic diff bridge support ──────────────────────────────────────────
  checkoutCommitToTemp(params: CheckoutTempParams): Promise<GitResult<string>>;

  // ── User config ───────────────────────────────────────────────────────────
  getConfig(repoDir: string): Promise<GitResult<GitUserConfig>>;
  setConfig(repoDir: string, config: Partial<GitUserConfig>): Promise<GitResult<void>>;

  // ── Binary info ───────────────────────────────────────────────────────────
  getGitVersion(): Promise<GitResult<string>>;
}
