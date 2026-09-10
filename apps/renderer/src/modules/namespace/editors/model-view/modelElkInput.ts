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
 * Pure helpers that turn a `ModelGraph` into ELK input and interpret ELK's
 * output for the model view (spec model-view-elk-layout, Task 2.1).
 *
 * These functions carry no React state and touch no DOM: they are the seam
 * between `buildModelGraph`'s render model and the shared `computeElkLayout`
 * layout engine. Keeping them here — rather than inline in `ModelViewCanvas` —
 * lets them be property-tested in isolation and keeps the canvas focused on
 * position ownership and rendering.
 *
 * Tile geometry constants are imported from `ModelTileNode` so `portOffset`
 * anchors each ELK port at the exact vertical centre of the row the tile will
 * render, and `tileHeight` reserves the same height the DOM will occupy.
 *
 * `computeModelLayout` is the one exception to "no ELK run here": it owns the
 * two-pass sequence described on it, which both of the canvas's layout entry
 * points need and neither should re-derive.
 */
import {
  computeElkLayout,
  type ElkLayoutInput,
  type ElkLayoutResult,
  type ElkNodeInput,
} from '../safety-analysis/utils/elkLayout';
import {
  HEADER_HEIGHT,
  PORT_LABEL_WIDTH,
  PORT_ROW_HEIGHT,
  TILE_PADDING,
  TILE_WIDTH,
  tileHeight,
} from './ModelTileNode';
import {
  TILE_SOURCE_HANDLE,
  TILE_TARGET_HANDLE,
  portSourceHandle,
  portTargetHandle,
  type ModelEdge,
  type ModelGraph,
  type ModelPort,
  type ModelTile,
} from './modelGraph';

const PORT_SOURCE_PREFIX = 'psrc-';
const PORT_TARGET_PREFIX = 'ptgt-';

/**
 * The straight run every route keeps at each of its two endpoints, and the
 * minimum distance any route keeps from the border of a tile — one number,
 * because both defects it fixes are the same defect measured differently.
 *
 * React Flow draws the arrow marker with `markerUnits="strokeWidth"`, so the
 * 12-unit marker on a 2.5-unit stroke occupies 12 x 2.5 = 30px, and its
 * `viewBox="-10 -10 20 20"` maps the arrow's 5-unit tail onto 5 x 30/20 = 7.5px
 * of path behind the endpoint. A corner nearer than that to the endpoint is not
 * "close to" the arrowhead — it is drawn underneath the filled triangle and
 * disappears. 24px is a little over three times that tail, so the last corner is
 * always visible, and the same 24px is what keeps a route's vertical runs off
 * the left and right borders of the tiles it attaches to.
 */
export const EDGE_ENDPOINT_STUB = 24;

/**
 * Clearance a frame keeps between its own border and the tiles nested inside it.
 *
 * Derived from `EDGE_ENDPOINT_STUB` rather than chosen, because this gap is not
 * only whitespace: it is the lane every **delegation** route runs in. A
 * delegation joins a frame's own port to a nested tile's port on the same side,
 * so the only horizontal room it has is this inset, and the router needs a stub
 * at each end of it — two stubs, hence twice the figure. Set it narrower and
 * `orthogonalSection` finds no room for the second stub, takes its
 * doubling-back branch, and draws the route *out through the frame's border* and
 * back in again.
 *
 * The extra margin is breathing room, so the frame border, the lane, and the
 * child read as three things rather than one thick smear.
 */
export const FRAME_INSET = EDGE_ENDPOINT_STUB * 2 + 8;

/**
 * Room a frame leaves on a border that carries its own ports.
 *
 * Historically this was the port column plus the delegation inset, because the
 * column was drawn *inside* the frame and a child laid out under it would have
 * been overlapped by the port names. The column now sits outside the border
 * (`ModelTileNode.portColumn`), so this band no longer reserves space for a
 * label — it is the lane every delegation route into that border runs along.
 *
 * The figure is kept rather than reduced to `FRAME_INSET`. Freeing the 150px
 * would narrow every frame and move its children, which is a layout change with
 * nothing to do with the overlap this band now prevents; and a wide lane is what
 * lets several delegations into neighbouring port rows take separate turns
 * instead of stacking onto one x. Narrowing it is a separate, measurable step.
 */
