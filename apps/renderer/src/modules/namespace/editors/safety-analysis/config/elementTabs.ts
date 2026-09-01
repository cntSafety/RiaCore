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
 * Canonical tab/lens definitions for the CenterPanel.
 *
 * Both selectors — the one shown for a model element and the one shown for a
 * malfunction — are rendered by the same `ElementLensSelector`, so they share
 * one shape and one visual style. Keeping the arrays in a React-free module
 * lets the contract tests assert the real thing instead of a mirrored copy.
 */

export interface TabDefinition {
  key: string;
  label: string;
  /** When > 0, a count badge is shown next to the label. Undefined or 0 means no badge. */
  count?: number;
  /** When true, the option is greyed-out / not selectable. */
  disabled?: boolean;
}

/**
 * Tabs shown when a malfunction is selected (analysis view).
 */
export const MALFUNCTION_TABS: TabDefinition[] = [
  { key: 'overview',     label: 'Overview' },
  { key: 'risk-rating',  label: 'Risk Rating' },
  { key: 'propagation',  label: 'Propagation' },
  { key: 'safety-tasks', label: 'Safety Tasks' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'review',       label: 'Review' },
];

/**
 * Tabs shown when a non-malfunction model element is selected (model browser).
 *
 * `table` renders the malfunction table for the selected scope element — hence
 * the "Malfunctions" label and the malfunction icon. The key stays `table`
 * because it addresses `MalfunctionTableView`, and the store/context-menu
 * plumbing already speaks it.
 */
export const ELEMENT_TABS: TabDefinition[] = [
  { key: 'diagram',     label: 'Model' },
  { key: 'propagation', label: 'Propagation' },
  { key: 'table',       label: 'Malfunctions' },
  { key: 'notes',       label: 'Notes' },
  { key: 'details',     label: 'Details' },
];

/** Element lens keys, as a union — mirrors `WorkspaceState.elementLensView`. */
export type ElementLensKey = 'diagram' | 'propagation' | 'table' | 'notes' | 'details';

/** Fallback lens used when the persisted preference names a key that no longer exists. */
export const DEFAULT_ELEMENT_LENS: ElementLensKey = 'details';

/** True when `key` is one of the currently defined element lenses. */
export function isElementLensKey(key: string): key is ElementLensKey {
  return ELEMENT_TABS.some((t) => t.key === key);
}
