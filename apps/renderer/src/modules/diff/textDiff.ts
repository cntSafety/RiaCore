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
 * Word-level text diff — re-exported from app-contracts.
 *
 * The implementation lives in `@riacore/app-contracts` (diff-presentation.ts)
 * because the archived HTML report is generated in app-core and must highlight
 * changes identically to this screen. This module stays as the renderer-local
 * import point so diff UI code keeps a stable path.
 */

export {
  diffWords,
  diffPropertyValues,
  MAX_LCS_CELLS,
  type Segment,
  type SegmentKind,
  type WordDiff,
} from '@riacore/app-contracts';
