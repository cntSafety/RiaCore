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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/riacore';
import type { NamespaceCheckSummary } from '@riacore/app-contracts';

/**
 * Loads applicable checks for the given namespace.
 * Automatically re-fetches when the namespace changes.
 */
export function useLoadApplicableChecks(namespace: string) {
  return useQuery({
    queryKey: ['checks.loadApplicable', namespace],
    queryFn: () => api.checks.loadApplicable(namespace),
    enabled: !!namespace,
  });
}

/**
 * Mutation hook to run a check. Returns `CheckRunSummary` including the first
 * page of violations and a `runId` for subsequent pagination.
 */
export function useRunCheck() {
  return useMutation({
    mutationFn: ({
      checkId,
      namespace,
      pageSize,
    }: {
      checkId: string;
      namespace: string;
      pageSize?: number;
    }) => api.checks.runCheck(checkId, namespace, pageSize),
  });
}

/**
 * Fetches an arbitrary page of violations for an already-started check run.
 */
export function useCheckPage(runId: string | null, page: number, pageSize: number) {
  return useQuery({
    queryKey: ['checks.getPage', runId, page, pageSize],
    queryFn: () => api.checks.getPage(runId!, page, pageSize),
    enabled: !!runId,
  });
}

/**
 * Loads the persisted check selection for a namespace.
 * Returns null when no selection has been saved yet for this namespace.
 */
export function useLoadCheckSelection(namespace: string) {
  return useQuery({
    queryKey: ['checks.loadSelection', namespace],
    queryFn: () => api.checks.loadSelection(namespace),
    enabled: !!namespace,
    // Stale time: short — we want fresh data when the view opens
    staleTime: 0,
  });
}

/**
 * Mutation hook to persist the check selection for a namespace.
 * Invalidates the loadSelection query on success so any concurrent readers
 * see the updated selection.
 */
export function useSaveCheckSelection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ namespace, selectedIds }: { namespace: string; selectedIds: string[] }) =>
      api.checks.saveSelection(namespace, selectedIds),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['checks.loadSelection', variables.namespace] });
    },
  });
}

/**
 * Loads the persisted check summary for a namespace.
 * The backend computes `isOutdated` at load time.
 * Returns null when no summary exists yet.
 */
export function useLoadCheckSummary(namespace: string | null | undefined) {
  return useQuery<NamespaceCheckSummary | null>({
    queryKey: ['checks.loadSummary', namespace],
    queryFn: () => api.checks.loadSummary(namespace!),
    enabled: !!namespace,
    // Refetch when the window regains focus so the outdated flag stays current
    refetchOnWindowFocus: true,
  });
}

/**
 * Mutation hook to persist the aggregated check summary for a namespace.
 * Invalidates the loadSummary query on success.
 */
export function useSaveCheckSummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      errors,
      warnings,
      hints,
      checksRun,
    }: {
      namespace: string;
      errors: number;
      warnings: number;
      hints: number;
      checksRun: number;
    }) => api.checks.saveSummary(namespace, errors, warnings, hints, checksRun),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['checks.loadSummary', variables.namespace] });
    },
  });
}
