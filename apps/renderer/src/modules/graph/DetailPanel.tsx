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
import { theme } from 'antd';
import type { GraphNode, GraphEdge } from '@riacore/app-contracts';
import { conceptColor } from './graphStyles';

const { useToken } = theme;

function isEdge(item: GraphNode | GraphEdge): item is GraphEdge {
  return 'type' in item && 'source' in item && 'target' in item;
}

function formatValue(value: unknown, fontFamily: string): React.ReactNode {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return (
          <pre style={{ margin: 0, fontSize: 11, fontFamily, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(parsed, null, 2)}
          </pre>
        );
      } catch {
        // not valid JSON, fall through
      }
    }
    return value;
  }
  if (value === null || value === undefined) return String(value);
  return String(value);
}

interface DetailPanelInnerProps {
  selected: GraphNode | GraphEdge | null;
  /** Width controlled externally when used inside a resizable layout. */
  width?: number;
}

export function DetailPanel({ selected }: DetailPanelInnerProps) {
  const { token } = useToken();

  const baseStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    borderLeft: 'none',
    background: token.colorBgContainer,
    fontFamily: token.fontFamily,
    fontSize: 12,
  };

  if (!selected) {
    return (
      <div
        style={{
          ...baseStyle,
          padding: 16,
          color: token.colorTextTertiary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
        }}
      >
        Select a node or edge to inspect its properties
      </div>
    );
  }

  const entries = Object.entries(selected.properties).filter(([key, value]) => {
    if (value === null || value === undefined) return false;
    if (isEdge(selected) && key === 'relationship') return false;
    // Concept is shown prominently in the hero header — don't duplicate it below
    if (!isEdge(selected) && key === 'concept') return false;
    return true;
  });

  const relationshipValue =
    isEdge(selected) && typeof selected.properties.relationship === 'string' && selected.properties.relationship.trim().length > 0
      ? selected.properties.relationship
      : null;

  // For ConceptInstance nodes, highlight the concept at the top of the panel
  const conceptName =
    !isEdge(selected) && typeof selected.properties.concept === 'string' && selected.properties.concept.length > 0
      ? selected.properties.concept
      : null;

  return (
    <div style={{ ...baseStyle, padding: 16, overflowY: 'auto' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: token.colorText }}>
        {isEdge(selected) ? 'Edge Details' : 'Node Details'}
      </div>

      {/* Concept hero header — only for ConceptInstance nodes */}
      {conceptName && (
        <div
          style={{
            marginBottom: 16,
            padding: '10px 12px',
            borderLeft: `4px solid ${conceptColor(conceptName)}`,
            background: token.colorFillTertiary,
            borderRadius: token.borderRadiusSM,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: token.colorTextTertiary,
              marginBottom: 2,
            }}
          >
            Concept
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: conceptColor(conceptName),
              wordBreak: 'break-word',
              lineHeight: 1.3,
            }}
          >
            {conceptName}
          </div>
        </div>
      )}

      {!isEdge(selected) && (
        <div style={{ marginBottom: 12 }}>
          <PropertyRow label="type" value={selected.label} token={token} />
        </div>
      )}

      {isEdge(selected) && (
        <div style={{ marginBottom: 12 }}>
          <PropertyRow label="relationship" value={relationshipValue ?? selected.type} token={token} />
          <PropertyRow label="type" value={selected.type} token={token} />
          <PropertyRow label="source" value={selected.source} token={token} />
          <PropertyRow label="target" value={selected.target} token={token} />
        </div>
      )}

      {entries.length > 0 ? (
        entries.map(([key, value]) => (
          <PropertyRow key={key} label={key} value={value} token={token} />
        ))
      ) : (
        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>No properties</div>
      )}
    </div>
  );
}

function PropertyRow({ label, value, token }: { label: string; value: unknown; token: Record<string, any> }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12, color: token.colorText, wordBreak: 'break-all', fontFamily: token.fontFamily }}>
        {formatValue(value, token.fontFamily as string)}
      </div>
    </div>
  );
}
