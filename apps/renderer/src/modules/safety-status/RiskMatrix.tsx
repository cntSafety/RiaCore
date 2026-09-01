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
 * RiskMatrix — fixed 5×5 risk matrix bubble chart.
 *
 * X-axis (occurrence): Level1=Very Low … Level5=Very High, left → right
 * Y-axis (detection):  Level1=Proven (bottom, low risk) … Level5=None (top, high risk)
 *
 * When the caller supplies the profile's `actionPriority` table, each cell is
 * coloured by its resolved Action Priority level (H/M/L) instead of the
 * legacy fixed gradient — see `cellColor()`. The matrix only ever plots
 * `Safety-Impact` malfunctions (see `computeRiskMatrixBubbles` in
 * `StatusCard.tsx`), so cells are resolved against that severity class. AP
 * tints reuse the same pastel swatches (and 0.55 blend) as `CELL_COLORS`, so
 * the visual language is unchanged from before AP existed. Falls back to the
 * legacy `CELL_COLORS` gradient when no table is supplied (older profiles
 * that have not migrated from RPN — see docs/particular/SafetyImprove.md §2).
 *
 * No hooks, no IPC calls — pure presentational. `actionPriority` is a plain
 * prop so the caller (which does have context access) resolves it once.
 */

import type { ActionPriorityLevel, ActionPriorityMetadata } from '@riacore/app-contracts';
import { resolveActionPriority } from '@riacore/app-contracts';

export interface RiskMatrixBubble {
  occurrence: string;
  detection: string;
  count: number;
}

// ── Fixed axis definitions ────────────────────────────────────────────────────

const OCCURRENCE_LEVELS = ['Level1', 'Level2', 'Level3', 'Level4', 'Level5'] as const;
const DETECTION_LEVELS_TOP_TO_BOTTOM = ['Level5', 'Level4', 'Level3', 'Level2', 'Level1'] as const;

const OCCURRENCE_LABELS: Record<string, string> = {
  Level1: 'Very\nLow',
  Level2: 'Low',
  Level3: 'Med',
  Level4: 'High',
  Level5: 'Very\nHigh',
};

const DETECTION_LABELS: Record<string, string> = {
  Level1: 'Proven',
  Level2: 'Good',
  Level3: 'Moderate',
  Level4: 'Limited',
  Level5: 'None',
};

// ── Legacy fixed-gradient fallback (no actionPriority table supplied) ────────
//
// Address: CELL_COLORS[row][col]
//
//   row 0 = bottom row = Level1 detection (Proven)    — lowest risk row
//   row 4 = top row    = Level5 detection (None)      — highest risk row
//   col 0 = left col   = Level1 occurrence (Very Low) — lowest risk col
//   col 4 = right col  = Level5 occurrence (Very High)— highest risk col
//
// The table is written bottom-to-top so row 0 (Proven) is the first array entry.
//
//              col0        col1        col2        col3        col4
//           (Very Low)    (Low)       (Med)      (High)   (Very High)
const CELL_COLORS = [
  // row 0 — Proven (bottom row, lowest risk)
  ['#7bc67e',  '#a8d5a2',  '#c8e6c9',  '#dcedc8',  '#f0f4c3'],
  // row 1 — Good
  ['#a8d5a2',  '#c8e6c9',  '#dcedc8',  '#f0f4c3',  '#fff9c4'],
  // row 2 — Moderate
  ['#c8e6c9',  '#dcedc8',  '#fff9c4',  '#ffe0b2',  '#ffccbc'],
  // row 3 — Limited
  ['#dcedc8',  '#fff9c4',  '#ffe0b2',  '#ffccbc',  '#ef9a9a'],
  // row 4 — None (top row, highest risk)
  ['#fff9c4',  '#ffe0b2',  '#ffccbc',  '#ef9a9a',  '#e57373'],
] as const;

/**
 * Colours per Action Priority level — reuses the same pastel swatches as the
 * legacy `CELL_COLORS` gradient (the corners and a middle tone), blended at
 * the same 0.55 opacity via `cellOpacity()` below.
 */
const AP_CELL_TINTS: Record<ActionPriorityLevel, string> = {
  L: '#7bc67e', // same green as CELL_COLORS' lowest-risk corner
  M: '#ffe0b2', // same amber as CELL_COLORS' mid-range cells
  H: '#e57373', // same red as CELL_COLORS' highest-risk corner
};

/** Neutral fallback for a cell that resolves to no AP level (incomplete table). */
const AP_CELL_UNRESOLVED = '#bdbdbd';

/**
 * Return the background colour for a rendered grid cell.
 *
 * @param occurrenceLevel  'Level1'..'Level5' (Very Low .. Very High)
 * @param detectionLevel   'Level1'..'Level5' (Proven .. None)
 * @param colIndex  0 = Very Low (left) … 4 = Very High (right) — legacy-fallback address
 * @param rowIndex  0 = top of rendered grid (None) … 4 = bottom (Proven) — legacy-fallback address
 * @param actionPriority  the profile's AP table, or undefined for the legacy gradient
 *
 * This matrix only ever plots `Safety-Impact` malfunctions (see
 * `computeRiskMatrixBubbles`), so the AP lookup is resolved against that
 * severity class regardless of which malfunction populates a given cell.
 */
