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
import type { CreateTagParams } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceState } from './useWorkspaceState';

export function useTagMutations() {
  const queryClient = useQueryClient();
  // Tags render as nodes in the authored-namespace safety tree. Creating,
  // renaming or deleting a tag therefore changes tree-visible data and must
  // invalidate tree.children so NamespaceTreePanel re-syncs. We derive the
  // workspaceKey here (rather than threading it through every call site) so all
  // callers — TagsOverviewView, CenterPanel, MalfunctionExpandedRow — are fixed
  // at once. Link/unlink are intentionally excluded: they associate an existing
  // tag with an element but never add/remove a tree node.
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;

  /**
   * Invalidate every loaded tree.children branch for the current workspace.
   * The tree only re-fetches parents that are actually loaded, so this
   * namespace-agnostic net is cheap and robust — it covers the authored
   * namespace root where a new/renamed/deleted tag node appears without
   * needing the tag's namespace at the call site.
   */
  function invalidateTreeForTags(): void {
    if (!workspaceKey) return;
    void queryClient.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey;
        return Array.isArray(key) && key[0] === 'tree.children' && key[1] === workspaceKey;
      },
    });
  }

  const createTag = useMutation({
    mutationFn: (params: CreateTagParams) => api.safety.createTag(params),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tags', variables.namespace] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
      invalidateTreeForTags();
    },
  });

  const updateTag = useMutation({
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown> }) =>
      api.safety.updateTag(nodeId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['tagsForElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
      invalidateTreeForTags();
    },
  });

  const deleteTag = useMutation({
    mutationFn: (nodeId: number) => api.safety.deleteTag(nodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['tagsForElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
      invalidateTreeForTags();
    },
  });

  const linkTag = useMutation({
    mutationFn: ({ elementNodeId, tagNodeId }: { elementNodeId: number; tagNodeId: number }) =>
      api.safety.linkTag(elementNodeId, tagNodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tagsForElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
    },
  });

  const unlinkTag = useMutation({
    mutationFn: ({ elementNodeId, tagNodeId }: { elementNodeId: number; tagNodeId: number }) =>
      api.safety.unlinkTag(elementNodeId, tagNodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tagsForElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
    },
  });

  const linkTagCrossNs = useMutation({
    mutationFn: ({ tagNodeId, importedElementNodeId }: { tagNodeId: number; importedElementNodeId: number }) =>
      api.safety.linkTagCrossNs(tagNodeId, importedElementNodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tagsForElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
    },
  });

  const unlinkTagCrossNs = useMutation({
    mutationFn: ({ tagNodeId, importedElementNodeId }: { tagNodeId: number; importedElementNodeId: number }) =>
      api.safety.unlinkTagCrossNs(tagNodeId, importedElementNodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tagsForElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
      queryClient.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
    },
  });

  return { createTag, updateTag, deleteTag, linkTag, unlinkTag, linkTagCrossNs, unlinkTagCrossNs };
}
