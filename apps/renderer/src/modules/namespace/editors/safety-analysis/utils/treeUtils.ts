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
 * Pure tree utility functions extracted from ImportedTreePanel for testability.
 * These are the UNFIXED versions that exhibit the performance defects.
 */

import type { DataNode } from 'antd/es/tree';
import type { TreeChildNode, ConceptInstanceData } from '@riacore/app-contracts';
import { canHostCrossNSSafetyElements, EXCLUDED_CONCEPTS } from '../config/conceptHosting';

// Re-export so existing consumers (e.g. tests) can import from this module
export { canHostCrossNSSafetyElements, EXCLUDED_CONCEPTS };

export interface SafetyTreeNode extends DataNode {
  nodeId: number;
  namespace: string;
  concept: string;
  name: string;
  nodeType: 'namespace' | 'model' | 'malfunction';
  loadedCount?: number;
  totalCount?: number;
}

export function malfunctionKey(namespace: string, nodeId: number): string {
  return `fm:${namespace}:${nodeId}`;
}

/**
 * Select the namespace roots that belong in a specific analysis's tree.
 *
 * Cross-namespace visibility is scoped to the per-pair connection
 * (`RIA_UNIV_NamespaceConnection`), NOT the shared metamodel. So the tree for
 * analysis `analysisNamespace` contains exactly:
 *   - the analysis namespace itself (where its malfunctions/tasks/etc. live), and
 *   - the Imported_Namespaces explicitly connected to that specific analysis
 *     (connection `target === analysisNamespace`).
 *
 * It deliberately EXCLUDES other authored analyses and any imported namespace
 * connected only to a different analysis — even one sharing the same metamodel.
 * This is the renderer-side realization of Requirement 10.4 / Property 11 (tree
 * context is scoped to the specific analysis).
 *
 * @param allNamespaces every namespace in the workspace (imported + authored)
 * @param connections   directed per-pair connections (source=imported, target=authored)
 * @param analysisNamespace the authored analysis whose tree is being rendered
 */
export function selectAnalysisRootNamespaces<T extends { name: string; role?: string }>(
  allNamespaces: T[],
  connections: readonly { source: string; target: string }[],
  analysisNamespace: string,
): T[] {
  const connectedImported = new Set(
    connections
      .filter((c) => c.target === analysisNamespace)
      .map((c) => c.source),
  );
  return allNamespaces.filter(
    (ns) =>
      ns.name === analysisNamespace ||
      (ns.role === 'imported' && connectedImported.has(ns.name)),
  );
}

/**
 * Build a SafetyTreeNode from a TreeChildNode (structural model node).
 * Extracted from ImportedTreePanel for testability.
 */
export function buildTreeNode(child: TreeChildNode, namespace: string): SafetyTreeNode {
  return {
    key: `${namespace}:${child.node_id}`,
    title: child.name || `(${child.concept})`,
    nodeId: child.node_id,
    namespace,
    concept: child.concept,
    name: child.name || `(${child.concept})`,
    nodeType: 'model',
    isLeaf: !child.hasChildren && !canHostCrossNSSafetyElements(child.concept),
  };
}

/**
 * Build a SafetyTreeNode from a ConceptInstanceData (failure mode).
 * Extracted from ImportedTreePanel for testability.
 */
export function buildMalfunctionNode(failureMode: ConceptInstanceData): SafetyTreeNode {
  const title = String(failureMode.attributes?.has_name ?? `Malfunction ${failureMode.node_id}`);
  return {
    key: malfunctionKey(failureMode.namespace, failureMode.node_id),
    title,
    nodeId: failureMode.node_id,
    namespace: failureMode.namespace,
    concept: failureMode.concept,
    name: title,
    nodeType: 'malfunction',
    isLeaf: true,
  };
}

/**
 * Recursively update children of a node in the tree.
 * BUG: This walks the ENTIRE tree (O(n)) to find and update one parent's children.
 */
export function updateTreeChildren(
  nodes: SafetyTreeNode[],
  parentKey: string,
  children: SafetyTreeNode[],
  totalCount: number,
): SafetyTreeNode[] {
  return nodes.map((node) => {
    if (String(node.key) === parentKey) {
      return { ...node, children, loadedCount: children.length, totalCount, isLeaf: children.length === 0 };
    }
    if (node.children) {
      return { ...node, children: updateTreeChildren(node.children as SafetyTreeNode[], parentKey, children, totalCount) };
    }
    return node;
  });
}

/**
 * Recursively rename a tree node by namespace and nodeId.
 * BUG: This walks the ENTIRE tree (O(n)) to find and rename one node.
 */
export function renameTreeNode(
  nodes: SafetyTreeNode[],
  namespace: string,
  nodeId: number,
  name: string,
): SafetyTreeNode[] {
  return nodes.map((node) => {
    if (node.namespace === namespace && node.nodeId === nodeId) {
      return {
        ...node,
        name,
        title: name,
      };
    }
    if (node.children) {
      return {
        ...node,
        children: renameTreeNode(node.children as SafetyTreeNode[], namespace, nodeId, name),
      };
    }
    return node;
  });
}
