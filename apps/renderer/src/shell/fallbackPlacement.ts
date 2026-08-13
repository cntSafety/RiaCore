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
// ── Sticky fallback placement for un-recorded Canvas_Elements ───────────────
//
// The Overview_Canvas never re-arranges itself on its own: Auto_Layout (ELK) runs
// ONLY when the user presses the Auto_Layout_Button, and the initial position of
// a newly created Canvas_Element is chosen by the user in Placement_Mode. That
// leaves one gap: a Canvas_Element that has no stored Layout_Record at all
// (e.g. created before layout persistence existed, or provisioned outside the
// UI). It still needs *some* coordinate to render at.
//
// This module supplies that coordinate with two hard guarantees:
//
//  1. **Deterministic and cheap** — a plain column/row grid, no graph layout
//     engine, no async work, so the build effect stays synchronous.
//  2. **Sticky** — once an element has been handed a fallback position, it keeps
//     that exact position for the rest of the session. Adding or removing other
//     elements, deleting a connection, or a status/stats refresh can never move
//     an already-placed element. Nothing on the canvas moves unless the user
//     drags it, places it, or presses Auto Layout.
//
// The cache is session-scoped and must be recreated on workspace switch (the
// stored Diagram_Layout is workspace-scoped too).

export interface Point {
  x: number;
  y: number;
}

export interface FallbackPlacementCache {
  /** `layout_id` → the position assigned to it (never reassigned). */
  positions: Map<string, Point>;
  /** Element_Kind → column index, assigned in first-seen order. */
  columns: Map<string, number>;
  /** Element_Kind → number of row slots already handed out for that kind. */
  slots: Map<string, number>;
}

/** Horizontal distance between two Element_Kind columns (node width + gutter). */
export const FALLBACK_COLUMN_GAP = 360;
/** Vertical distance between two elements in the same column. */
export const FALLBACK_ROW_GAP = 230;

export function createFallbackPlacementCache(): FallbackPlacementCache {
  return { positions: new Map(), columns: new Map(), slots: new Map() };
}

/**
 * Return the fallback position for `layoutId`, assigning one on first call.
 *
 * Elements are stacked top-to-bottom in a column per Element_Kind; the column
 * index is assigned in first-seen order, so callers that iterate imported
 * elements before analysis elements get the familiar imported-left /
 * analysis-right arrangement.
 *
 * Repeated calls for the same `layoutId` always return the same point — that
 * stickiness is what keeps the diagram stable across data refreshes.
 */
/**
 * Record a known position for `layoutId` without consuming a grid slot.
 *
 * Called right after a position is written to the database (placement commit,
 * drag stop). Persisting invalidates the layout query, but the refetch is async:
 * until it lands the element has no stored Layout_Record, and a rebuild in that
 * window would hand it an unrelated grid slot and then visibly jump it once the
 * record arrives — and, worse, place a *following* element based on that
 * temporary coordinate, so two tiles can end up overlapping. Seeding the cache
 * with the position we just wrote closes that window.
 */
export function setFallbackPosition(
  cache: FallbackPlacementCache,
  layoutId: string,
  position: Point,
): void {
  cache.positions.set(layoutId, { x: position.x, y: position.y });
}

export function ensureFallbackPosition(
  cache: FallbackPlacementCache,
  elementKind: string,
  layoutId: string,
): Point {
  const existing = cache.positions.get(layoutId);
  if (existing) return existing;

  let column = cache.columns.get(elementKind);
  if (column === undefined) {
    column = cache.columns.size;
    cache.columns.set(elementKind, column);
  }

  const slot = cache.slots.get(elementKind) ?? 0;
  cache.slots.set(elementKind, slot + 1);

  const position: Point = { x: column * FALLBACK_COLUMN_GAP, y: slot * FALLBACK_ROW_GAP };
  cache.positions.set(layoutId, position);
  return position;
}

// ── Free-spot search for a cancelled placement ──────────────────────────────
//
// When the user cancels Placement_Mode (Escape), the new Canvas_Element still
// needs a coordinate. Auto_Layout must NOT run for this — cancelling one
// element's placement may never re-arrange the rest of the diagram — so the
// element is dropped near the center of the current viewport instead.
//
// A plain "center of viewport" would stack every cancelled placement on the same
// spot: create three elements in a row and all three land on top of each other,
// which hides their connection handles. `findFreePosition` therefore cascades
// away from the preferred point until the new element's box clears every element
// already on the canvas.

export interface Box extends Point {
  width: number;
  height: number;
}

/** Nominal size of a newly placed tile, used for the overlap test. */
export const NEW_ELEMENT_SIZE = { width: 290, height: 200 };
/** Diagonal offset applied per cascade step until a free spot is found. */
const CASCADE_STEP = { x: 56, y: 56 };
/** Bound on the search so a densely packed canvas can never spin. */
const MAX_CASCADE_STEPS = 200;

function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/**
 * Return `preferred` if a box of `size` placed there clears every box in
 * `occupied` (with `gap` breathing room), otherwise the first cascaded offset
 * that does.
 *
 * Pure and deterministic: same inputs → same output. It only ever chooses a
 * position for the NEW element; nothing already on the canvas is considered
 * movable.
 */
export function findFreePosition(
  preferred: Point,
  occupied: readonly Box[],
  size: { width: number; height: number } = NEW_ELEMENT_SIZE,
  gap = 16,
): Point {
  for (let step = 0; step <= MAX_CASCADE_STEPS; step++) {
    const candidate: Point = {
      x: preferred.x + CASCADE_STEP.x * step,
      y: preferred.y + CASCADE_STEP.y * step,
    };
    const box: Box = { ...candidate, ...size };
    if (!occupied.some((other) => overlaps(box, other, gap))) return candidate;
  }
  return {
    x: preferred.x + CASCADE_STEP.x * MAX_CASCADE_STEPS,
    y: preferred.y + CASCADE_STEP.y * MAX_CASCADE_STEPS,
  };
}
