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
import React from 'react';
import { Tag } from 'antd';
import { getAsilColor } from '../config/asilColors';
import { treeDebug } from './treeDebugLog';

/**
 * Normalized tree index store for the Safety Analysis tree.
 *
 * Replaces the nested `SafetyTreeNode[]` state with a flat, keyed store
 * that supports O(1) lookups for all mutations (rename, insert, remove).
 *
 * Architecture follows SafetyAnalysisTreeConcept.md §2 "Client tree index store".
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TreeNodeKey = string;

export interface TreeNodeRecord {
  key: TreeNodeKey;
  nodeId: number;
  namespace: string;
  concept: string;
  nodeType: 'namespace' | 'model' | 'malfunction' | 'safety-note' | 'safety-task' | 'requirement' | 'review-item' | 'tag' | 'reference';
  title: string;
  isLeaf: boolean;
  parentKey: TreeNodeKey | null;
  /** For reference nodes: the source namespace and node ID of the referenced element. */
  referenceTarget?: { nodeId: number; namespace: string; concept: string } | null;
  /** ASIL level string (e.g. "D", "B(C)"). Populated for malfunction nodes; absent for all others. */
  asil?: string;
  /** Namespace role — only set on namespace root records. Used to mute imported namespace subtrees. */
  role?: 'authored' | 'imported';
  /** Metamodel name — only set on namespace root records. Used to resolve the type-specific icon/color. */
  metamodel?: string;
}

/** An anomaly detected during tree operations (boundary validation, derivation). */
export interface AnomalyReport {
  type: 'duplicate-node-id' | 'duplicate-namespace-name';
  message: string;
  details: Record<string, unknown>;
}

