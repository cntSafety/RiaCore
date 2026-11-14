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
import { App, Tree, Empty, Spin, AutoComplete, Input, Button, Popover, Modal, theme } from 'antd';
import { FolderOutlined, EditOutlined, LinkOutlined, LeftOutlined, RightOutlined, HistoryOutlined, DeleteOutlined } from '@ant-design/icons';
import {
  useState, useCallback, createElement, useEffect,
  useReducer, useMemo, useRef, useImperativeHandle, forwardRef,
} from 'react';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import { useAllNamespaces } from '../hooks/useTreeQueries';
import { useNamespaceConnections } from '../../../../../hooks/useNamespaceConnections';
import { selectAnalysisRootNamespaces } from '../utils/treeUtils';
import { getNodeDecoration, type NodeDecoration } from '../config/nodeTypeConfig';
import { getAsilIconColor } from '../config/asilColors';
import { useThemeMode, type ThemeMode } from '../../../../../theme/ThemeProvider';
import { useTreeDecorations } from '../hooks/useTreeDecorations';
import { navigateScopedTree, type TreeNavigationScope } from '../utils/scopedTreeNavigation';
import { getNamespaceDecorationByMetamodel } from '../../../../../lib/namespaceTypeDecoration';
import { api } from '../../../../../api/riacore';
import { resolveTreeReference } from '../utils/resolveTreeReference';
import type { SelectedTreeElement, ScopedTreeNavigator } from '../types';
import type { TreeChildNode, TreeReferenceNode, SearchResultNode, TreeNodeLocation, GetChildrenResponse } from '@riacore/app-contracts';
import { TreeContextMenu } from './TreeContextMenu';
import { CreateMalfunctionModal } from './CreateMalfunctionModal';
import { ReconnectOrphanedModal } from './ReconnectOrphanedModal';
import { SelectAnalysisNamespaceModal, type AnalysisNamespaceOption } from './SelectAnalysisNamespaceModal';
import { AnomalyBanner } from './AnomalyBanner';
import {
  treeReducer,
  initialTreeIndexState,
  deriveAntTreeData,
  type TreeNodeRecord,
  type TreeNodeKey,
} from '../utils/treeIndexStore';
import { validateChildrenResponse, validateNamespaceList } from '../utils/boundaryValidation';
import { treeDebug } from '../utils/treeDebugLog';
import { logOpEvent } from '../../../../../lib/opTrace';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import type { SafetyTreeSnapshot, PendingPropagationSource } from '../../../../../store/workspaceStore';
import { useWorkspaceState } from '../../../../../hooks/useWorkspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { treeChildrenQueryKey } from '../hooks/useTreeQueries';
import { useDeleteMalfunction, useDeleteSafetyNote, useDeleteTag, useDeleteSafetyTask, useDeleteRiskRatingFromTree, useDeleteReviewItem, useDeleteRequirement } from '../hooks/useSafetyMutations';
import { useTreeNavigationHistory, type HistoryEntry } from '../hooks/useTreeNavigationHistory';
import { DeleteWithPreview } from './DeleteWithPreview';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface NamespaceTreePanelProps {
  onSelect: (element: SelectedTreeElement | null) => void;
  safetyNamespace: string;
  /** When set, the panel operates in browse mode: shows only this imported namespace
   * directly, without requiring a safety analysis context. Safety authoring features
   * (malfunction creation, propagation, copy/paste) should not be passed in this mode. */
  browseNamespace?: string;
  /** A picker keeps navigation local and suppresses authoring context menus. */
  selectionOnly?: boolean;
  renderNodeSuffix?: (element: SelectedTreeElement) => React.ReactNode;
  onRequestAddNote?: () => void;
  onReady?: () => void;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
  /** Trigger auto-save of the authored namespace after element mutations or tree navigation. */
  triggerAutoSave?: () => void;
  /** Set this malfunction as the propagation source. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete propagation from the pending source to this malfunction. */
  onEndPropagation?: (node: SelectedTreeElement) => void;
  /** Copy the right-clicked malfunction to the clipboard. */
  onCopyMalfunction?: (node: SelectedTreeElement) => void;
  /** Paste the clipboard malfunction onto the right-clicked architecture element. */
  onPasteMalfunction?: (node: SelectedTreeElement) => void;
  /** Whether the clipboard currently holds a copied malfunction. */
  hasCopiedMalfunction?: boolean;
  /** Open the Malfunctions lens (the malfunction table) for the right-clicked architecture scope element. */
  onOpenInTableView?: (node: SelectedTreeElement) => void;
}

export interface NamespaceTreePanelHandle {
  renameNode: (nodeId: number, namespace: string, name: string) => void;
  navigateToNode: (nodeId: number, namespace: string, concept: string, usageContext?: SelectedTreeElement) => Promise<void>;
  /** Strict navigation for relationship rows; never widens the tree's scope. */
  navigateToNodeInScope: ScopedTreeNavigator;
  /**
   * Navigate to a cross-namespace reference child.
   * Prefers the host occurrence in the selected part usage, with the structural
   * host as a fallback, then selects the reference child.
   */
  navigateToReference: (
    refNodeId: number,
    refNamespace: string,
    refConcept: string,
    hostNodeId: number,
    hostNamespace: string,
  ) => Promise<void>;
  /**
   * Resolve and navigate to the reference location of the given selected node,
   * using the exact same logic as the right-click "Show Reference in Tree" menu:
   *  - a directly-selected reference child (hostNodeId/hostNamespace present),
   *  - a malfunction's occurs_at target (fetched on demand if not cached), or
   *  - a safety note's structural parent (from the tree store).
   * No-ops when the node has no reference location.
   */
  navigateToSelectedReference: (node: SelectedTreeElement) => Promise<void>;
  /** Force-reload the children of a namespace root (e.g. after a mutation adds/removes authored elements). */
  refreshNamespace: (namespace: string) => Promise<void>;
  /**
   * Deterministically reload a structural node's children and expand it so newly
   * added reference children (e.g. a pasted malfunction) appear immediately —
   * even when the node was never previously expanded. The cache-subscription
   * re-fetch silently skips never-expanded nodes, so callers that add children to
   * a possibly-collapsed structural parent must use this instead.
   */
  refreshStructuralParent: (node: SelectedTreeElement) => Promise<void>;
  /**
   * Open the Create Malfunction modal for the currently selected architecture node.
   * No-ops when no node is selected or the selected node cannot host malfunctions.
   */
  openAddMalfunctionModal: () => void;
  /**
   * Open the Delete Malfunction impact-preview modal for the currently selected node.
   * No-ops when no node is selected or the selected node is not a malfunction.
   */
  openDeleteMalfunctionModal: () => void;
  /** Clear the tree's own visual selection without notifying onSelect. */
  clearSelection: () => void;
}

/** Re-exported for test compatibility. */
export interface SafetyTreeNode extends DataNode {
  nodeId: number;
  namespace: string;
  concept: string;
  name: string;
  nodeType: 'namespace' | 'model' | 'malfunction' | 'safety-note' | 'safety-task'
           | 'requirement' | 'review-item' | 'tag' | 'reference';
  loadedCount?: number;
  totalCount?: number;
}

const PAGE_SIZE = 200;

/**
 * Upper bound on pages a single reveal may load per branch. A resolved node
 * location bounds paging to the element's own position, so this only guards the
 * unresolved fallback (and a branch that keeps reporting `hasMore`) against
 * draining an unbounded number of pages.
 */
const MAX_NAVIGATION_PAGES = 50;

/** Key for the toast shown while a reveal is still loading pages. */
const NAV_PROGRESS_KEY = 'tree-reveal-progress';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toModelRecord(child: TreeChildNode, namespace: string, parentKey: string | null): TreeNodeRecord {
  const isReference = child.isReference || parentKey?.startsWith('via:');
  return {
    key: isReference ? `via:${parentKey}/${encodeURIComponent(namespace)}:${child.node_id}` : `${namespace}:${child.node_id}`,
    nodeId: child.node_id,
    namespace,
    concept: child.concept,
    nodeType: isReference ? 'reference' : 'model',
    title: child.name || `(${child.concept})`,
    isLeaf: !child.hasChildren,
    parentKey,
    asil: child.asil,
    ...(isReference ? { referenceTarget: { nodeId: child.node_id, namespace, concept: child.concept } } : {}),
  };
}

function toReferenceRecord(
  ref: TreeReferenceNode,
  hostNamespace: string,
  hostNodeId: number,
  parentKey: string,
): TreeNodeRecord {
  return {
    key: `ref:${ref.sourceNamespace}:${ref.node_id}@${parentKey.startsWith('via:') ? parentKey : `${hostNamespace}:${hostNodeId}`}`,
    nodeId: ref.node_id,
    namespace: ref.sourceNamespace,
    concept: ref.concept,
    nodeType: 'reference',
    title: ref.name || `(${ref.concept})`,
    isLeaf: true,
    parentKey,
    referenceTarget: { nodeId: ref.node_id, namespace: ref.sourceNamespace, concept: ref.concept },
    asil: ref.asil,
  };
}

