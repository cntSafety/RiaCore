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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { createGitRunner } from './git-runner.js';
import type { IGitService, GitResult } from './git-service.js';
import type {
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
} from './git-types.js';

// ── Error classification ─────────────────────────────────────────────────────

export function classifyGitError(err: unknown): GitError {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  let kind: GitErrorKind = 'unknown';

  if (lower.includes('not a git repository')) {
    kind = 'not-a-repo';
  } else if (lower.includes('authentication failed') || lower.includes('permission denied (publickey)')) {
    kind = 'auth-failed';
  } else if (lower.includes('conflict')) {
    kind = 'merge-conflict';
  } else if (lower.includes('rejected')) {
    kind = 'push-rejected';
  } else if (
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('network unreachable')
  ) {
    kind = 'network-error';
  } else if (lower.includes('did not match any file')) {
    // Pathspec exists as a git concept but doesn't match any file/dir in the commit.
    // This is distinct from a commit/revision not being found.
    kind = 'paths-not-found';
  } else if (lower.includes('unknown revision') || lower.includes('not a valid object name')) {
    kind = 'commit-not-found';
  } else if (lower.includes('branch') && (lower.includes('not found') || lower.includes('does not exist'))) {
    kind = 'branch-not-found';
  }

  // Extract raw git output from simple-git's error shape
  let gitOutput: string | undefined;
  if (err !== null && typeof err === 'object' && 'git' in err) {
    const gitErr = err as { git?: unknown };
    if (typeof gitErr.git === 'string') {
      gitOutput = gitErr.git;
    } else if (gitErr.git != null) {
      gitOutput = String(gitErr.git);
    }
  }

  return { kind, message: msg, gitOutput };
}

function ok<T>(data: T): GitResult<T> {
  return { ok: true, data };
}

function fail<T>(err: unknown): GitResult<T> {
  return { ok: false, error: classifyGitError(err) };
}

// ── Status parsing helpers ────────────────────────────────────────────────────

function mapFileStatus(index: string, workingDir: string): GitFileStatus['status'] {
  // Map simple-git status codes
  const code = (index + workingDir).replace(/\s/g, '');
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'unmerged';
  if (index === 'A' || workingDir === 'A') return 'added';
  if (index === 'D' || workingDir === 'D') return 'deleted';
  if (index === 'R' || workingDir === 'R') return 'renamed';
  if (index === 'C' || workingDir === 'C') return 'copied';
  return 'modified';
}

// ── Implementation ────────────────────────────────────────────────────────────

