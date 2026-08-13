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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ImportConfigView,
  ImportRunSummary,
  ImporterInfo,
  LoadResult,
  RendererLogEntry,
  RepairManifestResult,
  SaveImportConfigParams,
  StoreResult,
  CreatedNamespaceInfo,
} from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useImportRunStore } from '../store/importRunStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  resetWorkspaceScopedQueries,
  invalidateAfterContentChange,
} from './workspaceCacheReset';

async function reportMutationError(component: string, message: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
  const payload: RendererLogEntry = {
    level: 'error',
    type: 'mutation.error',
    component,
    message,
    stack: error instanceof Error ? error.stack : undefined,
    context: {
      ...(context ?? {}),
      error: error instanceof Error ? error.message : String(error),
    },
  };

  try {
    await api.app.logRendererEvent(payload);
  } catch (reportError) {
    console.error('[Renderer] Failed to report mutation error', {
      component,
      message,
      reportError: reportError instanceof Error ? reportError.message : String(reportError),
    });
  }
}

/**
 * Auto-persist a freshly imported namespace to disk via a namespace-scoped
 * `persistor.store`, mirroring the safety editor's `useAutoSave` behavior.
 *
 * Called from the DIRECT import mutations only (`imports.run` /
 * `imports.runFromSource`). Supervised/branch/diff flows import into temporary
 * namespaces and must NOT be auto-persisted — they never go through these
 * mutations, so this helper is never reached for them.
 *
 * Best-effort: a persistence failure is logged but never fails the import (the
 * DB already holds the imported data; a manual/full store can recover it).
 */
async function autoPersistImportedNamespace(
  workingDir: string,
  summary: ImportRunSummary,
): Promise<void> {
  // Only persist a successfully completed import that produced a namespace.
  if (summary.status !== 'completed') return;
  const namespace = summary.namespace?.trim();
  if (!namespace) return;
  try {
    await api.persistor.store({ workingDir, namespace });
  } catch (error) {
    await reportMutationError(
      'autoPersistImportedNamespace',
      'Auto-save after direct import failed',
      error,
      { workingDir, namespace },
    );
  }
}

function resolveWorkingDir(source: string | null | undefined | (() => string | null | undefined)): string {
  const value = typeof source === 'function' ? source() : source;
  const workingDir = typeof value === 'string' ? value.trim() : '';
  if (!workingDir) {
    throw new Error('No workspace selected');
  }
  return workingDir;
}

function toSaveImportConfigParams(values: ImportConfigView, sourceId: string): SaveImportConfigParams {
  return {
    sourceId,
    sourceType: values.sourceType,
    namespace: values.namespace,
    sourceName: values.sourceName,
    projectDir: values.projectDir ?? '',
    scanResultDir: values.scanResultDir,
    needsFile: values.needsFile,
    filesInclude: values.filesInclude ?? [],
    filesExclude: values.filesExclude ?? [],
    elements: values.elements ?? {},
    configPath: values.configPath,
  };
}

export function useOpenWorkspaceMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (workingDir: string) => {
      const normalized = resolveWorkingDir(workingDir);
      await api.workspace.open(normalized);
      return normalized;
    },
    onSuccess: () => {
      // Remove (not just invalidate) all workspace-scoped query caches so stale
      // data from the previous workspace is never visible during the transition.
      resetWorkspaceScopedQueries(queryClient);
      // Then invalidate workspace status so the UI reflects the new workspace.
      queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
    },
  });
}

export function useProvisionImporterMutation(importers: ImporterInfo[]) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      importerName,
      namespace,
      workingDir,
    }: {
      importerName: string;
      namespace: string;
      workingDir: string;
    }) => {
      const sourceId = await api.importers.provisionConfig({
        importerName,
        workingDir: resolveWorkingDir(workingDir),
        namespace,
      });

      const selectedImporter = importers.find((item) => item.name === importerName);
      return {
        sourceId,
        sourceType: selectedImporter?.sourceType ?? importerName,
        namespace,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['imports.listSources'] });
    },
  });
}

export function useSaveImportConfigMutation(workingDir?: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ values, sourceId }: { values: ImportConfigView; sourceId: string }) => {
      const params = toSaveImportConfigParams(values, sourceId);
      await api.imports.saveConfig(params);
      return { sourceId, workingDir: workingDir ?? '', params };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['imports.listSources'] });
      queryClient.invalidateQueries({
        queryKey: ['imports.getConfig', workingDir || 'no-workspace', variables.sourceId],
      });
    },
  });
}