export const FRAME_PORT_BAND = PORT_LABEL_WIDTH + FRAME_INSET;

/**
 * Graph-level ELK options for the model view.
 *
 * Left-to-right flow, orthogonal routing, and greedy cycle-breaking with
 * feedback-edge lanes so cyclic graphs route without throwing.
 *
 * The four spacing values below are what stop a non-trivial model from being
 * drawn with its connections lying on the boxes. ELK's defaults for
 * `edgeNode`/`edgeEdge` are 10, which at a 2.5px stroke leaves a route grazing
 * a tile border rather than clearing it; they are raised to `EDGE_ENDPOINT_STUB`
 * so ELK's own baseline route already respects the clearance the client-side
 * re-route pass enforces at the endpoints. `nodeNode` is widened to fit a
 * horizontal edge lane plus that clearance on both sides between two stacked
 * tiles, and the between-layer gap widened with it so the router has lanes to
 * spread into instead of stacking edges against the boxes.
 *
 * `edgeEdge` is the separation between two parallel routes, and it is set from
 * `EDGE_ENDPOINT_STUB` rather than left at the 16 it used to be because a frame
 * full of delegations is mostly parallel routes. Measured on a frame with six
 * own inputs fanning out to three children — twelve delegations, and the router
 * lays them out cleanly: no segment within 24px of a border it does not attach
 * to, and no two drawn on top of one another. The complaint there is not that
 * the geometry is wrong but that it is dense: twelve lanes 16px apart, minus a
 * 2.5px stroke, is 13.5px of blank between neighbouring wires, and following one
 * of them to the port it ends at is guesswork. At 24 the gap is 21.5px. It costs
 * width — eight extra pixels per lane — which is the right trade for a diagram
 * whose purpose is to show what connects to what.
 */
export const MODEL_VIEW_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.feedbackEdges': 'true',
  'elk.spacing.nodeNode': '64',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.spacing.edgeNode': String(EDGE_ENDPOINT_STUB),
  'elk.layered.spacing.edgeNodeBetweenLayers': String(EDGE_ENDPOINT_STUB),
  'elk.spacing.edgeEdge': String(EDGE_ENDPOINT_STUB),
  'elk.layered.spacing.edgeEdgeBetweenLayers': String(EDGE_ENDPOINT_STUB),
};

/**
 * Vertical centre of the port row at `rowIndex` within a tile, in tile-local
 * layout units. Mirrors how `ModelTileNode` stacks rows: the header, then the
 * top padding, then `rowIndex` full rows, then half a row to reach the centre
 * of the current one. `tileHeight` uses the same constants, so a port's offset
 * always falls inside the node ELK reserves for the tile.
 */
export function portOffset(rowIndex: number): number {
  return HEADER_HEIGHT + TILE_PADDING + rowIndex * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2;
}

