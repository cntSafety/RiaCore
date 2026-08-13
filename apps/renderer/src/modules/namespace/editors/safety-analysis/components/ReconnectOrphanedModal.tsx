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
 * ReconnectOrphanedModal
 *
 * Shown when the user right-clicks an architecture element and chooses
 * "Reconnect Orphaned Malfunction". Discovers current orphaned malfunctions,
 * supports filtered multi-selection, and reconnects only the checked items.
 */
import { Modal, Input, List, Tag, Alert, Spin, Empty, Typography, Space, Checkbox, theme } from 'antd';
import { WarningOutlined, LinkOutlined, SearchOutlined } from '@ant-design/icons';
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AffectedEdge, OrphanedEntryWithContext } from '@riacore/app-contracts';
import { api } from '../../../../../api/riacore';
import type { SelectedTreeElement } from '../types';
import { invalidateAfterContentChange } from '../../../../../hooks/workspaceCacheReset';

const { Text } = Typography;

interface MalfunctionCandidate {
  key: string;
  entry: OrphanedEntryWithContext;
  edge: AffectedEdge;
}

function candidateKey(entry: OrphanedEntryWithContext, edge: AffectedEdge): string {
  return [
    entry.runId,
    entry.stablePath,
    edge.authoredNamespace,
    edge.authoredStableId || edge.authoredNodeId,
    edge.relationship,
  ].join('\u0001');
}

interface ReconnectOrphanedModalProps {
  open: boolean;
  /** The architecture element the user right-clicked — the reconnect target. */
  targetElement: SelectedTreeElement | null;
  namespace: string;
  workspaceKey: string | null;
  onClose: () => void;
  /** Refresh the affected tree branch after the backend edge is committed. */
  onReconnected?: (target: SelectedTreeElement) => void | Promise<void>;
  triggerAutoSave?: () => void;
}