export function useRunImportSourceMutation(workingDirSource: string | null | undefined | (() => string | null | undefined)) {
  const queryClient = useQueryClient();
  const { startRun, endRun } = useImportRunStore();

  return useMutation<ImportRunSummary, Error, { sourceId: string; sourceName: string }>({
    mutationFn: async ({ sourceId, sourceName }) => {
      const workingDir = resolveWorkingDir(workingDirSource);
      startRun(sourceId, sourceName);
      return api.imports.runFromSource({ sourceId, workingDir });
    },
    onSuccess: async (_data, variables) => {
      endRun(variables.sourceId, 'done');
      // Auto-persist the freshly imported namespace to disk (namespace-scoped
      // store), mirroring the safety editor's useAutoSave. Rationale for placing
      // this trigger in the renderer mutation onSuccess (rather than a backend
      // choke point): imports.run AND imports.runFromSource both call
      // deps.orchestration.runImport, but so do the branch flows
      // (runFromSourceAtRef, updateFromImportedBranch) which import into TEMP
      // namespaces and must NOT be auto-persisted (they persist
      // via their own merge/diff paths). Those flows do NOT go through this
      // mutation, so triggering here is the safe, targeted direct-import choke
      // point and follows the api → hook → mutation architecture. Best-effort:
      // a persist failure must not fail the import itself.
      await autoPersistImportedNamespace(resolveWorkingDir(workingDirSource), _data);
      // Re-import wipes and rewrites the imported namespace and reconnects
      // cross-namespace edges, so every DB-content cache is stale and node IDs
      // are reassigned — one canonical refresh (see workspaceCacheReset.ts).
      await invalidateAfterContentChange(queryClient);
      queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Clear all node-ID-bearing Zustand state — re-import reassigns node IDs
      // so any persisted selectedElement or navigation entry is now stale.
      useWorkspaceStore.getState().resetWorkspaceState();
    },
    onError: (error, variables) => {
      endRun(variables.sourceId, 'error', error.message);
      void reportMutationError('useRunImportSourceMutation', 'Import source mutation failed', error, {
        sourceId: variables.sourceId,
        sourceName: variables.sourceName,
      });
    },
  });
}

/**
 * Run an import for an existing source against files at a specific git ref
 * (branch or tag), writing directly into the source's real namespace.
 *
 * This is the "Run update from branch" flow (UC-9). It is deliberately IDENTICAL
 * to `useRunImportSourceMutation` in every post-import step — auto-persist,
 * cache invalidation, and workspace-state reset — so that updating from a branch
 * behaves exactly like re-running the importer after manually pointing the
 * source at the branch files. The ONLY difference is the source of the files:
 * `imports.runFromSourceAtRef` checks the ref out to a temp dir and imports from
 * there (and records git provenance server-side). It writes to the real
 * namespace, so it produces the same ImportRunSummary + impact report + orphan
 * reconnection as a normal run.
 */
export function useRunImportSourceAtRefMutation(workingDirSource: string | null | undefined | (() => string | null | undefined)) {
  const queryClient = useQueryClient();
  const { startRun, endRun } = useImportRunStore();

  return useMutation<ImportRunSummary, Error, { sourceId: string; sourceName: string; repoDir: string; ref: string }>({
    mutationFn: async ({ sourceId, sourceName, repoDir, ref }) => {
      const workingDir = resolveWorkingDir(workingDirSource);
      startRun(sourceId, sourceName);
      return api.imports.runFromSourceAtRef(sourceId, repoDir, ref, workingDir);
    },
    onSuccess: async (_data, variables) => {
      endRun(variables.sourceId, 'done');
      // Same post-import processing as the direct Run flow: auto-persist to disk,
      // refresh every DB-content cache, and reset node-ID-bearing Zustand state
      // (re-import reassigns node IDs). See useRunImportSourceMutation.
      await autoPersistImportedNamespace(resolveWorkingDir(workingDirSource), _data);
      await invalidateAfterContentChange(queryClient);
      queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      useWorkspaceStore.getState().resetWorkspaceState();
    },
    onError: (error, variables) => {
      endRun(variables.sourceId, 'error', error.message);
      void reportMutationError('useRunImportSourceAtRefMutation', 'Import from branch mutation failed', error, {
        sourceId: variables.sourceId,
        sourceName: variables.sourceName,
        ref: variables.ref,
      });
    },
  });
}

export function usePersistorLoadMutation(workingDirSource: string | null | undefined | (() => string | null | undefined)) {
  const queryClient = useQueryClient();

  return useMutation<LoadResult, Error, void>({
    mutationFn: async () => {
      const workingDir = resolveWorkingDir(workingDirSource);
      return api.persistor.load({ workingDir });
    },
    onSuccess: () => {
      // A ria-data load rebuilds the ENTIRE DB from the JSON files and
      // reassigns node IDs, so every workspace-scoped cache entry is stale —
      // this is the same teardown as a workspace open (see workspaceCacheReset.ts).
      // Removal, not invalidation: the connection graph and diagram layout use
      // staleTime: Infinity and would otherwise keep rendering the pre-load state.
      resetWorkspaceScopedQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Clear all node-ID-bearing Zustand state — node IDs may have changed after load
      useWorkspaceStore.getState().resetWorkspaceState();
    },
  });
}

