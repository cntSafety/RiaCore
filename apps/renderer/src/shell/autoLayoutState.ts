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
 * Pure Auto_Layout initial-state decision helper
 * (the connection-diagram-layout-persistence feature).
 *
 * The Overview_Canvas is in exactly one of two Auto_Layout states:
 *
 * - **Deactivated** (`Auto_Layout_Deactivated_State`): positions come from the
 *   stored / user-set Diagram_Layout; the layout effect does not run ELK on data
 *   changes.
 * - **Active** (`Auto_Layout_Active_State`): positions come from `computeElkLayout`.
 *   Only entered on `db_open` when zero rendered Canvas_Elements have a
 *   Layout_Record; Auto_Layout is then applied exactly once and the state
 *   transitions to Deactivated.
 *
 * When the Workspace_Phase becomes `db_open`, the initial state is decided by
 * whether at least one rendered Canvas_Element already has a Layout_Record:
 *
 * - ≥1 rendered element has a Layout_Record → Deactivated (Requirement 3.5).
 * - 0 rendered elements have Layout_Records → Active, apply Auto_Layout once,
 *   then Deactivated (Requirement 3.6).
 *
 * This module is deliberately pure (no React, no Zustand, no I/O) so it can be
 * exercised directly by the Property 7 test (task 10.4) and consumed by
 * `WorkspaceCanvas` when wiring the state machine (tasks 10.2 / 11.x).
 */

/** A Canvas_Element is identified for layout purposes by its Layout_Key. */
export interface LayoutKey {
  elementKind: string;
  elementKey: string;
}

/** The two possible Auto_Layout states decided at `db_open`. */
export type AutoLayoutInitialState = 'active' | 'deactivated';

/**
 * NUL separator used to synthesize the stable composite `layout_id`. `\u0000`
 * can never appear in an identifier-like Element_Kind or Element_Key, so the
 * encoding is injective (distinct Layout_Keys → distinct ids). Mirrors
 * `encodeLayoutId` from app-core; the renderer only depends on
 * `@riacore/app-contracts`, so the encoding is duplicated rather than imported
 * from the backend module.
 */
const LAYOUT_ID_SEPARATOR = '\u0000';

/** Encode a Layout_Key `(elementKind, elementKey)` into its `layout_id` string. */
export function encodeLayoutId(elementKind: string, elementKey: string): string {
  return `${elementKind}${LAYOUT_ID_SEPARATOR}${elementKey}`;
}

/**
 * True when at least one of the rendered Canvas_Elements has a Layout_Record in
 * the stored Diagram_Layout, i.e. the rendered Layout_Keys and stored Layout_Keys
 * overlap.
 *
 * @param renderedElements the Layout_Keys of the Canvas_Elements about to render
 * @param storedLayoutIds  the set of `layout_id`s present in the stored
 *                         Diagram_Layout (e.g. the keys of the
 *                         `useDiagramLayout` position map)
 */
export function anyRenderedElementHasRecord(
  renderedElements: readonly LayoutKey[],
  storedLayoutIds: ReadonlySet<string>,
): boolean {
  for (const el of renderedElements) {
    if (storedLayoutIds.has(encodeLayoutId(el.elementKind, el.elementKey))) {
      return true;
    }
  }
  return false;
}

/**
 * Decide the initial Auto_Layout state when the Workspace_Phase becomes
 * `db_open`.
 *
 * Returns `'deactivated'` when at least one rendered Canvas_Element already has a
 * Layout_Record (Requirement 3.5), otherwise `'active'` — meaning the caller
 * should apply Auto_Layout exactly once and then transition to Deactivated
 * (Requirement 3.6).
 */
export function decideInitialAutoLayoutState(
  renderedElements: readonly LayoutKey[],
  storedLayoutIds: ReadonlySet<string>,
): AutoLayoutInitialState {
  return anyRenderedElementHasRecord(renderedElements, storedLayoutIds)
    ? 'deactivated'
    : 'active';
}
