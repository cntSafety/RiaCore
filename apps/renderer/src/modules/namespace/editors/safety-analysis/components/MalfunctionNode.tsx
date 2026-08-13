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
 * MalfunctionNode - Custom React Flow node representing a single malfunction.
 * Displays malfunction name, ASIL level with color coding, and occurs-at target info.
 * Wraps content with ShowInTreeTrigger for context menu navigation.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1–6.6, 8.1–8.7, 13.3, 14.1, 14.3,
 *               17.1, 19.1–19.6, 20.1–20.5, 21.1–21.4, 22.4
 */

import { memo, useEffect, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import { Button, theme } from 'antd';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';

// ---------------------------------------------------------------------------
// Data interface
// ---------------------------------------------------------------------------

export interface MalfunctionNodeData extends Record<string, unknown> {
  nodeId: number;
  name: string;
  description: string;
  namespace: string;
  concept: string;
  asil: string;
  asilColor: string;
  occursAtTarget?: { node_id: number; namespace: string; concept: string } | null;
  occursAtLabel?: string;
  isEntry: boolean;
  isTruncated: boolean;
  /** Highlighted when this node is the pending propagation source. */
  isPendingSource?: boolean;
  /**
   * When set, replaces the default ASIL-accent left border with a uniform
   * colored frame on all four sides. Used by ScopedPropagationDiagram to
   * communicate the structural role of the occurs-at target:
   *   - blue  → SWC in scope or receiver port (r_port)
   *   - green → provider port (p_port / pr_port)
   * Boundary (out-of-scope) nodes leave this undefined and rely on opacity.
   */
  scopeFrameColor?: string | null;
  /** When true, disables ShowInTreeTrigger's own context menu so the parent
   *  diagram can handle right-click via onNodeContextMenu instead. */
  disableContextMenu?: boolean;
  /** Highlighted because the node name matches the current search query. */
  isSearchMatch?: boolean;
  /** The focused (currently selected) match in the search result set. */
  isSearchFocus?: boolean;
  /** The node is selected in the canvas (click-to-select). */
  isSelected?: boolean;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (
    refNodeId: number,
    refNamespace: string,
    refConcept: string,
    hostNodeId: number,
    hostNamespace: string,
  ) => void;
}

export type MalfunctionNodeType = Node<MalfunctionNodeData, 'malfunctionNode'>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 300;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function MalfunctionNodeComponent(props: NodeProps<MalfunctionNodeType>) {
  const { data } = props;
  const { token } = theme.useToken();
  const [isExpanded, setIsExpanded] = useState(false);

  const ariaLabel = [
    data.name,
    `ASIL ${data.asil}`,
    data.occursAtLabel ? `at ${data.occursAtLabel}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  useEffect(() => {
    setIsExpanded(false);
  }, [data.nodeId, data.name, data.description]);

  // Auto-reveal the description when this node is the focused search match, so a
  // hit on description text is visible without the user clicking the chevron.
  useEffect(() => {
    if (data.isSearchFocus && data.description) setIsExpanded(true);
  }, [data.isSearchFocus, data.description]);

  // The malfunction name is always rendered in full (it wraps and the card grows
  // to fit), so the expand toggle only governs the optional description.
  const hasExpandableContent = Boolean(data.description);

  // ── Border computation ─────────────────────────────────────────────────────
  // Priority: 1) pending-source (dashed orange)  2) search focus (cyan pulse)
  //           3) search match (cyan)  4) selected (dashed white)
  //           5) scope frame  6) default
  const nodeBorders = (() => {
    if (data.isPendingSource) {
      const b = '2px dashed #fa8c16';
      return { borderTop: b, borderRight: b, borderBottom: b, borderLeft: b };
    }
    if (data.isSearchFocus) {
      const b = '3px solid #13c2c2';
      return { borderTop: b, borderRight: b, borderBottom: b, borderLeft: b };
    }
    if (data.isSearchMatch) {
      const b = '3px solid #36cfc9';
      return { borderTop: b, borderRight: b, borderBottom: b, borderLeft: b };
    }
    if (data.isSelected) {
      const b = '2px dashed rgba(255,255,255,0.85)';
      return { borderTop: b, borderRight: b, borderBottom: b, borderLeft: b };
    }
    if (data.scopeFrameColor) {
      const b = `2px solid ${data.scopeFrameColor}`;
      return { borderTop: b, borderRight: b, borderBottom: b, borderLeft: b };
    }
    const edgeBorder = `1px solid ${data.isEntry ? token.colorPrimary : token.colorBorder}`;
    return {
      borderTop: edgeBorder,
      borderRight: edgeBorder,
      borderBottom: edgeBorder,
      borderLeft: `4px solid ${data.asilColor}`,
    };
  })();

  const nodeContent = (
    <div
      aria-label={ariaLabel}
      style={{
        width: NODE_WIDTH,
        minHeight: isExpanded ? 142 : 92,
        padding: '10px 12px 10px 12px',
        paddingRight: hasExpandableContent ? 72 : 52,
        background: token.colorBgContainer,
        ...nodeBorders,
        borderRadius: token.borderRadiusSM,
        boxShadow: data.isSearchFocus
          ? '0 0 0 4px rgba(19, 194, 194, 0.55), 0 0 16px rgba(19, 194, 194, 0.4)'
          : data.isSearchMatch
          ? '0 0 0 3px rgba(54, 207, 201, 0.35), 0 0 10px rgba(54, 207, 201, 0.25)'
          : data.isSelected
          ? '0 0 0 3px rgba(255,255,255,0.2)'
          : data.isEntry
          ? '0 2px 8px rgba(0, 0, 0, 0.12)'
          : '0 1px 2px rgba(0, 0, 0, 0.04)',
        fontFamily: token.fontFamily,
        position: 'relative',
        cursor: 'grab',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {hasExpandableContent && (
          <Button
            type="text"
            size="small"
            icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
            aria-label={isExpanded ? 'Collapse malfunction card' : 'Expand malfunction card'}
            onClick={(event) => {
              event.stopPropagation();
              setIsExpanded((value) => !value);
            }}
            style={{
              width: 18,
              minWidth: 18,
              height: 18,
              padding: 0,
              color: token.colorTextSecondary,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          />
        )}

        <div
          style={{
            fontSize: 10,
            fontFamily: token.fontFamilyCode,
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 999,
            background: `${data.asilColor}20`,
            color: data.asilColor,
            letterSpacing: '0.03em',
            lineHeight: 1.4,
          }}
        >
          {data.asil}
        </div>
      </div>

      {/* Occurs-at target (secondary text). Wraps fully so long port/signal names
          (e.g. "R-Port: Pr_App_ContactorControl_kl30Status") stay visible
          instead of being clipped. */}
      {data.occursAtLabel && (
        <div
          title={data.occursAtLabel}
          style={{
            fontSize: 11,
            color: token.colorTextSecondary,
            marginBottom: 4,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            whiteSpace: 'normal',
            lineHeight: '1.35',
          }}
        >
          {data.occursAtLabel}
        </div>
      )}

      {/* Malfunction name (primary text) — always rendered in full; wraps and the
          card grows vertically to fit instead of clamping with an ellipsis. */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: token.colorText,
          lineHeight: '1.45',
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {data.name}
      </div>

      {/* Description is shown only in the expanded state to keep the default cards compact. */}
      {isExpanded && data.description && (
        <div style={{ marginTop: 5 }}>
          <div
            style={{
              fontSize: 11,
              color: token.colorTextSecondary,
              lineHeight: '1.4',
              whiteSpace: 'normal',
            }}
          >
            {data.description}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: token.colorBorder, width: 8, height: 8 }}
      />

      {data.disableContextMenu ? (
        <div style={{ width: '100%' }}>{nodeContent}</div>
      ) : (
        <ShowInTreeTrigger
          homeTarget={{ nodeId: data.nodeId, namespace: data.namespace, concept: data.concept }}
          referenceTarget={data.occursAtTarget ? { nodeId: data.nodeId, namespace: data.namespace, concept: data.concept } : undefined}
          onNavigate={data.onNavigateToNode}
          onNavigateReference={
            data.occursAtTarget && data.onNavigateToReference
              ? () => data.onNavigateToReference!(
                  data.nodeId, data.namespace, data.concept,
                  data.occursAtTarget!.node_id, data.occursAtTarget!.namespace,
                )
              : undefined
          }
          hideKebab
          wrapperStyle={{ width: '100%' }}
        >
          {nodeContent}
        </ShowInTreeTrigger>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: token.colorBorder, width: 8, height: 8 }}
      />
    </>
  );
}

export const MalfunctionNode = memo(MalfunctionNodeComponent);
