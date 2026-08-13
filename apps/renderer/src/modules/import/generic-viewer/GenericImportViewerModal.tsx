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
import { Modal, Tree, Spin, Typography, theme, App } from 'antd';
import { FolderOutlined } from '@ant-design/icons';
import { useState, useEffect, useCallback, createElement } from 'react';
import type React from 'react';
import type { DataNode } from 'antd/es/tree';
import { api } from '../../../api/riacore';
import { getNodeDecoration } from '../../namespace/editors/safety-analysis/config/nodeTypeConfig';
import type { ImportSourceInfo } from '@riacore/app-contracts';

const { Text } = Typography;
const { useToken } = theme;

interface GenericImportViewerModalProps {
  sourceInfo: ImportSourceInfo | null;
  onClose: () => void;
}

interface GenericTreeNode extends DataNode {
  nodeId: number;
  namespace: string;
  concept: string;
}

interface IconProps {
  style: { color: string };
}

function conceptIcon(concept: string) {
  const decoration = getNodeDecoration(concept);
  return createElement(decoration.icon as React.ComponentType<IconProps>, { style: { color: decoration.color } });
}

function toTreeNode(
  child: { node_id: number; concept: string; name: string; hasChildren: boolean },
  namespace: string,
): GenericTreeNode {
  return {
    key: String(child.node_id),
    title: (
      <span>
        <Text style={{ marginRight: 4 }}>{child.name}</Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {child.concept}
        </Text>
      </span>
    ),
    icon: conceptIcon(child.concept),
    isLeaf: !child.hasChildren,
    nodeId: child.node_id,
    namespace,
    concept: child.concept,
  };
}

export function GenericImportViewerModal({ sourceInfo, onClose }: GenericImportViewerModalProps) {
  const { token } = useToken();
  const { message } = App.useApp();
  const [treeData, setTreeData] = useState<GenericTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namespace = sourceInfo?.targetNamespace ?? null;

  useEffect(() => {
    if (!namespace) {
      setTreeData([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setTreeData([]);
    api.namespaces
      .getChildren(namespace)
      .then((resp) => {
        setTreeData(resp.children.map((c) => toTreeNode(c, namespace)));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load model');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [namespace]);

  const loadData = useCallback(
    (node: DataNode): Promise<void> => {
      if (!namespace) return Promise.resolve();
      const gNode = node as GenericTreeNode;
      return api.namespaces
        .getChildren(namespace, gNode.nodeId)
        .then((resp) => {
          const children = resp.children.map((c) => toTreeNode(c, namespace));
          setTreeData((prev) => {
            function insertChildren(nodes: GenericTreeNode[]): GenericTreeNode[] {
              return nodes.map((n) => {
                if (n.key === gNode.key) return { ...n, children };
                if (n.children) return { ...n, children: insertChildren(n.children as GenericTreeNode[]) };
                return n;
              });
            }
            return insertChildren(prev);
          });
        })
        .catch((err: unknown) => {
          void message.error(
            `Failed to load children: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    [namespace, message],
  );

  const rootNode: DataNode = {
    key: '__root__',
    title: (
      <Text strong style={{ fontSize: 13 }}>
        {sourceInfo?.name ?? namespace ?? ''}
      </Text>
    ),
    icon: <FolderOutlined style={{ color: token.colorPrimary }} />,
    children: treeData,
    isLeaf: false,
  };

  return (
    <Modal
      open={sourceInfo !== null}
      onCancel={onClose}
      footer={null}
      width={800}
      destroyOnClose
      title={`Model Browser — ${sourceInfo?.name ?? ''}`}
    >
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Spin size="large" />
        </div>
      )}
      {error && !loading && (
        <div style={{ padding: 16 }}>
          <Text type="danger">{error}</Text>
        </div>
      )}
      {!loading && !error && (
        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          <Tree
            showIcon
            blockNode
            loadData={loadData}
            treeData={[rootNode]}
            defaultExpandedKeys={['__root__']}
            style={{ background: 'transparent' }}
          />
        </div>
      )}
    </Modal>
  );
}
