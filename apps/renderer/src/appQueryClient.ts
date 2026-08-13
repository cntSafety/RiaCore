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
 * Shared QueryClient instance for the main App renderer root.
 * Extracted so main.tsx can install the Cache_Invalidation_Subscriber
 * synchronously before createRoot().render().
 *
 * Requirements: 15.9
 */
import { QueryClient } from '@tanstack/react-query';

export const appQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// tree.children queries are the data source the NamespaceTreePanel subscribes to
// for tree synchronisation. The tree stores its nodes in a local reducer and does
// NOT keep useTreeChildren observers mounted for already-loaded branches, so these
// queries are inactive and — with the default 5-minute gcTime — get garbage
// collected after the branch sits idle. Once collected, a mutation's
// invalidateQueries(['tree.children', ...]) matches nothing, no cache event fires,
// and the tree-sync subscription never refreshes the branch: deleting/renaming an
// element leaves a stale node behind (and selecting it later throws
// "ConceptInstance with node_id N not found").
//
// staleTime is already Infinity (set per-query); gcTime: Infinity is the missing
// piece that keeps the invalidation pattern — the documented single source of
// truth — working regardless of how long a branch has been idle. Workspace
// switches / loads / merges explicitly removeQueries(['tree.children']), so this
// does not leak across workspaces; within one workspace the footprint is just the
// currently loaded branches.
appQueryClient.setQueryDefaults(['tree.children'], { gcTime: Infinity });
