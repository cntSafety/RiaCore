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
 * DiffResultView — tabs between List and Graph views,
 * and routes the list content based on the selected section.
 */

import { Tabs, theme } from 'antd';
import { useDiffStore } from '../../store/diffStore';
import { DiffNodeList } from './DiffNodeList';
import { DiffEdgeList } from './DiffEdgeList';
import { DiffGraphView } from './DiffGraphView';
import type { DiffResultSection } from '@riacore/app-contracts';

const { useToken } = theme;

const NODE_SECTIONS = new Set<DiffResultSection>(['addedNodes', 'deletedNodes', 'modifiedNodes']);
const EDGE_SECTIONS = new Set<DiffResultSection>([
  'addedEdges', 'deletedEdges', 'modifiedEdges',
  'addedCrossNsEdges', 'deletedCrossNsEdges', 'modifiedCrossNsEdges',
]);

export function DiffResultView() {
  const { token } = useToken();
  const { activeSummary, activeThreeWaySummary, mode, selectedSection, resultTab, setResultTab } = useDiffStore();

  const summary = mode === 'two-way' ? activeSummary : activeThreeWaySummary;
  if (!summary) return null;

  const diffId = summary.diffId;

  const listContent = NODE_SECTIONS.has(selectedSection)
    ? <DiffNodeList diffId={diffId} section={selectedSection} />
    : EDGE_SECTIONS.has(selectedSection)
      ? <DiffEdgeList diffId={diffId} section={selectedSection} />
      : null;

  return (
    <Tabs
      activeKey={resultTab}
      onChange={key => setResultTab(key as 'list' | 'graph')}
      size="small"
      className="diff-result-tabs"
      style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      tabBarStyle={{ marginBottom: 0, paddingLeft: 12, flexShrink: 0, background: token.colorBgContainer }}
      items={[
        {
          key: 'list',
          label: 'List',
          children: (
            <div style={{ height: '100%', overflow: 'hidden' }}>
              {listContent}
            </div>
          ),
        },
        {
          key: 'graph',
          label: 'Graph',
          // Only mount when the tab is active so that DiffGraphView's useEffect
          // always fires with the container already visible and measurable.
          // TanStack Query caches the diff result (staleTime: Infinity), so
          // re-mounting on tab switch never causes a redundant IPC round-trip.
          children: (
            <div style={{ height: '100%', overflow: 'hidden' }}>
              {resultTab === 'graph' && <DiffGraphView diffId={diffId} />}
            </div>
          ),
        },
      ]}
    />
  );
}
