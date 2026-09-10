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
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '50',
  'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
  'elk.edgeRouting': 'ORTHOGONAL',
};

export type ElkPortSide = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH';

export interface ElkPortInput {
  /** Port id — must be unique within the node and is what edges reference. */
  id: string;
  /** Fixed side. Model view uses WEST for inputs, EAST for outputs. */
  side: ElkPortSide;
  /**
   * Optional cross-axis offset from the node origin, in layout units, used to
   * anchor the port at the rendered row: the y for WEST/EAST, the x for
   * NORTH/SOUTH. When omitted ELK picks an offset itself.
   *
   * Supplying this also pins the *along*-axis coordinate to the node's border
   * for that side, which is what `elk.portConstraints: FIXED_POS` needs to place
   * the port where the DOM will actually draw it. Under `FIXED_SIDE` ELK
   * overrides both, so passing them costs nothing there.
   */
  offset?: number;
}

export interface ElkNodeInput {
  id: string;
  width: number;
  height: number;
  /**
   * Optional per-node ELK layout options (e.g. partitioning, portConstraints)
   * merged onto the ELK child. Backward compatible — omit for the default
   * behavior.
   */
  layoutOptions?: Record<string, string>;
  /**
   * Optional real ELK ports. Backward compatible — omit for the existing
   * node-only behavior used by PropagationCanvas and WorkspaceCanvas.
   */
  ports?: ElkPortInput[];
  /**
   * Nested children, making this a compound node.
   *
   * ELK sizes a compound node to fit its children, so `width`/`height` act as a
   * minimum here rather than the final size — read the computed size back from
   * {@link ElkLayoutResult.sizes}. Reserve room for the node's own label and
   * ports with `elk.padding` in {@link layoutOptions}, or the children will be
   * laid out over the top of them.
   */
  children?: ElkNodeInput[];
}

export interface ElkLayoutInput {
  nodes: ElkNodeInput[];
  edges: {
    id: string;
    source: string;
    target: string;
    /** Optional endpoint port refs. Must match a `ports[].id` on the node. */
    sourcePort?: string;
    targetPort?: string;
  }[];
  /**
   * Optional graph-level ELK layout options merged onto (and overriding) the
   * defaults. Backward compatible — omit for the default layered/RIGHT config.
   */
  layoutOptions?: Record<string, string>;
}

export interface ElkPoint {
  x: number;
  y: number;
}

export interface EdgeSection {
  startPoint: ElkPoint;
  bendPoints: ElkPoint[];
  endPoint: ElkPoint;
}

export interface ElkLayoutResult {
  /** Which engine produced this result, exposed for UI diagnostics. */
  mode: 'elk' | 'grid-fallback' | 'empty';
  /**
   * Node positions in ELK's own frame: relative to the parent for a nested node,
   * absolute for a top-level one. This is deliberately the same convention React
   * Flow uses for a child node's `position`, so it can be assigned straight
   * across whether or not the node is nested.
   */
  positions: Map<string, { x: number; y: number }>;
  /**
   * The same nodes resolved through their whole ancestor chain. Anything doing
   * geometry — hit-testing, re-routing an edge between two tiles — needs these,
   * because a parent-relative position means nothing on its own.
   *
   * Identical to {@link positions} when no node is nested.
   */
  absolutePositions: Map<string, { x: number; y: number }>;
  /**
   * Laid-out node sizes, keyed by node id. Only interesting for compound nodes,
   * whose size ELK computes from their children rather than taking from the
   * input.
   */
  sizes: Map<string, { width: number; height: number }>;
  /**
   * Routed edge geometry keyed by edge id, in absolute coordinates. Additive. An
   * edge id is present only when elkjs produced a usable section for it
   * (Req 1.4). Empty on the grid fallback (Req 1.6).
   *
   * "Absolute" is not what ELK returns and is the whole reason this is
   * normalised here — see {@link collectLayout}.
   */
  edgeSections: Record<string, EdgeSection>;
  /**
   * ELK-computed intra-node port order keyed by node id: the port ids in the
   * top-to-bottom order ELK placed them (WEST and EAST reported separately by
   * y-coordinate). Additive; empty on the grid fallback.
   */
  portOrder: Record<string, string[]>;
  /**
   * Where ELK actually put each port, along the border it sits on, relative to
   * its own node — the y for a WEST/EAST port, the x for a NORTH/SOUTH one.
   * Keyed by node id then port id. Additive; empty on the grid fallback.
   *
   * This is {@link portOrder}'s underlying measurement rather than a second view
   * of it, and it is reported because for some nodes ELK's placement is the
   * *authority* rather than an input. `elk.portConstraints: FIXED_POS` is
   * honoured for a leaf node, but a compound node laid out under
   * `elk.hierarchyHandling: INCLUDE_CHILDREN` has its own ports placed by the
   * flattened layout, which moves them to reduce crossings and ignores the
   * offsets supplied for them. Measured on a 3-node model-view graph: a frame's
   * own ports came back between 135px and 205px away from the offsets they were
   * pinned at, and in a different top-to-bottom order.
   *
   * A caller that draws such a node has to draw its ports here, or every route
   * ELK planned gets translated by that error and stops avoiding the obstacles
   * it was routed around.
   */
  portOffsets: Record<string, Record<string, number>>;
}

