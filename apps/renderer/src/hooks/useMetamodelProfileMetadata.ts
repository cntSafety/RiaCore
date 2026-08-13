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
import type { MetamodelProfileMetadata } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceQueryEnabled } from './useWorkspaceQueryEnabled';

export function metamodelProfileMetadataQueryKey(metamodel: string) {
  return ['metamodel.profileMetadata', metamodel] as const;
}

/** Loads the immutable, ordered metadata snapshot parsed from a LinkML profile. */
export function useMetamodelProfileMetadata(metamodel: string | null) {
  const workspaceQueryEnabled = useWorkspaceQueryEnabled();

  return useQuery<MetamodelProfileMetadata>({
    queryKey: metamodelProfileMetadataQueryKey(metamodel ?? ''),
    queryFn: () => api.metamodel.getProfileMetadata(metamodel!),
    enabled: workspaceQueryEnabled && !!metamodel,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
