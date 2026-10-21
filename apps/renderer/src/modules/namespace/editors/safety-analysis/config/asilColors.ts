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
 * ASIL palette — the single source of truth for every ASIL colour in the app.
 *
 * ## Why this is not a traffic light
 *
 * The palette used to run QM grey → A green → B lime → C orange → D red. That
 * encoding told the reader the wrong thing twice over. `#52c41a` is the app's own
 * "this is fine" colour (model-check "no violations", review ticks, `.ria-fg-ok`),
 * so an ASIL A or B malfunction looked like a passing result when it is in fact a
 * malfunction with a safety goal behind it — only QM means "no safety
 * requirement", and QM already has its own neutral grey. At the other end,
 * `#d4380d` sits at OKLCH hue 34, between red (hue 26) and orange, so ASIL D
 * read as an error rather than as the top of an integrity scale.
 *
 * ASIL is one ordered scale, so it gets one hue family. Severity is carried by
 * lightness and chroma inside pure orange (OKLCH hue 48-62), which stays clear of
 * the error vocabulary. QM stays achromatic because "no ASIL" is categorically
 * different from the bottom of the ramp, not a lesser version of it.
 *
 * ## Why there are two ramps
 *
 * Severity has to mean *more visually dominant*, and dominance inverts with the
 * background. On near-black a deep burnt orange is the faintest thing on screen;
 * on white it is the heaviest. So each theme gets its own values and the same
 * meaning. Pick with `useAsilPalette()` rather than hardcoding either set.
 *
 * ## The constraints these values satisfy
 *
 * Diagram strokes, tile borders and port squares are graphical objects required
 * to understand the content, so WCAG 1.4.11 applies to them:
 *
 * - every level clears **3:1** against its theme's canvas *and* raised surface;
 * - adjacent levels clear **1.3:1** against each other, so A/B and C/D stay
 *   tellable apart on a thin line;
 *
 * and for chips, where the gate is text-on-chip rather than chip-on-canvas:
 *
 * - chip text clears **4.5:1** against its own chip fill.
 *
 * `__tests__/asilColors.contrast.test.ts` recomputes all of this from these
 * values, so the palette cannot regress silently. Do not hand-edit a hex here
 * without running it.
 *
 * One known consequence, accepted deliberately: a pure orange needs roughly
 * OKLCH L <= 0.65 to reach 3:1 on white, and a pure orange that dark is perceived
 * as brown. The light ramp therefore ends at `#6b3106`. The alternative was
 * either failing 1.4.11 or compressing the ramp until adjacent levels fell below
 * 1.3:1, and an unmistakable D matters more than D looking bright.
 */

