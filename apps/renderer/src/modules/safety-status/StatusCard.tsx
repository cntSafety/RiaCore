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
 * StatusCard — per-component safety status card.
 *
 * Shows:
 *  - Component diagram (ports, malfunctions, propagation, requirements)
 *  - Risk matrix bubble chart (when risk ratings exist)
 *  - Component type tag (e.g. application_swc, part_definition)
 *
 * Right-click the component name → "Show in Tree" in the safety analysis window.
 */

import { Card, Tag } from 'antd';
import type { ComponentExportData, MalfunctionExportData } from '@riacore/app-contracts';
import { RiskMatrix, type RiskMatrixBubble } from './RiskMatrix';
import { ComponentDiagram } from './ComponentDiagram';
import { ShowInTreeTrigger } from '../../components/ShowInTreeTrigger';

export interface StatusCardProps {
  component: ComponentExportData;
  safetyNamespace: string;
}

// ── Exported helpers (used by property-based tests) ──────────────────────────

export function computeCoverage(mfs: MalfunctionExportData[]): { total: number; covered: number } {
  return {
    total: mfs.length,
    covered: mfs.filter(mf => mf.reqIds.length > 0).length,
  };
}

export function computePortMFCoverage(mfs: MalfunctionExportData[]): { portsWithMF: number; totalPorts: number } {
  const ports = new Set(mfs.map(mf => mf.portName ?? `__unnamed_${mf.nodeId}`));
  return { portsWithMF: ports.size, totalPorts: ports.size };
}

export function computeRiskMatrixBubbles(component: ComponentExportData): RiskMatrixBubble[] {
  const allMFs = [
    ...component.functionalMFs,
    ...component.receiverPortMFs,
    ...component.providerPortMFs,
  ];
  const safetyImpactMFs = allMFs.filter(
    mf => mf.asil && mf.asil !== 'QM' && mf.riskRating !== null,
  );
  const grouped = new Map<string, number>();
  for (const mf of safetyImpactMFs) {
    const key = `${mf.riskRating!.has_occurrence_level}|${mf.riskRating!.has_detection_level}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return Array.from(grouped.entries()).map(([key, count]) => {
    const [occurrence, detection] = key.split('|');
    return { occurrence, detection, count };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive a human-friendly metamodel label from the componentType concept name. */
function metamodelLabel(componentType: string): string {
  const ARXML_CONCEPTS = [
    'application_swc', 'composition_swc', 'service_swc',
    'ecu_abstraction_swc', 'cdd_swc', 'sensor_actuator_swc',
    'nv_block_swc', 'parameter_swc', 'service_proxy_swc',
  ];
  if (ARXML_CONCEPTS.includes(componentType)) return 'ARXML';
  // SysML v2 concepts use snake_case names like part_definition, action_usage, etc.
  if (componentType.includes('_definition') || componentType.includes('_usage') || componentType === 'package') return 'SysML v2';
  return componentType;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StatusCard({ component, safetyNamespace }: StatusCardProps) {
  const bubbles = computeRiskMatrixBubbles(component);

  return (
    <div data-testid="status-card">
      <Card
        title={
          <ShowInTreeTrigger
            homeTarget={{
              nodeId: component.nodeId,
              namespace: component.namespace,
              concept: component.componentType,
            }}
            safetyNamespace={safetyNamespace}
            wrapperStyle={{ width: '100%' }}
            hideKebab
          >
            <span style={{ cursor: 'context-menu', fontSize: 15, fontWeight: 600 }} title="Right-click → Show in Tree">
              {component.name}
            </span>
          </ShowInTreeTrigger>
        }
        size="small"
        styles={{ body: { padding: '12px 16px' } }}
      >
        {/* ── Component diagram ── */}
        <div style={{ marginBottom: 12 }}>
          <ComponentDiagram component={component} />
        </div>

        {/* ── Risk matrix — only shown when there are actual risk ratings ── */}
        {bubbles.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.75, alignSelf: 'flex-start' }}>Risk Matrix</div>
            <RiskMatrix bubbles={bubbles} />
          </div>
        )}

        {/* ── Port count + metamodel type indicator ── */}
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, opacity: 0.65 }}>
            {component.portCount} {component.portCount === 1 ? 'port' : 'ports'}
          </span>
          <Tag style={{ fontSize: 10, margin: 0 }}>
            {metamodelLabel(component.componentType)}
          </Tag>
        </div>
      </Card>
    </div>
  );
}