/**
 * Vertical centre of every one of a tile's port rows, keyed by port id, in
 * tile-local coordinates. The single source of that geometry: the ELK port
 * offsets, the client-side route pinning, and the DOM all read it from here, and
 * a disagreement between any two of them draws a connector off its own pin.
 *
 * An ordinary tile stacks all its ports in one column under the header, so the
 * row index is the offset — `portOffset`.
 *
 * A frame instead puts each direction against the border it faces and **centres
 * that column vertically** in the space below its header. Centred rather than
 * stacked at the top because a frame's ports are where the rest of the canvas
 * reaches it, and the rest of the canvas is level with its middle, not its title:
 * with the ports in a top band every delegation route had to run the full height
 * of the frame to get to a child, which is what made a frame full of actions read
 * as a bundle of long parallel wires down one side.
 *
 * `frameHeight` is what makes it a frame here, and it must be the height the DOM
 * will draw — the formula reproduces the `justify-content: center` the DOM uses,
 * so passing a different height silently offsets every route.
 *
 * **`elkOffsets` overrides the formula, and for a laid-out frame it always
 * should.** The centred stack is a guess made without knowing where the frame's
 * children ended up; ELK places the same ports knowing exactly that, and under
 * `INCLUDE_CHILDREN` it does so regardless of the positions it was handed for
 * them (measured: 135px to 205px away, in a different order — see
 * `ElkLayoutResult.portOffsets`). Whoever loses that argument has their geometry
 * translated onto the other's, and translating ELK's routes is what stopped them
 * avoiding the boxes they were routed around. So ELK wins, and the pins move to
 * where it put them.
 */
export function portRowOffsets(
  tile: ModelTile,
  frameHeight?: number,
  elkOffsets?: Record<string, number>,
): Map<string, number> {
  const offsets = new Map<string, number>();
  if (frameHeight === undefined) {
    tile.ports.forEach((port, rowIndex) => offsets.set(port.id, portOffset(rowIndex)));
    return offsets;
  }
  // A frame's ports are placed by ELK, not by this formula — see
  // `ElkLayoutResult.portOffsets`. Where ELK reported a port, that is where the
  // pin is drawn and where the route was anchored, so the two cannot disagree.
  // The centred stack below remains the fallback for a port ELK did not report
  // and for the first render, before any layout has run.
  if (elkOffsets !== undefined) {
    let complete = true;
    for (const port of tile.ports) {
      const reported = elkOffsets[port.id];
      if (reported === undefined) { complete = false; break; }
      offsets.set(port.id, reported);
    }
    if (complete) return offsets;
    offsets.clear();
  }
  for (const dir of ['in', 'out'] as const) {
    const column = tile.ports.filter((port) => port.dir === dir);
    if (column.length === 0) continue;
    const stack = column.length * PORT_ROW_HEIGHT;
    // The band is the frame below its header. Clamped so a frame too short for
    // its own ports overflows downward rather than up through the title.
    const band = Math.max(frameHeight - HEADER_HEIGHT, stack);
    const top = HEADER_HEIGHT + (band - stack) / 2;
    column.forEach((port, index) => {
      offsets.set(port.id, top + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2);
    });
  }
  return offsets;
}

/** Whether the tile has a port facing this border. */
function hasPortOn(tile: ModelTile, side: TileSide): boolean {
  return tile.ports.some((port) => (side === 'west' ? port.dir === 'in' : port.dir === 'out'));
}

/**
 * Smallest box a frame may occupy, whatever it contains.
 *
 * Tall enough for its header plus the taller of its two port columns, and never
 * shorter than the inset its children need — otherwise a frame with many ports
 * and one small child would centre its columns outside its own border.
 */
export function frameMinHeight(tile: ModelTile): number {
  const tallest = Math.max(
    tile.ports.filter((port) => port.dir === 'in').length,
    tile.ports.filter((port) => port.dir === 'out').length,
  );
  return HEADER_HEIGHT + Math.max(tallest * PORT_ROW_HEIGHT, 2 * FRAME_INSET);
}

/**
 * Group the nested tiles by the tile they are nested in.
 *
 * The render model records containment the way React Flow needs it — each tile
 * naming its parent — but the layout needs the inverse, since ELK is given a
 * frame with its children inside it. One shared derivation, so the canvas and
 * the layout cannot disagree about which tiles are frames.
 */
export function childrenByParent(tiles: ModelTile[]): Map<string, ModelTile[]> {
  const byParent = new Map<string, ModelTile[]>();
  for (const tile of tiles) {
    if (tile.parentId === undefined) continue;
    const siblings = byParent.get(tile.parentId);
    if (siblings) siblings.push(tile);
    else byParent.set(tile.parentId, [tile]);
  }
  return byParent;
}

