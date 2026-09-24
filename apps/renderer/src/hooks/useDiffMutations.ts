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
 * TanStack Query mutations for the Diff and Merge feature.
 *
 * All mutations use the global `api.diff` API layer and update the
 * `useDiffStore` on success.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/riacore';
import { useDiffStore } from '../store/diffStore';
import type { DiffOptions, DiffResultSection, ConflictResolution } from '@riacore/app-contracts';
import { useWorkspaceStore } from '../store/workspaceStore';
import { invalidateAfterContentChange } from './workspaceCacheReset';

// ── Compute two-way diff ──────────────────────────────────────────────────────

export function useComputeDiff() {
  const { setActiveSummary } = useDiffStore();
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');

  return useMutation({
    mutationFn: async ({
      leftNs, rightNs, opts,
    }: { leftNs: string; rightNs: string; opts?: DiffOptions }) => {
      return api.diff.computeNamespaces(leftNs, rightNs, workingDir, opts);
    },
    onSuccess: (summary) => setActiveSummary(summary),
  });
}

// ── Compute three-way diff ────────────────────────────────────────────────────

export function useComputeThreeWayDiff() {
  const { setActiveThreeWaySummary } = useDiffStore();
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');

  return useMutation({
    mutationFn: async ({
      baseNs, leftNs, rightNs, opts,
    }: { baseNs: string; leftNs: string; rightNs: string; opts?: DiffOptions }) => {
      return api.diff.computeThreeWay(baseNs, leftNs, rightNs, workingDir, opts);
    },
    onSuccess: (summary) => setActiveThreeWaySummary(summary),
  });
}

// ── Fetch a page of diff results ──────────────────────────────────────────────

export function useDiffResultPage(
  diffId: string | null,
  section: DiffResultSection,
  offset: number,
  limit: number,
  filters?: {
    filterText?: string;
    filterConceptType?: string;
    filterRelationshipType?: string;
  },
) {
  return useQuery({
    queryKey: ['diff', 'page', diffId, section, offset, limit, filters],
    queryFn: () =>
      api.diff.getResultPage(
        diffId!,
        section,
        offset,
        limit,
        filters?.filterText,
        filters?.filterConceptType,
        filters?.filterRelationshipType,
      ),
    enabled: !!diffId,
    staleTime: Infinity,  // result pages don't change once computed
    gcTime: Infinity,     // invalidation-only / re-fetchable by diffId; keep GC-immune (see useTreeQueries gcTime rule)
  });
}

// ── Fetch full diff result (used for graph view) ──────────────────────────────

export function useDiffResult(diffId: string | null) {
  return useQuery({
    queryKey: ['diff', 'result', diffId],
    queryFn: () => api.diff.getDiffResult(diffId!),
    enabled: !!diffId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ── Fetch three-way result ────────────────────────────────────────────────────

export function useThreeWayDiffResult(diffId: string | null) {
  return useQuery({
    queryKey: ['diff', 'threeWay', diffId],
    queryFn: () => api.diff.getThreeWayResult(diffId!),
    enabled: !!diffId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ── Export an HTML report of the change set ───────────────────────────────────

/**
 * Write a standalone HTML report of a computed diff, for archiving a reviewed
 * change set.
 *
 * No cache invalidation: this only reads the stored diff result and writes a
 * file outside the workspace data, so no query becomes stale.
 */
export function useExportDiffHtml() {
  return useMutation({
    mutationFn: async (params: {
      diffId: string;
      outputPath: string;
      targetNamespace?: string;
      sourceRef?: string;
      sourceCommit?: string;
      selectedChangeIds?: string[];
    }) => api.diff.exportHtml(params),
  });
}

// ── Apply merge ───────────────────────────────────────────────────────────────

export function useApplyMerge() {
  const queryClient = useQueryClient();
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');
  const { reset } = useDiffStore();

  return useMutation({
    mutationFn: async ({
      diffId, targetNs, direction, selectionIds,
    }: {
      diffId: string;
      targetNs: string;
      direction: 'left-into-right' | 'right-into-left';
      selectionIds?: string[];
    }) => {
      return api.diff.applyMerge(diffId, targetNs, direction, workingDir, selectionIds);
    },
    onSuccess: async () => {
      reset();
      // Merged content introduces new node IDs across the target namespace, so
      // every DB-content cache is stale (see workspaceCacheReset.ts). The
      // `['diff', diffId]` caches are flow-scoped and deliberately untouched —
      // the backend may dispose the diff on merge, so refetching one from a view
      // that is still mounted would surface a spurious error.
      await invalidateAfterContentChange(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Clear all node-ID-bearing Zustand state — merged content reassigns node
      // IDs so any persisted selectedElement or navigation entry is now stale.
      useWorkspaceStore.getState().resetWorkspaceState();
    },
  });
}

// ── Apply three-way merge ─────────────────────────────────────────────────────

export function useApplyThreeWayMerge() {
  const queryClient = useQueryClient();
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');
  const { reset } = useDiffStore();

  return useMutation({
    mutationFn: async ({
      diffId, targetNs, resolutions,
    }: {
      diffId: string;
      targetNs: string;
      resolutions: ConflictResolution[];
    }) => {
      return api.diff.applyThreeWayMerge(diffId, targetNs, resolutions, workingDir);
    },
    onSuccess: async () => {
      reset();
      // Same teardown as the two-way merge — see the note there on why the
      // flow-scoped `['diff', …]` caches are left alone.
      await invalidateAfterContentChange(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Clear all node-ID-bearing Zustand state — merged content reassigns node
      // IDs so any persisted selectedElement or navigation entry is now stale.
      useWorkspaceStore.getState().resetWorkspaceState();
    },
  });
}
