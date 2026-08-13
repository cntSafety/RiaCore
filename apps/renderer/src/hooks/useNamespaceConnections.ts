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
 * TanStack Query data layer for manual namespace connections
 * (the Overview_Canvas + CLI-parity feature).
 *
 * - `useNamespaceConnections` — the single query hook for the connection graph
 *   query key. It is invalidation-driven (`staleTime: Infinity`) and therefore
 *   must also set `gcTime: Infinity`: the canvas may unmount (no observer) while
 *   a connect/disconnect mutation invalidates the key, and with the default
 *   gcTime the query would be evicted and the invalidation would silently
 *   no-op. See the gcTime rule in `ui-data-architecture.md` / `ui-tree-sync.md`.
 * - `useConnectMutation` / `useDisconnectMutation` — mutations that use
 *   `invalidateQueries` (never manual `setQueryData`) over the connection-graph
 *   key, the `tree.*` keys, and `namespaces.list`. Because connecting or
 *   disconnecting changes which imported namespaces are visible inside an
 *   analysis's tree, we invalidate `tree.children` per the tree-sync guidance.
 *   Both use `async onSuccess` + `await Promise.all([...])` so the mutation
 *   stays `isPending` until every cache is consistent.
 *
 * Note: connect/disconnect do NOT reassign database node IDs (the per-pair edge
 * is keyed by namespace name), so `resetWorkspaceState()` is intentionally NOT
 * called here — invalidation alone is sufficient. See `workspace-node-id-reset.md`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  NamespaceConnectionGraph,
  ConnectionEntry,
  DisconnectResult,
} from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceState } from './useWorkspaceState';

/**
 * Canonical query key for the connection graph. Workspace-scoped so it does not
 * leak across workspaces; mutations invalidate by the `['namespaceConnections']`
 * prefix, which matches regardless of the trailing workspace key.
 */
export function namespaceConnectionsQueryKey(
  workspaceKey: string | null,
): readonly unknown[] {
  return ['namespaceConnections', 'graph', workspaceKey] as const;
}

/**
 * Query hook for the full namespace connection graph (imported list, analysis
 * list, and the connections between them). Enabled only while the DB is open.
 */
export function useNamespaceConnections() {
  const ws = useWorkspaceState();
  const workspaceKey = ws.phase !== 'no_workspace' ? ws.workingDir : null;
  const enabled = ws.phase === 'db_open';

  return useQuery<NamespaceConnectionGraph>({
    queryKey: namespaceConnectionsQueryKey(workspaceKey),
    queryFn: () => api.namespaceConnections.getGraph(),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * Build the full set of cache invalidations a connect/disconnect must perform.
 * Returns the promises so callers can `await Promise.all([...])` inside an
 * `async onSuccess`, keeping the mutation pending until caches are consistent.
 *
 * Invalidates:
 * - the connection-graph key (prefix `['namespaceConnections']`) so the canvas
 *   re-renders exactly one edge added/removed,
 * - `namespaces.list` (connectivity affects namespace-derived views),
 * - `tree.namespaces` and every loaded `tree.children` branch for the workspace,
 *   because a connected imported namespace appears/disappears in the analysis
 *   tree (tree-sync guidance, Req 3.5 / 5.6).
 */
function invalidateConnectionCaches(
  queryClient: QueryClient,
  workspaceKey: string | null,
): Promise<unknown>[] {
  return [
    queryClient.invalidateQueries({ queryKey: ['namespaceConnections'] }),
    queryClient.invalidateQueries({ queryKey: ['namespaces.list'] }),
    queryClient.invalidateQueries({ queryKey: ['tree.namespaces'] }),
    queryClient.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey;
        return (
          Array.isArray(key) &&
          key[0] === 'tree.children' &&
          (!workspaceKey || key[1] === workspaceKey)
        );
      },
    }),
  ];
}

/**
 * Mutation: connect an imported namespace to an analysis namespace
 * (imported → authored). Idempotent on the backend; the returned
 * `ConnectionEntry.alreadyConnected` reports whether the edge pre-existed.
 */
export function useConnectMutation() {
  const queryClient = useQueryClient();
  const ws = useWorkspaceState();
  const workspaceKey = ws.phase !== 'no_workspace' ? ws.workingDir : null;

  return useMutation<
    ConnectionEntry,
    Error,
    { sourceNamespace: string; targetNamespace: string }
  >({
    mutationFn: ({ sourceNamespace, targetNamespace }) =>
      api.namespaceConnections.connect(sourceNamespace, targetNamespace),
    onSuccess: async () => {
      await Promise.all(invalidateConnectionCaches(queryClient, workspaceKey));
    },
  });
}

/**
 * Mutation: disconnect an imported namespace from an analysis namespace. When
 * `deleteDependents` is true the pair's dependent cross-namespace relationship
 * instances are also removed (the confirm flow supplies this — see task 11.3).
 */
export function useDisconnectMutation() {
  const queryClient = useQueryClient();
  const ws = useWorkspaceState();
  const workspaceKey = ws.phase !== 'no_workspace' ? ws.workingDir : null;

  return useMutation<
    DisconnectResult,
    Error,
    { importedNamespace: string; authoredNamespace: string; deleteDependents: boolean }
  >({
    mutationFn: ({ importedNamespace, authoredNamespace, deleteDependents }) =>
      api.namespaceConnections.disconnect(importedNamespace, authoredNamespace, deleteDependents),
    onSuccess: async () => {
      await Promise.all(invalidateConnectionCaches(queryClient, workspaceKey));
    },
  });
}

/**
 * Imperative helper for the disconnect confirmation flow: count the dependent
 * cross-namespace relationship instances for a specific (imported, authored)
 * pair before mutating. Called directly (not as a mounted query) inside the
 * canvas's `Modal.confirm` path (task 11.3), so it is exposed as a thin wrapper
 * over the API layer rather than a query hook.
 */
export function countDependents(
  importedNamespace: string,
  authoredNamespace: string,
): Promise<number> {
  return api.namespaceConnections.countDependents(importedNamespace, authoredNamespace);
}