/** Which border of a tile an edge endpoint attaches to. */
export type TileSide = 'west' | 'east';

/**
 * Whether an edge keeps each end on the border its own port faces, rather than
 * leaving right and arriving left.
 *
 * True for a *delegation* — a frame's own port and one of its children's are two
 * views of the same signal, so the link between them stays inside the frame — and
 * for a *self-connection*, where both ends are ports of one tile. Every other edge
 * runs between tiles that sit side by side and takes the peer rule.
 */
export function isDelegation(edge: ModelEdge, tiles: Map<string, ModelTile>): boolean {
  // A connection between two ports of the *same* element is not a delegation, but
  // it wants the identical treatment and for the same reason: the peer rule sends
  // it out of one border and back into the opposite one, which for a single tile
  // means leaving on the right and arriving on the left, so the route has to loop
  // all the way around the box. ELK anchors such a self-loop at the ports' own
  // sides, so the peer rule also disagrees with the route ELK planned and the
  // pinning drags it — the same failure the frame ports had.
  //
  // These exist in real exports. Simulink traces a signal through routing blocks
  // and both ends land on one element's own boundary, giving a pass-through: in
  // `ClstrCtrl.sysml`, `AvgClstrVolt` has two (`connect CmdBus_In to
  // CC_TaskFast_Out` and `connect Digital_In to CC_TaskFast_Out`), which is why
  // `CC_TaskFast` appeared to be wired to itself.
  if (edge.source === edge.target) return true;
  return tiles.get(edge.target)?.parentId === edge.source
    || tiles.get(edge.source)?.parentId === edge.target;
}

/**
 * Which border an edge endpoint sits on.
 *
 * Between two tiles side by side, a route leaves the source's **east** border and
 * arrives at the target's **west** one, whichever way the ports themselves face:
 * that is what makes a left-to-right diagram read left to right.
 *
 * A delegation cannot follow that rule. Its two ends are a frame and something
 * inside the frame, so "leave on the right, arrive on the left" sends the route
 * out of the frame and back in again — and worse, away from the pin the user can
 * see, since a frame's own pins are drawn on the border their direction puts them
 * on. So a delegation anchors **both** ends on the side the port faces, and the
 * route runs inward from there.
 */
export function anchorSide(
  role: 'source' | 'target',
  portDir: 'in' | 'out' | undefined,
  delegation: boolean,
): TileSide {
  if (delegation && portDir !== undefined) return portDir === 'in' ? 'west' : 'east';
  return role === 'source' ? 'east' : 'west';
}

/**
 * The room a frame has to leave inside its border, as an ELK padding vector.
 *
 * The top clears the frame's header. A border carrying the frame's own ports
 * clears the whole port column, so a child is never laid out under a port's name;
 * a border with no ports on it only needs the plain inset, which is why a frame
 * is not uniformly padded.
 */
export function framePadding(tile: ModelTile): string {
  const top = HEADER_HEIGHT + FRAME_INSET;
  const left = hasPortOn(tile, 'west') ? FRAME_PORT_BAND : FRAME_INSET;
  const right = hasPortOn(tile, 'east') ? FRAME_PORT_BAND : FRAME_INSET;
  return `[top=${top},left=${left},bottom=${FRAME_INSET},right=${right}]`;
}

/**
 * Recover the port id an edge handle anchors to.
 *
 * Connection edges attach to a port row via the `psrc-`/`ptgt-` prefixed
 * handles from `modelGraph.ts`; stripping the prefix yields the port id ELK
 * should terminate the edge at. Ownership edges use the tile-level handles
 * (`tsrc`/`ttgt`), which own no port — they return `undefined` so the edge
 * anchors at the node itself rather than a phantom port.
 */
