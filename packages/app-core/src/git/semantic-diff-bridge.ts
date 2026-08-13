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
import * as path from 'node:path';
import { createDiffService } from '../diff/diff-service.js';
import type { IDbModule } from '../db/db-module.js';
import type { ServiceDependencies } from '../dispatch/types.js';
import type { GitSemanticDiffParams, GitSemanticDiffResult } from '@riacore/app-contracts';

export interface ISemanticDiffBridge {
  diffCommits(params: GitSemanticDiffParams, deps: ServiceDependencies): Promise<GitSemanticDiffResult>;
}

export function createSemanticDiffBridge(dbModule: IDbModule): ISemanticDiffBridge {
  return {
    async diffCommits(params, deps) {
      const svc = deps.gitService;
      if (!svc) throw new Error('Git service not available');

      const { repoDir, workingDir, fromRef, toRef, namespace, opts } = params;

      // Compute the path from repo root to the workspace directory.
      // When the workspace is a subdirectory of the repo, ria-data/ lives at
      // <prefix>/ria-data/ relative to the repo root.
      const effectiveWorkingDir = workingDir ?? repoDir;
      const rawPrefix = path.relative(repoDir, effectiveWorkingDir);
      const prefix = rawPrefix && rawPrefix !== '.' ? rawPrefix.split(path.sep).join('/') : '';
      const riaDataRepoPath = prefix ? `${prefix}/ria-data` : 'ria-data';

      // Checkout both commits to temp directories
      const fromTempResult = await svc.checkoutCommitToTemp({
        repoDir,
        commitHash: fromRef,
        paths: [riaDataRepoPath],
      });
      if (!fromTempResult.ok) {
        throw new Error(`Failed to checkout commit '${fromRef}': ${fromTempResult.error.message}`);
      }

      const toTempResult = await svc.checkoutCommitToTemp({
        repoDir,
        commitHash: toRef,
        paths: [riaDataRepoPath],
      });
      if (!toTempResult.ok) {
        // Cleanup from temp
        try { fs.rmSync(fromTempResult.data, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        throw new Error(`Failed to checkout commit '${toRef}': ${toTempResult.error.message}`);
      }

      const fromTempRoot = fromTempResult.data;
      const toTempRoot = toTempResult.data;

      // The checked-out ria-data/ lives at <tempRoot>/<riaDataRepoPath>
      // (git preserves the full path structure under the work-tree root).
      const fromRiaDataDir = path.join(fromTempRoot, ...riaDataRepoPath.split('/'));
      const toRiaDataDir = path.join(toTempRoot, ...riaDataRepoPath.split('/'));

      try {
        // Validate that ria-data directories exist in both temp dirs
        if (!fs.existsSync(fromRiaDataDir)) {
          throw new Error(`ria-data not found in commit ${fromRef} (expected: ${fromRiaDataDir})`);
        }
        if (!fs.existsSync(toRiaDataDir)) {
          throw new Error(`ria-data not found in commit ${toRef} (expected: ${toRiaDataDir})`);
        }

        const diffSvc = createDiffService(dbModule);
        const { summary, result } = await diffSvc.diffFromPaths({
          leftDir: fromRiaDataDir,
          leftNs: namespace,
          rightDir: toRiaDataDir,
          rightNs: namespace,
          opts,
        });

        return {
          summary,
          result,
          fromRef,
          toRef,
          namespace,
        };
      } finally {
        // Always clean up temp dirs
        try { fs.rmSync(fromTempRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        try { fs.rmSync(toTempRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    },
  };
}