const PORT_SIDE_ORDER: ElkPortSide[] = ['WEST', 'EAST', 'NORTH', 'SOUTH'];

/**
 * The elkjs return type is inferred from the input graph literal (which has no
 * routing sections), so we read the laid-out edges through this shape.
 */
interface LayoutedEdge {
  id: string;
  sections?: {
    startPoint?: ElkPoint;
    endPoint?: ElkPoint;
    bendPoints?: ElkPoint[];
  }[];
  /**
   * The node whose coordinate frame this edge's sections are expressed in, as
   * elkjs reports it. Present whenever hierarchy is in play; `'root'` for a
   * top-level edge, which is the case where the points are already absolute.
   */
  container?: string;
}

/** The laid-out graph, read back through the shape we actually care about. */
interface LayoutedNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ports?: { id: string; x?: number; y?: number; layoutOptions?: Record<string, unknown> }[];
  edges?: LayoutedEdge[];
  children?: LayoutedNode[];
}

interface LayoutAccumulator {
  positions: Map<string, { x: number; y: number }>;
  absolutePositions: Map<string, { x: number; y: number }>;
  sizes: Map<string, { width: number; height: number }>;
  edgeSections: Record<string, EdgeSection>;
  portOrder: Record<string, string[]>;
  portOffsets: Record<string, Record<string, number>>;
}

/**
 * Where each of a node's ports ended up along its own border — see
 * {@link ElkLayoutResult.portOffsets}. A NORTH/SOUTH port is measured across the
 * node's width, every other one down its height.
 */
function readPortOffsets(node: LayoutedNode): Record<string, number> | undefined {
  const ports = node.ports ?? [];
  if (ports.length === 0) return undefined;
  const offsets: Record<string, number> = {};
  for (const port of ports) {
    const side = (port.layoutOptions?.['elk.port.side'] as string | undefined) ?? '';
    offsets[port.id] = side === 'NORTH' || side === 'SOUTH' ? (port.x ?? 0) : (port.y ?? 0);
  }
  return offsets;
}

/** ELK reports a node's ports per side; the model view wants them top-to-bottom. */
function readPortOrder(node: LayoutedNode): string[] | undefined {
  const ports = node.ports ?? [];
  if (ports.length === 0) return undefined;

  const bySide = new Map<string, { id: string; y: number }[]>();
  for (const port of ports) {
    const side = (port.layoutOptions?.['elk.port.side'] as string | undefined) ?? '';
    const bucket = bySide.get(side) ?? [];
    bucket.push({ id: port.id, y: port.y ?? 0 });
    bySide.set(side, bucket);
  }

  const order: string[] = [];
  const emit = (side: string) => {
    const bucket = bySide.get(side);
    if (!bucket) return;
    bucket.sort((a, b) => a.y - b.y);
    for (const entry of bucket) order.push(entry.id);
    bySide.delete(side);
  };
  for (const side of PORT_SIDE_ORDER) emit(side);
  // Any remaining/unknown sides, in a stable key order.
  for (const side of [...bySide.keys()].sort()) emit(side);
  return order;
}

