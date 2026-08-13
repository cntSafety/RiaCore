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
import { api } from '../api/riacore';

/**
 * True only while workspace-scoped DB read channels are safe to invoke.
 *
 * Components can remain mounted briefly while a workspace is closing. During
 * that transition their stale namespace/metamodel props must not let queries
 * refetch against workspace-scoped IPC channels after the backend has closed.
 */
export function useWorkspaceQueryEnabled(): boolean {
  const { data: workspaceStatus } = useQuery({
    queryKey: ['workspace.status'],
    queryFn: api.workspace.getStatus,
    staleTime: 4000,
  });

  return workspaceStatus?.state === 'open' && workspaceStatus.info.dbStatus.state === 'open';
}
