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
 * FocusComponent — the center component card with a split IN PORTS / OUT PORTS layout.
 *
 * Renders a larger card with a 2px border (error color when the component has
 * malfunctions, info color otherwise). The body is divided into two halves by a
 * vertical divider: the left half lists IN PORT pins and the right half lists
 * OUT PORT pins.
 *
 * Requirements: 3.1, 3.4, 4.1, 7.1, 14.2
 */

import React from 'react';
import { theme, Tooltip } from 'antd';
import { AppstoreOutlined, WarningOutlined, DisconnectOutlined } from '@ant-design/icons';
import type { DiagramCenterComponent } from './diagramModel';
import { getAsilHexColor } from './diagramModel';
import { PortPin } from './PortPin';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';

export interface FocusComponentProps {
  /** Center component display data. */
  comp: DiagramCenterComponent;
  /** Ref dictionary for IN PORT pin DOM measurement by the SVG overlay. */
  focusLeftRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  /** Ref dictionary for OUT PORT pin DOM measurement by the SVG overlay. */
  focusRightRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
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

export function FocusComponent({ comp, focusLeftRefs, focusRightRefs, hovered, onHover, onNavigateToNode, onShowDetails, safetyNamespace, onNavigateToReference }: FocusComponentProps) {
  const { token } = theme.useToken();

  // ASIL-based border color, or info blue when no malfunctions
  const asilHex = getAsilHexColor(comp.maxAsil);
  const borderColor = asilHex ?? token.colorInfo;

  return (
    <div
      aria-label={`${comp.name} — center`}
      style={{
        minWidth: 300,
        borderRadius: 12,
        border: `2px solid ${borderColor}`,
        boxShadow: token.boxShadowSecondary ?? token.boxShadow,
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
          padding: '8px 12px',
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
              fontSize: 14,
              color: token.colorTextSecondary,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
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
        {comp.hasMalfunction && (
          <WarningOutlined
            style={{
              fontSize: 13,
              color: '#d4380d',
              flexShrink: 0,
            }}
          />
        )}
      </div>

      {/* Body: two halves with a vertical divider */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          padding: '6px 0',
        }}
      >
        {/* Left half — IN PORTS */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            paddingLeft: 4,
          }}
        >
          <span
            style={{
              fontSize: 9.5,
              textTransform: 'uppercase',
              color: token.colorTextTertiary,
              letterSpacing: '0.05em',
              padding: '0 6px 4px',
              lineHeight: 1,
            }}
          >
            In Ports
          </span>
          {comp.portsLeft.map((port) => (
            <PortPin
              key={port.id}
              id={port.id}
              name={port.name}
              dir={port.dir}
              warn={port.warn}
              asilColor={getAsilHexColor(port.maxAsil)}
              side="left"
              refCb={(el) => {
                focusLeftRefs.current[port.id] = el;
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

        {/* Vertical divider */}
        <div
          style={{
            width: 1,
            background: token.colorBorderSecondary,
            alignSelf: 'stretch',
            margin: '0 4px',
            flexShrink: 0,
          }}
        />

        {/* Right half — OUT PORTS */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            paddingRight: 4,
          }}
        >
          <span
            style={{
              fontSize: 9.5,
              textTransform: 'uppercase',
              color: token.colorTextTertiary,
              letterSpacing: '0.05em',
              padding: '0 6px 4px',
              lineHeight: 1,
              textAlign: 'right',
              width: '100%',
            }}
          >
            Out Ports
          </span>
          {comp.portsRight.map((port) => (
            <PortPin
              key={port.id}
              id={port.id}
              name={port.name}
              dir={port.dir}
              warn={port.warn}
              asilColor={getAsilHexColor(port.maxAsil)}
              side="right"
              refCb={(el) => {
                focusRightRefs.current[port.id] = el;
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

      {/* Unconnected ports section — ports with no connector */}
      {comp.portsUnconnected.length > 0 && (
        <div
          style={{
            borderTop: `1px dashed ${token.colorBorderSecondary}`,
            padding: '4px 0 6px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 8px 4px',
            }}
          >
            <DisconnectOutlined style={{ fontSize: 9.5, color: token.colorTextQuaternary }} />
            <span
              style={{
                fontSize: 9.5,
                textTransform: 'uppercase',
                color: token.colorTextQuaternary,
                letterSpacing: '0.05em',
                lineHeight: 1,
              }}
            >
              Unconnected
            </span>
          </div>
          {comp.portsUnconnected.map((port) => (
            <Tooltip
              key={port.id}
              title="This port has no connector in the current composition"
              placement="right"
              mouseEnterDelay={0.5}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  opacity: 0.55,
                }}
              >
                {/* Small dot indicator */}
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    border: `1.5px dashed ${token.colorTextQuaternary}`,
                    flexShrink: 0,
                  }}
                />
                <PortPin
                  id={port.id}
                  name={port.name}
                  dir={port.dir}
                  warn={port.warn}
                  asilColor={getAsilHexColor(port.maxAsil)}
                  side={port.dir === 'in' ? 'left' : 'right'}
                  refCb={() => { /* no SVG measurement needed for unconnected ports */ }}
                  hovered={hovered}
                  onHover={onHover}
                  portTarget={{ nodeId: port.nodeId, namespace: port.namespace, concept: port.portType }}
                  malfunctions={port.malfunctions}
                  malfunctionNamespace={safetyNamespace}
                  onNavigateToNode={onNavigateToNode}
                  onNavigateToReference={onNavigateToReference}
                />
              </div>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}
