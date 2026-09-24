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
 * DiffResultView — renders the change list for the selected diff section.
 *
 * Previously a List/Graph tab pair. The Graph tab was removed because it showed
 * nothing useful; with a single view left, a one-tab tab bar was pure chrome.
 * `DiffGraphView` is still in the module and still unit-tested — re-adding a
 * tab bar here is the only wiring needed to bring it back.
 *
 * Layout contract: this is a flex item of a height-bounded column parent, and a
 * column flex container for the list below it. `minHeight: 0` is required at
 * both ends — see `__tests__/diff-layout.conformance.test.ts` for why a missing
 * one silently stops the change list from scrolling.
 */

import { useDiffStore } from '../../store/diffStore';
import { DiffNodeList } from './DiffNodeList';
import { DiffEdgeList } from './DiffEdgeList';
import type { DiffResultSection } from '@riacore/app-contracts';

const NODE_SECTIONS = new Set<DiffResultSection>(['addedNodes', 'deletedNodes', 'modifiedNodes']);
const EDGE_SECTIONS = new Set<DiffResultSection>([
  'addedEdges', 'deletedEdges', 'modifiedEdges',
  'addedCrossNsEdges', 'deletedCrossNsEdges', 'modifiedCrossNsEdges',
]);

export function DiffResultView() {
  const { activeSummary, activeThreeWaySummary, mode, selectedSection } = useDiffStore();

  const summary = mode === 'two-way' ? activeSummary : activeThreeWaySummary;
  if (!summary) return null;

  const diffId = summary.diffId;

  const listContent = NODE_SECTIONS.has(selectedSection)
    ? <DiffNodeList diffId={diffId} section={selectedSection} />
    : EDGE_SECTIONS.has(selectedSection)
      ? <DiffEdgeList diffId={diffId} section={selectedSection} />
      : null;

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {listContent}
    </div>
  );
}
