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
// ── Canvas_Element position resolution ──────────────────────────────────────
// Pure resolver extracted from WorkspaceCanvas.tsx so it can be exercised
// directly by property tests against the REAL render code path.
//
// A Canvas_Element's rendered Element_Position is resolved in a strict order:
//   1. its stored Layout_Record, if one exists in the Diagram_Layout (Req 2.2)
//   2. otherwise its Auto_Layout-computed fallback position (Req 2.3)
//   3. otherwise the canvas origin {x:0, y:0}
//
// Stored positions are keyed by the composite `layout_id`
// (`${elementKind}\u0000${elementKey}`), while the Auto_Layout (ELK) fallback
// map is keyed by the element's node id (an imported node's `targetNamespace`
// or an analysis node's `name`). The resolver therefore takes both keys so the
// two independent maps are consulted with the key each was built with, keeping
// behavior identical to the previous inline `?? ... ??` expression.

export interface Point {
  x: number;
  y: number;
}

/**
 * Resolve a Canvas_Element's Element_Position.
 *
 * @param layoutId    composite `layout_id` used to look up the stored Layout_Record
 * @param fallbackKey node id used to look up the Auto_Layout-computed fallback
 * @param storedPositions   Diagram_Layout indexed by `layout_id` (Req 2.2)
 * @param fallbackPositions Auto_Layout result indexed by node id (Req 2.3)
 * @returns the stored position when present, else the fallback, else the origin
 */
export function resolveNodePosition(
  layoutId: string,
  fallbackKey: string,
  storedPositions: ReadonlyMap<string, Point>,
  fallbackPositions: ReadonlyMap<string, Point>,
): Point {
  return storedPositions.get(layoutId) ?? fallbackPositions.get(fallbackKey) ?? { x: 0, y: 0 };
}
