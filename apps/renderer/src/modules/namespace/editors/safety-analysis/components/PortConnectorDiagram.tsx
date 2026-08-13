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
 * PortConnectorDiagram — three-column data-flow diagram for port and SWC concepts.
 *
 * Renders sender components on the left, the selected component in the center
 * (with split IN/OUT ports), and receiver components on the right. SVG Bezier
 * paths connect individual port pins on partner cards to individual port pins
 * on the focus component.
 *
 * Visual design follows Concept F — Relations View.
 *
 * Requirements: 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 5.3, 5.4, 5.5,
 *               6.1, 6.2, 6.3, 7.1, 8.1, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5,
 *               10.6, 12.1, 12.2, 12.3, 13.1, 13.2, 13.3, 14.1, 14.3
 */

import React, { useRef, useState, useLayoutEffect } from 'react';
import { theme, Spin, Alert, Empty } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { usePortConnectors, useComponentPortConnectors } from '../../../../../hooks/usePortConnectors';
import {
  PORT_CONCEPTS,
  SWC_CONCEPTS,
  buildDiagramModel,
  buildConnectorPath,
  type DiagramLink,
} from './diagramModel';
import { PartnerCard } from './PartnerCard';
import { FocusComponent } from './FocusComponent';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import type { SelectedTreeElement } from '../types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PortConnectorDiagramProps {
  selectedTreeElement: SelectedTreeElement;
  workspaceKey: string | null;
  /** The authored safety namespace (where malfunctions live). */
  safetyNamespace?: string;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /** Navigation callback for "Show Reference in Tree". */
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
  /** Called when the user selects "Show details" on a component card. */
  onShowDetails?: () => void;
}

// ---------------------------------------------------------------------------
// PathData — internal type for SVG path rendering
// ---------------------------------------------------------------------------

interface PathData {
  d: string;
  warn: boolean;
  dashed: boolean;
  hovered: boolean;
}

// ---------------------------------------------------------------------------
// RelationConnectors — SVG overlay (not exported)
// ---------------------------------------------------------------------------

interface RelationConnectorsProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  leftPortRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  rightPortRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  focusLeftRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  focusRightRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  leftLinks: DiagramLink[];
  rightLinks: DiagramLink[];
  hovered: string | null;
}

