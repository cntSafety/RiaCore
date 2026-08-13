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
 * PartnerCard — sender or receiver component card with port pins on the edge
 * facing the focus component.
 *
 * Left partners (side='left') show their ports on the RIGHT edge so they face
 * the center. Right partners (side='right') show their ports on the LEFT edge.
 *
 * Requirements: 3.1, 3.4, 4.1, 14.2
 */

import React from 'react';
import { theme } from 'antd';
import { AppstoreOutlined, WarningOutlined } from '@ant-design/icons';
import type { DiagramComponent } from './diagramModel';
import { getAsilHexColor } from './diagramModel';
import { PortPin } from './PortPin';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';

export interface PartnerCardProps {
  /** Component display data. */
  comp: DiagramComponent;
  /** 'left' for senders, 'right' for receivers. */
  side: 'left' | 'right';
  /** Ref dictionary for port pin DOM measurement by the SVG overlay. */
  portRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  /** Currently hovered port ID. */
  hovered: string | null;
  /** Hover callback. */
  onHover: (id: string | null) => void;
  /** Navigation callback for "Show in Tree". */
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /** Callback for "Show details" — shows the element's detail page. */
  onShowDetails?: () => void;
  /** The authored safety namespace (where malfunctions live). */
  safetyNamespace?: string;
  /** Navigation callback for "Show Reference in Tree". */
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
}

export function PartnerCard({ comp, side, portRefs, hovered, onHover, onNavigateToNode, onShowDetails, safetyNamespace, onNavigateToReference }: PartnerCardProps) {
  const { token } = theme.useToken();

  // ASIL-based border color, or neutral when no malfunctions
  const asilHex = getAsilHexColor(comp.maxAsil);
  const borderColor = asilHex ?? token.colorBorder;

  // Port pins for left partners appear on the RIGHT edge; for right partners on the LEFT edge
  const pinSide = side === 'left' ? 'right' : 'left';

  // Ports list alignment: left partners right-align so pins appear on right edge,
  // right partners left-align so pins appear on left edge
  const portsJustify = side === 'left' ? 'flex-end' : 'flex-start';

  // Role label for aria-label
  const role = side === 'left' ? 'sender' : 'receiver';

  return (
    <div
      aria-label={`${comp.name} — ${role}`}
      style={{
        minWidth: 260,
        borderRadius: 8,
        border: `1px solid ${borderColor}`,
        boxShadow: token.boxShadow,
        background: token.colorBgContainer,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillAlter,
        }}
      >
        <ShowInTreeTrigger
          homeTarget={{ nodeId: comp.nodeId, namespace: comp.namespace, concept: comp.concept }}
          onNavigate={onNavigateToNode}
          onShowDetails={onShowDetails}
          wrapperStyle={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}
          hideKebab
        >
          <AppstoreOutlined
            style={{
              fontSize: 13,
              color: token.colorTextSecondary,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: token.colorText,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {comp.name}
          </span>
        </ShowInTreeTrigger>
        {comp.warn && (
          <WarningOutlined
            style={{
              fontSize: 12,
              color: '#d4380d',
              flexShrink: 0,
            }}
          />
        )}
      </div>

      {/* Port pins */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: portsJustify,
          padding: '4px 0',
        }}
      >
        {comp.ports.map((port) => (
          <PortPin
            key={port.id}
            id={port.id}
            name={port.name}
            dir={side === 'left' ? 'out' : 'in'}
            warn={port.warn}
            asilColor={getAsilHexColor(port.maxAsil)}
            side={pinSide}
            refCb={(el) => {
              portRefs.current[port.id] = el;
            }}
            hovered={hovered}
            onHover={onHover}
            portTarget={{ nodeId: port.nodeId, namespace: port.namespace, concept: port.portType }}
            malfunctions={port.malfunctions}
            malfunctionNamespace={safetyNamespace}
            onNavigateToNode={onNavigateToNode}
            onNavigateToReference={onNavigateToReference}
          />
        ))}
      </div>
    </div>
  );
}
