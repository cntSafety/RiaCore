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
import type { GetChildrenResponse } from '@riacore/app-contracts';
import type { SelectedTreeElement, ScopedTreeNavigationResult } from '../types';
import { selectAnalysisRootNamespaces } from './treeUtils';

export interface TreeNavigationScope {
  /** Includes the workspace and active analysis/browser, to reject an in-flight context switch. */
  contextKey: string;
  analysisNamespace: string;
  browseNamespace?: string;
  namespaces?: readonly { name: string; role?: string }[];
  connections?: readonly { source: string; target: string }[];
  ready: boolean;
}

interface ScopedTreeNavigationAdapter {
  getScope(): TreeNavigationScope;
  hasRoot(namespace: string): boolean;
  getAncestorPath(namespace: string, nodeId: number): Promise<number[]>;
  fetchPage(namespace: string, parentNodeId: number | undefined, offset: number): Promise<GetChildrenResponse>;
  applyPage(namespace: string, parentNodeId: number | undefined, page: GetChildrenResponse): void;
  select(target: SelectedTreeElement, ancestorPath: number[]): void;
}

/** A strict navigation path for relationship rows. Never creates namespace roots. */
export async function navigateScopedTree(
  target: SelectedTreeElement,
  adapter: ScopedTreeNavigationAdapter,
): Promise<ScopedTreeNavigationResult> {
  const initialContextKey = adapter.getScope().contextKey;
  const checkScope = (): ScopedTreeNavigationResult | null => {
    const scope = adapter.getScope();
    if (!scope.ready || !scope.namespaces || scope.contextKey !== initialContextKey) {
      return { status: 'unavailable', message: 'The tree context changed or is still loading. Please try again.' };
    }
    const roots = scope.browseNamespace
      ? scope.namespaces.filter(ns => ns.name === scope.browseNamespace)
      : selectAnalysisRootNamespaces([...scope.namespaces], scope.connections ?? [], scope.analysisNamespace);
    if (!roots.some(ns => ns.name === target.namespace)) {
      const ns = scope.namespaces.find(ns => ns.name === target.namespace);
      const message = scope.browseNamespace
        ? `This element belongs to “${target.namespace}” and is not available in the model browser for “${scope.browseNamespace}”.`
        : ns?.role === 'authored'
          ? `This element belongs to “${target.namespace}” and is not available in the tree for “${scope.analysisNamespace}”.`
          : `This element's namespace “${target.namespace}” is not imported into analysis “${scope.analysisNamespace}”.`;
      return { status: 'out-of-scope', message };
    }
    if (!adapter.hasRoot(target.namespace)) {
      return { status: 'unavailable', message: 'The namespace tree is still loading. Please try again.' };
    }
    return null;
  };
  const blocked = checkScope();
  if (blocked) return blocked;

  try {
    const ancestors = await adapter.getAncestorPath(target.namespace, target.nodeId);
    const pages: { parentNodeId: number | undefined; page: GetChildrenResponse }[] = [];
    // Find each ancestor and then the target using the same filtered, paginated
    // children API as the tree. An absent node must never become a fake selection.
    let parentNodeId: number | undefined;
    for (const wantedId of [...ancestors, target.nodeId]) {
      let offset = 0;
      let found = false;
      while (!found) {
        const beforeRead = checkScope();
        if (beforeRead) return beforeRead;
        const page = await adapter.fetchPage(target.namespace, parentNodeId, offset);
        const afterRead = checkScope();
        if (afterRead) return afterRead;
        if (page.offset !== offset) throw new Error('Unexpected tree page offset');
        pages.push({ parentNodeId, page });
        found = page.children.some(child => child.node_id === wantedId);
        if (found) break;
        if (!page.hasMore) break;
        if (page.children.length === 0) throw new Error('Tree pagination made no progress');
        offset += page.children.length;
      }
      if (!found) {
        return {
          status: 'not-visible',
          message: 'This element is not visible in the current tree. It may be hidden by the tree display settings or no longer available. Refresh relationships or check the tree display settings.',
        };
      }
      parentNodeId = wantedId;
    }
    const beforeSelect = checkScope();
    if (beforeSelect) return beforeSelect;
    for (const { parentNodeId: parent, page } of pages) adapter.applyPage(target.namespace, parent, page);
    adapter.select(target, ancestors);
    return { status: 'selected' };
  } catch {
    return { status: 'unavailable', message: 'Could not locate this element in the tree. Refresh relationships and try again.' };
  }
}
