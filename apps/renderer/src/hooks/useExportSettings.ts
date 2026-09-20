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
import type { ExportSettings } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Reads the persisted report-export preferences (currently: whether the
 * semi-quantitative risk-rating values are written into exported reports).
 *
 * The query key is intentionally global (no workspace scoping) — like LLM and
 * cross-namespace-link settings, this lives under `app.getPath('userData')`,
 * not under any workspace. The single invalidation site is
 * `useSaveExportSettings.onSuccess`.
 */
export function useExportSettings() {
  return useQuery<ExportSettings>({
    queryKey: ['exportSettings.settings'],
    queryFn: () => api.exportSettings.getSettings(),
    staleTime: 60_000,
  });
}