const ORIGIN = { x: 0, y: 0 };

/**
 * Walk the laid-out graph, recording node geometry and normalising every edge
 * route to absolute coordinates.
 *
 * ELK reports two different frames of reference and only one of them is absolute:
 *
 * - a node's `x`/`y` are relative to its parent, so an absolute position is the
 *   running sum down the ancestor chain;
 * - an edge's `sections[]` points are relative to **the node that contains the
 *   edge**, which is neither the edge's source node nor necessarily where the
 *   caller declared it. ELK re-homes an edge between two children to their
 *   common ancestor and names that node in `edge.container`. A `root` container
 *   means the points are already absolute.
 *
 * That last part is what makes getting this wrong so confusing: the top-level
 * routes look perfect and only the nested ones are displaced, each by its own
 * container's offset, which reads as "some routes are random" rather than "one
 * transform is missing". Normalising here means everything downstream —
 * `RoutedModelEdge`, the canvas re-router — keeps working in a single flat
 * coordinate space and needs to know none of this.
 *
 * Two passes, because an edge's offset is the absolute position of a node that
 * may be laid out after it: geometry first, then routes.
 */
function collectLayout(root: LayoutedNode, into: LayoutAccumulator): void {
  const walkGeometry = (node: LayoutedNode, parentX: number, parentY: number): void => {
    const absoluteX = parentX + (node.x ?? 0);
    const absoluteY = parentY + (node.y ?? 0);
    for (const child of node.children ?? []) {
      into.positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
      into.absolutePositions.set(child.id, {
        x: absoluteX + (child.x ?? 0),
        y: absoluteY + (child.y ?? 0),
      });
      if (child.width !== undefined && child.height !== undefined) {
        into.sizes.set(child.id, { width: child.width, height: child.height });
      }
      const order = readPortOrder(child);
      if (order) into.portOrder[child.id] = order;
      const offsets = readPortOffsets(child);
      if (offsets) into.portOffsets[child.id] = offsets;
      walkGeometry(child, absoluteX, absoluteY);
    }
  };
  walkGeometry(root, 0, 0);

  // `container` is authoritative where elkjs supplies it. The enclosing node is
  // the fallback, for the other serialisation of the same model — edges nested
  // under the node that owns them, with no `container` field.
  const walkEdges = (node: LayoutedNode, enclosingId: string): void => {
    for (const edge of node.edges ?? []) {
      const section = edge.sections?.[0];
      if (!section?.startPoint || !section.endPoint) continue;
      // An unknown or root container resolves to the origin, leaving the points
      // as ELK gave them — which is correct, because those are the absolute ones.
      const offset = into.absolutePositions.get(edge.container ?? enclosingId) ?? ORIGIN;
      const shift = (point: ElkPoint) => ({ x: point.x + offset.x, y: point.y + offset.y });
      into.edgeSections[edge.id] = {
        startPoint: shift(section.startPoint),
        bendPoints: (section.bendPoints ?? []).map(shift),
        endPoint: shift(section.endPoint),
      };
    }
    for (const child of node.children ?? []) walkEdges(child, child.id);
  };
  walkEdges(root, root.id);
}

