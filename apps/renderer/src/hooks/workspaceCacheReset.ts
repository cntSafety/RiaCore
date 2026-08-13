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
 * `resetWorkspaceScopedQueries` — the single, canonical TanStack Query cache
 * teardown for a workspace lifecycle transition (create / open / close /
 * load-from-ria-data).
 *
 * ## Why this exists (the bug it removes by construction)
 *
 * Before this module, each lifecycle mutation carried its OWN hand-written list
 * of `removeQueries({ queryKey: [...] })` calls. Three copies of an ~12-entry
 * list drifted, and every new query key silently opted out of cleanup. Two real
 * defects came from exactly that:
 *
 * 1. `['namespaceConnections']` and `['canvasLayout.getLayout']` were never in
 *    any list. Both are invalidation-driven (`staleTime: Infinity` +
 *    `gcTime: Infinity`) and their keys do not change when the SAME workspace is
 *    closed and reopened, so the Overview_Canvas kept rendering the connection
 *    set captured earlier in the renderer's lifetime — even after the CLI
 *    recreated the connections on disk or the DB was rebuilt from ria-data. Only
 *    an app restart cleared it.
 * 2. `removeQueries({ queryKey: ['safety.'] })` / `['checks.']` never matched
 *    anything. TanStack compares key elements by deep equality, not string
 *    prefix: `'safety.malfunction' !== 'safety.'`. Those two lines read like
 *    "drop all safety/check caches" but were no-ops.
 *
 * ## The design
 *
 * Instead of enumerating what to REMOVE (a list that must grow with every new
 * query), we enumerate the small, stable set of roots that must SURVIVE a
 * workspace transition and remove everything else. New query keys are therefore
 * workspace-scoped by default — the safe default, since almost every query in
 * this app reads the open workspace's DB and most carry node IDs that are
 * reassigned on every load.
 *
 * Removal (not invalidation) is deliberate: `staleTime: Infinity` queries would
 * ignore an invalidation-driven refetch, and removal drops the entry outright so
 * mounted observers refetch immediately.
 */
import type { QueryClient } from '@tanstack/react-query';
import { requestCrossWindowInvalidation } from '../lib/cache-invalidation-subscriber';

/**
 * Query key roots that are NOT workspace-scoped and must survive a workspace
 * create / open / close / reload.
 *
 * - `workspace.status` — the app-phase source of truth. `useCloseWorkspaceMutation`
 *   deliberately seeds it with `{ state: 'closed' }` before teardown so dependent
 *   queries disable immediately; removing it here would undo that and let
 *   workspace-scoped polls fire against a closed workspace.
 * - `importers.listAvailable`, `profiles.listAvailable` — app-installed plugin and
 *   profile catalogues, independent of any workspace.
 * - `llm.settings` — application-level settings, stored outside the workspace.
 */
export const PRESERVED_QUERY_ROOTS = [
  'workspace.status',
  'importers.listAvailable',
  'profiles.listAvailable',
  'llm.settings',
] as const;

/**
 * Is a query key's first element workspace-scoped (i.e. must be dropped on a
 * workspace transition)? A non-string root is treated as workspace-scoped: the
 * safe default is to drop what we cannot classify.
 */
export function isWorkspaceScopedQueryRoot(root: unknown): boolean {
  if (typeof root !== 'string') return true;
  return !(PRESERVED_QUERY_ROOTS as readonly string[]).includes(root);
}

/**
 * Remove every workspace-scoped query from the cache. Call this from every
 * lifecycle transition that swaps or rebuilds the workspace DB.
 */
export function resetWorkspaceScopedQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => isWorkspaceScopedQueryRoot(query.queryKey[0]),
  });
}

// ---------------------------------------------------------------------------
// Content-change teardown (node-ID-reassigning mutations)
// ---------------------------------------------------------------------------

/**
 * Workspace-scoped roots that belong to an in-flight UI flow rather than to DB
 * content. They are keyed by an ID the flow itself created (a `diffId`, a report
 * `runId`, the active import), so a content mutation that happens DURING that
 * flow must leave them alone — refetching a `diffId` the backend disposed on
 * merge would surface an error in a view that is still mounted. A workspace
 * transition still drops them (they are workspace-scoped, just not content).
 */
