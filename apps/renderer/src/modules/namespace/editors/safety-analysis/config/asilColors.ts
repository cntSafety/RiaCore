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
/** ASIL level → Ant Design Tag color string. */
export const ASIL_COLORS: Record<string, string> = {
  QM: 'default',
  A:  'green',
  B:  'lime',
  C:  'orange',
  D:  'red',
};

/**
 * Sentinel value + display label for an explicitly "unset" ASIL.
 *
 * Stored as an empty string in `malfunction_asil` / `req_asil`. The
 * "Malfunctions without ASIL" validation check treats both an absent key
 * and this empty value as "not set" (see workspace-service.ts).
 */
export const ASIL_UNSET_VALUE = '';
export const ASIL_UNSET_LABEL = 'Not set';

/**
 * Resolve the Tag color for an ASIL value.
 * Decomposition variants like "B(C)" resolve to the highest component color (C → orange).
 */
export function getAsilColor(asil: string): string {
  // Direct match for core levels
  if (ASIL_COLORS[asil]) return ASIL_COLORS[asil];

  // Decomposition: extract components from e.g. "B(C)" → ["B", "C"]
  const match = asil.match(/^([A-D]|QM)\(([A-D]|QM)\)$/);
  if (match) {
    const order = ['QM', 'A', 'B', 'C', 'D'];
    const left = order.indexOf(match[1]);
    const right = order.indexOf(match[2]);
    const highest = order[Math.max(left, right)];
    return ASIL_COLORS[highest] ?? 'default';
  }

  return 'default';
}

/** ASIL level → hex color for diagram node borders. */
export const ASIL_HEX_COLORS: Record<string, string> = {
  QM: '#8c8c8c',
  A:  '#52c41a',
  B:  '#a0d911',
  C:  '#ffa940',
  D:  '#d4380d',
};

/**
 * Resolve the hex color for an ASIL value.
 * Decomposition variants like "B(C)" resolve to the highest component color (C → #ffa940).
 */
export function getAsilHexColor(asil: string): string {
  // Direct match for core levels
  if (ASIL_HEX_COLORS[asil]) return ASIL_HEX_COLORS[asil];

  // Decomposition: extract components from e.g. "B(C)" → ["B", "C"]
  const match = asil.match(/^([A-D]|QM)\(([A-D]|QM)\)$/);
  if (match) {
    const order = ['QM', 'A', 'B', 'C', 'D'];
    const left = order.indexOf(match[1]);
    const right = order.indexOf(match[2]);
    const highest = order[Math.max(left, right)];
    return ASIL_HEX_COLORS[highest] ?? '#8c8c8c';
  }

  return '#8c8c8c';
}

// ---------------------------------------------------------------------------
// Grouped Select options (with an explicit "Not set" entry)
// ---------------------------------------------------------------------------

export interface AsilSelectOption {
  label: string;
  value: string;
  /** Hex color for an optional leading color dot in `optionRender`. */
  color: string;
}

export interface AsilSelectGroup {
  label: string;
  options: AsilSelectOption[];
}

/** A standalone option or a grouped set of options. */
export type AsilSelectEntry = AsilSelectOption | AsilSelectGroup;

/**
 * Builds the grouped ASIL options for a Select, prefixed with a standalone
 * "Not set" option (value `''`) so users can explicitly choose "no ASIL"
 * rather than relying on the clear (×) affordance.
 *
 * Each option carries a `color` so callers can render a leading color dot via
 * `optionRender`; the "Not set" option uses the neutral QM grey.
 */
export interface AsilValueGroup {
  label: string;
  options: string[];
}

export function buildAsilOptionGroups(groups: AsilValueGroup[]): AsilSelectEntry[] {
  return [
    { label: ASIL_UNSET_LABEL, value: ASIL_UNSET_VALUE, color: '#8c8c8c' },
    ...groups.map((group) => ({
      label: group.label,
      options: group.options.map((value) => ({
        label: value,
        value,
        color: getAsilHexColor(value),
      })),
    })),
  ];
}
