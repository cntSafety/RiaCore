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
 * TanStack Query hooks for Git operations.
 *
 * All hooks read the workspace working dir from Zustand store (useWorkspaceStore).
 * Mutations invalidate the relevant queries on success.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/riacore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import type { CommitParams, LogParams, FetchParams, PullParams, PushParams } from '@riacore/git-service';
import type { WorkspaceGitConfig } from '@riacore/app-contracts';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const gitKeys = {
  all: (repoDir: string) => ['git', repoDir] as const,
  isRepo: (dir: string) => ['git', 'isRepo', dir] as const,
  status: (repoDir: string) => ['git', 'status', repoDir] as const,
  log: (repoDir: string, params?: Partial<LogParams>) => ['git', 'log', repoDir, params] as const,
  branches: (repoDir: string) => ['git', 'branches', repoDir] as const,
  remotes: (repoDir: string) => ['git', 'remotes', repoDir] as const,
  config: (repoDir: string) => ['git', 'config', repoDir] as const,
  version: () => ['git', 'version'] as const,
  workspaceConfig: (workingDir: string) => ['git', 'workspaceConfig', workingDir] as const,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useGitIsRepo(repoDir: string) {
  return useQuery({
    queryKey: gitKeys.isRepo(repoDir),
    queryFn: () => api.git.isRepo(repoDir),
    enabled: !!repoDir,
  });
}

export function useGitStatus(repoDir: string, enabled = true) {
  return useQuery({
    queryKey: gitKeys.status(repoDir),
    queryFn: () => api.git.getStatus(repoDir),
    enabled: enabled && !!repoDir,
    refetchInterval: 5000,
  });
}

export function useGitLog(repoDir: string, params?: Partial<LogParams>) {
  return useQuery({
    queryKey: gitKeys.log(repoDir, params),
    queryFn: () => api.git.getLog({ repoDir, ...params }),
    enabled: !!repoDir,
  });
}

export function useGitBranches(repoDir: string, enabled = true) {
  return useQuery({
    queryKey: gitKeys.branches(repoDir),
    queryFn: () => api.git.listBranches(repoDir),
    enabled: enabled && !!repoDir,
  });
}

export function useGitRemotes(repoDir: string, enabled = true) {
  return useQuery({
    queryKey: gitKeys.remotes(repoDir),
    queryFn: () => api.git.listRemotes(repoDir),
    enabled: enabled && !!repoDir,
  });
}

export function useGitConfig(repoDir: string, enabled = true) {
  return useQuery({
    queryKey: gitKeys.config(repoDir),
    queryFn: () => api.git.getConfig(repoDir),
    enabled: enabled && !!repoDir,
  });
}

export function useGitVersion() {
  return useQuery({
    queryKey: gitKeys.version(),
    queryFn: () => api.git.getVersion(),
    staleTime: Infinity,
    // gcTime rule: a query that never goes stale is refreshed only by
    // invalidation, and an invalidation no-ops once the entry has been garbage
    // collected (the version panel is rarely mounted). Workspace transitions
    // drop it explicitly via resetWorkspaceScopedQueries.
    gcTime: Infinity,
  });
}

export function useWorkspaceGitConfig() {
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');
  return useQuery({
    queryKey: gitKeys.workspaceConfig(workingDir),
    queryFn: () => api.git.getWorkspaceConfig(workingDir),
    enabled: !!workingDir,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useGitInit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dir, initialBranch }: { dir: string; initialBranch?: string }) =>
      api.git.init(dir, initialBranch),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: gitKeys.isRepo(vars.dir) });
      void qc.invalidateQueries({ queryKey: gitKeys.status(vars.dir) });
    },
  });
}

export function useGitStageAll(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.git.stageAll(repoDir),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) }); },
  });
}

export function useGitUnstageAll(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.git.unstageAll(repoDir),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) }); },
  });
}

export function useGitCommit(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CommitParams) => api.git.commit(params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.log(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.branches(repoDir) });
    },
  });
}

export function useGitCreateBranch(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, from }: { name: string; from?: string }) =>
      api.git.createBranch(repoDir, name, from),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: gitKeys.branches(repoDir) }); },
  });
}

export function useGitCheckoutBranch(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.git.checkoutBranch(repoDir, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: gitKeys.branches(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) });
    },
  });
}

export function useGitDeleteBranch(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, force }: { name: string; force?: boolean }) =>
      api.git.deleteBranch(repoDir, name, force),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: gitKeys.branches(repoDir) }); },
  });
}

export function useGitFetch(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Omit<FetchParams, 'repoDir'>) =>
      api.git.fetch({ repoDir, ...params }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.remotes(repoDir) });
    },
  });
}

export function useGitPull(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Omit<PullParams, 'repoDir'>) =>
      api.git.pull({ repoDir, ...params }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.log(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.branches(repoDir) });
    },
  });
}

export function useGitPush(repoDir: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Omit<PushParams, 'repoDir'>) =>
      api.git.push({ repoDir, ...params }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.branches(repoDir) });
    },
  });
}

export function useEnsureGitignore(repoDir: string) {
  return useMutation({
    mutationFn: () => api.git.ensureGitignore(repoDir),
  });
}

export function useSaveWorkspaceGitConfig() {
  const qc = useQueryClient();
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');
  return useMutation({
    mutationFn: (config: WorkspaceGitConfig) => api.git.saveWorkspaceConfig(workingDir, config),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: gitKeys.workspaceConfig(workingDir) }); },
  });
}
