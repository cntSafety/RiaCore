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
 * NodeDiffDetail — attribute-level diff table for a single modified node.
 * Shows PropertyChange[] as a left/right comparison table.
 */

import { Table, Tag, Typography } from 'antd';
import type { NodeModification, PropertyChange } from '@riacore/app-contracts';

const { Text } = Typography;

interface Props {
  modification: NodeModification;
}

type ChangeRow = PropertyChange & { key: string };

/** Map change kinds to standard Ant Design preset tag colors for readability */
const CHANGE_TAG_COLOR: Record<string, string> = {
  added:    'success',
  deleted:  'error',
  modified: 'warning',
};

function renderValue(val: unknown): React.ReactNode {
  if (val === undefined || val === null) return <Text type="secondary" italic>—</Text>;
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return <Text style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-word' }}>{str}</Text>;
}

export function NodeDiffDetail({ modification }: Props) {
  const rows: ChangeRow[] = modification.propertyChanges.map((ch, i) => ({
    ...ch,
    key: `${ch.attribute}-${i}`,
  }));

  return (
    <Table<ChangeRow>
      size="small"
      dataSource={rows}
      pagination={false}
      style={{ margin: '4px 0' }}
      columns={[
        {
          title: 'Change',
          dataIndex: 'changeKind',
          width: 90,
          render: (kind: string) => (
            <Tag color={CHANGE_TAG_COLOR[kind] ?? 'default'} style={{ fontSize: 10, margin: 0 }}>
              {kind}
            </Tag>
          ),
        },
        {
          title: 'Attribute',
          dataIndex: 'attribute',
          width: 160,
          render: (val: string) => (
            <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{val}</Text>
          ),
        },
        {
          title: 'Left value',
          dataIndex: 'leftValue',
          render: renderValue,
        },
        {
          title: 'Right value',
          dataIndex: 'rightValue',
          render: renderValue,
        },
      ]}
    />
  );
}
