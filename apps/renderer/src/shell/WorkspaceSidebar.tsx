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
import { Tree, Spin } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { DatabaseOutlined, ImportOutlined, SafetyOutlined, FolderOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore, type NamespaceContext } from '../store/workspaceStore';
import { api } from '../api/riacore';

interface WorkspaceSidebarProps {
  onSelectNamespace?: (ns: NamespaceContext) => void;
  onNavigateHome?: () => void;
}


export function WorkspaceSidebar({ onSelectNamespace, onNavigateHome }: WorkspaceSidebarProps) {
  const { projectName, activeNamespace } = useWorkspaceStore();

  const { data: wsStatus, isLoading } = useQuery({
    queryKey: ['workspace.status'],
    queryFn: api.workspace.getStatus,
    refetchInterval: 10000,
    staleTime: 8000,
  });

  const workingDir = wsStatus?.state === 'open' ? wsStatus.info.workingDir : null;

  const { data: namespaceRows = [] } = useQuery({
    queryKey: ['namespaces.list', workingDir ?? 'no-workspace'],
    queryFn: api.namespaces.list,
    enabled: !!workingDir,
    placeholderData: [],
    staleTime: 5000,
  });

  const { data: importSources = [] } = useQuery({
    queryKey: ['imports.listSources', workingDir ?? 'no-workspace', 'sidebar'],
    queryFn: () => api.imports.listSources(),
    enabled: !!workingDir,
    placeholderData: [],
    staleTime: 5000,
  });

  // Map from targetNamespace (raw namespace name) → source display name
  const sourceDisplayNames = new Map<string, string>(
    importSources.map((src) => [src.targetNamespace, src.name]),
  );

  const namespaces: NamespaceContext[] = namespaceRows
    .filter((ns) => ns.role !== 'supervised_update_temp')
    .map((ns) => ({
      namespaceId: ns.namespaceId,
      name: ns.name,
      role: ns.role as NamespaceContext['role'],
      owningApplication: ns.owningApplication,
      metamodel: ns.metamodel,
      workingDir: workingDir ?? '',
    }));

  const treeData: DataNode[] = [
    {
      key: 'workspace',
      title: projectName ?? 'Workspace',
      icon: <FolderOutlined />,
      children: [
        {
          key: 'authored',
          title: 'Authored Namespaces',
          icon: <SafetyOutlined />,
          selectable: false,
          children: namespaces.filter((n) => n.role === 'authored').map((ns) => ({
            key: ns.namespaceId,
            title: ns.name,
            icon: <DatabaseOutlined />,
            isLeaf: true,
          })),
        },
        {
          key: 'imported',
          title: 'Import Sources',
          icon: <ImportOutlined />,
          selectable: false,
          children: namespaces.filter((n) => n.role === 'imported').map((ns) => ({
            key: ns.namespaceId,
            // Show the configured source display name when available (issue #53)
            title: sourceDisplayNames.get(ns.name) ?? ns.name,
            icon: <DatabaseOutlined />,
            isLeaf: true,
          })),
        },
      ],
    },
  ];

  const handleSelect = (selectedKeys: React.Key[]) => {
    const key = selectedKeys[0] as string;
    const ns = namespaces.find((n) => n.namespaceId === key);
    if (ns && onSelectNamespace) {
      onSelectNamespace(ns);
    }
    if (key === 'workspace' && onNavigateHome) {
      onNavigateHome();
    }
  };

  return (
    <div
      className="riacore-sidebar"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {isLoading ? (
        <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      ) : (
        <Tree
          blockNode
          showIcon
          defaultExpandAll
          treeData={treeData}
          selectedKeys={activeNamespace ? [activeNamespace.namespaceId] : []}
          onSelect={handleSelect}
          style={{
            padding: '4px 0',
            fontSize: 12,
            flex: 1,
            overflow: 'auto',
            background: 'transparent',
          }}
        />
      )}
    </div>
  );
}
