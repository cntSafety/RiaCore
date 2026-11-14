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
 * "Model" lens for any CGraph element: a rollup of the selected element's
 * cross-boundary relationships to its sibling elements, in the spirit of a
 * deployment/component diagram rather than the one-hop tree the
 * "Relationships" tab shows. See `AggregatedRelationshipsResult`.
 *
 * What a rollup means depends on where the element sits. For a container
 * (`c_component`, `c_file`) the subtree is everything it owns, so partners are
 * peer modules — an architecture view. For a leaf (`c_function`, `c_variable`,
 * a named type) the subtree is just the element and its parameters, so the
 * partners are its own callers, callees, accessors and types — a neighbourhood
 * view. Both come from the same backend rollup; only the depth differs.
 *
 * Two independent controls shape the drawing.
 *
 * **Depth** decides what is in it. **Depth 1** is a flat star: one box per
 * partner, one edge carrying the whole count. It answers "who calls this and
 * what does it call". **Depth 2 and above** draw containment as geometry: each partner's own
 * container becomes a frame, and the edge ends at the element inside it that the
 * relationship actually reaches. That answers the question the flat view cannot
 * — not "`BSw` calls `CDD_ADS_NEW` ten times" but which file in each — at the
 * cost of a count that is relative to the depth it was computed at, which the
 * canvas banner says.
 *
 * **Layout** decides how it is arranged. `radial` — the default — centres the
 * selection and distributes partners on rings around it. `layered` is ELK's
 * layered algorithm, which resolves a star into incoming / selection /
 * outgoing columns. See `cgraphRadialLayout` for why the default changed.
 *
 * Both, plus the relationship filter, are remembered for the session: per
 * element so returning to one shows what it was left at, and as a session
 * preference so stepping to a *new* element keeps the choice just made. The
 * canvas remounts on every selection change, so without that the controls
 * returned to their defaults exactly when a reader was walking a chain of
 * elements at a depth they had chosen.
 *
 * Containment itself is never an edge at any depth: the backend drops
 * containment relationships before grouping, and above depth 1 the same
 * relation is carried by a box's position inside its frame.
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Panel,
  Position, ReactFlow, ReactFlowProvider, getStraightPath, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, Button, Checkbox, Dropdown, Segmented, Spin, theme } from 'antd';
import { ApartmentOutlined, CloseOutlined, FilterOutlined, ReloadOutlined } from '@ant-design/icons';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import { useAggregatedRelationships } from '../hooks/useAggregatedRelationships';
import { loadedExpansions, useExpandedRelationships } from '../hooks/useExpandedRelationships';
import { useRelationshipTreeNavigation } from '../hooks/useRelationshipTreeNavigation';
import { useTreeDecorations } from '../hooks/useTreeDecorations';
import { getNodeDecoration, type NodeDecoration } from '../config/nodeTypeConfig';
import type { ScopedTreeNavigator, SelectedTreeElement } from '../types';
import {
  AGGREGATION_ARROW_SIZE, AGGREGATION_DEPTHS,
  AGGREGATION_EDGE_WIDTH, AGGREGATION_FRAME_HEADER, AGGREGATION_HANDLE,
  AGGREGATION_NODE_WIDTH, CATEGORY_COLOR, CATEGORY_DASH, CATEGORY_LABEL, CATEGORY_ORDER,
  aggregationEdgeHandles, aggregationLabelFraction, aggregationNodeSize, buildCGraphAggregationGraph,
  layoutCGraphAggregationGraph, resolveAggregationView, totalCount,
  type AggregationGraphEdge, type AggregationGraphNode, type AggregationLayoutMode, type RelationshipCategory,
} from '../utils/cgraphAggregationGraph';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';

interface ContainerNodeData extends Record<string, unknown> {
  node: AggregationGraphNode;
  /** The laid-out size. A leaf's is the fixed constant; a frame's is whatever the layout grew it to. */
  size: { width: number; height: number };
  /** Metamodel icon overlay, so a box carries the glyph the tree gives its concept. */
  decorations?: Record<string, NodeDecoration>;
  navigate: (target: SelectedTreeElement) => Promise<void>;
  onShowDetails?: () => void;
  /** Merge this element's own rollup into the diagram. Absent for the selection, which is already the rollup root. */
  onExpand?: (nodeId: number) => void;
  /** Drop a previously merged rollup. */
  onCollapse?: (nodeId: number) => void;
}

/** Menu id for the expansion actions. Namespaced, since `ShowInTreeTrigger` reserves its own. */
const EXPAND_ITEM_ID = 'cgraph.expandRelationships';
const COLLAPSE_ITEM_ID = 'cgraph.collapseRelationships';

