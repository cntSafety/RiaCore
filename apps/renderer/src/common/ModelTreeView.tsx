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
import { Tree, Input, theme } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import { useState, useMemo } from 'react';

const { useToken } = theme;

interface ModelTreeViewProps {
  data: DataNode[];
  selectedKeys?: string[];
  onSelect?: (key: string) => void;
  showSearch?: boolean;
  loading?: boolean;
}

function filterTree(nodes: DataNode[], term: string): DataNode[] {
  return nodes.reduce<DataNode[]>((acc, node) => {
    const title = String(node.title ?? '').toLowerCase();
    const children = node.children ? filterTree(node.children, term) : undefined;
    if (title.includes(term) || (children && children.length > 0)) {
      acc.push({ ...node, children });
    }
    return acc;
  }, []);
}

export function ModelTreeView({
  data,
  selectedKeys = [],
  onSelect,
  showSearch = true,
}: ModelTreeViewProps) {
  const { token } = useToken();
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => (search ? filterTree(data, search.toLowerCase()) : data),
    [data, search],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {showSearch && (
        <div style={{ padding: '4px 6px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Input
            prefix={<SearchOutlined style={{ fontSize: 11 }} />}
            placeholder="Filter…"
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ fontSize: 12 }}
          />
        </div>
      )}
      <Tree
        blockNode
        showIcon
        defaultExpandAll
        treeData={filtered}
        selectedKeys={selectedKeys}
        onSelect={(keys) => onSelect && onSelect(keys[0] as string)}
        style={{ flex: 1, overflow: 'auto', fontSize: 12, background: 'transparent', padding: '4px 0' }}
      />
    </div>
  );
}