export function useCreateAuthoredNamespaceMutation(workingDirSource: string | null | undefined | (() => string | null | undefined)) {
  const queryClient = useQueryClient();

  return useMutation<
    CreatedNamespaceInfo,
    Error,
    { profileId: string; namespace: string; overwrite?: boolean }
  >({
    mutationFn: async ({ profileId, namespace, overwrite }) => {
      const workingDir = resolveWorkingDir(workingDirSource);
      await api.workspace.open(workingDir);
      const info = await api.namespaces.createAuthored({
        workingDir,
        profileId,
        namespace,
        overwrite,
      });
      // Auto-persist the freshly created authored namespace to disk via a
      // namespace-scoped store, mirroring the import auto-save
      // (autoPersistImportedNamespace) and the safety editor's useAutoSave.
      // createAuthored only writes to the in-memory DB; without this store the
      // namespace's namespace.json + manifest entry never reach disk, so a
      // created-but-never-opened analysis (no malfunctions yet) would vanish on
      // the next workspace reopen even though its canvas tile position was
      // auto-saved. Best-effort: a failure is reported but does not fail
      // creation (a later edit or full store can recover it).
      try {
        await api.persistor.store({ workingDir, namespace: info.namespace });
      } catch (error) {
        await reportMutationError(
          'useCreateAuthoredNamespaceMutation',
          'Auto-save after authored namespace creation failed',
          error,
          { workingDir, namespace: info.namespace },
        );
      }
      return info;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['namespaces.list'] });
      queryClient.invalidateQueries({ queryKey: ['db.stats'] });
      queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
    },
    onError: (error, variables) => {
      void reportMutationError('useCreateAuthoredNamespaceMutation', 'Create authored namespace mutation failed', error, {
        profileId: variables.profileId,
        namespace: variables.namespace,
        overwrite: variables.overwrite ?? false,
      });
    },
  });
}

export function usePersistorStoreMutation(workingDirSource: string | null | undefined | (() => string | null | undefined)) {
  return useMutation<StoreResult, Error, void>({
    mutationFn: async () => {
      const workingDir = resolveWorkingDir(workingDirSource);
      return api.persistor.store({ workingDir });
    },
  });
}

export function useDeleteImportSourceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.imports.deleteSource(sourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['imports.listSources'] });
      queryClient.invalidateQueries({ queryKey: ['namespaces.list'] });
      queryClient.invalidateQueries({ queryKey: ['db.stats'] });
    },
  });
}

export function useDeleteNamespaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (namespace: string) => api.namespaces.delete(namespace),
    onSuccess: async () => {
      // Deleting a namespace removes its nodes and shifts the remaining node
      // IDs, so every DB-content cache is stale — not just namespaces.list and
      // db.stats, which is all this used to refresh.
      await invalidateAfterContentChange(queryClient);
      // Clear all node-ID-bearing Zustand state — entries referencing the
      // deleted namespace are invalid, and remaining node IDs may have shifted.
      useWorkspaceStore.getState().resetWorkspaceState();
    },
  });
}

export function useRunImportMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    ImportRunSummary,
    Error,
    { workingDir: string; configPath: string }
  >({
    mutationFn: async ({ workingDir, configPath }) => {
      const normalized = resolveWorkingDir(workingDir);
      await api.workspace.open(normalized);
      return api.imports.run({
        workingDir: normalized,
        configPath: configPath.trim(),
        triggeredBy: 'gui',
      });
    },
    onSuccess: async (_data, variables) => {
      // Auto-persist the freshly imported namespace to disk (namespace-scoped
      // store). This is the config-path DIRECT import path; see the rationale on
      // useRunImportSourceMutation for why the trigger lives in the renderer
      // mutation and not a shared backend choke point (supervised/branch/diff
      // flows share deps.orchestration.runImport but must not auto-persist).
      await autoPersistImportedNamespace(resolveWorkingDir(variables.workingDir), _data);
      // This path previously refreshed only workspace.status, db.stats and
      // imports.listSources — the tree and every safety view kept pre-import
      // node IDs until something else happened to refetch them.
      await invalidateAfterContentChange(queryClient);
      queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Clear all node-ID-bearing Zustand state — re-import reassigns node IDs
      // so any persisted selectedElement or navigation entry is now stale.
      useWorkspaceStore.getState().resetWorkspaceState();
    },
  });
}

/**
 * Recomputes namespace hashes from on-disk JSON files and updates manifest.json.
 *
 * This mutation does NOT require an open workspace — it operates purely on the
 * filesystem. Its primary use case is recovering from a hash mismatch that
 * prevents workspace.open() from succeeding (e.g. after manual JSON edits).
 *
 * After repair succeeds the caller should retry workspace.open() so the
 * workspace loads with the corrected hashes.
 */
export function usePersistorRepairMutation() {
  return useMutation<RepairManifestResult, Error, string>({
    mutationFn: (workingDir: string) =>
      api.persistor.repairManifest({ workingDir }),
  });
}