/**
 * The expansion entries for one box's context menu.
 *
 * Offered on every box except the selection, which is already the root of its
 * own rollup — expanding it would merge the payload the diagram is built from
 * back into itself. An already-expanded box is offered the collapse instead, so
 * the one entry always describes a change rather than a state.
 *
 * Exported with {@link EXPAND_ITEM_ID} for its own test: the menu itself is an
 * Electron call, so the contract worth pinning is which entries a given box
 * offers.
 */
export function expansionMenuItems(node: AggregationGraphNode): { id: string; label: string }[] {
  if (node.isRoot) return [];
  return node.isExpansionRoot
    ? [{ id: COLLAPSE_ITEM_ID, label: 'Collapse relationships' }]
    : [{ id: EXPAND_ITEM_ID, label: 'Expand relationships' }];
}

/** Dispatch a chosen expansion entry. Returns whether the id was one of ours. */
function handleExpansionItem(id: string, data: ContainerNodeData): boolean {
  const nodeId = data.node.container.node_id;
  if (id === EXPAND_ITEM_ID) { data.onExpand?.(nodeId); return true; }
  if (id === COLLAPSE_ITEM_ID) { data.onCollapse?.(nodeId); return true; }
  return false;
}

export { EXPAND_ITEM_ID, COLLAPSE_ITEM_ID };

/**
 * All eight anchors, on every box: both roles on all four borders.
 *
 * Which pair an edge uses is decided per edge from the laid-out geometry
 * (`aggregationEdgeHandles`), so every box has to offer every side for both
 * roles — in the radial layout a peer is as often above or below as beside.
 * They stay invisible and inert: nothing in this diagram is connectable by hand.
 */
function NodeAnchors() {
  const handleStyle = { opacity: 0, pointerEvents: 'none' as const };
  return (
    <>
      <Handle type="target" id={AGGREGATION_HANDLE.targetWest} position={Position.Left} style={handleStyle} />
      <Handle type="target" id={AGGREGATION_HANDLE.targetEast} position={Position.Right} style={handleStyle} />
      <Handle type="target" id={AGGREGATION_HANDLE.targetNorth} position={Position.Top} style={handleStyle} />
      <Handle type="target" id={AGGREGATION_HANDLE.targetSouth} position={Position.Bottom} style={handleStyle} />
      <Handle type="source" id={AGGREGATION_HANDLE.sourceEast} position={Position.Right} style={handleStyle} />
      <Handle type="source" id={AGGREGATION_HANDLE.sourceWest} position={Position.Left} style={handleStyle} />
      <Handle type="source" id={AGGREGATION_HANDLE.sourceNorth} position={Position.Top} style={handleStyle} />
      <Handle type="source" id={AGGREGATION_HANDLE.sourceSouth} position={Position.Bottom} style={handleStyle} />
    </>
  );
}

/**
 * What a box is to the selected element, for assistive technology only.
 *
 * It used to be printed above the name as well. Dropping that line costs
 * nothing a sighted reader had: the selected element is the one box with a
 * primary border and a tinted title, and every other box is a partner by
 * definition — the diagram has no third kind. The word was repeated on every
 * box to say something true of all but one of them.
 */
function roleLabel(node: AggregationGraphNode): string {
  if (node.isRoot) return 'Selected';
  return node.isExpansionRoot ? 'Expanded partner' : 'Partner';
}

/**
 * A box's border, which carries its role.
 *
 * Solid primary for the selection, dashed info for an element the reader
 * expanded, plain otherwise. Dashed rather than a second solid colour because
 * the distinction being drawn is not "more important" but "this box is showing
 * its own relationships as well as the selection's" — and because a box can
 * never be both, the two heavy borders cannot be confused in the same diagram.
 */
function expansionBorder(
  node: AggregationGraphNode,
  token: { colorPrimary: string; colorInfo: string; colorBorder: string },
): { border: string; borderStyle?: 'dashed' } {
  if (node.isRoot) return { border: `2px solid ${token.colorPrimary}` };
  if (node.isExpansionRoot) return { border: `2px dashed ${token.colorInfo}` };
  return { border: `1px solid ${token.colorBorder}` };
}

/**
 * The concept icon the tree would draw for this element.
 *
 * Read through the same `getNodeDecoration` + metamodel overlay the tree and
 * the Sphinx diagram use, rather than a local table: CGraph declares
 * `rendering:` for all its concepts in LinkML, so the folder, file and function
 * glyphs already exist and the only way to get a different one here would be to
 * reimplement the lookup and then drift from it.
 */
function ConceptIcon({ concept, decorations, size }: { concept: string; decorations?: Record<string, NodeDecoration>; size: number }) {
  const decoration = getNodeDecoration(concept, decorations);
  return createElement(decoration.icon, {
    style: { color: decoration.color, fontSize: size, flexShrink: 0 },
  } as Record<string, unknown>);
}

