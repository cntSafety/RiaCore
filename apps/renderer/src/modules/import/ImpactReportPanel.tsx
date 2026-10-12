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
import { Alert, Button, Collapse, Descriptions, Space, Tag, Typography, theme } from 'antd';
import {
  WarningOutlined,
  EditOutlined,
  LinkOutlined,
  CheckOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { createElement, useMemo, useState } from 'react';
import type React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getNodeDecoration } from '../namespace/editors/safety-analysis/config/nodeTypeConfig';
import { useImpactReport } from '../../hooks/useImpactReport';
import { api } from '../../api/riacore';
import type { OrphanedEntry, ModifiedEntry, AffectedEdge } from '@riacore/app-contracts';
import { invalidateAfterContentChange } from '../../hooks/workspaceCacheReset';
import { toPropertyChanges } from './attributeChanges';
import { ChangedAttributes } from './ChangedAttributes';

const { Text } = Typography;
const { useToken } = theme;

interface ImpactReportPanelProps {
  runId: string;
}

/**
 * One entry as seen from a single authored namespace: the full entry (needed
 * intact for reconnect, which rebuilds every cross-NS edge) plus only the
 * edges that actually belong to that namespace.
 */
export interface NamespaceScopedEntry<T> {
  entry: T;
  edges: AffectedEdge[];
}

/**
 * Group entries by the authored namespaces found in their affectedEdges.
 *
 * A boundary node can be referenced from several authored namespaces, so the
 * same entry legitimately appears under more than one heading. The edge list is
 * narrowed per namespace, so a group never shows affected nodes owned by a
 * different namespace. Namespaces with no matching edges are dropped.
 */
export function groupByAuthoredNamespace<T extends { affectedEdges: AffectedEdge[] }>(
  entries: T[],
): Map<string, NamespaceScopedEntry<T>[]> {
  const grouped = new Map<string, NamespaceScopedEntry<T>[]>();
  const push = (ns: string, scoped: NamespaceScopedEntry<T>) => {
    const list = grouped.get(ns) ?? [];
    list.push(scoped);
    grouped.set(ns, list);
  };

  for (const entry of entries) {
    const namespaces = new Set(entry.affectedEdges.map((e) => e.authoredNamespace));
    // If no affected edges, group under a fallback key
    if (namespaces.size === 0) {
      push('(unknown)', { entry, edges: [] });
      continue;
    }
    for (const ns of namespaces) {
      const edges = entry.affectedEdges.filter((e) => e.authoredNamespace === ns);
      if (edges.length === 0) continue;
      push(ns, { entry, edges });
    }
  }
  return grouped;
}

/**
 * Concept icon matching the namespace tree, so an affected node is recognisable
 * here by the same glyph and colour the user knows from the tree.
 *
 * The tree additionally tints a `malfunction` icon by ASIL
 * (`NamespaceTreePanel.buildIcon`). The impact report carries no ASIL on
 * `AffectedEdge`, so the concept's own colour is used — identical to how the tree
 * renders a malfunction with no ASIL set.
 */
function conceptIcon(concept: string) {
  const decoration = getNodeDecoration(concept);
  return createElement(decoration.icon as React.ComponentType<{ style: React.CSSProperties }>, {
    style: { color: decoration.color, marginRight: 4 },
  });
}

/** Render the list of affected authored nodes for an entry. */
function AffectedNodesList({ edges }: { edges: AffectedEdge[] }) {
  return (
    <Space size={4} wrap style={{ width: '100%' }}>
      {edges.map((edge, i) => (
        <Tag
          key={`${edge.authoredNodeId}-${i}`}
          style={{
            fontSize: 11,
            maxWidth: '100%',
            height: 'auto',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            marginInlineEnd: 0,
          }}
        >
          {conceptIcon(edge.authoredConcept)}
          {edge.authoredName}{' '}
          <Text type="secondary" style={{ fontSize: 10 }}>
            ({edge.authoredConcept} · {edge.relationship})
          </Text>
        </Tag>
      ))}
    </Space>
  );
}