/** Map one input node, and its children, onto the elkjs graph shape. */
function toElkNode(node: ElkNodeInput): { id: string } & Record<string, unknown> {
  return {
    id: node.id,
    width: node.width,
    height: node.height,
    ...(node.layoutOptions ? { layoutOptions: node.layoutOptions } : {}),
    ...(node.ports && node.ports.length > 0
      ? {
        ports: node.ports.map((port) => ({
          id: port.id,
          layoutOptions: { 'elk.port.side': port.side },
          ...(port.offset !== undefined ? portPosition(port, node) : {}),
          width: 1,
          height: 1,
        })),
      }
      : {}),
    ...(node.children && node.children.length > 0
      ? { children: node.children.map(toElkNode) }
      : {}),
  };
}

/** Whether any node in the input is a compound node. */
function hasNesting(nodes: ElkNodeInput[]): boolean {
  return nodes.some((node) => (node.children?.length ?? 0) > 0 || hasNesting(node.children ?? []));
}

/** Every node id in the input, at any depth. */
function flattenNodes(nodes: ElkNodeInput[]): ElkNodeInput[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
}

/**
 * The port's position relative to its node: `offset` along the border it sits
 * on, and the border's own coordinate across it. Without the second half a
 * `FIXED_POS` graph puts every port at x=0 — an EAST port would be pinned to
 * the node's *left* edge, and every route to it drawn to the wrong side.
 */
function portPosition(
  port: ElkPortInput,
  node: { width: number; height: number },
): { x: number; y: number } {
  switch (port.side) {
    case 'WEST': return { x: 0, y: port.offset! };
    case 'EAST': return { x: node.width, y: port.offset! };
    case 'NORTH': return { x: port.offset!, y: 0 };
    default: return { x: port.offset!, y: node.height };
  }
}

export async function computeElkLayout(input: ElkLayoutInput): Promise<ElkLayoutResult> {
  if (input.nodes.length === 0) {
    return {
      mode: 'empty',
      positions: new Map(),
      absolutePositions: new Map(),
      sizes: new Map(),
      edgeSections: {},
      portOrder: {},
      portOffsets: {},
    };
  }

  try {
    const graph = {
      id: 'root',
      layoutOptions: {
        ...ELK_OPTIONS,
        // Only when something is actually nested. Layered's default resolves to
        // SEPARATE_CHILDREN, which lays each level out on its own and will not
        // route an edge that crosses levels — but setting it unconditionally
        // would change the plan for the flat graphs the other canvases pass.
        ...(hasNesting(input.nodes) ? { 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' } : {}),
        ...(input.layoutOptions ?? {}),
      },
      children: input.nodes.map(toElkNode),
      // Every edge is declared at the root, including the ones that cross into a
      // compound node. ELK re-homes those itself, and `collectLayout` finds them
      // wherever they end up.
      edges: input.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.sourcePort ?? edge.source],
        targets: [edge.targetPort ?? edge.target],
      })),
    };

    const layoutedGraph = await elk.layout(graph);
    const accumulator: LayoutAccumulator = {
      positions: new Map(),
      absolutePositions: new Map(),
      sizes: new Map(),
      edgeSections: {},
      portOrder: {},
      portOffsets: {},
    };
    collectLayout(layoutedGraph as LayoutedNode, accumulator);

    return { mode: 'elk', ...accumulator };
  } catch (error) {
    console.error('[elkLayout] ELK layout failed, falling back to grid:', error);
    return fallbackGridLayout(flattenNodes(input.nodes));
  }
}

function fallbackGridLayout(nodes: { id: string; width: number; height: number }[]): ElkLayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  const COLS = 4;
  const H_SPACING = 300;
  const V_SPACING = 120;

  for (let i = 0; i < nodes.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    positions.set(nodes[i].id, { x: col * H_SPACING, y: row * V_SPACING });
    sizes.set(nodes[i].id, { width: nodes[i].width, height: nodes[i].height });
  }

  // The grid is flat by construction, so nesting collapses away and the two
  // position maps coincide.
  return {
    mode: 'grid-fallback',
    positions,
    absolutePositions: new Map(positions),
    sizes,
    edgeSections: {},
    portOrder: {},
    portOffsets: {},
  };
}
