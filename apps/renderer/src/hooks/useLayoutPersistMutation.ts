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
 * TanStack Query mutation for persisting Canvas_Element positions
 * (the connection-diagram-layout-persistence feature).
 *
 * `useLayoutPersistMutation` upserts one or more Layout_Records through the
 * `canvasLayout:setRecords` IPC channel. Per the UI data architecture it uses
 * `invalidateQueries` (never manual `setQueryData`) and an `async onSuccess` +
 * `await Promise.all([...invalidateQueries])`, so the mutation stays
 * `isPending` until the layout query cache is consistent (Req 1.6).
 *
 * The invalidated key `['canvasLayout.getLayout']` matches the query key used by
 * `useDiagramLayout` (task 6.1). Writing positions does NOT reassign database
 * node IDs (records are keyed by the stable `layout_id`), so
 * `resetWorkspaceState()` is intentionally NOT called here — invalidation alone
 * is sufficient.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LayoutRecord, DiagramLayout } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Mutation: persist one or more Layout_Records (position of a Canvas_Element).
 *
 * The whole batch is rejected by the backend if any record has a non-finite
 * coordinate (Req 1.8), and rejected while the workspace phase is not `db_open`
 * (Req 1.7); in both cases the stored Diagram_Layout is left unchanged and the
 * mutation surfaces the thrown Error.
 */
export function useLayoutPersistMutation() {
  const queryClient = useQueryClient();

  return useMutation<DiagramLayout, Error, LayoutRecord[]>({
    mutationFn: (records: LayoutRecord[]) =>
      api.canvasLayout.setRecords(records),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['canvasLayout.getLayout'] }),
      ]);
    },
  });
}
