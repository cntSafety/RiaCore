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
 * DiffEdgeList — paginated list of edge / cross-NS edge changes.
 *
 * Handles sections:
 *   addedEdges, deletedEdges, modifiedEdges,
 *   addedCrossNsEdges, deletedCrossNsEdges, modifiedCrossNsEdges
 */

import { useState } from 'react';
import {
  Button,
  Checkbox,
  Empty,
  Input,
  Spin,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import {
  PlusCircleOutlined,
  MinusCircleOutlined,
  EditOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type {
  EdgeSnapshot,
  EdgeModification,
  CrossNsEdgeSnapshot,
  CrossNsEdgeModification,
  DiffResultSection,
  PropertyChange,
} from '@riacore/app-contracts';
import { useDiffResultPage, useDiffResult } from '../../hooks/useDiffMutations';
import { useDiffStore } from '../../store/diffStore';

const { useToken } = theme;
const { Text } = Typography;

const SECTION_LABELS: Record<string, string> = {
  addedEdges:           'Added Edges',
  deletedEdges:         'Deleted Edges',
  modifiedEdges:        'Modified Edges',
  addedCrossNsEdges:    'Added Cross-NS Edges',
  deletedCrossNsEdges:  'Deleted Cross-NS Edges',
  modifiedCrossNsEdges: 'Modified Cross-NS Edges',
};

const SECTION_ICON: Record<string, React.ReactNode> = {
  addedEdges:           <PlusCircleOutlined style={{ color: '#52c41a' }} />,
  deletedEdges:         <MinusCircleOutlined style={{ color: '#ff4d4f' }} />,
  modifiedEdges:        <EditOutlined style={{ color: '#fa8c16' }} />,
  addedCrossNsEdges:    <PlusCircleOutlined style={{ color: '#52c41a' }} />,
  deletedCrossNsEdges:  <MinusCircleOutlined style={{ color: '#ff4d4f' }} />,
  modifiedCrossNsEdges: <EditOutlined style={{ color: '#fa8c16' }} />,
};

type EdgeItem = EdgeSnapshot | EdgeModification | CrossNsEdgeSnapshot | CrossNsEdgeModification;

function getEdgeKey(item: EdgeItem): string {
  return `${item.sourceStableId}::${item.targetStableId}::${item.relationshipType}`;
}

function getRelType(item: EdgeItem): string {
  return item.relationshipType ?? '';
}

function getChanges(item: EdgeItem): PropertyChange[] {
  return (item as EdgeModification).propertyChanges ?? [];
}

interface Props {
  diffId: string;
  section: DiffResultSection;
}

export function DiffEdgeList({ diffId, section }: Props) {
  const { token } = useToken();
  const {
    pageOffset, pageSize,
    filterText, filterRelationshipType,
    selectedChangeIds,
    toggleChangeSelection,
    setPageOffset,
    setFilterText,
    setFilterRelationshipType,
  } = useDiffStore();

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { data: fullResult } = useDiffResult(diffId);

  // Build a stableId → display name lookup from all node snapshots in the diff result
  const nodeNameMap = (() => {
    if (!fullResult) return new Map<string, string>();
    const map = new Map<string, string>();
    const resolveNameFromAttrs = (attrs: Record<string, unknown>): string => {
      const nameValue =
        attrs['has_name'] ?? attrs['short_name'] ?? attrs['req_name'] ??
        attrs['name'] ?? attrs['title'] ?? attrs['note_text'];
      return typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : '';
    };
    for (const n of fullResult.addedNodes) {
      const name = resolveNameFromAttrs(n.attributes);
      if (name) map.set(n.stableId, name);
    }
    for (const n of fullResult.deletedNodes) {
      const name = resolveNameFromAttrs(n.attributes);
      if (name) map.set(n.stableId, name);
    }
    for (const n of fullResult.modifiedNodes) {
      const snapshot = n.rightSnapshot ?? n.leftSnapshot;
      const name = resolveNameFromAttrs(snapshot.attributes);
      if (name) map.set(n.stableId, name);
    }
    return map;
  })();

  /** Resolve a stableId to a short display label, preferring pre-computed labels on the snapshot. */
  const resolveEndpointLabel = (stableId: string, precomputed?: string): string => {
    if (precomputed) return precomputed;
    const name = nodeNameMap.get(stableId);
    if (name) return name;
    // For cross-ns edges, the stableId might be a path like /TigerDetectionSW/SensorFusionMiddleware
    if (stableId.includes('/')) {
      const segments = stableId.split('/');
      return segments[segments.length - 1] || stableId;
    }
    // Truncate UUID
    return stableId.length > 16 ? stableId.slice(0, 8) + '…' : stableId;
  };

  const { data: page, isLoading, isError } = useDiffResultPage(
    diffId,
    section,
    pageOffset,
    pageSize,
    filterText || filterRelationshipType
      ? { filterText: filterText || undefined, filterRelationshipType: filterRelationshipType || undefined }
      : undefined,
  );

  const items = (page?.items ?? []) as EdgeItem[];
  const totalCount = page?.totalCount ?? 0;
  const hasNext = page?.hasMore ?? false;
  const hasPrev = pageOffset > 0;
  const currentPage  = Math.floor(pageOffset / pageSize) + 1;
  const totalPages   = Math.max(1, Math.ceil(totalCount / pageSize));

  const isModifiedSection = section.startsWith('modified');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Filter bar */}
      <div
        style={{
          padding: '6px 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <Text strong style={{ fontSize: 12, alignSelf: 'center' }}>
          {SECTION_ICON[section]} {SECTION_LABELS[section] ?? section}
          {' '}
          <Text type="secondary" style={{ fontWeight: 400 }}>({totalCount})</Text>
        </Text>
        <Input.Search
          size="small"
          placeholder="Filter by text…"
          allowClear
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          onSearch={setFilterText}
          style={{ width: 200 }}
        />
        <Input
          size="small"
          placeholder="Relationship type…"
          allowClear
          value={filterRelationshipType}
          onChange={e => setFilterRelationshipType(e.target.value)}
          style={{ width: 180 }}
        />
      </div>

      {/* List body */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Spin size="small" />
          </div>
        )}
        {isError && (
          <Text type="danger" style={{ padding: 12, display: 'block', fontSize: 12 }}>
            Failed to load page.
          </Text>
        )}
        {!isLoading && !isError && items.length === 0 && (
          <Empty description="No items" style={{ margin: '24px auto' }} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}

        {!isLoading && items.map((item) => {
          const edgeKey = getEdgeKey(item);
          const relType = getRelType(item);
          const changes = getChanges(item);
          const isExpanded = expandedKey === edgeKey;
          const isChecked = selectedChangeIds.has(edgeKey);
          const isCrossNs = section.includes('CrossNs');

          return (
            <div
              key={edgeKey}
              style={{
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                background: isChecked ? `${token.colorPrimary}0d` : 'transparent',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '5px 12px',
                  gap: 8,
                  cursor: isModifiedSection ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
                onClick={() => isModifiedSection && setExpandedKey(isExpanded ? null : edgeKey)}
              >
                <Checkbox
                  checked={isChecked}
                  onClick={e => e.stopPropagation()}
                  onChange={() => toggleChangeSelection(edgeKey)}
                />
                {SECTION_ICON[section]}
                {isCrossNs && (
                  <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>cross-ns</Tag>
                )}
                <Text
                  style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={`${item.sourceStableId} → ${item.targetStableId}`}
                >
                  {resolveEndpointLabel(item.sourceStableId, (item as CrossNsEdgeSnapshot).sourceLabel)}
                  <span style={{ color: token.colorTextSecondary }}> → </span>
                  {resolveEndpointLabel(item.targetStableId, (item as CrossNsEdgeSnapshot).targetLabel)}
                </Text>
                {relType && (
                  <Tag style={{ fontSize: 10, margin: 0 }}>{relType}</Tag>
                )}
                {isModifiedSection && changes.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    {changes.length} attr Δ
                  </Text>
                )}
              </div>

              {isExpanded && isModifiedSection && changes.length > 0 && (
                <div style={{ padding: '0 12px 8px 32px' }}>
                  <Table<PropertyChange & { key: string }>
                    size="small"
                    dataSource={changes.map((c, i) => ({ ...c, key: `${c.attribute}-${i}` }))}
                    pagination={false}
                    columns={[
                      {
                        title: 'Attribute',
                        dataIndex: 'attribute',
                        width: 160,
                        render: (val: string, row) => (
                          <span>
                            <Tag
                              color={row.changeKind === 'added' ? 'green' : row.changeKind === 'deleted' ? 'red' : 'orange'}
                              style={{ fontSize: 10, marginRight: 4 }}
                            >
                              {row.changeKind}
                            </Tag>
                            <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{val}</Text>
                          </span>
                        ),
                      },
                      {
                        title: 'Left',
                        dataIndex: 'leftValue',
                        render: (v: unknown) => v !== undefined && v !== null
                          ? <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{String(v)}</Text>
                          : <Text type="secondary" italic>—</Text>,
                      },
                      {
                        title: 'Right',
                        dataIndex: 'rightValue',
                        render: (v: unknown) => v !== undefined && v !== null
                          ? <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{String(v)}</Text>
                          : <Text type="secondary" italic>—</Text>,
                      },
                    ]}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalCount > pageSize && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '6px 12px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
          <Button
            size="small"
            icon={<LeftOutlined />}
            disabled={!hasPrev}
            onClick={() => setPageOffset(pageOffset - pageSize)}
          />
          <Text style={{ fontSize: 11 }}>
            Page {currentPage} / {totalPages}
          </Text>
          <Button
            size="small"
            icon={<RightOutlined />}
            disabled={!hasNext}
            onClick={() => setPageOffset(pageOffset + pageSize)}
          />
        </div>
      )}
    </div>
  );
}