export const FLOW_SCOPED_QUERY_ROOTS = [
  'diff',
  'impactReport',
  'imports.getActiveImport',
] as const;

/**
 * Is this query key root DB content — i.e. must it be refreshed whenever the
 * open workspace's content changes (import, merge, namespace delete)?
 */
export function isWorkspaceContentQueryRoot(root: unknown): boolean {
  if (!isWorkspaceScopedQueryRoot(root)) return false;
  if (typeof root !== 'string') return true;
  return !(FLOW_SCOPED_QUERY_ROOTS as readonly string[]).includes(root);
}

/**
 * Refresh every DB-content query after a mutation that rewrites content and
 * REASSIGNS NODE IDS: import, re-import, two-way / three-way / union / supervised
 * merge, namespace delete, update-from-branch, update-from-repo.
 *
 * Callers previously hand-copied a ~6-entry invalidation block; eleven copies had
 * drifted, so `useRunImportMutation` refreshed neither the tree nor any safety
 * view, `useDeleteNamespaceMutation` refreshed almost nothing, and NO caller ever
 * refreshed tags, checks, propagation graphs, ARXML connectors, or the
 * `staleTime: Infinity` rendering-config and canvas-layout caches.
 *
 * Why this is not `resetWorkspaceScopedQueries` (which removes everything):
 *
 * - Active queries are INVALIDATED, not removed. TanStack keeps the previous data
 *   visible while an invalidated active query refetches in the background, so the
 *   tree and canvas do not flash a spinner. Removal would drop straight to a hard
 *   loading state. Invalidation also survives a failed refetch: the query stays
 *   `isInvalidated`, so it retries on next mount instead of silently keeping
 *   pre-mutation data (which is why this is not `refetchQueries`).
 * - Inactive queries are REMOVED. With no observer there is nothing to refetch, a
 *   physical drop cannot be defeated by the gcTime rule, and removal emits no
 *   `invalidate` cache event — which matters for the fan-out below.
 * - Flow-scoped roots are untouched (see FLOW_SCOPED_QUERY_ROOTS).
 *
 * Cross-window fan-out: `cache-invalidation-subscriber` auto-broadcasts one
 * message per invalidated key, coalesced per EXACT key, and DROPS anything past
 * `SOFT_CAP_PER_WINDOW` (50) in a 200 ms window. Active invalidations here are
 * bounded by what is mounted, so they broadcast normally. The removed inactive
 * queries emit no event at all, so this fans out one explicit coarse message per
 * distinct affected ROOT instead — bounded by the number of query roots in the
 * app (tens), not by the number of cached node IDs (unbounded). Without that, a
 * safety-analysis spawn window would keep serving pre-import node IDs.
 *
 * Returns a promise that resolves once the active refetches have settled, so
 * callers can `await` it and keep the mutation `isPending` until the cache is
 * consistent (see the Mutations rule in `ui-data-architecture.md`).
 */
export async function invalidateAfterContentChange(queryClient: QueryClient): Promise<void> {
  const isContent = (queryKey: readonly unknown[]): boolean =>
    isWorkspaceContentQueryRoot(queryKey[0]);

  // `tree.children` pages are keyed by parent node ID and hold whole child
  // pages, so a reassign makes them unmergeable — drop them outright whether or
  // not they are active (unchanged from the previous per-site behavior; the
  // NamespaceTreePanel reloads its branches from the `tree.namespaces` refresh).
  queryClient.removeQueries({ queryKey: ['tree.children'] });

  // Collect the distinct roots of the inactive entries BEFORE removing them:
  // their removal is silent, so they are the ones needing an explicit broadcast.
  const silentRoots = new Set<string>();
  for (const query of queryClient.getQueryCache().findAll()) {
    if (!isContent(query.queryKey) || query.isActive()) continue;
    const root = query.queryKey[0];
    if (typeof root === 'string') silentRoots.add(root);
  }

  queryClient.removeQueries({
    predicate: (query) => isContent(query.queryKey) && !query.isActive(),
  });

  for (const root of silentRoots) {
    requestCrossWindowInvalidation([root]);
  }

  await queryClient.invalidateQueries({
    predicate: (query) => isContent(query.queryKey),
    refetchType: 'active',
  });
}
