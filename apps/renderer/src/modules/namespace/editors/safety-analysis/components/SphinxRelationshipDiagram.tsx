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
import { createElement, useEffect, useMemo, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Panel, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, Button, Spin, theme } from 'antd';
import { ApartmentOutlined, ReloadOutlined } from '@ant-design/icons';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import { useElementRelationships } from '../hooks/useElementRelationships';
import { useRelationshipTreeNavigation } from '../hooks/useRelationshipTreeNavigation';
import { useTreeDecorations } from '../hooks/useTreeDecorations';
import { getNodeDecoration, type NodeDecoration } from '../config/nodeTypeConfig';
import { useAsilPalette } from '../config/asilColors';
import type { ScopedTreeNavigator, SelectedTreeElement } from '../types';
import {
  buildSphinxRelationshipGraph, layoutSphinxRelationshipGraph, RELATIONSHIP_NODE_WIDTH,
  type RelationshipGraphNode, type RelationshipGraphEdge,
} from '../utils/sphinxRelationshipGraph';

interface RelationshipNodeData extends Record<string, unknown> {
  node: RelationshipGraphNode;
  decorations?: Record<string, NodeDecoration>;
  navigate: (target: SelectedTreeElement) => Promise<void>;
  onShowDetails?: () => void;
}

function RelationshipNode({ data }: NodeProps<Node<RelationshipNodeData>>) {
  const { token } = theme.useToken();
  const asilPalette = useAsilPalette();
  const { node, decorations, navigate, onShowDetails } = data;
  const element = node.element;
  const target = { nodeId: element.node_id, namespace: element.namespace, concept: element.concept, name: element.name };
  const decoration = getNodeDecoration(element.concept, decorations);
  const role = node.role === 'focus' ? 'Selected need' : node.role === 'incoming' ? 'Incoming' : 'Outgoing';
  const handleStyle = { opacity: 0, pointerEvents: 'none' as const };
  return (
    <div
      aria-label={`${role}: ${element.name}`}
      style={{ width: RELATIONSHIP_NODE_WIDTH, height: node.height, boxSizing: 'border-box', borderRadius: 8, background: token.colorBgContainer, border: `${node.role === 'focus' ? 2 : 1}px solid ${node.role === 'focus' ? token.colorInfo : token.colorBorder}`, padding: 12, color: token.colorText }}
    >
      <Handle type="target" id="in" position={Position.Left} style={handleStyle} />
      <Handle type="source" id="out" position={Position.Right} style={handleStyle} />
      <Handle type="source" id="self-out" position={Position.Top} style={{ ...handleStyle, left: '25%' }} />
      <Handle type="target" id="self-in" position={Position.Top} style={{ ...handleStyle, left: '75%' }} />
      <div style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 6 }}>
        {role}{node.bothDirections ? ' · linked both ways' : ''}
      </div>
      <ShowInTreeTrigger
        homeTarget={target}
        // Explicit callback prevents the trigger's cross-window fallback, even without a tree adapter.
        onNavigate={() => { void navigate(target); }}
        onShowDetails={node.role === 'focus' ? onShowDetails : undefined}
        wrapperStyle={{ display: 'flex', width: 'calc(100% - 20px)', alignItems: 'flex-start', gap: 8 }}
      >
        {createElement(decoration.icon, { style: { marginTop: 2, color: element.concept === 'malfunction' ? asilPalette.icon(element.asil) : decoration.color } } as Record<string, unknown>)}
        <span title={element.name} style={{ fontSize: 13, lineHeight: '19px', fontWeight: 600, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>{element.name}</span>
      </ShowInTreeTrigger>
      {element.identifier && element.identifier !== element.name && (
        <div title={element.identifier} style={{ fontSize: 11, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4 }}>{element.identifier}</div>
      )}
      <div title={`${element.namespace} · ${element.concept}`} style={{ fontSize: 11, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 6 }}>{element.namespace} · {element.concept}</div>
    </div>
  );
}

