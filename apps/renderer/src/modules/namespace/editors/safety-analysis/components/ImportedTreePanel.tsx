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
import { Tree, Empty, Spin, AutoComplete, Input } from 'antd';
import { useState, useCallback, createElement, useEffect, useReducer, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import { useImportedNamespaces } from '../hooks/useTreeQueries';
import { getNodeDecoration } from '../config/nodeTypeConfig';
import { api } from '../../../../../api/riacore';
import type { SelectedTreeElement } from '../types';
import type { ConceptInstanceData, TreeChildNode, SearchResultNode } from '@riacore/app-contracts';
import { TreeContextMenu } from './TreeContextMenu';
import { CreateMalfunctionModal } from './CreateMalfunctionModal';
import {
  treeReducer,
  initialTreeIndexState,
  deriveAntTreeData,
  type TreeNodeRecord,
  type TreeNodeKey,
} from '../utils/treeIndexStore';
import { treeDebug } from '../utils/treeDebugLog';
import { canHostCrossNSSafetyElements } from '../config/conceptHosting';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import type { PendingPropagationSource } from '../../../../../store/workspaceStore';
import { useImportSources } from '../../../../../hooks/useImportSources';

export interface NavigateToTreeNodeParams {
  nodeId: number;
  namespace: string;
  concept: string;
  /** Display name for the target node (used in onSelect notification). */
  name?: string;
  /** Pre-resolved ancestor path. If not provided, fetched via IPC. */
  ancestorPath?: number[];
  /** For authored elements, the structural host node. If not provided and concept is malfunction, resolved via IPC. */
  crossNsTarget?: { nodeId: number; namespace: string } | null;
}

export interface ImportedTreePanelHandle {
  renameNode: (nodeId: number, namespace: string, name: string) => void;
  navigateToNode: (nodeId: number, namespace: string, concept: string) => Promise<void>;
}

interface ImportedTreePanelProps {
  onSelect: (element: SelectedTreeElement | null) => void;
  /** Safety namespace used for malfunction authoring features. When omitted the
   * panel operates in read-only browse mode: the "Add Malfunction" context-menu
   * entry and the create-malfunction modal are suppressed. */
  safetyNamespace?: string;
  /** When set, only this namespace is displayed in the tree root list.
   * Used by the standalone model-browser modal to show a single import source. */
  targetNamespace?: string;
  onRequestAddNote?: () => void;
  /** Called once after namespace roots are initialized. */
  onReady?: () => void;
  /** Set this malfunction as the propagation source. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete propagation from the pending source to this malfunction. */
  onEndPropagation?: (node: SelectedTreeElement) => void;
}

/** Re-exported for test compatibility. */
export interface SafetyTreeNode extends DataNode {
  nodeId: number;
  namespace: string;
  concept: string;
  name: string;
  nodeType: 'namespace' | 'model' | 'malfunction';
  loadedCount?: number;
  totalCount?: number;
}

const PAGE_SIZE = 200;

function malfunctionKey(namespace: string, nodeId: number): string {
  return `fm:${namespace}:${nodeId}`;
}

// ---------------------------------------------------------------------------
// Helpers to convert API data → TreeNodeRecord for the normalized store
// ---------------------------------------------------------------------------

function toModelRecord(child: TreeChildNode, namespace: string, parentKey: string | null): TreeNodeRecord {
  return {
    key: `${namespace}:${child.node_id}`,
    nodeId: child.node_id,
    namespace,
    concept: child.concept,
    nodeType: 'model',
    title: child.name || `(${child.concept})`,
    isLeaf: !child.hasChildren,
    parentKey,
  };
}

function toMalfunctionRecord(fm: ConceptInstanceData, parentKey: string): TreeNodeRecord {
  const title = String(fm.attributes?.has_name ?? `Malfunction ${fm.node_id}`);
  return {
    key: malfunctionKey(fm.namespace, fm.node_id),
    nodeId: fm.node_id,
    namespace: fm.namespace,
    concept: fm.concept,
    nodeType: 'malfunction',
    title,
    isLeaf: true,
    parentKey,
  };
}

/** Build an icon ReactNode for a concept string. */
function buildIcon(concept: string): React.ReactNode {
  const decoration = getNodeDecoration(concept);
  return createElement(decoration.icon, { style: { color: decoration.color } } as Record<string, unknown>);
}

function sentinelKey(nsKey: TreeNodeKey): TreeNodeKey {
  return `sentinel:${nsKey}`;
}

function toSentinelRecord(nsKey: TreeNodeKey, namespace: string): TreeNodeRecord {
  return {
    key: sentinelKey(nsKey),
    nodeId: -2,
    namespace,
    concept: 'sentinel',
    nodeType: 'model',
    title: 'Load more…',
    isLeaf: true,
    parentKey: nsKey,
  };
}

const AUTHORED_NODE_TYPES = new Set(['malfunction', 'safety-note', 'safety-task', 'requirement', 'review-item']);
const AUTHORED_CONCEPTS = new Set(['malfunction', 'safety_note', 'safety_task', 'requirement', 'review_item']);

/** Returns true if the concept or nodeType indicates an authored safety element. */
function isAuthoredConcept(concept: string): boolean {
  return AUTHORED_NODE_TYPES.has(concept) || AUTHORED_CONCEPTS.has(concept);
}

/** Returns true if the concept indicates a malfunction. */
function isMalfunctionConcept(concept: string): boolean {
  return concept === 'malfunction';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ImportedTreePanel = forwardRef<ImportedTreePanelHandle, ImportedTreePanelProps>(
  function ImportedTreePanel({ onSelect, safetyNamespace = '', targetNamespace, onRequestAddNote, onReady, onStartPropagation, onEndPropagation }, ref) {
  const { data: importedNamespaces, isLoading: nsLoading } = useImportedNamespaces();
  // Memoized so the reference is stable across renders — avoids the infinite
  // loop that would occur if filter() created a new array on every render,
  // causing initRoots / navigateToTreeNode to rememoize and their useEffects
  // to re-fire indefinitely.
  const visibleNamespaces = useMemo(
    () => targetNamespace
      ? (importedNamespaces ?? []).filter((ns) => ns.name === targetNamespace)
      : importedNamespaces,
    [importedNamespaces, targetNamespace],
  );

  const workingDir = useWorkspaceStore((s) => s.workingDir);
  const { data: importSources = [] } = useImportSources(workingDir !== null, workingDir);

  // Map from targetNamespace → display name for namespace root titles (#53)
  const nsDisplayNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const src of importSources) {
      if (src.targetNamespace && src.name) {
        map.set(src.targetNamespace, src.name);
      }
    }
    return map;
  }, [importSources]);

  const pendingPropagationSource = useWorkspaceStore(
    (s) => s.pendingPropagationSource[safetyNamespace] ?? null,
  ) as PendingPropagationSource | null;
  const [state, dispatch] = useReducer(treeReducer, initialTreeIndexState);
  const [contextMenuNode, setContextMenuNode] = useState<SelectedTreeElement | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalTarget, setCreateModalTarget] = useState<SelectedTreeElement | null>(null);

  // Virtual scrolling: track container height via ResizeObserver
  const [panelHeight, setPanelHeight] = useState(600);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<React.ComponentRef<typeof Tree> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return; // fallback to 600px default
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setPanelHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // Re-run when nsLoading changes so the observer attaches after the loading
    // spinner is replaced by the actual tree container in the DOM.
  }, [nsLoading]);

  // Pagination tracking: maps nsKey → { offset, hasMore }
  const paginationRef = useRef<Map<TreeNodeKey, { offset: number; hasMore: boolean }>>(new Map());
  // Guard against concurrent onLoadData calls for the same namespace
  const loadingNsRef = useRef<Set<TreeNodeKey>>(new Set());
  // Loading state for sentinel nodes (next-page fetches)
  const [loadingMore, setLoadingMore] = useState<Record<TreeNodeKey, boolean>>({});
  // Error state for failed page fetches
  const [pageErrors, setPageErrors] = useState<Record<TreeNodeKey, string>>({});

  // ── Persist tree UI state on unmount ──────────────────────────────
  const setSafetyTreeState = useWorkspaceStore((s) => s.setSafetyTreeState);

  useEffect(() => {
    return () => {
      const expandedKeys = Object.keys(state.expandedKeys);
      const selectedKey = state.selectedKey;
      const selectedRecord = selectedKey ? state.nodesByKey[selectedKey] : null;
      const selectedElement = selectedRecord
        ? { nodeId: selectedRecord.nodeId, namespace: selectedRecord.namespace, concept: selectedRecord.concept, name: selectedRecord.title }
        : null;
      setSafetyTreeState(safetyNamespace, { expandedKeys, selectedKey, selectedElement });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safetyNamespace, setSafetyTreeState, state.expandedKeys, state.selectedKey, state.nodesByKey]);

  // Derive the nested Ant Design tree data from the normalized store
  const treeData = useMemo(
    () => {
      const stopTimer = treeDebug.startTimer('deriveAntTreeData');
      const { nodes, anomalyCount } = deriveAntTreeData(state, buildIcon);
      const data = nodes as unknown as SafetyTreeNode[];
      treeDebug.debug('deriveAntTreeData complete', {
        rootNodes: data.length,
        anomalyCount,
        totalNodesInStore: Object.keys(state.nodesByKey).length,
        expandedCount: Object.keys(state.expandedKeys).length,
        loadedParents: Object.keys(state.loadedParents).length,
      });
      stopTimer();
      return data;
    },
    [state],
  );

  // Derive arrays for Ant Design controlled props
  const selectedKeys = useMemo(
    () => (state.selectedKey ? [state.selectedKey] : []),
    [state.selectedKey],
  );
  const expandedKeys = useMemo(
    () => Object.keys(state.expandedKeys),
    [state.expandedKeys],
  );

  // Initialize root nodes for each imported namespace — lazy, no child fetches.
  // Children load on first expansion via onLoadData.
  const initRoots = useCallback(() => {
    if (!visibleNamespaces || visibleNamespaces.length === 0) return;

    treeDebug.info('INIT_NAMESPACES — registering imported namespace roots', {
      count: visibleNamespaces.length,
      names: visibleNamespaces.map((ns) => ns.name),
    });

    const namespaces = visibleNamespaces.map((ns) => {
      const nsKey = `ns:${ns.name}`;
      // Use the import source display name if available, fall back to namespace name (#53)
      const displayTitle = nsDisplayNameMap.get(ns.name) ?? ns.name;
      return {
        key: nsKey,
        record: {
          key: nsKey,
          nodeId: -1,
          namespace: ns.name,
          concept: 'namespace',
          nodeType: 'namespace' as const,
          title: displayTitle,
          isLeaf: false, // always expandable — children load on demand
          parentKey: null,
        },
        childRecords: [] as TreeNodeRecord[],
      };
    });

    dispatch({ type: 'INIT_NAMESPACES', namespaces });
    // No auto-expand — children load on first user expansion via onLoadData
  }, [visibleNamespaces, nsDisplayNameMap]);

  // Trigger init when namespaces arrive or change
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const readyFiredRef = useRef(false);
  const [treeReady, setTreeReady] = useState(false);

  useEffect(() => {
    if (visibleNamespaces && visibleNamespaces.length > 0) {
      initRoots();

      // Mark tree as ready — this triggers a re-render, ensuring the
      // imperative handle has the latest navigateToTreeNode closure
      // before we call onReady.
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        setTreeReady(true);
      }

      // Write tree shape summary to the lifecycle log via IPC
      api.app.logRendererEvent({
        level: 'debug',
        type: 'renderer.debug',
        message: 'ImportedTreePanel: namespaces initialized',
        component: 'ImportedTreePanel',
        context: {
          namespaceCount: visibleNamespaces.length,
          namespaces: visibleNamespaces.map((ns) => ns.name),
        },
      }).catch(() => { /* fire-and-forget */ });
    }
  }, [visibleNamespaces, initRoots]);

  // Fire onReady after the render that follows treeReady becoming true,
  // so the imperative handle has an up-to-date navigateToTreeNode closure.
  useEffect(() => {
    if (treeReady) {
      onReadyRef.current?.();
    }
  }, [treeReady]);


  // Refresh a node's children — loads the first page of structural children
  // plus all failure modes, dispatching LOAD_BRANCH_PAGE to the normalized store.
  const refreshNode = useCallback(async (node: SelectedTreeElement, offset = 0, limit = PAGE_SIZE) => {
    const parentKey = `${node.namespace}:${node.nodeId}`;
    const stopTimer = treeDebug.startTimer(`refreshNode ${node.concept} "${node.name ?? node.nodeId}" (${parentKey})`);

    const structuralChildrenPromise = api.namespaces.getChildren(node.namespace, node.nodeId, offset, limit);
    const failureModesPromise = (offset === 0 && canHostCrossNSSafetyElements(node.concept))
      ? api.safety.getMalfunctionsForElement(node.nodeId)
      : Promise.resolve([] as ConceptInstanceData[]);

    const [structuralChildren, failureModes] = await Promise.all([structuralChildrenPromise, failureModesPromise]);

    treeDebug.debug(`refreshNode result for "${node.name ?? node.nodeId}"`, {
      parentKey,
      structuralChildren: structuralChildren.children.length,
      failureModes: failureModes.length,
      totalChildren: structuralChildren.totalCount,
      offset,
      hasMore: structuralChildren.hasMore,
    });

    const children: TreeNodeRecord[] = [
      ...failureModes.map((fm) => toMalfunctionRecord(fm, parentKey)),
      ...structuralChildren.children.map((child) => toModelRecord(child, node.namespace, parentKey)),
    ];

    if (offset === 0) {
      // First page: replace all children
      dispatch({ type: 'LOAD_BRANCH', parentKey, children });
    } else {
      // Subsequent pages: append
      dispatch({
        type: 'LOAD_BRANCH_PAGE',
        parentKey,
        children,
        loadedCount: offset + structuralChildren.children.length,
        totalCount: structuralChildren.totalCount,
      });
    }

    // Track pagination for this node
    paginationRef.current.set(parentKey, {
      offset: offset + structuralChildren.children.length,
      hasMore: structuralChildren.hasMore,
    });

    // Append sentinel if there are more pages
    if (structuralChildren.hasMore) {
      dispatch({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, node.namespace) });
    } else {
      // Remove sentinel if no more pages (e.g. after a refresh)
      dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sentinelKey(parentKey) });
    }

    stopTimer();
  }, []);

  // Search state and handlers (declared after refreshNode to avoid forward reference)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultNode[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Shared navigation helper — used by both search and navigateToNode
  // ---------------------------------------------------------------------------
  const navigateToTreeNode = useCallback(async (params: NavigateToTreeNodeParams) => {
    const { nodeId, namespace, concept, name } = params;

    // Resolve crossNsTarget if not provided and concept is a malfunction
    const isAuthoredElement = params.crossNsTarget != null || isAuthoredConcept(concept);
    let crossNsTarget = params.crossNsTarget ?? null;
    let treeNamespace = namespace;

    if (crossNsTarget) {
      treeNamespace = crossNsTarget.namespace;
    } else if (isAuthoredElement && isMalfunctionConcept(concept)) {
      // Fallback: crossNsTarget missing — fetch the malfunction to get occursAtTarget
      try {
        const fmData = await api.safety.getMalfunction(nodeId);
        if (fmData.occursAtTarget) {
          crossNsTarget = {
            nodeId: fmData.occursAtTarget.node_id,
            namespace: fmData.occursAtTarget.namespace,
          };
          treeNamespace = fmData.occursAtTarget.namespace;
        }
      } catch { /* best-effort */ }
    }

    // Resolve ancestorPath if not provided
    let ancestorPath = params.ancestorPath;
    if (!ancestorPath) {
      try {
        // For malfunctions with a host, get the ancestor path of the host node
        const pathNodeId = crossNsTarget ? crossNsTarget.nodeId : nodeId;
        const pathNamespace = crossNsTarget ? crossNsTarget.namespace : treeNamespace;
        ancestorPath = await api.namespaces.getAncestorPath(pathNamespace, pathNodeId);
      } catch (err) {
        console.error('[navigate] Failed to fetch ancestor path:', err);
        return;
      }
    }

    const nsKey = `ns:${treeNamespace}`;
    // Check against both the reducer state AND the query data to avoid stale
    // closure issues — after a reload the INIT_NAMESPACES dispatch may not
    // have re-rendered yet when this callback runs.
    const nsKeyExists = !!state.nodesByKey[nsKey]
      || (visibleNamespaces ?? []).some((ns) => ns.name === treeNamespace);

    // If the namespace root isn't in the tree, we can't navigate —
    // just show the element in the center panel.
    if (!nsKeyExists) {
      onSelect({
        nodeId,
        namespace,
        concept,
        name,
      });
      return;
    }

    // If the namespace root exists in visibleNamespaces but hasn't been
    // dispatched to the reducer yet (stale closure after reload), ensure it
    // is present in the store before we proceed.
    if (!state.nodesByKey[nsKey]) {
      const namespaces = (visibleNamespaces ?? []).map((ns) => {
        const key = `ns:${ns.name}`;
        return {
          key,
          record: {
            key,
            nodeId: -1,
            namespace: ns.name,
            concept: 'namespace',
            nodeType: 'namespace' as const,
            title: ns.name,
            isLeaf: false,
            parentKey: null,
          },
          childRecords: [] as TreeNodeRecord[],
        };
      });
      dispatch({ type: 'INIT_NAMESPACES', namespaces });
    }

    // We track loaded records locally since state is stale inside an async callback.
    const localNodesByKey: Record<string, TreeNodeRecord> = { ...state.nodesByKey };
    const localLoadedParents = new Set<string>(Object.keys(state.loadedParents));

    // Step 1: Ensure namespace root children are loaded.
    if (!localLoadedParents.has(nsKey)) {
      try {
        const rootResult = await api.namespaces.getChildren(treeNamespace, undefined, 0, PAGE_SIZE);
        const childRecords: TreeNodeRecord[] = rootResult.children.map((c: TreeChildNode) =>
          toModelRecord(c, treeNamespace, nsKey),
        );
        dispatch({
          type: 'LOAD_BRANCH_PAGE',
          parentKey: nsKey,
          children: childRecords,
          loadedCount: childRecords.length,
          totalCount: rootResult.totalCount,
        });
        paginationRef.current.set(nsKey, {
          offset: childRecords.length,
          hasMore: rootResult.hasMore,
        });
        if (rootResult.hasMore) {
          const sentKey = sentinelKey(nsKey);
          if (!localNodesByKey[sentKey] && !state.nodesByKey[sentKey]) {
            dispatch({ type: 'INSERT_CHILD', parentKey: nsKey, child: toSentinelRecord(nsKey, treeNamespace) });
          }
        }
        for (const r of childRecords) {
          localNodesByKey[r.key] = r;
        }
        localLoadedParents.add(nsKey);
      } catch { /* best-effort */ }
    }

    // Step 2: Walk ancestor IDs in order, loading each level's children.
    for (const ancestorId of ancestorPath) {
      const ancestorKey = `${treeNamespace}:${ancestorId}`;
      const record = localNodesByKey[ancestorKey];

      if (!record) {
        console.warn(`[navigate] ancestor ${ancestorKey} not found in store`);
        break;
      }

      if (record.nodeType === 'namespace' || localLoadedParents.has(ancestorKey)) {
        continue;
      }

      try {
        await refreshNode({
          nodeId: record.nodeId,
          namespace: record.namespace,
          concept: record.concept,
          name: record.title,
        });
        const childResult = await api.namespaces.getChildren(record.namespace, record.nodeId);
        for (const c of childResult.children) {
          const childRecord = toModelRecord(c, record.namespace, ancestorKey);
          localNodesByKey[childRecord.key] = childRecord;
        }
        localLoadedParents.add(ancestorKey);
      } catch {
        break;
      }
    }

    // Step 3: Expand all ancestor keys + the namespace root
    const ancestorKeys = [nsKey, ...ancestorPath.map((id) => `${treeNamespace}:${id}`)];
    dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: ancestorKeys });

    // Step 4: Build the correct tree key and load the host node for authored elements.
    const nodeKey = isAuthoredElement
      ? malfunctionKey(namespace, nodeId)
      : `${treeNamespace}:${nodeId}`;

    if (isAuthoredElement && crossNsTarget) {
      const hostKey = `${crossNsTarget.namespace}:${crossNsTarget.nodeId}`;
      let hostRecord = localNodesByKey[hostKey];

      // If the host isn't in the local mirror, fetch and insert it.
      if (!hostRecord) {
        try {
          const hostInstance = await api.safety.getInstance(crossNsTarget.nodeId);
          hostRecord = {
            key: hostKey,
            nodeId: hostInstance.node_id,
            namespace: crossNsTarget.namespace,
            concept: hostInstance.concept,
            nodeType: 'model',
            title: String(hostInstance.attributes?.short_name ?? hostInstance.attributes?.has_name ?? hostInstance.concept),
            isLeaf: false,
            parentKey: ancestorPath.length > 0
              ? `${treeNamespace}:${ancestorPath[ancestorPath.length - 1]}`
              : nsKey,
          };
          dispatch({ type: 'INSERT_CHILD', parentKey: hostRecord.parentKey!, child: hostRecord });
          localNodesByKey[hostKey] = hostRecord;
        } catch { /* best-effort */ }
      }

      if (hostRecord) {
        try {
          await refreshNode({
            nodeId: hostRecord.nodeId,
            namespace: hostRecord.namespace,
            concept: hostRecord.concept,
            name: hostRecord.title,
          });
        } catch { /* best-effort */ }
      }
      dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
    }

    // Step 5: Set selected key, notify parent, and scroll after React flushes
    dispatch({ type: 'SET_SELECTED', key: nodeKey });
    onSelect({
      nodeId,
      namespace,
      concept,
      name,
    });
    setTimeout(() => {
      treeRef.current?.scrollTo({ key: nodeKey });
    }, 0);
  }, [state.loadedParents, state.nodesByKey, refreshNode, onSelect, visibleNamespaces]);

  // Expose imperative handle so SafetyEditor can dispatch actions directly.
  useImperativeHandle(ref, () => ({
    renameNode(nodeId: number, namespace: string, name: string) {
      const key = `${namespace}:${nodeId}`;
      const fmKey = malfunctionKey(namespace, nodeId);
      // Try model key first, fall back to failure mode key
      if (state.nodesByKey[key]) {
        dispatch({ type: 'PATCH_TITLE', key, title: name });
      } else if (state.nodesByKey[fmKey]) {
        dispatch({ type: 'PATCH_TITLE', key: fmKey, title: name });
      }
    },
    async navigateToNode(nodeId: number, namespace: string, concept: string) {
      try {
        // Let navigateToTreeNode resolve the correct tree namespace.
        // For malfunctions the tree namespace is the host's structural
        // namespace (resolved via occursAtTarget), not the authored
        // safety namespace passed in here — so we must NOT pre-check
        // against the raw namespace.
        await navigateToTreeNode({ nodeId, namespace, concept });
      } catch (err) {
        console.error('[ImportedTreePanel] navigateToNode failed:', err);
      }
    },
  }), [state.nodesByKey, navigateToTreeNode]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const result = await api.namespaces.search(value, 0, 50);
        setSearchResults(result.results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  const handleSearchResultSelect = useCallback(async (_value: string, option: { result: SearchResultNode }) => {
    const result = option.result;
    setSearchQuery('');
    setSearchResults([]);

    // Delegate to the shared navigation helper, passing the pre-resolved
    // ancestorPath and crossNsTarget from the search result.
    await navigateToTreeNode({
      nodeId: result.nodeId,
      namespace: result.namespace,
      concept: result.concept,
      name: result.name,
      ancestorPath: result.ancestorPath,
      crossNsTarget: result.crossNsTarget ?? null,
    });
  }, [navigateToTreeNode]);

  const onLoadData = useCallback(async (node: EventDataNode<SafetyTreeNode>) => {
    const treeNode = node as unknown as SafetyTreeNode;

    // Handle namespace folder nodes — fetch top-level children on first expansion
    if (treeNode.nodeType === 'namespace') {
      const nsKey = String(treeNode.key);
      // Skip if already loaded or currently loading (guards against double-fire)
      if (state.loadedParents[nsKey] || loadingNsRef.current.has(nsKey)) {
        treeDebug.debug(`onLoadData skip — namespace "${treeNode.namespace}" already loaded or in-flight`);
        return;
      }
      loadingNsRef.current.add(nsKey);

      const stopTimer = treeDebug.startTimer(`onLoadData namespace "${treeNode.namespace}"`);
      dispatch({ type: 'SET_LOADING', key: nsKey, loading: true });
      try {
        const result = await api.namespaces.getChildren(treeNode.namespace, undefined, 0, PAGE_SIZE);
        const childRecords: TreeNodeRecord[] = result.children.map((c: TreeChildNode) =>
          toModelRecord(c, treeNode.namespace, nsKey),
        );

        const conceptCounts: Record<string, number> = {};
        for (const c of result.children) {
          conceptCounts[c.concept] = (conceptCounts[c.concept] ?? 0) + 1;
        }

        treeDebug.info(`Namespace "${treeNode.namespace}" root children loaded`, {
          rootElements: childRecords.length,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
          conceptBreakdown: conceptCounts,
          leafNodes: childRecords.filter((r) => r.isLeaf).length,
          expandableNodes: childRecords.filter((r) => !r.isLeaf).length,
        });

        api.app.logRendererEvent({
          level: 'debug',
          type: 'renderer.debug',
          message: `ImportedTreePanel: namespace "${treeNode.namespace}" tree loaded`,
          component: 'ImportedTreePanel',
          context: {
            namespace: treeNode.namespace,
            rootElements: childRecords.length,
            totalCount: result.totalCount,
            leafNodes: childRecords.filter((r) => r.isLeaf).length,
            expandableNodes: childRecords.filter((r) => !r.isLeaf).length,
            conceptBreakdown: conceptCounts,
          },
        }).catch(() => { /* fire-and-forget */ });

        dispatch({
          type: 'LOAD_BRANCH_PAGE',
          parentKey: nsKey,
          children: childRecords,
          loadedCount: childRecords.length,
          totalCount: result.totalCount,
        });

        // Append sentinel if there are more pages
        if (result.hasMore) {
          dispatch({
            type: 'INSERT_CHILD',
            parentKey: nsKey,
            child: toSentinelRecord(nsKey, treeNode.namespace),
          });
        }

        // Track pagination state
        paginationRef.current.set(nsKey, {
          offset: childRecords.length,
          hasMore: result.hasMore,
        });
      } catch (err) {
        treeDebug.error(`onLoadData namespace "${treeNode.namespace}" FAILED`, {
          error: String((err as Error)?.message ?? err),
        });
      } finally {
        dispatch({ type: 'SET_LOADING', key: nsKey, loading: false });
        stopTimer();
      }
      return;
    }

    // Handle model nodes — fetch structural children + failure modes
    if (treeNode.nodeType !== 'model') return;

    const key = String(treeNode.key);
    dispatch({ type: 'SET_LOADING', key, loading: true });

    try {
      await refreshNode({
        nodeId: treeNode.nodeId,
        namespace: treeNode.namespace,
        concept: treeNode.concept,
        name: treeNode.name,
      });
    } catch (err) {
      treeDebug.error(`onLoadData model node "${treeNode.name}" (${key}) FAILED`, {
        error: String((err as Error)?.message ?? err),
      });
    } finally {
      dispatch({ type: 'SET_LOADING', key, loading: false });
    }
  }, [refreshNode, state.loadedParents]);

  const handleSelect = useCallback((_keys: React.Key[], info: { node: EventDataNode<SafetyTreeNode> }) => {
    const treeNode = info.node as unknown as SafetyTreeNode;

    // Sentinel node: trigger next page load
    if (treeNode.concept === 'sentinel') {
      const sKey = String(treeNode.key); // e.g. "sentinel:ns:MyNamespace" or "sentinel:ns:123"
      const parentKey = sKey.replace(/^sentinel:/, '');
      const pagination = paginationRef.current.get(parentKey);
      if (!pagination || !pagination.hasMore || loadingMore[parentKey]) return;

      // Resolve the parent node ID for the getChildren call.
      // Namespace roots use key format "ns:name" → parentNodeId = undefined
      // Model nodes use key format "namespace:nodeId" → parentNodeId = nodeId
      const parentRecord = state.nodesByKey[parentKey];
      const parentNodeId = parentRecord?.nodeType === 'namespace' ? undefined : parentRecord?.nodeId;

      setLoadingMore((prev) => ({ ...prev, [parentKey]: true }));
      setPageErrors((prev) => { const next = { ...prev }; delete next[parentKey]; return next; });

      api.namespaces.getChildren(treeNode.namespace, parentNodeId, pagination.offset, PAGE_SIZE)
        .then((result) => {
          const childRecords: TreeNodeRecord[] = result.children.map((c: TreeChildNode) =>
            toModelRecord(c, treeNode.namespace, parentKey),
          );

          // Remove old sentinel
          dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sKey });

          // Append new children
          dispatch({
            type: 'LOAD_BRANCH_PAGE',
            parentKey,
            children: childRecords,
            loadedCount: pagination.offset + childRecords.length,
            totalCount: result.totalCount,
          });

          // Update pagination tracking
          paginationRef.current.set(parentKey, {
            offset: pagination.offset + childRecords.length,
            hasMore: result.hasMore,
          });

          // Add new sentinel if still more pages
          if (result.hasMore) {
            dispatch({
              type: 'INSERT_CHILD',
              parentKey,
              child: toSentinelRecord(parentKey, treeNode.namespace),
            });
          }
        })
        .catch((err: unknown) => {
          treeDebug.error(`loadNextPage for "${parentKey}" FAILED`, {
            error: String((err as Error)?.message ?? err),
          });
          setPageErrors((prev) => ({
            ...prev,
            [parentKey]: String((err as Error)?.message ?? 'Failed to load more'),
          }));
        })
        .finally(() => {
          setLoadingMore((prev) => { const next = { ...prev }; delete next[parentKey]; return next; });
        });
      return;
    }

    dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
    if (treeNode.nodeId === -1) {
      onSelect(null);
      return;
    }
    onSelect({
      nodeId: treeNode.nodeId,
      namespace: treeNode.namespace,
      concept: treeNode.concept,
      name: treeNode.name,
    });
  }, [onSelect, loadingMore, state.nodesByKey]);

  const handleRightClick = useCallback((info: { event: React.MouseEvent; node: EventDataNode<SafetyTreeNode> }) => {
    info.event.preventDefault();
    const treeNode = info.node as unknown as SafetyTreeNode;
    if (treeNode.nodeId === -1) {
      setContextMenuNode(null);
      return;
    }

    dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
    onSelect({
      nodeId: treeNode.nodeId,
      namespace: treeNode.namespace,
      concept: treeNode.concept,
      name: treeNode.name,
    });
    setContextMenuNode({
      nodeId: treeNode.nodeId,
      namespace: treeNode.namespace,
      concept: treeNode.concept,
      name: treeNode.name,
    });
    setContextMenuPosition({ x: info.event.clientX, y: info.event.clientY });
  }, [onSelect]);

  const handleExpand = useCallback((keys: React.Key[]) => {
    dispatch({ type: 'SET_EXPANDED', keys: keys.map(String) });
  }, []);

  const handleFailureModeCreated = useCallback(async (created: { nodeId: number; name: string }) => {
    if (!createModalTarget) return;

    await refreshNode(createModalTarget);

    // Ensure the parent is expanded
    const parentKey = `${createModalTarget.namespace}:${createModalTarget.nodeId}`;
    if (!state.expandedKeys[parentKey]) {
      dispatch({ type: 'TOGGLE_EXPAND', key: parentKey });
    }

    const createdKey = malfunctionKey(createModalTarget.namespace, created.nodeId);
    dispatch({ type: 'SET_SELECTED', key: createdKey });
    onSelect({
      nodeId: created.nodeId,
      namespace: createModalTarget.namespace,
      concept: 'malfunction',
      name: created.name,
    });
  }, [createModalTarget, onSelect, refreshNode, state.expandedKeys]);

  if (nsLoading) {
    return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (!visibleNamespaces || visibleNamespaces.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={targetNamespace ? `No data for namespace "${targetNamespace}"` : 'No imported namespaces connected'}
        style={{ padding: 24, fontSize: 12 }}
      />
    );
  }

  return (
    <>
      <div style={{ padding: '4px 8px 4px' }}>
        <AutoComplete
          value={searchQuery}
          onChange={handleSearchChange}
          options={searchResults.map((r) => {
            const AUTHORED_TYPES = new Set(['malfunction', 'safety-note', 'safety-task', 'requirement', 'review-item']);
            const isOrphan = AUTHORED_TYPES.has(r.nodeType)
              && r.crossNsTarget == null
              && !(visibleNamespaces ?? []).some((ns) => ns.name === r.namespace);
            return {
              value: `${r.namespace}:${r.nodeId}`,
              label: (
                <div>
                  <span style={{ fontWeight: 500 }}>{r.name || `(${r.concept})`}</span>
                  <span style={{ color: '#8c8c8c', marginLeft: 8, fontSize: 11 }}>{r.concept} · {r.namespace}</span>
                  {isOrphan && (
                    <span style={{ color: '#faad14', marginLeft: 6, fontSize: 10, fontWeight: 600 }} title="Not attached to any element in the model tree">⚠ unlinked</span>
                  )}
                </div>
              ),
              result: r,
            };
          })}
          onSelect={handleSearchResultSelect}
          style={{ width: '100%' }}
          notFoundContent={
            searchLoading
              ? <Spin size="small" />
              : (searchQuery.length >= 2 ? 'No results' : null)
          }
        >
          <Input placeholder="Search elements…" size="small" />
        </AutoComplete>
      </div>
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', minHeight: 0, padding: '4px 0' }}>
        <Tree<SafetyTreeNode>
          ref={treeRef}
          virtual
          height={panelHeight}
          showIcon
          blockNode
          treeData={treeData}
          selectedKeys={selectedKeys}
          expandedKeys={expandedKeys}
          onExpand={handleExpand}
          loadData={onLoadData as (treeNode: EventDataNode<DataNode>) => Promise<void>}
          onSelect={handleSelect as (keys: React.Key[], info: { node: EventDataNode<DataNode> }) => void}
          onRightClick={handleRightClick as (info: { event: React.MouseEvent; node: EventDataNode<DataNode> }) => void}
          style={{ fontSize: 12 }}
          titleRender={(node) => {
            const treeNode = node as unknown as SafetyTreeNode;
            if (treeNode.concept === 'sentinel') {
              const parentKey = String(treeNode.key).replace(/^sentinel:/, '');
              if (loadingMore[parentKey]) {
                return <span style={{ color: '#8c8c8c' }}><Spin size="small" style={{ marginRight: 6 }} />Loading…</span>;
              }
              if (pageErrors[parentKey]) {
                return (
                  <span>
                    <span style={{ color: '#ff4d4f', marginRight: 8 }}>{pageErrors[parentKey]}</span>
                    <span
                      style={{ color: '#1677ff', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelect([], { node: node as unknown as EventDataNode<SafetyTreeNode> });
                      }}
                    >
                      Retry
                    </span>
                  </span>
                );
              }
              return <span style={{ color: '#1677ff', cursor: 'pointer' }}>Load more…</span>;
            }
            return treeNode.title as React.ReactNode;
          }}
        />
      </div>

      <TreeContextMenu
        node={contextMenuNode}
        position={contextMenuPosition}
        onClose={() => setContextMenuNode(null)}
        onAddMalfunction={safetyNamespace ? () => {
          setCreateModalTarget(contextMenuNode);
          setCreateModalOpen(true);
        } : undefined}
        onDelete={() => {
          if (!contextMenuNode) return;
          const nodeKey = contextMenuNode.concept === 'malfunction'
            ? `fm:${contextMenuNode.namespace}:${contextMenuNode.nodeId}`
            : `${contextMenuNode.namespace}:${contextMenuNode.nodeId}`;
          const record = state.nodesByKey[nodeKey];
          const parentKey = record?.parentKey;

          api.safety.deleteMalfunction(contextMenuNode.nodeId).then(() => {
            // Refresh the parent node to remove the deleted FM from the tree
            if (parentKey) {
              const parentRecord = state.nodesByKey[parentKey];
              if (parentRecord) {
                refreshNode({
                  nodeId: parentRecord.nodeId,
                  namespace: parentRecord.namespace,
                  concept: parentRecord.concept,
                });
              }
            }
            onSelect(null);
          }).catch((err: unknown) => {
            console.error('Failed to delete malfunction:', err);
          });
        }}
        pendingPropagationSource={pendingPropagationSource}
        onStartPropagation={onStartPropagation ? () => {
          if (!contextMenuNode) return;
          onStartPropagation(contextMenuNode);
        } : undefined}
        onEndPropagation={onEndPropagation ? () => {
          if (!contextMenuNode) return;
          onEndPropagation(contextMenuNode);
        } : undefined}
      />

      {safetyNamespace && (
        <CreateMalfunctionModal
          open={createModalOpen}
          namespace={safetyNamespace}
          selectedTreeElement={createModalTarget}
          onClose={() => {
            setCreateModalOpen(false);
            setCreateModalTarget(null);
          }}
          onCreated={handleFailureModeCreated}
        />
      )}
    </>
  );
  },
);
