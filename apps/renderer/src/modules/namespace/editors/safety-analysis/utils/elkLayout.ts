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

export interface ElkLayoutInput {
  nodes: {
    id: string;
    width: number;
    height: number;
    /**
     * Optional per-node ELK layout options (e.g. partitioning) merged onto the
     * ELK child. Backward compatible — omit for the default behavior.
     */
    layoutOptions?: Record<string, string>;
  }[];
  edges: { id: string; source: string; target: string }[];
  /**
   * Optional graph-level ELK layout options merged onto (and overriding) the
   * defaults. Backward compatible — omit for the default layered/RIGHT config.
   */
  layoutOptions?: Record<string, string>;
}

export interface ElkLayoutResult {
  positions: Map<string, { x: number; y: number }>;
}

export async function computeElkLayout(input: ElkLayoutInput): Promise<ElkLayoutResult> {
  if (input.nodes.length === 0) {
    return { positions: new Map() };
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
      })),
      edges: input.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    };

    const layoutedGraph = await elk.layout(graph);
    const positions = new Map<string, { x: number; y: number }>();

    for (const child of layoutedGraph.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }

    return { positions };
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

  return { positions };
}
