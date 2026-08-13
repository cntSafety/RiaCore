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
// ── Placement_Mode drop record building ─────────────────────────────────────
// Pure record-building function extracted from WorkspaceCanvas.tsx's onPaneClick
// so it can be exercised directly by property tests against the REAL render code
// path (Req 9.3).
//
// While the Overview_Canvas is in Placement_Mode, a single primary click on the
// pane drops the new Canvas_Element at the clicked coordinate. onPaneClick first
// converts the click's screen coordinate to a flow coordinate via
// `rf.screenToFlowPosition`, then builds exactly one Layout_Record for the placed
// element at that flow coordinate and persists it. buildPlacementRecord is that
// trivial, deterministic record-building step: it pairs the placement's
// Layout_Key (elementKind + elementKey) with the clicked flow coordinate,
// preserving the coordinate exactly (Req 9.3).

import type { LayoutRecord } from '@riacore/app-contracts';

/** The Layout_Key of the Canvas_Element being placed. */
export interface PlacementTarget {
  elementKind: string;
  elementKey: string;
}

/** A two-dimensional flow coordinate (Overview_Canvas layout coordinates). */
export interface FlowCoord {
  x: number;
  y: number;
}

/**
 * Build the single Layout_Record for a Placement_Mode drop (Req 9.3).
 *
 * @param placement  the Layout_Key of the element being placed
 * @param flowCoord  the clicked position converted to flow coordinates
 * @returns a Layout_Record with the placement's Layout_Key and exactly the
 *          clicked coordinate (no rounding, no transformation).
 */
export function buildPlacementRecord(
  placement: PlacementTarget,
  flowCoord: FlowCoord,
): LayoutRecord {
  return {
    elementKind: placement.elementKind,
    elementKey: placement.elementKey,
    x: flowCoord.x,
    y: flowCoord.y,
  };
}