function NodeTitle({ data, clampLines }: { data: ContainerNodeData; clampLines: number }) {
  const { token } = theme.useToken();
  const { node, decorations, navigate, onShowDetails } = data;
  const { container } = node;
  const target = { nodeId: container.node_id, namespace: container.namespace, concept: container.concept, name: container.name };
  return (
    <>
      <ShowInTreeTrigger
        homeTarget={target}
        onNavigate={() => { void navigate(target); }}
        onShowDetails={node.isRoot ? onShowDetails : undefined}
        extraItems={expansionMenuItems(node)}
        onExtraItem={(id) => { handleExpansionItem(id, data); }}
        wrapperStyle={{ display: 'block' }}
        // Every action behind it — "Show in Tree", "Show details" — is on the
        // right-click menu, so the hover button only added a control that
        // overlapped the name it belonged to.
        hideKebab
      >
        <span title={container.name} style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: clampLines, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>{container.name}</span>
      </ShowInTreeTrigger>
      {/*
        * Concept only. The namespace was the same string on every box in the
        * diagram — the rollup does not cross namespaces — so it was a constant
        * taking up the one line that could have carried the type legibly.
        */}
      <div
        title={`${container.concept} — ${container.namespace}`}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: token.colorTextSecondary, marginTop: 4, overflow: 'hidden' }}
      >
        <ConceptIcon concept={container.concept} decorations={decorations} size={12} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{container.concept}</span>
      </div>
    </>
  );
}

function ContainerNode({ data }: NodeProps<Node<ContainerNodeData>>) {
  const { token } = theme.useToken();
  const { node } = data;
  return (
    <div
      aria-label={`${roleLabel(node)}: ${node.container.name}`}
      style={{
        width: AGGREGATION_NODE_WIDTH, boxSizing: 'border-box', borderRadius: 8, padding: 12,
        background: node.isRoot ? token.colorPrimaryBg : token.colorBgContainer,
        color: token.colorText,
        ...expansionBorder(node, token),
      }}
    >
      <NodeAnchors />
      <NodeTitle data={data} clampLines={2} />
    </div>
  );
}

/**
 * A box with visible children: the container drawn *around* the things inside
 * it, which is how this layout shows containment.
 *
 * Its initial size is the layout's — the frame was grown to fit its children —
 * and the element fills the node's *live* size rather than sizing itself from
 * its content. Live, not `data.size`: a child dragged past the border grows the
 * frame (`expandParent`), React Flow sets the new width/height on the node, and
 * the element has to follow so its measured size changes too. That
 * measurement is what lets the frame above it grow in turn; a frame pinned to
 * `data.size` would stop the growth one level up. Only the title row can be clicked: the rest of the
 * frame belongs to its children, and a full-bleed hit target would swallow
 * their own triggers.
 *
 * The body is one of antd's near-transparent fill tokens rather than a surface
 * colour, including for the root, where the selection is carried by the border
 * and the title row instead. React Flow draws edges beneath nodes, and a frame
 * *is* a node, so an opaque body hides every route that crosses it — which at
 * this depth is most of them, since the boxes the routes connect are inside
 * frames. Raising the edges above the nodes instead would put them over the
 * leaf boxes and their text.
 */
function FrameNode({ data, width, height }: NodeProps<Node<ContainerNodeData>>) {
  const { token } = theme.useToken();
  const { node, size } = data;
  const { container } = node;
  const target = { nodeId: container.node_id, namespace: container.namespace, concept: container.concept, name: container.name };
  return (
    <div
      aria-label={`${roleLabel(node)} container: ${node.container.name}`}
      style={{
        width: width ?? size.width, height: height ?? size.height, boxSizing: 'border-box', borderRadius: 10,
        background: token.colorFillQuaternary,
        color: token.colorText,
        ...expansionBorder(node, token),
      }}
    >
      <NodeAnchors />
      <div
        style={{
          height: AGGREGATION_FRAME_HEADER, boxSizing: 'border-box', padding: '4px 12px',
          display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden',
          background: node.isRoot ? token.colorPrimaryBg : token.colorBgContainer,
          borderBottom: `1px solid ${node.isRoot ? token.colorPrimary : token.colorBorderSecondary}`,
          borderRadius: '8px 8px 0 0',
        }}
      >
        {/*
          * A frame has one row and no room for a separate type line, so the
          * icon carries the concept here — which is also how a tree row reads.
          */}
        <ConceptIcon concept={container.concept} decorations={data.decorations} size={14} />
        <ShowInTreeTrigger
          homeTarget={target}
          onNavigate={() => { void data.navigate(target); }}
          onShowDetails={node.isRoot ? data.onShowDetails : undefined}
          extraItems={expansionMenuItems(node)}
          onExtraItem={(id) => { handleExpansionItem(id, data); }}
          wrapperStyle={{ display: 'block', minWidth: 0, overflow: 'hidden' }}
          hideKebab
        >
          <span
            title={`${container.name} — ${container.namespace} · ${container.concept}`}
            style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}
          >
            {container.name}
          </span>
        </ShowInTreeTrigger>
      </div>
    </div>
  );
}

