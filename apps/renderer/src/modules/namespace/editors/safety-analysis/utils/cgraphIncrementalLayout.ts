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
 * Incremental placement for an expanded CGraph lens: keep every box where it
 * is, and find space for the new ones near the box they were expanded from.
 *
 * ## Why this is not a layout mode
 *
 * The Layout control picks how the diagram is arranged *from scratch* — radially
 * or in ELK's layered columns. This runs instead of either of them, whichever
 * one produced the arrangement on screen, because what it has to preserve is
 * that arrangement rather than reproduce the rule behind it. Re-running the
 * chosen algorithm on the grown graph is what "Auto Layout" is for, and keeping
 * the two separate is what lets a reader follow a chain of expansions without
 * the canvas rearranging under them at each step.
 *
 * So the dispatch is: no hint → full layout by mode; hint → this.
 *
 * ## What is allowed to move
 *
 * Nothing at the top level. Every box that already had a position keeps its
 * exact coordinates, including a frame that grew.
 *
 * Inside a frame that gained children, everything re-packs. A frame's size is a
 * function of its contents, so a frame that gains a box must grow, and growing
 * means its own children have to be re-laid out; the alternative is appending
 * into whatever gap happens to be free, which degrades a little further with
 * every expansion. The frame's *origin* is pinned, so the growth is downward
 * and rightward and the reader's spatial anchor survives. A frame whose
 * contents did not change keeps its previous size and its children's previous
 * relative positions exactly.
 *
 * Two consequences worth stating. A grown frame can overlap a neighbouring
 * top-level box, because the neighbour is not allowed to move out of the way —
 * new boxes avoid the grown rectangle, but existing ones stay put. And nothing
 * is normalised to positive coordinates: shifting the whole diagram to clear
 * negative space would move every existing box, which is the one thing this
 * must not do. The canvas handles negative coordinates and computes its own
 * bounds.
 */

import type { AggregationLayoutResult } from './cgraphRadialLayout';

interface Point { x: number; y: number }
interface Size { width: number; height: number }
interface Rect { x: number; y: number; width: number; height: number }

export interface IncrementalLayoutNode {
  id: string;
  parentId?: string;
}

export interface IncrementalLayoutConfig {
  leafWidth: number;
  leafHeight: number;
  frameHeader: number;
  framePadding: number;
  childGap: number;
  /** Radial step between candidate rings when searching for free space. */
  ringGap: number;
  /** Minimum space kept between two boxes placed at the top level. */
  clearance: number;
}

/**
 * The arrangement currently on screen. Both position maps are needed for the
 * same reason the layout returns both: a nested box's stored position is
 * relative to its frame, and a top-level box's is absolute.
 */
export interface AggregationLayoutHint {
  positions: Map<string, Point>;
  absolutePositions: Map<string, Point>;
  sizes: Map<string, Size>;
  /** The box new ones should cluster around — normally the one just expanded. */
  anchorId?: string;
}

/** How many rings out to search before giving up and parking the box past everything. */
const MAX_SEARCH_RINGS = 24;

function overlaps(a: Rect, b: Rect, clearance: number): boolean {
  return a.x < b.x + b.width + clearance
    && b.x < a.x + a.width + clearance
    && a.y < b.y + b.height + clearance
    && b.y < a.y + a.height + clearance;
}