function RelationConnectors({
  containerRef,
  leftPortRefs,
  rightPortRefs,
  focusLeftRefs,
  focusRightRefs,
  leftLinks,
  rightLinks,
  hovered,
}: RelationConnectorsProps) {
  const { token } = theme.useToken();
  const [paths, setPaths] = useState<PathData[]>([]);

  useLayoutEffect(() => {
    const recalc = () => {
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const newPaths: PathData[] = [];

      // Left links: partner port → focus IN port
      for (const link of leftLinks) {
        const partnerEl = leftPortRefs.current[link.partnerPort];
        const focusEl = focusLeftRefs.current[link.focusPort];
        if (!partnerEl || !focusEl) continue;
        const pr = partnerEl.getBoundingClientRect();
        const fr = focusEl.getBoundingClientRect();
        const x1 = pr.right - cr.left;
        const y1 = pr.top + pr.height / 2 - cr.top;
        const x2 = fr.left - cr.left;
        const y2 = fr.top + fr.height / 2 - cr.top;
        newPaths.push({
          d: buildConnectorPath(x1, y1, x2, y2),
          warn: link.warn,
          dashed: link.connectorType === 'delegation_connector',
          hovered: hovered === link.partnerPort || hovered === link.focusPort,
        });
      }

      // Right links: focus OUT port → partner port
      for (const link of rightLinks) {
        const focusEl = focusRightRefs.current[link.focusPort];
        const partnerEl = rightPortRefs.current[link.partnerPort];
        if (!focusEl || !partnerEl) continue;
        const fr = focusEl.getBoundingClientRect();
        const pr = partnerEl.getBoundingClientRect();
        const x1 = fr.right - cr.left;
        const y1 = fr.top + fr.height / 2 - cr.top;
        const x2 = pr.left - cr.left;
        const y2 = pr.top + pr.height / 2 - cr.top;
        newPaths.push({
          d: buildConnectorPath(x1, y1, x2, y2),
          warn: link.warn,
          dashed: link.connectorType === 'delegation_connector',
          hovered: hovered === link.focusPort || hovered === link.partnerPort,
        });
      }

      setPaths(newPaths);
    };

    // Double rAF for initial layout settling
    let raf1: number, raf2: number;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(recalc);
    });

    // ResizeObserver on the container AND all its children (grid items).
    // This ensures we recalc when cards reflow, not just when the outer
    // container changes dimensions.
    const observer = new ResizeObserver(recalc);
    if (containerRef.current) {
      observer.observe(containerRef.current);
      // Observe all direct children of the grid (the three columns)
      const grid = containerRef.current.querySelector('[style*="display: grid"], [style*="display:grid"]') ??
        containerRef.current.lastElementChild;
      if (grid) {
        for (const child of Array.from(grid.children)) {
          observer.observe(child);
        }
      }
    }

    // Window resize listener as a fallback for snap/maximize/restore events.
    // The ResizeObserver on the container may not fire quickly enough when the
    // window size changes abruptly (double-click title bar, Win+Arrow, etc.)
    // because the container's own dimensions update before child layout settles.
    let resizeRaf: number | undefined;
    const onWindowResize = () => {
      // Cancel any pending recalc to avoid stacking frames
      if (resizeRaf !== undefined) cancelAnimationFrame(resizeRaf);
      // Immediate recalc for responsiveness
      recalc();
      // Follow-up recalc after layout settles (double rAF)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = requestAnimationFrame(recalc);
      });
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (resizeRaf !== undefined) cancelAnimationFrame(resizeRaf);
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [leftLinks, rightLinks, hovered, containerRef, leftPortRefs, rightPortRefs, focusLeftRefs, focusRightRefs]);

  return (
    <svg
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 1,
        overflow: 'visible',
      }}
    >
      <defs />
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.hovered ? token.colorInfo : token.colorTextTertiary}
          strokeWidth={p.hovered ? 2 : 1.5}
          strokeDasharray={p.dashed ? '6 4' : undefined}
          fill="none"
          strokeOpacity={p.hovered ? 1 : 0.65}
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DiagramLegend — legend bar above the grid (not exported)
// ---------------------------------------------------------------------------

