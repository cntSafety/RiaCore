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
import { Table } from 'antd';
import type { TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useResizableColumns } from './useResizableColumns';
import './data-table.css';

export interface DataTableProps<T>
  extends Omit<TableProps<T>, 'columns' | 'components'> {
  columns: ColumnsType<T>;
  /**
   * Optional override for the underlying antd `components` slot. Header cell
   * overrides are merged so the resize handle keeps working alongside any
   * caller-supplied body cell renderer.
   */
  components?: TableProps<T>['components'];
}

type PaginationProp<T> = TableProps<T>['pagination'];

const PAGINATION_DEFAULTS: Exclude<PaginationProp<unknown>, false | undefined> = {
  defaultPageSize: 100,
  showSizeChanger: true,
  pageSizeOptions: ['10', '20', '50', '100'],
  showTotal: (total: number) => `${total} items`,
};

function resolvePagination<T>(p: PaginationProp<T>): PaginationProp<T> {
  if (p === false) return false;
  if (p === undefined) return { ...PAGINATION_DEFAULTS };
  return { ...PAGINATION_DEFAULTS, ...p };
}

export function DataTable<T extends object>(props: DataTableProps<T>) {
  const {
    columns,
    components: callerComponents,
    pagination,
    size,
    ...rest
  } = props;

  const { columns: resizableColumns, components: resizeComponents } =
    useResizableColumns<T>(columns);

  const mergedComponents: TableProps<T>['components'] = {
    ...callerComponents,
    header: {
      ...(callerComponents?.header ?? {}),
      cell: resizeComponents.header.cell,
    },
  };

  return (
    <Table<T>
      {...rest}
      columns={resizableColumns}
      components={mergedComponents}
      pagination={resolvePagination<T>(pagination)}
      size={size ?? 'small'}
    />
  );
}