function cellColor(
  occurrenceLevel: string,
  detectionLevel: string,
  colIndex: number,
  rowIndex: number,
  actionPriority: ActionPriorityMetadata | undefined,
): string {
  if (actionPriority) {
    const level = resolveActionPriority(actionPriority, 'Safety-Impact', occurrenceLevel, detectionLevel);
    return level ? AP_CELL_TINTS[level] : AP_CELL_UNRESOLVED;
  }
  const tableRow = (CELL_COLORS.length - 1) - rowIndex;
  return CELL_COLORS[tableRow]?.[colIndex] ?? '#ffffff';
}

/** Cell background opacity — same 0.55 blend for both the AP tints and the legacy gradient. */
const CELL_OPACITY = 0.55;

/** Bubble diameter in px: min 18, max 60, scales with count. */
function bubbleDiameter(count: number): number {
  return Math.max(18, Math.min(60, 18 + count * 8));
}

// ── Component ─────────────────────────────────────────────────────────────────

interface RiskMatrixProps {
  bubbles: RiskMatrixBubble[];
  /** The active profile's AP table. Omit to keep the legacy fixed-gradient colouring. */
  actionPriority?: ActionPriorityMetadata;
}

export function RiskMatrix({ bubbles, actionPriority }: RiskMatrixProps) {
  const bubbleMap = new Map<string, number>();
  for (const b of bubbles) {
    bubbleMap.set(`${b.occurrence}|${b.detection}`, b.count);
  }

  const CELL_W  = 54;
  const CELL_H  = 46;
  const LABEL_W = 58;
  const LABEL_H = 36;
  const COLS = OCCURRENCE_LEVELS.length;
  const ROWS = DETECTION_LEVELS_TOP_TO_BOTTOM.length;

  const gridW = LABEL_W + CELL_W * COLS;
  const gridH = CELL_H * ROWS + LABEL_H;

  return (
    <div style={{ position: 'relative', width: gridW, height: gridH, userSelect: 'none', fontSize: 11 }}>

      {/* ── Per-cell coloured background ── */}
      {DETECTION_LEVELS_TOP_TO_BOTTOM.map((det, ri) =>
        OCCURRENCE_LEVELS.map((occ, ci) => (
          <div
            key={`bg-${occ}-${det}`}
            style={{
              position: 'absolute',
              left: LABEL_W + ci * CELL_W,
              top: ri * CELL_H,
              width: CELL_W,
              height: CELL_H,
              backgroundColor: cellColor(occ, det, ci, ri, actionPriority),
              opacity: CELL_OPACITY,
            }}
          />
        ))
      )}

      {/* ── Grid lines ── */}
      {OCCURRENCE_LEVELS.map((occ, ci) => ci > 0 && (
        <div key={`vdiv-${occ}`} style={{ position: 'absolute', left: LABEL_W + ci * CELL_W, top: 0, width: 1, height: CELL_H * ROWS, backgroundColor: 'rgba(255,255,255,0.5)' }} />
      ))}
      {DETECTION_LEVELS_TOP_TO_BOTTOM.map((det, ri) => ri > 0 && (
        <div key={`hdiv-${det}`} style={{ position: 'absolute', left: LABEL_W, top: ri * CELL_H, width: CELL_W * COLS, height: 1, backgroundColor: 'rgba(255,255,255,0.3)' }} />
      ))}

      {/* ── Y-axis labels (detection, left of grid) ── */}
      {DETECTION_LEVELS_TOP_TO_BOTTOM.map((det, ri) => (
        <div
          key={`ylbl-${det}`}
          style={{
            position: 'absolute', left: 0, top: ri * CELL_H,
            width: LABEL_W - 4, height: CELL_H,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            paddingRight: 6, fontSize: 10, fontWeight: 500, lineHeight: 1.2,
            textAlign: 'right', opacity: 0.8,
          }}
          title={det}
        >
          {DETECTION_LABELS[det] ?? det}
        </div>
      ))}

      {/* ── X-axis labels (occurrence, below grid) ── */}
      {OCCURRENCE_LEVELS.map((occ, ci) => (
        <div
          key={`xlbl-${occ}`}
          style={{
            position: 'absolute', left: LABEL_W + ci * CELL_W, top: CELL_H * ROWS + 4,
            width: CELL_W, height: LABEL_H - 4,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            fontSize: 10, fontWeight: 500, lineHeight: 1.2,
            textAlign: 'center', opacity: 0.8, whiteSpace: 'pre-line',
          }}
          title={occ}
        >
          {OCCURRENCE_LABELS[occ] ?? occ}
        </div>
      ))}

      {/* ── Bubbles ── */}
      {DETECTION_LEVELS_TOP_TO_BOTTOM.map((det, ri) =>
        OCCURRENCE_LEVELS.map((occ, ci) => {
          const count = bubbleMap.get(`${occ}|${det}`);
          if (!count) return null;
          const d = bubbleDiameter(count);
          const cx = LABEL_W + ci * CELL_W + CELL_W / 2;
          const cy = ri * CELL_H + CELL_H / 2;
          return (
            <div
              key={`bubble-${occ}-${det}`}
              data-testid="risk-matrix-bubble"
              style={{
                position: 'absolute',
                left: cx - d / 2, top: cy - d / 2,
                width: d, height: d,
                borderRadius: '50%',
                backgroundColor: '#f97316',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontWeight: 700,
                fontSize: Math.max(9, Math.min(14, d * 0.32)),
                boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                zIndex: 1,
              }}
              title={`Occurrence: ${OCCURRENCE_LABELS[occ] ?? occ}, Detection: ${DETECTION_LABELS[det] ?? det}, Count: ${count}`}
            >
              {count}
            </div>
          );
        })
      )}
    </div>
  );
}
