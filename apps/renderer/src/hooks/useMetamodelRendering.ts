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
import type { MetamodelRenderingConfig } from '@riacore/app-contracts';
import { useWorkspaceQueryEnabled } from './useWorkspaceQueryEnabled';

/** Query key for a metamodel's rendering config. */
export function metamodelRenderingQueryKey(metamodel: string) {
  return ['metamodel.rendering', metamodel] as const;
}

/**
 * Loads the rendering config (concept name → rendering settings) for the given
 * metamodel. The config is static for a given metamodel, so the query never goes
 * stale on its own and is refreshed only by invalidation.
 *
 * `gcTime: Infinity` is required by the gcTime rule: a query that is refreshed
 * only by invalidation (`staleTime: Infinity`) and can be invalidated while it
 * has no mounted observer must keep its cache entry alive, otherwise the
 * invalidation silently no-ops once the query is garbage-collected.
 */
export function useMetamodelRendering(metamodel: string | null) {
  const workspaceQueryEnabled = useWorkspaceQueryEnabled();

  return useQuery<MetamodelRenderingConfig>({
    queryKey: metamodelRenderingQueryKey(metamodel ?? ''),
    queryFn: () => api.metamodel.getRenderingConfig(metamodel!),
    enabled: workspaceQueryEnabled && !!metamodel,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
