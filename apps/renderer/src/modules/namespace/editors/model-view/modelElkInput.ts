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
import { computeElkLayout, type ElkLayoutInput, type ElkLayoutResult } from '../safety-analysis/utils/elkLayout';
import {
  HEADER_HEIGHT,
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
  'elk.spacing.edgeEdge': '16',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
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
 * `portConstraints` decides what ELK is allowed to do with those ports, and the
 * two passes of `computeModelLayout` want opposite things from it — see there.
 */
export function buildElkInput(
  graph: ModelGraph,
  portConstraints: 'FIXED_SIDE' | 'FIXED_POS' = 'FIXED_SIDE',
): ElkLayoutInput {
  const sourcePorts = new Set(graph.edges.map(edge => `${edge.source}|${portIdFromHandle(edge.sourceHandle)}`));
  const targetPorts = new Set(graph.edges.map(edge => `${edge.target}|${portIdFromHandle(edge.targetHandle)}`));
  const tiles = new Map(graph.tiles.map(tile => [tile.id, tile]));
  const endpointPort = (tileId: string, handle: string, role: 'source' | 'target') => {
    const portId = portIdFromHandle(handle);
    const port = tiles.get(tileId)?.ports.find(candidate => candidate.id === portId);
    const oppositeSide = port && (role === 'source' ? port.dir === 'in' : port.dir === 'out');
    return oppositeSide ? handle : portId;
  };
  return {
    nodes: graph.tiles.map((tile) => ({
      id: tile.id,
      width: TILE_WIDTH,
      height: tileHeight(tile),
      layoutOptions: { 'elk.portConstraints': portConstraints },
      ports: tile.ports.flatMap((port, rowIndex) => {
        const ports = [{ id: port.id, side: port.dir === 'in' ? 'WEST' as const : 'EAST' as const, offset: portOffset(rowIndex) }];
        if (port.dir === 'in' && sourcePorts.has(`${tile.id}|${port.id}`)) {
          ports.push({ id: portSourceHandle(port.id), side: 'EAST', offset: portOffset(rowIndex) });
        }
        if (port.dir === 'out' && targetPorts.has(`${tile.id}|${port.id}`)) {
          ports.push({ id: portTargetHandle(port.id), side: 'WEST', offset: portOffset(rowIndex) });
        }
        return ports;
      }),
    })),
    edges: graph.edges.map((edge: ModelEdge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourcePort: endpointPort(edge.source, edge.sourceHandle, 'source'),
      targetPort: endpointPort(edge.target, edge.targetHandle, 'target'),
    })),
    layoutOptions: MODEL_VIEW_LAYOUT_OPTIONS,
  };
}

/** A settled model layout: node positions, routed edges, and the row order. */
export interface ModelLayout {
  positions: ElkLayoutResult['positions'];
  edgeSections: ElkLayoutResult['edgeSections'];
  /** ELK's intra-side port order, to be fed back through `resolvePortOrder`. */
  portOrder: ElkLayoutResult['portOrder'];
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

  const pass2 = await computeElkLayout(buildElkInput(ordered, 'FIXED_POS'));
  if (pass2.mode !== 'elk') return { ...pass1, ordered };

  // Pass 2 reports back the order it was given, so pass 1's stays authoritative.
  return {
    positions: pass2.positions,
    edgeSections: pass2.edgeSections,
    portOrder: pass1.portOrder,
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
