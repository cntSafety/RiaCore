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

export interface ElkLayoutInput {
  nodes: {
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
  }[];
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
  positions: Map<string, { x: number; y: number }>;
  /**
   * Routed edge geometry keyed by edge id. Additive. An edge id is present
   * only when elkjs produced a usable section for it (Req 1.4). Empty on the
   * grid fallback (Req 1.6).
   */
  edgeSections: Record<string, EdgeSection>;
  /**
   * ELK-computed intra-node port order keyed by node id: the port ids in the
   * top-to-bottom order ELK placed them (WEST and EAST reported separately by
   * y-coordinate). Additive; empty on the grid fallback.
   */
  portOrder: Record<string, string[]>;
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
    return { mode: 'empty', positions: new Map(), edgeSections: {}, portOrder: {} };
  }

  try {
    const graph = {
      id: 'root',
      layoutOptions: { ...ELK_OPTIONS, ...(input.layoutOptions ?? {}) },
      children: input.nodes.map((node) => ({
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
      })),
      edges: input.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.sourcePort ?? edge.source],
        targets: [edge.targetPort ?? edge.target],
      })),
    };

    const layoutedGraph = await elk.layout(graph);
    const positions = new Map<string, { x: number; y: number }>();
    const portOrder: Record<string, string[]> = {};
    const edgeSections: Record<string, EdgeSection> = {};

    for (const child of layoutedGraph.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });

      const ports = child.ports ?? [];
      if (ports.length > 0) {
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

        portOrder[child.id] = order;
      }
    }

    const layoutedEdges = (layoutedGraph.edges ?? []) as LayoutedEdge[];
    for (const edge of layoutedEdges) {
      const section = edge.sections?.[0];
      if (section && section.startPoint && section.endPoint) {
        edgeSections[edge.id] = {
          startPoint: { x: section.startPoint.x, y: section.startPoint.y },
          bendPoints: (section.bendPoints ?? []).map((bp) => ({ x: bp.x, y: bp.y })),
          endPoint: { x: section.endPoint.x, y: section.endPoint.y },
        };
      }
    }

    return { mode: 'elk', positions, edgeSections, portOrder };
  } catch (error) {
    console.error('[elkLayout] ELK layout failed, falling back to grid:', error);
    return fallbackGridLayout(input.nodes);
  }
}

function fallbackGridLayout(nodes: { id: string; width: number; height: number }[]): ElkLayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const COLS = 4;
  const H_SPACING = 300;
  const V_SPACING = 120;

  for (let i = 0; i < nodes.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    positions.set(nodes[i].id, { x: col * H_SPACING, y: row * V_SPACING });
  }

  return { mode: 'grid-fallback', positions, edgeSections: {}, portOrder: {} };
}