function createGitServiceImpl(): IGitService {
  return {
    async isRepo(dir: string): Promise<GitResult<boolean>> {
      try {
        const git = await createGitRunner(dir);
        const result = await git.checkIsRepo();
        return ok(result);
      } catch (err) {
        const e = classifyGitError(err);
        if (e.kind === 'not-a-repo') return ok(false);
        return fail(err);
      }
    },

    async init(dir: string, initialBranch?: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(dir);
        const args: string[] = initialBranch ? ['--initial-branch', initialBranch] : [];
        await git.init(args);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async getStatus(repoDir: string): Promise<GitResult<GitRepoStatus>> {
      try {
        const git = await createGitRunner(repoDir);
        const s = await git.status();

        const staged: GitFileStatus[] = [];
        const unstaged: GitFileStatus[] = [];
        let hasConflicts = false;

        for (const f of s.files) {
          const index = f.index ?? '';
          const wd = f.working_dir ?? '';

          // Conflict detection
          if (
            (index === 'U' || wd === 'U') ||
            (index === 'A' && wd === 'A') ||
            (index === 'D' && wd === 'D')
          ) {
            hasConflicts = true;
            unstaged.push({ path: f.path, status: 'unmerged' });
            continue;
          }

          // Untracked
          if (index === '?' && wd === '?') continue;

          // Staged changes
          if (index && index !== ' ' && index !== '?') {
            const status = mapFileStatus(index, ' ');
            const entry: GitFileStatus = { path: f.path, status };
            staged.push(entry);
          }

          // Unstaged changes
          if (wd && wd !== ' ' && wd !== '?') {
            const status = mapFileStatus(' ', wd);
            const entry: GitFileStatus = { path: f.path, status };
            unstaged.push(entry);
          }
        }

        const status: GitRepoStatus = {
          isRepo: true,
          branch: s.current,
          isDetached: s.detached,
          ahead: s.ahead,
          behind: s.behind,
          staged,
          unstaged,
          untracked: s.not_added,
          hasConflicts,
          trackingBranch: s.tracking,
        };

        return ok(status);
      } catch (err) {
        const e = classifyGitError(err);
        if (e.kind === 'not-a-repo') {
          return ok({
            isRepo: false,
            branch: null,
            isDetached: false,
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [],
            untracked: [],
            hasConflicts: false,
            trackingBranch: null,
          });
        }
        return fail(err);
      }
    },

    async stageFiles(repoDir: string, patterns: string[]): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.add(patterns);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async stageAll(repoDir: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.add('.');
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async unstageAll(repoDir: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.reset(['HEAD']);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async commit(params: CommitParams): Promise<GitResult<CommitResult>> {
      try {
        const git = await createGitRunner(params.repoDir);

        if (params.stagePatterns && params.stagePatterns.length > 0) {
          await git.add(params.stagePatterns);
        } else if (params.stageModified) {
          await git.add(['-u']);
        }

        const options: Record<string, string> = {};
        if (params.author) {
          options['--author'] = `${params.author.name} <${params.author.email}>`;
        }

        const result = await git.commit(params.message, undefined, options);

        return ok({
          hash: result.commit,
          shortHash: result.commit.slice(0, 8),
          branch: result.branch,
          summary: `[${result.branch ?? 'HEAD'} ${result.commit.slice(0, 8)}] ${params.message.split('\n')[0]}`,
        });
      } catch (err) {
        return fail(err);
      }
    },

    async getCurrentBranch(repoDir: string): Promise<GitResult<string | null>> {
      try {
        const git = await createGitRunner(repoDir);
        const s = await git.status();
        return ok(s.current);
      } catch (err) {
        return fail(err);
      }
    },

    async listBranches(repoDir: string): Promise<GitResult<BranchInfo[]>> {
      try {
        const git = await createGitRunner(repoDir);
        const summary = await git.branch(['--all', '--verbose', '--no-abbrev']);

        const branches: BranchInfo[] = Object.values(summary.branches).map((b) => {
          const isRemote = b.name.startsWith('remotes/');
          const name = isRemote ? b.name.slice('remotes/'.length) : b.name;
          return {
            name,
            current: b.current,
            tracking: undefined,
            ahead: 0,
            behind: 0,
            lastCommitHash: b.commit,
            lastCommitDate: undefined,
            lastCommitMessage: b.label,
            isRemote,
          };
        });

        return ok(branches);
      } catch (err) {
        return fail(err);
      }
    },

    async createBranch(repoDir: string, name: string, from?: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        if (from) {
          await git.checkoutBranch(name, from);
        } else {
          await git.checkoutLocalBranch(name);
        }
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async checkoutBranch(repoDir: string, name: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.checkout(name);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async deleteBranch(repoDir: string, name: string, force = false): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.deleteLocalBranch(name, force);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async renameBranch(repoDir: string, oldName: string, newName: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.raw(['branch', '-m', oldName, newName]);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async listTags(repoDir: string): Promise<GitResult<TagInfo[]>> {
      try {
        const git = await createGitRunner(repoDir);
        // --format outputs: <refname:short>|<objecttype>|<creatordate:iso>|<objectname>
        // For annotated tags objecttype='tag'; for lightweight objecttype='commit'.
        const raw = await git.raw([
          'tag',
          '--list',
          '--sort=-creatordate',
          '--format=%(refname:short)|%(objecttype)|%(creatordate:iso)|%(*objectname)%(objectname)',
        ]);
        const tags: TagInfo[] = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [name, objecttype, date, commitHash] = trimmed.split('|');
          if (!name) continue;
          tags.push({
            name: name.trim(),
            isAnnotated: objecttype?.trim() === 'tag',
            date: date?.trim() || undefined,
            commitHash: commitHash?.trim() || undefined,
          });
        }
        return ok(tags);
      } catch (err) {
        return fail(err);
      }
    },

    async getRepoRoot(dir: string): Promise<GitResult<string | null>> {
      try {
        const git = await createGitRunner(dir);
        const raw = await git.revparse(['--show-toplevel']);
        const root = raw.trim();
        return ok(root || null);
      } catch (err) {
        // Not inside a git repo
        return ok(null);
      }
    },

    async getLog(params: LogParams): Promise<GitResult<CommitLog>> {
      try {
        const git = await createGitRunner(params.repoDir);

        const options: Record<string, string | number> = {};
        if (params.maxCount !== undefined) options['--max-count'] = params.maxCount;
        if (params.path) options['--'] = params.path;

        let logResult;
        if (params.from && params.to) {
          logResult = await git.log({ from: params.from, to: params.to, ...options });
        } else if (params.ref) {
          logResult = await git.log({ from: params.ref, ...options });
        } else {
          logResult = await git.log(options);
        }

        const entries: CommitEntry[] = logResult.all.map((e) => ({
          hash: e.hash,
          shortHash: e.hash.slice(0, 8),
          author: e.author_name,
          email: e.author_email,
          date: e.date,
          isoDate: e.date,
          message: e.message,
          body: e.body,
          refs: e.refs,
        }));

        return ok({ entries });
      } catch (err) {
        return fail(err);
      }
    },

    async getCommit(repoDir: string, ref: string): Promise<GitResult<CommitEntry | null>> {
      try {
        const git = await createGitRunner(repoDir);
        // Use rev-parse to resolve the ref to a commit hash first.
        let hash: string;
        try {
          const raw = await git.raw(['rev-parse', `${ref}^{commit}`]);
          hash = raw.trim();
        } catch {
          return ok(null);
        }
        // Use raw git log to retrieve commit details for the resolved hash.
        // simple-git's .log({ from }) uses range syntax (from..) which returns
        // 0 results when the hash equals HEAD. Using raw avoids that pitfall.
        // Use record-separator (U+001E) as delimiter — won't appear in commit text.
        const SEP = '\x1e';
        const format = ['%H', '%aI', '%s', '%D', '%b', '%aN', '%aE'].join(SEP);
        const raw = await git.raw(['log', '-1', `--format=${format}`, hash]);
        if (!raw || !raw.trim()) return ok(null);
        const parts = raw.trim().split(SEP);
        if (parts.length < 7) return ok(null);
        const [commitHash, date, message, refs, body, author, email] = parts;
        return ok({
          hash: commitHash,
          shortHash: commitHash.slice(0, 8),
          author,
          email,
          date,
          isoDate: date,
          message,
          body,
          refs,
        });
      } catch (err) {
        const classified = classifyGitError(err);
        if (classified.kind === 'commit-not-found') return ok(null);
        return fail(err);
      }
    },

    async listRemotes(repoDir: string): Promise<GitResult<RemoteInfo[]>> {
      try {
        const git = await createGitRunner(repoDir);
        const remotes = await git.getRemotes(true);
        return ok(
          remotes.map((r) => ({
            name: r.name,
            fetchUrl: r.refs.fetch ?? '',
            pushUrl: r.refs.push ?? '',
          })),
        );
      } catch (err) {
        return fail(err);
      }
    },

    async addRemote(repoDir: string, name: string, url: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.addRemote(name, url);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async removeRemote(repoDir: string, name: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.removeRemote(name);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async setRemoteUrl(repoDir: string, name: string, url: string): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        await git.remote(['set-url', name, url]);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async fetch(params: FetchParams): Promise<GitResult<FetchResult>> {
      try {
        const git = await createGitRunner(params.repoDir);
        const args: string[] = ['fetch', params.remote ?? 'origin'];
        if (params.prune) args.push('--prune');
        await git.raw(args);
        return ok({
          remote: params.remote ?? 'origin',
          updated: [],
        });
      } catch (err) {
        return fail(err);
      }
    },

    async pull(params: PullParams): Promise<GitResult<PullResult>> {
      try {
        const git = await createGitRunner(params.repoDir);
        const options: Record<string, null | string> = {};
        if (params.rebase) options['--rebase'] = null;

        const result = await git.pull(params.remote, params.branch, options);

        let mergeType: PullResult['mergeType'] = 'merge-commit';
        const summary = result.summary?.changes ?? 0;
        if (result.summary?.changes === 0 && result.summary?.insertions === 0 && result.summary?.deletions === 0) {
          mergeType = 'already-up-to-date';
        } else if (params.rebase) {
          mergeType = 'rebase';
        }

        return ok({
          mergeType,
          filesChanged: result.files?.length ?? 0,
          summary: `${result.files?.length ?? 0} files changed`,
        });
      } catch (err) {
        return fail(err);
      }
    },

    async push(params: PushParams): Promise<GitResult<PushResult>> {
      try {
        const git = await createGitRunner(params.repoDir);
        const options: Record<string, null | string> = {};
        if (params.setUpstream) options['--set-upstream'] = null;
        if (params.force) options['--force'] = null;

        await git.push(params.remote ?? 'origin', params.branch, options);

        return ok({
          remote: params.remote ?? 'origin',
          branch: params.branch ?? '',
          success: true,
          summary: `Pushed to ${params.remote ?? 'origin'}/${params.branch ?? 'HEAD'}`,
        });
      } catch (err) {
        return fail(err);
      }
    },

    async checkoutCommitToTemp(params: CheckoutTempParams): Promise<GitResult<string>> {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riacore-git-diff-'));
      const tarPath = path.join(tempDir, '_archive.tar');
      try {
        const git = await createGitRunner(params.repoDir);
        const targetPaths = params.paths ?? ['ria-data', 'ria-config'];

        // Use git archive to write files directly to a tar on disk.
        // Unlike `git --work-tree checkout`, git archive never modifies the
        // repository index, so the real working folder stays clean even when
        // the caller cancels or the operation is only for inspection.
        // `--output` writes the archive to a file so the bytes never pass
        // through simple-git's string buffer (which would corrupt binary data).
        await git.raw([
          'archive',
          '--format=tar',
          '--output', tarPath,
          params.commitHash,
          '--',
          ...targetPaths,
        ]);

        // Extract with the `tar` npm package (pure JS) rather than shelling out
        // to an ambient `tar` binary. Shelling out is fragile on Windows: if a
        // Git-for-Windows / MSYS `tar.exe` (GNU tar) resolves ahead of the
        // Windows-native bsdtar on PATH, it misparses an absolute drive-letter
        // path like `C:\Users\...\archive.tar` as a `[user@]host:path` remote
        // archive spec and fails with "Cannot connect to C: resolve failed" —
        // silently or noisily breaking every checkoutCommitToTemp caller
        // (supervised update from branch, supervised merge from branch,
        // semantic git diff). The pure-JS extractor has no such ambiguity and
        // needs no external binary at all.
        await tar.x({ file: tarPath, cwd: tempDir });
        fs.unlinkSync(tarPath);

        return ok(tempDir);
      } catch (err) {
        // Cleanup on failure
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
        return fail(err);
      }
    },

    async getConfig(repoDir: string): Promise<GitResult<GitUserConfig>> {
      try {
        const git = await createGitRunner(repoDir);
        let name: string | undefined;
        let email: string | undefined;

        try {
          const raw = await git.raw(['config', '--get', 'user.name']);
          name = raw.trim() || undefined;
        } catch {
          // not set
        }

        try {
          const raw = await git.raw(['config', '--get', 'user.email']);
          email = raw.trim() || undefined;
        } catch {
          // not set
        }

        return ok({ name, email });
      } catch (err) {
        return fail(err);
      }
    },

    async setConfig(repoDir: string, config: Partial<GitUserConfig>): Promise<GitResult<void>> {
      try {
        const git = await createGitRunner(repoDir);
        if (config.name !== undefined) {
          await git.addConfig('user.name', config.name);
        }
        if (config.email !== undefined) {
          await git.addConfig('user.email', config.email);
        }
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },

    async getGitVersion(): Promise<GitResult<string>> {
      try {
        // Use a non-repo dir (os.tmpdir) to avoid "not-a-repo" errors
        const git = await createGitRunner(os.tmpdir());
        const raw = await git.raw(['--version']);
        return ok(raw.trim());
      } catch (err) {
        return fail(err);
      }
    },
  };
}

export function createGitService(): IGitService {
  return createGitServiceImpl();
}
