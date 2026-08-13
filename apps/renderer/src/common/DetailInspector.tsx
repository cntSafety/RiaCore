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
import { Descriptions, Button, Empty, theme } from 'antd';
import { EditOutlined } from '@ant-design/icons';

const { useToken } = theme;

export interface InspectorField {
  label: string;
  value: React.ReactNode;
}

interface DetailInspectorProps {
  title?: string;
  fields: InspectorField[];
  onEdit?: () => void;
  emptyText?: string;
}

export function DetailInspector({
  title,
  fields,
  onEdit,
  emptyText = 'Select an item to inspect',
}: DetailInspectorProps) {
  const { token } = useToken();

  if (fields.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={emptyText}
        style={{ padding: 24, fontSize: 12 }}
      />
    );
  }

  return (
    <div style={{ padding: '8px 12px' }}>
      {title && (
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: token.colorText }}>
          {title}
        </div>
      )}

      <Descriptions
        column={1}
        size="small"
        bordered={false}
        labelStyle={{ fontSize: 11, color: token.colorTextTertiary, width: 90, paddingRight: 8 }}
        contentStyle={{ fontSize: 12 }}
      >
        {fields.map((f, i) => (
          <Descriptions.Item key={i} label={f.label}>
            {f.value}
          </Descriptions.Item>
        ))}
      </Descriptions>

      {onEdit && (
        <div style={{ marginTop: 10 }}>
          <Button size="small" type="primary" icon={<EditOutlined />} onClick={onEdit} style={{ fontSize: 11 }}>
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