export function portIdFromHandle(handle: string | undefined): string | undefined {
  if (!handle) return undefined;
  if (handle === TILE_SOURCE_HANDLE || handle === TILE_TARGET_HANDLE) return undefined;
  if (handle.startsWith(PORT_SOURCE_PREFIX)) return handle.slice(PORT_SOURCE_PREFIX.length);
  if (handle.startsWith(PORT_TARGET_PREFIX)) return handle.slice(PORT_TARGET_PREFIX.length);
  return undefined;
}

/**
 * Build the ELK layout input for a model graph.
 *
 * Each row has its normal ELK port (WEST for inputs, EAST for outputs). When
 * that row participates in the opposite connection role, add an anchor on the
 * other side at the same row offset. React Flow deliberately gives every row
 * a source handle on the right and a target handle on the left, including
 * InOutPort rows. Routing a source to its default WEST port instead makes the
 * endpoint correction drag the route through the tile.
 * Ownership edges anchor at the tile. The graph options are `MODEL_VIEW_LAYOUT_OPTIONS`.
 *
 * Containment enters as ELK hierarchy: a tile with a `parentId` is handed to ELK
 * as a *child* of that frame rather than as another node at the root, and the
 * frame gets `elk.padding` reserving its own chrome. Edges all stay declared at
 * the root whatever level their endpoints are on — ELK re-homes each one to the
 * lowest container holding both ends, and `computeElkLayout` normalises the
 * routes it returns back to canvas coordinates.
 *
 * `portConstraints` decides what ELK is allowed to do with those ports, and the
 * two passes of `computeModelLayout` want opposite things from it — see there.
 */
export function buildElkInput(
  graph: ModelGraph,
  portConstraints: 'FIXED_SIDE' | 'FIXED_POS' = 'FIXED_SIDE',
  frameSizes?: ElkLayoutResult['sizes'],
): ElkLayoutInput {
  const sourcePorts = new Set(graph.edges.map(edge => `${edge.source}|${portIdFromHandle(edge.sourceHandle)}`));
  const targetPorts = new Set(graph.edges.map(edge => `${edge.target}|${portIdFromHandle(edge.targetHandle)}`));
  const tiles = new Map(graph.tiles.map(tile => [tile.id, tile]));
  const endpointPort = (
    tileId: string, handle: string, role: 'source' | 'target', delegation: boolean,
  ) => {
    const portId = portIdFromHandle(handle);
    const port = tiles.get(tileId)?.ports.find(candidate => candidate.id === portId);
    if (port === undefined) return portId;
    // The `psrc-`/`ptgt-` ELK ports are the extra anchors on the *opposite* border,
    // and they exist only so a peer route can leave on the right and arrive on the
    // left. A delegation keeps each end on the border its port faces, so it uses
    // the port's own anchor — see `anchorSide`.
    const side = anchorSide(role, port.dir, delegation);
    const natural = port.dir === 'in' ? 'west' : 'east';
    return side === natural ? portId : handle;
  };
  const nestedIn = childrenByParent(graph.tiles);
  const toNode = (tile: ModelTile): ElkNodeInput => {
    const children = nestedIn.get(tile.id);
    // A frame's size is ELK's to decide — it has to fit whatever it contains —
    // so on the second pass the size the first pass settled on is fed back in.
    // Without it the frame goes in 260 wide again and `FIXED_POS` pins its EAST
    // port at x=260, a few hundred pixels inside its own right border, which is
    // where every route into that port would then be drawn.
    const measured = children ? frameSizes?.get(tile.id) : undefined;
    const width = Math.max(measured?.width ?? 0, TILE_WIDTH);
    const height = Math.max(measured?.height ?? 0, children ? frameMinHeight(tile) : tileHeight(tile));
    // A frame's ports are centred on its height, so their offsets depend on the
    // size decided above — which is why the second pass has to be told what the
    // first one measured.
    const offsets = portRowOffsets(tile, children ? height : undefined);
    const offsetOf = (portId: string) => offsets.get(portId) ?? height / 2;
    return {
      id: tile.id,
      width,
      height,
      layoutOptions: {
        'elk.portConstraints': portConstraints,
        // The given size stays a floor rather than a fixed value, so a frame
        // around one small child is still wide enough to read its title.
        ...(children
          ? {
            // A frame's interior is laid out against the frame's own options, not
            // the graph's, so the spacing tuned for this view has to be repeated
            // here. Left off, the inside falls back to ELK's defaults — roughly
            // 20px between layers instead of 160 — and the children end up packed
            // tight with their connectors flush against the boxes, which is
            // exactly the defect these numbers were chosen to fix.
            ...MODEL_VIEW_LAYOUT_OPTIONS,
            'elk.padding': framePadding(tile),
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            'elk.nodeSize.minimum': `(${width},${height})`,
          }
          : {}),
      },
      ports: tile.ports.flatMap((port) => {
        const offset = offsetOf(port.id);
        const ports = [{ id: port.id, side: port.dir === 'in' ? 'WEST' as const : 'EAST' as const, offset }];
        if (port.dir === 'in' && sourcePorts.has(`${tile.id}|${port.id}`)) {
          ports.push({ id: portSourceHandle(port.id), side: 'EAST', offset });
        }
        if (port.dir === 'out' && targetPorts.has(`${tile.id}|${port.id}`)) {
          ports.push({ id: portTargetHandle(port.id), side: 'WEST', offset });
        }
        return ports;
      }),
      ...(children ? { children: children.map(toNode) } : {}),
    };
  };

  return {
    // Only the tiles nothing contains go in at the root; a nested tile enters as
    // a child of its frame, which is how ELK is told to lay it out inside.
    nodes: graph.tiles.filter((tile) => tile.parentId === undefined).map(toNode),
    edges: graph.edges.map((edge: ModelEdge) => {
      const delegation = isDelegation(edge, tiles);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourcePort: endpointPort(edge.source, edge.sourceHandle, 'source', delegation),
        targetPort: endpointPort(edge.target, edge.targetHandle, 'target', delegation),
      };
    }),
    layoutOptions: MODEL_VIEW_LAYOUT_OPTIONS,
  };
}