interface AggregationEdgeData extends Record<string, unknown> {
  edge: AggregationGraphEdge;
}

/**
 * One hairline per container pair, straight from border to border, with the
 * relationship and its count printed on it.
 *
 * Straight rather than bezier. A curve is worth its ambiguity when it has to
 * get around something, which is what a layered diagram's routes do. Here the
 * handle pair is already chosen from the geometry so that the two borders face
 * each other, which makes the direct segment the shortest path *and* the one
 * that leaves and arrives perpendicular to the borders — a bezier through the
 * same two points only bows away from it, and a bundle of them bowing by
 * different amounts between the same two boxes is what made the earlier
 * drawing hard to trace.
 *
 * Nothing about the line encodes the count: the count is text, and
 * {@link AGGREGATION_EDGE_WIDTH} explains why it is only text.
 */
function AggregationEdge(props: EdgeProps<Edge<AggregationEdgeData>>) {
  const { token } = theme.useToken();
  const edge = props.data!.edge;
  const dominant = edge.segments[0]?.category ?? 'other';
  const [path] = getStraightPath(props);
  // Not the midpoint `getStraightPath` also returns: an edge whose opposite
  // direction is drawn too shares its whole line with it, so both labels would
  // be placed at the same point. See `aggregationLabelFraction`.
  const fraction = aggregationLabelFraction(edge);
  const labelX = props.sourceX + (props.targetX - props.sourceX) * fraction;
  const labelY = props.sourceY + (props.targetY - props.sourceY) * fraction;
  const labels = edge.segments.map((segment) => `${segment.relationship} ×${segment.count}`);
  return (
    <>
      <BaseEdge
        id={props.id} path={path} markerEnd={props.markerEnd}
        style={{ stroke: CATEGORY_COLOR[dominant], strokeWidth: AGGREGATION_EDGE_WIDTH, strokeDasharray: CATEGORY_DASH[dominant] }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          title={`${labels.join('\n')}\n\u2014\n${totalCount(edge)} total`}
          style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            // Sized to its content, with a cap. It used to wrap mid-word at
            // 220px, which turned `takes_address_of ×1` into two lines and so
            // tripled a three-relationship label's height — and its height is
            // what it collides with. CGraph's relationship names are a fixed
            // slot list whose longest is 16 characters, so the cap is only a
            // guard against an unknown name from another importer.
            width: 'max-content', maxWidth: 320, overflow: 'hidden',
            borderRadius: 4, padding: '2px 6px',
            background: token.colorBgLayout, color: token.colorText,
            // A border so two labels that still end up adjacent read as two
            // boxes rather than as one block of mixed text.
            border: `1px solid ${token.colorBorderSecondary}`,
            fontFamily: token.fontFamilyCode, fontSize: 11, lineHeight: '15px',
            textAlign: 'center', whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'all',
          }}
        >
          {edge.segments.map((segment) => (
            <div key={segment.relationship} style={{ color: CATEGORY_COLOR[segment.category] }}>{segment.relationship} ×{segment.count}</div>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const NODE_TYPES = { container: ContainerNode, frame: FrameNode };
const EDGE_TYPES = { aggregation: AggregationEdge };
type DiagramNode = Node<ContainerNodeData>;

/**
 * Containment depth selector.
 *
 * Depth 1 is the flat rollup the lens has always drawn: one box per module, one
 * edge carrying the whole count. Each further level asks the backend to report
 * both ends of every edge one containment step deeper and draws the containers
 * above them as frames, which answers the question depth 1 cannot — not "`BSw`
 * calls `CDD_ADS_NEW` ten times" but *which file* in each.
 *
 * A separate control rather than a replacement, because the two answer
 * different questions and depth 1 stays much the cheaper query: it visits one
 * ancestor chain per partner, where depth 3 keeps the whole chain and draws a
 * box for every element on it.
 *
 * Exported for its own test, for the same reason `CategoryFilter` is — direct
 * rendering keeps the test off the ReactFlow canvas.
 */
export function DepthControl({ depth, onChange }: { depth: number; onChange: (next: number) => void }) {
  const { token } = theme.useToken();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: token.colorBgLayout, borderRadius: token.borderRadius, padding: '0 6px' }}>
      <span style={{ fontSize: 11, color: token.colorTextSecondary }}>Depth</span>
      <Segmented
        size="small"
        value={depth}
        onChange={(value) => onChange(Number(value))}
        options={AGGREGATION_DEPTHS.map((level) => ({
          value: level,
          label: String(level),
          title: level === 1
            ? 'Flat rollup — one box per sibling element'
            : `Nest ${level - 1} level${level > 2 ? 's' : ''} deeper — show which contained element each relationship reaches.`
              + ' Reduced automatically if the result would be too large to draw.',
        }))}
        aria-label={`Containment depth — ${depth} of ${AGGREGATION_DEPTHS[AGGREGATION_DEPTHS.length - 1]}`}
      />
    </span>
  );
}

/**
 * Arrangement selector.
 *
 * Radial is the default because it is what this graph's shape asks for: every
 * partner relates to the selection and to nothing else, so a ring distributes
 * them over a square canvas where a layered algorithm resolves the same star
 * into three columns and grows in one direction only. Layered stays available
 * for the reading order it gives — callers on the left, callees on the right —
 * and because it is the crossing-aware one of the two.
 *
 * Exported for its own test, like the other two controls, so the test does not
 * have to mount the ReactFlow canvas.
 */
export function LayoutModeControl({ mode, onChange }: { mode: AggregationLayoutMode; onChange: (next: AggregationLayoutMode) => void }) {
  const { token } = theme.useToken();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: token.colorBgLayout, borderRadius: token.borderRadius, padding: '0 6px' }}>
      <span style={{ fontSize: 11, color: token.colorTextSecondary }}>Layout</span>
      <Segmented
        size="small"
        value={mode}
        onChange={(value) => onChange(value as AggregationLayoutMode)}
        options={[
          { value: 'radial' satisfies AggregationLayoutMode, label: 'Radial', title: 'Selected element at the centre, partners distributed on rings around it.' },
          { value: 'layered' satisfies AggregationLayoutMode, label: 'Layered', title: 'Incoming partners on the left, the selected element in the middle, outgoing on the right.' },
        ]}
        aria-label={`Layout — ${mode}`}
      />
    </span>
  );
}

