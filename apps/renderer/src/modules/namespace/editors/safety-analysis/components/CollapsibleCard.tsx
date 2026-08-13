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
import { Card, Tag, Space } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { useState, type ReactNode } from 'react';

interface CollapsibleCardProps {
  title: string;
  statusBadge?: string;
  children: ReactNode;
  defaultExpanded?: boolean;
}

export function CollapsibleCard({ title, statusBadge, children, defaultExpanded = false }: CollapsibleCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Card
      size="small"
      style={{ marginBottom: 8 }}
      title={
        <Space
          style={{ cursor: 'pointer', width: '100%', fontSize: 12 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
          <span>{title}</span>
          {statusBadge && <Tag style={{ fontSize: 10, marginLeft: 'auto' }}>{statusBadge}</Tag>}
        </Space>
      }
    >
      {expanded ? children : (
        <div
          style={{ fontSize: 11, color: '#8c8c8c', cursor: 'pointer' }}
          onClick={() => setExpanded(true)}
        >
          Expand to view and edit
        </div>
      )}
    </Card>
  );
}
