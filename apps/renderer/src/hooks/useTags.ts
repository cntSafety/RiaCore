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
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceQueryEnabled } from './useWorkspaceQueryEnabled';

export function useTags(namespace: string) {
  const workspaceQueryEnabled = useWorkspaceQueryEnabled();

  return useQuery<ConceptInstanceData[]>({
    queryKey: ['tags', namespace],
    queryFn: () => api.safety.getAllTags(namespace),
    enabled: workspaceQueryEnabled && namespace.length > 0,
    placeholderData: [],
  });
}

export function useTagsForElement(nodeId: number) {
  const workspaceQueryEnabled = useWorkspaceQueryEnabled();

  return useQuery<ConceptInstanceData[]>({
    queryKey: ['tagsForElement', nodeId],
    queryFn: () => api.safety.getTagsForElement(nodeId),
    enabled: workspaceQueryEnabled,
    placeholderData: [],
  });
}

export function useTagsForImportedElement(nodeId: number | undefined) {
  const workspaceQueryEnabled = useWorkspaceQueryEnabled();

  return useQuery<ConceptInstanceData[]>({
    queryKey: ['tagsForImportedElement', nodeId],
    queryFn: () => api.safety.getTagsForImportedElement(nodeId!),
    enabled: workspaceQueryEnabled && nodeId !== undefined,
    placeholderData: [],
  });
}
