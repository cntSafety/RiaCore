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
import { Tree, Empty, Spin, AutoComplete, Input, Button, Popover, theme } from 'antd';
import { FolderOutlined, EditOutlined, LinkOutlined, LeftOutlined, RightOutlined, HistoryOutlined, DeleteOutlined } from '@ant-design/icons';
import {
  useState, useCallback, createElement, useEffect,
  useReducer, useMemo, useRef, useImperativeHandle, forwardRef,
} from 'react';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import { useAllNamespaces } from '../hooks/useTreeQueries';
import { useNamespaceConnections } from '../../../../../hooks/useNamespaceConnections';
import { selectAnalysisRootNamespaces } from '../utils/treeUtils';
import { getNodeDecoration, buildSysmlDecorations, type NodeDecoration } from '../config/nodeTypeConfig';
import { getAsilHexColor } from '../config/asilColors';
import { useMetamodelRendering } from '../../../../../hooks/useMetamodelRendering';
import { getNamespaceDecorationByMetamodel } from '../../../../../lib/namespaceTypeDecoration';
import { api } from '../../../../../api/riacore';
import type { SelectedTreeElement } from '../types';
import type { TreeChildNode, TreeReferenceNode, SearchResultNode } from '@riacore/app-contracts';
import { TreeContextMenu } from './TreeContextMenu';
import { CreateMalfunctionModal } from './CreateMalfunctionModal';
import { ReconnectOrphanedModal } from './ReconnectOrphanedModal';
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
import { useTreeNavigationHistory } from '../hooks/useTreeNavigationHistory';
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
  /** Open the Table View lens for the right-clicked architecture scope element. */
  onOpenInTableView?: (node: SelectedTreeElement) => void;
}

