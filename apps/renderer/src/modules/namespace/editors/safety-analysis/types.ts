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
/** Element selected from the imported tree panel. */
export interface SelectedTreeElement {
  nodeId: number;
  namespace: string;
  concept: string;
  name?: string;
  /** Host node ID when this element is selected as a cross-namespace reference child. */
  hostNodeId?: number;
  /** Host namespace when this element is selected as a cross-namespace reference child. */
  hostNamespace?: string;
}

