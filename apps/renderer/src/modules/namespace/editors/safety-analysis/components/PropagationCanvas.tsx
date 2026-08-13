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
 * PropagationCanvas — unified React Flow canvas for propagation diagrams.
 *
 * Accepts pre-normalised node/edge data from either:
 *   - ScopedPropagationDiagram  (component-scoped view)
 *   - FailurePropagationDiagram (malfunction-centric view)
 *
 * Visual rules applied consistently to both views:
 *   - scopeFrameColor: green for p_port/pr_port, blue for r_port, purple for SWC
 *   - opacity 0.45    for boundary (out-of-scope) nodes
 *   - dashed orange   for the pending-propagation-source node
 *   - Ctrl+F          opens an in-canvas search bar; matches highlighted cyan
 *
 * All ELK layout, React Flow rendering, context-menu interactions,
 * and propagation mutations live here — wrappers only provide data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import {
  ReactFlow,
  MarkerType,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, App, Button, Empty, Input, Spin, Tooltip, theme } from 'antd';
import { CloseOutlined, ReloadOutlined, UpOutlined, DownOutlined as DownOutlinedNav } from '@ant-design/icons';
import { computeElkLayout } from '../utils/elkLayout';
import { MalfunctionNode, type MalfunctionNodeData } from './MalfunctionNode';
import { PropagationEdge } from './PropagationEdge';
import { usePropagationMutation } from '../hooks/useSafetyMutations';
import { getAsilHexColor } from '../config/asilColors';

// ---------------------------------------------------------------------------
// Public node / edge types
// ---------------------------------------------------------------------------

export interface PropagationCanvasNode {
  /** React Flow node id — String(nodeId). */
  id: string;
  nodeId: number;
  name: string;
  description: string;
  namespace: string;
  concept: string;
  asil: string;
  occursAtTarget?: { node_id: number; namespace: string; concept: string; name?: string } | null;
  /** True for the entry (focal) malfunction in malfunction-centric views. */
  isEntry: boolean;
  /**
   * True for nodes outside the current scope — rendered at 0.45 opacity.
   * Pre-computed by the wrapper (ScopedPropagationDiagram from internal/boundary
   * split; FailurePropagationDiagram from focal structural node comparison).
   */
  isBoundary: boolean;
  isTruncated: boolean;
}

export interface PropagationCanvasEdge {
  id: string;
  source: string;
  target: string;
}

// ---------------------------------------------------------------------------
// Constants (shared by both diagram types)
// ---------------------------------------------------------------------------

const NODE_WIDTH = 300;
const NODE_MIN_HEIGHT = 92;

/**
 * Build the occurs-at label exactly as MalfunctionNode renders it. Shared between
 * the layout-height estimate and the React Flow node data so both stay in sync.
 */
function buildOccursAtLabel(
  occursAtTarget: { concept: string; name?: string } | null | undefined,
): string | undefined {
  if (!occursAtTarget) return undefined;
  return occursAtTarget.name
    ? `${formatConceptLabel(occursAtTarget.concept)}: ${occursAtTarget.name}`
    : formatConceptLabel(occursAtTarget.concept);
}

/**
 * Estimate a node's rendered height so ELK reserves enough vertical room for the
 * now fully-wrapped (non-truncated) malfunction name and occurs-at label. The
 * MalfunctionNode card grows with its content, so a fixed height would overlap
 * long names. This is an approximation based on average glyph advance — exact
 * pixel accuracy is unnecessary because ELK adds inter-node spacing on top.
 */
function estimateNodeHeight(
  name: string,
  occursAtLabel: string | undefined,
  hasDescription: boolean,
): number {
  // The card reserves space on the right for the expand chevron + ASIL badge.
  const rightPad = hasDescription ? 72 : 52;
  const textWidth = NODE_WIDTH - 12 - rightPad; // left padding + reserved right area

  // Name: 13px / line-height 1.45 ≈ 19px per line, ~6.6px average glyph advance.
  const nameCharsPerLine = Math.max(8, Math.floor(textWidth / 6.6));
  const nameLines = Math.max(1, Math.ceil((name?.length ?? 0) / nameCharsPerLine));
  const nameHeight = nameLines * 19;

  // Occurs-at label: 11px / line-height 1.35 ≈ 15px per line + 4px margin-bottom.
  let labelHeight = 0;
  if (occursAtLabel) {
    const labelCharsPerLine = Math.max(8, Math.floor(textWidth / 5.6));
    const labelLines = Math.max(1, Math.ceil(occursAtLabel.length / labelCharsPerLine));
    labelHeight = labelLines * 15 + 4;
  }

  const verticalPadding = 20; // 10px top + 10px bottom
  return Math.max(NODE_MIN_HEIGHT, verticalPadding + labelHeight + nameHeight);
}

