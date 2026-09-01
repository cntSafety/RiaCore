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
 * ComponentDiagram — schematic visual of an SWC component showing:
 *   - The component body as a rounded rectangle
 *   - Receiver ports (left edge) and provider ports (right edge)
 *   - Port colour: orange if ≥1 MF, red if no MF
 *   - Functional malfunctions as orange squares inside the body
 *   - Incoming propagation bar (left of MF) — yellow if has causation
 *   - Outgoing propagation bar (right of MF) — yellow if propagates out
 *   - Requirement indicator (green bar above MF) — if reqIds.length > 0
 *   - Click on a MF square → opens detail modal
 *
 * Pure presentational + one modal interaction. No IPC calls.
 */

import { useState } from 'react';
import { Modal, Descriptions, Tag } from 'antd';
import type { ComponentExportData, MalfunctionExportData, PortExportData } from '@riacore/app-contracts';
import { ActionPriorityTag } from '../namespace/editors/safety-analysis/components/ActionPriorityTag';
import { useSafetyProfileMetadata } from '../namespace/editors/safety-analysis/hooks/useSafetyProfileMetadata';

// ── Colour tokens ─────────────────────────────────────────────────────────────

const C = {
  componentBorder: '#3d7a6b',
  componentFill: 'var(--ant-color-bg-container, #fafaf5)',
  portWithMF: '#f59e0b',      // amber — port has ≥1 malfunction
  portNoMF: '#dc2626',        // red — port has no malfunction
  mfSquare: '#f97316',        // orange — safety-impact malfunction (ASIL A–D)
  mfSquareQM: '#9ca3af',     // gray — QM malfunction (no safety impact)
  reqBar: '#10b981',          // green — has requirement
  propIn: '#eab308',          // yellow — incoming propagation
  propOut: '#eab308',         // yellow — outgoing propagation
  propNone: 'transparent',
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortInfo {
  name: string;
  kind: 'receiver' | 'provider';
  hasMF: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function derivePorts(component: ComponentExportData): { receiverPorts: PortInfo[]; providerPorts: PortInfo[] } {
  // Ports with MFs — collect distinct port names per kind
  const receiverPortNamesWithMF = new Set(component.receiverPortMFs.map(mf => mf.portName).filter(Boolean));
  const providerPortNamesWithMF = new Set(component.providerPortMFs.map(mf => mf.portName).filter(Boolean));

  // Use the real ports array from the backend
  const receiverPorts: PortInfo[] = [];
  const providerPorts: PortInfo[] = [];

  for (const port of component.ports) {
    const info: PortInfo = {
      name: port.name,
      kind: port.kind,
      hasMF: port.kind === 'receiver'
        ? receiverPortNamesWithMF.has(port.name)
        : providerPortNamesWithMF.has(port.name),
    };
    if (port.kind === 'receiver') {
      receiverPorts.push(info);
    } else {
      providerPorts.push(info);
    }
  }

  return { receiverPorts, providerPorts };
}

function hasOutgoingPropagation(mf: MalfunctionExportData): boolean {
  // A MF has outgoing propagation if it has any propagatesToIds
  return mf.propagatesToIds.length > 0;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ComponentDiagramProps {
  component: ComponentExportData;
}

export function ComponentDiagram({ component }: ComponentDiagramProps) {
  const [selectedMF, setSelectedMF] = useState<MalfunctionExportData | null>(null);
  const profile = useSafetyProfileMetadata();

  const { receiverPorts, providerPorts } = derivePorts(component);
  const allMFs = [...component.functionalMFs, ...component.receiverPortMFs, ...component.providerPortMFs];

  // Layout constants
  const PORT_SIZE = 10;
  const PORT_GAP = 4;
  const MF_SIZE = 16;
  const MF_GAP = 4;
  const BODY_PADDING = 12;
  const PROP_BAR_W = 4;
  const REQ_BAR_H = 3;

  // Compute body dimensions based on content
  const maxPorts = Math.max(receiverPorts.length, providerPorts.length, 1);
  const bodyH = Math.max(
    maxPorts * (PORT_SIZE + PORT_GAP) + PORT_GAP + 8,
    component.functionalMFs.length * (MF_SIZE + MF_GAP + REQ_BAR_H + 2) + BODY_PADDING * 2,
    80,
  );
  const bodyW = Math.max(120, 60 + component.functionalMFs.length * 6);

  const svgW = bodyW + 40; // extra space for port squares outside body
  const svgH = bodyH + 16;

  const bodyX = 20;
  const bodyY = 8;

  return (
    <>
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ display: 'block', margin: '0 auto' }}
        aria-label={`Component diagram for ${component.name}`}
      >
        {/* Component body */}
        <rect
          x={bodyX}
          y={bodyY}
          width={bodyW}
          height={bodyH}
          rx={6}
          ry={6}
          fill={C.componentFill}
          stroke={C.componentBorder}
          strokeWidth={1.5}
        />

        {/* Receiver ports (left edge) */}
        {receiverPorts.map((port, i) => {
          const py = bodyY + PORT_GAP + i * (PORT_SIZE + PORT_GAP);
          return (
            <rect
              key={`rp-${port.name}`}
              x={bodyX - PORT_SIZE / 2}
              y={py}
              width={PORT_SIZE}
              height={PORT_SIZE}
              rx={2}
              fill={port.hasMF ? C.portWithMF : C.portNoMF}
            >
              <title>{port.name} ({port.hasMF ? 'has malfunction' : 'no malfunction assigned'})</title>
            </rect>
          );
        })}

        {/* Provider ports (right edge) */}
        {providerPorts.map((port, i) => {
          const py = bodyY + PORT_GAP + i * (PORT_SIZE + PORT_GAP);
          return (
            <rect
              key={`pp-${port.name}`}
              x={bodyX + bodyW - PORT_SIZE / 2}
              y={py}
              width={PORT_SIZE}
              height={PORT_SIZE}
              rx={2}
              fill={port.hasMF ? C.portWithMF : C.portNoMF}
            >
              <title>{port.name} ({port.hasMF ? 'has malfunction' : 'no malfunction assigned'})</title>
            </rect>
          );
        })}

        {/* Functional malfunctions (inside body, centered) */}
        {component.functionalMFs.map((mf, i) => {
          const mfX = bodyX + bodyW / 2 - MF_SIZE / 2;
          const mfY = bodyY + BODY_PADDING + i * (MF_SIZE + MF_GAP + REQ_BAR_H + 2);
          const hasReq = mf.reqIds.length > 0;
          const hasIncoming = mf.propagatesFromIds.length > 0;
          const hasOutgoing = hasOutgoingPropagation(mf);

          return (
            <g key={`mf-${mf.nodeId}`} style={{ cursor: 'pointer' }} onClick={() => setSelectedMF(mf)}>
              {/* Requirement bar (above MF) */}
              <rect
                x={mfX}
                y={mfY}
                width={MF_SIZE}
                height={REQ_BAR_H}
                rx={1}
                fill={hasReq ? C.reqBar : 'transparent'}
              />

              {/* Incoming propagation bar (left of MF) */}
              <rect
                x={mfX - PROP_BAR_W - 2}
                y={mfY + REQ_BAR_H + 1}
                width={PROP_BAR_W}
                height={MF_SIZE}
                rx={1}
                fill={hasIncoming ? C.propIn : C.propNone}
                stroke={hasIncoming ? C.propIn : 'rgba(0,0,0,0.1)'}
                strokeWidth={0.5}
              />

              {/* Malfunction square */}
              <rect
                x={mfX}
                y={mfY + REQ_BAR_H + 1}
                width={MF_SIZE}
                height={MF_SIZE}
                rx={2}
                fill={mf.asil === 'QM' || mf.asil === '' ? C.mfSquareQM : C.mfSquare}
              >
                <title>{mf.name} (ASIL {mf.asil || 'N/A'})</title>
              </rect>

              {/* Outgoing propagation bar (right of MF) */}
              <rect
                x={mfX + MF_SIZE + 2}
                y={mfY + REQ_BAR_H + 1}
                width={PROP_BAR_W}
                height={MF_SIZE}
                rx={1}
                fill={hasOutgoing ? C.propOut : C.propNone}
                stroke={hasOutgoing ? C.propOut : 'rgba(0,0,0,0.1)'}
                strokeWidth={0.5}
              />
            </g>
          );
        })}
      </svg>

      {/* MF detail modal */}
      <Modal
        title={selectedMF?.name ?? 'Malfunction Details'}
        open={selectedMF !== null}
        onCancel={() => setSelectedMF(null)}
        footer={null}
        width={480}
        destroyOnClose
      >
        {selectedMF && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="ID">{selectedMF.id}</Descriptions.Item>
            <Descriptions.Item label="Name">{selectedMF.name}</Descriptions.Item>
            <Descriptions.Item label="ASIL">
              <Tag color={selectedMF.asil === 'D' ? 'red' : selectedMF.asil === 'C' ? 'orange' : selectedMF.asil === 'B' ? 'gold' : 'default'}>
                {selectedMF.asil || 'N/A'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Description">{selectedMF.description || '—'}</Descriptions.Item>
            {selectedMF.portName && (
              <Descriptions.Item label="Port">{selectedMF.portName} ({selectedMF.portKind})</Descriptions.Item>
            )}
            <Descriptions.Item label="Requirements">
              {selectedMF.reqIds.length > 0 ? selectedMF.reqIds.join(', ') : 'None'}
            </Descriptions.Item>
            <Descriptions.Item label="Incoming Propagation">
              {selectedMF.propagatesFromIds.length > 0 ? selectedMF.propagatesFromIds.join(', ') : 'None'}
            </Descriptions.Item>
            {selectedMF.riskRating && (
              <>
                <Descriptions.Item label="Occurrence">{selectedMF.riskRating.has_occurrence_level}</Descriptions.Item>
                <Descriptions.Item label="Detection">{selectedMF.riskRating.has_detection_level}</Descriptions.Item>
                <Descriptions.Item label="RPN">{selectedMF.riskRating.risk_priority_number}</Descriptions.Item>
                <Descriptions.Item label="Action Priority">
                  <ActionPriorityTag
                    actionPriority={profile.actionPriority}
                    severity={selectedMF.riskRating.has_severity}
                    occurrence={selectedMF.riskRating.has_occurrence_level}
                    detection={selectedMF.riskRating.has_detection_level}
                  />
                </Descriptions.Item>
              </>
            )}
          </Descriptions>
        )}
      </Modal>
    </>
  );
}
