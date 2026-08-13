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
 * TanStack Query data layer for the Overview_Canvas diagram layout
 * (the connection-diagram-layout-persistence feature).
 *
 * - `useDiagramLayout` — the single query hook for the `['canvasLayout.getLayout']`
 *   query key. It returns the current Diagram_Layout (one Layout_Record per
 *   Layout_Key) and is enabled only while the workspace DB is open
 *   (`phase === 'db_open'`, Req 2.1 / 2.4).
 *
 *   It is invalidation-driven (`staleTime: Infinity`) and therefore must also set
 *   `gcTime: Infinity` (the gcTime rule, Req 7.3d): the canvas may unmount (no
 *   observer) while a layout-persist mutation invalidates this key, and with the
 *   default gcTime the query would be garbage-collected and the invalidation would
 *   silently no-op. See the gcTime rule in `ui-data-architecture.md` /
 *   `ui-tree-sync.md`.
 */
import { useQuery } from '@tanstack/react-query';
import type { DiagramLayout } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceState } from './useWorkspaceState';

/**
 * Canonical query key for the diagram layout. A layout-persist mutation
 * invalidates this exact key to refresh the rendered positions.
 */
export const diagramLayoutQueryKey = ['canvasLayout.getLayout'] as const;

/**
 * Query hook for the current Diagram_Layout. Enabled only while the workspace
 * DB is open; invalidation-driven, so both `staleTime` and `gcTime` are
 * `Infinity`.
 */
export function useDiagramLayout() {
  const ws = useWorkspaceState();
  const enabled = ws.phase === 'db_open';

  return useQuery<DiagramLayout>({
    queryKey: diagramLayoutQueryKey,
    queryFn: () => api.canvasLayout.getLayout(),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