/** Resolution action buttons for an orphaned entry. */
function OrphanedActions({ entry }: { entry: OrphanedEntry }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only show Reconnect when a rename hint is available
  if (!entry.possibleRenameTarget) return null;

  const handleReconnect = async () => {
    if (!entry.possibleRenameTarget) return;
    setLoading(true);
    setError(null);
    try {
      const reconnected = await api.imports.reconnectOrphanedEntry(entry, entry.possibleRenameTarget.nodeId);
      if (reconnected < 1) {
        throw new Error('No orphaned relationship could be reconnected. Refresh the report and try again.');
      }
      // Refresh every DB-content cache so the authored namespace reflects the
      // restored cross-namespace edges immediately (see hooks/workspaceCacheReset.ts).
      // The `['impactReport', runId]` cache is flow-scoped and survives, so this
      // panel keeps rendering the report it was opened with.
      await invalidateAfterContentChange(queryClient);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <Space size={4} style={{ marginTop: 8 }}>
        <Tag color="success" icon={<CheckOutlined />}>Reconnected</Tag>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={4} style={{ marginTop: 8, width: '100%' }}>
      <Space size={4}>
        <Button
          size="small"
          icon={<LinkOutlined />}
          loading={loading}
          onClick={() => void handleReconnect()}
        >
          Reconnect to renamed node
        </Button>
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ fontSize: 11 }} />}
    </Space>
  );
}

/** Resolution action buttons for a modified entry — no action needed, edges are auto-reconnected. */
function ModifiedActions(_props: { entry: ModifiedEntry }) {
  return null;
}

/** Render a single orphaned entry with details and actions. */
function OrphanedEntryItem({ entry, edges }: { entry: OrphanedEntry; edges: AffectedEdge[] }) {
  const { token } = useToken();

  return (
    <div style={{ marginBottom: 12, padding: '8px 12px', background: token.colorBgLayout, borderRadius: token.borderRadius, overflow: 'hidden' }}>
      <Descriptions
        size="small"
        column={1}
        style={{ marginBottom: 4 }}
        contentStyle={{ minWidth: 0, wordBreak: 'break-word' }}
      >
        <Descriptions.Item label="Path">
          <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{entry.stablePath}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Concept">
          <Tag>{entry.concept}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Affected nodes">
          <AffectedNodesList edges={edges} />
        </Descriptions.Item>
        {entry.possibleRenameTarget && (
          <Descriptions.Item label="Rename hint">
            <Space size={4}>
              <SwapOutlined style={{ color: token.colorInfo }} />
              <Text style={{ fontSize: 12 }}>
                Likely renamed to{' '}
                <Text code style={{ fontSize: 12 }}>{entry.possibleRenameTarget.stablePath}</Text>
                {' '}(node {entry.possibleRenameTarget.nodeId})
              </Text>
            </Space>
          </Descriptions.Item>
        )}
      </Descriptions>
      <OrphanedActions entry={entry} />
    </div>
  );
}

/** Render a single modified entry with details and actions. */
function ModifiedEntryItem({ entry, edges }: { entry: ModifiedEntry; edges: AffectedEdge[] }) {
  const { token } = useToken();

  // The report already carries the full before/after attribute maps; only the
  // key names were ever shown. See attributeChanges.ts.
  const changes = useMemo(
    () => toPropertyChanges(entry.changedKeys, entry.oldAttributes, entry.newAttributes),
    [entry],
  );

  return (
    <div style={{ marginBottom: 12, padding: '8px 12px', background: token.colorBgLayout, borderRadius: token.borderRadius, overflow: 'hidden' }}>
      <Descriptions
        size="small"
        column={1}
        style={{ marginBottom: 4 }}
        contentStyle={{ minWidth: 0, wordBreak: 'break-word' }}
      >
        <Descriptions.Item label="Path">
          <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{entry.stablePath}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={`Changes (${entry.changedKeys.length})`}>
          <ChangedAttributes changes={changes} />
        </Descriptions.Item>
        <Descriptions.Item label="Affected nodes">
          <AffectedNodesList edges={edges} />
        </Descriptions.Item>
      </Descriptions>
      <ModifiedActions entry={entry} />
    </div>
  );
}

// ── Minimalist success state ──────────────────────────────────────────────────