export interface TreeIndexState {
  nodesByKey: Record<TreeNodeKey, TreeNodeRecord>;
  childKeysByParent: Record<TreeNodeKey, TreeNodeKey[]>;
  rootKeys: TreeNodeKey[];
  loadedParents: Record<TreeNodeKey, true>;
  expandedKeys: Record<TreeNodeKey, true>;
  selectedKey: TreeNodeKey | null;
  loadingKeys: Record<TreeNodeKey, true>;
  paginationByParent: Record<TreeNodeKey, { loadedCount: number; totalCount: number }>;
  /** Accumulated anomalies detected during tree operations. */
  anomalies: AnomalyReport[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type TreeAction =
  | { type: 'INIT_NAMESPACES'; namespaces: { key: TreeNodeKey; record: TreeNodeRecord; childRecords: TreeNodeRecord[] }[] }
  | { type: 'LOAD_BRANCH'; parentKey: TreeNodeKey; children: TreeNodeRecord[] }
  | { type: 'LOAD_BRANCH_PAGE'; parentKey: TreeNodeKey; children: TreeNodeRecord[]; loadedCount: number; totalCount: number }
  | { type: 'EXPAND_ANCESTOR_PATH'; keys: TreeNodeKey[] }
  | { type: 'PATCH_TITLE'; key: TreeNodeKey; title: string }
  | { type: 'INSERT_CHILD'; parentKey: TreeNodeKey; child: TreeNodeRecord }
  | { type: 'REMOVE_CHILD'; parentKey: TreeNodeKey; childKey: TreeNodeKey }
  | { type: 'TOGGLE_EXPAND'; key: TreeNodeKey }
  | { type: 'SET_EXPANDED'; keys: TreeNodeKey[] }
  | { type: 'SET_SELECTED'; key: TreeNodeKey | null }
  | { type: 'SET_LOADING'; key: TreeNodeKey; loading: boolean }
  | { type: 'ADD_ANOMALY'; anomaly: AnomalyReport }
  | { type: 'CLEAR_ANOMALIES' }
  | { type: 'RESET' };

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const initialTreeIndexState: TreeIndexState = {
  nodesByKey: {},
  childKeysByParent: {},
  rootKeys: [],
  loadedParents: {},
  expandedKeys: {},
  selectedKey: null,
  loadingKeys: {},
  paginationByParent: {},
  anomalies: [],
};


// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function treeReducer(state: TreeIndexState, action: TreeAction): TreeIndexState {
  switch (action.type) {
    case 'INIT_NAMESPACES': {
      const nodesByKey: Record<TreeNodeKey, TreeNodeRecord> = { ...state.nodesByKey };
      const childKeysByParent: Record<TreeNodeKey, TreeNodeKey[]> = { ...state.childKeysByParent };
      const rootKeys: TreeNodeKey[] = [];

      // Build the set of namespace keys in the new list so we can detect stale namespaces.
      const newNsKeySet = new Set(action.namespaces.map((ns) => ns.key));

      // Remove all nodes belonging to namespaces that are no longer in the new list.
      // A node belongs to a stale namespace if its namespace field matches a root key
      // that is in the current rootKeys but NOT in the new namespace list.
      const staleNsKeys = state.rootKeys.filter((k) => !newNsKeySet.has(k));
      for (const staleNsKey of staleNsKeys) {
        // Walk the entire nodesByKey and remove nodes whose namespace matches the stale ns key.
        // The namespace root key format is `{namespace}:{nodeId}` — the namespace field on the
        // record is the canonical identifier.
        const staleNsRecord = nodesByKey[staleNsKey];
        const staleNamespace = staleNsRecord?.namespace ?? staleNsKey;
        for (const [key, record] of Object.entries(nodesByKey)) {
          if (record.namespace === staleNamespace) {
            delete nodesByKey[key];
            delete childKeysByParent[key];
          }
        }
        // Also remove the namespace root key itself from childKeysByParent.
        delete childKeysByParent[staleNsKey];
      }

      // Clear loadedParents and paginationByParent for all namespace root keys in the new list.
      const loadedParents: Record<TreeNodeKey, true> = { ...state.loadedParents };
      const paginationByParent: Record<TreeNodeKey, { loadedCount: number; totalCount: number }> = {
        ...state.paginationByParent,
      };

      for (const ns of action.namespaces) {
        // Remove all previously-cached children for this namespace so stale
        // data from before a persistor.load doesn't persist in the tree.
        const oldChildKeys = childKeysByParent[ns.key] ?? [];
        for (const oldKey of oldChildKeys) {
          delete nodesByKey[oldKey];
          delete childKeysByParent[oldKey];
        }
        delete childKeysByParent[ns.key];

        // Clear loadedParents and paginationByParent for this namespace root key.
        delete loadedParents[ns.key];
        delete paginationByParent[ns.key];

        nodesByKey[ns.key] = ns.record;
        rootKeys.push(ns.key);

        // Pre-populate explicitly provided child records (currently always []).
        const childKeys: TreeNodeKey[] = [];
        for (const child of ns.childRecords) {
          nodesByKey[child.key] = child;
          childKeys.push(child.key);
        }
        childKeysByParent[ns.key] = childKeys;
      }

      return {
        ...state,
        nodesByKey,
        childKeysByParent,
        rootKeys,
        loadedParents,
        paginationByParent,
      };
    }

    case 'LOAD_BRANCH': {
      const { parentKey, children } = action;
      const nextNodesByKey = { ...state.nodesByKey };
      const nextChildKeysByParent = { ...state.childKeysByParent };
      const childKeys: TreeNodeKey[] = [];

      // Remove old children that are no longer present
      const oldChildKeys = state.childKeysByParent[parentKey] ?? [];
      for (const oldKey of oldChildKeys) {
        if (!children.some((c) => c.key === oldKey)) {
          delete nextNodesByKey[oldKey];
          // Also clean up grandchildren references (use copy, not previous state)
          delete nextChildKeysByParent[oldKey];
        }
      }

      // Insert new children, deduplicating by key
      const seenKeys = new Set<TreeNodeKey>();
      for (const child of children) {
        if (!seenKeys.has(child.key)) {
          seenKeys.add(child.key);
          nextNodesByKey[child.key] = child;
          childKeys.push(child.key);
        }
      }

      // Update parent's isLeaf based on children
      if (nextNodesByKey[parentKey]) {
        nextNodesByKey[parentKey] = {
          ...nextNodesByKey[parentKey],
          isLeaf: children.length === 0,
        };
      }

      return {
        ...state,
        nodesByKey: nextNodesByKey,
        childKeysByParent: {
          ...nextChildKeysByParent,
          [parentKey]: childKeys,
        },
        loadedParents: {
          ...state.loadedParents,
          [parentKey]: true as const,
        },
      };
    }

    case 'PATCH_TITLE': {
      const { key, title } = action;
      const existing = state.nodesByKey[key];
      if (!existing) return state;

      return {
        ...state,
        nodesByKey: {
          ...state.nodesByKey,
          [key]: { ...existing, title },
        },
      };
    }

    case 'INSERT_CHILD': {
      const { parentKey, child } = action;
      const nextNodesByKey = { ...state.nodesByKey, [child.key]: child };
      const existingChildren = state.childKeysByParent[parentKey] ?? [];

      // Mark parent as non-leaf since it now has at least one child
      if (nextNodesByKey[parentKey]?.isLeaf) {
        nextNodesByKey[parentKey] = { ...nextNodesByKey[parentKey], isLeaf: false };
      }

      return {
        ...state,
        nodesByKey: nextNodesByKey,
        childKeysByParent: {
          ...state.childKeysByParent,
          [parentKey]: [...existingChildren, child.key],
        },
      };
    }

    case 'REMOVE_CHILD': {
      const { parentKey, childKey } = action;
      const nextNodesByKey = { ...state.nodesByKey };
      delete nextNodesByKey[childKey];

      const existingChildren = state.childKeysByParent[parentKey] ?? [];

      return {
        ...state,
        nodesByKey: nextNodesByKey,
        childKeysByParent: {
          ...state.childKeysByParent,
          [parentKey]: existingChildren.filter((k) => k !== childKey),
        },
      };
    }

    case 'TOGGLE_EXPAND': {
      const { key } = action;
      const next = { ...state.expandedKeys };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = true;
      }
      return { ...state, expandedKeys: next };
    }

    case 'SET_EXPANDED': {
      const next: Record<TreeNodeKey, true> = {};
      for (const k of action.keys) {
        next[k] = true;
      }
      return { ...state, expandedKeys: next };
    }

    case 'SET_SELECTED': {
      return { ...state, selectedKey: action.key };
    }

    case 'SET_LOADING': {
      const next = { ...state.loadingKeys };
      if (action.loading) {
        next[action.key] = true;
      } else {
        delete next[action.key];
      }
      return { ...state, loadingKeys: next };
    }

    case 'LOAD_BRANCH_PAGE': {
      const { parentKey, children, loadedCount, totalCount } = action;
      const existingKeys = new Set(state.childKeysByParent[parentKey] ?? []);
      const nextNodesByKey = { ...state.nodesByKey };
      const appendedKeys: TreeNodeKey[] = [];

      for (const child of children) {
        if (!existingKeys.has(child.key)) {
          nextNodesByKey[child.key] = child;
          appendedKeys.push(child.key);
        }
      }

      const newChildKeys = [...(state.childKeysByParent[parentKey] ?? []), ...appendedKeys];

      // Update parent's isLeaf if children were added
      if (appendedKeys.length > 0 && nextNodesByKey[parentKey]) {
        nextNodesByKey[parentKey] = { ...nextNodesByKey[parentKey], isLeaf: false };
      }

      return {
        ...state,
        nodesByKey: nextNodesByKey,
        childKeysByParent: {
          ...state.childKeysByParent,
          [parentKey]: newChildKeys,
        },
        loadedParents: {
          ...state.loadedParents,
          [parentKey]: true as const,
        },
        paginationByParent: {
          ...state.paginationByParent,
          [parentKey]: { loadedCount, totalCount },
        },
      };
    }

    case 'EXPAND_ANCESTOR_PATH': {
      const next = { ...state.expandedKeys };
      for (const k of action.keys) {
        next[k] = true;
      }
      return { ...state, expandedKeys: next };
    }

    case 'ADD_ANOMALY': {
      return {
        ...state,
        anomalies: [...state.anomalies, action.anomaly],
      };
    }

    case 'CLEAR_ANOMALIES': {
      return {
        ...state,
        anomalies: [],
      };
    }

    case 'RESET': {
      return initialTreeIndexState;
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived data helpers
// ---------------------------------------------------------------------------

/**
 * Shape of a node in the Ant Design `<Tree>` data array.
 * Mirrors the `SafetyTreeNode` interface in ImportedTreePanel but defined
 * here to avoid circular imports.
 */
export interface AntSafetyTreeNode {
  key: string;
  title: React.ReactNode;
  nodeId: number;
  namespace: string;
  concept: string;
  name: string;
  nodeType: 'namespace' | 'model' | 'malfunction' | 'safety-note' | 'safety-task' | 'requirement' | 'review-item' | 'tag' | 'reference';
  isLeaf: boolean;
  icon?: React.ReactNode;
  children?: AntSafetyTreeNode[];
  loadedCount?: number;
  totalCount?: number;
  /** True when this node's key appeared more than once in its parent's child list (structural anomaly). */
  hasDuplicateWarning?: boolean;
  /** True when this node is a cross-namespace reference (nodeType === 'reference'). */
  isReference?: boolean;
}

/**
 * A flat row representing a visible tree node, including its depth for
 * indentation. Used by virtualized renderers instead of nested tree data.
 */
export interface VisibleRow {
  /** The underlying node record. */
  record: TreeNodeRecord;
  /** Nesting depth (0 = root). */
  depth: number;
}

/**
 * Derive a flat list of visible rows by walking only expanded branches
 * starting from root keys. Cost is proportional to the number of visible
 * (expanded) rows, not the total tree size.
 */
export function deriveVisibleRows(state: TreeIndexState): VisibleRow[] {
  const rows: VisibleRow[] = [];

  function walk(key: TreeNodeKey, depth: number): void {
    const record = state.nodesByKey[key];
    if (!record) return;

    rows.push({ record, depth });

    // Only recurse into children if this node is expanded
    if (state.expandedKeys[key]) {
      const childKeys = state.childKeysByParent[key] ?? [];
      for (const childKey of childKeys) {
        walk(childKey, depth + 1);
      }
    }
  }

  for (const rootKey of state.rootKeys) {
    walk(rootKey, 0);
  }

  return rows;
}

/**
 * Convert the normalized TreeIndexState back into the nested tree node array
 * format expected by Ant Design's `<Tree>` component.
 *
 * This is a bridge function used during the migration. Later tasks (3.5, 3.6)
 * will replace this with a flat visible-row derivation + virtualized renderer.
 *
 * Returns `{ nodes, anomalyCount }` where `anomalyCount` is the number of
 * structural anomalies detected (orphan references + same-key duplicates).
 * Anomalies are logged via `treeDebug.warn` and flagged on the affected nodes.
 */
export function deriveAntTreeData(
  state: TreeIndexState,
  buildIcon: (concept: string, asil?: string, record?: TreeNodeRecord) => React.ReactNode,
  authoredNamespace?: string,
): { nodes: AntSafetyTreeNode[]; anomalyCount: number } {
  let anomalyCount = 0;

  function buildSubtree(key: TreeNodeKey, parentKey: TreeNodeKey | null, hasDuplicate: boolean, isImported: boolean): AntSafetyTreeNode | null {
    const record = state.nodesByKey[key];

    // Orphan reference: key in child list but missing from nodesByKey — skip to avoid crash
    if (!record) {
      anomalyCount++;
      treeDebug.warn('deriveAntTreeData: orphan reference — key missing from nodesByKey', {
        key,
        parentKey,
      });
      return null;
    }

    const childKeys = state.childKeysByParent[key] ?? [];

    // Detect same-key duplicates within this node's child list
    const seenChildKeys = new Set<TreeNodeKey>();
    const duplicateChildKeys = new Set<TreeNodeKey>();
    for (const ck of childKeys) {
      if (seenChildKeys.has(ck)) {
        duplicateChildKeys.add(ck);
      } else {
        seenChildKeys.add(ck);
      }
    }

    if (duplicateChildKeys.size > 0) {
      anomalyCount += duplicateChildKeys.size;
      treeDebug.warn('deriveAntTreeData: same-key duplicate detected in child list', {
        parentKey: key,
        duplicateKeys: [...duplicateChildKeys],
      });
    }

    // Build children — render ALL keys including duplicates (truth-telling), skip orphans
    const children: AntSafetyTreeNode[] = [];
    // Determine whether children belong to an imported namespace subtree.
    // A namespace root record determines this by comparing its namespace name
    // against the authoredNamespace argument; child records inherit the flag.
    const childIsImported = record.nodeType === 'namespace'
      ? (authoredNamespace !== undefined ? record.namespace !== authoredNamespace : record.role === 'imported')
      : isImported;
    for (const ck of childKeys) {
      const isDuplicate = duplicateChildKeys.has(ck);
      const child = buildSubtree(ck, key, isDuplicate, childIsImported);
      if (child !== null) {
        children.push(child);
      }
    }

    const isFailureMode = record.nodeType === 'malfunction' ||
      (record.nodeType === 'reference' && record.concept === 'malfunction');
    const isReference = record.nodeType === 'reference';

    let titleNode: React.ReactNode = record.title;
    if (isFailureMode) {
      const nameSpan = React.createElement('span', { style: { fontWeight: 600 } }, record.title);
      if (record.asil) {
        titleNode = React.createElement(
          React.Fragment,
          null,
          nameSpan,
          React.createElement(Tag, {
            color: getAsilColor(record.asil),
            style: { marginLeft: 6, fontSize: 11, lineHeight: '18px', padding: '0 4px' },
          }, record.asil),
        ) as React.ReactNode;
      } else {
        titleNode = nameSpan as React.ReactNode;
      }
    }
    if (hasDuplicate) {
      // Wrap title with a warning indicator for duplicated nodes
      titleNode = React.createElement(
        'span',
        { style: { color: '#faad14' }, title: 'Duplicate key detected' },
        '⚠ ',
        titleNode,
      ) as React.ReactNode;
    }

    // Mute the entire title for nodes that belong to imported namespaces so
    // that authored-namespace elements stand out visually.
    // Exception: reference nodes whose source namespace is the authored namespace
    // (e.g. malfunction references appearing under imported structural nodes)
    // are authored content and must always render at full opacity.
    const effectivelyImported = isImported &&
      !(record.nodeType === 'reference' && authoredNamespace !== undefined && record.namespace === authoredNamespace);
    if (effectivelyImported) {
      titleNode = React.createElement(
        'span',
        { style: { opacity: 0.7 } },
        titleNode,
      ) as React.ReactNode;
    }

    return {
      key: record.key,
      title: titleNode,
      nodeId: record.nodeId,
      namespace: record.namespace,
      concept: record.concept,
      name: record.title,
      nodeType: record.nodeType,
      isLeaf: record.isLeaf && children.length === 0,
      icon: effectivelyImported
        ? React.createElement('span', { style: { opacity: 0.7 } }, buildIcon(record.concept, record.asil, record))
        : buildIcon(record.concept, record.asil, record),
      children: children.length > 0 ? children : undefined,
      ...(hasDuplicate ? { hasDuplicateWarning: true } : {}),
      ...(isReference ? { isReference: true } : {}),
    };
  }

  const nodes: AntSafetyTreeNode[] = [];
  for (const rootKey of state.rootKeys) {
    const node = buildSubtree(rootKey, null, false, false);
    if (node !== null) {
      nodes.push(node);
    }
  }

  return { nodes, anomalyCount };
}