import type { MalfunctionInfo } from '@riacore/app-contracts';
import { useMemo } from 'react';
import { useThemeMode, type ThemeMode } from '../../../../../theme/ThemeProvider';

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Numeric rank per core ASIL level. Shared by colour lookup and comparison. */
export const ASIL_ORDER: Record<string, number> = {
  QM: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

/** Highest rank in {@link ASIL_ORDER}; `D`. */
const MAX_LEVEL = 4;

/**
 * Converts an ASIL string to a numeric level for comparison and colour lookup.
 *
 * Core levels map directly: QM=0, A=1, B=2, C=3, D=4. Decomposition variants
 * (`A(B)`, `QM(D)`) resolve to their highest component, because the colour has to
 * represent the integrity the element is being held to. Unrecognized or empty
 * strings return -1, which every resolver below treats as "no ASIL".
 */
export function parseAsilLevel(asil: string | null | undefined): number {
  if (!asil) return -1;

  const trimmed = asil.trim();

  const decomposition = trimmed.match(/^([A-Z]+)\(([A-Z]+)\)$/);
  if (decomposition) {
    const left = ASIL_ORDER[decomposition[1]] ?? -1;
    const right = ASIL_ORDER[decomposition[2]] ?? -1;
    return Math.max(left, right);
  }

  const level = ASIL_ORDER[trimmed];
  return level !== undefined ? level : -1;
}

/**
 * Returns the ASIL string with the highest resolved level from a list of
 * malfunctions, or `null` for an empty list.
 *
 * Malfunctions that exist but carry no recognized ASIL resolve to `'QM'`, so the
 * caller still renders *something* — "there is a malfunction here and nobody has
 * classified it" is a finding, not an absence.
 */
export function resolveMaxAsil(malfunctions: MalfunctionInfo[]): string | null {
  if (malfunctions.length === 0) return null;

  let maxLevel = -1;
  let maxAsil: string | null = null;

  for (const malfunction of malfunctions) {
    const level = parseAsilLevel(malfunction.asil);
    if (level > maxLevel) {
      maxLevel = level;
      maxAsil = malfunction.asil;
    }
  }

  if (maxAsil === null || maxLevel < 0) return 'QM';

  return maxAsil;
}

/** Returns whichever of two ASIL strings is the higher level. */
export function higherAsil(a: string | null, b: string | null): string | null {
  const levelA = parseAsilLevel(a);
  const levelB = parseAsilLevel(b);
  if (levelA < 0 && levelB < 0) return a ?? b;
  return levelB > levelA ? b : a;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export type AsilChip = {
  /** Chip background. */
  fill: string;
  /** Chip text/border colour; clears 4.5:1 against `fill`. */
  text: string;
};

/**
 * On-canvas colour per level: diagram strokes, tile borders, port squares, tree
 * icons. Keyed by {@link parseAsilLevel} output.
 *
 * Measured contrast (canvas / raised surface):
 *
 * | level | dark on #141414 / #1f1f1f | light on #ffffff / #fafafa |
 * | ----- | ------------------------- | -------------------------- |
 * | QM    | 5.48 / 4.90               | 3.36 / 3.22                |
 * | A     | 13.49 / 12.07             | 3.37 / 3.23                |
 * | B     | 10.10 / 9.03              | 4.81 / 4.60                |
 * | C     | 7.22 / 6.46               | 7.00 / 6.71                |
 * | D     | 5.06 / 4.52               | 10.16 / 9.73               |
 */
const LINE_BY_LEVEL: Record<ThemeMode, Record<number, string>> = {
  dark: {
    0: '#8c8c8c', // QM — achromatic, deliberately off the ramp
    1: '#fed5b3', // A  — pale amber
    2: '#fdaf68', // B
    3: '#f1871e', // C
    4: '#d76517', // D — deepest saturated orange; hue 48, 14 deg clear of volcano
  },
  light: {
    0: '#8c8c8c', // QM
    1: '#dd6c19', // A  — hue held at 50 across the light ramp; drifting toward
    2: '#b55812', // B    amber turns A to mustard at this lightness
    3: '#8f440c', // C
    4: '#6b3106', // D — reads brown, and is the only pure orange this dark that
  },             //      clears 3:1 on white
};

/**
 * Chip (tag) fill and text per level.
 *
 * A chip is a fill-plus-text surface, so the binding constraint is text against
 * its own fill, not fill against the canvas. That is what lets a light-theme chip
 * stay bright and friendly while the on-canvas line for the same level stays dark
 * enough to be conformant. Fill also steps with level, so a chip reads as ramped
 * before its text is parsed.
 */
const CHIP_BY_LEVEL: Record<ThemeMode, Record<number, AsilChip>> = {
  dark: {
    0: { fill: '#262626', text: '#bfbfbf' }, // QM
    1: { fill: '#2e2419', text: '#fed5b3' }, // A — text/fill 11.13
    2: { fill: '#33261a', text: '#fdaf68' }, // B — 8.03
    3: { fill: '#38281a', text: '#f1871e' }, // C — 5.53
    4: { fill: '#38261a', text: '#e8721a' }, // D — 4.69
  },
  light: {
    0: { fill: '#f5f5f5', text: '#595959' }, // QM
    1: { fill: '#fdf0e3', text: '#8f440c' }, // A — text/fill 6.25
    2: { fill: '#fbe4cf', text: '#7d3a09' }, // B — 6.89
    3: { fill: '#f7d6ba', text: '#6b3106' }, // C — 7.39
    4: { fill: '#f0c4a0', text: '#542504' }, // D — 7.98
  },
};

/**
 * Stroke width per level, in px.
 *
 * The second channel. Colour alone is a poor carrier on a thin line, and in the
 * light theme adjacent levels are only ~1.43:1 apart, so a D path is both deeper
 * and visibly heavier than an A path. Theme-independent on purpose.
 */
const WEIGHT_BY_LEVEL: Record<number, number> = {
  0: 2,
  1: 2.25,
  2: 2.5,
  3: 2.75,
  4: 3,
};

/** Width for an edge carrying no ASIL at all. Matches the pre-existing default. */
export const ASIL_LINE_WEIGHT_NONE = 2.5;

/** Level-name-keyed view of the on-canvas ramp, for tests and documentation. */
export const ASIL_LINE_COLORS: Record<ThemeMode, Record<string, string>> = {
  dark: Object.fromEntries(
    Object.entries(ASIL_ORDER).map(([name, level]) => [name, LINE_BY_LEVEL.dark[level]]),
  ),
  light: Object.fromEntries(
    Object.entries(ASIL_ORDER).map(([name, level]) => [name, LINE_BY_LEVEL.light[level]]),
  ),
};

/** Level-name-keyed view of the chip ramp, for tests and documentation. */
export const ASIL_CHIP_COLORS: Record<ThemeMode, Record<string, AsilChip>> = {
  dark: Object.fromEntries(
    Object.entries(ASIL_ORDER).map(([name, level]) => [name, CHIP_BY_LEVEL.dark[level]]),
  ),
  light: Object.fromEntries(
    Object.entries(ASIL_ORDER).map(([name, level]) => [name, CHIP_BY_LEVEL.light[level]]),
  ),
};

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * On-canvas colour for an ASIL value, or `null` when there is no ASIL.
 *
 * `null` is meaningful: it tells a diagram caller "nothing safety-relevant here,
 * fall back to your own neutral". Callers that must always paint something (tree
 * icons) want {@link getAsilIconColor} instead.
 */
export function getAsilLineColor(asil: string | null | undefined, mode: ThemeMode): string | null {
  const level = parseAsilLevel(asil);
  if (level < 0) return null;
  return LINE_BY_LEVEL[mode][level] ?? null;
}

/**
 * On-canvas colour for an ASIL value, falling back to the QM grey.
 *
 * For surfaces that always render a mark — a malfunction tree icon exists whether
 * or not anyone has classified it, and an invisible icon would be a worse answer
 * than a neutral one.
 */
export function getAsilIconColor(asil: string | null | undefined, mode: ThemeMode): string {
  return getAsilLineColor(asil, mode) ?? LINE_BY_LEVEL[mode][0];
}

/** Chip fill and text for an ASIL value, falling back to the QM pair. */
export function getAsilChip(asil: string | null | undefined, mode: ThemeMode): AsilChip {
  const level = parseAsilLevel(asil);
  return CHIP_BY_LEVEL[mode][level < 0 ? 0 : level];
}

/** Stroke width for an ASIL value; {@link ASIL_LINE_WEIGHT_NONE} when unset. */
export function getAsilLineWeight(asil: string | null | undefined): number {
  const level = parseAsilLevel(asil);
  if (level < 0) return ASIL_LINE_WEIGHT_NONE;
  return WEIGHT_BY_LEVEL[level] ?? ASIL_LINE_WEIGHT_NONE;
}

/**
 * The palette bound to the active theme.
 *
 * Preferred entry point for components. The returned functions are stable for a
 * given theme, so they are safe in dependency arrays — which matters for the
 * model canvas, where rebuilding edge data on every render would thrash layout.
 */
export function useAsilPalette() {
  const mode = useThemeMode();
  return useMemo(
    () => ({
      mode,
      /** On-canvas colour, or `null` when there is no ASIL. */
      line: (asil: string | null | undefined) => getAsilLineColor(asil, mode),
      /** On-canvas colour, falling back to QM grey. */
      icon: (asil: string | null | undefined) => getAsilIconColor(asil, mode),
      /** Chip fill + text. */
      chip: (asil: string | null | undefined) => getAsilChip(asil, mode),
      /** Stroke width. */
      weight: getAsilLineWeight,
    }),
    [mode],
  );
}

// ---------------------------------------------------------------------------
// "Not set"
// ---------------------------------------------------------------------------

/**
 * Sentinel value + display label for an explicitly "unset" ASIL.
 *
 * Stored as an empty string in `malfunction_asil` / `req_asil`. The
 * "Malfunctions without ASIL" validation check treats both an absent key
 * and this empty value as "not set" (see workspace-service.ts).
 */
export const ASIL_UNSET_VALUE = '';
export const ASIL_UNSET_LABEL = 'Not set';

// ---------------------------------------------------------------------------
// Grouped Select options (with an explicit "Not set" entry)
// ---------------------------------------------------------------------------

export interface AsilSelectOption {
  label: string;
  value: string;
  /** Colour for the leading dot in `optionRender`. */
  color: string;
}

export interface AsilSelectGroup {
  label: string;
  options: AsilSelectOption[];
}

/** A standalone option or a grouped set of options. */
export type AsilSelectEntry = AsilSelectOption | AsilSelectGroup;

export interface AsilValueGroup {
  label: string;
  options: string[];
}

/**
 * Builds the grouped ASIL options for a Select, prefixed with a standalone
 * "Not set" option (value `''`) so users can explicitly choose "no ASIL"
 * rather than relying on the clear (x) affordance.
 *
 * Each option carries a `color` for a leading dot via `optionRender`; "Not set"
 * uses the neutral QM grey. `mode` is required because the dot is an on-canvas
 * mark against the dropdown surface, so it is subject to the same contrast floor
 * as everything else in the ramp.
 */
export function buildAsilOptionGroups(groups: AsilValueGroup[], mode: ThemeMode): AsilSelectEntry[] {
  return [
    { label: ASIL_UNSET_LABEL, value: ASIL_UNSET_VALUE, color: LINE_BY_LEVEL[mode][0] },
    ...groups.map((group) => ({
      label: group.label,
      options: group.options.map((value) => ({
        label: value,
        value,
        color: getAsilIconColor(value, mode),
      })),
    })),
  ];
}

/**
 * {@link buildAsilOptionGroups} bound to the active theme and memoized.
 *
 * Preferred over calling the builder directly: the dots are on-canvas marks and
 * so are theme-dependent, and every call site that needs them is a component
 * already.
 */
export function useAsilOptionGroups(groups: AsilValueGroup[]): AsilSelectEntry[] {
  const mode = useThemeMode();
  return useMemo(() => buildAsilOptionGroups(groups, mode), [groups, mode]);
}

export { MAX_LEVEL as ASIL_MAX_LEVEL };
