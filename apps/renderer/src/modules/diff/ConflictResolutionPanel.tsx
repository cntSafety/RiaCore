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
 * ConflictResolutionPanel — for three-way diff.
 *
 * Shows all conflicts and lets the user choose:
 *   - Accept Left
 *   - Accept Right
 *   - Skip
 *
 * When all conflicts are resolved, the "Apply Three-Way Merge" button activates.
 */

import { Alert, Button, Progress, Space, Table, Tag, Typography, theme } from 'antd';
import { MergeCellsOutlined } from '@ant-design/icons';
import type { ConflictRecord, ThreeWayDiffSummary, ConflictResolution, MergeResult } from '@riacore/app-contracts';
import { useDiffStore } from '../../store/diffStore';
import { useApplyThreeWayMerge, useThreeWayDiffResult } from '../../hooks/useDiffMutations';

const { useToken } = theme;
const { Text } = Typography;

interface Props {
  summary: ThreeWayDiffSummary;
}

const CONFLICT_LABELS: Record<string, string> = {
  'node-deleted-in-left-modified-in-right': 'Del (L) / Mod (R)',
  'node-deleted-in-right-modified-in-left': 'Del (R) / Mod (L)',
  'node-attribute-conflict':                'Attr conflict',
  'edge-deleted-in-left-modified-in-right': 'Edge Del (L) / Mod (R)',
  'edge-deleted-in-right-modified-in-left': 'Edge Del (R) / Mod (L)',
  'edge-attribute-conflict':                'Edge attr conflict',
};

function renderValue(val: unknown): string {
  if (val === undefined || val === null) return '—';
  return typeof val === 'string' ? val : JSON.stringify(val);
}

export function ConflictResolutionPanel({ summary }: Props) {
  const { token } = useToken();
  const {
    conflictResolutions,
    setConflictResolution,
    clearConflictResolutions,
  } = useDiffStore();

  const { data: threeWayResult } = useThreeWayDiffResult(summary.diffId);
  const applyThreeWay = useApplyThreeWayMerge();

  const conflicts: ConflictRecord[] = threeWayResult?.conflicts ?? [];
  const resolvedCount = conflictResolutions.filter(r => r.resolution !== undefined).length;
  const allResolved = conflicts.length > 0 && resolvedCount >= conflicts.length;
  const progressPct = conflicts.length > 0 ? Math.round((resolvedCount / conflicts.length) * 100) : 0;

  const getResolution = (stableId: string): ConflictResolution | undefined =>
    conflictResolutions.find(r => r.stableId === stableId);

  const handleApply = () => {
    applyThreeWay.mutate({
      diffId: summary.diffId,
      targetNs: summary.leftVariant,
      resolutions: conflictResolutions,
    });
  };

  const mergeResult: MergeResult | undefined = applyThreeWay.data;

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Text strong style={{ fontSize: 12 }}>
          <MergeCellsOutlined style={{ marginRight: 4 }} />
          Conflict Resolution
        </Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {resolvedCount} / {conflicts.length} resolved
        </Text>
        <Progress
          percent={progressPct}
          size="small"
          style={{ width: 120 }}
          showInfo={false}
          status={allResolved ? 'success' : 'active'}
        />
        {resolvedCount > 0 && (
          <Button size="small" onClick={() => clearConflictResolutions()}>
            Clear
          </Button>
        )}
        <Button
          type="primary"
          size="small"
          icon={<MergeCellsOutlined />}
          disabled={!allResolved}
          loading={applyThreeWay.isPending}
          onClick={handleApply}
        >
          Apply Three-Way Merge
        </Button>
      </div>

      {/* Conflict table */}
      {conflicts.length > 0 && (
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          <Table<ConflictRecord>
            size="small"
            dataSource={conflicts.map((c, i) => ({ ...c, key: `${c.stableId}-${i}` }))}
            pagination={false}
            rowKey={(r) => r.stableId + (r.attribute ?? '')}
            columns={[
              {
                title: 'Type',
                dataIndex: 'conflictType',
                width: 160,
                render: (v: string) => (
                  <Tag color="red" style={{ fontSize: 10 }}>
                    {CONFLICT_LABELS[v] ?? v}
                  </Tag>
                ),
              },
              {
                title: 'ID',
                dataIndex: 'stableId',
                ellipsis: true,
                render: (v: string) => (
                  <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>{v}</Text>
                ),
              },
              {
                title: 'Attr',
                dataIndex: 'attribute',
                width: 100,
                render: (v?: string) => v
                  ? <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>{v}</Text>
                  : <Text type="secondary" style={{ fontSize: 10 }}>—</Text>,
              },
              {
                title: 'Base',
                dataIndex: 'baseValue',
                width: 100,
                render: (v: unknown) => (
                  <Text style={{ fontSize: 10, fontFamily: 'monospace' }}>{renderValue(v)}</Text>
                ),
              },
              {
                title: 'Left',
                dataIndex: 'leftValue',
                width: 100,
                render: (v: unknown) => (
                  <Text style={{ fontSize: 10, fontFamily: 'monospace' }}>{renderValue(v)}</Text>
                ),
              },
              {
                title: 'Right',
                dataIndex: 'rightValue',
                width: 100,
                render: (v: unknown) => (
                  <Text style={{ fontSize: 10, fontFamily: 'monospace' }}>{renderValue(v)}</Text>
                ),
              },
              {
                title: 'Resolution',
                width: 220,
                render: (_: unknown, record: ConflictRecord) => {
                  const res = getResolution(record.stableId);
                  return (
                    <Space size={4}>
                      <Button
                        size="small"
                        type={res?.resolution === 'accept-left' ? 'primary' : 'default'}
                        style={{ fontSize: 10 }}
                        onClick={() =>
                          setConflictResolution({ stableId: record.stableId, resolution: 'accept-left' })
                        }
                      >
                        Accept Left
                      </Button>
                      <Button
                        size="small"
                        type={res?.resolution === 'accept-right' ? 'primary' : 'default'}
                        style={{ fontSize: 10 }}
                        onClick={() =>
                          setConflictResolution({ stableId: record.stableId, resolution: 'accept-right' })
                        }
                      >
                        Accept Right
                      </Button>
                      <Button
                        size="small"
                        danger={res?.resolution === 'manual'}
                        style={{ fontSize: 10 }}
                        onClick={() =>
                          setConflictResolution({ stableId: record.stableId, resolution: 'manual' })
                        }
                      >
                        Skip
                      </Button>
                    </Space>
                  );
                },
              },
            ]}
          />
        </div>
      )}

      {/* Result banners */}
      {applyThreeWay.isError && (
        <Alert
          type="error"
          message={applyThreeWay.error?.message ?? 'Three-way merge failed'}
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
              ? `Merge applied: +${mergeResult.nodesAdded} nodes, −${mergeResult.nodesDeleted}, ~${mergeResult.nodesModified}. Skipped: ${mergeResult.skipped}.`
              : 'Merge was not applied.'
          }
          style={{ fontSize: 11 }}
        />
      )}
    </div>
  );
}
