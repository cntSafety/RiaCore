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
 * DTOs for the connection-diagram-layout-persistence feature.
 *
 * These types cross the IPC boundary, so they are defined here in app-contracts.
 * app-core imports them from `@riacore/app-contracts`; app-contracts must never
 * depend on app-core.
 */

/**
 * A persisted association between one Layout_Key `(elementKind, elementKey)` and
 * one Element_Position `(x, y)`.
 *
 * `elementKind` is an OPAQUE string (no enum constraint): the two current values
 * are `imported` and `analysis`, but any future Element_Kind is accepted without a
 * schema, IPC, or CLI change.
 */
export interface LayoutRecord {
  /** Opaque Element_Kind — not restricted to a fixed enumeration. */
  elementKind: string;
  /** Stable identity of the Canvas_Element within its Element_Kind. */
  elementKey: string;
  /** Finite x coordinate in Overview_Canvas layout coordinates. */
  x: number;
  /** Finite y coordinate in Overview_Canvas layout coordinates. */
  y: number;
}

/** The complete Diagram_Layout: at most one LayoutRecord per Layout_Key. */
export type DiagramLayout = LayoutRecord[];