export function buildIcon(
  concept: string,
  nodeType?: string,
  role?: string,
  asil?: string,
  sysmlDecorations?: Record<string, NodeDecoration>,
  record?: TreeNodeRecord,
  /**
   * Theme the malfunction ASIL colour is resolved against.
   *
   * Explicit rather than read from context, because this is a plain function
   * called from the reducer-driven `deriveAntTreeData` path and from
   * `buildIconCached`, neither of which is a component. The caller that *is* a
   * component (`buildIconBound`) reads the theme and threads it down.
   */
  themeMode: ThemeMode = 'dark',
): React.ReactNode {
  if (nodeType === 'namespace') {
    // Use the shared namespace-type decoration when the record carries a metamodel
    // (namespace roots in the NamespaceTreePanel always have one). This makes the
    // tree icon/color consistent with the dashboard canvas card for the same namespace.
    if (record?.metamodel) {
      const nsDecoration = getNamespaceDecorationByMetamodel(record.metamodel);
      if (nsDecoration) {
        return createElement(nsDecoration.icon, { style: { color: nsDecoration.color } } as Record<string, unknown>);
      }
    }
    // Fallback: authored namespaces show a pencil, imported namespaces a folder.
    const icon = role === 'authored' ? EditOutlined : FolderOutlined;
    return createElement(icon, { style: { color: '#8c8c8c' } } as Record<string, unknown>);
  }
  if (nodeType === 'reference') {
    const decoration = getNodeDecoration(concept, sysmlDecorations);
    const iconColor = concept === 'malfunction' ? getAsilIconColor(asil ?? '', themeMode) : decoration.color;
    return createElement(
      'span',
      { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
      createElement(decoration.icon, { style: { color: iconColor } } as Record<string, unknown>),
      createElement(LinkOutlined, { style: { fontSize: 8, color: '#8c8c8c', marginLeft: 1 } } as Record<string, unknown>),
    );
  }
  const decoration = getNodeDecoration(concept, sysmlDecorations);
  const iconColor = concept === 'malfunction' ? getAsilIconColor(asil ?? '', themeMode) : decoration.color;
  return createElement(decoration.icon, { style: { color: iconColor } } as Record<string, unknown>);
}

// Module-level cache: concept strings map to stable React elements.
// There are ~20 distinct concepts; reusing elements avoids allocating new
// objects for every node on every treeData rebuild (previously 1,500+ per rebuild).
//
// The cache key folds in a `configVersion` so a metamodel reload (which changes
// the SysML decoration overlay identity) bumps the version and rebuilds icons
// instead of serving stale cached elements built from the previous config.
const _iconCache = new Map<string, React.ReactNode>();
export function buildIconCached(
  concept: string,
  asil?: string,
  sysmlDecorations?: Record<string, NodeDecoration>,
  configVersion = 0,
  record?: TreeNodeRecord,
  themeMode: ThemeMode = 'dark',
): React.ReactNode {
  // Namespace roots are keyed by their metamodel so each distinct type gets its
  // own cached icon (rather than sharing a single 'namespace' entry).
  const nsKey = record?.nodeType === 'namespace' ? `namespace:${record.metamodel ?? record.role ?? 'unknown'}` : null;
  const base = nsKey ?? (concept === 'malfunction' ? `malfunction:${asil ?? ''}` : concept);
  // `buildIcon` renders a different element for reference nodes (the concept icon
  // plus a LinkOutlined badge) than for own nodes, so nodeType has to be part of
  // the key. Without it a reference malfunction and an own malfunction with the
  // same ASIL collide and whichever renders first wins for both.
  //
  // `themeMode` is in the key for the same reason `configVersion` is: a cached
  // element holds a resolved colour, and the malfunction ASIL ramp has different
  // values per theme. Without it, switching the OS between light and dark serves
  // every already-built malfunction icon in the colour of the previous theme —
  // and because these entries never expire, they would stay wrong for the rest of
  // the session.
  const cacheKey = `${configVersion}:${themeMode}:${record?.nodeType ?? ''}:${base}`;
  if (!_iconCache.has(cacheKey)) {
    _iconCache.set(
      cacheKey,
      buildIcon(concept, record?.nodeType, record?.role, asil, sysmlDecorations, record, themeMode),
    );
  }
  return _iconCache.get(cacheKey)!;
}

function sentinelKey(parentKey: TreeNodeKey): TreeNodeKey {
  return `sentinel:${parentKey}`;
}

function toSentinelRecord(parentKey: TreeNodeKey, namespace: string): TreeNodeRecord {
  return {
    key: sentinelKey(parentKey),
    nodeId: -2,
    namespace,
    concept: 'sentinel',
    nodeType: 'model',
    title: 'Load more…',
    isLeaf: true,
    parentKey,
  };
}

// ---------------------------------------------------------------------------
// Helper: auto-opens the DeleteWithPreview modal on mount.
// Used to trigger the impact preview immediately when a node is selected for
// deletion via the context menu (no extra click required).
// ---------------------------------------------------------------------------
function _AutoOpenPreview({ onMount }: { onMount: () => void }) {
  useEffect(() => { onMount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const NamespaceTreePanel = forwardRef<NamespaceTreePanelHandle, NamespaceTreePanelProps>(
  function NamespaceTreePanel({ onSelect, safetyNamespace, browseNamespace, selectionOnly = false, renderNodeSuffix, onRequestAddNote, onReady, onNavigateToNode, onNavigateToReference, triggerAutoSave, onStartPropagation, onEndPropagation, onCopyMalfunction, onPasteMalfunction, hasCopiedMalfunction, onOpenInTableView }, ref) {

  const { token } = theme.useToken();
  const { message } = App.useApp();

  // Pending propagation source for this namespace (read directly from store)
  const pendingPropagationSource = useWorkspaceStore(
    (s) => s.pendingPropagationSource[safetyNamespace] ?? null,
  ) as PendingPropagationSource | null;

  // Derive workspaceKey from workspace state
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;

  const { data: allNamespaces, isLoading: nsLoading } = useAllNamespaces(workspaceKey);
  const [state, dispatch] = useReducer(treeReducer, initialTreeIndexState);

  // Cross-namespace tree scoping (Req 10.4 / Property 11): the tree for this
  // analysis shows the analysis itself plus ONLY the imported namespaces
  // explicitly connected to it via the per-pair RIA_UNIV_NamespaceConnection
  // edge — never imported namespaces connected only to a different analysis that
  // happens to share the same metamodel. The connection graph is the source of
  // truth; connect/disconnect mutations invalidate its query key (and
  // tree.namespaces), so this re-scopes automatically when connections change.
  const { data: connectionGraph } = useNamespaceConnections();
  // Stable primitive key of the connected-imported set for this analysis, so
  // `initRoots` identity only changes when the actual set changes (not on every
  // identical-content refetch of the connection graph — which would otherwise
  // re-dispatch INIT_NAMESPACES on each render).
  const connectedImportedKey = useMemo(() => {
    const names = (connectionGraph?.connections ?? [])
      .filter((c) => c.target === safetyNamespace)
      .map((c) => c.source)
      .sort();
    return names.join('\u0001');
  }, [connectionGraph, safetyNamespace]);

  // When enabled, the tree fetches hidden-by-default SysML concepts too. Bound
  // into every children fetch (query key + getChildren showAll arg) so the
  // visible set always matches this flag. Toggled from the global Settings dialog.
  const showAllTreeElements = useWorkspaceStore((s) => s.showAllTreeElements);

  // SysML v2 metamodel rendering config → concept → Decoration overlay. The
  // static NODE_TYPE_CONFIG stays authoritative; this overlay supplies icons/colors
  // for SysML concepts it does not already cover (see nodeTypeConfig.getNodeDecoration).
  // Both the JSON importer (SysMLv2) and the textual importer (SysMLv2Textual) are
  // fetched and merged so elements from either source get the correct icon/color.
  const sysmlDecorations = useTreeDecorations();
  const themeMode = useThemeMode();
  // Bump a version counter whenever the overlay identity changes so the
  // module-level icon cache (keyed by configVersion) rebuilds icons after a
  // metamodel reload instead of serving stale cached elements.
  const configVersionRef = useRef(0);
  const prevDecorationsRef = useRef<typeof sysmlDecorations>(undefined);
  const configVersion = useMemo(() => {
    if (sysmlDecorations !== prevDecorationsRef.current) {
      prevDecorationsRef.current = sysmlDecorations;
      configVersionRef.current += 1;
    }
    return configVersionRef.current;
  }, [sysmlDecorations]);
  // Icon builder bound with the SysML overlay + config version, passed to
  // deriveAntTreeData so every node resolves its decoration through the overlay.
  //
  // `themeMode` joins the binding for the same reason `configVersion` does: a
  // malfunction icon's colour comes from the theme-dependent ASIL ramp, and both
  // this callback's identity and the module cache's key have to move with it or
  // the tree keeps painting the previous theme's colours.
  const buildIconBound = useCallback(
    (concept: string, asil?: string, record?: TreeNodeRecord) =>
      buildIconCached(concept, asil, sysmlDecorations, configVersion, record, themeMode),
    [sysmlDecorations, configVersion, themeMode],
  );

  // Mutation hook for right-click delete — uses workspaceKey so tree.children is invalidated
  const deleteMalfunction = useDeleteMalfunction(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteSafetyNote = useDeleteSafetyNote(safetyNamespace, workspaceKey, triggerAutoSave, (nodeId) => {
    const key = stateRef.current.selectedKey;
    if (key && stateRef.current.nodesByKey[key]?.nodeId === nodeId) {
      dispatch({ type: 'SET_SELECTED', key: null });
      onSelect(null);
    }
  });
  const deleteTag = useDeleteTag(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteTask = useDeleteSafetyTask(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteRiskRating = useDeleteRiskRatingFromTree(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteReviewItem = useDeleteReviewItem(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteRequirement = useDeleteRequirement(safetyNamespace, workspaceKey, triggerAutoSave);
  // Node pending deletion — drives the DeleteWithPreview modal
  const [pendingDeleteNode, setPendingDeleteNode] = useState<SelectedTreeElement | null>(null);
  // Navigation history for back/forward within the tree — restored from Zustand on mount
  const savedNavHistory = useWorkspaceStore((s) => s.navigationHistory);
  const navHistory = useTreeNavigationHistory(33, selectionOnly ? undefined : savedNavHistory?.entries, selectionOnly ? undefined : savedNavHistory?.cursor);
  const [contextMenuNode, setContextMenuNode] = useState<SelectedTreeElement | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalTarget, setCreateModalTarget] = useState<SelectedTreeElement | null>(null);
  const [reconnectOrphanedOpen, setReconnectOrphanedOpen] = useState(false);
  const [reconnectOrphanedTarget, setReconnectOrphanedTarget] = useState<SelectedTreeElement | null>(null);
  // Browse mode only (see `browseNamespace`): the panel has no fixed
  // `safetyNamespace`, so "Add Malfunction" must first resolve which analysis
  // to author into. `browseCreateNamespace` is the analysis chosen for the
  // create-modal instance currently open; `selectAnalysisOptions` drives the
  // picker itself.
  const [selectAnalysisOpen, setSelectAnalysisOpen] = useState(false);
  const [selectAnalysisOptions, setSelectAnalysisOptions] = useState<AnalysisNamespaceOption[]>([]);
  const [browseCreateNamespace, setBrowseCreateNamespace] = useState<string | null>(null);

  // Virtual scrolling
  const [panelHeight, setPanelHeight] = useState(600);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<React.ComponentRef<typeof Tree> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setPanelHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nsLoading]);

  // Pagination tracking
  const paginationRef = useRef<Map<TreeNodeKey, { offset: number; hasMore: boolean }>>(new Map());
  // Concurrency guard: prevent duplicate onLoadData calls for the same key
  const loadingNsRef = useRef<Set<TreeNodeKey>>(new Set());
  const [loadingMore, setLoadingMore] = useState<Record<TreeNodeKey, boolean>>({});
  const [pageErrors, setPageErrors] = useState<Record<TreeNodeKey, string>>({});

  // ---------------------------------------------------------------------------
  // Tree sync via TanStack Query cache invalidation.
  //
  // When a mutation invalidates a tree.children query key, TanStack Query marks
  // that query as stale. We subscribe to the query cache and react to those
  // invalidations by re-fetching the affected parent and dispatching the result
  // to the reducer. This is the canonical TanStack Query pattern — no hacks,
  // no mutation-cache subscriptions, no setTimeout.
  //
  // The query cache subscription fires synchronously during React's commit
  // phase, so we defer the dispatch with queueMicrotask to stay outside any
  // ongoing render cycle.
  // ---------------------------------------------------------------------------
  const queryClient = useQueryClient();
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Keep the latest showAll flag available to the cache-subscription effect,
  // which is keyed only on [queryClient] and must not re-subscribe on toggle.
  const showAllTreeElementsRef = useRef(showAllTreeElements);
  showAllTreeElementsRef.current = showAllTreeElements;
  // Reference scope for the tree: the active analysis (undefined in browse mode).
  // Kept in a ref so the cache-subscription effect (keyed only on [queryClient])
  // always re-seeds with the same scoped key the tree loaded from.
  const scopeNamespaceRef = useRef<string | undefined>(browseNamespace ? undefined : safetyNamespace);
  scopeNamespaceRef.current = browseNamespace ? undefined : safetyNamespace;

  const navigationScope: TreeNavigationScope = {
    contextKey: JSON.stringify([workspaceKey, safetyNamespace, browseNamespace, showAllTreeElements]),
    analysisNamespace: safetyNamespace,
    browseNamespace,
    namespaces: allNamespaces,
    connections: connectionGraph?.connections,
    ready: wsState.phase === 'db_open' && !!allNamespaces && (!!browseNamespace || !!connectionGraph),
  };
  const navigationScopeRef = useRef(navigationScope);
  navigationScopeRef.current = navigationScope;
  const navigationMountedRef = useRef(true);
  useEffect(() => {
    navigationMountedRef.current = true;
    return () => { navigationMountedRef.current = false; };
  }, []);

  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const unsubscribe = queryCache.subscribe((event) => {
      // React to any update on tree.children keys.
      // In TanStack Query v5, invalidateQueries sets query.state.isInvalidated = true
      // and fires a 'updated' event. We check isInvalidated as the reliable signal.
      if (event.type !== 'updated') return;

      const key = event.query.queryKey;
      if (!Array.isArray(key) || key[0] !== 'tree.children') return;

      // Only react when the query was just invalidated
      if (!event.query.state.isInvalidated) return;

      // Extract namespace and parentNodeId from the query key:
      // ['tree.children', workspaceKey, namespace, parentNodeId?]
      const ns = key[2] as string | undefined;
      const parentNodeId = key[3] as number | undefined;
      if (!ns) return;

      const wk = workspaceKeyRef.current;
      if (!wk) return;

      // Determine the tree key for this parent
      const parentKey = parentNodeId !== undefined
        ? `${ns}:${parentNodeId}` as TreeNodeKey
        : `ns:${ns}` as TreeNodeKey;

      // Decide whether this parent is "live" in the tree and therefore needs a
      // refresh. We must NOT rely solely on the committed `loadedParents` map:
      // React commits reducer dispatches asynchronously, so a parent whose first
      // load was just dispatched — or is still in flight — is not yet in
      // `loadedParents`, even though its (possibly pre-mutation) data is about to
      // land in the tree. The tree.children query is registered in the cache
      // synchronously when a load starts, so its presence is the reliable
      // "load initiated" signal that the committed map misses.
      // Rebuild the panel's scoped key so the re-seed targets the exact query the
      // tree loaded from (the panel scopes references to the active analysis).
      const scope = scopeNamespaceRef.current;
      const qkey = treeChildrenQueryKey(wk, ns, parentNodeId, showAllTreeElementsRef.current, scope, true);
      const loadedNow = !!stateRef.current.loadedParents[parentKey];
      const loadInitiated = !!queryClient.getQueryCache().find({ queryKey: qkey, exact: true });
      // Never loaded and never fetched → nothing in the tree to update; the
      // branch will load fresh on its first expand.
      if (!loadedNow && !loadInitiated) {
        logOpEvent('tree.sync', 'frontend',
          'Tree sync skipped — parent not live in tree', {
            parentKey, namespace: ns, parentNodeId, loadedNow, loadInitiated,
          }, 'debug');
        return;
      }

      treeDebug.debug(`tree.children invalidated — re-fetching "${parentKey}"`);

      // Defer out of any ongoing render/commit cycle.
      // queueMicrotask is faster than setTimeout and still defers past the
      // current synchronous execution stack.
      queueMicrotask(() => {
        // If a first load for this parent is still in flight, it may have started
        // BEFORE this mutation committed and could resolve with stale data AFTER
        // us. Wait (bounded) for it to settle so the authoritative fetch below is
        // the last writer for this branch. Capped at ~20 × 25ms so a hung IPC
        // request never blocks the refresh indefinitely.
        const waitForInFlight = (attempt = 0): Promise<void> => {
          const q = queryClient.getQueryCache().find({ queryKey: qkey, exact: true });
          if (q && q.state.fetchStatus === 'fetching' && attempt < 20) {
            return new Promise<void>((r) => setTimeout(r, 25)).then(() => waitForInFlight(attempt + 1));
          }
          return Promise.resolve();
        };

        // Re-fetch by calling the API directly and seeding the cache via
        // setQueryData — deliberately NOT via fetchQuery or refetchQueries.
        //
        // - fetchQuery deduplicates onto an in-flight request that may have
        //   started BEFORE this mutation committed, returning pre-mutation data
        //   (the original intermittent stale-tree bug).
        // - refetchQueries uses cancelRefetch:true, which cancels and RESTARTS
        //   the query's fetch. The restart dispatches a new cache event while
        //   state.isInvalidated is still true (the flag is only cleared on fetch
        //   success), so THIS subscription re-enters and schedules another
        //   refetch — an infinite cancel/restart loop that freezes the renderer.
        //
        // A direct API call issues exactly one fresh request (post-commit, so it
        // cannot be stale); setQueryData then dispatches a 'success' that clears
        // isInvalidated, so the cache event it produces is filtered out by the
        // isInvalidated guard above — no re-entrancy, no loop.
        waitForInFlight()
          .then(async () => {
            // Refresh the prefix already loaded at any occurrence. Broad
            // annotation invalidation must not discard a usage on page two.
            const occurrences = Object.values(stateRef.current.nodesByKey)
              .filter(record => record.namespace === ns && record.nodeId === parentNodeId);
            const limit = Math.max(PAGE_SIZE, paginationRef.current.get(parentKey)?.offset ?? 0,
              ...occurrences.map(record => paginationRef.current.get(record.key)?.offset ?? 0));
            const result = await api.namespaces.getChildren(ns, parentNodeId, 0, limit, showAllTreeElementsRef.current, scope, true);
            // The shared cache still represents only the first page.
            queryClient.setQueryData(qkey, { ...result, children: result.children.slice(0, PAGE_SIZE), hasMore: result.totalCount > PAGE_SIZE });
            return result;
          })
          .then((result) => {
            if (!result) {
              treeDebug.warn(`Re-fetch after invalidation produced no data for "${parentKey}"`);
              return;
            }
            const anomalies = validateChildrenResponse(result.children, parentKey);
            for (const anomaly of anomalies) {
              treeDebug.warn('validateChildrenResponse anomaly on invalidation re-fetch', { anomaly });
              dispatchRef.current({ type: 'ADD_ANOMALY', anomaly });
            }
            // A source branch may be visible beneath several usages. Refresh
            // every loaded appearance using its own display keys.
            const parentKeys = new Set([parentKey, ...Object.values(stateRef.current.nodesByKey)
              .filter(record => record.namespace === ns && record.nodeId === parentNodeId &&
                record.key.startsWith('via:') && stateRef.current.loadedParents[record.key])
              .map(record => record.key)]);
            for (const displayParentKey of parentKeys) {
              const visibleChildren = result.children.slice(0, Math.max(PAGE_SIZE, paginationRef.current.get(displayParentKey)?.offset ?? 0));
              const hasMore = visibleChildren.length < result.totalCount;
              const children: TreeNodeRecord[] = [
                ...visibleChildren.map((c) => toModelRecord(c, ns, displayParentKey)),
                ...(result.references ?? []).map((ref) =>
                  toReferenceRecord(ref, ns, parentNodeId ?? -1, displayParentKey),
                ),
              ];
              dispatchRef.current({ type: 'LOAD_BRANCH', parentKey: displayParentKey, children });
              paginationRef.current.set(displayParentKey, {
                offset: visibleChildren.length,
                hasMore,
              });
              if (hasMore) {
                dispatchRef.current({ type: 'INSERT_CHILD', parentKey: displayParentKey, child: toSentinelRecord(displayParentKey, ns) });
              }
            }
            logOpEvent('tree.sync', 'frontend', 'Tree branch refreshed', {
              parentKey,
              namespace: ns,
              parentNodeId,
              childCount: result.children.length + (result.references?.length ?? 0),
              hasMore: result.hasMore,
            });
          }).catch((err) => {
            treeDebug.error(`Re-fetch after invalidation failed for "${parentKey}"`, { err: String(err) });
            logOpEvent('tree.sync', 'frontend', 'Tree branch refresh FAILED', {
              parentKey, namespace: ns, parentNodeId, error: String(err),
            }, 'error');
          });
      });
    });
    return unsubscribe;
  }, [queryClient]);
  const setSafetyTreeState = useWorkspaceStore((s) => s.setSafetyTreeState);
  const setNavigationHistory = useWorkspaceStore((s) => s.setNavigationHistory);
  useEffect(() => {
    if (selectionOnly) return;
    return () => {
      const expandedKeys = Object.keys(state.expandedKeys);
      const selectedKey = state.selectedKey;
      const selectedRecord = selectedKey ? state.nodesByKey[selectedKey] : null;
      let selectedElement: SafetyTreeSnapshot['selectedElement'] = null;
      if (selectedRecord) {
        selectedElement = {
          nodeId: selectedRecord.nodeId,
          namespace: selectedRecord.namespace,
          concept: selectedRecord.concept,
          name: selectedRecord.title,
        };
        if (selectedRecord.nodeType === 'reference' && selectedRecord.parentKey) {
          const host = state.nodesByKey[selectedRecord.parentKey];
          if (host) {
            selectedElement.hostNamespace = host.namespace;
            selectedElement.hostNodeId = host.nodeId;
          }
        }
      }
      setSafetyTreeState(safetyNamespace, { expandedKeys, selectedKey, selectedElement });
      // Persist navigation history
      setNavigationHistory({
        entries: [...navHistory.entries],
        cursor: navHistory.cursor,
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionOnly, safetyNamespace, setSafetyTreeState, setNavigationHistory, state.expandedKeys, state.selectedKey, state.nodesByKey]);

  // Derive Ant Design tree data.
  // Depends only on structural state — nodesByKey, childKeysByParent, rootKeys.
  // UI-only changes (selectedKey, expandedKeys, loadingKeys) do NOT affect tree
  // structure and must not trigger a full re-walk of all nodes.
  const treeData = useMemo(() => {
    const stopTimer = treeDebug.startTimer('deriveAntTreeData');
    const { nodes, anomalyCount } = deriveAntTreeData(state, buildIconBound, safetyNamespace);
    const data = nodes as unknown as SafetyTreeNode[];
    treeDebug.debug('deriveAntTreeData complete', {
      rootNodes: data.length,
      anomalyCount,
      totalNodesInStore: Object.keys(state.nodesByKey).length,
    });
    stopTimer();
    return data;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nodesByKey, state.childKeysByParent, state.rootKeys, buildIconBound]);

  const selectedKeys = useMemo(() => (state.selectedKey ? [state.selectedKey] : []), [state.selectedKey]);
  const expandedKeys = useMemo(() => Object.keys(state.expandedKeys), [state.expandedKeys]);

  // Initialize namespace roots
  const initRoots = useCallback(() => {
    if (!allNamespaces || allNamespaces.length === 0) return;

    // Boundary validation on namespace list
    const nsAnomalies = validateNamespaceList(allNamespaces);
    for (const anomaly of nsAnomalies) {
      treeDebug.warn('validateNamespaceList anomaly', { anomaly });
      dispatch({ type: 'ADD_ANOMALY', anomaly });
    }

    // Scope the roots to this analysis + its connected imported namespaces only
    // (Req 10.4 / Property 11). INIT_NAMESPACES replaces the root set and removes
    // stale namespace nodes, so a namespace that was disconnected drops out here.
    // In browse mode, show only the specified namespace directly.
    const connections = connectionGraph?.connections ?? [];
    const scopedNamespaces = browseNamespace
      ? allNamespaces.filter((ns) => ns.name === browseNamespace)
      : selectAnalysisRootNamespaces(allNamespaces, connections, safetyNamespace);

    treeDebug.info('INIT_NAMESPACES — registering scoped namespace roots', {
      analysis: safetyNamespace,
      count: scopedNamespaces.length,
      names: scopedNamespaces.map((ns) => ns.name),
      totalInWorkspace: allNamespaces.length,
    });

    const namespaces = scopedNamespaces.map((ns) => {
      const nsKey = `ns:${ns.name}`;
      return {
        key: nsKey,
        record: {
          key: nsKey,
          nodeId: -1,
          namespace: ns.name,
          concept: 'namespace',
          nodeType: 'namespace' as const,
          title: ns.name,
          isLeaf: false,
          parentKey: null,
          role: (ns.role === 'authored' || ns.role === 'imported') ? ns.role : 'imported',
          metamodel: ns.metamodel,
        } as TreeNodeRecord,
        childRecords: [] as TreeNodeRecord[],
      };
    });

    dispatch({ type: 'INIT_NAMESPACES', namespaces });
    // Reset pagination and loading guards on namespace refresh
    paginationRef.current.clear();
    loadingNsRef.current.clear();
  }, [allNamespaces, connectionGraph, safetyNamespace, connectedImportedKey, browseNamespace]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const readyFiredRef = useRef(false);
  const [treeReady, setTreeReady] = useState(false);

  useEffect(() => {
    if (allNamespaces && allNamespaces.length > 0) {
      initRoots();
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        setTreeReady(true);
      }
    }
  }, [allNamespaces, initRoots]);

  useEffect(() => {
    if (treeReady) {
      onReadyRef.current?.();
    }
  }, [treeReady]);

  // Reset tree only when workspaceKey changes to a different value — not on initial mount.
  const prevWorkspaceKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevWorkspaceKeyRef.current;
    prevWorkspaceKeyRef.current = workspaceKey;
    // Skip the initial mount (prev === undefined) and no-op changes
    if (prev === undefined || prev === workspaceKey) return;
    dispatch({ type: 'RESET' });
    paginationRef.current.clear();
    loadingNsRef.current.clear();
    readyFiredRef.current = false;
    setTreeReady(false);
  }, [workspaceKey]);

  // Reset + re-initialize the tree when the "Show all elements" filter changes.
  // Hidden-by-default concepts are filtered server-side, so the visible set —
  // and every branch's hasChildren / pagination counts — changes with the flag.
  // We reuse the SAME mechanism as the workspaceKey reset: dispatch RESET, clear
  // pagination/loading guards, then re-run initRoots() to re-register the roots.
  // Collapsed branches re-fetch lazily with the new showAll value (fetchChildren
  // keys the query by showAll), so expanded branches pick up the new filter on
  // re-expand. Skipped on first mount to avoid a redundant initial load.
  const prevShowAllRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const prev = prevShowAllRef.current;
    prevShowAllRef.current = showAllTreeElements;
    if (prev === undefined || prev === showAllTreeElements) return;
    dispatch({ type: 'RESET' });
    paginationRef.current.clear();
    loadingNsRef.current.clear();
    initRoots();
  }, [showAllTreeElements, initRoots]);

  // ---------------------------------------------------------------------------
  // fetchChildren — fetch via queryClient so results are cached and invalidation
  // triggers automatic re-fetches via the query cache subscription above.
  // ---------------------------------------------------------------------------
  const fetchChildren = useCallback(async (
    namespace: string,
    parentNodeId?: number,
    offset = 0,
    limit = PAGE_SIZE,
  ) => {
    const wk = workspaceKeyRef.current;
    // Scope cross-namespace references (occurs_at malfunctions, notes, tags) to
    // the active analysis so a shared imported element does not show artifacts
    // from a different analysis. In browse mode there is no analysis context, so
    // scope stays undefined (show everything on the imported element).
    const scope = browseNamespace ? undefined : safetyNamespace;
    // The cache stores only the standard first page. Larger prefix reads and
    // later pages must bypass it because the key does not include the limit.
    if (offset > 0 || limit !== PAGE_SIZE || !wk) {
      return api.namespaces.getChildren(namespace, parentNodeId, offset, limit, showAllTreeElements, scope, true);
    }
    return queryClient.fetchQuery<import('@riacore/app-contracts').GetChildrenResponse>({
      queryKey: treeChildrenQueryKey(wk, namespace, parentNodeId, showAllTreeElements, scope, true),
      queryFn: () => api.namespaces.getChildren(namespace, parentNodeId, 0, limit, showAllTreeElements, scope, true),
      staleTime: Infinity, // use cached result if available; invalidation forces re-fetch
    });
  }, [queryClient, showAllTreeElements, browseNamespace, safetyNamespace]);

  // ---------------------------------------------------------------------------
  // refreshNode — load children for a model node
  // ---------------------------------------------------------------------------
  const refreshNode = useCallback(async (node: SelectedTreeElement, offset = 0, limit = PAGE_SIZE, displayKey?: string) => {
    const parentKey = displayKey ?? `${node.namespace}:${node.nodeId}`;
    const stopTimer = treeDebug.startTimer(`refreshNode ${node.concept} "${node.name ?? node.nodeId}"`);

    const result = await fetchChildren(node.namespace, node.nodeId, offset, limit);

    // Boundary validation
    const anomalies = validateChildrenResponse(result.children, parentKey);
    for (const anomaly of anomalies) {
      treeDebug.warn('validateChildrenResponse anomaly', { anomaly });
      dispatch({ type: 'ADD_ANOMALY', anomaly });
    }

    const children: TreeNodeRecord[] = [
      ...result.children.map((child) => toModelRecord(child, node.namespace, parentKey)),
      ...result.references.map((ref) => toReferenceRecord(ref, node.namespace, node.nodeId, parentKey)),
    ];

    if (offset === 0) {
      dispatch({ type: 'LOAD_BRANCH', parentKey, children });
    } else {
      dispatch({
        type: 'LOAD_BRANCH_PAGE',
        parentKey,
        children,
        loadedCount: offset + result.children.length,
        totalCount: result.totalCount,
      });
    }

    paginationRef.current.set(parentKey, {
      offset: offset + result.children.length,
      hasMore: result.hasMore,
    });

    if (result.hasMore) {
      dispatch({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, node.namespace) });
    } else {
      dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sentinelKey(parentKey) });
    }

    stopTimer();
  }, [fetchChildren]);

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultNode[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // navigateToTreeNode — simplified: no crossNsTarget, navigate within own namespace
  // ---------------------------------------------------------------------------
  const navigateToTreeNode = useCallback(async (params: {
    nodeId: number;
    namespace: string;
    concept: string;
    name?: string;
    ancestorPath?: number[];
    suppressSelect?: boolean;
  }): Promise<boolean> => {
    const { nodeId, namespace, concept, name, suppressSelect } = params;
    const nsKey = `ns:${namespace}`;

    // Check namespace exists in the current list
    const nsExists = !!state.nodesByKey[nsKey]
      || (allNamespaces ?? []).some((ns) => ns.name === namespace);

    if (!nsExists) {
      // Namespace not in tree — just notify parent
      if (!suppressSelect) onSelect({ nodeId, namespace, concept, name });
      return false;
    }

    // Ensure namespace root is in the store
    if (!state.nodesByKey[nsKey] && allNamespaces) {
      // Normally the tree is scoped to this analysis + its connected imports
      // (Req 10.4 / Property 11), so we must NOT re-register every workspace
      // namespace here. But when we are explicitly navigating to a node whose
      // namespace is genuinely linked to this analysis (e.g. an occurs_at host)
      // yet is not in the scoped set, we must still surface that one host root —
      // otherwise the reference child exists in the store but has no rendered
      // ancestor path and "Show Reference in Tree" silently does nothing.
      const scoped = browseNamespace
        ? allNamespaces.filter((ns) => ns.name === browseNamespace)
        : selectAnalysisRootNamespaces(allNamespaces, connectionGraph?.connections ?? [], safetyNamespace);
      const rootNamespaces = [...scoped];
      if (!rootNamespaces.some((ns) => ns.name === namespace)) {
        const hostNs = allNamespaces.find((ns) => ns.name === namespace);
        if (hostNs) rootNamespaces.push(hostNs);
      }
      const namespaces = rootNamespaces.map((ns) => {
        const key = `ns:${ns.name}`;
        return {
          key,
          record: {
            key, nodeId: -1, namespace: ns.name, concept: 'namespace',
            nodeType: 'namespace' as const, title: ns.name, isLeaf: false, parentKey: null,
            role: (ns.role === 'authored' || ns.role === 'imported') ? ns.role : 'imported',
            metamodel: (ns as { metamodel?: string }).metamodel,
          } as TreeNodeRecord,
          childRecords: [] as TreeNodeRecord[],
        };
      });
      dispatch({ type: 'INIT_NAMESPACES', namespaces });
    }

    // Resolve where the node sits in the tree's own page order. Each level's
    // child index tells us which pages to load, so every level of the path can
    // be materialized — not just page zero of each ancestor.
    let location: TreeNodeLocation | null = null;
    try {
      location = await api.namespaces.getNodeLocation(namespace, nodeId, showAllTreeElementsRef.current, true);
    } catch (err) {
      treeDebug.warn('[navigate] Failed to resolve node location', { err: String(err) });
    }

    // Fall back to the ancestor-id path when the node is not a visible
    // containment child at every level — an orphan, a concept hidden by the
    // display settings, or an authored element the tree shows only as a
    // reference child. Paging then runs without index hints.
    let ancestorPath = params.ancestorPath;
    if (!location?.resolved && !ancestorPath) {
      try {
        ancestorPath = await api.namespaces.getAncestorPath(namespace, nodeId);
      } catch (err) {
        treeDebug.warn('[navigate] Failed to fetch ancestor path', { err: String(err) });
        if (!suppressSelect) onSelect({ nodeId, namespace, concept, name });
        return false;
      }
    }

    const localNodesByKey: Record<string, TreeNodeRecord> = { ...state.nodesByKey };
    const localLoadedParents = new Set<string>(Object.keys(state.loadedParents));
    const targetKey = `${namespace}:${nodeId}`;

    // Child index per parent branch, keyed the way the store keys parents.
    const indexByParentKey = new Map<string, number>();
    for (const level of location?.levels ?? []) {
      const levelParentKey = level.parentNodeId === undefined ? nsKey : `${namespace}:${level.parentNodeId}`;
      indexByParentKey.set(levelParentKey, level.childIndex);
    }

    // Loading pages is the slow part of a reveal on a large branch, and a silent
    // pause is indistinguishable from a reveal that did nothing. Show the toast
    // lazily, so the common single-page case stays silent.
    let progressShown = false;
    const showProgress = () => {
      if (progressShown || suppressSelect) return;
      progressShown = true;
      void message.loading({ content: 'Locating element in the tree…', key: NAV_PROGRESS_KEY, duration: 0 });
    };
    const clearProgress = () => {
      if (!progressShown) return;
      progressShown = false;
      void message.destroy(NAV_PROGRESS_KEY);
    };

    // Load page zero of a branch that nothing has opened yet. Model parents go
    // through refreshNode so boundary validation, cross-namespace reference
    // children and the Load more sentinel behave exactly as on manual expansion.
    const loadFirstPage = async (parentKey: string, parentNodeId: number | undefined): Promise<void> => {
      if (localLoadedParents.has(parentKey)) return;
      try {
        if (parentNodeId === undefined) {
          const rootResult = await fetchChildren(namespace, undefined, 0, PAGE_SIZE);
          const childRecords = rootResult.children.map((c: TreeChildNode) =>
            toModelRecord(c, namespace, parentKey),
          );
          dispatch({
            type: 'LOAD_BRANCH_PAGE',
            parentKey,
            children: childRecords,
            loadedCount: childRecords.length,
            totalCount: rootResult.totalCount,
          });
          paginationRef.current.set(parentKey, { offset: childRecords.length, hasMore: rootResult.hasMore });
          if (rootResult.hasMore) {
            dispatch({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, namespace) });
          }
          for (const r of childRecords) localNodesByKey[r.key] = r;
        } else {
          const record = localNodesByKey[parentKey];
          if (!record) return;
          await refreshNode({
            nodeId: record.nodeId,
            namespace: record.namespace,
            concept: record.concept,
            name: record.title,
          });
          // refreshNode dispatches to the reducer; mirror the same page locally,
          // because `state` is stale inside this async closure. Page zero is
          // cached, so this re-read does not hit the backend again.
          const mirrored = await fetchChildren(namespace, parentNodeId, 0, PAGE_SIZE);
          for (const c of mirrored.children) {
            const cr = toModelRecord(c, namespace, parentKey);
            localNodesByKey[cr.key] = cr;
          }
        }
        localLoadedParents.add(parentKey);
      } catch (err) {
        treeDebug.warn('[navigate] first page load failed', { parentKey, err: String(err) });
      }
    };

    // Append pages under `parentKey` until `wantedKey` is in the store. With a
    // child index from namespaces.getNodeLocation the element's page is known, so
    // this stops there; without one it pages until found or exhausted.
    const loadPagesUntilPresent = async (
      parentKey: string,
      parentNodeId: number | undefined,
      wantedKey: string,
    ): Promise<void> => {
      const wantedIndex = indexByParentKey.get(parentKey);
      // Resume from whatever this branch already loaded. Re-fetching page zero
      // would drop previously loaded siblings and their expanded branches.
      let cursor = paginationRef.current.get(parentKey) ?? { offset: 0, hasMore: true };
      for (let page = 0; page < MAX_NAVIGATION_PAGES; page++) {
        if (localNodesByKey[wantedKey] || !cursor.hasMore) return;
        // Past the known index: no later page can contain the element, so a
        // missing record means hidden or stale rather than not yet loaded.
        if (wantedIndex !== undefined && cursor.offset > wantedIndex) return;
        showProgress();
        let result: Awaited<ReturnType<typeof fetchChildren>>;
        try {
          result = await fetchChildren(namespace, parentNodeId, cursor.offset, PAGE_SIZE);
        } catch (err) {
          treeDebug.warn('[navigate] page fetch failed', { parentKey, offset: cursor.offset, err: String(err) });
          return;
        }
        if (result.children.length === 0) return; // no progress — do not spin
        const pageRecords = result.children.map((c: TreeChildNode) =>
          toModelRecord(c, namespace, parentKey),
        );
        const nextOffset = cursor.offset + result.children.length;
        // Drop the sentinel before appending so it stays the last child.
        dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sentinelKey(parentKey) });
        dispatch({
          type: 'LOAD_BRANCH_PAGE',
          parentKey,
          children: pageRecords,
          loadedCount: nextOffset,
          totalCount: result.totalCount,
        });
        for (const r of pageRecords) localNodesByKey[r.key] = r;
        cursor = { offset: nextOffset, hasMore: result.hasMore };
        paginationRef.current.set(parentKey, cursor);
        if (result.hasMore) {
          dispatch({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, namespace) });
        }
      }
      treeDebug.warn('[navigate] page budget exhausted', { parentKey, wantedKey, offset: cursor.offset });
    };

    // The chain of nodes to materialize, root-level first. A resolved location is
    // authoritative: it is same-namespace and carries indexes. The ancestor-id
    // path is the fallback for everything it could not resolve.
    const chain = location?.resolved && location.levels.length > 0
      ? location.levels.map((level) => level.nodeId)
      : [...(ancestorPath ?? []), nodeId];

    // Walk the chain, loading each level far enough to contain the next one.
    // Loading only page zero per level is what previously stranded a reveal at
    // the first ancestor sitting beyond its parent's first page.
    let parentKey = nsKey;
    let parentNodeId: number | undefined;
    let located = true;
    try {
      for (const wantedId of chain) {
        const wantedKey = `${namespace}:${wantedId}`;
        if (!localNodesByKey[wantedKey]) {
          await loadFirstPage(parentKey, parentNodeId);
          await loadPagesUntilPresent(parentKey, parentNodeId, wantedKey);
        }
        if (!localNodesByKey[wantedKey]) {
          treeDebug.warn('[navigate] level not found in store', { parentKey, wantedKey });
          located = false;
          break;
        }
        parentKey = wantedKey;
        parentNodeId = wantedId;
      }
    } finally {
      // The toast has no duration, so it must not outlive an unexpected throw.
      clearProgress();
    }

    // Expand the resolved ancestors (the chain without the target itself).
    const ancestorKeys = [nsKey, ...chain.slice(0, -1).map((id) => `${namespace}:${id}`)];
    dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: ancestorKeys });

    if (!located) {
      // Never select a key the tree cannot render: a selection with no visible
      // row is exactly the "reveal silently did nothing" symptom. Open the
      // element in the center panel and say the tree could not show it.
      if (!suppressSelect) {
        message.warning('This element could not be revealed in the tree. It may be hidden by the tree display settings, or no longer present.');
        navHistory.push({ nodeId, namespace, concept, name });
        onSelect({ nodeId, namespace, concept, name });
      }
      return false;
    }

    dispatch({ type: 'SET_SELECTED', key: targetKey });
    if (!suppressSelect) {
      // Reveal callers may only know the identity. Select the same metadata as
      // a row click, using the local mirror for pages loaded before React commits.
      const target = localNodesByKey[targetKey];
      const navEntry = { nodeId, namespace, concept: target.concept, name: target.title };
      navHistory.push(navEntry);
      onSelect(navEntry);
      setTimeout(() => { treeRef.current?.scrollTo({ key: targetKey }); }, 0);
    }
    return true;
  }, [state.loadedParents, state.nodesByKey, refreshNode, fetchChildren, onSelect, allNamespaces, navHistory, message]);

  // Look for a loaded host before the shared async resolver queries graph data.
  // Used by the context menu and navigateToSelectedReference:
  //  - malfunction → its occurs_at target, read from the malfunction detail cache
  //  - safety_note → its structural parent, derived from the tree store's parentKey
  // Returns null when the location is not loaded; authored roots are resolved
  // on demand rather than treating a cold cache as an unlinked element.
  const resolveReferenceTarget = useCallback(
    (node: { nodeId: number; namespace: string; concept: string }):
      { node_id: number; namespace: string; concept: string } | null => {
      if (node.concept === 'malfunction') {
        const cached = queryClient.getQueryData<import('@riacore/app-contracts').MalfunctionData>(
          ['safety.malfunction', node.nodeId],
        );
        return cached?.occursAtTarget ?? null;
      }
      if (node.concept === 'safety_note') {
        const noteRecord = Object.values(stateRef.current.nodesByKey).find(
          (r) => r.nodeId === node.nodeId && r.namespace === node.namespace && r.concept === 'safety_note',
        );
        const parentKey = noteRecord?.parentKey;
        if (parentKey && !parentKey.startsWith('ns:')) {
          const parent = stateRef.current.nodesByKey[parentKey];
          if (parent) {
            return { node_id: parent.nodeId, namespace: parent.namespace, concept: parent.concept };
          }
        }
      }
      return null;
    },
    [queryClient],
  );

  // Follow only the target's source containment path beneath the nearest selected
  // part usage. Never search sibling usages or choose an arbitrary loaded copy.
  const findReferenceOccurrence = useCallback(async (
    hostNodeId: number, hostNamespace: string, preferredTreeKey?: string, startNode?: TreeNodeRecord,
  ): Promise<{ host: TreeNodeRecord; steps: { parent: TreeNodeRecord; limit: number; page: GetChildrenResponse }[] } | null> => {
    const snapshot = stateRef.current;
    let current = snapshot.nodesByKey[preferredTreeKey ?? snapshot.selectedKey ?? ''] ?? startNode;
    const seen = new Set<string>();
    while (current && !seen.has(current.key)) {
      seen.add(current.key);
      if (current.nodeId === hostNodeId && current.namespace === hostNamespace && !current.key.startsWith('ref:')) {
        return { host: current, steps: [] };
      }
      if (current.concept === 'part_usage') break;
      current = snapshot.nodesByKey[current.parentKey ?? ''];
    }
    if (!current || current.concept !== 'part_usage' || current.namespace !== hostNamespace) return null;

    const sourcePath = [...await api.namespaces.getAncestorPath(hostNamespace, hostNodeId), hostNodeId];
    const steps: { parent: TreeNodeRecord; limit: number; page: GetChildrenResponse }[] = [];
    let pathIndex = -1;
    const visited = new Set<number>([current.nodeId]);
    for (let depth = 0; depth < 50; depth++) {
      const matches: { row: TreeChildNode; index: number; limit: number }[] = [];
      let offset = 0;
      const children: TreeChildNode[] = [];
      let lastPage: GetChildrenResponse | undefined;
      for (let page = 0; page < MAX_NAVIGATION_PAGES; page++) {
        const result = await fetchChildren(hostNamespace, current.nodeId, offset, PAGE_SIZE);
        const nextOffset = offset + result.children.length;
        children.push(...result.children);
        lastPage = result;
        for (const row of result.children) {
          const index = sourcePath.indexOf(row.node_id, pathIndex + 1);
          if (index >= 0) matches.push({ row, index, limit: nextOffset });
        }
        // Incomplete/ambiguous searches must use the declaration fallback.
        if (matches.length > 1) return null;
        if (!result.hasMore) break;
        if (nextOffset <= offset || page === MAX_NAVIGATION_PAGES - 1) return null;
        offset = nextOffset;
      }
      if (matches.length !== 1 || !lastPage) return null;
      const match = matches[0];
      if (visited.has(match.row.node_id)) return null;
      steps.push({ parent: current, limit: match.limit, page: { ...lastPage, children, offset: 0 } });
      current = toModelRecord(match.row, hostNamespace, current.key);
      pathIndex = match.index;
      if (current.nodeId === hostNodeId) return { host: current, steps };
      if (current.isLeaf) return null;
      visited.add(current.nodeId);
    }
    return null;
  }, [fetchChildren]);

  // Both port navigation and authored-reference navigation materialize the same
  // usage path. Keep page retention, occurrence keys and expansion identical.
  const materializeOccurrence = useCallback((
    preferred: NonNullable<Awaited<ReturnType<typeof findReferenceOccurrence>>>, isCurrent: () => boolean,
  ): boolean => {
    for (const { parent, limit, page } of preferred.steps) {
      if (!isCurrent()) return false;
      const visible = page.children.slice(0, Math.max(limit, paginationRef.current.get(parent.key)?.offset ?? 0));
      const hasMore = visible.length < page.totalCount;
      dispatch({ type: 'LOAD_BRANCH', parentKey: parent.key, children: [
        ...visible.map(child => toModelRecord(child, parent.namespace, parent.key)),
        ...page.references.map(child => toReferenceRecord(child, parent.namespace, parent.nodeId, parent.key)),
      ] });
      paginationRef.current.set(parent.key, { offset: visible.length, hasMore });
      if (hasMore) dispatch({ type: 'INSERT_CHILD', parentKey: parent.key, child: toSentinelRecord(parent.key, parent.namespace) });
    }
    const ancestors: string[] = [];
    let ancestor = stateRef.current.nodesByKey[preferred.steps[0]?.parent.key ?? preferred.host.key];
    while (ancestor && !ancestors.includes(ancestor.key)) {
      ancestors.push(ancestor.key);
      ancestor = stateRef.current.nodesByKey[ancestor.parentKey ?? ''];
    }
    dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [...ancestors, ...preferred.steps.map(step => step.parent.key)] });
    return true;
  }, []);

  const referenceNavigationId = useRef(0);
  // Core "navigate to a reference child" routine. Extracted so both the imperative
  // navigateToReference (called with explicit host coordinates) and
  // navigateToSelectedReference (which resolves the target first) share one
  // implementation.
  const performNavigateToReference = useCallback(
    async (
      refNodeId: number,
      refNamespace: string,
      refConcept: string,
      hostNodeId: number,
      hostNamespace: string,
      options: { name?: string; recordHistory?: boolean; treeKey?: string } = {},
    ) => {
      const requestId = ++referenceNavigationId.current;
      const contextKey = navigationScopeRef.current.contextKey;
      const isCurrent = () => navigationMountedRef.current && referenceNavigationId.current === requestId
        && navigationScopeRef.current.contextKey === contextKey;
      let occurrence: Awaited<ReturnType<typeof findReferenceOccurrence>> = null;
      try {
        occurrence = await findReferenceOccurrence(hostNodeId, hostNamespace, options.treeKey);
      } catch (err) {
        treeDebug.warn('[reference] usage occurrence unavailable; using declaration', { err: String(err) });
      }
      if (!isCurrent()) return false;

      const selectAtHost = async (preferred: typeof occurrence): Promise<boolean> => {
        const hostKey = preferred?.host.key ?? `${hostNamespace}:${hostNodeId}`;
        const refKey = `ref:${refNamespace}:${refNodeId}@${hostKey}`;

        // Step 1: Materialize the selected occurrence, or use the structural host.
        // Pass suppressSelect=true so onSelect is NOT called for the host node,
        // preventing the center panel from switching to the port mid-navigation.
        if (preferred) {
          if (!materializeOccurrence(preferred, isCurrent)) return false;
        } else {
          await navigateToTreeNode({ nodeId: hostNodeId, namespace: hostNamespace, concept: '', suppressSelect: true });
        }
        if (!isCurrent()) return false;

        // Also expand the host node itself so its reference children are visible.
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });

        // Step 2: Load the host node's children (including cross-NS reference nodes).
        await refreshNode({ nodeId: hostNodeId, namespace: hostNamespace, concept: '', name: '' }, 0,
          Math.max(PAGE_SIZE, paginationRef.current.get(hostKey)?.offset ?? 0), hostKey);
        if (!isCurrent()) return false;

        // Step 3: Wait for React to commit the LOAD_BRANCH dispatch, then select
        // the reference child key. Poll stateRef (always current) rather than using
        // a fixed timeout — avoids the race where the key isn't in nodesByKey yet
        // when the timeout fires (cold cache, slow machine, large tree).
        return new Promise<boolean>((resolve) => {
          const waitForKeyAndSelect = (attempts = 0) => {
            if (!isCurrent()) { resolve(false); return; }
            if (stateRef.current.nodesByKey[refKey]) {
              const element = {
                nodeId: refNodeId, namespace: refNamespace, concept: refConcept,
                name: options.name ?? stateRef.current.nodesByKey[refKey].title,
                hostNodeId, hostNamespace,
                ...(refKey.includes('via:') ? { treeKey: refKey } : {}),
              };
              dispatch({ type: 'SET_SELECTED', key: refKey });
              if (options.recordHistory || refKey.includes('via:')) navHistory.push({ ...element, treeKey: refKey });
              onSelect(element);
              // rc-tree keeps the previous flattened rows during its expand
              // animation. Retry scrolling until the selected row is rendered;
              // the reference can exist in our store before rc-tree can scroll to it.
              const scrollToReference = (attempt = 0) => {
                if (stateRef.current.selectedKey !== refKey || !containerRef.current) return;
                // Keep the current viewport when the reference already fits;
                // otherwise reveal it with the smallest necessary scroll.
                treeRef.current?.scrollTo({ key: refKey });
                const selectedRow = containerRef.current.querySelector('[role="treeitem"][aria-selected="true"]');
                if (!selectedRow && attempt < 20) {
                  setTimeout(() => scrollToReference(attempt + 1), 50);
                }
              };
              setTimeout(() => scrollToReference(), 50);
              resolve(true);
            } else if (attempts < 20) {
              // Retry up to 20 × 50ms = 1s
              setTimeout(() => waitForKeyAndSelect(attempts + 1), 50);
            } else {
              treeDebug.warn('[performNavigateToReference] refKey never appeared in nodesByKey', { refKey });
              resolve(false);
            }
          };
          setTimeout(() => waitForKeyAndSelect(), 50);
        });
      };
      if (occurrence) {
        try {
          if (await selectAtHost(occurrence)) return true;
        } catch (err) {
          treeDebug.warn('[reference] usage reveal failed; using declaration', { err: String(err) });
        }
      }
      return isCurrent() ? selectAtHost(null) : false;
    },
    [findReferenceOccurrence, materializeOccurrence, navigateToTreeNode, refreshNode, onSelect, navHistory],
  );

  // Imperative handle
  useImperativeHandle(ref, () => ({
    renameNode(nodeId: number, namespace: string, name: string) {
      for (const record of Object.values(stateRef.current.nodesByKey)) {
        if (record.nodeId === nodeId && record.namespace === namespace) {
          dispatch({ type: 'PATCH_TITLE', key: record.key, title: name });
        }
      }
      navHistory.rename(nodeId, namespace, name);
    },
    async navigateToNode(nodeId: number, namespace: string, concept: string, usageContext?: SelectedTreeElement) {
      const requestId = ++referenceNavigationId.current;
      const contextKey = navigationScopeRef.current.contextKey;
      const isCurrent = () => navigationMountedRef.current && referenceNavigationId.current === requestId
        && navigationScopeRef.current.contextKey === contextKey;
      try {
        if (concept === 'port_usage' && usageContext?.concept === 'part_usage' && usageContext.namespace === namespace) {
          try {
            let usage = await findReferenceOccurrence(usageContext.nodeId, namespace, usageContext.treeKey);
            if (!isCurrent()) return;
            const loadedUsage = stateRef.current.nodesByKey[usageContext.treeKey ?? `${namespace}:${usageContext.nodeId}`];
            if (!usage && loadedUsage?.concept === 'part_usage') usage = { host: loadedUsage, steps: [] };
            if (!usage) {
              const found = await navigateToTreeNode({ ...usageContext, suppressSelect: true });
              if (!isCurrent()) return;
              if (found) {
                const host = stateRef.current.nodesByKey[`${namespace}:${usageContext.nodeId}`]
                  ?? toModelRecord({ node_id: usageContext.nodeId, name: usageContext.name ?? '', concept: 'part_usage', hasChildren: true, asil: '' }, namespace, null);
                usage = { host, steps: [] };
              }
            }
            if (usage) {
              const member = await findReferenceOccurrence(nodeId, namespace, usage.host.key, usage.host);
              if (!isCurrent()) return;
              if (member && materializeOccurrence({ host: member.host, steps: [...usage.steps, ...member.steps] }, isCurrent)) {
                const selected = await new Promise<boolean>(resolve => {
                  const select = (attempt = 0) => {
                    if (!isCurrent()) { resolve(false); return; }
                    const record = stateRef.current.nodesByKey[member.host.key];
                    if (!record) {
                      if (attempt < 20) setTimeout(() => select(attempt + 1), 50);
                      else resolve(false);
                      return;
                    }
                    const parent = stateRef.current.nodesByKey[record.parentKey ?? ''];
                    const element: SelectedTreeElement = {
                      nodeId, namespace, concept: record.concept, name: record.title,
                      ...(record.key.startsWith('via:') ? { treeKey: record.key, hostNodeId: parent?.nodeId, hostNamespace: parent?.namespace } : {}),
                    };
                    dispatch({ type: 'SET_SELECTED', key: record.key });
                    navHistory.push(element);
                    onSelect(element);
                    const scroll = (attempt = 0) => {
                      if (!isCurrent() || stateRef.current.selectedKey !== record.key || !containerRef.current) return;
                      treeRef.current?.scrollTo({ key: record.key });
                      if (!containerRef.current.querySelector('[role="treeitem"][aria-selected="true"]') && attempt < 20) setTimeout(() => scroll(attempt + 1), 50);
                    };
                    setTimeout(() => scroll(), 50);
                    resolve(true);
                  };
                  select();
                });
                if (selected || !isCurrent()) return;
              }
            }
          } catch (err) {
            treeDebug.warn('[port] usage occurrence unavailable; using declaration', { err: String(err) });
          }
        }
        if (!isCurrent()) return;
        await navigateToTreeNode({ nodeId, namespace, concept });
      } catch (err) {
        treeDebug.error('[NamespaceTreePanel] navigateToNode failed', { err: String(err) });
      }
    },
    async navigateToNodeInScope(target) {
      return navigateScopedTree(target, {
        getScope: () => ({ ...navigationScopeRef.current, ready: navigationScopeRef.current.ready && navigationMountedRef.current }),
        hasRoot: ns => !!stateRef.current.nodesByKey[`ns:${ns}`],
        getAncestorPath: (ns, nodeId) => api.namespaces.getAncestorPath(ns, nodeId),
        fetchPage: (ns, parentNodeId, offset) => fetchChildren(ns, parentNodeId, offset, PAGE_SIZE),
        applyPage: (ns, parentNodeId, page) => {
          const parentKey = parentNodeId === undefined ? `ns:${ns}` : `${ns}:${parentNodeId}`;
          const children = [
            ...page.children.map(child => toModelRecord(child, ns, parentKey)),
            ...(parentNodeId === undefined ? [] : page.references.map(ref => toReferenceRecord(ref, ns, parentNodeId, parentKey))),
          ];
          // Merge navigation pages: replacing page zero would remove previously
          // loaded siblings and their expanded branches. Never rewind pagination.
          const previous = paginationRef.current.get(parentKey);
          const nextOffset = page.offset + page.children.length;
          const advancesPage = !previous || nextOffset >= previous.offset;
          if (advancesPage) dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sentinelKey(parentKey) });
          dispatch({
            type: 'LOAD_BRANCH_PAGE', parentKey, children,
            loadedCount: Math.max(previous?.offset ?? 0, nextOffset), totalCount: page.totalCount,
          });
          if (advancesPage) {
            paginationRef.current.set(parentKey, { offset: nextOffset, hasMore: page.hasMore });
            if (page.hasMore) dispatch({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, ns) });
          }
        },
        select: (node, ancestors) => {
          const key = `${node.namespace}:${node.nodeId}`;
          dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [`ns:${node.namespace}`, ...ancestors.map(id => `${node.namespace}:${id}`)] });
          dispatch({ type: 'SET_SELECTED', key });
          navHistory.push(node);
          onSelect(node);
          setTimeout(() => { treeRef.current?.scrollTo({ key }); }, 0);
        },
      });
    },
    async navigateToReference(
      refNodeId: number,
      refNamespace: string,
      refConcept: string,
      hostNodeId: number,
      hostNamespace: string,
    ) {
      try {
        await performNavigateToReference(refNodeId, refNamespace, refConcept, hostNodeId, hostNamespace);
      } catch (err) {
        treeDebug.error('[NamespaceTreePanel] navigateToReference failed', { err: String(err) });
      }
    },
    async navigateToSelectedReference(node: SelectedTreeElement) {
      try {
        const target = await resolveTreeReference(node, resolveReferenceTarget(node));
        if (!target) return;
        await performNavigateToReference(target.reference.nodeId, target.reference.namespace, target.reference.concept, target.host.node_id, target.host.namespace, { treeKey: node.treeKey });
      } catch (err) {
        treeDebug.error('[NamespaceTreePanel] navigateToSelectedReference failed', { err: String(err) });
      }
    },
    async refreshStructuralParent(node: SelectedTreeElement) {
      const parentKey = node.treeKey ?? `${node.namespace}:${node.nodeId}`;
      // Deterministically re-fetch the structural parent's children. Unlike the
      // cache-subscription re-fetch, refreshNode works even when the node was
      // never expanded (which is the case for a port that had no malfunctions).
      try {
        await refreshNode(node, 0, PAGE_SIZE, parentKey);
      } catch (err) {
        treeDebug.error('[NamespaceTreePanel] refreshStructuralParent failed', { err: String(err) });
        return;
      }
      // Expand the parent so the newly added reference child is visible.
      if (!stateRef.current.expandedKeys[parentKey]) {
        dispatch({ type: 'TOGGLE_EXPAND', key: parentKey });
      }
    },
    async refreshNamespace(namespace: string) {
      const nsKey = `ns:${namespace}`;
      const isExpanded = !!state.expandedKeys[nsKey];
      dispatch({ type: 'LOAD_BRANCH', parentKey: nsKey, children: [] });
      paginationRef.current.delete(nsKey);
      loadingNsRef.current.delete(nsKey);
      if (isExpanded) {
        try {
          const result = await fetchChildren(namespace, undefined, 0, PAGE_SIZE);
          const anomalies = validateChildrenResponse(result.children, nsKey);
          for (const anomaly of anomalies) dispatch({ type: 'ADD_ANOMALY', anomaly });
          const children: TreeNodeRecord[] = result.children.map((c) => toModelRecord(c, namespace, nsKey));
          dispatch({
            type: 'LOAD_BRANCH_PAGE',
            parentKey: nsKey,
            children,
            loadedCount: children.length,
            totalCount: result.totalCount,
          });
          paginationRef.current.set(nsKey, { offset: children.length, hasMore: result.hasMore });
          if (result.hasMore) {
            dispatch({ type: 'INSERT_CHILD', parentKey: nsKey, child: toSentinelRecord(nsKey, namespace) });
          }
        } catch (err) {
          treeDebug.error('[NamespaceTreePanel] refreshNamespace failed', { err: String(err) });
        }
      }
    },
    openAddMalfunctionModal() {
      const selectedKey = stateRef.current.selectedKey;
      const selectedRecord = selectedKey ? stateRef.current.nodesByKey[selectedKey] : null;
      if (!selectedRecord) return;
      // Only architecture nodes (non-malfunction, non-safety-note, etc.) can host malfunctions.
      // Domain-specific hosting logic lives in conceptHosting.ts, outside this panel.
      // The create modal itself will no-op on invalid concepts, and the context menu
      // only shows "Add Malfunction" on architecture nodes, so this is safe to call
      // for any selected node.
      setCreateModalTarget({ nodeId: selectedRecord.nodeId, namespace: selectedRecord.namespace, concept: selectedRecord.concept, name: selectedRecord.title as string });
      setCreateModalOpen(true);
    },
    openDeleteMalfunctionModal() {
      const selectedKey = stateRef.current.selectedKey;
      const selectedRecord = selectedKey ? stateRef.current.nodesByKey[selectedKey] : null;
      if (!selectedRecord || selectedRecord.concept !== 'malfunction') return;
      setPendingDeleteNode({
        nodeId: selectedRecord.nodeId,
        namespace: selectedRecord.namespace,
        concept: selectedRecord.concept,
        name: selectedRecord.title as string,
      });
    },
    clearSelection() {
      dispatch({ type: 'SET_SELECTED', key: null });
    },
  }), [state.nodesByKey, state.expandedKeys, navigateToTreeNode, fetchChildren, refreshNode, performNavigateToReference, resolveReferenceTarget, findReferenceOccurrence, materializeOccurrence]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.length < 2) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const result = await api.namespaces.search(value, 0, 50);
        setSearchResults(selectionOnly && browseNamespace
          ? result.results.filter(item => item.namespace === browseNamespace)
          : result.results);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 300);
  }, [selectionOnly, browseNamespace]);

  const handleSearchResultSelect = useCallback(async (_value: string, option: { result: SearchResultNode }) => {
    const result = option.result;
    setSearchQuery('');
    setSearchResults([]);
    // Navigate within the element's own namespace — no crossNsTarget resolution
    await navigateToTreeNode({
      nodeId: result.nodeId,
      namespace: result.namespace,
      concept: result.concept,
      name: result.name,
      ancestorPath: result.ancestorPath,
    });
  }, [navigateToTreeNode]);

  // ---------------------------------------------------------------------------
  // onLoadData — lazy load on expansion
  // ---------------------------------------------------------------------------
  const onLoadData = useCallback(async (node: EventDataNode<SafetyTreeNode>) => {
    const treeNode = node as unknown as SafetyTreeNode;

    if (treeNode.nodeType === 'namespace') {
      const nsKey = String(treeNode.key);
      // Concurrency guard
      if (state.loadedParents[nsKey] || loadingNsRef.current.has(nsKey)) {
        treeDebug.debug(`onLoadData skip — namespace "${treeNode.namespace}" already loaded or in-flight`);
        return;
      }
      loadingNsRef.current.add(nsKey);
      const stopTimer = treeDebug.startTimer(`onLoadData namespace "${treeNode.namespace}"`);
      dispatch({ type: 'SET_LOADING', key: nsKey, loading: true });
      try {
        const result = await fetchChildren(treeNode.namespace, undefined, 0, PAGE_SIZE);

        // Boundary validation
        const anomalies = validateChildrenResponse(result.children, nsKey);
        for (const anomaly of anomalies) {
          treeDebug.warn('validateChildrenResponse anomaly on namespace load', { anomaly });
          dispatch({ type: 'ADD_ANOMALY', anomaly });
        }

        const childRecords: TreeNodeRecord[] = result.children.map((c: TreeChildNode) =>
          toModelRecord(c, treeNode.namespace, nsKey),
        );
        dispatch({
          type: 'LOAD_BRANCH_PAGE',
          parentKey: nsKey,
          children: childRecords,
          loadedCount: childRecords.length,
          totalCount: result.totalCount,
        });
        if (result.hasMore) {
          dispatch({ type: 'INSERT_CHILD', parentKey: nsKey, child: toSentinelRecord(nsKey, treeNode.namespace) });
        }
        paginationRef.current.set(nsKey, { offset: childRecords.length, hasMore: result.hasMore });
      } catch (err) {
        treeDebug.error(`onLoadData namespace "${treeNode.namespace}" FAILED`, { error: String(err) });
      } finally {
        dispatch({ type: 'SET_LOADING', key: nsKey, loading: false });
        stopTimer();
      }
      return;
    }

    if (treeNode.nodeType !== 'model' && !String(treeNode.key).startsWith('via:')) return;

    const key = String(treeNode.key);
    dispatch({ type: 'SET_LOADING', key, loading: true });
    try {
      await refreshNode({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name }, 0, PAGE_SIZE, key);
    } catch (err) {
      treeDebug.error(`onLoadData model node "${treeNode.name}" FAILED`, { error: String(err) });
    } finally {
      dispatch({ type: 'SET_LOADING', key, loading: false });
    }
  }, [fetchChildren, refreshNode, state.loadedParents]);

  // ---------------------------------------------------------------------------
  // handleSelect
  // ---------------------------------------------------------------------------
  const handleSelect = useCallback((_keys: React.Key[], info: { node: EventDataNode<SafetyTreeNode> }) => {
    const treeNode = info.node as unknown as SafetyTreeNode;



    // Sentinel: load next page
    if (treeNode.concept === 'sentinel') {
      const sKey = String(treeNode.key);
      const parentKey = sKey.replace(/^sentinel:/, '');
      const pagination = paginationRef.current.get(parentKey);
      if (!pagination || !pagination.hasMore || loadingMore[parentKey]) return;

      const parentRecord = state.nodesByKey[parentKey];
      const parentNodeId = parentRecord?.nodeType === 'namespace' ? undefined : parentRecord?.nodeId;

      setLoadingMore((prev) => ({ ...prev, [parentKey]: true }));
      setPageErrors((prev) => { const next = { ...prev }; delete next[parentKey]; return next; });

      fetchChildren(treeNode.namespace, parentNodeId, pagination.offset, PAGE_SIZE)
        .then((result) => {
          const childRecords: TreeNodeRecord[] = result.children.map((c: TreeChildNode) =>
            toModelRecord(c, treeNode.namespace, parentKey),
          );
          dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sKey });
          dispatch({
            type: 'LOAD_BRANCH_PAGE',
            parentKey,
            children: childRecords,
            loadedCount: pagination.offset + childRecords.length,
            totalCount: result.totalCount,
          });
          paginationRef.current.set(parentKey, { offset: pagination.offset + childRecords.length, hasMore: result.hasMore });
          if (result.hasMore) {
            dispatch({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, treeNode.namespace) });
          }
        })
        .catch((err: unknown) => {
          treeDebug.error(`loadNextPage for "${parentKey}" FAILED`, { error: String(err) });
          setPageErrors((prev) => ({ ...prev, [parentKey]: String((err as Error)?.message ?? 'Failed to load more') }));
        })
        .finally(() => {
          setLoadingMore((prev) => { const next = { ...prev }; delete next[parentKey]; return next; });
        });
      return;
    }

    // Reference node: open referenced element in center panel
    if (treeNode.nodeType === 'reference') {
      const record = state.nodesByKey[String(treeNode.key)];
      if (record?.referenceTarget) {
        dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
        const element = {
          nodeId: record.referenceTarget.nodeId,
          namespace: record.referenceTarget.namespace,
          concept: record.referenceTarget.concept,
          name: treeNode.name,
        };
        // Store the reference tree key and host info so back navigation restores the reference position
        const treeKey = String(treeNode.key);
        const host = record.parentKey ? state.nodesByKey[record.parentKey] : undefined;
        const hostNodeId = host?.nodeId;
        const hostNamespace = host?.namespace;
        navHistory.push({ ...element, treeKey, hostNodeId, hostNamespace });
        onSelect({ ...element, hostNodeId, hostNamespace, ...(treeKey.includes('via:') ? { treeKey } : {}) });
      }
      return;
    }

    dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
    if (treeNode.nodeId === -1) { onSelect(null); return; }
    const element = { nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name };
    navHistory.push(element);
    onSelect(element);
  }, [onSelect, loadingMore, state.nodesByKey, fetchChildren]);

  const handleRightClick = useCallback((info: { event: React.MouseEvent; node: EventDataNode<SafetyTreeNode> }) => {
    info.event.preventDefault();
    const treeNode = info.node as unknown as SafetyTreeNode;
    if (treeNode.nodeId === -1) { setContextMenuNode(null); return; }
    dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
    onSelect({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name,
      ...(String(treeNode.key).includes('via:') ? { treeKey: String(treeNode.key) } : {}),
    });
    setContextMenuNode({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name,
      ...(String(treeNode.key).includes('via:') ? { treeKey: String(treeNode.key) } : {}),
    });

    setContextMenuPosition({ x: info.event.clientX, y: info.event.clientY });
  }, [onSelect]);

  const handleExpand = useCallback((keys: React.Key[]) => {
    dispatch({ type: 'SET_EXPANDED', keys: keys.map(String) });
  }, []);

  const handleFailureModeCreated = useCallback(async (created: { nodeId: number; name: string }) => {
    if (!createModalTarget) return;

    // The new malfunction lives in the analysis namespace it was authored
    // into, not createModalTarget.namespace — normally safetyNamespace, but in
    // browse mode (no fixed safetyNamespace) it is whatever the user picked in
    // SelectAnalysisNamespaceModal.
    const malfunctionNamespace = browseNamespace ? (browseCreateNamespace ?? safetyNamespace) : safetyNamespace;
    try {
      if (createModalTarget.treeKey && stateRef.current.nodesByKey[createModalTarget.treeKey]) {
        const parentKey = createModalTarget.treeKey;
        await refreshNode(createModalTarget, 0, PAGE_SIZE, parentKey);
        const treeKey = `ref:${malfunctionNamespace}:${created.nodeId}@${parentKey}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [parentKey] });
        dispatch({ type: 'SET_SELECTED', key: treeKey });
        const element = { nodeId: created.nodeId, namespace: malfunctionNamespace, concept: 'malfunction', name: created.name,
          hostNodeId: createModalTarget.nodeId, hostNamespace: createModalTarget.namespace };
        onSelect(element);
        navHistory.push({ ...element, treeKey });
        return;
      }
      // Refresh even a previously unexpanded leaf, then select the reference
      // only once React has committed it. Keep the authoring and host namespaces
      // distinct, and record this location for Back/Forward navigation.
      const revealed = await performNavigateToReference(
        created.nodeId, malfunctionNamespace, 'malfunction',
        createModalTarget.nodeId, createModalTarget.namespace,
        { name: created.name, recordHistory: true },
      );
      if (revealed) return;
    } catch (err) {
      treeDebug.error('[NamespaceTreePanel] reveal created malfunction failed', { err: String(err) });
    }
    // Creation already succeeded. A navigation failure must not look like a
    // failed create or encourage the user to create a duplicate malfunction.
    onSelect(createModalTarget);
    void message.warning('Malfunction created, but its reference could not be shown in the tree.');
  }, [createModalTarget, onSelect, performNavigateToReference, refreshNode, navHistory, message, safetyNamespace, browseNamespace, browseCreateNamespace]);

  // ---------------------------------------------------------------------------
  // Back / Forward navigation handlers
  // ---------------------------------------------------------------------------
  const restoreDefinitionLocation = useCallback((entry: HistoryEntry): boolean => {
    if (!entry.treeKey?.includes('via:')) return false;
    const record = stateRef.current.nodesByKey[entry.treeKey];
    if (!record) {
      // After a tree reset the former display occurrence may no longer exist.
      // Reveal the declaration instead of selecting a phantom history row.
      void navigateToTreeNode({ ...entry, suppressSelect: false });
      return true;
    }
    const ancestors: string[] = [];
    let parentKey = record.parentKey;
    while (parentKey && !ancestors.includes(parentKey)) {
      ancestors.push(parentKey);
      parentKey = stateRef.current.nodesByKey[parentKey]?.parentKey ?? null;
    }
    dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: ancestors });
    dispatch({ type: 'SET_SELECTED', key: record.key });
    onSelect({ nodeId: record.nodeId, namespace: record.namespace, concept: record.concept, name: record.title,
      hostNodeId: entry.hostNodeId, hostNamespace: entry.hostNamespace,
      ...(record.key.includes('via:') ? { treeKey: record.key } : {}),
    });
    setTimeout(() => treeRef.current?.scrollTo({ key: record.key }), 0);
    return true;
  }, [navigateToTreeNode, onSelect]);

  const handleNavBack = useCallback(() => {
    const entry = navHistory.back();
    if (!entry || restoreDefinitionLocation(entry)) return;
    if (entry.hostNodeId !== undefined && entry.hostNamespace !== undefined) {
      // This was a reference node — navigate to the reference position
      navigateToTreeNode({ nodeId: entry.hostNodeId, namespace: entry.hostNamespace, concept: '', suppressSelect: true }).then(() => {
        const hostKey = `${entry.hostNamespace}:${entry.hostNodeId}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
        refreshNode({ nodeId: entry.hostNodeId!, namespace: entry.hostNamespace!, concept: '', name: '' }).then(() => {
          setTimeout(() => {
            if (entry.treeKey) {
              dispatch({ type: 'SET_SELECTED', key: entry.treeKey });
              onSelect({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name, hostNodeId: entry.hostNodeId, hostNamespace: entry.hostNamespace });
              setTimeout(() => { treeRef.current?.scrollTo({ key: entry.treeKey! }); }, 50);
            }
          }, 50);
        });
      });
    } else {
      navigateToTreeNode({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
    }
  }, [navHistory, navigateToTreeNode, refreshNode, onSelect, restoreDefinitionLocation]);

  const handleNavForward = useCallback(() => {
    const entry = navHistory.forward();
    if (!entry || restoreDefinitionLocation(entry)) return;
    if (entry.hostNodeId !== undefined && entry.hostNamespace !== undefined) {
      // This was a reference node — navigate to the reference position
      navigateToTreeNode({ nodeId: entry.hostNodeId, namespace: entry.hostNamespace, concept: '', suppressSelect: true }).then(() => {
        const hostKey = `${entry.hostNamespace}:${entry.hostNodeId}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
        refreshNode({ nodeId: entry.hostNodeId!, namespace: entry.hostNamespace!, concept: '', name: '' }).then(() => {
          setTimeout(() => {
            if (entry.treeKey) {
              dispatch({ type: 'SET_SELECTED', key: entry.treeKey });
              onSelect({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name, hostNodeId: entry.hostNodeId, hostNamespace: entry.hostNamespace });
              setTimeout(() => { treeRef.current?.scrollTo({ key: entry.treeKey! }); }, 50);
            }
          }, 50);
        });
      });
    } else {
      navigateToTreeNode({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
    }
  }, [navHistory, navigateToTreeNode, refreshNode, onSelect, restoreDefinitionLocation]);

  const handleNavGoTo = useCallback((index: number) => {
    const entry = navHistory.goTo(index);
    if (!entry || restoreDefinitionLocation(entry)) return;
    if (entry.hostNodeId !== undefined && entry.hostNamespace !== undefined) {
      navigateToTreeNode({ nodeId: entry.hostNodeId, namespace: entry.hostNamespace, concept: '', suppressSelect: true }).then(() => {
        const hostKey = `${entry.hostNamespace}:${entry.hostNodeId}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
        refreshNode({ nodeId: entry.hostNodeId!, namespace: entry.hostNamespace!, concept: '', name: '' }).then(() => {
          setTimeout(() => {
            if (entry.treeKey) {
              dispatch({ type: 'SET_SELECTED', key: entry.treeKey });
              onSelect({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name, hostNodeId: entry.hostNodeId, hostNamespace: entry.hostNamespace });
              setTimeout(() => { treeRef.current?.scrollTo({ key: entry.treeKey! }); }, 50);
            }
          }, 50);
        });
      });
    } else {
      navigateToTreeNode({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
    }
  }, [navHistory, navigateToTreeNode, refreshNode, onSelect, restoreDefinitionLocation]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (nsLoading) {
    return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (!allNamespaces || allNamespaces.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No namespaces available"
        style={{ padding: 24, fontSize: 12 }}
      />
    );
  }

  return (
    <>
      {/* Anomaly banner — shown when structural anomalies are detected */}
      <AnomalyBanner
        anomalies={state.anomalies}
        onDismiss={() => dispatch({ type: 'CLEAR_ANOMALIES' })}
      />

      <div style={{ padding: '6px 8px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, gap: 2 }}>
          <Button
            type="text"
            size="small"
            icon={<LeftOutlined style={{ fontSize: 10 }} />}
            disabled={!navHistory.canGoBack}
            onClick={handleNavBack}
            style={{ padding: '0 4px', height: 22, width: 22, minWidth: 22 }}
            title="Back (previous selection)"
          />
          <Button
            type="text"
            size="small"
            icon={<RightOutlined style={{ fontSize: 10 }} />}
            disabled={!navHistory.canGoForward}
            onClick={handleNavForward}
            style={{ padding: '0 4px', height: 22, width: 22, minWidth: 22 }}
            title="Forward (next selection)"
          />
          <Popover
            trigger="hover"
            placement="bottomLeft"
            content={
              navHistory.entries.length === 0
                ? <span style={{ fontSize: 12, color: token.colorTextSecondary }}>No history yet</span>
                : (
                  <div style={{ minWidth: 180 }}>
                    <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                      {navHistory.entries.map((entry, idx) => (
                        <div
                          key={`${entry.namespace}:${entry.nodeId}:${idx}`}
                          onClick={() => handleNavGoTo(idx)}
                          style={{
                            padding: '4px 8px',
                            fontSize: 12,
                            cursor: 'pointer',
                            borderRadius: 4,
                            background: idx === navHistory.cursor ? token.controlItemBgActive : 'transparent',
                            fontWeight: idx === navHistory.cursor ? 500 : 400,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {idx === navHistory.cursor && <span style={{ color: token.colorPrimary, fontSize: 10 }}>▸</span>}
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {entry.name || `(${entry.concept})`}
                          </span>
                          <span style={{ color: token.colorTextSecondary, fontSize: 10, flexShrink: 0 }}>{entry.concept}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: token.colorTextTertiary }}>{navHistory.entries.length} of 33</span>
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={() => navHistory.clear()}
                        style={{ fontSize: 11, color: token.colorTextTertiary }}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                )
            }
          >
            <span
              style={{
                fontSize: 11,
                color: token.colorTextSecondary,
                marginLeft: 4,
                cursor: 'default',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              <HistoryOutlined style={{ fontSize: 10 }} />
              Selection history
            </span>
          </Popover>
        </div>
        <AutoComplete
          value={searchQuery}
          onChange={handleSearchChange}
          options={searchResults.map((r) => ({
            value: `${r.namespace}:${r.nodeId}`,
            label: (
              <div>
                <span style={{ fontWeight: 500 }}>{r.name || `(${r.concept})`}</span>
                <span style={{ color: '#8c8c8c', marginLeft: 8, fontSize: 11 }}>{r.concept} · {r.namespace}</span>
              </div>
            ),
            result: r,
          }))}
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
          key={`safety-tree:${workspaceKey ?? 'none'}:${showAllTreeElements ? 'all' : 'visible'}`}
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
          onRightClick={selectionOnly ? undefined : handleRightClick as (info: { event: React.MouseEvent; node: EventDataNode<DataNode> }) => void}
          style={{ fontSize: 12 }}
          className="riacore-safety-tree"
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
                    >Retry</span>
                  </span>
                );
              }
              return <span style={{ color: '#1677ff', cursor: 'pointer' }}>Load more…</span>;
            }
            const suffix = renderNodeSuffix?.({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name });
            return suffix ? (
              <span data-tree-key={String(treeNode.key)} style={{ display: 'inline-flex', width: '100%', minWidth: 0, verticalAlign: 'bottom' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{treeNode.title as React.ReactNode}</span>
                <span style={{ flexShrink: 0 }}>{suffix}</span>
              </span>
            ) : <span data-tree-key={String(treeNode.key)}>{treeNode.title as React.ReactNode}</span>;
          }}
        />
      </div>

      <TreeContextMenu
        node={contextMenuNode}
        safetyNamespace={safetyNamespace}
        position={contextMenuPosition}
        onClose={() => setContextMenuNode(null)}
        onAddMalfunction={() => {
          if (browseNamespace) {
            // Browse mode has no fixed analysis scope (safetyNamespace is
            // empty here — see NamespaceTreePanelProps.browseNamespace), so
            // resolve one from the connection graph before authoring anything.
            const connectedAnalysisNames = new Set(
              (connectionGraph?.connections ?? [])
                .filter((c) => c.source === browseNamespace)
                .map((c) => c.target),
            );
            const connectedAnalyses = (connectionGraph?.analyses ?? [])
              .filter((a) => connectedAnalysisNames.has(a.name));
            if (connectedAnalyses.length === 0) {
              Modal.error({
                title: 'No analysis scope available',
                content: `Malfunctions require an analysis scope. "${browseNamespace}" is not connected to any analysis — connect it to one first.`,
              });
              return;
            }
            setCreateModalTarget(contextMenuNode);
            setSelectAnalysisOptions(connectedAnalyses);
            setSelectAnalysisOpen(true);
            return;
          }
          setCreateModalTarget(contextMenuNode);
          setCreateModalOpen(true);
        }}
        onReconnectOrphanedMalfunction={browseNamespace ? undefined : () => {
          setReconnectOrphanedTarget(contextMenuNode);
          setReconnectOrphanedOpen(true);
        }}
        onDelete={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onDeleteSafetyNote={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onDeleteTag={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onDeleteSafetyTask={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onDeleteRiskRating={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onDeleteReviewItem={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onDeleteRequirement={() => {
          if (!contextMenuNode) return;
          setPendingDeleteNode({ ...contextMenuNode });
        }}
        onShowInTree={onNavigateToNode ? () => {
          if (!contextMenuNode) return;
          onNavigateToNode(contextMenuNode.nodeId, contextMenuNode.namespace, contextMenuNode.concept);
        } : undefined}
        onShowReferenceInTree={onNavigateToReference && contextMenuNode &&
          ['malfunction', 'risk_rating', 'safety_note'].includes(contextMenuNode.concept) ? () => {
          const node = contextMenuNode;
          void (async () => {
            try {
              const target = await resolveTreeReference(node, resolveReferenceTarget(node));
              if (!target) return;
              onNavigateToReference(
                target.reference.nodeId, target.reference.namespace, target.reference.concept,
                target.host.node_id, target.host.namespace,
              );
            } catch (err) {
              treeDebug.error('[NamespaceTreePanel] context-menu Show Reference in Tree failed', { err: String(err) });
            }
          })();
        } : undefined}
        pendingPropagationSource={pendingPropagationSource}
        onStartPropagation={onStartPropagation ? () => {
          if (!contextMenuNode) return;
          onStartPropagation(contextMenuNode);
        } : undefined}
        onEndPropagation={onEndPropagation ? () => {
          if (!contextMenuNode) return;
          onEndPropagation(contextMenuNode);
        } : undefined}
        onCopyMalfunction={onCopyMalfunction ? () => {
          if (!contextMenuNode) return;
          onCopyMalfunction(contextMenuNode);
        } : undefined}
        onPasteMalfunction={onPasteMalfunction ? () => {
          if (!contextMenuNode) return;
          onPasteMalfunction(contextMenuNode);
        } : undefined}
        hasCopiedMalfunction={hasCopiedMalfunction}
        onOpenInTableView={onOpenInTableView ? () => {
          if (!contextMenuNode) return;
          onOpenInTableView(contextMenuNode);
        } : undefined}
      />

      {/* Impact-preview delete modal for malfunction, safety_note, tag, safety_task, risk_rating, review_item and safety_requirement nodes */}
      {pendingDeleteNode && (
        <DeleteWithPreview
          nodeId={pendingDeleteNode.nodeId}
          onCancel={() => setPendingDeleteNode(null)}
          onConfirm={async () => {
            if (!pendingDeleteNode) return;
            if (pendingDeleteNode.concept === 'safety_note') {
              // Find the note's record in the tree store — it may be a reference node
              // (key format: ref:namespace:nodeId@hostNs:hostNodeId) so we can't
              // construct the key directly. Search by nodeId + namespace + concept.
              const noteRecord = Object.values(state.nodesByKey).find(
                (r) => r.nodeId === pendingDeleteNode.nodeId &&
                        r.namespace === pendingDeleteNode.namespace &&
                        r.concept === 'safety_note',
              );
              const parentKey = noteRecord?.parentKey;
              const parent = parentKey ? state.nodesByKey[parentKey] : undefined;
              const parentNodeId = parent?.nodeType === 'namespace' ? undefined : parent?.nodeId;
              const parentNamespace = parent?.namespace;
              await deleteSafetyNote.mutateAsync({ nodeId: pendingDeleteNode.nodeId, parentNodeId, parentNamespace });
            } else if (pendingDeleteNode.concept === 'tag') {
              // Find the tag's record in the tree store to resolve its parent.
              const tagRecord = Object.values(state.nodesByKey).find(
                (r) => r.nodeId === pendingDeleteNode.nodeId &&
                        r.namespace === pendingDeleteNode.namespace &&
                        r.concept === 'tag',
              );
              const parentKey = tagRecord?.parentKey;
              const parent = parentKey ? state.nodesByKey[parentKey] : undefined;
              const parentNodeId = parent?.nodeType === 'namespace' ? undefined : parent?.nodeId;
              const parentNamespace = parent?.namespace;
              await deleteTag.mutateAsync({ nodeId: pendingDeleteNode.nodeId, parentNodeId, parentNamespace });
            } else if (pendingDeleteNode.concept === 'safety_task') {
              await deleteTask.mutateAsync({ nodeId: pendingDeleteNode.nodeId });
            } else if (pendingDeleteNode.concept === 'risk_rating') {
              await deleteRiskRating.mutateAsync(pendingDeleteNode.nodeId);
            } else if (pendingDeleteNode.concept === 'review_item') {
              await deleteReviewItem.mutateAsync({ nodeId: pendingDeleteNode.nodeId });
            } else if (pendingDeleteNode.concept === 'safety_requirement') {
              await deleteRequirement.mutateAsync(pendingDeleteNode.nodeId);
            } else if (pendingDeleteNode.concept === 'malfunction') {
              await deleteMalfunction.mutateAsync(pendingDeleteNode.nodeId);
            }
            onSelect(null);
            setPendingDeleteNode(null);
          }}
        >
          {(openPreview) => {
            // Trigger the preview immediately when the node is set
            // We use a one-shot effect via a tiny helper component
            return <_AutoOpenPreview onMount={openPreview} />;
          }}
        </DeleteWithPreview>
      )}

      <SelectAnalysisNamespaceModal
        open={selectAnalysisOpen}
        analyses={selectAnalysisOptions}
        targetName={createModalTarget?.name}
        onClose={() => { setSelectAnalysisOpen(false); setCreateModalTarget(null); }}
        onSelect={(namespace) => {
          setBrowseCreateNamespace(namespace);
          setSelectAnalysisOpen(false);
          setCreateModalOpen(true);
        }}
      />
      <CreateMalfunctionModal
        open={createModalOpen}
        namespace={browseNamespace ? (browseCreateNamespace ?? '') : safetyNamespace}
        selectedTreeElement={createModalTarget}
        onClose={() => { setCreateModalOpen(false); setCreateModalTarget(null); setBrowseCreateNamespace(null); }}
        onCreated={handleFailureModeCreated}
        workspaceKey={workspaceKey}
        occursAtNamespace={createModalTarget?.namespace}
        triggerAutoSave={triggerAutoSave}
      />
      <ReconnectOrphanedModal
        open={reconnectOrphanedOpen}
        targetElement={reconnectOrphanedTarget}
        namespace={safetyNamespace}
        workspaceKey={workspaceKey}
        onClose={() => { setReconnectOrphanedOpen(false); setReconnectOrphanedTarget(null); }}
        onReconnected={(target) => refreshNode(target)}
        triggerAutoSave={triggerAutoSave}
      />
    </>
  );
  },
);
