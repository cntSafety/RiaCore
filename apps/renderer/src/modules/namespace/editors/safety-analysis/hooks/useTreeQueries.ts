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
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../api/riacore';
import type { NamespaceInfo, GetChildrenResponse } from '@riacore/app-contracts';

/** Fetch all namespaces and filter to imported ones. */
export function useImportedNamespaces() {
  return useQuery({
    queryKey: ['tree.namespaces', 'imported'],
    queryFn: async () => {
      const all = await api.namespaces.list();
      return all.filter((ns: NamespaceInfo) => ns.role === 'imported');
    },
    refetchOnMount: 'always',
  });
}

/** Fetch all namespaces (imported + authored). Disabled when no workspace is open. */
export function useAllNamespaces(workspaceKey: string | null) {
  return useQuery({
    queryKey: ['tree.namespaces', 'all', workspaceKey],
    queryFn: async () => {
      const all = await api.namespaces.list();
      return all;
    },
    enabled: !!workspaceKey,
    refetchOnMount: 'always',
  });
}

/**
 * Build the canonical query key for a tree.children query.
 * Used by both the hook and mutation invalidations to ensure they match.
 */
export function treeChildrenQueryKey(
  workspaceKey: string | null,
  namespace: string,
  parentNodeId?: number,
  showAll = false,
  scopeNamespace?: string,
): readonly unknown[] {
  // scopeNamespace is appended ONLY when provided so that invalidations built
  // without it (the 5-element key) remain a proper prefix of the scoped key and
  // therefore still match it. Appending an explicit `undefined` would break
  // that prefix match (undefined !== safetyNamespace at that position).
  const base = ['tree.children', workspaceKey, namespace, parentNodeId, showAll] as const;
  return scopeNamespace !== undefined ? [...base, scopeNamespace] : base;
}

/**
 * Lazy-load children of a tree node (or roots when parentNodeId is undefined).
 *
 * Key design decisions:
 * - staleTime: Infinity — tree children only refetch when explicitly invalidated
 *   by a mutation (via invalidateQueries). They do NOT refetch on window focus,
 *   remount, or reconnect. This prevents the tree from flickering on every
 *   focus event and makes the invalidation pattern the single source of truth.
 * - gcTime: Infinity — these queries are inactive (the tree keeps its nodes in a
 *   local reducer and mounts no observer for loaded branches), so with the
 *   default gcTime they would be garbage collected after ~5 min idle. Once
 *   collected, invalidateQueries matches nothing and the tree-sync subscription
 *   never refreshes the branch — leaving stale nodes after delete/rename. Set as
 *   a query default in appQueryClient.ts / spawnQueryClient.ts (covers fetchQuery
 *   and setQueryData paths too); repeated here so the hook is self-consistent.
 *   Workspace transitions removeQueries(['tree.children']), so nothing leaks.
 * - Workspace-scoped: workspaceKey in the query key prevents cross-workspace
 *   cache pollution and disables the query when no workspace is open.
 */
export function useTreeChildren(
  workspaceKey: string | null,
  namespace: string,
  parentNodeId?: number,
  showAll = false,
  scopeNamespace?: string,
) {
  return useQuery<GetChildrenResponse>({
    queryKey: treeChildrenQueryKey(workspaceKey, namespace, parentNodeId, showAll, scopeNamespace),
    queryFn: () => api.namespaces.getChildren(namespace, parentNodeId, undefined, undefined, showAll, scopeNamespace),
    enabled: !!workspaceKey && !!namespace,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
