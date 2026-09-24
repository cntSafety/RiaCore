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
 * DiffPanel — top-level Diff and Merge view.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  DiffNamespaceSelector  [Mode: 2-way / 3-way] [Compute button]      │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │  DiffSummaryBar   (counts per section + filter controls)             │
 *   ├────────────────────────────────────────────────────────────────────-┤
 *   │  [List tab] [Graph tab]                                              │
 *   │  ┌──────────────────────────────────────────────────────────────┐   │
 *   │  │  DiffNodeList / DiffEdgeList  (virtualized, paginated)        │   │
 *   │  └──────────────────────────────────────────────────────────────┘   │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │  MergeReviewPanel / ConflictResolutionPanel                         │
 *   └─────────────────────────────────────────────────────────────────────┘
 */

import { theme, Alert } from 'antd';
import { DiffNamespaceSelector } from './DiffNamespaceSelector';
import { DiffSummaryBar } from './DiffSummaryBar';
import { DiffResultView } from './DiffResultView';
import { MergeReviewPanel } from './MergeReviewPanel';
import { ConflictResolutionPanel } from './ConflictResolutionPanel';
import { useDiffStore } from '../../store/diffStore';

const { useToken } = theme;

interface DiffPanelProps {
  onBack?: () => void;
}

export function DiffPanel({ onBack }: DiffPanelProps) {
  const { token } = useToken();
  const { mode, activeSummary, activeThreeWaySummary } = useDiffStore();

  const hasResult = mode === 'two-way' ? !!activeSummary : !!activeThreeWaySummary;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        background: token.colorBgLayout,
      }}
    >
      {/* Header: namespace selector */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          flexShrink: 0,
        }}
      >
        <DiffNamespaceSelector onBack={onBack} />
      </div>

      {/* Summary bar */}
      {hasResult && (
        <div
          style={{
            padding: '8px 16px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            flexShrink: 0,
          }}
        >
          <DiffSummaryBar />
        </div>
      )}

      {/* Main content. minHeight: 0 lets this shrink to the space the fixed
          header, summary bar, and merge panel leave over, so a long change list
          scrolls inside the list body rather than overflowing and being clipped. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {hasResult ? (
          <>
            <DiffResultView />

            {/* Merge / Conflict panel */}
            <div
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                flexShrink: 0,
                maxHeight: 220,
                overflow: 'auto',
              }}
            >
              {mode === 'two-way' && activeSummary && (
                <MergeReviewPanel summary={activeSummary} />
              )}
              {mode === 'three-way' && activeThreeWaySummary && (
                <ConflictResolutionPanel summary={activeThreeWaySummary} />
              )}
            </div>
          </>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              padding: 32,
            }}
          >
            <Alert
              type="info"
              showIcon
              message="Select namespaces and click Compute Diff to see results."
              style={{ maxWidth: 480 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
