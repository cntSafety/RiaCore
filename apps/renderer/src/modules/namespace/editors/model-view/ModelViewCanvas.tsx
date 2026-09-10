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
 * ModelViewCanvas — the model view's canvas (spec-view.md Phase 5.3).
 *
 * What this replaces is worth stating, because it is not a restyling. The
 * connection diagram was a fixed three-column CSS grid — senders, focus,
 * receivers — with an SVG overlay that measured every port pin's bounding
 * rectangle on every layout change and redrew Bezier paths between them. That
 * shape could show one thing and could not pan, zoom, or be rearranged: the
 * columns *were* the layout.
 *
 * This is a React Flow canvas, the same library the workspace overview uses, so
 * panning and zooming behave the way they do on the main view rather than
 * differently. Opening a model applies Auto Layout once after loading; later
 * drags and expansions keep the user's arrangement for the current session.
 * Model positions are neither saved nor restored: persistence belongs to the
 * workspace overview where namespaces are connected.
 *
 * ## Who owns a position
 *
 * React Flow owns positions while the canvas is mounted; this component owns
 * the two things React Flow cannot know — where ELK would put a tile, and where
 * the user last dragged it. Both are held in **refs**, not state, and are
 * applied by mapping over the existing nodes rather than by rebuilding them.
 *
 * That is not a micro-optimisation. Recreating a node object mid-drag discards
 * React Flow's internal drag state, so the tile snaps back and the drag looks
 * like it did nothing — which is exactly what happened when the position maps
 * were state that the node-building effect depended on. Node objects are
 * therefore rebuilt only when the *content* changes, and even then the current
 * position is carried across.
 *
 * ELK lays out everything the user has not placed by hand; a tile the user has
 * moved keeps its position and ELK is not allowed to take it back. That is the
 * only sensible rule once expansion exists — an expansion adds tiles, and
 * re-flowing the whole canvas underneath the user each time would make the
 * arrangement they had just built unusable.
 *
 * ## Containment
 *
 * A tile with a `parentId` is a React Flow child node: positioned relative to
 * the frame that contains it, dragged only within it (`extent: 'parent'`), and
 * carried along when the frame moves. Containment is thereby a property of the
 * layout rather than a line on it, which is the point — a line between two tiles
 * on this canvas already means "these exchange data".
 *
 * Two consequences run through the code below. Positions are **frame-relative**
 * everywhere they are stored (`auto`, `pinned`, and React Flow's own), because
 * that is the coordinate React Flow renders from; routing resolves them to
 * canvas space through `resolveAbsolutePositions`, because a route may run
 * between two different frames. And a frame's *size* is layout output rather
 * than a constant — ELK grew it around its children — so it is carried in the
 * `sizes` ref and applied as a node style, while every other tile is left to
 * measure itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Alert, Button, Spin, Tooltip, theme } from 'antd';
import { ApartmentOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import type { EdgeSection, ElkPoint } from '../safety-analysis/utils/elkLayout';
import { useCommonModelPresentation } from '../../../../hooks/usePresentation';
import { useModelView, type ModelExpansion } from '../../../../hooks/useModelView';
import { ModelTileNode, TILE_WIDTH, tileHeight, type ModelTileNodeData } from './ModelTileNode';
import {
  EDGE_ENDPOINT_STUB,
  anchorSide,
  childrenByParent,
  computeModelLayout,
  isDelegation,
  portIdFromHandle,
  portRowOffsets,
  resolvePortOrder,
  structureSignature,
  type TileSide,
} from './modelElkInput';
import { RoutedModelEdge, type EdgeEmphasis, type RoutedModelEdgeData } from './RoutedModelEdge';
import type { ModelGraph, ModelTile } from './modelGraph';

const NODE_TYPES = { modelTile: ModelTileNode };
const EDGE_TYPES = { routed: RoutedModelEdge };

/**
 * Stroke for a flow edge. Taken from the colour the SysML v2 metamodel itself
 * assigns to flow connections (`rendering.color` in `sysml-v2.linkml.yaml`), so
 * a flow reads the same here as its icon does in the tree.
 */
const FLOW_STROKE = '#08979c';

type Position = { x: number; y: number };

/**
 * How long to coalesce re-route requests. A drag emits one `onNodeDragStop`,
 * and a structural re-layout lands its sections and positions together;
 * debouncing runs the routing-only pass once against the settled positions
 * rather than once per change.
 */
const REROUTE_DEBOUNCE_MS = 24;

/**
 * The live coordinate of an edge endpoint, in flow space, derived purely from
 * the tile's current position and the port's rendered row — never from ELK.
 *
 * Connection edges anchor at a port row, on the border `side` names, `offsetY`
 * down from the tile's top. Ownership edges carry no port (their handles are
 * tile-level), so they pass no offset and anchor at the tile's vertical centre.
 *
 * Both the side and the offset are passed in rather than derived here, because
 * both depend on things only the caller knows: a delegation does not follow the
 * source-right/target-left rule (`anchorSide`), and a frame centres its port
 * columns on its own measured height (`portRowOffsets`). One place decides each.
 *
 * `pos` must be a **canvas** position, and `size` the box the tile actually
 * occupies. Neither is `TILE_WIDTH` by `tileHeight` for a frame: ELK grew it
 * around its children, so its right border and its centre are both somewhere
 * else. Defaulting `size` keeps every ordinary tile a one-argument call.
 */
export function portCoordinate(
  pos: Position,
  tile: ModelTile,
  offsetY: number | undefined,
  side: TileSide,
  size?: { width: number; height: number },
): ElkPoint {
  const width = size?.width ?? TILE_WIDTH;
  const height = size?.height ?? tileHeight(tile);
  const x = side === 'east' ? pos.x + width : pos.x;
  return { x, y: pos.y + (offsetY ?? height / 2) };
}

/**
 * Resolve each tile's canvas position from the positions React Flow holds.
 *
 * React Flow stores a nested node's position relative to the frame containing
 * it, which is the right thing for rendering and the wrong thing for routing: a
 * route is drawn in canvas space and may run between two different frames. The
 * containment is one level deep, but the walk is general and guards against a
 * cycle rather than trusting that.
 */
export function resolveAbsolutePositions(
  graph: ModelGraph,
  positions: Map<string, Position>,
): Map<string, Position> {
  const parentOf = new Map(graph.tiles.map((tile) => [tile.id, tile.parentId]));
  const resolved = new Map<string, Position>();
  for (const [id, position] of positions) {
    let x = position.x;
    let y = position.y;
    const seen = new Set<string>([id]);
    for (let parent = parentOf.get(id); parent !== undefined && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      const offset = positions.get(parent);
      if (!offset) break;
      x += offset.x;
      y += offset.y;
    }
    resolved.set(id, { x, y });
  }
  return resolved;
}

/**
 * Turn a list of way points into a Manhattan `EdgeSection`.
 *
 * Two rules, and both of them are the fix for a reported rendering defect.
 *
 * **Where a diagonal seam is broken.** `points[2]` is the pair leaving the
 * source row — callers open every route with the source anchor followed by its
 * departure point, which share a row — and it alone turns *vertically*, onto
 * the departure lane the caller chose. Every later turn is taken horizontally.
 * The departure pair is normally not diagonal at all, because the caller puts
 * the departure point on the first bend's own x; the vertical turn is what
 * catches the case where the route has to double back over its own tile.
 *
 * **Which way points are dropped.** Simplification runs as a forward pass
 * against the points it has actually *kept*, never against raw neighbours: a
 * duplicate way point (two stubs meeting at the same x is the ordinary case)
 * would otherwise let each of two adjacent points justify dropping the other,
 * and the route collapses to a diagonal. A point is dropped only when it
 * duplicates the last kept point, or when it lies on the same line *and in the
 * same direction* as the two around it. A point where the route reverses is
 * kept: dropping it would merge the run it caps into a longer one and eat the
 * endpoint stub, which is the whole reason the stub was inserted.
 */
function sectionThrough(points: ElkPoint[]): EdgeSection {
  const orthogonal: ElkPoint[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = orthogonal[orthogonal.length - 1];
    const next = points[index];
    if (previous.x !== next.x && previous.y !== next.y) {
      orthogonal.push(index === 2 ? { x: previous.x, y: next.y } : { x: next.x, y: previous.y });
    }
    orthogonal.push(next);
  }

  const simplified: ElkPoint[] = [];
  for (const point of orthogonal) {
    const last = simplified[simplified.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const prior = simplified[simplified.length - 2];
    if (prior && last) {
      // `last` is redundant when the run through it does not change direction.
      // Neither factor can be zero here — consecutive kept points always differ.
      const straightX = prior.x === last.x && last.x === point.x
        && (last.y - prior.y) * (point.y - last.y) > 0;
      const straightY = prior.y === last.y && last.y === point.y
        && (last.x - prior.x) * (point.x - last.x) > 0;
      if (straightX || straightY) simplified.pop();
    }
    simplified.push(point);
  }

  return {
    startPoint: simplified[0],
    bendPoints: simplified.slice(1, -1),
    endPoint: simplified[simplified.length - 1],
  };
}

/**
 * Push a bend's x out of the two bands that hug the tiles the edge attaches to.
 *
 * A bend inside either band is precisely what draws a connection flush along a
 * box's border. ELK's own baseline keeps `EDGE_ENDPOINT_STUB` clear of every
 * node, but a bend translated by a *dragged* endpoint can land anywhere, so the
 * clearance has to be re-imposed here. Pushing a bend to the band's outer edge
 * only ever increases its distance from the tile.
 */
function clearOfTileBorders(x: number, srcX: number, tgtX: number): number {
  if (x >= srcX && x < srcX + EDGE_ENDPOINT_STUB) return srcX + EDGE_ENDPOINT_STUB;
  if (x <= tgtX && x > tgtX - EDGE_ENDPOINT_STUB) return tgtX - EDGE_ENDPOINT_STUB;
  return x;
}

/**
 * Rebuild an edge's section from its cached ELK baseline against the live
 * endpoint coordinates without calling ELK. Each half keeps the translation of
 * its endpoint, and translated bends are pushed clear of both tiles' borders.
 *
 * The two ends are then pinned onto the live ports through a **departure** and
 * an **arrival** point, and where those sit is the whole design:
 *
 * Each is the adjacent bend's *own* x, clamped only so far as the clearance
 * requires. That matters because ELK has already spread the edges of one tile
 * across separate lanes — `elk.spacing.edgeEdge` apart — and it is those lanes
 * that keep the connectors of neighbouring port rows off each other. Pinning
 * every route to one shared stub lane instead, which an earlier version of this
 * did, collapses all of them onto a single x: several ports next to each other
 * on the same element, all of their connectors turning at the same place, drawn
 * on top of one another. The clamp is a floor on the clearance, not a lane
 * assignment, so an edge keeps its own lane whenever that lane is already clear.
 *
 * When the baseline has no bend at all there is no lane to preserve and nothing
 * to translate, so the route is handed to `orthogonalSection`, whose midpoint
 * lane varies per edge rather than being shared.
 */
export function offsetSection(baseline: EdgeSection, srcLive: ElkPoint, tgtLive: ElkPoint): EdgeSection {
  if (baseline.bendPoints.length === 0) return orthogonalSection(srcLive, tgtLive);

  const srcDelta = { x: srcLive.x - baseline.startPoint.x, y: srcLive.y - baseline.startPoint.y };
  const tgtDelta = { x: tgtLive.x - baseline.endPoint.x, y: tgtLive.y - baseline.endPoint.y };
  const mid = Math.floor(baseline.bendPoints.length / 2);
  const bends = baseline.bendPoints.map((point, index) => {
    const delta = index < mid ? srcDelta : tgtDelta;
    return {
      x: clearOfTileBorders(point.x + delta.x, srcLive.x, tgtLive.x),
      y: point.y + delta.y,
    };
  });

  const departX = Math.max(bends[0].x, srcLive.x + EDGE_ENDPOINT_STUB);
  const arriveX = Math.min(bends[bends.length - 1].x, tgtLive.x - EDGE_ENDPOINT_STUB);

  return sectionThrough([
    srcLive,
    { x: departX, y: srcLive.y },
    ...bends,
    { x: arriveX, y: tgtLive.y },
    tgtLive,
  ]);
}

/**
 * The lane a backwards route runs along between its two vertical legs.
 *
 * Normally the midpoint of the two rows. When the rows are less than two stubs
 * apart that midpoint lies on top of both horizontal runs and the route doubles
 * back along itself, so the lane is dropped clear below whichever row is lower
 * instead.
 */
function backwardLaneY(srcY: number, tgtY: number): number {
  if (Math.abs(tgtY - srcY) >= 2 * EDGE_ENDPOINT_STUB) return (srcY + tgtY) / 2;
  return Math.max(srcY, tgtY) + EDGE_ENDPOINT_STUB;
}

/**
 * Fallback route for an edge with no cached ELK baseline (e.g. ELK omitted its
 * section, or a tile has just been dragged past its partner). Keeps the edge
 * visible and terminating at the live ports without any ELK call.
 *
 * Forward — the target far enough to the right that a stub fits at each end —
 * is the familiar route via the horizontal midpoint, collapsing to a straight
 * run when the two rows align. Backwards or overlapping, that midpoint would
 * fall on or inside the tiles, so the route instead steps one stub out of the
 * source, runs along a lane clear of both rows, and comes back in one stub
 * short of the target.
 */
export function orthogonalSection(srcLive: ElkPoint, tgtLive: ElkPoint): EdgeSection {
  const srcStubX = srcLive.x + EDGE_ENDPOINT_STUB;
  const tgtStubX = tgtLive.x - EDGE_ENDPOINT_STUB;

  if (tgtStubX >= srcStubX) {
    const midX = (srcStubX + tgtStubX) / 2;
    return sectionThrough([
      srcLive,
      { x: srcStubX, y: srcLive.y },
      { x: midX, y: srcLive.y },
      { x: midX, y: tgtLive.y },
      { x: tgtStubX, y: tgtLive.y },
      tgtLive,
    ]);
  }

  const laneY = backwardLaneY(srcLive.y, tgtLive.y);
  return sectionThrough([
    srcLive,
    { x: srcStubX, y: srcLive.y },
    { x: srcStubX, y: laneY },
    { x: tgtStubX, y: laneY },
    { x: tgtStubX, y: tgtLive.y },
    tgtLive,
  ]);
}

/**
 * How many frames each tile sits inside. Used only to order the node array, so
 * a frame is always handed to React Flow before anything nested in it.
 */
export function nestingDepths(graph: ModelGraph): Map<string, number> {
  const parentOf = new Map(graph.tiles.map((tile) => [tile.id, tile.parentId]));
  const depths = new Map<string, number>();
  for (const tile of graph.tiles) {
    let depth = 0;
    const seen = new Set<string>([tile.id]);
    for (let parent = tile.parentId; parent !== undefined && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      depth += 1;
    }
    depths.set(tile.id, depth);
  }
  return depths;
}

/**
 * The measured box of every tile that is a frame, and of no other tile.
 *
 * Only a frame is sized from the outside — its size is what ELK made it, not a
 * constant — so handing React Flow a style for an ordinary tile would pin it to
 * a height the DOM is entitled to disagree with.
 */
export function frameSizes(
  graph: ModelGraph,
  sizes: Map<string, { width: number; height: number }>,
): Record<string, { width: number; height: number }> {
  const measured: Record<string, { width: number; height: number }> = {};
  for (const frameId of childrenByParent(graph.tiles).keys()) {
    const size = sizes.get(frameId);
    if (size) measured[frameId] = size;
  }
  return measured;
}

/**
 * Pin ELK routes to the exact rows React Flow renders for the final tile order.
 *
 * `positions` are as React Flow holds them — relative to a tile's frame where it
 * has one — and are resolved to canvas space here, so callers can pass node
 * positions straight in. `sizes` supplies the boxes ELK measured, which only
 * matters for frames; a tile missing from it falls back to the fixed tile box.
 */
export function routeSectionsAtPositions(
  graph: ModelGraph,
  positions: Map<string, Position>,
  sizes: Map<string, { width: number; height: number }>,
  sections: Record<string, EdgeSection>,
  portOffsets?: Record<string, Record<string, number>>,
): Record<string, EdgeSection> {
  const tileById = new Map(graph.tiles.map((tile) => [tile.id, tile]));
  const canvas = resolveAbsolutePositions(graph, positions);
  // A frame's port rows are ELK's to place and an ordinary tile's are the row
  // formula's, so the offsets differ by tile. Computed once per tile rather than
  // per endpoint.
  const frames = childrenByParent(graph.tiles);
  const offsetCache = new Map<string, Map<string, number>>();
  const offsetsFor = (tile: ModelTile) => {
    const cached = offsetCache.get(tile.id);
    if (cached) return cached;
    const isFrame = frames.has(tile.id);
    const offsets = portRowOffsets(
      tile,
      isFrame ? sizes.get(tile.id)?.height : undefined,
      isFrame ? portOffsets?.[tile.id] : undefined,
    );
    offsetCache.set(tile.id, offsets);
    return offsets;
  };
  const routed: Record<string, EdgeSection> = {};
  for (const edge of graph.edges) {
    const sourceTile = tileById.get(edge.source);
    const targetTile = tileById.get(edge.target);
    const sourcePosition = canvas.get(edge.source);
    const targetPosition = canvas.get(edge.target);
    if (!sourceTile || !targetTile || !sourcePosition || !targetPosition) continue;
    const sourcePortId = portIdFromHandle(edge.sourceHandle);
    const targetPortId = portIdFromHandle(edge.targetHandle);
    // A delegation stays inside its frame, so both of its ends anchor on the
    // border their port faces instead of leaving right and arriving left.
    const delegation = isDelegation(edge, tileById);
    const source = portCoordinate(
      sourcePosition,
      sourceTile,
      sourcePortId === undefined ? undefined : offsetsFor(sourceTile).get(sourcePortId),
      anchorSide('source', sourceTile.ports.find((p) => p.id === sourcePortId)?.dir, delegation),
      sizes.get(edge.source),
    );
    const target = portCoordinate(
      targetPosition,
      targetTile,
      targetPortId === undefined ? undefined : offsetsFor(targetTile).get(targetPortId),
      anchorSide('target', targetTile.ports.find((p) => p.id === targetPortId)?.dir, delegation),
      sizes.get(edge.target),
    );
    // A frame's own port-to-port connection is routed here rather than by ELK.
    //
    // ELK treats it as a self-loop, and a self-loop is placed *outside* the node:
    // its defaults are `selfLoopDistribution: NORTH` and `selfLoopOrdering:
    // STACKED`, so such a connection is stacked over the top of the frame and runs
    // right around it. There is no option to route it through the interior, because
    // to ELK a node is an opaque rectangle even when ELK laid out its contents —
    // and hierarchical self-loop port placement is a known weak spot besides
    // (eclipse-elk/elk#552).
    //
    // But a frame's interior is exactly where such a connection belongs. It is a
    // pass-through — a signal entering the container on one side and leaving on the
    // other — and the frame keeps a wide empty band inside each port border
    // (`FRAME_PORT_BAND`) with nothing in it. Dropping the baseline hands the edge
    // to `orthogonalSection`, which runs it from the west anchor to the east one
    // with a single jog, collapsing to a straight line when the two ports are level.
    //
    // Only for a frame. On a leaf tile the interior is full of the tile's own port
    // rows and ELK's route over the top is the readable one, so its baseline stands.
    const selfOnFrame = edge.source === edge.target && frames.has(edge.source);
    const section = selfOnFrame ? undefined : sections[edge.id];
    routed[edge.id] = section
      ? offsetSection(section, source, target)
      : orthogonalSection(source, target);
  }
  return routed;
}

export interface ModelViewCanvasProps {
  namespace: string;
  nodeId: number;
  workspaceKey: string | null;
  /** The authored safety namespace (where malfunctions live). */
  safetyNamespace?: string;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (
    refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string,
  ) => void;
  onShowDetails?: () => void;
}

export function ModelViewCanvas(props: ModelViewCanvasProps) {
  // React Flow's viewport hooks require a provider above them, and this
  // component is mounted directly by the lens rather than inside one.
  return (
    <ReactFlowProvider>
      <ModelViewCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function ModelViewCanvasInner({
  namespace, nodeId, workspaceKey, safetyNamespace,
  onNavigateToNode, onNavigateToReference, onShowDetails,
}: ModelViewCanvasProps) {
  const { token } = theme.useToken();
  const { fitView, getNodes } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const presentation = useCommonModelPresentation(workspaceKey);

  const [expansions, setExpansions] = useState<ModelExpansion[]>([]);
  const query = useModelView(namespace, nodeId, workspaceKey, expansions, safetyNamespace);
  const graph = query.data?.graph;
  // A layout result belongs to one exact graph shape. Until ELK has settled
  // that shape, keep its provisional nodes and straight fallback edges hidden;
  // otherwise React Flow briefly paints every new tile at a carried/default
  // position and those malformed intermediate routes can remain for seconds.
  const structureKey = useMemo(() => (graph ? structureSignature(graph) : ''), [graph]);
  const [settledStructure, setSettledStructure] = useState('');
  const layoutReady = structureKey !== '' && settledStructure === structureKey;
  const [autoLayoutRunning, setAutoLayoutRunning] = useState(false);
  const [fitRevision, setFitRevision] = useState(0);
  const autoLayoutRunId = useRef(0);
  const autoLayoutStartedFor = useRef<string | null>(null);
  const viewIdentity = `${workspaceKey ?? ''}\u0001${namespace}\u0001${nodeId}`;
  const layoutIdentity = `${viewIdentity}\u0001${structureKey}`;
  const layoutIdentityRef = useRef(layoutIdentity);
  layoutIdentityRef.current = layoutIdentity;

  useEffect(() => {
    autoLayoutRunId.current += 1;
    setAutoLayoutRunning(false);
  }, [layoutIdentity]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  /** Where the user put a tile. Wins over ELK, and survives a content refetch. */
  const pinned = useRef<Record<string, Position>>({});
  /** Where ELK put a tile. */
  const auto = useRef<Record<string, Position>>({});
  /**
   * How big ELK made each frame. Held for the frames only — see `frameSizes` —
   * and in a ref because it is layout output the render reads, not state anything
   * re-renders on: the layout pass that writes it also sets the nodes.
   */
  const sizes = useRef<Record<string, { width: number; height: number }>>({});
  /**
   * The primary ELK auto-pass edge sections, cached per edge id as the baseline
   * the routing-only re-route pass translates. Set whenever ELK settles a new
   * layout; read (never re-run) on drag to rebuild routes client-side.
   */
  const baselineSections = useRef<Record<string, EdgeSection>>({});

  /**
   * ELK-computed intra-side port order per tile. It replaces the deterministic
   * alphabetical order from `buildModelGraph` once ELK has run, and is empty
   * until then, so a tile renders its fallback order on first paint.
   */
  const [elkPortOrder, setElkPortOrder] = useState<Record<string, string[]>>({});

  /**
   * Where ELK put each frame's own ports, keyed by tile id then port id.
   *
   * A frame's pins are drawn here rather than at the centred stack
   * `portRowOffsets` computes, because ELK places them itself and ignores the
   * offsets it was handed for them — see `ElkLayoutResult.portOffsets`. Both the
   * DOM and the route pinning read this, so they cannot disagree.
   *
   * State, not a ref: the tile renders from it, so it has to trigger a re-render.
   * A ref alongside it is what `runReroute` reads, because that runs outside the
   * render and needs the settled value on every drag tick.
   */
  const [elkPortOffsets, setElkPortOffsets] = useState<Record<string, Record<string, number>>>({});
  const portOffsetsRef = useRef<Record<string, Record<string, number>>>({});
  const applyPortOffsets = useCallback((next: Record<string, Record<string, number>>) => {
    portOffsetsRef.current = next;
    setElkPortOffsets(next);
  }, []);
  /** ELK-computed edge routes, keyed by edge id, written onto each edge's `data.section`. */
  const [edgeSections, setEdgeSections] = useState<Record<string, EdgeSection>>({});

  /**
   * The route the user has clicked, to be traced from end to end.
   *
   * Held here rather than left to React Flow's own selection because the canvas
   * deliberately runs with `elementsSelectable={false}` — a selection outline on a
   * tile competes with the focus emphasis — and because the emphasis has to reach
   * every *other* edge to mute it, which selection state does not express.
   */
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  /**
   * The graph with each tile's ports resolved into ELK's computed render order
   * (falling back to `buildModelGraph`'s deterministic order when ELK has not
   * run or returned no order for a tile). Both the rendered rows and the
   * structure signature read this, so a content-only refetch leaves the
   * signature unchanged while a genuine port reorder changes it.
   */
  const resolvedGraph = useMemo<ModelGraph | undefined>(() => {
    if (!graph) return undefined;
    return {
      ...graph,
      tiles: graph.tiles.map((tile) => ({
        ...tile,
        ports: resolvePortOrder(tile, elkPortOrder[tile.id]),
      })),
    };
  }, [graph, elkPortOrder]);

  /**
   * The latest resolved graph, read by the debounced re-route pass. Held in a
   * ref so `scheduleReroute` can stay identity-stable (empty deps) and always
   * see the current tiles/edges when its timer fires, rather than re-creating
   * the callback — and re-arming the debounce — on every content refetch.
   */
  const resolvedGraphRef = useRef<ModelGraph | undefined>(resolvedGraph);
  resolvedGraphRef.current = resolvedGraph;

  const handleExpand = useCallback((kind: 'contained' | 'connections', representativeId: string) => {
    setExpansions((current) => (
      current.some((e) => e.kind === kind && e.representativeId === representativeId)
        ? current
        : [...current, { kind, representativeId }]
    ));
  }, []);

  const collapse = useCallback(() => {
    setExpansions([]);
    pinned.current = {};
  }, []);

  // ── Nodes and edges ───────────────────────────────────────────────────────
  // Rebuilt when the content changes — which includes a malfunction appearing,
  // not only a tile being added. Positions are carried across from the nodes
  // being replaced, so a refetch never moves anything.
  useEffect(() => {
    if (!resolvedGraph || !layoutReady) {
      // Do not expose React Flow's provisional {0,0}/carried positions or its
      // straight fallback edges while ELK is calculating this graph shape.
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      const nestedIn = childrenByParent(resolvedGraph.tiles);
      const built = resolvedGraph.tiles.map((tile) => {
        const isFrame = nestedIn.has(tile.id);
        const size = isFrame ? sizes.current[tile.id] : undefined;
        return {
          id: tile.id,
          type: 'modelTile',
          position: positions.get(tile.id) ?? pinned.current[tile.id] ?? auto.current[tile.id] ?? { x: 0, y: 0 },
          // Containment is React Flow's own: a nested tile is positioned relative
          // to its frame and moves with it, which is the behaviour that makes
          // "inside" mean inside rather than "drawn on top of, for now".
          ...(tile.parentId !== undefined ? { parentId: tile.parentId, extent: 'parent' as const } : {}),
          // Only a frame is sized from the outside. An ordinary tile measures
          // itself, and handing React Flow a stale height would fight the DOM.
          ...(size ? { style: { width: size.width, height: size.height } } : {}),
          data: {
            tile,
            isFrame,
            portOffsets: isFrame ? elkPortOffsets[tile.id] : undefined,
            presentation,
            safetyNamespace,
            onExpand: handleExpand,
            onNavigateToNode,
            onNavigateToReference,
            onShowDetails,
          } satisfies ModelTileNodeData,
          // Dragging is the point; selection is not, and a selected outline on
          // top of the focus emphasis reads as a second kind of highlight.
          draggable: true,
          selectable: false,
        };
      });
      // React Flow resolves `parentId` against the nodes it has already seen, so
      // a child listed before its frame is dropped with a console error rather
      // than nested (xyflow#4438). Ordering by depth is enough: containment here
      // is a forest, and a frame is always shallower than what it contains.
      const depth = nestingDepths(resolvedGraph);
      return built.sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0));
    });
    // Every edge is a routed edge: it draws a polyline through ELK's bend points
    // when a section is available, and falls back to a straight path otherwise.
    // The visual encoding moves onto `data` so the routed component applies it.
    setEdges(resolvedGraph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'routed',
      data: {
        section: edgeSections[edge.id],
        // A malfunction still outranks everything: an edge touching one reads red
        // whatever kind it is. Otherwise a flow takes the colour the SysML
        // metamodel itself assigns to flows, so it is legible as a different kind
        // of thing from a static connection at a glance.
        stroke: edge.kind === 'ownership' ? token.colorTextSecondary
          : edge.warn ? '#d4380d'
            : edge.kind === 'flow' ? FLOW_STROKE
              : token.colorTextSecondary,
        strokeWidth: edge.kind === 'ownership' ? 2 : 2.5,
        strokeDasharray: edge.dashed ? '6 4' : edge.kind === 'ownership' ? '2 3' : undefined,
      } satisfies RoutedModelEdgeData,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      // Per-edge, because the canvas turns selection off globally for the tiles.
      // Without it React Flow leaves the interaction stroke click-through and the
      // route cannot be picked out at all.
      selectable: true,
    })));
  }, [resolvedGraph, layoutReady, edgeSections, presentation, safetyNamespace, handleExpand,
    onNavigateToNode, onNavigateToReference, onShowDetails, setNodes, setEdges, token]);

  /**
   * Apply the emphasis for the selected route.
   *
   * A separate pass over the existing edges rather than part of the effect above,
   * and that is deliberate: that effect rebuilds `data.section` from
   * `edgeSections`, which is the *layout's* geometry, while a drag writes newer
   * geometry straight onto the edge through `runReroute`. Rebuilding on every click
   * would throw the dragged routes away and snap them back. So this only ever
   * touches `emphasis`, and returns the edge untouched when it already has the
   * right one, so clicking twice costs nothing.
   */
  useEffect(() => {
    setEdges((prev) => {
      let changed = false;
      const next = prev.map((edge) => {
        const emphasis: EdgeEmphasis | undefined = selectedEdgeId === null
          ? undefined
          : edge.id === selectedEdgeId ? 'selected' : 'muted';
        const data = edge.data as RoutedModelEdgeData;
        if (data.emphasis === emphasis) return edge;
        changed = true;
        return {
          ...edge,
          // The selected route is drawn over the ones it runs parallel to, so its
          // halo is not buried under them.
          zIndex: emphasis === 'selected' ? 10 : 0,
          data: { ...data, emphasis },
        };
      });
      return changed ? next : prev;
    });
  }, [selectedEdgeId, setEdges]);

  // A re-layout can remove the selected edge, and a selection pointing at an edge
  // that no longer exists mutes the whole canvas with nothing highlighted.
  useEffect(() => { setSelectedEdgeId(null); }, [structureKey]);

  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: { id: string }) => {
    // Clicking the highlighted route again clears it, so the gesture is its own
    // undo and does not depend on finding empty canvas to click.
    setSelectedEdgeId((current) => (current === edge.id ? null : edge.id));
  }, []);
  const clearSelectedEdge = useCallback(() => setSelectedEdgeId(null), []);

  /**
   * Move every tile the user has not placed by hand, and resize the frames.
   *
   * A frame is resized even when it is pinned: the user dragged where it sits,
   * not how big it is, and a frame left at its pre-layout size would clip the
   * children ELK just placed inside it.
   */
  const applyPositions = useCallback((positions: Record<string, Position>, respectPinned: boolean) => {
    setNodes((current) => current.map((node) => {
      const size = sizes.current[node.id];
      const resized = size ? { ...node, style: { ...node.style, width: size.width, height: size.height } } : node;
      if (respectPinned && pinned.current[node.id]) return resized;
      const next = positions[node.id];
      return next ? { ...resized, position: next } : resized;
    }));
  }, [setNodes]);

  // ── Re-route (routing only, no ELK) ─────────────────────────────────────────
  // A tile that has been dragged no longer sits where ELK placed it,
  // so the baseline sections — which are in ELK's coordinate space — no longer
  // line up with it. This pass rebuilds each edge's geometry purely client-side
  // against the *live* tile/port coordinates, so a route always terminates where
  // the tile actually is. It deliberately does NOT call ELK: holding positions
  // fixed through a layered re-layout is unsound with GREEDY cycle-breaking (ELK
  // re-derives a fresh layout), and skipping ELK also means the elkjs INTERACTIVE
  // cycle-breaker crash cannot occur here. It only ever writes `edge.data.section`
  // — never `node.position` — so pinned tiles never move.
  const rerouteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runReroute = useCallback(() => {
    const current = resolvedGraphRef.current;
    if (!current) return;
    // `routeSectionsAtPositions` is the whole pass — the same helper the layout
    // effects route through, rather than a second copy of the loop that has to
    // be kept in step with it by inspection.
    const posById = new Map(getNodes().map((node) => [node.id, node.position]));
    const nextSections = routeSectionsAtPositions(
      current, posById, new Map(Object.entries(sizes.current)), baselineSections.current,
      portOffsetsRef.current,
    );
    setEdges((prev) => prev.map((edge) => (
      nextSections[edge.id]
        ? { ...edge, data: { ...(edge.data as RoutedModelEdgeData), section: nextSections[edge.id] } }
        : edge
    )));
  }, [getNodes, setEdges]);
  const scheduleReroute = useCallback(() => {
    if (rerouteTimer.current) clearTimeout(rerouteTimer.current);
    rerouteTimer.current = setTimeout(() => {
      rerouteTimer.current = null;
      runReroute();
    }, REROUTE_DEBOUNCE_MS);
  }, [runReroute]);
  // Fired on every `onNodeDrag` tick so a tile's edges track it as it moves,
  // the way they did before routes were cached against an ELK baseline instead
  // of being derived straight from the node/handle each render. Runs
  // synchronously (no debounce) — React Flow has already applied the node's
  // new position by the time this fires, so the work is cheap (edge count) and
  // skipping the debounce is what keeps the route glued to the cursor.
  const handleNodeDrag = useCallback(() => {
    if (rerouteTimer.current) {
      clearTimeout(rerouteTimer.current);
      rerouteTimer.current = null;
    }
    runReroute();
  }, [runReroute]);

  // Cancel pending route/layout work when the canvas unmounts.
  useEffect(() => () => {
    if (rerouteTimer.current) clearTimeout(rerouteTimer.current);
    autoLayoutRunId.current += 1;
  }, []);

  const handleAutoLayout = useCallback(() => {
    if (autoLayoutRunning || !graph || !resolvedGraph || resolvedGraph.tiles.length === 0) return;

    // A manual click also satisfies the one-time layout on open.
    autoLayoutStartedFor.current = viewIdentity;
    const runId = ++autoLayoutRunId.current;
    const startedForIdentity = layoutIdentity;
    setAutoLayoutRunning(true);
    void (async () => {
      const result = await computeModelLayout(resolvedGraph);
      if (runId !== autoLayoutRunId.current || startedForIdentity !== layoutIdentityRef.current) return;

      const missingTileIds = resolvedGraph.tiles
        .filter((tile) => {
          const position = result.positions.get(tile.id);
          return !position || !Number.isFinite(position.x) || !Number.isFinite(position.y);
        })
        .map((tile) => tile.id);
      if (missingTileIds.length > 0) {
        console.warn('[ModelViewCanvas] incomplete auto-layout ignored', { runId, missingTileIds, result });
        return;
      }

      const orderedTiles = result.ordered.tiles;
      const measured = frameSizes(result.ordered, result.sizes);
      const finalSections = routeSectionsAtPositions(
        result.ordered, result.positions, result.sizes, result.edgeSections, result.portOffsets,
      );

      if (rerouteTimer.current) {
        clearTimeout(rerouteTimer.current);
        rerouteTimer.current = null;
      }
      pinned.current = {};
      auto.current = Object.fromEntries(result.positions);
      sizes.current = measured;
      baselineSections.current = finalSections;
      applyPortOffsets(result.portOffsets);

      const tileById = new Map(orderedTiles.map((tile) => [tile.id, tile]));
      setNodes((current) => current.map((node) => {
        const size = measured[node.id];
        return {
          ...node,
          position: result.positions.get(node.id) ?? node.position,
          // A frame's box is a layout result, so it lands with the positions —
          // the node array was built before ELK had measured anything.
          ...(size ? { style: { ...node.style, width: size.width, height: size.height } } : {}),
          data: {
            ...node.data,
            tile: tileById.get(node.id) ?? (node.data as ModelTileNodeData).tile,
          },
        };
      }));
      setEdges((current) => current.map((edge) => ({
        ...edge,
        data: {
          ...(edge.data as RoutedModelEdgeData),
          section: finalSections[edge.id],
        },
      })));
      setElkPortOrder(result.portOrder);
      setEdgeSections(finalSections);
      setSettledStructure(structureKey);
      setFitRevision((revision) => revision + 1);
    })()
      .catch((error) => {
        if (runId !== autoLayoutRunId.current || startedForIdentity !== layoutIdentityRef.current) return;
        console.error('[ModelViewCanvas] auto-layout failed', { runId, error });
      })
      .finally(() => {
        if (runId === autoLayoutRunId.current && startedForIdentity === layoutIdentityRef.current) {
          setAutoLayoutRunning(false);
        }
      });
  }, [autoLayoutRunning, graph, layoutIdentity, resolvedGraph, setEdges, setNodes,
    structureKey, viewIdentity]);

  // ── Auto-layout ───────────────────────────────────────────────────────────
  // Keyed on the graph's *shape*, so moving a tile cannot trigger a re-flow of
  // the canvas under the cursor, and a refetch that changes only a malfunction
  // marker does not rearrange anything.
  //
  // The shape key is declared with the query result above so provisional
  // React Flow state can be withheld before this asynchronous pass settles.
  useEffect(() => {
    if (!resolvedGraph || resolvedGraph.tiles.length === 0) return;
    let cancelled = false;
    // `computeModelLayout` runs both ELK passes: the first for the intra-side
    // port order, the second for positions and routes against the port geometry
    // the DOM will actually draw. The result carries positions (unchanged
    // consumer), routed edge sections, that port order, and the graph with the
    // order already applied — all consumed below.
    void computeModelLayout(resolvedGraph).then((
      { positions, sizes: measuredSizes, edgeSections: sections, portOrder, portOffsets: layoutPortOffsets, ordered },
    ) => {
      if (cancelled) return;
      auto.current = Object.fromEntries(positions);
      sizes.current = frameSizes(ordered, measuredSizes);
      applyPositions(auto.current, true);
      setElkPortOrder(portOrder);
      applyPortOffsets(layoutPortOffsets);

      const effectivePositions = new Map(positions);
      for (const [tileId, position] of Object.entries(pinned.current)) {
        effectivePositions.set(tileId, position);
      }
      const normalizedSections = routeSectionsAtPositions(
        ordered, effectivePositions, measuredSizes, sections, layoutPortOffsets,
      );
      baselineSections.current = normalizedSections;
      setEdgeSections(normalizedSections);
      setSettledStructure(structureKey);
    });
    return () => { cancelled = true; };
    // `resolvedGraph` is read but omitted from the deps: only its shape
    // (`structureKey`) may trigger a re-layout, so a content-only refetch that
    // leaves the shape and resolved port order unchanged does not re-run ELK.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, applyPositions]);

  // Run the button's full layout once the opening graph and React Flow
  // measurements are ready. Key this to the selected view, not its shape, so
  // refetches and expansions do not discard tiles dragged in this session.
  useEffect(() => {
    if (autoLayoutStartedFor.current === viewIdentity || autoLayoutRunning) return;
    if (!layoutReady || !nodesInitialized || nodes.length === 0) return;
    if (query.isFetching || query.isPlaceholderData || query.isError) return;
    handleAutoLayout();
  }, [autoLayoutRunning, handleAutoLayout, layoutReady, nodesInitialized, nodes.length,
    query.isFetching, query.isPlaceholderData, query.isError, viewIdentity]);

  // Fit on open and after each expansion, once the layout for it has actually
  // been applied.
  //
  // Two things this must not do. It must not fit on every graph change — a
  // refetch would then yank the viewport away from wherever the user had
  // panned. And it must not fit before the layout lands, when every tile still
  // sits at the origin and "fit" means "zoom all the way in on a single point",
  // which is what it did until `layoutSettled` gated it.
  //
  // An expansion *is* worth re-framing for: the user has just asked for more,
  // and the tiles it adds are otherwise placed outside the viewport.
  //
  // Three conditions, and every one of them was learned by watching the fit
  // land somewhere useless:
  //
  //  - The layout must have settled **for the structure now on screen**, not
  //    merely at some point. Otherwise the fit frames tiles that ELK has not
  //    placed yet, all of which still sit at the origin.
  //  - `isPlaceholderData` must have cleared. An expansion changes the query
  //    key and React Query serves the previous result while the new one loads;
  //    fitting to that consumed the one fit the expansion was going to get.
  //  - `nodes.length` is read through a ref rather than depended on. As a
  //    dependency it re-ran this effect the moment the node list changed, and
  //    the cleanup cancelled the animation frame the previous run had just
  //    scheduled, while the new run declined to reschedule.
  //  - `useNodesInitialized()` must be true, not just a rendered frame away.
  //    A `requestAnimationFrame` fires before React Flow's ResizeObserver has
  //    measured the new tiles' real dimensions, so `fitView` was framing
  //    zero-size nodes at their raw ELK positions — the transform it computed
  //    never actually moved the viewport, which read as tiles pinned to the
  //    canvas's top-left origin instead of centred. Same race `GraphFitter`
  //    in WorkspaceCanvas.tsx exists to avoid.
  const fittedFor = useRef<string | null>(null);
  const nodeCount = useRef(0);
  nodeCount.current = nodes.length;
  const showingPlaceholder = query.isPlaceholderData;
  const fitKey = `${expansions.length}:${fitRevision}`;
  useEffect(() => {
    if (showingPlaceholder || nodeCount.current === 0 || !nodesInitialized) return;
    if (structureKey === '' || settledStructure !== structureKey) return;
    if (fittedFor.current === fitKey) return;
    fittedFor.current = fitKey;
    void fitView({ padding: 0.15, duration: 200 });
  }, [settledStructure, structureKey, showingPlaceholder, fitKey, fitView, nodesInitialized]);

  // ── Dragging ──────────────────────────────────────────────────────────────
  const handleNodeDragStop = useCallback((_event: unknown, node: Node) => {
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return;
    pinned.current[node.id] = { x: node.position.x, y: node.position.y };
    // The moved tile's edges no longer match ELK's baseline route — recompute
    // routes for the current positions (pinned tiles stay put; only geometry
    // changes).
    scheduleReroute();
  }, [scheduleReroute]);

  // ── States ────────────────────────────────────────────────────────────────
  if (query.isLoading && !graph) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (query.isError && query.error) {
    return <div style={{ padding: 24 }}><Alert type="error" message={(query.error as Error).message} /></div>;
  }
  // A selection the view cannot centre on — an element the mapping does not
  // project — renders nothing, exactly as an unhandled concept did before.
  if (!graph) return null;
  if (graph.tiles.length > 0 && !layoutReady) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200 }}>
        <Spin size="large" tip="Calculating layout" />
      </div>
    );
  }

  const focusTile = graph.tiles.find((tile) => tile.isFocus);
  const emptyHint = graph.tiles.length > 1 || graph.edges.length > 0
    ? null
    : hintForLoneTile(focusTile);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, height: '100%', width: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        // React Flow has its own colour-mode switch and defaults to light,
        // independently of Ant Design. Without this, its built-in controls keep
        // light surfaces on the dark canvas.
        colorMode="system"
        onNodesChange={onNodesChange}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        // Click a route to trace it end to end; click the canvas, or the route
        // again, to let go. Clicking a tile clears it too — the user has moved on
        // to a different question by then.
        onEdgeClick={handleEdgeClick}
        onPaneClick={clearSelectedEdge}
        onNodeClick={clearSelectedEdge}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.1}
        maxZoom={2}
        // Panning with the primary button matches the workspace overview, where
        // the canvas is dragged rather than rubber-band selected.
        panOnDrag
        zoomOnScroll
        style={{ background: token.colorBgLayout }}
      >
        <Background gap={18} size={1} color={token.colorBorderSecondary} />
        <Controls showInteractive={false} />

        <Panel position="bottom-right">
          <Button
            size="small"
            icon={<ApartmentOutlined />}
            onClick={handleAutoLayout}
            loading={autoLayoutRunning}
            disabled={!resolvedGraph || resolvedGraph.tiles.length === 0}
          >
            Auto Layout
          </Button>
        </Panel>

        <Panel position="top-left"><Legend /></Panel>

        {(expansions.length > 0 || query.isFetching) && (
          <Panel position="top-right">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {query.isFetching && <Spin size="small" />}
              {expansions.length > 0 && (
                <Tooltip title="Remove every expansion and return to the element's own neighbourhood">
                  <Button size="small" icon={<ReloadOutlined />} onClick={collapse}>
                    Collapse ({expansions.length})
                  </Button>
                </Tooltip>
              )}
            </div>
          </Panel>
        )}

        {emptyHint && (
          <Panel position="bottom-center">
            <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>{emptyHint}</span>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/**
 * The hint has to say *why* the canvas holds a single tile, and there are two
 * different reasons. A composition, for instance, exposes no ports at all in
 * this projection, so "no connections found" describes the symptom and blames
 * the wrong thing: there was never anything to connect. An element that does
 * expose ports but has none wired up is the other case.
 */
function hintForLoneTile(focus: ModelTile | undefined): string {
  if (!focus) return 'Nothing to show for this element.';
  if (focus.ports.length === 0) {
    return 'This element exposes no ports and contains nothing — right-click it to expand.';
  }
  return 'None of this element\'s ports are connected.';
}



function Legend() {
  const { token } = theme.useToken();
  const asilLevels = [
    { label: 'QM', color: '#8c8c8c' },
    { label: 'A', color: '#52c41a' },
    { label: 'B', color: '#a0d911' },
    { label: 'C', color: '#ffa940' },
    { label: 'D', color: '#d4380d' },
  ];
  const caption: React.CSSProperties = {
    fontSize: 11,
    fontFamily: token.fontFamilyCode,
    textTransform: 'uppercase',
    color: token.colorTextSecondary,
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '4px 10px',
        borderRadius: 6,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {asilLevels.map(({ label, color }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color }} />
          <span style={caption}>{label}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <WarningOutlined style={{ fontSize: 11, color: '#d4380d' }} />
        <span style={caption}>has malfunction</span>
      </div>
      {/* A flow is the one link whose arrow means something — see `isFlowLink`. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ display: 'inline-block', width: 14, height: 2, background: FLOW_STROKE }} />
        <span style={caption}>flow</span>
      </div>
    </div>
  );
}
