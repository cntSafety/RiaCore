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
 * DiffSummaryBar — shows change counts per section and lets the user
 * switch the active section (addedNodes, deletedNodes, etc.).
 * Displays a warning banner when the dataset is very large.
 */

import { Alert, Badge, Space, Tag, theme, Typography } from 'antd';
import type { DiffSummary, DiffResultSection, ThreeWayDiffSummary } from '@riacore/app-contracts';
import { useDiffStore } from '../../store/diffStore';

const { useToken } = theme;
const { Text } = Typography;

interface Props {
  /** Pass either a two-way or three-way summary. */
  summary?: DiffSummary | ThreeWayDiffSummary;
}

type SectionEntry = {
  key: DiffResultSection;
  label: string;
  count: number;
  color: string;
};

function getSections(summary: DiffSummary | ThreeWayDiffSummary): SectionEntry[] {
  const tw = summary as DiffSummary;
  const th = summary as ThreeWayDiffSummary;
  // For two-way diff, use DiffSummary's count fields; for three-way, sum left+right counts
  const addedNodes    = tw.addedNodesCount    ?? (th.leftAddedNodesCount    ?? 0) + (th.rightAddedNodesCount    ?? 0);
  const deletedNodes  = tw.deletedNodesCount  ?? (th.leftDeletedNodesCount  ?? 0) + (th.rightDeletedNodesCount  ?? 0);
  const modifiedNodes = tw.modifiedNodesCount ?? (th.leftModifiedNodesCount ?? 0) + (th.rightModifiedNodesCount ?? 0);

  return [
    { key: 'addedNodes',          label: '+ Nodes',   count: addedNodes,                       color: '#52c41a' },
    { key: 'deletedNodes',        label: '− Nodes',   count: deletedNodes,                     color: '#ff4d4f' },
    { key: 'modifiedNodes',       label: '~ Nodes',   count: modifiedNodes,                    color: '#fa8c16' },
    { key: 'addedEdges',          label: '+ Edges',   count: tw.addedEdgesCount       ?? 0,    color: '#1677ff' },
    { key: 'deletedEdges',        label: '− Edges',   count: tw.deletedEdgesCount     ?? 0,    color: '#722ed1' },
    { key: 'modifiedEdges',       label: '~ Edges',   count: tw.modifiedEdgesCount    ?? 0,    color: '#13c2c2' },
    { key: 'addedCrossNsEdges',   label: '+ CrossNS', count: tw.addedCrossNsEdgesCount   ?? 0, color: '#52c41a' },
    { key: 'deletedCrossNsEdges', label: '− CrossNS', count: tw.deletedCrossNsEdgesCount ?? 0, color: '#ff4d4f' },
    { key: 'modifiedCrossNsEdges',label: '~ CrossNS', count: tw.modifiedCrossNsEdgesCount ?? 0,color: '#fa8c16' },
  ];
}

export function DiffSummaryBar({ summary: summaryProp }: Props) {
  const { token } = useToken();
  const {
    mode,
    activeSummary,
    activeThreeWaySummary,
    selectedSection,
    setSelectedSection,
  } = useDiffStore();

  const summary = summaryProp ?? (mode === 'two-way' ? activeSummary : activeThreeWaySummary);
  if (!summary) return null;

  const sections = getSections(summary);
  const tw = summary as DiffSummary;
  const threeWay = summary as ThreeWayDiffSummary;
  const conflictCount = threeWay.conflictCount ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {tw.largeDatasetWarning && (
        <Alert
          type="warning"
          showIcon
          banner
          message="Large dataset — only the first 50,000 changed elements are shown."
          style={{ fontSize: 12, padding: '2px 8px' }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {sections.filter(s => s.count > 0).map(s => (
          <Tag
            key={s.key}
            style={{
              cursor: 'pointer',
              fontSize: 11,
              borderColor: s.key === selectedSection ? s.color : token.colorBorderSecondary,
              background: s.key === selectedSection ? `${s.color}1a` : 'transparent',
              color: s.key === selectedSection ? s.color : token.colorText,
              transition: 'all 0.15s',
            }}
            onClick={() => setSelectedSection(s.key)}
          >
            {s.label} <Badge
              count={s.count}
              showZero={false}
              style={{
                backgroundColor: s.color,
                fontSize: 10,
                height: 16,
                lineHeight: '16px',
                minWidth: 16,
                padding: '0 4px',
                boxShadow: 'none',
              }}
            />
          </Tag>
        ))}

        {conflictCount > 0 && (
          <Tag color="error" style={{ fontSize: 11 }}>
            ⚡ {conflictCount} conflicts
          </Tag>
        )}

        {sections.every(s => s.count === 0) && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            No differences found.
          </Text>
        )}
      </div>
    </div>
  );
}