export interface CGraphAggregationDiagramProps {
  selectedTreeElement: SelectedTreeElement;
  workspaceKey: string | null;
  onShowInTree?: ScopedTreeNavigator;
  onShowDetails?: () => void;
}

export function CGraphAggregationDiagram(props: CGraphAggregationDiagramProps) {
  return <ReactFlowProvider key={`${props.workspaceKey}:${props.selectedTreeElement.namespace}:${props.selectedTreeElement.nodeId}`}><AggregationCanvas {...props} /></ReactFlowProvider>;
}

/**
 * Category filter, collapsed into a dropdown beside the canvas buttons.
 *
 * It was an always-open checkbox column, which on a short canvas covered a
 * meaningful share of the diagram it was filtering. Checkboxes are kept inside
 * the dropdown rather than swapped for a Menu's selected-row highlight: the
 * colour swatch next to each label is the legend for the edge colours, so the
 * list has to show all four categories whether or not they are active.
 *
 * The trigger carries the active count, so the collapsed state still says
 * whether anything is filtered out — otherwise an empty diagram and a
 * filtered-to-nothing diagram look identical.
 *
 * Exported for its own test: rendering it directly keeps that test off the
 * ReactFlow canvas, which would otherwise have to be mocked wholesale.
 */
export function CategoryFilter({ active, onChange }: { active: ReadonlySet<RelationshipCategory>; onChange: (next: Set<RelationshipCategory>) => void }) {
  const { token } = theme.useToken();
  const total = CATEGORY_ORDER.length;
  return (
    <Dropdown
      trigger={['click']}
      // The panel sits at the bottom of the canvas, so the list opens upward.
      placement="topRight"
      menu={{ items: [] }}
      dropdownRender={() => (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            background: token.colorBgElevated,
            borderRadius: token.borderRadius,
            boxShadow: token.boxShadowSecondary,
            padding: '8px 12px',
          }}
        >
          <span style={{ fontSize: 11, color: token.colorTextSecondary }}>Show relationships</span>
          {CATEGORY_ORDER.map((category) => (
            <Checkbox
              key={category}
              checked={active.has(category)}
              onChange={(event) => {
                const next = new Set(active);
                if (event.target.checked) next.add(category); else next.delete(category);
                onChange(next);
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: CATEGORY_COLOR[category], display: 'inline-block' }} />
                {CATEGORY_LABEL[category]}
              </span>
            </Checkbox>
          ))}
        </div>
      )}
    >
      <Button
        size="small"
        icon={<FilterOutlined />}
        aria-label={`Show relationships — ${active.size} of ${total} categories shown`}
      >
        {`Relationships ${active.size}/${total}`}
      </Button>
    </Dropdown>
  );
}

