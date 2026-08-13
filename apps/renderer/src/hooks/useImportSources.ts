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
import type { ImportSourceInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Fetches the list of SourceMaster sources from the DB.
 * Polling is driven by the caller — no import-run-store coupling.
 */
export function useImportSources(enabled: boolean, workspaceKey?: string | null) {
  return useQuery<ImportSourceInfo[]>({
    queryKey: ['imports.listSources', workspaceKey ?? 'no-workspace', enabled ? 'db-open' : 'db-closed'],
    queryFn: () => api.imports.listSources(),
    enabled,
    placeholderData: [],
    staleTime: 5_000,
    refetchOnMount: true,
  });
}
