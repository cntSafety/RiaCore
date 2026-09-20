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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExportSettings } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Mutation hook for persisting the report-export preferences via the
 * `exportSettings.saveSettings` IPC channel.
 *
 * On success it invalidates `['exportSettings.settings']` so
 * `useExportSettings` re-fetches the freshly persisted record.
 */
export function useSaveExportSettings() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, ExportSettings>({
    mutationFn: (settings) => api.exportSettings.saveSettings(settings),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['exportSettings.settings'] });
    },
  });
}
