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
  computeModelLayout,
  portIdFromHandle,
  portOffset,
  resolvePortOrder,
  structureSignature,
} from './modelElkInput';
import { RoutedModelEdge, type RoutedModelEdgeData } from './RoutedModelEdge';
import type { ModelGraph, ModelTile } from './modelGraph';

const NODE_TYPES = { modelTile: ModelTileNode };
const EDGE_TYPES = { routed: RoutedModelEdge };

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
 * Connection edges anchor at a port row: the source end on the tile's right
 * edge (`x = pos.x + TILE_WIDTH`) and the target end on its left (`x = pos.x`),
 * both at the vertical centre of the port's resolved row (`portOffset`).
 * Ownership edges carry no port (their handles are tile-level), so they anchor
 * at the same left/right edge but at the tile's vertical centre.
 */
export function portCoordinate(
  pos: Position,
  tile: ModelTile,
  portId: string | undefined,
  role: 'source' | 'target',
): ElkPoint {
  const x = role === 'source' ? pos.x + TILE_WIDTH : pos.x;
  if (portId === undefined) return { x, y: pos.y + tileHeight(tile) / 2 };
  const rowIndex = tile.ports.findIndex((port) => port.id === portId);
  const offset = rowIndex >= 0 ? portOffset(rowIndex) : tileHeight(tile) / 2;
  return { x, y: pos.y + offset };
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

/** Pin ELK routes to the exact rows React Flow renders for the final tile order. */
export function routeSectionsAtPositions(
  graph: ModelGraph,
  positions: Map<string, Position>,
  sections: Record<string, EdgeSection>,
): Record<string, EdgeSection> {
  const tileById = new Map(graph.tiles.map((tile) => [tile.id, tile]));
  const routed: Record<string, EdgeSection> = {};
  for (const edge of graph.edges) {
    const sourceTile = tileById.get(edge.source);
    const targetTile = tileById.get(edge.target);
    const sourcePosition = positions.get(edge.source);
    const targetPosition = positions.get(edge.target);
    if (!sourceTile || !targetTile || !sourcePosition || !targetPosition) continue;
    const source = portCoordinate(
      sourcePosition,
      sourceTile,
      portIdFromHandle(edge.sourceHandle),
      'source',
    );
    const target = portCoordinate(
      targetPosition,
      targetTile,
      portIdFromHandle(edge.targetHandle),
      'target',
    );
    const section = sections[edge.id];
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
  /** ELK-computed edge routes, keyed by edge id, written onto each edge's `data.section`. */
  const [edgeSections, setEdgeSections] = useState<Record<string, EdgeSection>>({});

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
      return resolvedGraph.tiles.map((tile) => ({
        id: tile.id,
        type: 'modelTile',
        position: positions.get(tile.id) ?? pinned.current[tile.id] ?? auto.current[tile.id] ?? { x: 0, y: 0 },
        data: {
          tile,
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
      }));
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
        stroke: edge.kind !== 'ownership' && edge.warn ? '#d4380d' : token.colorTextSecondary,
        strokeWidth: edge.kind === 'ownership' ? 2 : 2.5,
        strokeDasharray: edge.dashed ? '6 4' : edge.kind === 'ownership' ? '2 3' : undefined,
      } satisfies RoutedModelEdgeData,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    })));
  }, [resolvedGraph, layoutReady, edgeSections, presentation, safetyNamespace, handleExpand,
    onNavigateToNode, onNavigateToReference, onShowDetails, setNodes, setEdges, token]);

  /** Move every tile the user has not placed by hand. */
  const applyPositions = useCallback((positions: Record<string, Position>, respectPinned: boolean) => {
    setNodes((current) => current.map((node) => {
      if (respectPinned && pinned.current[node.id]) return node;
      const next = positions[node.id];
      return next ? { ...node, position: next } : node;
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
    const nextSections = routeSectionsAtPositions(current, posById, baselineSections.current);
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
      const finalSections = routeSectionsAtPositions(result.ordered, result.positions, result.edgeSections);

      if (rerouteTimer.current) {
        clearTimeout(rerouteTimer.current);
        rerouteTimer.current = null;
      }
      pinned.current = {};
      auto.current = Object.fromEntries(result.positions);
      baselineSections.current = finalSections;

      const tileById = new Map(orderedTiles.map((tile) => [tile.id, tile]));
      setNodes((current) => current.map((node) => ({
        ...node,
        position: result.positions.get(node.id) ?? node.position,
        data: {
          ...node.data,
          tile: tileById.get(node.id) ?? (node.data as ModelTileNodeData).tile,
        },
      })));
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
    void computeModelLayout(resolvedGraph).then(({ positions, edgeSections: sections, portOrder, ordered }) => {
      if (cancelled) return;
      auto.current = Object.fromEntries(positions);
      applyPositions(auto.current, true);
      setElkPortOrder(portOrder);

      const effectivePositions = new Map(positions);
      for (const [tileId, position] of Object.entries(pinned.current)) {
        effectivePositions.set(tileId, position);
      }
      const normalizedSections = routeSectionsAtPositions(ordered, effectivePositions, sections);
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
    </div>
  );
}
