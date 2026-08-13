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
 * Cell colours are defined in CELL_COLORS below using a [row][col] address where:
 *   row 0 = bottom row = Proven detection (lowest risk row)
 *   row 4 = top row    = None detection   (highest risk row)
 *   col 0 = left col   = Very Low occurrence  (lowest risk col)
 *   col 4 = right col  = Very High occurrence (highest risk col)
 *
 * No hooks, no IPC calls — pure presentational.
 */

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

// ── Cell colour lookup table ──────────────────────────────────────────────────
//
// Address: CELL_COLORS[row][col]
//
//   row 0 = bottom row = Level1 detection (Proven)    — lowest risk row
//   row 4 = top row    = Level5 detection (None)      — highest risk row
//   col 0 = left col   = Level1 occurrence (Very Low) — lowest risk col
//   col 4 = right col  = Level5 occurrence (Very High)— highest risk col
//
// Edit any hex value here to change the colour of that specific cell.
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
 * Return the background colour for a rendered grid cell.
 *
 * @param colIndex  0 = Very Low (left) … 4 = Very High (right)
 * @param rowIndex  0 = top of rendered grid (None) … 4 = bottom (Proven)
 *
 * The rendered grid has rowIndex 0 at the top (highest risk), but CELL_COLORS
 * has row 0 at the bottom (lowest risk), so we flip the row index.
 */
function cellColor(colIndex: number, rowIndex: number): string {
  const tableRow = (CELL_COLORS.length - 1) - rowIndex;
  return CELL_COLORS[tableRow]?.[colIndex] ?? '#ffffff';
}

/** Bubble diameter in px: min 18, max 60, scales with count. */
function bubbleDiameter(count: number): number {
  return Math.max(18, Math.min(60, 18 + count * 8));
}

// ── Component ─────────────────────────────────────────────────────────────────

interface RiskMatrixProps {
  bubbles: RiskMatrixBubble[];
}

export function RiskMatrix({ bubbles }: RiskMatrixProps) {
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
              backgroundColor: cellColor(ci, ri),
              opacity: 0.55,
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
