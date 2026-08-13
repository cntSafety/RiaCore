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
 * PortPin — individual port indicator used in both PartnerCard and FocusComponent.
 *
 * Renders a colored square (blue for in-ports, orange for out-ports), the port
 * name in monospace, and an optional warning icon. Layout order depends on
 * which side of the card the pin sits on:
 *   - side='left':  [square] [name] [warn]
 *   - side='right': [warn] [name] [square]
 *
 * Right-clicking the port name/square shows "Show in Tree" for the port.
 * Right-clicking the malfunction warning icon shows navigation to the
 * malfunction(s) attached to this port.
 *
 * Requirements: 7.1, 7.4, 8.1, 8.2, 8.3
 */

import { useRef } from 'react';
import type { MouseEvent } from 'react';
import { theme, Tooltip } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import { api } from '../../../../../api/riacore';
import type { DiagramMalfunctionRef } from './diagramModel';

export interface PortPinProps {
  /** Unique port identifier for ref tracking and hover. */
  id: string;
  /** Port display name. */
  name: string;
  /** 'in' for requester/inner ports, 'out' for provider/outer ports. */
  dir: 'in' | 'out';
  /** Whether this port has malfunctions attached. */
  warn: boolean;
  /** ASIL hex color for the port square, or null for no malfunctions. */
  asilColor: string | null;
  /** Which side of the card this pin sits on (determines layout order). */
  side: 'left' | 'right';
  /** Ref callback for DOM measurement by the SVG overlay. */
  refCb: (el: HTMLDivElement | null) => void;
  /** Currently hovered port ID (for highlight). */
  hovered: string | null;
  /** Hover state callback. */
  onHover: (id: string | null) => void;
  /** Port navigation target — nodeId, namespace, concept (portType). */
  portTarget?: { nodeId: number; namespace: string; concept: string };
  /** Malfunctions attached to this port (for warning icon navigation). */
  malfunctions?: DiagramMalfunctionRef[];
  /** The authored safety namespace where malfunctions live. */
  malfunctionNamespace?: string;
  /** Navigation callback for "Show in Tree". */
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /** Navigation callback for "Show Reference in Tree" — navigates to the reference child under the host. */
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
}

export function PortPin({ id, name, dir, warn, asilColor, side, refCb, hovered, onHover, portTarget, malfunctions, malfunctionNamespace, onNavigateToNode, onNavigateToReference }: PortPinProps) {
  const { token } = theme.useToken();
  const navigatingRef = useRef(false);

  const isHovered = hovered === id;

  // Truncate long names at 24 chars
  const MAX_NAME_LEN = 24;
  const truncated = name.length > MAX_NAME_LEN;
  const displayName = truncated ? name.slice(0, MAX_NAME_LEN) + '…' : name;

  // ASIL color for the square, or neutral grey when no malfunctions
  const squareColor = asilColor ?? token.colorTextQuaternary;

  // Hover background: semi-transparent info color
  const hoverBg = `rgba(${hexToRgb(token.colorInfo)}, 0.12)`;

  const square = (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: 2,
        background: squareColor,
        flexShrink: 0,
      }}
    />
  );

  const labelEl = (
    <span
      style={{
        fontSize: 10.5,
        color: token.colorTextSecondary,
        fontFamily: token.fontFamilyCode,
        lineHeight: 1,
      }}
    >
      {displayName}
    </span>
  );

  const label = truncated ? (
    <Tooltip title={name} mouseEnterDelay={0.4}>
      {labelEl}
    </Tooltip>
  ) : labelEl;

  // Port content (square + label) wrapped with ShowInTreeTrigger for port navigation
  const portContent = (
    <>
      {square}
      {label}
    </>
  );

  const portWithNav = portTarget && onNavigateToNode ? (
    <ShowInTreeTrigger
      homeTarget={portTarget}
      onNavigate={onNavigateToNode}
      wrapperStyle={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      hideKebab
    >
      {portContent}
    </ShowInTreeTrigger>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {portContent}
    </span>
  );

  // Malfunction warning icon with context menu for "Show Reference in Tree" navigation.
  // Malfunctions appear as reference children under the port in the imported namespace tree,
  // so we use onNavigateToReference with the port as the host node.
  const handleMalfunctionContextMenu = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (navigatingRef.current || !malfunctions || malfunctions.length === 0 || !malfunctionNamespace || !portTarget) return;
    // Need either onNavigateToReference (preferred) or onNavigateToNode as fallback
    if (!onNavigateToReference && !onNavigateToNode) return;

    navigatingRef.current = true;
    try {
      if (malfunctions.length === 1) {
        // Single malfunction — show context menu with one item
        const items = [{ id: String(malfunctions[0].nodeId), label: 'Show Reference in Tree' }];
        const selectedId = await api.contextMenu.show(items);
        if (selectedId) {
          if (onNavigateToReference) {
            onNavigateToReference(malfunctions[0].nodeId, malfunctionNamespace, 'malfunction', portTarget.nodeId, portTarget.namespace);
          } else {
            onNavigateToNode?.(malfunctions[0].nodeId, malfunctionNamespace, 'malfunction');
          }
        }
      } else {
        // Multiple malfunctions — show picker menu listing each
        const items = malfunctions.map(m => ({
          id: String(m.nodeId),
          label: `Show "${m.name}" Reference in Tree`,
        }));
        const selectedId = await api.contextMenu.show(items);
        if (selectedId) {
          const nodeId = parseInt(selectedId, 10);
          if (onNavigateToReference) {
            onNavigateToReference(nodeId, malfunctionNamespace, 'malfunction', portTarget.nodeId, portTarget.namespace);
          } else {
            onNavigateToNode?.(nodeId, malfunctionNamespace, 'malfunction');
          }
        }
      }
    } finally {
      navigatingRef.current = false;
    }
  };

  // Build tooltip content for malfunction warning icon
  const malfunctionTooltip = malfunctions && malfunctions.length > 0
    ? malfunctions.map(m => {
        const desc = m.description ? `: ${m.description}` : '';
        return `${m.name}${desc}`;
      }).join('\n')
    : undefined;

  const warningIcon = warn ? (
    <Tooltip
      title={malfunctionTooltip}
      mouseEnterDelay={0.3}
      overlayStyle={{ maxWidth: 360 }}
      overlayInnerStyle={{ whiteSpace: 'pre-wrap', fontSize: 12, color: token.colorText }}
      color={token.colorBgElevated}
    >
      <span
        onContextMenu={malfunctions && malfunctions.length > 0 ? handleMalfunctionContextMenu : undefined}
        style={{ display: 'inline-flex', cursor: malfunctions && malfunctions.length > 0 ? 'context-menu' : 'default', flexShrink: 0 }}
      >
        <WarningOutlined
          style={{
            fontSize: 11,
            color: '#d4380d',
            flexShrink: 0,
          }}
        />
      </span>
    </Tooltip>
  ) : null;

  return (
    <div
      ref={refCb}
      data-port-id={id}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 6px',
        borderRadius: 4,
        cursor: 'default',
        background: isHovered ? hoverBg : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      {side === 'left' && portWithNav}
      {side === 'left' && warningIcon}

      {side === 'right' && warningIcon}
      {side === 'right' && portWithNav}
    </div>
  );
}

/**
 * Converts a hex color string (e.g. "#0891b2") to an "r, g, b" string
 * suitable for use in rgba(). Falls back to "0, 0, 0" for unrecognized input.
 */
function hexToRgb(hex: string): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return '0, 0, 0';
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}
