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
import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Input, Alert, Layout, theme, App } from 'antd';
import type { GraphNode, GraphEdge } from '@riacore/app-contracts';
import { api } from '../../api/riacore';
import { GraphCanvas, type GraphCanvasHandle } from '../graph/GraphCanvas';
import { DetailPanel } from '../graph/DetailPanel';
import { mergeGraphElements, mergeRefreshResult } from '../graph/graphStyles';
import { type QueryTemplate, resolveTemplate } from '../graph/queryTemplates';
import { PredefinedQueryList } from './PredefinedQueryList';
import { useWorkspaceState, isDbOpen } from '../../hooks/useWorkspaceState';
import { useWorkspaceStatus } from '../../hooks/useWorkspaceStatus';

const { Sider, Content } = Layout;
const { useToken } = theme;

const SIDEBAR_DEFAULT = 220;
const SIDEBAR_MIN     = 140;
const SIDEBAR_MAX     = 380;
const DETAIL_DEFAULT  = 280;
const DETAIL_MIN      = 180;
const DETAIL_MAX      = 560;

/**
 * Drag handle using Pointer Capture so resizing stays locked to the handle
 * even when the cursor moves faster than the element.
 *
 * direction='right': dragging right increases width (left sidebar)
 * direction='left' : dragging left  increases width (right detail panel)
 */
function ResizeHandle({
  getStartWidth,
  onResize,
  direction,
  min,
  max,
}: {
  /** Called on pointerdown to capture the current panel width. */
  getStartWidth: () => number;
  onResize: (w: number) => void;
  direction: 'right' | 'left';
  min: number;
  max: number;
}) {
  const { token } = useToken();
  const ref = useRef<HTMLDivElement>(null);
  const startW = useRef(0);
  const startX = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      startW.current = getStartWidth();
      startX.current = e.clientX;
      el.setPointerCapture(e.pointerId);
    },
    [getStartWidth],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!ref.current?.hasPointerCapture(e.pointerId)) return;
      const delta = e.clientX - startX.current;
      const raw = direction === 'right' ? startW.current + delta : startW.current - delta;
      onResize(Math.min(max, Math.max(min, raw)));
    },
    [direction, min, max, onResize],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    ref.current?.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        width: 5,
        flexShrink: 0,
        cursor: 'col-resize',
        background: token.colorBorderSecondary,
        transition: 'background 0.15s',
        zIndex: 10,
        touchAction: 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorPrimary; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBorderSecondary; }}
    />
  );
}

