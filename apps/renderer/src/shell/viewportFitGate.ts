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
// Feature: overview-canvas-render-robustness
//
// Pure, framework-free extraction of the Overview_Canvas Viewport_Fit gate
// (design Decision 6).
//
// The live `GraphFitter` in `WorkspaceCanvas.tsx` (around line 1073) decides
// whether to fit like this:
//
//     if (!nodesInitialized) return;
//     if (fittedForRef.current === signal) return;
//     fittedForRef.current = signal;
//     void fitView({ padding: 0.2, duration: 200 });
//
// The `!nodesInitialized` early return is unbounded: `useNodesInitialized()`
// stays false for as long as any rendered node lacks Measured_Dimensions, and a
// dropped resize-observation notification (Notification_Loss) means that
// measurement may never arrive. The result is that the Viewport_Fit for a
// pending Graph_Structure_Change is suppressed indefinitely, so a newly
// imported element can be left outside the visible viewport with no way for the
// user to discover it (Requirement 3.3).
//
// This module replaces that gate with a deadline: the fit still waits for
// `nodesInitialized` when it arrives promptly, but no longer waits forever.
// Waiting is safe to abandon because this feature guarantees every node carries
// Declared_Dimensions from its first frame (Decision 1), so `getNodesBounds` has
// usable geometry with no measurement at all. The deadline therefore changes
// WHEN the fit runs, never whether the bounds it computes are correct.
//
// `placementActive` is new behavior, not a port of the existing gate.
// `graphStructureKey` changes as soon as a new import source or analysis
// namespace exists in the data, which is before the user has placed it, so
// without this input a fit can pan the canvas while the Placement_Mode ghost is
// still following the cursor. Suppressing the fit while placement is active and
// letting it run once placement completes satisfies Requirement 3.5 and removes
// that jump.
//
// Both the once-per-structure-key rule (Requirements 3.1, 3.2) and the deadline
// (Requirement 3.3) live here; `WorkspaceCanvas.tsx` retains only the
// bookkeeping of `lastFittedKey` and the elapsed-time measurement.

/**
 * Fit_Deadline: how long the gate will wait for the Nodes_Initialized_Signal
 * before fitting on Declared_Dimensions bounds instead.
 */
export const VIEWPORT_FIT_DEADLINE_MS = 1000;

export interface ViewportFitInput {
  /** Identity of the current rendered Canvas_Element set (Graph_Structure_Change discriminant). */
  structureKey: string;
  /** The `structureKey` a Viewport_Fit has already run for, or null if none has. */
  lastFittedKey: string | null;
  /** The Nodes_Initialized_Signal, i.e. `useNodesInitialized()`. */
  nodesInitialized: boolean;
  /** Milliseconds elapsed since `structureKey` last changed. */
  msSinceStructureKeyChanged: number;
  /** True while a Canvas_Element is in Placement_Mode. */
  placementActive: boolean;
}

/**
 * Decide whether the Overview_Canvas should perform a Viewport_Fit now.
 *
 * Returns `{ fit: true }` only when all of the following hold:
 *   - `structureKey !== lastFittedKey` — one fit per Graph_Structure_Change, and
 *     none for a status, statistics, connection, or position refresh
 *     (Requirements 3.1, 3.2).
 *   - `placementActive === false` — no fit while placement is in progress
 *     (Requirement 3.5).
 *   - `nodesInitialized === true` OR the Fit_Deadline has elapsed — a lost
 *     Measurement_Notification delays the fit but cannot cancel it
 *     (Requirement 3.3).
 *
 * A negative or zero `msSinceStructureKeyChanged` needs no special handling: it
 * simply fails the deadline arm, leaving `nodesInitialized` as the only way
 * through, which is the correct reading of "the deadline has not elapsed yet".
 */
export function decideViewportFit(input: ViewportFitInput): { fit: boolean } {
  if (input.structureKey === input.lastFittedKey) return { fit: false };
  if (input.placementActive) return { fit: false };
  const deadlineReached = input.msSinceStructureKeyChanged >= VIEWPORT_FIT_DEADLINE_MS;
  return { fit: input.nodesInitialized || deadlineReached };
}