// Horizontal gap between a newly-added node and the neighbour it attaches to,
// matching ELK's inter-layer spacing so incremental placement looks consistent
// with a full auto-layout.
const INCREMENTAL_H_GAP = 100;
// Vertical step used when nudging a new node down to clear an overlap.
const INCREMENTAL_V_STEP = 50;

/**
 * Place a newly-added node next to a neighbour that already has a position,
 * instead of trusting the coordinate ELK computed for a throwaway full-graph
 * layout (which is unrelated to the user's preserved manual arrangement and
 * causes "strange" placement / overlaps).
 *
 * Layout flows RIGHT (source → target), so:
 *   - a propagation TARGET is placed to the right of its source, and
 *   - a propagation SOURCE is placed to the left of its target.
 * The candidate is then nudged straight down until it no longer overlaps any
 * already-positioned node. Falls back to the ELK position when the new node has
 * no positioned neighbour (should not happen for a connected incremental add).
 */
export function placeNewNodeNearNeighbors(
  newNodeId: string,
  edges: PropagationCanvasEdge[],
  positions: Map<string, { x: number; y: number }>,
  heights: Map<string, number>,
): { x: number; y: number } | undefined {
  const newHeight = heights.get(newNodeId) ?? NODE_MIN_HEIGHT;

  // Prefer anchoring to the source of an incoming edge (place to the right);
  // otherwise anchor to the target of an outgoing edge (place to the left).
  let candidate: { x: number; y: number } | undefined;
  for (const e of edges) {
    if (e.target === newNodeId && positions.has(e.source)) {
      const src = positions.get(e.source)!;
      candidate = { x: src.x + NODE_WIDTH + INCREMENTAL_H_GAP, y: src.y };
      break;
    }
  }
  if (!candidate) {
    for (const e of edges) {
      if (e.source === newNodeId && positions.has(e.target)) {
        const tgt = positions.get(e.target)!;
        candidate = { x: tgt.x - NODE_WIDTH - INCREMENTAL_H_GAP, y: tgt.y };
        break;
      }
    }
  }
  if (!candidate) return undefined;

  // Nudge down until the candidate's vertical span clears every positioned node
  // that shares horizontal overlap. Bounded to avoid any pathological loop.
  const overlaps = (y: number): { bottom: number } | null => {
    for (const [id, pos] of positions) {
      if (id === newNodeId) continue;
      const h = heights.get(id) ?? NODE_MIN_HEIGHT;
      const xOverlap = candidate!.x < pos.x + NODE_WIDTH && candidate!.x + NODE_WIDTH > pos.x;
      const yOverlap = y < pos.y + h && y + newHeight > pos.y;
      if (xOverlap && yOverlap) return { bottom: pos.y + h };
    }
    return null;
  };
  for (let i = 0; i < positions.size + 1; i++) {
    const hit = overlaps(candidate.y);
    if (!hit) break;
    candidate.y = hit.bottom + INCREMENTAL_V_STEP;
  }
  return candidate;
}

// Defined outside component to prevent React Flow re-registration on each render
const nodeTypes = { malfunctionNode: MalfunctionNode };
const edgeTypes = { propagationEdge: PropagationEdge };

// ---------------------------------------------------------------------------
// Shared helpers (previously duplicated in both diagram components)
// ---------------------------------------------------------------------------

