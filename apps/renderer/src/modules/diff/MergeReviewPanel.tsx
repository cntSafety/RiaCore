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
 * MergeReviewPanel — controls for applying a two-way merge.
 *
 * Lets the user:
 *  - See how many changes are selected
 *  - Select all / Deselect all
 *  - Choose merge direction
 *  - Apply the merge
 *  - View the merge result summary
 */

import { Alert, Button, Radio, Space, Typography, theme, Divider } from 'antd';
import { MergeCellsOutlined } from '@ant-design/icons';
import type { DiffSummary, MergeResult } from '@riacore/app-contracts';
import { useDiffStore } from '../../store/diffStore';
import { useApplyMerge } from '../../hooks/useDiffMutations';

const { useToken } = theme;
const { Text } = Typography;

interface Props {
  summary: DiffSummary;
}

export function MergeReviewPanel({ summary }: Props) {
  const { token } = useToken();
  const {
    selectedChangeIds,
    mergeDirection,
    setMergeDirection,
    selectAllChanges,
    deselectAllChanges,
  } = useDiffStore();

  const applyMerge = useApplyMerge();

  const selectedCount = selectedChangeIds.size;
  const targetNs = mergeDirection === 'left-into-right' ? summary.rightNamespace : summary.leftNamespace;

  const handleApply = () => {
    applyMerge.mutate({
      diffId: summary.diffId,
      targetNs,
      direction: mergeDirection,
      selectionIds: selectedCount > 0 ? Array.from(selectedChangeIds) : undefined,
    });
  };

  const mergeResult: MergeResult | undefined = applyMerge.data;

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Text strong style={{ fontSize: 12 }}>
          <MergeCellsOutlined style={{ marginRight: 4 }} />
          Merge
        </Text>

        {/* Direction */}
        <Radio.Group
          size="small"
          value={mergeDirection}
          onChange={e => setMergeDirection(e.target.value)}
        >
          <Radio.Button value="left-into-right">
            <Text style={{ fontSize: 11 }}>
              {summary.leftNamespace} → {summary.rightNamespace}
            </Text>
          </Radio.Button>
          <Radio.Button value="right-into-left">
            <Text style={{ fontSize: 11 }}>
              {summary.rightNamespace} → {summary.leftNamespace}
            </Text>
          </Radio.Button>
        </Radio.Group>

        {/* Selection info */}
        <Text type="secondary" style={{ fontSize: 11 }}>
          {selectedCount > 0
            ? `${selectedCount} change(s) selected — only selected items will be merged`
            : 'No items selected — all changes will be merged. Use checkboxes to cherry-pick specific items.'}
        </Text>

        <Space size={4}>
          <Button size="small" onClick={() => selectAllChanges([])}>
            Select All
          </Button>
          <Button size="small" onClick={() => deselectAllChanges()}>
            Deselect All
          </Button>
        </Space>

        <Button
          type="primary"
          size="small"
          icon={<MergeCellsOutlined />}
          loading={applyMerge.isPending}
          onClick={handleApply}
        >
          Apply Merge → {targetNs}
        </Button>
      </div>

      {/* Result summary */}
      {applyMerge.isError && (
        <Alert
          type="error"
          message={applyMerge.error?.message ?? 'Merge failed'}
          showIcon
          style={{ fontSize: 11 }}
        />
      )}
      {mergeResult && (
        <Alert
          type={mergeResult.mergeApplied ? 'success' : 'warning'}
          showIcon
          message={
            mergeResult.mergeApplied
              ? `Merge applied: +${mergeResult.nodesAdded} nodes, −${mergeResult.nodesDeleted} nodes, ~${mergeResult.nodesModified} nodes, +${mergeResult.edgesAdded} edges, −${mergeResult.edgesDeleted} edges, ~${mergeResult.edgesModified} edges. Skipped: ${mergeResult.skipped}.`
              : 'Merge was not applied.'
          }
          style={{ fontSize: 11 }}
        />
      )}
      {mergeResult?.warnings && mergeResult.warnings.length > 0 && (
        <Alert
          type="warning"
          message={mergeResult.warnings.join('; ')}
          showIcon
          style={{ fontSize: 11 }}
        />
      )}
    </div>
  );
}
