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
 * Shared QueryClient instance for the Safety Analysis Spawn window renderer root.
 * Extracted so main.tsx can install the Cache_Invalidation_Subscriber
 * synchronously before createRoot().render().
 *
 * Requirements: 8.1, 15.9
 */
import { QueryClient } from '@tanstack/react-query';

export const spawnQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// See appQueryClient.ts for the rationale. The spawn window also renders the
// NamespaceTreePanel, so it needs the same gcTime: Infinity default on
// tree.children to keep the invalidation-driven tree sync from breaking after a
// branch has been idle past the default gcTime.
spawnQueryClient.setQueryDefaults(['tree.children'], { gcTime: Infinity });
