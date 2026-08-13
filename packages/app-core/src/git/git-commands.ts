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
import type { createRegistry } from '../dispatch/channel-registry.js';
import { loadWorkspaceGitConfig, saveWorkspaceGitConfig } from './store-commit-hook.js';

type Registry = ReturnType<typeof createRegistry>;

const GIT_CHANNEL_META = { requiresWorkspace: false, category: 'git' } as const;

/** Standard .gitignore content for RIA workspaces */
const RIA_GITIGNORE_CONTENT = `# RIACore workspace — runtime files (not for version control)
db
db.wal
logs/
*.tmp
*.lock
node_modules/
`;

const RIA_GITIGNORE_REQUIRED = ['db', 'db.wal', 'logs/'];

async function ensureGitignore(repoDir: string): Promise<{ created: boolean; updated: boolean }> {
  const gitignorePath = path.join(repoDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, RIA_GITIGNORE_CONTENT, 'utf-8');
    return { created: true, updated: false };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const lines = existing.split('\n').map((l) => l.trim());

  const missing = RIA_GITIGNORE_REQUIRED.filter((entry) => !lines.includes(entry));

  if (missing.length === 0) {
    return { created: false, updated: false };
  }

  const appendContent = '\n# RIACore workspace — runtime files (appended by RIA)\n' + missing.join('\n') + '\n';
  fs.appendFileSync(gitignorePath, appendContent, 'utf-8');
  return { created: false, updated: true };
}

/**
 * Register all git.* IPC channel handlers.
 */
export function registerGitChannels(registry: Registry): void {
  registry.register('git.isRepo', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.isRepo(payload.dir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.init', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.init(payload.dir, payload.initialBranch);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getStatus', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getStatus(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.stageAll', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.stageAll(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.stageFiles', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.stageFiles(payload.repoDir, payload.patterns);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.unstageAll', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.unstageAll(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.commit', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.commit(payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getCurrentBranch', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getCurrentBranch(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.listBranches', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.listBranches(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.createBranch', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.createBranch(payload.repoDir, payload.name, payload.from);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.checkoutBranch', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.checkoutBranch(payload.repoDir, payload.name);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.deleteBranch', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.deleteBranch(payload.repoDir, payload.name, payload.force);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.renameBranch', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.renameBranch(payload.repoDir, payload.oldName, payload.newName);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getLog', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getLog(payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getCommit', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getCommit(payload.repoDir, payload.ref);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.listRemotes', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.listRemotes(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.addRemote', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.addRemote(payload.repoDir, payload.name, payload.url);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.removeRemote', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.removeRemote(payload.repoDir, payload.name);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.setRemoteUrl', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.setRemoteUrl(payload.repoDir, payload.name, payload.url);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.fetch', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.fetch(payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.pull', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.pull(payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.push', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.push(payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getConfig', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getConfig(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.setConfig', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const { repoDir, ...config } = payload;
    const result = await svc.setConfig(repoDir, config);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getVersion', async (_payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getGitVersion();
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.semanticDiffCommits', async (payload, deps, _ctx) => {
    // Phase 4 implementation — see semantic-diff-bridge.ts
    const { createSemanticDiffBridge } = await import('./semantic-diff-bridge.js');
    const bridge = createSemanticDiffBridge(deps.dbModule);
    return bridge.diffCommits(payload, deps);
  }, GIT_CHANNEL_META);

  registry.register('git.ensureGitignore', async (payload, deps, _ctx) => {
    return ensureGitignore(payload.repoDir);
  }, GIT_CHANNEL_META);

  registry.register('git.getWorkspaceConfig', async (payload, _deps, _ctx) => {
    return loadWorkspaceGitConfig(payload.workingDir);
  }, GIT_CHANNEL_META);

  registry.register('git.saveWorkspaceConfig', async (payload, _deps, _ctx) => {
    const { workingDir, config } = payload;
    await saveWorkspaceGitConfig(workingDir, config);
  }, GIT_CHANNEL_META);

  registry.register('git.listTags', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.listTags(payload.repoDir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);

  registry.register('git.getRepoRoot', async (payload, deps, _ctx) => {
    const svc = deps.gitService;
    if (!svc) throw new Error('Git service not available');
    const result = await svc.getRepoRoot(payload.dir);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }, GIT_CHANNEL_META);
}
