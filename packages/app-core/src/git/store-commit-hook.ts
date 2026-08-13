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
import * as yaml from 'yaml';
import type { WorkspaceGitConfig } from '@riacore/app-contracts';
import type { IGitService } from '@riacore/git-service';

// StoreResult shape (mirrored from persistor to avoid circular import)
interface StoreResult {
  files_written: number;
  total_records: number;
  namespaces_written: string[];
  exported_at: string;
}

const GIT_CONFIG_FILENAME = 'ria-git-config.yaml';

/**
 * Load the per-workspace git configuration from ria-config/ria-git-config.yaml.
 * Returns null if the file does not exist or cannot be parsed.
 */
export async function loadWorkspaceGitConfig(workingDir: string): Promise<WorkspaceGitConfig | null> {
  const configPath = path.join(workingDir, 'ria-config', GIT_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.parse(raw) as Partial<WorkspaceGitConfig>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      repoDir: parsed.repoDir,
      autoCommitOnStore: parsed.autoCommitOnStore ?? false,
      autoCommitMessageTemplate: parsed.autoCommitMessageTemplate ??
        'chore: store snapshot [{{date}}]\n\nNamespaces: {{namespaces}}\nFiles written: {{fileCount}}\nAuto-committed by RIACore persistor.store',
      commitAuthor: parsed.commitAuthor,
    };
  } catch (err) {
    console.warn('[git] Failed to parse workspace git config:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Write the workspace git configuration to ria-config/ria-git-config.yaml.
 */
export async function saveWorkspaceGitConfig(workingDir: string, config: WorkspaceGitConfig): Promise<void> {
  const configDir = path.join(workingDir, 'ria-config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, GIT_CONFIG_FILENAME);
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
}

/**
 * Resolve the git repo directory from config.
 * Falls back to the workspace working directory if repoDir is not configured.
 */
export function resolveRepoDir(gitConfig: WorkspaceGitConfig, workingDir: string): string {
  return gitConfig.repoDir && gitConfig.repoDir.trim() !== '' ? gitConfig.repoDir : workingDir;
}

/**
 * Convert paths relative to workingDir into paths relative to repoDir.
 *
 * When the RIA workspace lives inside a git repository at a sub-directory
 * (e.g. repoDir=/project, workingDir=/project/ria), a bare pattern like
 * 'ria-data/' resolves to the wrong location from git's perspective (the
 * repo root). This function prepends the relative offset so git can locate
 * the files correctly.
 *
 * Uses forward slashes in all output paths for cross-platform git compatibility.
 *
 * Examples:
 *   repoDir=/project, workingDir=/project/ria, paths=['ria-data/']
 *   → ['ria/ria-data/']
 *
 *   repoDir=/project, workingDir=/project, paths=['ria-data/']
 *   → ['ria-data/']  (unchanged — workspace is at repo root)
 */
export function toRepoRelativePaths(workingDir: string, repoDir: string, relPaths: string[]): string[] {
  const rawPrefix = path.relative(repoDir, workingDir);
  if (!rawPrefix || rawPrefix === '.') return relPaths;
  // Normalize separators to forward slashes for git
  const prefix = rawPrefix.split(path.sep).join('/');
  return relPaths.map(p => `${prefix}/${p}`);
}

/**
 * Build the auto-commit message from the template and store result.
 */
export function buildAutoCommitMessage(template: string, storeResult: StoreResult): string {
  const date = new Date().toISOString().split('T')[0];
  return template
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{namespaces\}\}/g, storeResult.namespaces_written.join(', '))
    .replace(/\{\{fileCount\}\}/g, String(storeResult.files_written));
}

interface SimpleLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Optional post-store auto-commit hook.
 * Called after a successful persistor.store — never throws.
 */
export async function runStoreCommitHook(
  workingDir: string,
  storeResult: StoreResult,
  gitService: IGitService,
  logger?: SimpleLogger,
): Promise<void> {
  const gitConfig = await loadWorkspaceGitConfig(workingDir);
  if (!gitConfig || !gitConfig.autoCommitOnStore) return;

  const repoDir = resolveRepoDir(gitConfig, workingDir);

  const isRepoResult = await gitService.isRepo(repoDir);
  if (!isRepoResult.ok || !isRepoResult.data) {
    logger?.warn(`[git] Auto-commit skipped — "${repoDir}" is not a git repository`);
    return;
  }

  const stageResult = await gitService.stageFiles(repoDir, toRepoRelativePaths(workingDir, repoDir, ['ria-data/', 'ria-config/']));
  if (!stageResult.ok) {
    logger?.warn(`[git] Auto-commit: staging failed — ${stageResult.error.message}`);
    return;
  }

  const statusResult = await gitService.getStatus(repoDir);
  if (!statusResult.ok) {
    logger?.warn(`[git] Auto-commit: getStatus failed — ${statusResult.error.message}`);
    return;
  }

  if (statusResult.data.staged.length === 0) {
    logger?.info('[git] Nothing to commit after store');
    return;
  }

  const message = buildAutoCommitMessage(
    gitConfig.autoCommitMessageTemplate,
    storeResult,
  );

  const commitResult = await gitService.commit({
    repoDir,
    message,
    author: gitConfig.commitAuthor,
  });

  if (!commitResult.ok) {
    logger?.warn(`[git] Auto-commit failed — ${commitResult.error.message}`);
    return;
  }

  logger?.info(`[git] Auto-committed after store: ${commitResult.data.shortHash}`);
}