/** Format a raw ARXML concept string (e.g. "r_port") into a readable label. */
export function formatConceptLabel(concept: string): string {
  const CONCEPT_LABELS: Record<string, string> = {
    r_port: 'R-Port',
    p_port: 'P-Port',
    pr_port: 'PR-Port',
    application_swc: 'SWC',
    composition_swc: 'Composition',
    service_swc: 'Service SWC',
    sensor_actuator_swc: 'Sensor/Actuator',
  };
  return CONCEPT_LABELS[concept] ?? concept.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Derive a scope frame colour from the occurs-at concept of an in-scope node:
 *   p_port / pr_port  → successColor (green) — provider port (sends data)
 *   r_port            → primaryColor (blue)  — receiver port (receives data)
 *   *_swc             → componentColor (purple) — component in scope
 *   no target         → primaryColor (blue)  — conservative fallback
 * Boundary nodes keep the same frame colour; their faded state comes from opacity.
 */
export function computeScopeFrameColor(
  _isBoundary: boolean,
  occursAtConcept: string | undefined,
  primaryColor: string,
  successColor: string,
  componentColor: string,
): string | undefined {
  if (occursAtConcept === 'p_port' || occursAtConcept === 'pr_port') return successColor;
  if (occursAtConcept?.endsWith('_swc')) return componentColor;
  return primaryColor;
}

// ---------------------------------------------------------------------------
// PropagationSearchPanel — rendered inside <ReactFlow> so useReactFlow works
// ---------------------------------------------------------------------------

interface PropagationSearchPanelProps {
  rfNodes: Node<MalfunctionNodeData>[];
  searchOpen: boolean;
  searchQuery: string;
  searchMatchIndex: number;
  searchMatchIds: string[];
  onQueryChange: (q: string) => void;
  onIndexChange: (idx: number) => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function PropagationSearchPanel({
  searchOpen,
  searchQuery,
  searchMatchIndex,
  searchMatchIds,
  rfNodes,
  onQueryChange,
  onIndexChange,
  onClose,
  inputRef,
}: PropagationSearchPanelProps) {
  const { token } = theme.useToken();
  const { setCenter } = useReactFlow();

  // Pan to the focused match whenever it changes
  useEffect(() => {
    if (searchMatchIds.length === 0) return;
    const focusId = searchMatchIds[searchMatchIndex];
    const focusNode = rfNodes.find((n) => n.id === focusId);
    if (!focusNode) return;
    // Pan roughly to the node centre (width 300; height varies with wrapped name).
    setCenter(focusNode.position.x + NODE_WIDTH / 2, focusNode.position.y + 50, {
      zoom: 1,
      duration: 350,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatchIndex, searchMatchIds]);

  if (!searchOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Stop propagation so ReactFlow doesn't handle Delete / arrow keys etc.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchMatchIds.length > 0) {
        onIndexChange(
          e.shiftKey
            ? (searchMatchIndex - 1 + searchMatchIds.length) % searchMatchIds.length
            : (searchMatchIndex + 1) % searchMatchIds.length,
        );
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius,
        padding: '4px 8px',
        boxShadow: token.boxShadow,
      }}
      onKeyDown={handleKeyDown}
    >
        <Input
          ref={(el) => {
            // @ts-ignore — AntD InputRef exposes .input
            (inputRef as React.MutableRefObject<HTMLInputElement | null>).current =
              el?.input ?? null;
          }}
          size="small"
          placeholder="Search name, description, port…"
          value={searchQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          style={{ width: 220 }}
          allowClear
          aria-label="Search malfunctions in propagation view"
          autoFocus
        />

        {/* Match counter */}
        <span
          style={{
            fontSize: 12,
            color:
              searchQuery.trim() && searchMatchIds.length === 0
                ? token.colorError
                : token.colorTextSecondary,
            minWidth: 52,
            textAlign: 'center',
            userSelect: 'none',
          }}
        >
          {searchQuery.trim()
            ? searchMatchIds.length === 0
              ? 'No match'
              : `${searchMatchIndex + 1} / ${searchMatchIds.length}`
            : ''}
        </span>

        {/* Previous match */}
        <button
          aria-label="Previous match (Shift+Enter)"
          disabled={searchMatchIds.length === 0}
          onClick={() =>
            onIndexChange(
              (searchMatchIndex - 1 + searchMatchIds.length) % searchMatchIds.length,
            )
          }
          style={{
            background: 'none',
            border: 'none',
            cursor: searchMatchIds.length === 0 ? 'default' : 'pointer',
            padding: '0 2px',
            color: searchMatchIds.length === 0 ? token.colorTextDisabled : token.colorText,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <UpOutlined style={{ fontSize: 11 }} />
        </button>

        {/* Next match */}
        <button
          aria-label="Next match (Enter)"
          disabled={searchMatchIds.length === 0}
          onClick={() =>
            onIndexChange((searchMatchIndex + 1) % searchMatchIds.length)
          }
          style={{
            background: 'none',
            border: 'none',
            cursor: searchMatchIds.length === 0 ? 'default' : 'pointer',
            padding: '0 2px',
            color: searchMatchIds.length === 0 ? token.colorTextDisabled : token.colorText,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <DownOutlinedNav style={{ fontSize: 11 }} />
        </button>

        {/* Close */}
        <button
          aria-label="Close search (Escape)"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 2px',
            color: token.colorTextSecondary,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <CloseOutlined style={{ fontSize: 11 }} />
        </button>
      </div>
  );
}

// ---------------------------------------------------------------------------
// LayoutControls — manual "Refresh layout" button (rendered inside ReactFlow)
// ---------------------------------------------------------------------------

interface LayoutControlsProps {
  /** Bump the layout version in the parent to trigger a full ELK re-arrange. */
  onRefresh: () => void;
  /**
   * Incremented by the parent once a manual-refresh layout has been applied.
   * Watched here to fit the viewport to the freshly arranged graph.
   */
  fitTick: number;
}

function LayoutControls({ onRefresh, fitTick }: LayoutControlsProps) {
  const { fitView } = useReactFlow();
  const mountedRef = useRef(false);

  useEffect(() => {
    // Skip the initial render; only fit after an explicit refresh.
    if (!mountedRef.current) { mountedRef.current = true; return; }
    void fitView({ padding: 0.2, duration: 350 });
  }, [fitTick, fitView]);

  return (
    <Tooltip title="Re-arrange all nodes with automatic layout">
      <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>
        Refresh layout
      </Button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PropagationCanvasProps {
  nodes: PropagationCanvasNode[];
  edges: PropagationCanvasEdge[];
  /** Safety namespace — for mutations and pending-source store access. */
  namespace: string;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  /**
   * Called after every successful add/remove mutation.
   * The wrapper should invalidate its specific query cache here.
   */
  onInvalidate: () => void;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (
    refNodeId: number, refNamespace: string, refConcept: string,
    hostNodeId: number, hostNamespace: string,
  ) => void;
  /** Message shown when there are no nodes to display. */
  emptyDescription?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PropagationCanvas({
  nodes,
  edges,
  namespace,
  isLoading,
  isError,
  error,
  onInvalidate,
  onNavigateToNode,
  onNavigateToReference,
  emptyDescription = 'No malfunctions with propagation relationships found.',
}: PropagationCanvasProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const { add: addPropagation, remove: removePropagation } = usePropagationMutation(namespace);

  // ── Search state ──────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // ── Canvas selection (click to select, Ctrl+T to navigate) ───────────────
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string | null>(null);

  // Scope frame colours (read from theme; stable refs for use inside effects)
  const scopePrimaryColor = token.colorPrimary;
  const scopeSuccessColor = token.colorSuccess;
  const scopeComponentColor = '#722ed1';
  const scopePrimaryColorRef = useRef(scopePrimaryColor);
  scopePrimaryColorRef.current = scopePrimaryColor;
  const scopeSuccessColorRef = useRef(scopeSuccessColor);
  scopeSuccessColorRef.current = scopeSuccessColor;
  const scopeComponentColorRef = useRef(scopeComponentColor);
  scopeComponentColorRef.current = scopeComponentColor;

  // Pending propagation source for this namespace
  const pendingSource = useWorkspaceStore((s) => s.pendingPropagationSource[namespace] ?? null);
  const pendingSourceRef = useRef(pendingSource);
  pendingSourceRef.current = pendingSource;

  // Position persistence — survive re-layouts; positions are only discarded on an
  // explicit "Refresh layout" so modeling new propagations never re-arranges nodes.
  const userPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Manual layout control. Auto-layout runs only on first load and on explicit
  // refresh; `layoutVersion` bumps to request a full ELK re-arrange, `fitTick`
  // signals the in-canvas controls to fit the viewport afterwards.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const lastLayoutVersionRef = useRef(0);
  const [fitTick, setFitTick] = useState(0);
  const refreshLayout = useCallback(() => setLayoutVersion((v) => v + 1), []);

  // Data fingerprint — drives the layout effect that rebuilds rfNodes from props.
  // Includes:
  //   - isBoundary so scope changes (boundary reclassification without id changes)
  //     trigger a re-render, and
  //   - the rendered text fields (name, description, occurs-at name) so editing a
  //     malfunction's name/description — or renaming its occurs_at target — refreshes
  //     the node label. Without these, the query cache updates but React Flow keeps
  //     the stale node data because the effect never re-runs.
  // Fields are joined with control-character separators (\u0001 within a node,
  // \u0002 between nodes) so free-text values containing ':' or ',' cannot collide.
  const dataFingerprint = useMemo(() => {
    const nodeIds = nodes
      .map((n) =>
        [
          n.id,
          n.asil,
          n.isBoundary ? 'B' : 'I',
          n.name,
          n.description,
          n.occursAtTarget?.name ?? '',
        ].join('\u0001'),
      )
      .sort()
      .join('\u0002');
    const edgeIds = edges.map((e) => e.id).sort().join(',');
    return `${nodeIds}|${edgeIds}`;
  }, [nodes, edges]);

  // React Flow state
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<MalfunctionNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Stable refs — keep effect closure fresh without re-running the effect
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const onNavigateToNodeRef = useRef(onNavigateToNode);
  onNavigateToNodeRef.current = onNavigateToNode;
  const onNavigateToReferenceRef = useRef(onNavigateToReference);
  onNavigateToReferenceRef.current = onNavigateToReference;
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;

  // ── Layout effect ─────────────────────────────────────────────────────────
  useEffect(() => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;

    if (currentNodes.length === 0) {
      setRfNodes([]);
      setRfEdges([]);
      return;
    }

    // Auto-layout runs only on the first render and on an explicit user refresh.
    // Modeling new propagations changes `dataFingerprint` (so the effect re-runs to
    // add/remove nodes and refresh node data) but existing positions are preserved
    // — the user's manual arrangement is no longer reset.
    const manualRefresh = layoutVersion !== lastLayoutVersionRef.current;
    lastLayoutVersionRef.current = layoutVersion;

    // Decide whether this pass is a full auto-layout or a position-preserving update.
    // Auto-layout (full ELK + viewport fit) runs when:
    //   - the user clicked "Refresh layout" (manualRefresh), or
    //   - nothing has been positioned yet (initial render of the view), or
    //   - the graph is an entirely new view — it shares no node ids with the
    //     previous layout (e.g. the user selected a different element).
    // Otherwise (modeling a propagation onto the current view) existing positions
    // are preserved so the user's arrangement is not disturbed.
    const savedPositions = userPositionsRef.current;
    let sharesNodeWithPrevious = false;
    for (const n of currentNodes) {
      if (savedPositions.has(n.id)) { sharesNodeWithPrevious = true; break; }
    }
    const autoLayout = manualRefresh || savedPositions.size === 0 || !sharesNodeWithPrevious;
    if (autoLayout) {
      savedPositions.clear();
    }

    let cancelled = false;

    const runLayout = async () => {
      const { positions } = await computeElkLayout({
        nodes: currentNodes.map((n) => ({
          id: n.id,
          width: NODE_WIDTH,
          height: estimateNodeHeight(n.name, buildOccursAtLabel(n.occursAtTarget), !!n.description),
        })),
        edges: currentEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      });

      if (cancelled) return;

      // Ids that already had a saved position before this pass (existing nodes).
      // Captured before the restore loop so newly-added nodes can be identified.
      const existingIds = new Set(userPositionsRef.current.keys());

      // Restore user-dragged positions
      for (const [id, pos] of userPositionsRef.current) {
        positions.set(id, pos);
      }

      // Incremental add (not a full auto-layout): a newly-added node keeps the
      // coordinate ELK computed for a throwaway full-graph layout, which is
      // unrelated to the preserved manual positions and lands "strangely".
      // Re-place each new node next to a connected, already-positioned neighbour.
      if (!autoLayout) {
        const heights = new Map<string, number>(
          currentNodes.map((n) => [
            n.id,
            estimateNodeHeight(n.name, buildOccursAtLabel(n.occursAtTarget), !!n.description),
          ]),
        );
        for (const node of currentNodes) {
          if (existingIds.has(node.id)) continue; // existing node — position preserved
          const placed = placeNewNodeNearNeighbors(node.id, currentEdges, positions, heights);
          if (placed) positions.set(node.id, placed);
        }
      }

      const primary = scopePrimaryColorRef.current;
      const success = scopeSuccessColorRef.current;
      const component = scopeComponentColorRef.current;
      const pending = pendingSourceRef.current;

      const rfNodesResult: Node<MalfunctionNodeData>[] = currentNodes.map((node) => ({
        id: node.id,
        type: 'malfunctionNode' as const,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        // Boundary nodes are faded; in-scope nodes get a coloured frame
        style: node.isBoundary ? { opacity: 0.45 } : undefined,
        data: {
          nodeId: node.nodeId,
          name: node.name,
          description: node.description,
          namespace: node.namespace,
          concept: node.concept,
          asil: node.asil,
          asilColor: getAsilHexColor(node.asil),
          occursAtTarget: node.occursAtTarget,
          occursAtLabel: buildOccursAtLabel(node.occursAtTarget),
          isEntry: node.isEntry,
          isTruncated: node.isTruncated,
          // Frame colour: green for provider ports, blue for receiver ports,
          // purple for component-level malfunctions, conservative blue fallback otherwise.
          scopeFrameColor: computeScopeFrameColor(
            node.isBoundary,
            node.occursAtTarget?.concept,
            primary,
            success,
            component,
          ),
          isPendingSource: node.nodeId === pending?.nodeId,
          disableContextMenu: true,
          onNavigateToNode: onNavigateToNodeRef.current,
          onNavigateToReference: onNavigateToReferenceRef.current,
        },
      }));

      const rfEdgesResult: Edge[] = currentEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'propagationEdge' as const,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
      }));

      setRfNodes(rfNodesResult);
      setRfEdges(rfEdgesResult);

      // Persist resolved positions (ELK for any new nodes, saved positions for
      // existing ones) and prune removed nodes, so the next data change keeps the
      // current arrangement intact.
      const persisted = new Map<string, { x: number; y: number }>();
      for (const node of currentNodes) {
        const pos = positions.get(node.id);
        if (pos) persisted.set(node.id, pos);
      }
      userPositionsRef.current = persisted;

      // After a full auto-layout (initial render, new view, or explicit refresh)
      // fit the viewport to the freshly arranged graph.
      if (autoLayout) setFitTick((t) => t + 1);
    };

    void runLayout();
    return () => { cancelled = true; };
  }, [dataFingerprint, layoutVersion, setRfNodes, setRfEdges]);

  // ── Keep isPendingSource flag in sync between layouts ─────────────────────
  useEffect(() => {
    setRfNodes((prev) =>
      prev.map((node) => {
        const nid = (node.data as MalfunctionNodeData).nodeId;
        const next = nid === pendingSource?.nodeId;
        if ((node.data as MalfunctionNodeData).isPendingSource === next) return node;
        return { ...node, data: { ...node.data, isPendingSource: next } };
      }),
    );
  }, [pendingSource, setRfNodes]);

  // ── Search match IDs (derived from source nodes, NOT rfNodes) ─────────────
  // Deliberately uses the `nodes` prop — not `rfNodes` — to avoid a feedback
  // loop where updating rfNodes (to set isSearchMatch) re-triggers this memo,
  // which re-triggers the sync effect, causing an infinite update cycle.
  //
  // Matches against name, description, and the occurs-at port/target text so a
  // node is found by any of its visible (or expand-to-reveal) content. The port
  // text combines the raw target name and the formatted "R-Port: …" label, so
  // searching either the readable concept ("p-port") or the underlying signal
  // name works.
  const searchMatchIds = useMemo<string[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || !searchOpen) return [];
    return nodes
      .filter((n) => {
        const portText = [
          n.occursAtTarget?.name,
          buildOccursAtLabel(n.occursAtTarget),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return (
          n.name.toLowerCase().includes(q) ||
          n.description.toLowerCase().includes(q) ||
          portText.includes(q)
        );
      })
      .map((n) => n.id);
  }, [nodes, searchQuery, searchOpen]);

  // Clamp index when match list shrinks
  useEffect(() => {
    setSearchMatchIndex((prev) =>
      searchMatchIds.length === 0 ? 0 : Math.min(prev, searchMatchIds.length - 1),
    );
  }, [searchMatchIds.length]);

  // Sync isSearchMatch / isSearchFocus flags onto rfNodes, and dim non-matches
  // when a search is active so matches pop visually.
  useEffect(() => {
    const hasActiveSearch = searchOpen && searchQuery.trim().length > 0;
    setRfNodes((prev) =>
      prev.map((node) => {
        const isMatch = searchMatchIds.includes(node.id);
        const isFocus =
          searchMatchIds.length > 0 && node.id === searchMatchIds[searchMatchIndex];
        const d = node.data as MalfunctionNodeData;

        // Preserve existing boundary opacity; otherwise dim non-matches during search
        const isBoundaryNode = node.style?.opacity === 0.45;
        const dimOpacity = isBoundaryNode ? 0.15 : 0.2;
        const nextOpacity = hasActiveSearch && !isMatch
          ? dimOpacity
          : isBoundaryNode
          ? 0.45
          : undefined;
        const currentOpacity = node.style?.opacity as number | undefined;

        if (
          d.isSearchMatch === isMatch &&
          d.isSearchFocus === isFocus &&
          currentOpacity === nextOpacity
        ) return node;

        return {
          ...node,
          style: { ...node.style, opacity: nextOpacity },
          data: { ...d, isSearchMatch: isMatch, isSearchFocus: isFocus },
        };
      }),
    );
  }, [searchMatchIds, searchMatchIndex, setRfNodes, searchOpen, searchQuery]);

  // ── Selected node (for Ctrl+T "Show in Tree") ────────────────────────────
  // Tracks the last node the user clicked in the canvas so Ctrl+T can navigate
  // to it using the same onNavigateToNode path as the right-click context menu.
  const selectedCanvasNodeRef = useRef<{
    nodeId: number;
    namespace: string;
    concept: string;
    occursAtTarget: { node_id: number; namespace: string; concept: string } | null | undefined;
  } | null>(null);

  // Sync isSelected flag onto rfNodes when canvas selection changes
  useEffect(() => {
    setRfNodes((prev) =>
      prev.map((node) => {
        const next = node.id === selectedCanvasNodeId;
        const d = node.data as MalfunctionNodeData;
        if (d.isSelected === next) return node;
        return { ...node, data: { ...d, isSelected: next } };
      }),
    );
  }, [selectedCanvasNodeId, setRfNodes]);

  // ── Ctrl+F / Ctrl+T keyboard handlers ────────────────────────────────────
  // Listen on document so shortcuts fire without needing to click the canvas
  // first. A hover guard ensures they only activate when the pointer is over
  // this diagram (avoids conflicts with other panels).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isHoveredRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isHoveredRef.current) return;

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'f') {
        // Ctrl+F — open search
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        // Ctrl+T and Ctrl+Shift+T — same functions as right-click context menu.
        const sel = selectedCanvasNodeRef.current;
        const isShift = e.shiftKey;
        const shortcut = isShift ? 'Ctrl+Shift+T' : 'Ctrl+T';

        console.group(`[PropagationCanvas] ${shortcut}`);
        console.log('isHovered:', isHoveredRef.current);
        console.log('selectedCanvasNode:', sel
          ? { nodeId: sel.nodeId, namespace: sel.namespace, concept: sel.concept, occursAtTarget: sel.occursAtTarget }
          : null);
        console.log('onNavigateToNode available:', !!onNavigateToNodeRef.current);
        console.log('onNavigateToReference available:', !!onNavigateToReferenceRef.current);

        if (!sel) {
          console.warn('→ No canvas node selected — shortcut ignored');
          console.groupEnd();
          return;
        }

        if (!isShift) {
          // Ctrl+T → "Show in Tree"
          if (onNavigateToNodeRef.current) {
            e.preventDefault();
            console.log('→ Calling onNavigateToNode', { nodeId: sel.nodeId, namespace: sel.namespace, concept: sel.concept });
            onNavigateToNodeRef.current(sel.nodeId, sel.namespace, sel.concept);
          } else {
            console.warn('→ onNavigateToNode not available — shortcut ignored');
          }
        } else {
          // Ctrl+Shift+T → "Show Reference in Tree"
          if (sel.occursAtTarget && onNavigateToReferenceRef.current) {
            e.preventDefault();
            console.log('→ Calling onNavigateToReference', {
              refNodeId: sel.nodeId,
              refNamespace: sel.namespace,
              refConcept: sel.concept,
              hostNodeId: sel.occursAtTarget.node_id,
              hostNamespace: sel.occursAtTarget.namespace,
            });
            onNavigateToReferenceRef.current(
              sel.nodeId, sel.namespace, sel.concept,
              sel.occursAtTarget.node_id, sel.occursAtTarget.namespace,
            );
          } else {
            console.warn('→ Show Reference in Tree blocked:', {
              hasOccursAtTarget: !!sel.occursAtTarget,
              occursAtTarget: sel.occursAtTarget,
              hasOnNavigateToReference: !!onNavigateToReferenceRef.current,
            });
          }
        }
        console.groupEnd();
      } else if (e.key === 'Escape' && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchOpen]);

  // ── Interaction handlers ──────────────────────────────────────────────────

  const handleNodeContextMenu = useCallback(
    async (event: React.MouseEvent, node: Node<MalfunctionNodeData>) => {
      event.preventDefault();
      const { api: riacoreApi } = await import('../../../../../api/riacore');
      const { pendingPropagationSource, setPendingPropagationSource } = useWorkspaceStore.getState();
      const pending = pendingPropagationSource[namespace] ?? null;

      const items: { id: string; label: string }[] = [];
      if (onNavigateToNodeRef.current) {
        items.push({ id: 'showInTree', label: 'Show in Tree' });
      }
      if (node.data.occursAtTarget && onNavigateToReferenceRef.current) {
        items.push({ id: 'showReferenceInTree', label: 'Show Reference in Tree' });
      }
      if (!pending) {
        items.push({ id: 'startPropagation', label: 'Start Propagation' });
      } else if (pending.nodeId !== node.data.nodeId) {
        items.push({ id: 'endPropagation', label: 'End Propagation to' });
      }

      if (items.length === 0) return;
      const selectedId = await riacoreApi.contextMenu.show(items);

      if (selectedId === 'showInTree') {
        onNavigateToNodeRef.current?.(node.data.nodeId, node.data.namespace, node.data.concept);
      } else if (selectedId === 'showReferenceInTree' && node.data.occursAtTarget) {
        onNavigateToReferenceRef.current?.(
          node.data.nodeId, node.data.namespace, node.data.concept,
          node.data.occursAtTarget.node_id, node.data.occursAtTarget.namespace,
        );
      } else if (selectedId === 'startPropagation') {
        setPendingPropagationSource(namespace, {
          nodeId: node.data.nodeId,
          name: node.data.name,
          namespace: node.data.namespace,
          concept: 'malfunction',
        });
      } else if (selectedId === 'endPropagation' && pending) {
        try {
          await addPropagation.mutateAsync({
            sourceFmNodeId: pending.nodeId,
            targetFmNodeId: node.data.nodeId,
          });
          onInvalidateRef.current();
          setPendingPropagationSource(namespace, null);
        } catch (err) {
          message.error(String((err as Error)?.message ?? 'Failed to create propagation'));
        }
      }
    },
    [namespace, addPropagation, message],
  );

  const handleNodeDragStop = useCallback((_event: React.MouseEvent, node: Node) => {
    userPositionsRef.current.set(node.id, node.position);
  }, []);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node<MalfunctionNodeData>) => {
    // Track the clicked node so Ctrl+T can navigate to it in the tree.
    // Does NOT call onNavigateToNode automatically — the user may want to drag
    // or inspect the node without the tree jumping to it.
    const sel = {
      nodeId: node.data.nodeId,
      namespace: node.data.namespace,
      concept: node.data.concept,
      occursAtTarget: node.data.occursAtTarget ?? null,
    };
    selectedCanvasNodeRef.current = sel;
    setSelectedCanvasNodeId(node.id);
    console.log('[PropagationCanvas] node selected:', sel);
  }, []);

  const handleConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    try {
      await addPropagation.mutateAsync({
        sourceFmNodeId: parseInt(connection.source, 10),
        targetFmNodeId: parseInt(connection.target, 10),
      });
      onInvalidateRef.current();
    } catch (err) {
      message.error(String((err as Error)?.message ?? 'Failed to create propagation'));
    }
  }, [addPropagation, message]);

  const handleEdgesDelete = useCallback(async (deletedEdges: Edge[]) => {
    for (const edge of deletedEdges) {
      try {
        await removePropagation.mutateAsync({
          sourceFmNodeId: parseInt(edge.source, 10),
          targetFmNodeId: parseInt(edge.target, 10),
        });
        onInvalidateRef.current();
      } catch (err) {
        message.error(String((err as Error)?.message ?? 'Failed to delete propagation'));
      }
    }
  }, [removePropagation, message]);

  const handleEdgeContextMenu = useCallback(async (event: React.MouseEvent, edge: Edge) => {
    event.preventDefault();
    const { api: riacoreApi } = await import('../../../../../api/riacore');
    const selectedId = await riacoreApi.contextMenu.show([
      { id: 'deletePropagation', label: 'Delete Propagation' },
    ]);
    if (selectedId === 'deletePropagation') {
      try {
        await removePropagation.mutateAsync({
          sourceFmNodeId: parseInt(edge.source, 10),
          targetFmNodeId: parseInt(edge.target, 10),
        });
        onInvalidateRef.current();
      } catch (err) {
        message.error(String((err as Error)?.message ?? 'Failed to delete propagation'));
      }
    }
  }, [removePropagation, message]);

  // ── Loading / empty states ────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin tip="Loading propagation graph..." />
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
        <Empty description={emptyDescription} />
      </div>
    );
  }

  const internalCount = nodes.filter((n) => !n.isBoundary).length;
  const boundaryCount = nodes.filter((n) => n.isBoundary).length;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      style={{ flex: 1, minHeight: 0, position: 'relative', outline: 'none' }}
      role="img"
      aria-label={`Propagation diagram with ${internalCount} in-scope and ${boundaryCount} boundary malfunctions`}
      onMouseEnter={() => { isHoveredRef.current = true; }}
      onMouseLeave={() => { isHoveredRef.current = false; }}
    >
      {isError && (
        <Alert
          type="warning"
          message="Some propagation data could not be loaded"
          description={error?.message}
          showIcon
          closable
          style={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 10 }}
        />
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        onPaneClick={() => {
          selectedCanvasNodeRef.current = null;
          setSelectedCanvasNodeId(null);
        }}
        onNodeDragStop={handleNodeDragStop}
        onEdgesDelete={handleEdgesDelete}
        onEdgeContextMenu={handleEdgeContextMenu}
        onNodeContextMenu={handleNodeContextMenu as unknown as (event: React.MouseEvent, node: Node) => void}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        style={{ background: token.colorBgLayout }}
        deleteKeyCode="Delete"
      >
        {/* Top-right toolbar — search (when open) + manual layout refresh, kept on
            a single centered row so the controls stay vertically aligned. */}
        <Panel position="top-right" style={{ margin: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PropagationSearchPanel
              rfNodes={rfNodes}
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              searchMatchIndex={searchMatchIndex}
              searchMatchIds={searchMatchIds}
              onQueryChange={(q) => {
                setSearchQuery(q);
                setSearchMatchIndex(0);
              }}
              onIndexChange={setSearchMatchIndex}
              onClose={() => {
                setSearchOpen(false);
                setSearchQuery('');
              }}
              inputRef={searchInputRef}
            />

            {/* Manual layout refresh — auto-layout no longer fires on data changes */}
            <LayoutControls onRefresh={refreshLayout} fitTick={fitTick} />
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
