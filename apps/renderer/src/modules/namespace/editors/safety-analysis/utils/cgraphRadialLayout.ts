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
 * Radial "city" placement for the CGraph lens: the selected element at the
 * centre, its partners distributed on concentric rings around it.
 *
 * ## Why not a layered layout
 *
 * The lens used to hand the whole graph to ELK's `layered` algorithm. A star —
 * which every one of these graphs is, see below — through a layered algorithm
 * resolves to three columns: incoming partners in one layer, the selection in
 * the next, outgoing in a third. That is a correct drawing and a poor use of a
 * canvas. The aspect ratio grows with the partner count in one direction only,
 * so twelve partners produce a tall ribbon with two thirds of the viewport
 * empty, and every route is forced through the two narrow gaps beside the
 * selection.
 *
 * ## Why not ELK's own radial
 *
 * `org.eclipse.elk.radial` implements Eades' free-tree algorithm and takes a
 * *tree*. These graphs are not trees: a partner can both call into and be
 * called from the selection, and two partners can connect to different elements
 * inside it. It also supports neither `elk.hierarchyHandling` nor
 * `elk.padding`, so the frames that carry containment at depth 2 and above
 * would collapse. `elk.stress` has the same two gaps.
 *
 * What this takes from the literature is the part that applies:
 *
 * - **Concentric rings with the radius carrying an analysis result** rather than
 *   graph distance, after Brandes and Pich, ["More flexible radial
 *   layout"](https://kops.uni-konstanz.de/bitstreams/2a6d1ee5-eb02-4cd6-a1a5-006e32ee316c/download).
 *   Here the result is relationship weight: the partners with the most
 *   relationships to the selection sit on the innermost ring.
 * - **Annulus wedges allocated by node size** rather than by leaf count, which
 *   is the customisation ELK's radial layouter documents over plain Eades.
 *   A wide frame claims proportionally more of the circumference, so nothing
 *   overlaps without a separate overlap-removal pass.
 * - **A rotation that reduces crossings**, the same role the "translation
 *   optimization" phase plays in ELK's radial. Each ring is turned so that its
 *   members sit on the side of the selection where the elements they actually
 *   reach are drawn (see {@link preferredAngles}).
 *
 * ## Why the interiors need no graph layout
 *
 * A frame's children are *packed*, not laid out. The backend excludes
 * relationships internal to the selection's subtree and reports only those
 * crossing its boundary, so every edge has one end on the selection's side and
 * one outside it — and therefore no two children of the same frame are ever
 * connected. There is no intra-frame graph to draw, which is what makes a
 * near-square grid the right answer inside a frame and lets this whole layout
 * run synchronously.
 *
 * Kept free of imports from `cgraphAggregationGraph` beyond types: that module
 * owns the constants and calls this one, so taking them as {@link
 * RadialLayoutConfig} rather than importing them keeps the dependency one-way.
 */

import type { ElkLayoutResult } from './elkLayout';

interface Point { x: number; y: number }
interface Size { width: number; height: number }

/** Minimum a node has to declare for this layout: identity and its frame. */
export interface RadialLayoutNode {
  id: string;
  parentId?: string;
}

/** Minimum an edge has to declare: endpoints and the weight that ranks a ring. */
export interface RadialLayoutEdge {
  source: string;
  target: string;
  count: number;
}

export interface RadialLayoutConfig {
  /** Fixed size of a box with no children. */
  leafWidth: number;
  leafHeight: number;
  /** Room a frame reserves for its own title row. */
  frameHeader: number;
  /** Clearance between a frame's border and the boxes inside it. */
  framePadding: number;
  /** Gap between two boxes packed inside the same frame. */
  childGap: number;
  /** Clear space between the selection and the first ring, and between rings. */
  ringGap: number;
  /** Minimum arc between two neighbours on the same ring. */
  ringSpacing: number;
  /** Which node is the centre. */
  rootId: string;
}

/**
 * Same shape ELK's wrapper returns, so the canvas consumes either layout
 * identically — `mode` only widens, which is what the fallback banner reads.
 */
export interface AggregationLayoutResult extends Omit<ElkLayoutResult, 'mode'> {
  mode: ElkLayoutResult['mode'] | 'radial' | 'incremental';
}

const EMPTY_RESULT = (): AggregationLayoutResult => ({
  mode: 'empty',
  positions: new Map(),
  absolutePositions: new Map(),
  sizes: new Map(),
  edgeSections: {},
  portOrder: {},
  portOffsets: {},
});

/** The radius of the circle that circumscribes a box — its worst-case extent in any direction. */
function boundingRadius(size: Size): number {
  return Math.hypot(size.width, size.height) / 2;
}

export function computeRadialCityLayout<Node extends RadialLayoutNode>(
  graph: { nodes: readonly Node[]; edges: readonly RadialLayoutEdge[] },
  config: RadialLayoutConfig,
): AggregationLayoutResult {
  if (graph.nodes.length === 0) return EMPTY_RESULT();

  const positions = new Map<string, Point>();
  const absolutePositions = new Map<string, Point>();
  const sizes = new Map<string, Size>();

  const childrenOf = new Map<string, Node[]>();
  const parentOf = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.parentId === undefined) continue;
    parentOf.set(node.id, node.parentId);
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const topLevel = graph.nodes.filter((node) => node.parentId === undefined);

  /**
   * Pack one box's children and return the size that fits them, recursing
   * first so a nested frame is measured before the frame around it reserves
   * room for it. Columns are `ceil(sqrt(n))`, which keeps a frame roughly
   * square rather than letting a module with twenty files become a column
   * taller than the rest of the diagram.
   *
   * Child positions are set parent-relative here, which is both React Flow's
   * convention for a nested node and what `absolutePositions` is resolved from
   * below.
   */
  const pack = (node: Node): Size => {
    const children = childrenOf.get(node.id);
    if (!children || children.length === 0) {
      const leaf = { width: config.leafWidth, height: config.leafHeight };
      sizes.set(node.id, leaf);
      return leaf;
    }
    const childSizes = children.map((child) => pack(child));
    const columns = Math.ceil(Math.sqrt(children.length));
    let contentWidth = 0;
    let rowTop = 0;
    for (let start = 0; start < children.length; start += columns) {
      const end = Math.min(start + columns, children.length);
      let rowHeight = 0;
      let left = 0;
      for (let index = start; index < end; index += 1) {
        positions.set(children[index].id, {
          x: config.framePadding + left,
          y: config.frameHeader + config.framePadding + rowTop,
        });
        left += childSizes[index].width + config.childGap;
        rowHeight = Math.max(rowHeight, childSizes[index].height);
      }
      contentWidth = Math.max(contentWidth, left - config.childGap);
      rowTop += rowHeight + config.childGap;
    }
    const size = {
      width: Math.max(config.leafWidth, contentWidth + config.framePadding * 2),
      height: Math.max(config.leafHeight, (rowTop - config.childGap) + config.frameHeader + config.framePadding * 2),
    };
    sizes.set(node.id, size);
    return size;
  };
  for (const node of topLevel) pack(node);

  /** The top-level box an endpoint is drawn inside, which is what a ring places. */
  const topAncestor = (id: string): string => {
    let current = id;
    for (let step = 0; step <= graph.nodes.length; step += 1) {
      const parent = parentOf.get(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  };

  /** An endpoint's offset inside its own top-level box: the chain of relative positions. */
  const offsetWithinTop = (id: string): Point => {
    let x = 0;
    let y = 0;
    let current = id;
    for (let step = 0; step <= graph.nodes.length; step += 1) {
      if (parentOf.get(current) === undefined) break;
      const relative = positions.get(current) ?? { x: 0, y: 0 };
      x += relative.x;
      y += relative.y;
      current = parentOf.get(current)!;
    }
    return { x, y };
  };

  const rootNode = topLevel.find((node) => node.id === config.rootId);
  const rootSize = (rootNode && sizes.get(rootNode.id)) ?? { width: 0, height: 0 };
  const rootCenter = { x: rootSize.width / 2, y: rootSize.height / 2 };

  // Relationship weight per top-level box, and the elements inside the
  // selection that each partner reaches. Edges whose two ends resolve to the
  // same top-level box say nothing about where to put it.
  const weightOf = new Map<string, number>();
  const anchorsOf = new Map<string, string[]>();
  const addAnchor = (partner: string, anchor: string) => {
    if (anchor === config.rootId) return;
    const anchors = anchorsOf.get(partner);
    if (anchors) anchors.push(anchor);
    else anchorsOf.set(partner, [anchor]);
  };
  for (const edge of graph.edges) {
    const sourceTop = topAncestor(edge.source);
    const targetTop = topAncestor(edge.target);
    if (sourceTop === targetTop) continue;
    weightOf.set(sourceTop, (weightOf.get(sourceTop) ?? 0) + edge.count);
    weightOf.set(targetTop, (weightOf.get(targetTop) ?? 0) + edge.count);
    if (sourceTop === config.rootId) addAnchor(targetTop, edge.source);
    if (targetTop === config.rootId) addAnchor(sourceTop, edge.target);
  }

  /**
   * Where each partner "wants" to sit, as an angle around the selection.
   *
   * At depth 2 and above an edge does not end at the selection but at a
   * specific element packed inside it, and that element has already been given
   * a place by `pack`. Pointing the partner at the centroid of the elements it
   * reaches means its line crosses the selection's frame on the side where its
   * endpoint actually is, instead of running across the frame's whole interior
   * to get there.
   *
   * Absent at depth 1, where every edge ends at the selection itself and there
   * is no such signal — the weight order then decides the whole arrangement.
   */
  const preferredAngles = (): Map<string, number> => {
    const preferred = new Map<string, number>();
    for (const [partner, anchors] of anchorsOf) {
      let sumX = 0;
      let sumY = 0;
      for (const anchor of anchors) {
        const offset = offsetWithinTop(anchor);
        const size = sizes.get(anchor) ?? { width: config.leafWidth, height: config.leafHeight };
        sumX += offset.x + size.width / 2 - rootCenter.x;
        sumY += offset.y + size.height / 2 - rootCenter.y;
      }
      if (sumX === 0 && sumY === 0) continue;
      preferred.set(partner, Math.atan2(sumY, sumX));
    }
    return preferred;
  };
  const preferred = preferredAngles();

  const partners = topLevel
    .filter((node) => node.id !== config.rootId)
    .map((node, order) => ({
      id: node.id,
      order,
      size: sizes.get(node.id) ?? { width: config.leafWidth, height: config.leafHeight },
      weight: weightOf.get(node.id) ?? 0,
    }));
  // Heaviest first, so the innermost ring is the one worth reading.
  partners.sort((a, b) => b.weight - a.weight || a.order - b.order);

  /**
   * Fill rings outward, each taking partners until the next one would not fit
   * on its circumference. The arc a partner claims is its bounding diameter
   * plus the neighbour spacing, so a ring is full when those sum past `2πr` —
   * and because `r` grows with the ring, an outer ring holds more.
   *
   * The first member of a ring is always accepted, which is what bounds the
   * loop: a box too wide for any circumference still gets a ring of its own
   * rather than spinning here.
   */
  const rings: { radius: number; demand: number; members: typeof partners }[] = [];
  let index = 0;
  let inner = boundingRadius(rootSize) + config.ringGap;
  while (index < partners.length) {
    const members: typeof partners = [];
    let widest = 0;
    let demand = 0;
    while (index < partners.length) {
      const candidate = partners[index];
      const radius = boundingRadius(candidate.size);
      const nextWidest = Math.max(widest, radius);
      const nextDemand = demand + radius * 2 + config.ringSpacing;
      if (members.length > 0 && nextDemand > 2 * Math.PI * (inner + nextWidest)) break;
      members.push(candidate);
      widest = nextWidest;
      demand = nextDemand;
      index += 1;
    }
    rings.push({ radius: inner + widest, demand, members });
    inner += widest * 2 + config.ringGap;
  }

  for (const ring of rings) {
    // Stable sort, so members with no preferred angle keep their weight order
    // behind the ones that have one.
    ring.members.sort((a, b) => {
      const left = preferred.get(a.id);
      const right = preferred.get(b.id);
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right;
    });

    let cursor = 0;
    const assigned = ring.members.map((member) => {
      const share = (boundingRadius(member.size) * 2 + config.ringSpacing) / ring.demand;
      const angle = cursor + share * Math.PI;
      cursor += share * 2 * Math.PI;
      return angle;
    });

    // One rotation for the whole ring, as the circular mean of how far each
    // member is from where it wanted to be. Rotating is free — it preserves the
    // spacing the wedges just established — where moving a single member is not.
    let rotationX = 0;
    let rotationY = 0;
    ring.members.forEach((member, position) => {
      const want = preferred.get(member.id);
      if (want === undefined) return;
      rotationX += Math.cos(want - assigned[position]);
      rotationY += Math.sin(want - assigned[position]);
    });
    const rotation = rotationX === 0 && rotationY === 0 ? 0 : Math.atan2(rotationY, rotationX);

    ring.members.forEach((member, position) => {
      const angle = assigned[position] + rotation;
      positions.set(member.id, {
        x: rootCenter.x + Math.cos(angle) * ring.radius - member.size.width / 2,
        y: rootCenter.y + Math.sin(angle) * ring.radius - member.size.height / 2,
      });
    });
  }

  if (rootNode) positions.set(rootNode.id, { x: 0, y: 0 });

  // Shift the whole arrangement into positive coordinates. Only the top level
  // moves: a nested position is relative to its frame and travels with it.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of topLevel) {
    const position = positions.get(node.id);
    if (!position) continue;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
  }
  if (Number.isFinite(minX) && Number.isFinite(minY)) {
    for (const node of topLevel) {
      const position = positions.get(node.id);
      if (!position) continue;
      positions.set(node.id, { x: position.x - minX, y: position.y - minY });
    }
  }

  const resolve = (node: Node, parent: Point): void => {
    const relative = positions.get(node.id) ?? { x: 0, y: 0 };
    const absolute = { x: parent.x + relative.x, y: parent.y + relative.y };
    absolutePositions.set(node.id, absolute);
    for (const child of childrenOf.get(node.id) ?? []) resolve(child, absolute);
  };
  for (const node of topLevel) resolve(node, { x: 0, y: 0 });

  return { mode: 'radial', positions, absolutePositions, sizes, edgeSections: {}, portOrder: {}, portOffsets: {} };
}