/** A settled model layout: node positions, routed edges, and the row order. */
export interface ModelLayout {
  /**
   * Where each tile goes, in the frame that contains it — which is what React
   * Flow wants for a nested node, and identical to the absolute position for a
   * tile no frame contains.
   */
  positions: ElkLayoutResult['positions'];
  /**
   * The same positions resolved to canvas coordinates. The re-route pass works
   * in canvas space, because a route can run between two different frames.
   */
  absolutePositions: ElkLayoutResult['absolutePositions'];
  /**
   * What each tile measures. Only a frame needs this — ELK grew it around its
   * children, so its size is a layout result rather than a constant.
   */
  sizes: ElkLayoutResult['sizes'];
  edgeSections: ElkLayoutResult['edgeSections'];
  /** ELK's intra-side port order, to be fed back through `resolvePortOrder`. */
  portOrder: ElkLayoutResult['portOrder'];
  /**
   * Where ELK put each port on each node. Only a frame's entry is consumed, and
   * there it is authoritative — see `portRowOffsets`.
   */
  portOffsets: ElkLayoutResult['portOffsets'];
  /** `graph` with every tile's ports already resolved into that order. */
  ordered: ModelGraph;
}

/**
 * Lay out a model graph — in two ELK passes, because one pass cannot give both
 * things the view needs.
 *
 * **Pass 1, `FIXED_SIDE`.** The side of each port is fixed by its direction, but
 * ELK is free to order the ports within a side, and it orders them to reduce
 * edge crossings. That order is worth having: it is what `resolvePortOrder`
 * feeds back onto the tile so the rows render in it.
 *
 * **Pass 2, `FIXED_POS`.** `FIXED_SIDE` buys that ordering by also letting ELK
 * *move* the ports — it spreads them over the node's height by its own rules,
 * which have nothing to do with a 40px header and 26px rows. So the routes it
 * returns terminate at port positions the DOM will never draw, off by as much as
 * 87px on a tile with several rows per side. The canvas then pins each route's
 * endpoints onto the real rows and translates the rest to match, which drags
 * long horizontal runs sideways — straight through tiles the edge has nothing to
 * do with. Measured on a 14-tile mesh: ELK's own routes crossed no box at all,
 * and the pinned ones crossed five.
 *
 * So the second pass re-runs the layout with the rows in pass 1's order and the
 * port positions **fixed at the offsets the DOM will use**. ELK now routes
 * against the geometry that will actually be drawn, the endpoint pinning becomes
 * a no-op, and the box crossings go to zero. It costs a second layout call —
 * roughly 95ms to 180ms on a 30-tile model, behind the existing spinner.
 *
 * Pass 1's node sizes are handed to pass 2 along with the order, because a frame
 * is the one node whose size is a layout result rather than a constant, and
 * fixing a port's position means knowing which border it is fixed to.
 */
