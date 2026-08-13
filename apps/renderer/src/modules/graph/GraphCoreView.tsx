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
import { useState, useRef, useCallback } from 'react';
import { Button, Input, Alert, Spin, theme, App } from 'antd';
import type { GraphNode, GraphEdge } from '@riacore/app-contracts';
import { api } from '../../api/riacore';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { DetailPanel } from './DetailPanel';
import { PredefinedQueryList } from './PredefinedQueryList';
import { mergeGraphElements, mergeRefreshResult } from './graphStyles';
import { resolveTemplate, type QueryTemplate } from './queryTemplates';

const { useToken } = theme;

const SIDEBAR_DEFAULT = 220;
const SIDEBAR_MIN     = 140;
const SIDEBAR_MAX     = 380;
const DETAIL_DEFAULT  = 280;
const DETAIL_MIN      = 180;
const DETAIL_MAX      = 560;

// ── Resize handle ─────────────────────────────────────────────────────────────

function ResizeHandle({
  getStartWidth,
  onResize,
  direction,
  min,
  max,
}: {
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
        width: 4,
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'transparent',
        transition: 'background 0.15s',
        zIndex: 1,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBorderSecondary; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    />
  );
}

// ── GraphCoreView ─────────────────────────────────────────────────────────────

interface GraphCoreViewProps {
  onBack: () => void;
}

export function GraphCoreView({ onBack }: GraphCoreViewProps) {
  const { token } = useToken();
  const { message } = App.useApp();

  // ── Panel widths ──
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [detailWidth, setDetailWidth]   = useState(DETAIL_DEFAULT);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const detailRef  = useRef<HTMLDivElement>(null);

  // ── Query state ──
  const [cypher, setCypher] = useState('');
  const [lastExecutedCypher, setLastExecutedCypher] = useState<string | null>(null);
  const [elements, setElements] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<GraphNode | GraphEdge | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [expandingNodeIds, setExpandingNodeIds] = useState<Set<string>>(new Set());

  const canvasRef = useRef<GraphCanvasHandle>(null);

  // ── Run handler ──
  const handleRun = useCallback(async () => {
    const trimmed = cypher.trim();
    if (!trimmed) {
      setError('Query cannot be empty');
      return;
    }
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
  }, [cypher]);

  // ── Expand handler ──
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
        setExpandingNodeIds((prev) => { const next = new Set(prev); next.delete(nodeId); return next; });
        setTruncated((prev) => prev || result.truncated);
        canvasRef.current?.mergeExpansion(newNodes, newEdges, nodeId);
        if (newNodes.length === 0) message.info('No further neighbors found for this node');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setExpandingNodeIds((prev) => { const next = new Set(prev); next.delete(nodeId); return next; });
      }
    },
    [elements, message],
  );

  // ── Refresh handler ──
  const handleRefresh = useCallback(async () => {
    if (lastExecutedCypher === null) return;
    setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      const baseResult = await api.graph.query(lastExecutedCypher);
      let merged = mergeRefreshResult(elements, baseResult);
      for (const nodeId of expandedNodeIds) {
        const node = merged.nodes.find((n) => n.id === nodeId);
        if (!node) continue;
        const expansionResult = await api.graph.expand(nodeId, node.label, node.properties);
        merged = mergeRefreshResult(merged, expansionResult);
      }
      setElements(merged);
      canvasRef.current?.refreshElements(merged.nodes, merged.edges);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [lastExecutedCypher, elements, expandedNodeIds]);

  // ── Template select — sets query and auto-runs ──
  const handleTemplateSelect = useCallback(
    (tpl: QueryTemplate, paramValue?: string) => {
      const resolved = resolveTemplate(tpl, paramValue);
      setCypher(resolved);
      (async () => {
        const trimmed = resolved.trim();
        if (!trimmed) return;
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
      })();
    },
    [],
  );

  const refreshDisabled = lastExecutedCypher === null || loading;

  // ── Render ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: token.colorBgLayout }}>
      {/* Error banner */}
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ borderRadius: 0 }}
        />
      )}

      {/* Three-column layout: sidebar | canvas | detail */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* Left sidebar — query templates */}
        <div
          ref={sidebarRef}
          style={{
            width: sidebarWidth,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 12px 6px',
              fontSize: 11,
              fontWeight: 600,
              color: token.colorTextSecondary,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              flexShrink: 0,
            }}
          >
            Query Templates
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <PredefinedQueryList onSelect={handleTemplateSelect} disabled={loading} />
          </div>
        </div>

        <ResizeHandle
          getStartWidth={() => sidebarRef.current?.offsetWidth ?? sidebarWidth}
          onResize={setSidebarWidth}
          direction="right"
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
        />

        {/* Center: query bar + canvas + status */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          {/* Query bar */}
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
            <a
              onClick={onBack}
              style={{ fontSize: 12, color: token.colorLink, cursor: 'pointer', whiteSpace: 'nowrap', paddingTop: 4 }}
            >
              ← Back
            </a>
            <Input.TextArea
              value={cypher}
              onChange={(e) => setCypher(e.target.value)}
              placeholder="Enter Cypher query…"
              autoSize={{ minRows: 1, maxRows: 6 }}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              disabled={loading}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void handleRun();
                }
              }}
            />
            <Button type="primary" onClick={handleRun} disabled={loading} loading={loading && !refreshing}>
              Run
            </Button>
            <Button onClick={handleRefresh} disabled={refreshDisabled} loading={refreshing}>
              Refresh
            </Button>
          </div>

          {/* Graph canvas */}
          <Spin spinning={loading} style={{ flex: 1, minHeight: 0, display: 'flex' }} wrapperClassName="graph-spin-wrapper">
            <GraphCanvas
              ref={canvasRef}
              nodes={elements.nodes}
              edges={elements.edges}
              expandedNodeIds={expandedNodeIds}
              expandingNodeIds={expandingNodeIds}
              onSelect={setSelected}
              onExpand={handleExpand}
            />
          </Spin>

          {/* Status bar */}
          <div
            style={{
              padding: '4px 12px',
              fontSize: 11,
              color: token.colorTextSecondary,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <span>{elements.nodes.length} nodes, {elements.edges.length} edges</span>
            {truncated && (
              <span style={{ color: token.colorWarning }}>⚠ Result truncated to display limits</span>
            )}
          </div>
        </div>

        <ResizeHandle
          getStartWidth={() => detailRef.current?.offsetWidth ?? detailWidth}
          onResize={setDetailWidth}
          direction="left"
          min={DETAIL_MIN}
          max={DETAIL_MAX}
        />

        {/* Right: detail panel */}
        <div ref={detailRef} style={{ width: detailWidth, flexShrink: 0 }}>
          <DetailPanel selected={selected} />
        </div>
      </div>
    </div>
  );
}
