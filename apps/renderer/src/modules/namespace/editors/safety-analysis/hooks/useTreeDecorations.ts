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
import { useMemo } from 'react';
import { useMetamodelRendering } from '../../../../../hooks/useMetamodelRendering';
import { buildSysmlDecorations } from '../config/nodeTypeConfig';

/** The same metamodel overlay for tree rows and related-element rows. */
export function useTreeDecorations() {
  const { data: json } = useMetamodelRendering('SysMLv2');
  const { data: textual } = useMetamodelRendering('SysMLv2Textual');
  return useMemo(() => {
    if (!json && !textual) return undefined;
    return buildSysmlDecorations({ ...json, ...textual });
  }, [json, textual]);
}
