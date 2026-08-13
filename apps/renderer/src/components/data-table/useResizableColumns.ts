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
import { useEffect, useMemo, useState } from 'react';
import type { ColumnsType, ColumnType } from 'antd/es/table';
import { ResizableTitle } from './ResizableTitle';

/**
 * Minimum width any column may take, in pixels. Matches the historical
 * `Math.max(60, …)` clamp used by `ModelCheckView`.
 */
export const MIN_COLUMN_WIDTH = 60;

export type WidthMap = Record<string, number>;

/**
 * Pure reducer-style updater for the width map. Returns a new map with the
 * given key clamped to at least {@link MIN_COLUMN_WIDTH}. Property tests in
 * `__tests__/useResizableColumns.property.test.ts` target this function
 * directly.
 */
export function applyResize(
  widths: Readonly<WidthMap>,
  key: string,
  newWidth: number,
): WidthMap {
  return { ...widths, [key]: Math.max(MIN_COLUMN_WIDTH, newWidth) };
}

function columnKey<T>(col: ColumnsType<T>[number]): string {
  const c = col as ColumnType<T>;
  return String(c.key ?? c.dataIndex ?? '');
}

function seedWidthsFromColumns<T>(columns: ColumnsType<T>): WidthMap {
  const seed: WidthMap = {};
  for (const col of columns) {
    const key = columnKey(col);
    if (key === '') continue;
    const w = (col as ColumnType<T>).width;
    if (typeof w === 'number') seed[key] = w;
  }
  return seed;
}

/**
 * Hook that manages per-column widths and wires {@link ResizableTitle} into
 * the antd table's header cell. The hook seeds itself from the initial
 * `columns` array (any column declaring a numeric `width` becomes resizable)
 * and merges newly-declared widths in without clobbering widths the user has
 * already dragged.
 */
export function useResizableColumns<T>(columns: ColumnsType<T>): {
  columns: ColumnsType<T>;
  components: { header: { cell: typeof ResizableTitle } };
} {
  const [widths, setWidths] = useState<WidthMap>(() => seedWidthsFromColumns(columns));

  // When the input columns reference changes, merge any new columns'
  // declared widths into the state without overwriting widths the user
  // has already set.
  useEffect(() => {
    setWidths((prev) => {
      let changed = false;
      const next: WidthMap = { ...prev };
      for (const col of columns) {
        const key = columnKey(col);
        if (key === '') continue;
        if (key in next) continue;
        const w = (col as ColumnType<T>).width;
        if (typeof w === 'number') {
          next[key] = w;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [columns]);

  const resizableColumns = useMemo<ColumnsType<T>>(
    () =>
      columns.map((col) => {
        const key = columnKey(col);
        if (key === '') return col;
        const w = widths[key];
        if (w === undefined) return col;
        return {
          ...col,
          width: w,
          onHeaderCell: () => ({
            width: w,
            onResize: (newWidth: number) => {
              setWidths((prev) => applyResize(prev, key, newWidth));
            },
          }),
        };
      }),
    [columns, widths],
  );

  const components = useMemo(
    () => ({
      header: { cell: ResizableTitle },
    }),
    [],
  );

  return { columns: resizableColumns, components };
}
