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
// ── Unmeasured Canvas_Element watch (overview-canvas-render-robustness) ─────
//
// WHY this exists: a Canvas_Element that renders on its Declared_Dimensions
// because a Measurement_Notification was never delivered looks completely
// normal. Nothing throws, nothing logs, the card sits at the right place and
// the only trace is that `measured` never arrives — so edge geometry stays
// approximate, `nodesInitialized` stays false, and the Viewport_Fit only runs
// because of its deadline. Before Declared_Dimensions existed the same lost
// notification hid the card outright, and that defect took a user screenshot
// to find. Declared_Dimensions make the symptom invisible instead of fatal,
// which is an improvement only if the underlying condition is still reported.
//
// This module is the pure bookkeeping half of that report. It answers one
// question per tick: which ids have now gone longer than the
// Measurement_Grace_Period without Measured_Dimensions and have not been
// reported yet, and which previously reported ids have since acquired them.
// `WorkspaceCanvas.tsx` owns the interval and the `logOpEvent` call; this
// module owns the "exactly once" accounting so that it is property-testable
// with an explicit clock (`now` is an input — the module never reads the
// clock itself) and free of any React or DOM dependency.
//
// The watch is observation-only: it never influences the Node_Array and never
// produces a user-facing error (Requirement 6.4).

/** A Canvas_Element must acquire Measured_Dimensions within this window. */
export const MEASUREMENT_GRACE_PERIOD_MS = 2000;

export interface UnmeasuredWatchState {
  /** node id → timestamp at which it entered the Node_Array. */
  firstSeenAt: Map<string, number>;
  /** node ids for which an overdue report has already been emitted. */
  reported: Set<string>;
}

export interface UnmeasuredWatchInput {
  /** ids currently in the Node_Array, in render order. */
  presentIds: readonly string[];
  /** subset of `presentIds` that has Measured_Dimensions. */
  measuredIds: ReadonlySet<string>;
  /** caller-supplied clock reading for this tick. */
  now: number;
}

export interface UnmeasuredWatchOutcome {
  /** ids that have just exceeded the grace period without Measured_Dimensions. */
  overdue: string[];
  /** previously reported ids that have since acquired Measured_Dimensions. */
  recovered: string[];
}

export function createUnmeasuredWatchState(): UnmeasuredWatchState {
  return { firstSeenAt: new Map(), reported: new Set() };
}

/**
 * Advance the watch by one tick.
 *
 * **Mutates `state` in place** — `firstSeenAt` and `reported` are updated as a
 * side effect — and returns only what should be reported for this tick. The
 * caller keeps one long-lived state object and logs whatever comes back.
 *
 * Work is done in a fixed order:
 *   1. ids absent from `presentIds` are dropped from both `firstSeenAt` and
 *      `reported`, so an id that leaves and later re-enters the Node_Array
 *      restarts its grace period from scratch (Requirement 4.4).
 *   2. ids present for the first time get `firstSeenAt = now`.
 *   3. `recovered` = reported ids that now appear in `measuredIds`; they leave
 *      `reported`, which is what makes a *later* unmeasured period reportable
 *      again.
 *   4. `overdue` = present, unmeasured, not-yet-reported ids whose elapsed time
 *      has reached the grace period; they enter `reported`.
 *
 * Guarantees:
 *  - an id is reported overdue **at most once per continuous unmeasured
 *    period** (Requirement 6.2);
 *  - an id that acquires Measured_Dimensions within the grace period is
 *    **never** reported overdue (Requirement 6.1);
 *  - an id that was reported overdue and later acquires Measured_Dimensions
 *    appears in `recovered` **exactly once** (Requirement 6.3).
 *
 * Both output arrays follow `presentIds` order, so a given tick's reports are
 * deterministic regardless of Map/Set insertion history.
 */
export function tickUnmeasuredWatch(
  state: UnmeasuredWatchState,
  input: UnmeasuredWatchInput,
): UnmeasuredWatchOutcome {
  const { presentIds, measuredIds, now } = input;
  const present = new Set(presentIds);

  // 1. Forget everything that is no longer in the Node_Array.
  for (const id of [...state.firstSeenAt.keys()]) {
    if (!present.has(id)) state.firstSeenAt.delete(id);
  }
  for (const id of [...state.reported]) {
    if (!present.has(id)) state.reported.delete(id);
  }

  // 2. Start the clock for ids seen for the first time.
  for (const id of presentIds) {
    if (!state.firstSeenAt.has(id)) state.firstSeenAt.set(id, now);
  }

  const overdue: string[] = [];
  const recovered: string[] = [];

  // 3 + 4. Decide per id, walking `presentIds` so the output order is stable.
  for (const id of presentIds) {
    if (measuredIds.has(id)) {
      if (state.reported.delete(id)) recovered.push(id);
      continue;
    }
    if (state.reported.has(id)) continue;
    const firstSeenAt = state.firstSeenAt.get(id);
    if (firstSeenAt === undefined) continue;
    if (now - firstSeenAt >= MEASUREMENT_GRACE_PERIOD_MS) {
      state.reported.add(id);
      overdue.push(id);
    }
  }

  return { overdue, recovered };
}