function ImpactReportSuccess({ report }: { report: import('@riacore/app-contracts').ImpactReport }) {
  const { token } = useToken();

  const isFirstImport = report.stableCount === 0 && report.orphaned.length === 0 && report.modified.length === 0;

  const stats = [
    { value: report.stableCount, label: 'Stable' },
    { value: report.orphaned.length, label: 'Orphaned' },
    { value: report.modified.length, label: 'Modified' },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="success"
        showIcon
        message="Changes do not impact existing analysis"
        description={
          isFirstImport
            ? 'First import: no prior relationship between namespaces to assess.'
            : 'Cross-namespace connections were automatically restored.'
        }
      />

      {!isFirstImport && (
        <Space size={6} wrap>
          {stats.map((item) => (
            <Tag key={item.label} color={item.label === 'Stable' ? 'success' : undefined}>
              <Text strong style={{ fontVariantNumeric: 'tabular-nums', color: token.colorText }}>
                {item.value}
              </Text>
              <Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
                {item.label}
              </Text>
            </Tag>
          ))}
        </Space>
      )}
    </Space>
  );
}

// ── Minimalist warning header ─────────────────────────────────────────────────

function ImpactReportWarning({ summaryText }: { summaryText: string }) {
  const { token } = useToken();

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div style={{ flexShrink: 0, marginTop: 5 }}>
          <div style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: token.colorWarning,
            boxShadow: `0 0 0 3px ${token.colorWarningBg}`,
          }} />
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: token.colorText, marginBottom: 2 }}>
            Boundary Impact Detected
          </div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {summaryText} boundary nodes require attention.
          </div>
        </div>
      </div>
      <div style={{
        height: 2,
        background: token.colorWarningBorder,
        borderRadius: 1,
        marginBottom: 4,
      }} />
    </div>
  );
}

/** Main impact report panel — only renders when orphaned or modified entries exist. */
export function ImpactReportPanel({ runId }: ImpactReportPanelProps) {
  const { data: report, isLoading } = useImpactReport(runId);

  if (isLoading || !report) return null;

  const hasOrphaned = report.orphaned.length > 0;
  const hasModified = report.modified.length > 0;

  // Show success message when there are no orphaned or modified entries
  if (!hasOrphaned && !hasModified) {
    return <ImpactReportSuccess report={report} />;
  }

  const orphanedByNs = groupByAuthoredNamespace(report.orphaned);
  const modifiedByNs = groupByAuthoredNamespace(report.modified);

  const summaryText = [
    `${report.orphaned.length} orphaned`,
    `${report.modified.length} modified`,
    `${report.stableCount} stable`,
  ].join(', ');

  const collapseItems = [];

  if (hasOrphaned) {
    collapseItems.push({
      key: 'orphaned',
      label: (
        <Space>
          <WarningOutlined style={{ color: '#dc2626' }} />
          <span>Orphaned entries ({report.orphaned.length})</span>
        </Space>
      ),
      children: (
        <div>
          {[...orphanedByNs.entries()].map(([ns, entries]) => (
            <div key={ns} style={{ marginBottom: 16 }}>
              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                Authored namespace: <Tag color="blue">{ns}</Tag>
              </Text>
              {entries.map(({ entry, edges }) => (
                <OrphanedEntryItem key={entry.stablePath} entry={entry} edges={edges} />
              ))}
            </div>
          ))}
        </div>
      ),
    });
  }

  if (hasModified) {
    collapseItems.push({
      key: 'modified',
      label: (
        <Space>
          <EditOutlined style={{ color: '#d97706' }} />
          <span>Modified entries ({report.modified.length})</span>
        </Space>
      ),
      children: (
        <div>
          {[...modifiedByNs.entries()].map(([ns, entries]) => (
            <div key={ns} style={{ marginBottom: 16 }}>
              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                Authored namespace: <Tag color="blue">{ns}</Tag>
              </Text>
              {entries.map(({ entry, edges }) => (
                <ModifiedEntryItem key={entry.stablePath} entry={entry} edges={edges} />
              ))}
            </div>
          ))}
        </div>
      ),
    });
  }

  return (
    <div style={{ padding: 16 }}>
      <ImpactReportWarning summaryText={summaryText} />
      <Collapse
        defaultActiveKey={['orphaned', 'modified']}
        items={collapseItems}
        size="small"
      />
    </div>
  );
}
