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
import { Alert, Button, Space, Table, Tag, Typography, theme } from 'antd';
import { createElement } from 'react';
import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import type { RelationshipData } from '@riacore/app-contracts';
import { useElementRelationships } from '../hooks/useElementRelationships';
import { sortElementRelationships } from '../utils/elementRelationships';
import { useRelationshipTreeNavigation } from '../hooks/useRelationshipTreeNavigation';
import { SectionHeader } from './SectionHeader';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import { useTreeDecorations } from '../hooks/useTreeDecorations';
import { getNodeDecoration } from '../config/nodeTypeConfig';
import { useAsilPalette } from '../config/asilColors';
import type { ScopedTreeNavigator } from '../types';

/** Read-only database links. Deliberately independent of diagram mappings and analysis scope. */
export function ElementRelationships({ nodeId, workspaceKey, onShowInTree }: {
  nodeId: number;
  workspaceKey: string | null;
  onShowInTree?: ScopedTreeNavigator;
}) {
  const { token } = theme.useToken();
  const decorations = useTreeDecorations();
  const asilPalette = useAsilPalette();
  const showInTree = useRelationshipTreeNavigation(onShowInTree);
  const relationships = useElementRelationships(nodeId, workspaceKey);
  const rows = sortElementRelationships(relationships.data ?? []);

  const renderRelatedElement = (node: RelationshipData['connectedNode']) => {
    const target = { nodeId: node.node_id, namespace: node.namespace, concept: node.concept, name: node.name };
    const decoration = getNodeDecoration(node.concept, decorations);
    return (
      <ShowInTreeTrigger
        homeTarget={target}
        // Always supply an in-place callback: never fall back to opening another analysis.
        onNavigate={() => { void showInTree(target); }}
        hideKebab
        wrapperStyle={{ maxWidth: '100%', width: '100%' }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}>
          <Space align="start" size={8} style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {createElement(decoration.icon, { style: { color: node.concept === 'malfunction' ? asilPalette.icon(node.asil) : decoration.color } } as Record<string, unknown>)}
            <Space orientation="vertical" size={0}>
              <Typography.Text>{node.name}</Typography.Text>
              {node.identifier && node.identifier !== node.name && (
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>{node.identifier}</Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>{node.concept}</Typography.Text>
            </Space>
          </Space>
          <Button
            type="text"
            size="small"
            icon={<ExportOutlined />}
            aria-label={`Show ${node.name} in tree`}
            onClick={() => { void showInTree(target); }}
            style={{ flexShrink: 0 }}
          >Show in tree</Button>
        </div>
      </ShowInTreeTrigger>
    );
  };

  return (
    <section aria-label="Relationships" style={{ borderLeft: `3px solid ${token.colorPrimary}`, paddingLeft: 16 }}>
      <SectionHeader
        title="Relationships"
        fontSize={token.fontSize}
        count={relationships.data ? rows.length : undefined}
        action={
          <Button
            aria-label="Refresh relationships"
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            loading={relationships.isFetching}
            disabled={!relationships.available}
            onClick={() => { void relationships.refetch(); }}
          >Refresh relationships</Button>
        }
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: token.fontSizeSM, marginBottom: 8 }}>
        Incoming links point to this element; outgoing links point to the related element.
      </Typography.Paragraph>
      {relationships.isError ? (
        <Alert
          type="error"
          showIcon
          title="Could not load relationships"
          description={relationships.error.message}
        />
      ) : (
        <Table<RelationshipData>
          size="middle"
          dataSource={rows}
          rowKey={(row) => `${row.type}:${row.edge_id}:${row.direction}`}
          loading={relationships.isLoading}
          pagination={{
            pageSize: 10,
            hideOnSinglePage: true,
            showSizeChanger: false,
            placement: ['bottomEnd'],
            showTotal: (total, range) => `${range[0]}–${range[1]} of ${total} relationships`,
          }}
          locale={{ emptyText: !relationships.available
            ? 'Open a workspace to view relationships'
            : relationships.isPending ? 'Loading relationships…' : 'No relationships stored for this element' }}
          scroll={{ x: 620 }}
          style={{ overflowWrap: 'anywhere' }}
          columns={[
            {
              title: 'Direction',
              dataIndex: 'direction',
              width: 100,
              render: (direction: RelationshipData['direction']) => direction === 'incoming' ? '← Incoming' : 'Outgoing →',
            },
            {
              title: 'Relationship',
              dataIndex: 'relationship',
              width: 180,
              render: (value: string) => <span style={{ fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM }}>{value}</span>,
            },
            {
              title: 'Related element',
              render: (_, { connectedNode }) => renderRelatedElement(connectedNode),
            },
            {
              title: 'Namespace',
              width: 160,
              render: (_, row) => (
                <Space orientation="vertical" size={4}>
                  <Typography.Text>{row.connectedNode.namespace}</Typography.Text>
                  {row.type === 'cross' && <Tag>Cross namespace</Tag>}
                </Space>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