export async function computeModelLayout(graph: ModelGraph): Promise<ModelLayout> {
  const pass1 = await computeElkLayout(buildElkInput(graph, 'FIXED_SIDE'));
  const ordered: ModelGraph = {
    ...graph,
    tiles: graph.tiles.map((tile) => ({
      ...tile,
      ports: resolvePortOrder(tile, pass1.portOrder[tile.id]),
    })),
  };

  // A grid fallback means elkjs threw; a second pass would only throw again, and
  // the fallback carries no routes to improve on.
  if (pass1.mode !== 'elk') {
    return { ...pass1, ordered };
  }

  const pass2 = await computeElkLayout(buildElkInput(ordered, 'FIXED_POS', pass1.sizes));
  if (pass2.mode !== 'elk') return { ...pass1, ordered };

  // Pass 2 reports back the order it was given, so pass 1's stays authoritative
  // — for a leaf node, which honours the positions it was handed. A frame does
  // not, so its *offsets* come from pass 2, the layout that produced the routes.
  return {
    positions: pass2.positions,
    absolutePositions: pass2.absolutePositions,
    sizes: pass2.sizes,
    edgeSections: pass2.edgeSections,
    portOrder: pass1.portOrder,
    portOffsets: pass2.portOffsets,
    ordered,
  };
}

/**
 * Resolve the render order of a tile's ports from the order ELK laid them out
 * in. Side is never changed by reordering: the ports are partitioned into
 * inputs and outputs, each side sorted by ELK's rank, and inputs kept before
 * outputs. When ELK returned no order (initial render or grid fallback) the
 * tile's existing deterministic order from `buildModelGraph` is used unchanged.
 */
export function resolvePortOrder(tile: ModelTile, elkOrder: string[] | undefined): ModelPort[] {
  if (!elkOrder || elkOrder.length === 0) return tile.ports;
  const rank = new Map(elkOrder.map((id, index) => [id, index]));
  const inPorts = tile.ports.filter((port) => port.dir === 'in');
  const outPorts = tile.ports.filter((port) => port.dir === 'out');
  const byRank = (a: ModelPort, b: ModelPort) =>
    (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  return [...inPorts.sort(byRank), ...outPorts.sort(byRank)];
}

/**
 * Identity of the graph's *shape*, so layout re-runs on structure, not content.
 *
 * Each tile contributes its id and its port ids in the array's current
 * (resolved) render order; the edge id set follows. A content-only refetch
 * (names, malfunction markers) leaves this unchanged, so ELK does not re-run and
 * rows do not reshuffle. A genuine port-reorder or a change to the tile/edge set
 * produces a different signature and triggers a re-flow.
 */
export function structureSignature(graph: ModelGraph): string {
  const tiles = graph.tiles
    .map((tile) => `${tile.id}:${tile.ports.map((port) => port.id).join('>')}`)
    .join(',');
  const edges = graph.edges.map((edge) => edge.id).join(',');
  return `${tiles}|${edges}`;
}