export function GraphCoreWindowView() {
  const { token } = useToken();
  const { message } = App.useApp();
  const ws = useWorkspaceState();
  // isLoading is true only on the very first fetch (empty cache).
  // We use it to avoid blocking Run while the Graph-Core window's fresh
  // QueryClient is still fetching workspace/db status for the first time.
  const { isLoading: wsLoading } = useWorkspaceStatus();
  const statusLoading = wsLoading;

  // ── Workspace key ──
  const workspaceKey = ws.phase === 'no_workspace' ? null : ws.workingDir;
  const prevKeyRef = useRef<string | null | undefined>(undefined);

  // ── Query state ──
  const [cypher, setCypher] = useState('');
  const [lastExecutedCypher, setLastExecutedCypher] = useState<string | null>(null);
  const [elements, setElements] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<GraphNode | GraphEdge | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [expandingNodeIds, setExpandingNodeIds] = useState<Set<string>>(new Set());
  const canvasRef = useRef<GraphCanvasHandle>(null);

  // ── Panel state ──
  const [sidebarWidth, setSidebarWidth]       = useState(SIDEBAR_DEFAULT);
  const [detailWidth, setDetailWidth]         = useState(DETAIL_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed]   = useState(false);

  // ── Workspace-follow reset ──
  // Only reset when the workspace CHANGES from one open workspace to another (A→B)
  // or when it closes (A→null). Do NOT reset on the initial null→A transition
  // that happens when the window first loads and the status query resolves.
  useEffect(() => {
    const prev = prevKeyRef.current;
    prevKeyRef.current = workspaceKey;
    // Skip initial mount (undefined) and skip null→workspace transitions
    if (prev === undefined) return;
    if (prev === null) return; // null→A: workspace just became available, don't reset
    if (prev === workspaceKey) return; // no change
    // A→B or A→null: actual workspace change, reset everything
    setCypher('');
    setElements({ nodes: [], edges: [] });
    setLastExecutedCypher(null);
    setSelected(null);
    setError(null);
    setExpandedNodeIds(new Set());
    setExpandingNodeIds(new Set());
    setTruncated(false);
  }, [workspaceKey]);

  // ── Run (shared executor used by Run button, Ctrl+Enter, and template auto-run) ──
  const runQuery = useCallback(
    async (cypherText: string) => {
      if (!isDbOpen(ws) && !statusLoading) {
        void message.info('No workspace is open. Open a workspace in the main window first.');
        return;
      }
      const trimmed = cypherText.trim();
      if (!trimmed) { setError('Query cannot be empty'); return; }
      setLoading(true);
      setError(null);
      try {
        const result = await api.graph.query(trimmed);
        setElements({ nodes: result.nodes, edges: result.edges });
        setLastExecutedCypher(trimmed);
        setExpandedNodeIds(new Set());
        setExpandingNodeIds(new Set());
        setTruncated(result.truncated);
        canvasRef.current?.setElements(result.nodes, result.edges);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [ws.phase, statusLoading, message],
  );

  const handleRun = useCallback(() => { void runQuery(cypher); }, [runQuery, cypher]);

  // ── Expand ──
  const handleExpand = useCallback(
    async (nodeId: string, nodeLabel: string, properties: Record<string, unknown>) => {
      setExpandingNodeIds((prev) => new Set(prev).add(nodeId));
      try {
        const result = await api.graph.expand(nodeId, nodeLabel, properties);
        const merged = mergeGraphElements(elements, result);
        const existingNodeIds = new Set(elements.nodes.map((n) => n.id));
        const existingEdgeIds = new Set(elements.edges.map((e) => e.id));
        const newNodes = result.nodes.filter((n) => !existingNodeIds.has(n.id));
        const newEdges = result.edges.filter((e) => !existingEdgeIds.has(e.id));
        setElements(merged);
        setExpandedNodeIds((prev) => new Set(prev).add(nodeId));
        setExpandingNodeIds((prev) => { const s = new Set(prev); s.delete(nodeId); return s; });
        setTruncated((prev) => prev || result.truncated);
        canvasRef.current?.mergeExpansion(newNodes, newEdges, nodeId);
        if (newNodes.length === 0) void message.info('No further neighbors found for this node');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setExpandingNodeIds((prev) => { const s = new Set(prev); s.delete(nodeId); return s; });
      }
    },
    [elements, message],
  );

  // ── Hide node ──
  const handleHideNode = useCallback(
    (nodeId: string) => {
      // Remove the node and any edges that reference it from React state
      setElements((prev) => ({
        nodes: prev.nodes.filter((n) => n.id !== nodeId),
        edges: prev.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      }));
      // Also remove from expanded tracking
      setExpandedNodeIds((prev) => { const s = new Set(prev); s.delete(nodeId); return s; });
      setExpandingNodeIds((prev) => { const s = new Set(prev); s.delete(nodeId); return s; });
      // Clear selection if the hidden node was selected
      setSelected((prev) => {
        if (prev && 'label' in prev && prev.id === nodeId) return null;
        // Also clear if a connected edge was selected
        if (prev && 'source' in prev && (prev.source === nodeId || prev.target === nodeId)) return null;
        return prev;
      });
      // Remove from the Cytoscape canvas
      canvasRef.current?.removeNode(nodeId);
    },
    [],
  );

  // ── Refresh ──
  const handleRefresh = useCallback(async () => {
    if (lastExecutedCypher === null) return;
    setLoading(true);
    setError(null);
    try {
      const baseResult = await api.graph.query(lastExecutedCypher);
      let merged = mergeRefreshResult(elements, baseResult);
      for (const nodeId of expandedNodeIds) {
        const node = merged.nodes.find((n) => n.id === nodeId);
        if (!node) continue;
        const exp = await api.graph.expand(nodeId, node.label, node.properties);
        merged = mergeRefreshResult(merged, exp);
      }
      setElements(merged);
      canvasRef.current?.refreshElements(merged.nodes, merged.edges);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lastExecutedCypher, elements, expandedNodeIds]);

  // ── Template select — populate the query input AND auto-run ──
  const handleTemplateSelect = useCallback(
    (template: QueryTemplate, paramValue?: string) => {
      const resolved = resolveTemplate(template, paramValue);
      setCypher(resolved);
      void runQuery(resolved);
    },
    [runQuery],
  );

  const runDisabled     = (!isDbOpen(ws) && !statusLoading) || loading;
  const refreshDisabled = lastExecutedCypher === null || loading;

  // ── Render ──
  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>

      {/* ── Left sidebar ── */}
      <Sider
        collapsible
        collapsed={sidebarCollapsed}
        onCollapse={setSidebarCollapsed}
        collapsedWidth={0}
        width={sidebarWidth}
        theme="light"
        style={{
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'hidden',
          // Push the built-in trigger to the bottom
          display: 'flex',
          flexDirection: 'column',
        }}
        // Custom trigger: a small arrow tab on the right edge
        trigger={null}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 16px 6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: token.colorTextSecondary,
            }}
          >
            Query Templates
          </span>
        </div>

        {/* Scrollable template list */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          <PredefinedQueryList
            onSelect={handleTemplateSelect}
            disabled={ws.phase === 'no_workspace'}
          />
        </div>
      </Sider>

      {/* Left collapse toggle tab */}
      <div
        onClick={() => setSidebarCollapsed((c) => !c)}
        title={sidebarCollapsed ? 'Show templates' : 'Hide templates'}
        style={{
          width: 14,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorTextSecondary,
          fontSize: 10,
          userSelect: 'none',
          zIndex: 5,
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBgTextHover; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBgContainer; }}
      >
        {sidebarCollapsed ? '›' : '‹'}
      </div>

      {/* Resize handle (only visible when sidebar is open) */}
      {!sidebarCollapsed && (
        <ResizeHandle
          direction="right"
          getStartWidth={() => sidebarWidth}
          onResize={setSidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
        />
      )}

      {/* ── Main content ── */}
      <Layout style={{ overflow: 'hidden' }}>
        <Content
          style={{
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: token.colorBgLayout,
          }}
        >
          {/* Top bar */}
          <div
            style={{
              padding: '8px 12px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              background: token.colorBgContainer,
              flexShrink: 0,
            }}
          >
            <Input.TextArea
              value={cypher}
              onChange={(e) => setCypher(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl+Enter (or Cmd+Enter on macOS) runs the query
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void runQuery(cypher);
                }
              }}
              placeholder="Enter Cypher query… (Ctrl+Enter to run)"
              autoSize={false}
              style={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: 12,
                resize: 'vertical',
                minHeight: 32,
                maxHeight: 400,
              }}
              rows={2}
              disabled={loading}
            />
            <Button type="primary" onClick={handleRun} disabled={runDisabled} loading={loading}>
              Run
            </Button>
            <Button onClick={handleRefresh} disabled={refreshDisabled}>
              Refresh
            </Button>
          </div>

          {/* Error banner */}
          {error && (
            <Alert
              type="error"
              message={error}
              closable
              onClose={() => setError(null)}
              style={{ borderRadius: 0, flexShrink: 0 }}
            />
          )}

          {/* Canvas row */}
          <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>

            {/* Graph canvas — loading overlay instead of Spin wrapper so
                the canvas always fills its flex container */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                minWidth: 0,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {/* Canvas fills all available space */}
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <GraphCanvas
                  ref={canvasRef}
                  nodes={elements.nodes}
                  edges={elements.edges}
                  expandedNodeIds={expandedNodeIds}
                  expandingNodeIds={expandingNodeIds}
                  onSelect={setSelected}
                  onExpand={handleExpand}
                  onHideNode={handleHideNode}
                />
                {/* Loading overlay — sits on top of the canvas, doesn't affect layout */}
                {loading && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(0,0,0,0.35)',
                      zIndex: 5,
                    }}
                  >
                    <div style={{ color: '#fff', fontSize: 13 }}>Running query…</div>
                  </div>
                )}
              </div>

              {/* Status bar */}
              <div
                style={{
                  padding: '3px 12px',
                  fontSize: 11,
                  color: token.colorTextSecondary,
                  borderTop: `1px solid ${token.colorBorderSecondary}`,
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  background: token.colorBgContainer,
                  flexShrink: 0,
                }}
              >
                <span>{elements.nodes.length} nodes, {elements.edges.length} edges</span>
                {truncated && (
                  <span style={{ color: token.colorWarning }}>⚠ Result truncated</span>
                )}
              </div>
            </div>

            {/* Right resize handle (only when detail open) */}
            {!detailCollapsed && (
              <ResizeHandle
                direction="left"
                getStartWidth={() => detailWidth}
                onResize={setDetailWidth}
                min={DETAIL_MIN}
                max={DETAIL_MAX}
              />
            )}

            {/* Right detail panel */}
            <div
              style={{
                width: detailCollapsed ? 0 : detailWidth,
                flexShrink: 0,
                overflow: 'hidden',
                position: 'relative',
                zIndex: 1,
                transition: 'width 0.2s',
                borderLeft: detailCollapsed ? 'none' : `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              {!detailCollapsed && <DetailPanel selected={selected} />}
            </div>

            {/* Right collapse toggle tab */}
            <div
              onClick={() => setDetailCollapsed((c) => !c)}
              title={detailCollapsed ? 'Show details' : 'Hide details'}
              style={{
                width: 14,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                background: token.colorBgContainer,
                borderLeft: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextSecondary,
                fontSize: 10,
                userSelect: 'none',
                zIndex: 5,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBgTextHover; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBgContainer; }}
            >
              {detailCollapsed ? '‹' : '›'}
            </div>

          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