export function computeIncrementalLayout<Node extends IncrementalLayoutNode>(
  graph: { nodes: readonly Node[] },
  config: IncrementalLayoutConfig,
  hint: AggregationLayoutHint,
): AggregationLayoutResult {
  const positions = new Map<string, Point>();
  const absolutePositions = new Map<string, Point>();
  const sizes = new Map<string, Size>();

  const childrenOf = new Map<string, Node[]>();
  for (const node of graph.nodes) {
    if (node.parentId === undefined) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const topLevel = graph.nodes.filter((node) => node.parentId === undefined);

  /**
   * Size one box and, if it is a frame, position what is inside it.
   *
   * Returns whether the box's own geometry changed, which is what propagates
   * the re-pack upward: a frame whose child grew has to grow too, even though
   * none of its own children are new.
   */
  const measure = (node: Node): { size: Size; changed: boolean } => {
    const children = childrenOf.get(node.id);
    if (!children || children.length === 0) {
      const size = { width: config.leafWidth, height: config.leafHeight };
      sizes.set(node.id, size);
      // A leaf's size is a constant, so the only thing that can have changed
      // about it is whether it existed at all.
      return { size, changed: !hint.sizes.has(node.id) };
    }

    const measured = children.map((child) => measure(child));
    const previousSize = hint.sizes.get(node.id);
    const reusable = measured.every((entry) => !entry.changed)
      && previousSize !== undefined
      && children.every((child) => hint.positions.has(child.id));
    if (reusable) {
      for (const child of children) positions.set(child.id, hint.positions.get(child.id)!);
      sizes.set(node.id, previousSize);
      return { size: previousSize, changed: false };
    }

    // Same near-square packing the radial layout uses, so a frame looks the
    // same whether it was built from scratch or grown into.
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
        left += measured[index].size.width + config.childGap;
        rowHeight = Math.max(rowHeight, measured[index].size.height);
      }
      contentWidth = Math.max(contentWidth, left - config.childGap);
      rowTop += rowHeight + config.childGap;
    }
    const size = {
      width: Math.max(config.leafWidth, contentWidth + config.framePadding * 2),
      height: Math.max(config.leafHeight, (rowTop - config.childGap) + config.frameHeader + config.framePadding * 2),
    };
    sizes.set(node.id, size);
    return { size, changed: true };
  };
  for (const node of topLevel) measure(node);

  const sizeOf = (id: string): Size => sizes.get(id) ?? { width: config.leafWidth, height: config.leafHeight };
  const rectOf = (id: string, at: Point): Rect => ({ x: at.x, y: at.y, ...sizeOf(id) });

  // Everything that already had a place keeps it, and is registered as an
  // obstacle — at its *new* size, so a frame that grew is avoided at the extent
  // it now occupies rather than the one it used to.
  const occupied: Rect[] = [];
  const pending: Node[] = [];
  for (const node of topLevel) {
    const previous = hint.absolutePositions.get(node.id);
    if (!previous) { pending.push(node); continue; }
    positions.set(node.id, previous);
    occupied.push(rectOf(node.id, previous));
  }

  /**
   * Where to grow from: the expanded box, or failing that the middle of what is
   * already drawn. An expansion's partners belong next to the element they were
   * expanded from — that adjacency is the whole reason to place incrementally
   * rather than re-run the layout.
   */
  const anchorPosition = hint.anchorId !== undefined
    ? (positions.get(hint.anchorId) ?? hint.absolutePositions.get(hint.anchorId))
    : undefined;
  const anchor: Rect = anchorPosition && hint.anchorId !== undefined
    ? rectOf(hint.anchorId, anchorPosition)
    : centreOf(occupied, config);

  for (const node of pending) {
    const size = sizeOf(node.id);
    const spot = findFreeSpot(anchor, size, occupied, config);
    positions.set(node.id, spot);
    occupied.push({ ...spot, ...size });
  }

  const resolve = (node: Node, parent: Point): void => {
    const relative = positions.get(node.id) ?? { x: 0, y: 0 };
    const absolute = { x: parent.x + relative.x, y: parent.y + relative.y };
    absolutePositions.set(node.id, absolute);
    for (const child of childrenOf.get(node.id) ?? []) resolve(child, absolute);
  };
  for (const node of topLevel) resolve(node, { x: 0, y: 0 });

  return { mode: 'incremental', positions, absolutePositions, sizes, edgeSections: {}, portOrder: {}, portOffsets: {} };
}

/** A zero-size rect at the centre of everything placed, for when there is no anchor to grow from. */
function centreOf(occupied: readonly Rect[], config: IncrementalLayoutConfig): Rect {
  if (occupied.length === 0) return { x: 0, y: 0, width: config.leafWidth, height: config.leafHeight };
  const x = occupied.reduce((sum, rect) => sum + rect.x + rect.width / 2, 0) / occupied.length;
  const y = occupied.reduce((sum, rect) => sum + rect.y + rect.height / 2, 0) / occupied.length;
  return { x, y, width: 0, height: 0 };
}

/**
 * First free spot on an outward spiral around the anchor.
 *
 * Rings rather than a scan line, so partners of the same element end up
 * surrounding it instead of in a column beside it, and each ring is sampled at
 * roughly one box-width intervals so a candidate is tried wherever one could
 * fit. Angle zero is due east and the sweep is clockwise, which puts the first
 * new box to the right of the expanded one — the direction a reader following
 * the graph is already moving in.
 *
 * The fallback parks the box clear of everything to the east. It is reached
 * only when 24 rings are full, which on a canvas this size means the search was
 * never going to succeed; an overlap there would be worse than a long edge.
 */
function findFreeSpot(
  anchor: Rect,
  size: Size,
  occupied: readonly Rect[],
  config: IncrementalLayoutConfig,
): Point {
  const centreX = anchor.x + anchor.width / 2;
  const centreY = anchor.y + anchor.height / 2;
  const boxRadius = Math.hypot(size.width, size.height) / 2;
  const base = Math.hypot(anchor.width, anchor.height) / 2 + boxRadius + config.ringGap;
  const step = boxRadius + config.ringGap;

  for (let ring = 0; ring < MAX_SEARCH_RINGS; ring += 1) {
    const radius = base + ring * step;
    const samples = Math.max(8, Math.round((2 * Math.PI * radius) / (size.width + config.clearance)));
    for (let sample = 0; sample < samples; sample += 1) {
      const angle = (2 * Math.PI * sample) / samples;
      const candidate = {
        x: centreX + Math.cos(angle) * radius - size.width / 2,
        y: centreY + Math.sin(angle) * radius - size.height / 2,
        ...size,
      };
      if (!occupied.some((rect) => overlaps(rect, candidate, config.clearance))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }

  const east = occupied.reduce((max, rect) => Math.max(max, rect.x + rect.width), centreX);
  return { x: east + config.ringGap, y: centreY - size.height / 2 };
}
