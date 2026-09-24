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
 * DiffNodeList — paginated virtualized list of node changes.
 *
 * Handles sections: addedNodes, deletedNodes, modifiedNodes.
 * Checkboxes for merge cherry-picking.
 * Expandable rows show NodeDiffDetail for modifications.
 */

import { useState } from 'react';
import {
  Button,
  Checkbox,
  Input,
  Spin,
  Tag,
  Typography,
  theme,
  Empty,
} from 'antd';
import {
  PlusCircleOutlined,
  MinusCircleOutlined,
  EditOutlined,
  LeftOutlined,
  RightOutlined,
  RightCircleOutlined,
  DownCircleOutlined,
} from '@ant-design/icons';
import type { NodeSnapshot, NodeModification, DiffResultSection } from '@riacore/app-contracts';
import { useDiffResultPage, useDiffResult } from '../../hooks/useDiffMutations';
import { useDiffStore } from '../../store/diffStore';
import { NodeDiffDetail } from './NodeDiffDetail';
import { labelSectionHeading } from './diffSectionLabels';
import { labelConceptType } from './safetyDiffLabels';

const { useToken } = theme;
const { Text } = Typography;

const SECTION_ICON: Record<string, React.ReactNode> = {
  addedNodes:   <PlusCircleOutlined style={{ color: '#52c41a' }} />,
  deletedNodes: <MinusCircleOutlined style={{ color: '#ff4d4f' }} />,
  modifiedNodes:<EditOutlined style={{ color: '#fa8c16' }} />,
};

interface Props {
  diffId: string;
  section: DiffResultSection;
}

export function DiffNodeList({ diffId, section }: Props) {
  const { token } = useToken();
  const {
    pageOffset, pageSize,
    filterText, filterConceptType,
    selectedChangeIds,
    toggleChangeSelection,
    setPageOffset,
    setFilterText,
    setFilterConceptType,
  } = useDiffStore();

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Metamodel drives which domain vocabulary applies to concept types and
  // attribute keys. Already cached by the endpoint-label path in DiffEdgeList.
  const { data: fullResult } = useDiffResult(diffId);
  const metamodel = fullResult?.metamodel ?? '';

  const { data: page, isLoading, isError } = useDiffResultPage(
    diffId,
    section,
    pageOffset,
    pageSize,
    filterText || filterConceptType
      ? { filterText: filterText || undefined, filterConceptType: filterConceptType || undefined }
      : undefined,
  );

  const items = (page?.items ?? []) as (NodeSnapshot | NodeModification)[];
  const totalCount = page?.totalCount ?? 0;
  const hasNext = page?.hasMore ?? false;
  const hasPrev = pageOffset > 0;
  const currentPage  = Math.floor(pageOffset / pageSize) + 1;
  const totalPages   = Math.max(1, Math.ceil(totalCount / pageSize));

  const isModifiedSection = section === 'modifiedNodes';

  const getStableId = (item: NodeSnapshot | NodeModification): string =>
    'stableId' in item ? item.stableId : (item as NodeSnapshot).stableId;

  const getConceptType = (item: NodeSnapshot | NodeModification): string =>
    'conceptType' in item ? item.conceptType : '';

  /** Resolve a human-readable display name from node attributes. */
  const getDisplayName = (item: NodeSnapshot | NodeModification): string => {
    const attrs: Record<string, unknown> =
      'attributes' in item
        ? (item as NodeSnapshot).attributes
        : ((item as NodeModification).rightSnapshot ?? (item as NodeModification).leftSnapshot).attributes;
    const nameValue =
      attrs['has_name'] ??
      attrs['short_name'] ??
      attrs['req_name'] ??
      attrs['name'] ??
      attrs['title'] ??
      attrs['note_text'] ??
      attrs['tag_name'];
    const name = typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : '';

    if (!name) return '';

    // If the name is generic (matches concept type label), enrich with a secondary attribute
    const conceptType = getConceptType(item);
    const genericNames = new Set([conceptType, conceptType.replace(/_/g, ' ')]);
    const isGeneric = genericNames.has(name.toLowerCase()) || name.toLowerCase() === conceptType.replace(/_/g, ' ');

    if (isGeneric) {
      // Try to find a distinguishing secondary attribute
      const secondary =
        attrs['risk_rating_note'] ??
        attrs['description'] ??
        attrs['task_description'] ??
        attrs['malfunction_description'] ??
        attrs['req_text'] ??
        attrs['reviewer_comment'];
      if (typeof secondary === 'string' && secondary.trim()) {
        const trimmed = secondary.trim();
        const truncated = trimmed.length > 23 ? trimmed.slice(0, 23) + '…' : trimmed;
        return `${name} (${truncated})`;
      }
    }

    return name;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
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
          {SECTION_ICON[section]} {labelSectionHeading(section)}
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
          placeholder="Concept type…"
          allowClear
          value={filterConceptType}
          onChange={e => setFilterConceptType(e.target.value)}
          style={{ width: 160 }}
        />
      </div>

      {/* List body — the scroll container. minHeight: 0 is what lets it shrink
          below its content height so `overflow: auto` actually has something to
          scroll; without it the rows push the whole panel taller than the
          available space and the overflow is clipped by an ancestor instead. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
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
          const stableId = getStableId(item);
          const conceptType = getConceptType(item);
          const displayName = getDisplayName(item);
          const isExpanded = expandedId === stableId;
          const isChecked = selectedChangeIds.has(stableId);

          return (
            <div
              key={stableId}
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
                  borderRadius: 4,
                  transition: 'background 0.15s',
                }}
                className={isModifiedSection ? 'diff-node-row-expandable' : undefined}
                onClick={() => isModifiedSection && setExpandedId(isExpanded ? null : stableId)}
              >
                {isModifiedSection && (
                  isExpanded
                    ? <DownCircleOutlined style={{ fontSize: 12, color: token.colorPrimary }} />
                    : <RightCircleOutlined style={{ fontSize: 12, color: token.colorTextTertiary }} />
                )}
                <Checkbox
                  checked={isChecked}
                  onClick={e => e.stopPropagation()}
                  onChange={() => toggleChangeSelection(stableId)}
                />
                {SECTION_ICON[section]}
                <Text
                  style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={displayName || stableId}
                >
                  {displayName || stableId}
                </Text>
                {conceptType && (
                  <Tag style={{ fontSize: 10, margin: 0 }} title={conceptType}>
                    {labelConceptType(conceptType, metamodel)}
                  </Tag>
                )}
                {isModifiedSection && (
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    {(item as NodeModification).propertyChanges?.length ?? 0} attr Δ
                  </Text>
                )}
              </div>
              {isExpanded && isModifiedSection && (
                <div style={{ padding: '0 12px 8px 32px' }}>
                  <NodeDiffDetail modification={item as NodeModification} metamodel={metamodel} />
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