function AggregationCanvas({ selectedTreeElement, workspaceKey, onShowInTree, onShowDetails }: CGraphAggregationDiagramProps) {
  const { token } = theme.useToken();
  const rememberView = useWorkspaceStore((s) => s.setCGraphView);
  /*
   * Seeded once, from the session view, and never resynced — the canvas already
   * remounts per element (its `ReactFlowProvider` is keyed on one), so the
   * remount *is* the mechanism that carries the settings to the next element.
   * A store→local sync effect would additionally fight the user: writing a
   * control's new value back through the store and into the same control.
   *
   * Read imperatively rather than through a selector for that same reason —
   * subscribing would re-render the canvas on each of its own writes.
   */
  const [initialView] = useState(() =>
    resolveAggregationView(useWorkspaceStore.getState().cgraphView),
  );
  const [depth, setDepth] = useState<number>(initialView.depth);
  const [layoutMode, setLayoutMode] = useState<AggregationLayoutMode>(initialView.layoutMode);
  /**
   * Elements whose own rollups are merged in, in the order they were expanded.
   *
   * Not remembered across a selection change: the canvas remounts per element,
   * and an expansion is a position *within* one element's diagram rather than a
   * preference. It is also not in the store, unlike the three controls — the
   * boxes it adds are only meaningful next to the arrangement they were placed
   * into, and that arrangement does not survive the remount either.
   */
  const [expansions, setExpansions] = useState<number[]>([]);
  /** The most recent expansion, which is where new boxes are placed. */
  const [anchorNodeId, setAnchorNodeId] = useState<number | null>(null);
  const query = useAggregatedRelationships(selectedTreeElement.nodeId, workspaceKey, depth);
  const expansionQueries = useExpandedRelationships(expansions, workspaceKey, depth);
  const decorations = useTreeDecorations();
  const navigate = useRelationshipTreeNavigation(onShowInTree);
  const { fitBounds } = useReactFlow<DiagramNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<DiagramNode>([]);
  const [edges, setEdges] = useState<Edge<AggregationEdgeData>[]>([]);
  const [revision, setRevision] = useState(0);
  const [activeCategories, setActiveCategories] = useState<Set<RelationshipCategory>>(initialView.categories);
  // `mode` is part of the identity of a result, not only of the request that
  // produced it: a radial result would place the boxes a layered canvas is
  // waiting for, so the render below has to wait for the matching one.
  const [layout, setLayout] = useState<{ graph: ReturnType<typeof buildCGraphAggregationGraph>; mode: AggregationLayoutMode; result: Awaited<ReturnType<typeof layoutCGraphAggregationGraph>> } | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const initialized = useNodesInitialized();
  /*
   * `useQueries` hands back a fresh array every render, so the graph is
   * memoised on a signature of what has actually been read rather than on the
   * array's identity. `dataUpdatedAt` moves only when a result does, which is
   * exactly the condition for rebuilding — and a stable identity for the graph
   * matters more here than usual, because the layout effect keys off it.
   */
  const expansionSignature = expansionQueries.map((entry, index) => `${expansions[index]}:${entry.dataUpdatedAt}`).join(',');
  const graph = useMemo(
    () => {
      if (!query.data) return { nodes: [], edges: [], rootId: '' };
      return buildCGraphAggregationGraph([query.data, ...loadedExpansions(expansionQueries)], activeCategories);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `expansionSignature` stands in for the query array's contents.
    [query.data, expansionSignature, activeCategories],
  );

  const expand = useCallback((nodeId: number) => {
    setAnchorNodeId(nodeId);
    setExpansions((current) => current.includes(nodeId) ? current : [...current, nodeId]);
  }, []);
  const collapse = useCallback((nodeId: number) => {
    setExpansions((current) => current.filter((id) => id !== nodeId));
  }, []);

  /*
   * Publish the three controls as the session view, so every element selected
   * afterwards opens the way the reader just set this one.
   *
   * Runs on mount as well, writing back the settings it was seeded with. That
   * is idempotent and nothing here subscribes to the value it writes, so the
   * mount write is a no-op in effect — but it keeps the publish unconditional
   * rather than needing a "was this a user edit" test.
   *
   * Categories go in as a sorted array. A `Set` would be a store value whose
   * identity changes on every edit and whose order is insertion-dependent,
   * which makes two equal filters compare unequal.
   */
  useEffect(() => {
    rememberView({
      depth,
      layoutMode,
      categories: CATEGORY_ORDER.filter((category) => activeCategories.has(category)),
    });
  }, [rememberView, depth, layoutMode, activeCategories]);

  /**
   * What makes the whole arrangement invalid, as against merely grown.
   *
   * Everything in here changes which boxes exist and where they belong, so the
   * layout has to be recomputed from scratch: a different depth or filter is a
   * different graph, a different mode is a different rule, and the revision is
   * the "Auto Layout" button. An expansion is deliberately *not* in it — that
   * is the one change the arrangement survives.
   */
  const baselineKey = `${layoutMode}|${depth}|${CATEGORY_ORDER.filter((category) => activeCategories.has(category)).join()}|${revision}`;
  const previousLayout = useRef<{ baselineKey: string; result: Awaited<ReturnType<typeof layoutCGraphAggregationGraph>> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!query.available || !query.data) return;
    setLayoutError(false);
    // A hint only when the arrangement on screen was computed for the same
    // baseline. After a depth change or an Auto Layout there is nothing to
    // preserve, and preserving stale positions would pin boxes to places the
    // new graph never put them.
    const reusable = previousLayout.current?.baselineKey === baselineKey ? previousLayout.current : null;
    const hint = reusable
      ? {
        positions: reusable.result.positions,
        absolutePositions: reusable.result.absolutePositions,
        sizes: reusable.result.sizes,
        ...(anchorNodeId !== null ? { anchorId: String(anchorNodeId) } : {}),
      }
      : undefined;
    void layoutCGraphAggregationGraph(graph, layoutMode, hint).then((result) => {
      if (cancelled) return;
      previousLayout.current = { baselineKey, result };
      setLayout({ graph, mode: layoutMode, result });
    }).catch(() => { if (!cancelled) setLayoutError(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `baselineKey` already carries mode, depth, filter and revision.
  }, [graph, layoutMode, baselineKey, anchorNodeId, query.available, query.data]);

  const settled = layout !== null && layout.graph === graph && layout.mode === layoutMode;

  useEffect(() => {
    if (!layout || !settled) return;
    // `positions` is parent-relative for a nested node and absolute otherwise,
    // which is exactly React Flow's own convention for `position`, so the same
    // value is correct at every level. A dragged child stays inside the frame
    // that contains it (`extent: 'parent'`), but pushes the frame's border out
    // rather than stopping at it (`expandParent`), so a crowded file can be
    // rearranged by hand. Frames carry the flag too, so the growth propagates
    // to every frame above. Frames only grow; Auto Layout restores the fitted
    // sizes. The width/height are passed explicitly because a frame's initial
    // size is the layout's result rather than its content.
    setNodes(graph.nodes.map((node) => {
      const size = aggregationNodeSize(node.id, layout.result.sizes);
      return {
        id: node.id,
        type: node.isFrame ? 'frame' : 'container',
        position: layout.result.positions.get(node.id)!,
        width: size.width,
        ...(node.isFrame ? { height: size.height } : {}),
        ...(node.parentId !== undefined ? { parentId: node.parentId, extent: 'parent' as const, expandParent: true } : {}),
        data: {
          node, size, decorations, navigate, onShowDetails,
          // The selection is already its own rollup's root, so there is nothing
          // for it to expand into the diagram.
          ...(node.isRoot ? {} : { onExpand: expand, onCollapse: collapse }),
        },
      };
    }));
    setEdges(graph.edges.map((edge) => ({
      id: edge.id, type: 'aggregation', source: edge.source, target: edge.target,
      ...aggregationEdgeHandles(edge, layout.result),
      // Sized explicitly rather than left to React Flow's default, which is
      // scaled for a thicker stroke than this view's hairline.
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: AGGREGATION_ARROW_SIZE,
        height: AGGREGATION_ARROW_SIZE,
        color: CATEGORY_COLOR[edge.segments[0]?.category ?? 'other'],
      },
      data: { edge },
    })));
  }, [graph, layout, settled, decorations, navigate, onShowDetails, expand, collapse, setNodes]);

  useEffect(() => {
    if (!initialized || !layout || !settled) return;
    // An expansion leaves the viewport alone. Re-fitting after one would change
    // the zoom and pan the reader is working in — which is the "losing focus"
    // the incremental placement exists to avoid, and it would undo it at the
    // last step. New boxes are placed adjacent to the box just expanded, which
    // is the one the reader has in view by definition.
    if (layout.result.mode === 'incremental') return;
    const frame = requestAnimationFrame(() => {
      // Bounds come from the layout rather than from the live nodes: a nested
      // node's `position` is relative to its frame, so summing those gives a
      // box that is too small and off-centre. `absolutePositions` is the
      // resolved chain, which is what this needs.
      const boxes = graph.nodes
        .map((node) => ({ position: layout.result.absolutePositions.get(node.id), size: aggregationNodeSize(node.id, layout.result.sizes) }))
        .filter((box): box is { position: { x: number; y: number }; size: { width: number; height: number } } => box.position !== undefined);
      if (!boxes.length) return;
      const minX = Math.min(...boxes.map((box) => box.position.x));
      const minY = Math.min(...boxes.map((box) => box.position.y));
      const maxX = Math.max(...boxes.map((box) => box.position.x + box.size.width));
      const maxY = Math.max(...boxes.map((box) => box.position.y + box.size.height));
      void fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { padding: 0.2, duration: 150 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, layout, settled, graph, fitBounds]);

  if (!query.available) return <Alert type="info" title="Open a workspace to view the relationship diagram" />;
  if (query.isLoading) return <div style={{ margin: 'auto' }}><Spin description="Loading relationships" /></div>;
  if (query.isError && !query.data) return <Alert type="error" title="Could not load relationships" description={query.error.message} action={<Button onClick={() => { void query.refetch(); }}>Retry</Button>} />;
  if (layoutError) return <Alert type="error" title="Could not lay out the diagram" action={<Button onClick={() => setRevision((value) => value + 1)}>Retry</Button>} />;

  const hasAnyData = (query.data?.containers.length ?? 0) > 0 || (query.data?.edges.length ?? 0) > 0;
  const nothingVisible = hasAnyData && graph.nodes.length <= 1;

  return (
    <div aria-label="CGraph aggregated relationships" style={{ position: 'relative', flex: 1, width: '100%', height: '100%', minHeight: 240 }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange} nodesConnectable={false} edgesReconnectable={false} elementsSelectable={false}
        colorMode="system" minZoom={0.05} maxZoom={2} panOnDrag zoomOnScroll
        proOptions={{ hideAttribution: true }} style={{ background: token.colorBgLayout }}
      >
        <Background gap={18} size={1} color={token.colorBorderSecondary} />
        <Controls showInteractive={false} />
        <Panel position="top-left">
          {/*
            * Only the two empty states get a line here. Describing what the
            * current depth means was restating the control that sets it, in
            * permanent screen space over the diagram it describes — and the
            * depth entries carry that explanation in their own tooltips, where
            * it is read at the moment the choice is made. What remains is the
            * cases where the canvas is blank and the reason is not visible.
            */}
          {(!hasAnyData || nothingVisible) && (
            <div style={{ color: token.colorTextSecondary, background: token.colorBgLayout, padding: '4px 8px', fontSize: 12, marginBottom: 6 }}>
              {hasAnyData ? 'No relationships match the selected filters' : 'No relationships cross this element\u2019s boundary'}
            </div>
          )}
          {/*
            * A reduction has to be stated, not absorbed. Asking for depth 5 and
            * being shown depth 2 otherwise reads as the control being broken,
            * and a reader comparing this diagram against another element's at
            * "the same" depth would be comparing two different groupings.
            */}
          {query.data && query.data.depth < query.data.requestedDepth && (
            <Alert
              type="info"
              title={`Showing depth ${query.data.depth} instead of ${query.data.requestedDepth}`}
              description="Deeper levels produce more elements than can be drawn for this selection. Select a contained element to inspect it at full depth."
              style={{ marginBottom: 6 }}
            />
          )}
          {query.data?.truncated && <Alert type="warning" title="This element contains very many descendants; the diagram reflects a partial scan" style={{ marginBottom: 6 }} />}
          {query.isError && <Alert type="error" title="Could not refresh relationships" description={query.error.message} style={{ marginBottom: 6 }} />}
          {layout?.result.mode === 'grid-fallback' && <Alert type="info" title="Showing a simplified layout" style={{ marginBottom: 6 }} />}
        </Panel>
        <Panel position="bottom-right">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <LayoutModeControl mode={layoutMode} onChange={setLayoutMode} />
            <DepthControl depth={depth} onChange={setDepth} />
            <CategoryFilter active={activeCategories} onChange={setActiveCategories} />
            {/*
              * Only while something is expanded. It is the way back from a
              * canvas that has grown past being readable — without it the only
              * ways to undo a run of expansions are collapsing each box from
              * its own menu or navigating away and back.
              */}
            {expansions.length > 0 && (
              <Button
                aria-label={`Collapse all expansions — ${expansions.length} expanded`}
                size="small"
                icon={<CloseOutlined />}
                onClick={() => { setExpansions([]); setAnchorNodeId(null); }}
              >
                {`Expanded ${expansions.length}`}
              </Button>
            )}
            <Button aria-label="Refresh relationship diagram" size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh</Button>
            <Button aria-label="Auto Layout" size="small" icon={<ApartmentOutlined />} onClick={() => setRevision((value) => value + 1)}>Auto Layout</Button>
          </div>
        </Panel>
      </ReactFlow>
      {!settled && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: token.colorBgLayout }}><Spin description="Calculating layout" /></div>}
    </div>
  );
}