export interface NamespaceTreePanelHandle {
  renameNode: (nodeId: number, namespace: string, name: string) => void;
  navigateToNode: (nodeId: number, namespace: string, concept: string) => Promise<void>;
  /**
   * Navigate to a cross-namespace reference child.
   * Expands the structural host node (hostNodeId in hostNamespace) and then
   * selects the reference child key so the malfunction reference is highlighted.
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

// ---------------------------------------------------------------------------
// Helpers
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
    asil: child.asil,
  };
}

function toReferenceRecord(
  ref: TreeReferenceNode,
  hostNamespace: string,
  hostNodeId: number,
  parentKey: string,
): TreeNodeRecord {
  return {
    key: `ref:${ref.sourceNamespace}:${ref.node_id}@${hostNamespace}:${hostNodeId}`,
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
    const decoration = getNodeDecoration(concept);
    const iconColor = concept === 'malfunction' ? getAsilHexColor(asil ?? '') : decoration.color;
    return createElement(
      'span',
      { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
      createElement(decoration.icon, { style: { color: iconColor } } as Record<string, unknown>),
      createElement(LinkOutlined, { style: { fontSize: 8, color: '#8c8c8c', marginLeft: 1 } } as Record<string, unknown>),
    );
  }
  const decoration = getNodeDecoration(concept, sysmlDecorations);
  const iconColor = concept === 'malfunction' ? getAsilHexColor(asil ?? '') : decoration.color;
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
): React.ReactNode {
  // Namespace roots are keyed by their metamodel so each distinct type gets its
  // own cached icon (rather than sharing a single 'namespace' entry).
  const nsKey = record?.nodeType === 'namespace' ? `namespace:${record.metamodel ?? record.role ?? 'unknown'}` : null;
  const base = nsKey ?? (concept === 'malfunction' ? `malfunction:${asil ?? ''}` : concept);
  // `buildIcon` renders a different element for reference nodes (the concept icon
  // plus a LinkOutlined badge) than for own nodes, so nodeType has to be part of
  // the key. Without it a reference malfunction and an own malfunction with the
  // same ASIL collide and whichever renders first wins for both.
  const cacheKey = `${configVersion}:${record?.nodeType ?? ''}:${base}`;
  if (!_iconCache.has(cacheKey)) {
    _iconCache.set(cacheKey, buildIcon(concept, record?.nodeType, record?.role, asil, sysmlDecorations, record));
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
  function NamespaceTreePanel({ onSelect, safetyNamespace, browseNamespace, onRequestAddNote, onReady, onNavigateToNode, onNavigateToReference, triggerAutoSave, onStartPropagation, onEndPropagation, onCopyMalfunction, onPasteMalfunction, hasCopiedMalfunction, onOpenInTableView }, ref) {

  const { token } = theme.useToken();

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
  const { data: renderingConfigJson } = useMetamodelRendering('SysMLv2');
  const { data: renderingConfigTextual } = useMetamodelRendering('SysMLv2Textual');
  const sysmlDecorations = useMemo(
    () => {
      if (!renderingConfigJson && !renderingConfigTextual) return undefined;
      const merged = { ...renderingConfigJson, ...renderingConfigTextual };
      return buildSysmlDecorations(merged);
    },
    [renderingConfigJson, renderingConfigTextual],
  );
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
  const buildIconBound = useCallback(
    (concept: string, asil?: string, record?: TreeNodeRecord) => buildIconCached(concept, asil, sysmlDecorations, configVersion, record),
    [sysmlDecorations, configVersion],
  );

  // Mutation hook for right-click delete — uses workspaceKey so tree.children is invalidated
  const deleteMalfunction = useDeleteMalfunction(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteSafetyNote = useDeleteSafetyNote(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteTag = useDeleteTag(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteTask = useDeleteSafetyTask(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteRiskRating = useDeleteRiskRatingFromTree(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteReviewItem = useDeleteReviewItem(safetyNamespace, workspaceKey, triggerAutoSave);
  const deleteRequirement = useDeleteRequirement(safetyNamespace, workspaceKey, triggerAutoSave);
  // Node pending deletion — drives the DeleteWithPreview modal
  const [pendingDeleteNode, setPendingDeleteNode] = useState<SelectedTreeElement | null>(null);
  // Navigation history for back/forward within the tree — restored from Zustand on mount
  const savedNavHistory = useWorkspaceStore((s) => s.navigationHistory);
  const navHistory = useTreeNavigationHistory(33, savedNavHistory?.entries, savedNavHistory?.cursor);
  const [contextMenuNode, setContextMenuNode] = useState<SelectedTreeElement | null>(null);
  const [contextMenuOccursAtTarget, setContextMenuOccursAtTarget] = useState<{ node_id: number; namespace: string; concept: string } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createModalTarget, setCreateModalTarget] = useState<SelectedTreeElement | null>(null);
  const [reconnectOrphanedOpen, setReconnectOrphanedOpen] = useState(false);
  const [reconnectOrphanedTarget, setReconnectOrphanedTarget] = useState<SelectedTreeElement | null>(null);

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
      const qkey = treeChildrenQueryKey(wk, ns, parentNodeId, showAllTreeElementsRef.current, scope);
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
            const result = await api.namespaces.getChildren(ns, parentNodeId, 0, PAGE_SIZE, showAllTreeElementsRef.current, scope);
            queryClient.setQueryData(qkey, result);
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
            const children: TreeNodeRecord[] = [
              ...result.children.map((c) => toModelRecord(c, ns, parentKey)),
              ...(result.references ?? []).map((ref) =>
                toReferenceRecord(ref, ns, parentNodeId ?? -1, parentKey),
              ),
            ];
            dispatchRef.current({ type: 'LOAD_BRANCH', parentKey, children });
            paginationRef.current.set(parentKey, {
              offset: result.children.length,
              hasMore: result.hasMore,
            });
            if (result.hasMore) {
              dispatchRef.current({ type: 'INSERT_CHILD', parentKey, child: toSentinelRecord(parentKey, ns) });
            }
            logOpEvent('tree.sync', 'frontend', 'Tree branch refreshed', {
              parentKey,
              namespace: ns,
              parentNodeId,
              childCount: children.length,
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
        // If this is a reference node, parse hostNamespace and hostNodeId from the key.
        // Key format: ref:refNamespace:refNodeId@hostNamespace:hostNodeId
        if (selectedKey && selectedKey.startsWith('ref:')) {
          const atIdx = selectedKey.indexOf('@');
          if (atIdx !== -1) {
            const hostPart = selectedKey.slice(atIdx + 1); // "hostNamespace:hostNodeId"
            const lastColon = hostPart.lastIndexOf(':');
            if (lastColon !== -1) {
              const hostNamespace = hostPart.slice(0, lastColon);
              const hostNodeId = parseInt(hostPart.slice(lastColon + 1), 10);
              if (hostNamespace && !isNaN(hostNodeId)) {
                selectedElement.hostNamespace = hostNamespace;
                selectedElement.hostNodeId = hostNodeId;
              }
            }
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
  }, [safetyNamespace, setSafetyTreeState, setNavigationHistory, state.expandedKeys, state.selectedKey, state.nodesByKey]);

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
    // For paginated fetches beyond page 0, bypass the cache (offset > 0 means
    // we're appending, not replacing — the cache only stores the first page).
    if (offset > 0 || !wk) {
      return api.namespaces.getChildren(namespace, parentNodeId, offset, limit, showAllTreeElements, scope);
    }
    return queryClient.fetchQuery<import('@riacore/app-contracts').GetChildrenResponse>({
      queryKey: treeChildrenQueryKey(wk, namespace, parentNodeId, showAllTreeElements, scope),
      queryFn: () => api.namespaces.getChildren(namespace, parentNodeId, 0, limit, showAllTreeElements, scope),
      staleTime: Infinity, // use cached result if available; invalidation forces re-fetch
    });
  }, [queryClient, showAllTreeElements, browseNamespace, safetyNamespace]);

  // ---------------------------------------------------------------------------
  // refreshNode — load children for a model node
  // ---------------------------------------------------------------------------
  const refreshNode = useCallback(async (node: SelectedTreeElement, offset = 0, limit = PAGE_SIZE) => {
    const parentKey = `${node.namespace}:${node.nodeId}`;
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
  }) => {
    const { nodeId, namespace, concept, name, suppressSelect } = params;
    const nsKey = `ns:${namespace}`;

    // Check namespace exists in the current list
    const nsExists = !!state.nodesByKey[nsKey]
      || (allNamespaces ?? []).some((ns) => ns.name === namespace);

    if (!nsExists) {
      // Namespace not in tree — just notify parent
      if (!suppressSelect) onSelect({ nodeId, namespace, concept, name });
      return;
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

    // Resolve ancestor path if not provided
    let ancestorPath = params.ancestorPath;
    if (!ancestorPath) {
      try {
        ancestorPath = await api.namespaces.getAncestorPath(namespace, nodeId);
      } catch (err) {
        treeDebug.warn('[navigate] Failed to fetch ancestor path', { err: String(err) });
        if (!suppressSelect) onSelect({ nodeId, namespace, concept, name });
        return;
      }
    }

    const localNodesByKey: Record<string, TreeNodeRecord> = { ...state.nodesByKey };
    const localLoadedParents = new Set<string>(Object.keys(state.loadedParents));

    // Step 1: Ensure the target node is loaded into the namespace root.
    // If the namespace root has already been loaded but the target is beyond the
    // first page (pagination), keep fetching pages until the node appears or
    // all pages are exhausted.
    const targetKey = `${namespace}:${nodeId}`;

    // Helper: fetch all remaining pages for a parent until the target key is found
    const fetchUntilFound = async (parentKey: string, parentNodeId: number | undefined, ns: string) => {
      let pagination = paginationRef.current.get(parentKey);
      while (pagination?.hasMore && !localNodesByKey[targetKey]) {
        try {
          const pageResult = await fetchChildren(ns, parentNodeId, pagination.offset, PAGE_SIZE);
          const pageRecords = pageResult.children.map((c: TreeChildNode) =>
            toModelRecord(c, ns, parentKey),
          );
          dispatch({
            type: 'LOAD_BRANCH_PAGE',
            parentKey,
            children: pageRecords,
            loadedCount: pagination.offset + pageResult.children.length,
            totalCount: pageResult.totalCount,
          });
          const newOffset = pagination.offset + pageResult.children.length;
          paginationRef.current.set(parentKey, { offset: newOffset, hasMore: pageResult.hasMore });
          if (!pageResult.hasMore) {
            dispatch({ type: 'REMOVE_CHILD', parentKey, childKey: sentinelKey(parentKey) });
          }
          for (const r of pageRecords) localNodesByKey[r.key] = r;
          pagination = paginationRef.current.get(parentKey);
        } catch {
          break;
        }
      }
    };

    if (!localLoadedParents.has(nsKey)) {
      // Namespace root not yet loaded at all — fetch first page
      try {
        const rootResult = await fetchChildren(namespace, undefined, 0, PAGE_SIZE);
        const childRecords = rootResult.children.map((c: TreeChildNode) =>
          toModelRecord(c, namespace, nsKey),
        );
        dispatch({
          type: 'LOAD_BRANCH_PAGE',
          parentKey: nsKey,
          children: childRecords,
          loadedCount: childRecords.length,
          totalCount: rootResult.totalCount,
        });
        paginationRef.current.set(nsKey, { offset: childRecords.length, hasMore: rootResult.hasMore });
        if (rootResult.hasMore) {
          dispatch({ type: 'INSERT_CHILD', parentKey: nsKey, child: toSentinelRecord(nsKey, namespace) });
        }
        for (const r of childRecords) localNodesByKey[r.key] = r;
        localLoadedParents.add(nsKey);
      } catch { /* best-effort */ }
    }

    // If the target is a direct child of the namespace root and still not found,
    // keep paginating until we find it (handles the >200 items case).
    if (!localNodesByKey[targetKey] && ancestorPath.length === 0) {
      await fetchUntilFound(nsKey, undefined, namespace);
    }

    // Step 2: Walk ancestor path, loading each level
    for (const ancestorId of ancestorPath) {
      const ancestorKey = `${namespace}:${ancestorId}`;
      const record = localNodesByKey[ancestorKey];
      if (!record) {
        treeDebug.warn('[navigate] ancestor not found in store', { ancestorKey });
        break;
      }
      if (record.nodeType === 'namespace' || localLoadedParents.has(ancestorKey)) continue;
      try {
        await refreshNode({ nodeId: record.nodeId, namespace: record.namespace, concept: record.concept, name: record.title });
        const childResult = await fetchChildren(record.namespace, record.nodeId);
        for (const c of childResult.children) {
          const cr = toModelRecord(c, record.namespace, ancestorKey);
          localNodesByKey[cr.key] = cr;
        }
        localLoadedParents.add(ancestorKey);
      } catch { break; }
    }

    // Step 3: Expand ancestors
    const ancestorKeys = [nsKey, ...ancestorPath.map((id) => `${namespace}:${id}`)];
    dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: ancestorKeys });

    // Step 4: Select and scroll.
    // If the node is still not in localNodesByKey after all fetching, it means
    // it's paginated under a parent that hasn't been fully loaded yet.
    // Try one more round of pagination on the immediate parent before giving up.
    if (!localNodesByKey[targetKey]) {
      const immediateParentId = ancestorPath.length > 0 ? ancestorPath[ancestorPath.length - 1] : undefined;
      const immediateParentKey = immediateParentId !== undefined
        ? `${namespace}:${immediateParentId}`
        : nsKey;
      await fetchUntilFound(immediateParentKey, immediateParentId, namespace);
    }

    dispatch({ type: 'SET_SELECTED', key: targetKey });
    if (!suppressSelect) {
      const navEntry = { nodeId, namespace, concept, name };
      navHistory.push(navEntry);
      onSelect({ nodeId, namespace, concept, name });
      setTimeout(() => { treeRef.current?.scrollTo({ key: targetKey }); }, 0);
    }
  }, [state.loadedParents, state.nodesByKey, refreshNode, fetchChildren, onSelect, allNamespaces, navHistory]);

  // Resolve the cross-namespace reference target for a node. This is the single
  // source of truth shared by the right-click context menu (handleRightClick) and
  // the keyboard shortcut (navigateToSelectedReference):
  //  - malfunction → its occurs_at target, read from the malfunction detail cache
  //  - safety_note → its structural parent, derived from the tree store's parentKey
  // Returns null when the node has no reference location.
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
          const lastColon = parentKey.lastIndexOf(':');
          const parentNodeId = lastColon !== -1 ? parseInt(parentKey.slice(lastColon + 1), 10) : NaN;
          const parentNamespace = parentKey.slice(0, lastColon);
          if (!isNaN(parentNodeId) && parentNamespace) {
            return { node_id: parentNodeId, namespace: parentNamespace, concept: '' };
          }
        }
      }
      return null;
    },
    [queryClient],
  );

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
    ) => {
      const refKey = `ref:${refNamespace}:${refNodeId}@${hostNamespace}:${hostNodeId}`;

      // Step 1: Navigate to the structural host node — expands its ancestor path.
      // Pass suppressSelect=true so onSelect is NOT called for the host node,
      // preventing the center panel from switching to the port mid-navigation.
      await navigateToTreeNode({ nodeId: hostNodeId, namespace: hostNamespace, concept: '', suppressSelect: true });

      // Also expand the host node itself so its reference children are visible.
      const hostKey = `${hostNamespace}:${hostNodeId}`;
      dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });

      // Step 2: Load the host node's children (including cross-NS reference nodes).
      await refreshNode({ nodeId: hostNodeId, namespace: hostNamespace, concept: '', name: '' });

      // Step 3: Wait for React to commit the LOAD_BRANCH dispatch, then select
      // the reference child key. Poll stateRef (always current) rather than using
      // a fixed timeout — avoids the race where the key isn't in nodesByKey yet
      // when the timeout fires (cold cache, slow machine, large tree).
      const waitForKeyAndSelect = (attempts = 0) => {
        if (stateRef.current.nodesByKey[refKey]) {
          dispatch({ type: 'SET_SELECTED', key: refKey });
          onSelect({ nodeId: refNodeId, namespace: refNamespace, concept: refConcept });
          setTimeout(() => { treeRef.current?.scrollTo({ key: refKey }); }, 50);
        } else if (attempts < 20) {
          // Retry up to 20 × 50ms = 1s
          setTimeout(() => waitForKeyAndSelect(attempts + 1), 50);
        } else {
          treeDebug.warn('[performNavigateToReference] refKey never appeared in nodesByKey', { refKey });
        }
      };
      setTimeout(() => waitForKeyAndSelect(), 50);
    },
    [navigateToTreeNode, refreshNode, onSelect],
  );

  // Imperative handle
  useImperativeHandle(ref, () => ({
    renameNode(nodeId: number, namespace: string, name: string) {
      const key = `${namespace}:${nodeId}`;
      if (state.nodesByKey[key]) {
        dispatch({ type: 'PATCH_TITLE', key, title: name });
      }
      navHistory.rename(nodeId, namespace, name);
    },
    async navigateToNode(nodeId: number, namespace: string, concept: string) {
      try {
        await navigateToTreeNode({ nodeId, namespace, concept });
      } catch (err) {
        treeDebug.error('[NamespaceTreePanel] navigateToNode failed', { err: String(err) });
      }
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
        // A reference child selected directly already carries its host coordinates.
        if (node.hostNodeId !== undefined && node.hostNamespace !== undefined) {
          await performNavigateToReference(node.nodeId, node.namespace, node.concept, node.hostNodeId, node.hostNamespace);
          return;
        }
        // Otherwise resolve the target the same way the context menu does.
        let target = resolveReferenceTarget(node);
        // Robustness: the malfunction detail query may not be warm yet (the user
        // can press the shortcut immediately after selecting). Fetch on demand so
        // the result never depends on cache timing.
        if (!target && node.concept === 'malfunction') {
          try {
            const fm = await api.safety.getMalfunction(node.nodeId);
            target = fm.occursAtTarget ?? null;
          } catch (err) {
            treeDebug.error('[NamespaceTreePanel] navigateToSelectedReference fetch failed', { err: String(err) });
          }
        }
        if (!target) return;
        await performNavigateToReference(node.nodeId, node.namespace, node.concept, target.node_id, target.namespace);
      } catch (err) {
        treeDebug.error('[NamespaceTreePanel] navigateToSelectedReference failed', { err: String(err) });
      }
    },
    async refreshStructuralParent(node: SelectedTreeElement) {
      const parentKey = `${node.namespace}:${node.nodeId}`;
      // Deterministically re-fetch the structural parent's children. Unlike the
      // cache-subscription re-fetch, refreshNode works even when the node was
      // never expanded (which is the case for a port that had no malfunctions).
      try {
        await refreshNode(node);
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
  }), [state.nodesByKey, state.expandedKeys, navigateToTreeNode, fetchChildren, refreshNode, performNavigateToReference, resolveReferenceTarget]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.length < 2) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const result = await api.namespaces.search(value, 0, 50);
        setSearchResults(result.results);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 300);
  }, []);

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

    if (treeNode.nodeType !== 'model') return;

    const key = String(treeNode.key);
    dispatch({ type: 'SET_LOADING', key, loading: true });
    try {
      await refreshNode({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name });
    } catch (err) {
      treeDebug.error(`onLoadData model node "${treeNode.name}" FAILED`, { error: String(err) });
    } finally {
      dispatch({ type: 'SET_LOADING', key, loading: false });
    }
  }, [fetchChildren, state.loadedParents]);

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

      api.namespaces.getChildren(treeNode.namespace, parentNodeId, pagination.offset, PAGE_SIZE, showAllTreeElements)
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
        // Parse host info from key format: ref:refNamespace:refNodeId@hostNamespace:hostNodeId
        let hostNodeId: number | undefined;
        let hostNamespace: string | undefined;
        const atIdx = treeKey.indexOf('@');
        if (atIdx !== -1) {
          const hostPart = treeKey.slice(atIdx + 1);
          const lastColon = hostPart.lastIndexOf(':');
          if (lastColon !== -1) {
            hostNamespace = hostPart.slice(0, lastColon);
            hostNodeId = parseInt(hostPart.slice(lastColon + 1), 10);
          }
        }
        navHistory.push({ ...element, treeKey, hostNodeId, hostNamespace });
        onSelect(element);
      }
      return;
    }

    dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
    if (treeNode.nodeId === -1) { onSelect(null); return; }
    const element = { nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name };
    navHistory.push(element);
    onSelect(element);
  }, [onSelect, loadingMore, state.nodesByKey, showAllTreeElements]);

  const handleRightClick = useCallback((info: { event: React.MouseEvent; node: EventDataNode<SafetyTreeNode> }) => {
    info.event.preventDefault();
    const treeNode = info.node as unknown as SafetyTreeNode;
    if (treeNode.nodeId === -1) { setContextMenuNode(null); return; }
    dispatch({ type: 'SET_SELECTED', key: String(treeNode.key) });
    onSelect({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name });
    setContextMenuNode({ nodeId: treeNode.nodeId, namespace: treeNode.namespace, concept: treeNode.concept, name: treeNode.name });

    // For malfunction nodes, look up occursAtTarget from the TanStack Query cache
    // so the context menu can offer "Show Reference in Tree" when applicable.
    // For safety_note nodes, resolve the parent from the tree store's parentKey.
    // Both cases go through the shared resolveReferenceTarget helper, which is the
    // same logic the Ctrl+Shift+T shortcut uses (navigateToSelectedReference).
    if (treeNode.concept === 'malfunction' || treeNode.concept === 'safety_note') {
      setContextMenuOccursAtTarget(resolveReferenceTarget(treeNode));
    } else {
      setContextMenuOccursAtTarget(null);
    }

    setContextMenuPosition({ x: info.event.clientX, y: info.event.clientY });
  }, [onSelect, resolveReferenceTarget]);

  const handleExpand = useCallback((keys: React.Key[]) => {
    dispatch({ type: 'SET_EXPANDED', keys: keys.map(String) });
  }, []);

  const handleFailureModeCreated = useCallback(async (created: { nodeId: number; name: string }) => {
    if (!createModalTarget) return;

    const parentKey = `${createModalTarget.namespace}:${createModalTarget.nodeId}`;

    // Directly refresh the structural parent so the new malfunction reference
    // appears immediately, regardless of whether the node was previously expanded.
    // The cache subscription guard (loadedParents check) silently skips nodes that
    // were never expanded — which is common for port/leaf nodes in large models.
    // Calling refreshNode here is deterministic: it always re-fetches, dispatches
    // LOAD_BRANCH (which sets loadedParents and flips isLeaf to false when children
    // exist), and works even when the node was a structural leaf with no prior expansion.
    await refreshNode({
      nodeId: createModalTarget.nodeId,
      namespace: createModalTarget.namespace,
      concept: createModalTarget.concept,
      name: createModalTarget.name,
    });

    // Expand the structural parent so the malfunction reference is visible.
    if (!state.expandedKeys[parentKey]) {
      dispatch({ type: 'TOGGLE_EXPAND', key: parentKey });
    }

    // The new malfunction lives in safetyNamespace, not createModalTarget.namespace.
    const createdKey = `${safetyNamespace}:${created.nodeId}`;
    dispatch({ type: 'SET_SELECTED', key: createdKey });
    onSelect({ nodeId: created.nodeId, namespace: safetyNamespace, concept: 'malfunction', name: created.name });
  }, [createModalTarget, onSelect, refreshNode, state.expandedKeys, safetyNamespace]);

  // ---------------------------------------------------------------------------
  // Back / Forward navigation handlers
  // ---------------------------------------------------------------------------
  const handleNavBack = useCallback(() => {
    const entry = navHistory.back();
    if (!entry) return;
    if (entry.hostNodeId !== undefined && entry.hostNamespace !== undefined) {
      // This was a reference node — navigate to the reference position
      navigateToTreeNode({ nodeId: entry.hostNodeId, namespace: entry.hostNamespace, concept: '', suppressSelect: true }).then(() => {
        const hostKey = `${entry.hostNamespace}:${entry.hostNodeId}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
        refreshNode({ nodeId: entry.hostNodeId!, namespace: entry.hostNamespace!, concept: '', name: '' }).then(() => {
          setTimeout(() => {
            if (entry.treeKey) {
              dispatch({ type: 'SET_SELECTED', key: entry.treeKey });
              onSelect({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
              setTimeout(() => { treeRef.current?.scrollTo({ key: entry.treeKey! }); }, 50);
            }
          }, 50);
        });
      });
    } else {
      navigateToTreeNode({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
    }
  }, [navHistory, navigateToTreeNode, refreshNode, onSelect]);

  const handleNavForward = useCallback(() => {
    const entry = navHistory.forward();
    if (!entry) return;
    if (entry.hostNodeId !== undefined && entry.hostNamespace !== undefined) {
      // This was a reference node — navigate to the reference position
      navigateToTreeNode({ nodeId: entry.hostNodeId, namespace: entry.hostNamespace, concept: '', suppressSelect: true }).then(() => {
        const hostKey = `${entry.hostNamespace}:${entry.hostNodeId}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
        refreshNode({ nodeId: entry.hostNodeId!, namespace: entry.hostNamespace!, concept: '', name: '' }).then(() => {
          setTimeout(() => {
            if (entry.treeKey) {
              dispatch({ type: 'SET_SELECTED', key: entry.treeKey });
              onSelect({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
              setTimeout(() => { treeRef.current?.scrollTo({ key: entry.treeKey! }); }, 50);
            }
          }, 50);
        });
      });
    } else {
      navigateToTreeNode({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
    }
  }, [navHistory, navigateToTreeNode, refreshNode, onSelect]);

  const handleNavGoTo = useCallback((index: number) => {
    const entry = navHistory.goTo(index);
    if (!entry) return;
    if (entry.hostNodeId !== undefined && entry.hostNamespace !== undefined) {
      navigateToTreeNode({ nodeId: entry.hostNodeId, namespace: entry.hostNamespace, concept: '', suppressSelect: true }).then(() => {
        const hostKey = `${entry.hostNamespace}:${entry.hostNodeId}`;
        dispatch({ type: 'EXPAND_ANCESTOR_PATH', keys: [hostKey] });
        refreshNode({ nodeId: entry.hostNodeId!, namespace: entry.hostNamespace!, concept: '', name: '' }).then(() => {
          setTimeout(() => {
            if (entry.treeKey) {
              dispatch({ type: 'SET_SELECTED', key: entry.treeKey });
              onSelect({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
              setTimeout(() => { treeRef.current?.scrollTo({ key: entry.treeKey! }); }, 50);
            }
          }, 50);
        });
      });
    } else {
      navigateToTreeNode({ nodeId: entry.nodeId, namespace: entry.namespace, concept: entry.concept, name: entry.name });
    }
  }, [navHistory, navigateToTreeNode, refreshNode, onSelect]);

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
          onRightClick={handleRightClick as (info: { event: React.MouseEvent; node: EventDataNode<DataNode> }) => void}
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
            return treeNode.title as React.ReactNode;
          }}
        />
      </div>

      <TreeContextMenu
        node={contextMenuNode}
        safetyNamespace={safetyNamespace}
        position={contextMenuPosition}
        onClose={() => setContextMenuNode(null)}
        onAddMalfunction={() => {
          setCreateModalTarget(contextMenuNode);
          setCreateModalOpen(true);
        }}
        onReconnectOrphanedMalfunction={() => {
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
        onShowReferenceInTree={(
          onNavigateToReference && contextMenuNode && (
            // Malfunctions: always offer "Show Reference in Tree" and resolve the
            // occurs_at target on-demand at click time (below). Gating menu
            // visibility on contextMenuOccursAtTarget — which is read from the
            // (possibly cold) malfunction detail cache in handleRightClick — is
            // what made the item appear only on the SECOND right-click, once the
            // detail query fired by the first click's onSelect had resolved.
            contextMenuNode.concept === 'malfunction' ||
            // safety_note reference targets are resolved synchronously from the
            // tree store (see resolveReferenceTarget), so they are reliably
            // available on the first right-click.
            (contextMenuNode.concept === 'safety_note' && contextMenuOccursAtTarget)
          )
        ) ? () => {
          const node = contextMenuNode;
          if (!node) return;
          void (async () => {
            let target = contextMenuOccursAtTarget;
            // On-demand resolve for malfunctions when the cache was cold at
            // right-click time — mirrors navigateToSelectedReference's fallback
            // so the result never depends on query-cache warmth.
            if (!target && node.concept === 'malfunction') {
              try {
                const fm = await api.safety.getMalfunction(node.nodeId);
                target = fm.occursAtTarget ?? null;
              } catch (err) {
                treeDebug.error('[NamespaceTreePanel] context-menu Show Reference in Tree fetch failed', { err: String(err) });
              }
            }
            if (!target) return;
            onNavigateToReference(
              node.nodeId,
              node.namespace,
              node.concept,
              target.node_id,
              target.namespace,
            );
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
              // Extract the parent node ID and namespace from the parentKey.
              // parentKey format: "ns:NamespaceName" (namespace root) or "NamespaceName:nodeId"
              // or "ref:..." for reference parents. We need the structural parent's nodeId + namespace.
              let parentNodeId: number | undefined;
              let parentNamespace: string | undefined;
              if (parentKey) {
                if (parentKey.startsWith('ns:')) {
                  // Parent is a namespace root — no structural nodeId
                  parentNamespace = parentKey.slice(3);
                } else {
                  const lastColon = parentKey.lastIndexOf(':');
                  const id = lastColon !== -1 ? parseInt(parentKey.slice(lastColon + 1), 10) : NaN;
                  if (!isNaN(id)) {
                    parentNodeId = id;
                    parentNamespace = parentKey.slice(0, lastColon);
                  }
                }
              }
              await deleteSafetyNote.mutateAsync({ nodeId: pendingDeleteNode.nodeId, parentNodeId, parentNamespace });
            } else if (pendingDeleteNode.concept === 'tag') {
              // Find the tag's record in the tree store to resolve its parent.
              const tagRecord = Object.values(state.nodesByKey).find(
                (r) => r.nodeId === pendingDeleteNode.nodeId &&
                        r.namespace === pendingDeleteNode.namespace &&
                        r.concept === 'tag',
              );
              const parentKey = tagRecord?.parentKey;
              let parentNodeId: number | undefined;
              let parentNamespace: string | undefined;
              if (parentKey && !parentKey.startsWith('ns:')) {
                const lastColon = parentKey.lastIndexOf(':');
                const id = lastColon !== -1 ? parseInt(parentKey.slice(lastColon + 1), 10) : NaN;
                if (!isNaN(id)) {
                  parentNodeId = id;
                  parentNamespace = parentKey.slice(0, lastColon);
                }
              } else if (parentKey?.startsWith('ns:')) {
                parentNamespace = parentKey.slice(3);
              }
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

      <CreateMalfunctionModal
        open={createModalOpen}
        namespace={safetyNamespace}
        selectedTreeElement={createModalTarget}
        onClose={() => { setCreateModalOpen(false); setCreateModalTarget(null); }}
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
