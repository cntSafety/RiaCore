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
 * Namespace union-merge channel handlers (UC-13, UC-14, UC-15).
 *
 * Registers five IPC channels:
 *  - namespace.getSyncStatus
 *  - namespace.applyUnionMergeFromFiles
 *  - namespace.applyUnionMergeFromBranch
 *  - namespace.supervisedMergeFromBranchPrepare
 *  - namespace.supervisedMergeCleanup
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { createRegistry } from '../channel-registry.js';
import { createDiffService } from '../../diff/diff-service.js';
import { createUnionMergeService } from '../../namespaces/union-merge-service.js';
import { countDiffSummaryChanges, describeDiffSummaryCounts } from '@riacore/app-contracts';
import { createPersistorService } from '../../index.js';
import { runStoreCommitHook } from '../../git/store-commit-hook.js';

export function registerNamespaceMergeChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── namespace.getSyncStatus ───────────────────────────────────────────────
  registry.register('namespace.getSyncStatus', async ({ namespace, workingDir }, deps, _ctx) => {
    const snapshotDir = path.join(workingDir, 'ria-data');
    const diffSvc = createDiffService(deps.dbModule);
    const { summary, result: _result } = await diffSvc.diffHybrid({
      liveNs: namespace,
      snapshotDir,
      snapshotNs: namespace,
      liveIsLeft: true,
      workingDir,
    });

    // countDiffSummaryChanges, not a hand-written field list: the previous
    // check omitted the three cross-namespace counts, so a namespace that
    // differed from its snapshot only in a cross-NS relationship reported
    // itself as in sync.
    const inSync = countDiffSummaryChanges(summary) === 0;

    return {
      namespace,
      inSync,
      diffSummary: inSync ? null : summary,
    };
  }, { requiresWorkspace: true, category: 'namespaces' });

  // ── namespace.applyUnionMergeFromFiles ────────────────────────────────────
  registry.register('namespace.applyUnionMergeFromFiles', async ({ namespace, workingDir }, deps, _ctx) => {
    const snapshotDir = path.join(workingDir, 'ria-data');

    if (!fs.existsSync(snapshotDir)) {
      throw new Error(`ria-data directory not found at '${snapshotDir}'`);
    }

    const diffSvc = createDiffService(deps.dbModule);
    // liveIsLeft: true → addedNodes = nodes in incoming (right/files) not in live (left)
    const { result: diffResult } = await diffSvc.diffHybrid({
      liveNs: namespace,
      snapshotDir,
      snapshotNs: namespace,
      liveIsLeft: true,
      workingDir,
    });

    const mergeSvc = createUnionMergeService(deps.dbModule);
    const mergeResult = await mergeSvc.applyUnionMerge({
      diffResult,
      targetNamespace: namespace,
      source: 'files',
    });

    // Persist the updated DB state to ria-data/ files (Bug 4 fix)
    const logger = deps.loggers.workspace(workingDir);
    const storeResult = await createPersistorService(deps.dbModule, logger).store({ workingDir });

    // Run the auto-commit hook so that the files written here are staged
    // consistently with files written via the persistor.store IPC channel.
    // Without this, a prior auto-save may have staged an older version of the
    // same ria-data/ files, leaving them in a split staged/unstaged state.
    if (deps.gitService) {
      await runStoreCommitHook(workingDir, storeResult, deps.gitService).catch((err) =>
        console.warn('[namespace.applyUnionMergeFromFiles] Auto-commit hook failed:', err instanceof Error ? err.message : String(err)),
      );
    }

    return mergeResult;
  }, { mutates: 'self', requiresWorkspace: true, category: 'namespaces' });

  // ── namespace.supervisedMergeFromBranchPrepare ────────────────────────────
  registry.register('namespace.supervisedMergeFromBranchPrepare', async (
    { namespace, repoDir, branchRef, workingDir }, deps, ctx,
  ) => {
    const logger = deps.loggers.diffMerge(workingDir);
    logger.info('namespace.supervisedMergeFromBranchPrepare: start', {
      namespace,
      repoDir,
      branchRef,
      workingDir,
    });

    // Step 1: guard gitService
    if (!deps.gitService) {
      throw new Error('Git service not available');
    }

    let tempDir: string | undefined;
    try {
      const workspaceRiaDataPath = path.relative(
        path.resolve(repoDir),
        path.resolve(workingDir, 'ria-data'),
      );
      if (
        workspaceRiaDataPath === '' ||
        workspaceRiaDataPath.startsWith(`..${path.sep}`) ||
        workspaceRiaDataPath === '..' ||
        path.isAbsolute(workspaceRiaDataPath)
      ) {
        throw new Error(
          `Workspace '${workingDir}' must be inside repository '${repoDir}' to merge from a branch.`,
        );
      }
      const archivePath = workspaceRiaDataPath.split(path.sep).join('/');

      // Step 2: resolve commit hash for the branch ref
      const commitResult = await deps.gitService.getCommit(repoDir, branchRef);
      if (!commitResult.ok) {
        logger.error('namespace.supervisedMergeFromBranchPrepare: failed to resolve ref', {
          branchRef,
          error: commitResult.error.message,
        });
        throw new Error(`Failed to resolve ref '${branchRef}': ${commitResult.error.message}`);
      }
      const commit = commitResult.data;
      if (!commit) {
        throw new Error(`Branch or tag '${branchRef}' not found in repo`);
      }
      logger.info('namespace.supervisedMergeFromBranchPrepare: resolved commit', {
        branchRef,
        commitHash: commit.hash,
        shortHash: commit.hash.slice(0, 7),
      });

      // Step 3: checkout ria-data/ to temp dir
      logger.info('namespace.supervisedMergeFromBranchPrepare: checking out ria-data/ to temp dir', {
        repoDir,
        commitHash: commit.hash,
      });
      const checkoutResult = await deps.gitService.checkoutCommitToTemp({
        repoDir,
        commitHash: commit.hash,
        paths: [archivePath],
      });
      if (!checkoutResult.ok) {
        const errKind = checkoutResult.error.kind;
        logger.error('namespace.supervisedMergeFromBranchPrepare: checkout failed', {
          error: checkoutResult.error.message,
          errorKind: errKind,
        });
        if (errKind === 'paths-not-found') {
          throw new Error(
            `Branch '${branchRef}' does not contain RIA workspace data. ` +
            `The 'ria-data/' directory was not found on this branch. ` +
            `Please select a branch that contains the RIA workspace files.`,
          );
        }
        throw new Error(`Failed to check out branch '${branchRef}': ${checkoutResult.error.message}`);
      }
      tempDir = checkoutResult.data;
      logger.info('namespace.supervisedMergeFromBranchPrepare: checkout complete', { tempDir });

      // Step 4: sync check — diff live namespace vs on-disk snapshot
      logger.info('namespace.supervisedMergeFromBranchPrepare: sync check (live vs on-disk snapshot)', {
        namespace,
        snapshotDir: path.join(workingDir, 'ria-data'),
      });
      const diffSvc = createDiffService(deps.dbModule);
      const { summary: syncSummary } = await diffSvc.diffHybrid({
        liveNs: namespace,
        snapshotDir: path.join(workingDir, 'ria-data'),
        snapshotNs: namespace,
        liveIsLeft: true,
        workingDir,
      });
      // Counts every change kind, including edges and cross-namespace edges.
      // The previous node-only check missed unsaved relationship edits, so the
      // user was not warned that the diff below compares the branch against a
      // stale snapshot rather than what they see on screen.
      const hasLiveChanges = countDiffSummaryChanges(syncSummary) > 0;
      const syncWarning = hasLiveChanges
        ? `Namespace '${namespace}' has unsaved live changes. The diff shows the branch content against the last stored snapshot.`
        : undefined;
      logger.info('namespace.supervisedMergeFromBranchPrepare: sync check result', {
        hasLiveChanges,
        ...describeDiffSummaryCounts(syncSummary),
        syncWarning: syncWarning ?? null,
      });

      // Step 5: branch diff — diff live namespace vs branch snapshot
      logger.info('namespace.supervisedMergeFromBranchPrepare: computing branch diff', {
        namespace,
        branchSnapshotDir: path.join(tempDir, workspaceRiaDataPath),
      });
      const { summary, result } = await diffSvc.diffHybrid({
        liveNs: namespace,
        snapshotDir: path.join(tempDir, workspaceRiaDataPath),
        snapshotNs: namespace,
        liveIsLeft: true,
        workingDir,
      });
      logger.info('namespace.supervisedMergeFromBranchPrepare: branch diff complete', {
        diffId: summary.diffId,
        ...describeDiffSummaryCounts(summary),
        totalChanges: countDiffSummaryChanges(summary),
      });

      // Step 6: cache the diff result
      ctx.storeDiffResult(summary.diffId, result);

      // Step 7: return the prepare result
      logger.info('namespace.supervisedMergeFromBranchPrepare: complete — ready for user review', {
        diffId: summary.diffId,
        resolvedCommitHash: commit.hash,
        tempDir,
        syncWarning: syncWarning ?? null,
      });
      return {
        diffId: summary.diffId,
        diffSummary: summary,
        resolvedCommitHash: commit.hash,
        resolvedShortHash: commit.hash.slice(0, 7),
        tempDir,
        syncWarning,
      };
    } catch (err) {
      // Cleanup tempDir on any error
      if (tempDir !== undefined) {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }
  }, { mutates: 'self', requiresWorkspace: true, category: 'namespaces' });

  // ── namespace.supervisedMergeCleanup ──────────────────────────────────────
  registry.register('namespace.supervisedMergeCleanup', async ({ tempDir }) => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      // ENOENT = already deleted, succeed silently
    }
  }, { mutates: 'self', requiresWorkspace: false, category: 'namespaces' });

  // ── namespace.applyUnionMergeFromBranch ───────────────────────────────────
  registry.register('namespace.applyUnionMergeFromBranch', async ({ namespace, workingDir, repoDir, branchRef }, deps, _ctx) => {
    if (!deps.gitService) {
      throw new Error('Git service is not available');
    }

    // Verify it's a git repo (isRepo() returns GitResult<boolean>, not a plain boolean)
    const isRepoResult = await deps.gitService.isRepo(repoDir);
    if (!isRepoResult.ok) {
      throw new Error(`Git error checking repository '${repoDir}': ${isRepoResult.error.message}`);
    }
    if (!isRepoResult.data) {
      throw new Error(`'${repoDir}' is not a git repository`);
    }

    const checkoutResult = await deps.gitService.checkoutCommitToTemp({
      repoDir,
      commitHash: branchRef,
      paths: ['ria-data'],
    });
    if (!checkoutResult.ok) {
      if (checkoutResult.error.kind === 'paths-not-found') {
        throw new Error(
          `Branch '${branchRef}' does not contain RIA workspace data. ` +
          `The 'ria-data/' directory was not found on this branch. ` +
          `Please select a branch that contains the RIA workspace files.`,
        );
      }
      throw new Error(`Failed to check out branch '${branchRef}': ${checkoutResult.error.message}`);
    }
    const tempDir = checkoutResult.data;

    try {
      const snapshotDir = path.join(tempDir, 'ria-data');
      if (!fs.existsSync(snapshotDir)) {
        throw new Error(
          `Branch '${branchRef}' does not contain a ria-data/ directory at the repository root.`,
        );
      }

      const diffSvc = createDiffService(deps.dbModule);
      const { result: diffResult } = await diffSvc.diffHybrid({
        liveNs: namespace,
        snapshotDir,
        snapshotNs: namespace,
        liveIsLeft: true,
        workingDir,
      });

      const mergeSvc = createUnionMergeService(deps.dbModule);
      const mergeResult = await mergeSvc.applyUnionMerge({
        diffResult,
        targetNamespace: namespace,
        source: 'branch',
        sourceBranch: branchRef,
      });

      // Persist the updated DB state to ria-data/ files (Bug 4 fix)
      const logger = deps.loggers.workspace(workingDir);
      const storeResult = await createPersistorService(deps.dbModule, logger).store({ workingDir });

      // Run the auto-commit hook so that the files written here are staged
      // consistently with files written via the persistor.store IPC channel.
      // Without this, a prior auto-save may have staged an older version of the
      // same ria-data/ files, leaving them in a split staged/unstaged state.
      if (deps.gitService) {
        await runStoreCommitHook(workingDir, storeResult, deps.gitService).catch((err) =>
          console.warn('[namespace.applyUnionMergeFromBranch] Auto-commit hook failed:', err instanceof Error ? err.message : String(err)),
        );
      }

      return mergeResult;
    } finally {
      // Unconditional cleanup of temp checkout
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors — temp dir will be cleaned up by OS eventually
      }
    }
  }, { mutates: 'self', requiresWorkspace: true, category: 'namespaces' });
}
