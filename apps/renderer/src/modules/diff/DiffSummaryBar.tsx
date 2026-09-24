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

import { Alert, Badge, Tag, theme, Typography } from 'antd';
import type { DiffSummary, DiffResultSection, ThreeWayDiffSummary } from '@riacore/app-contracts';
import { useDiffStore } from '../../store/diffStore';
import { labelSectionChip } from './diffSectionLabels';

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

  // Labels come from the shared section vocabulary so a chip and the list
  // heading it selects always read the same.
  const entry = (key: DiffResultSection, count: number, color: string): SectionEntry =>
    ({ key, label: labelSectionChip(key), count, color });

  return [
    entry('addedNodes',           addedNodes,                              '#52c41a'),
    entry('modifiedNodes',        modifiedNodes,                           '#fa8c16'),
    entry('deletedNodes',         deletedNodes,                            '#ff4d4f'),
    entry('addedEdges',           tw.addedEdgesCount          ?? 0,        '#1677ff'),
    entry('modifiedEdges',        tw.modifiedEdgesCount       ?? 0,        '#13c2c2'),
    entry('deletedEdges',         tw.deletedEdgesCount        ?? 0,        '#722ed1'),
    entry('addedCrossNsEdges',    tw.addedCrossNsEdgesCount   ?? 0,        '#52c41a'),
    entry('modifiedCrossNsEdges', tw.modifiedCrossNsEdgesCount ?? 0,       '#fa8c16'),
    entry('deletedCrossNsEdges',  tw.deletedCrossNsEdgesCount ?? 0,        '#ff4d4f'),
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