interface RelationshipEdgeData extends Record<string, unknown> {
  edge: RelationshipGraphEdge;
  labelWidth: number;
}

function RelationshipEdge(props: EdgeProps<Edge<RelationshipEdgeData>>) {
  const { token } = theme.useToken();
  const edge = props.data!.edge;
  const loopHeight = Math.max(80, edge.labels.length * 20 + 40);
  const [path, labelX, labelY] = edge.self
    ? [`M ${props.sourceX} ${props.sourceY} C ${props.sourceX} ${props.sourceY - loopHeight * 1.5}, ${props.targetX} ${props.targetY - loopHeight * 1.5}, ${props.targetX} ${props.targetY}`, (props.sourceX + props.targetX) / 2, props.sourceY - loopHeight] as const
    : getBezierPath(props);
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={{ stroke: token.colorTextSecondary, strokeWidth: 1.5 }} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          title={edge.labels.join('\n')}
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, maxWidth: props.data!.labelWidth, borderRadius: 4, padding: '3px 6px', background: token.colorBgLayout, color: token.colorText, fontFamily: token.fontFamilyCode, fontSize: 11, lineHeight: '18px', textAlign: 'center', overflowWrap: 'anywhere', pointerEvents: 'all' }}
        >
          {edge.labels.map(label => <div key={label}>{label}</div>)}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const NODE_TYPES = { relationship: RelationshipNode };
const EDGE_TYPES = { relationship: RelationshipEdge };
type DiagramNode = Node<RelationshipNodeData>;

export interface SphinxRelationshipDiagramProps {
  selectedTreeElement: SelectedTreeElement;
  workspaceKey: string | null;
  onShowInTree?: ScopedTreeNavigator;
  onShowDetails?: () => void;
}

export function SphinxRelationshipDiagram(props: SphinxRelationshipDiagramProps) {
  return <ReactFlowProvider key={`${props.workspaceKey}:${props.selectedTreeElement.namespace}:${props.selectedTreeElement.nodeId}`}><RelationshipCanvas {...props} /></ReactFlowProvider>;
}