export function ReconnectOrphanedModal({
  open,
  targetElement,
  namespace,
  workspaceKey,
  onClose,
  onReconnected,
  triggerAutoSave,
}: ReconnectOrphanedModalProps) {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [reconnectedCount, setReconnectedCount] = useState(0);

  // Discover orphaned malfunctions from the live model for this analysis/target.
  const { data: allEntries = [], isLoading } = useQuery<OrphanedEntryWithContext[]>({
    queryKey: ['imports.listOrphanedEntries', workspaceKey, namespace, targetElement?.nodeId],
    queryFn: () => api.imports.listOrphanedEntries({
      analysisNamespace: namespace,
      targetNodeId: targetElement?.nodeId,
    }),
    enabled: open && !!workspaceKey && !!targetElement,
    staleTime: 30_000,
  });

  const candidates = useMemo<MalfunctionCandidate[]>(() => allEntries.flatMap((entry) =>
    entry.affectedEdges
      .filter((edge) => edge.authoredConcept === 'malfunction')
      .map((edge) => ({ key: candidateKey(entry, edge), entry, edge })),
  ), [allEntries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      ({ entry, edge }) =>
        entry.stablePath.toLowerCase().includes(q) ||
        entry.concept.toLowerCase().includes(q) ||
        entry.importedNamespace.toLowerCase().includes(q) ||
        edge.authoredName.toLowerCase().includes(q) ||
        edge.authoredNamespace.toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const selectedCount = selectedKeys.size;
  const filteredSelectedCount = filtered.reduce(
    (count, candidate) => count + (selectedKeys.has(candidate.key) ? 1 : 0),
    0,
  );
  const allFilteredSelected = filtered.length > 0 && filteredSelectedCount === filtered.length;

  const toggleCandidate = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        for (const candidate of filtered) next.delete(candidate.key);
      } else {
        for (const candidate of filtered) next.add(candidate.key);
      }
      return next;
    });
  };

  const handleClose = () => {
    setSearch('');
    setSelectedKeys(new Set());
    setError(null);
    setDone(false);
    setReconnectedCount(0);
    onClose();
  };

  const handleReconnect = async () => {
    if (selectedKeys.size === 0 || !targetElement) return;
    setReconnecting(true);
    setError(null);
    try {
      // Keep candidates from the same boundary entry together, but send only
      // the malfunction edges the user checked.
      const selectedByEntry = new Map<string, { entry: OrphanedEntryWithContext; edges: AffectedEdge[] }>();
      for (const candidate of candidates) {
        if (!selectedKeys.has(candidate.key)) continue;
        const entryKey = `${candidate.entry.runId}\u0001${candidate.entry.stablePath}`;
        const group = selectedByEntry.get(entryKey) ?? { entry: candidate.entry, edges: [] };
        group.edges.push(candidate.edge);
        selectedByEntry.set(entryKey, group);
      }

      let reconnected = 0;
      for (const { entry, edges } of selectedByEntry.values()) {
        reconnected += await api.imports.reconnectOrphanedEntry(
          { ...entry, affectedEdges: edges },
          targetElement.nodeId,
        );
      }
      if (reconnected < 1) {
        throw new Error('No orphaned malfunction could be reconnected. Refresh the model and try again.');
      }
      // Refresh every DB-content cache so the new cross-namespace edges are
      // visible — this also covers `imports.listOrphanedEntries`, so the list
      // behind this modal refreshes (see hooks/workspaceCacheReset.ts).
      await invalidateAfterContentChange(queryClient);
      // The tree keeps its own reducer index in addition to the query cache.
      // Refresh the selected host explicitly so its malfunction children move
      // into place before the success state is shown.
      await onReconnected?.(targetElement);
      triggerAutoSave?.();
      setReconnectedCount(reconnected);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnecting(false);
    }
  };

  const hasEntries = candidates.length > 0;

  return (
    <Modal
      title={
        <Space>
          <WarningOutlined style={{ color: token.colorWarning }} />
          <span>Reconnect Orphaned Malfunction</span>
        </Space>
      }
      open={open}
      onCancel={handleClose}
      onOk={done ? handleClose : () => void handleReconnect()}
      okText={done ? 'Done' : selectedCount > 0 ? `Reconnect (${selectedCount})` : 'Reconnect'}
      okButtonProps={{
        disabled: selectedCount === 0 || done,
        loading: reconnecting,
        icon: <LinkOutlined />,
      }}
      cancelText={done ? undefined : 'Cancel'}
      cancelButtonProps={done ? { style: { display: 'none' } } : undefined}
      destroyOnClose
      width={560}
    >
      {targetElement && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          Reconnecting to: <Text strong style={{ fontSize: 12 }}>{targetElement.name}</Text>
          {' '}
          <Tag style={{ fontSize: 11 }}>{targetElement.concept}</Tag>
        </Text>
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 12 }}
          closable
          onClose={() => setError(null)}
        />
      )}

      {done && (
        <Alert
          type="success"
          showIcon
          message={`${reconnectedCount} malfunction${reconnectedCount === 1 ? '' : 's'} reconnected successfully.`}
          style={{ marginBottom: 12 }}
        />
      )}

      {!done && (
        <>
          <Input
            prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
            placeholder="Search by path, concept, namespace, or malfunction name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            autoFocus
            style={{ marginBottom: 12 }}
          />

          {isLoading && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <Spin />
            </div>
          )}

          {!isLoading && !hasEntries && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No orphaned malfunctions found in the active analysis."
            />
          )}

          {!isLoading && hasEntries && filtered.length === 0 && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No entries match your search."
            />
          )}

          {!isLoading && filtered.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Checkbox
                  checked={allFilteredSelected}
                  indeterminate={filteredSelectedCount > 0 && !allFilteredSelected}
                  onChange={toggleAllFiltered}
                >
                  Select all shown
                </Checkbox>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {selectedCount} selected
                </Text>
              </div>
              <List
                size="small"
                dataSource={filtered}
                style={{
                  maxHeight: 320,
                  overflowY: 'auto',
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadius,
                }}
                renderItem={(candidate) => {
                  const isSelected = selectedKeys.has(candidate.key);
                  return (
                    <List.Item
                      onClick={() => toggleCandidate(candidate.key)}
                      style={{
                        cursor: 'pointer',
                        padding: '10px 12px',
                        background: isSelected ? token.colorPrimaryBg : undefined,
                        borderLeft: isSelected ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        aria-label={`Select ${candidate.edge.authoredName}`}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggleCandidate(candidate.key)}
                        style={{ marginRight: 10 }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Text strong={isSelected} ellipsis={{ tooltip: candidate.edge.authoredName }}>
                          {candidate.edge.authoredName || `Malfunction ${candidate.edge.authoredNodeId}`}
                        </Text>
                        <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
                          from <em>{candidate.edge.authoredNamespace}</em>
                        </Text>
                      </div>
                      <Tag style={{ fontSize: 11, marginLeft: 8 }}>malfunction</Tag>
                    </List.Item>
                  );
                }}
              />
            </>
          )}

          {hasEntries && (
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
              {filtered.length} of {candidates.length} orphaned malfunction{candidates.length === 1 ? '' : 's'}
            </Text>
          )}
        </>
      )}
    </Modal>
  );
}