function DiagramLegend() {
  const { token } = theme.useToken();

  const asilLevels = [
    { label: 'QM', color: '#8c8c8c' },
    { label: 'A', color: '#52c41a' },
    { label: 'B', color: '#a0d911' },
    { label: 'C', color: '#ffa940' },
    { label: 'D', color: '#d4380d' },
  ];

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        padding: '8px 24px',
        alignItems: 'center',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexWrap: 'wrap',
      }}
    >
      {/* ASIL levels */}
      {asilLevels.map(({ label, color }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 2,
              background: color,
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontFamily: token.fontFamilyCode,
              textTransform: 'uppercase',
              color: token.colorTextSecondary,
            }}
          >
            {label}
          </span>
        </div>
      ))}

      {/* Has malfunction indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <WarningOutlined style={{ fontSize: 11, color: '#d4380d' }} />
        <span
          style={{
            fontSize: 11,
            fontFamily: token.fontFamilyCode,
            textTransform: 'uppercase',
            color: token.colorTextSecondary,
          }}
        >
          has malfunction
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PortConnectorDiagram — main component
// ---------------------------------------------------------------------------

export function PortConnectorDiagram({ selectedTreeElement, workspaceKey, safetyNamespace, onNavigateToNode, onNavigateToReference, onShowDetails }: PortConnectorDiagramProps) {
  const { token } = theme.useToken();
  const { nodeId, concept } = selectedTreeElement;

  // Determine which hook to call based on concept type
  const isPortConcept = PORT_CONCEPTS.has(concept);
  const isSwcConcept = SWC_CONCEPTS.has(concept);

  // Always call both hooks; only one will be enabled at a time
  const portResult = usePortConnectors(isPortConcept ? nodeId : null, workspaceKey);
  const swcResult = useComponentPortConnectors(isSwcConcept ? nodeId : null, workspaceKey);

  // Hover state shared across all port pins and SVG paths
  const [hoveredPortId, setHoveredPortId] = useState<string | null>(null);

  // Per-port DOM refs for SVG measurement
  const leftPortRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const rightPortRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const focusLeftRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const focusRightRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve active query result
  const isLoading = isPortConcept ? portResult.isLoading : swcResult.isLoading;
  const isError = isPortConcept ? portResult.isError : swcResult.isError;
  const error = isPortConcept ? portResult.error : swcResult.error;

  // Loading state
  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          minHeight: 200,
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  // Error state
  if (isError && error) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" message={error.message} />
      </div>
    );
  }

  // Derive center component info and connectors from the active result
  let centerNodeId: number;
  let centerName: string;
  let centerConcept: string;
  let centerNamespace: string;
  let connectors: Parameters<typeof buildDiagramModel>[0];
  let componentMalfunctions: Record<number, import('@riacore/app-contracts').MalfunctionInfo[]> = {};
  let unconnectedPorts: import('@riacore/app-contracts').PortInfo[] = [];

  if (isPortConcept && portResult.data) {
    const { port, connectors: portConnectors, componentMalfunctions: portCompFms } = portResult.data;
    centerNodeId = port.ownerNodeId;
    centerName = port.ownerName;
    centerConcept = port.ownerConcept;
    centerNamespace = port.ownerNamespace ?? selectedTreeElement.namespace;
    connectors = portConnectors;
    componentMalfunctions = portCompFms;
    // Single-port query doesn't return unconnectedPorts — leave empty
  } else if (isSwcConcept && swcResult.data) {
    const { component, connectors: swcConnectors, componentMalfunctions: swcCompFms, unconnectedPorts: swcUnconnected } = swcResult.data;
    centerNodeId = component.nodeId;
    centerName = component.name;
    centerConcept = component.concept;
    centerNamespace = selectedTreeElement.namespace;
    connectors = swcConnectors;
    componentMalfunctions = swcCompFms;
    unconnectedPorts = swcUnconnected ?? [];
  } else {
    return null;
  }

  const model = buildDiagramModel(connectors, centerNodeId, centerName, centerConcept, componentMalfunctions, centerNamespace, unconnectedPorts);

  // Empty state — no connectors, but still render the focus component
  const hasConnectors = model.senders.length > 0 || model.receivers.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 900, minHeight: 0, overflow: 'auto' }}>
      {/* Legend bar */}
      <DiagramLegend />

      {/* Main grid with SVG overlay */}
      <div ref={containerRef} style={{ position: 'relative', flex: 1 }}>
        <RelationConnectors
          containerRef={containerRef}
          leftPortRefs={leftPortRefs}
          rightPortRefs={rightPortRefs}
          focusLeftRefs={focusLeftRefs}
          focusRightRefs={focusRightRefs}
          leftLinks={model.leftLinks}
          rightLinks={model.rightLinks}
          hovered={hoveredPortId}
        />

        {/* CSS Grid layout */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: 120,
            padding: '24px 24px 32px',
            alignItems: 'center',
          }}
        >
          {/* Left column — senders */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 24,
            }}
          >
            {model.senders.map((comp) => (
              <PartnerCard
                key={comp.nodeId}
                comp={comp}
                side="left"
                portRefs={leftPortRefs}
                hovered={hoveredPortId}
                onHover={setHoveredPortId}
                onNavigateToNode={onNavigateToNode}
                onShowDetails={onShowDetails}
                safetyNamespace={safetyNamespace}
                onNavigateToReference={onNavigateToReference}
              />
            ))}
          </div>

          {/* Center column — focus component */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <FocusComponent
              comp={model.center}
              focusLeftRefs={focusLeftRefs}
              focusRightRefs={focusRightRefs}
              hovered={hoveredPortId}
              onHover={setHoveredPortId}
              onNavigateToNode={onNavigateToNode}
              onShowDetails={onShowDetails}
              safetyNamespace={safetyNamespace}
              onNavigateToReference={onNavigateToReference}
            />
            {!hasConnectors && (
              <Empty
                description="No connections found for this component"
                style={{ color: token.colorTextSecondary }}
              />
            )}
          </div>

          {/* Right column — receivers */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 24,
            }}
          >
            {model.receivers.map((comp) => (
              <PartnerCard
                key={comp.nodeId}
                comp={comp}
                side="right"
                portRefs={rightPortRefs}
                hovered={hoveredPortId}
                onHover={setHoveredPortId}
                onNavigateToNode={onNavigateToNode}
                onShowDetails={onShowDetails}
                safetyNamespace={safetyNamespace}
                onNavigateToReference={onNavigateToReference}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