function RelationshipCanvas({ selectedTreeElement, workspaceKey, onShowInTree, onShowDetails }: SphinxRelationshipDiagramProps) {
  const { token } = theme.useToken();
  const query = useElementRelationships(selectedTreeElement.nodeId, workspaceKey);
  const decorations = useTreeDecorations();
  const navigate = useRelationshipTreeNavigation(onShowInTree);
  const { fitBounds, getNodes } = useReactFlow<DiagramNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<DiagramNode>([]);
  const [edges, setEdges] = useState<Edge<RelationshipEdgeData>[]>([]);
  const [revision, setRevision] = useState(0);
  const [layout, setLayout] = useState<{ graph: ReturnType<typeof buildSphinxRelationshipGraph>; result: Awaited<ReturnType<typeof layoutSphinxRelationshipGraph>> } | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const initialized = useNodesInitialized();
  const graph = useMemo(() => buildSphinxRelationshipGraph(selectedTreeElement, query.data ?? []), [selectedTreeElement, query.data]);

  useEffect(() => {
    let cancelled = false;
    if (!query.available || !query.data) return;
    setLayoutError(false);
    void layoutSphinxRelationshipGraph(graph).then(result => {
      if (!cancelled) setLayout({ graph, result });
    }).catch(() => { if (!cancelled) setLayoutError(true); });
    return () => { cancelled = true; };
  }, [graph, query.available, query.data, revision]);

  useEffect(() => {
    if (!layout || layout.graph !== graph) return;
    setNodes(graph.nodes.map(node => ({
      id: node.id, type: 'relationship', position: layout.result.positions.get(node.id)!,
      width: RELATIONSHIP_NODE_WIDTH, height: node.height,
      data: { node, decorations, navigate, onShowDetails },
    })));
    setEdges(graph.edges.map(edge => ({
      id: edge.id, type: 'relationship', source: edge.source, target: edge.target,
      sourceHandle: edge.self ? 'self-out' : 'out', targetHandle: edge.self ? 'self-in' : 'in',
      markerEnd: { type: MarkerType.ArrowClosed, color: token.colorTextSecondary },
      data: { edge, labelWidth: graph.gap - 24 },
    })));
  }, [graph, layout, decorations, navigate, onShowDetails, setNodes, token.colorTextSecondary]);

  useEffect(() => {
    if (!initialized || !layout || layout.graph !== graph) return;
    const frame = requestAnimationFrame(() => {
      const current = getNodes();
      if (!current.length) return;
      const self = graph.edges.find(edge => edge.self);
      const loopTop = self ? -Math.max(80, self.labels.length * 20 + 40) - 30 : Infinity;
      const left = Math.min(...current.map(node => node.position.x));
      const y = Math.min(loopTop, ...current.map(node => node.position.y));
      const right = Math.max(...current.map(node => node.position.x + RELATIONSHIP_NODE_WIDTH));
      const bottom = Math.max(...current.map(node => node.position.y + node.data.node.height));
      // Keep the focus in the center column even when only one direction has partners.
      const halfWidth = Math.max(RELATIONSHIP_NODE_WIDTH / 2 - left, right - RELATIONSHIP_NODE_WIDTH / 2);
      void fitBounds({ x: RELATIONSHIP_NODE_WIDTH / 2 - halfWidth, y, width: halfWidth * 2, height: bottom - y }, { padding: 0.2, duration: 150 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, layout, graph, fitBounds, getNodes]);

  if (!query.available) return <Alert type="info" title="Open a workspace to view relationships" />;
  if (query.isLoading) return <div style={{ margin: 'auto' }}><Spin description="Loading relationships" /></div>;
  if (query.isError && !query.data) return <Alert type="error" title="Could not load relationships" description={query.error.message} action={<Button onClick={() => { void query.refetch(); }}>Retry</Button>} />;
  if (layoutError) return <Alert type="error" title="Could not lay out relationships" action={<Button onClick={() => setRevision(value => value + 1)}>Retry</Button>} />;

  return (
    <div aria-label="Sphinx need relationships" style={{ position: 'relative', flex: 1, width: '100%', height: '100%', minHeight: 240 }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange} nodesConnectable={false} edgesReconnectable={false} elementsSelectable={false}
        colorMode="system" minZoom={0.05} maxZoom={2} panOnDrag zoomOnScroll
        proOptions={{ hideAttribution: true }} style={{ background: token.colorBgLayout }}
      >
        <Background gap={18} size={1} color={token.colorBorderSecondary} />
        <Controls showInteractive={false} />
        <Panel position="top-left">
          <div style={{ color: token.colorTextSecondary, background: token.colorBgLayout, padding: '4px 8px', fontSize: 12 }}>
            {query.data?.length === 0 ? 'No relationships stored for this element' : 'Incoming → Selected need → Outgoing'}
          </div>
          {query.isError && <Alert type="error" title="Could not refresh relationships" description={query.error.message} />}
          {layout?.result.mode === 'grid-fallback' && <Alert type="info" title="Showing a simplified layout" />}
        </Panel>
        <Panel position="bottom-right">
          <div style={{ display: 'flex', gap: 6 }}>
            <Button aria-label="Refresh relationships" size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh relationships</Button>
            <Button aria-label="Auto Layout" size="small" icon={<ApartmentOutlined />} onClick={() => setRevision(value => value + 1)}>Auto Layout</Button>
          </div>
        </Panel>
      </ReactFlow>
      {(!layout || layout.graph !== graph) && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: token.colorBgLayout }}><Spin description="Calculating layout" /></div>}
    </div>
  );
}
