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
 * StatusCardsView — container view for the safety status cards grid.
 *
 * - Right-click any card title → "Show in Tree" navigates the safety analysis window
 * - Refresh button re-fetches the safety data from the backend
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Spin, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useSafetyData } from '../../hooks/useSafetyData';
import { StatusCard } from './StatusCard';

interface StatusCardsViewProps {
  namespace: string;
  onBack: () => void;
}

export function StatusCardsView({ namespace, onBack }: StatusCardsViewProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, isFetching } = useSafetyData(namespace);
  const [searchText, setSearchText] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);

  // Force a fresh fetch every time the view mounts (navigated to).
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['safety.safetyData', namespace] });
  }, [queryClient, namespace]);

  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['safety.safetyData', namespace] });
  };

  const filteredComponents = useMemo(() => {
    if (!data) return [];
    if (!searchText.trim()) return data.components;
    const q = searchText.toLowerCase();
    return data.components.filter(c => c.name.toLowerCase().includes(q));
  }, [data, searchText]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          flexShrink: 0,
          borderBottom: '1px solid var(--ant-color-border, #f0f0f0)',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 16 }}>
          Safety Status Cards — {namespace}
        </span>

        <Tooltip title="How Status Cards work">
          <Button
            type="text"
            size="small"
            icon={<InfoCircleOutlined />}
            onClick={() => setInfoOpen(true)}
          />
        </Tooltip>

        <Input
          prefix={<SearchOutlined style={{ opacity: 0.4 }} />}
          placeholder="Filter by component name…"
          allowClear
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          style={{ maxWidth: 260, flex: 1 }}
        />

        <Tooltip title="Refresh data from backend">
          <Button
            icon={<ReloadOutlined spin={isFetching} />}
            onClick={handleRefresh}
            disabled={isFetching}
          >
            Refresh
          </Button>
        </Tooltip>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Spin size="large" />
          </div>
        )}

        {isError && (
          <Alert
            type="error"
            message="Failed to load safety data"
            description={error instanceof Error ? error.message : String(error)}
            showIcon
          />
        )}

        {!isLoading && !isError && data && data.components.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Empty description="No components with safety data found" />
          </div>
        )}

        {!isLoading && !isError && data && data.components.length > 0 && filteredComponents.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Empty description={`No components matching "${searchText}"`} />
          </div>
        )}

        {!isLoading && !isError && filteredComponents.length > 0 && (
          <div
            style={{
              columnCount: 3,
              columnGap: 16,
              columnWidth: 340,
            }}
          >
            {filteredComponents.map(component => (
              <div key={component.uuid} style={{ breakInside: 'avoid', marginBottom: 16 }}>
                <StatusCard
                  component={component}
                  safetyNamespace={namespace}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info modal */}
      <Modal
        title="About Safety Status Cards"
        open={infoOpen}
        onCancel={() => setInfoOpen(false)}
        footer={<Button type="primary" onClick={() => setInfoOpen(false)}>Got it</Button>}
        width={560}
      >
        <Typography.Paragraph>
          Each card represents any element from the imported namespace that has at least one malfunction linked to it via the <Typography.Text code>occurs_at</Typography.Text> relationship. This works across all supported metamodels — AUTOSAR SWCs, SysML v2 parts, actions, attributes, or any other element type.
        </Typography.Paragraph>
        <Typography.Paragraph>
          <Typography.Text strong>What is shown:</Typography.Text>
        </Typography.Paragraph>
        <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
          <li><Typography.Text strong>Ports</Typography.Text> — receiver (left) and provider (right) interfaces. <Typography.Text type="warning">Amber</Typography.Text> = has ≥1 malfunction, <Typography.Text type="danger">Red</Typography.Text> = no malfunction assigned.</li>
          <li><Typography.Text strong>Orange squares</Typography.Text> — malfunctions with safety impact (ASIL A–D). <Typography.Text type="secondary">Gray</Typography.Text> = QM (no safety impact).</li>
          <li><Typography.Text strong>Green bar</Typography.Text> (above MF) — malfunction has at least one linked requirement.</li>
          <li><Typography.Text strong>Yellow bars</Typography.Text> (left/right of MF) — incoming/outgoing failure propagation.</li>
          <li><Typography.Text strong>Risk Matrix</Typography.Text> — 5×5 grid showing occurrence vs detection levels. Only shown when risk ratings exist.</li>
        </ul>
        <Typography.Paragraph>
          <Typography.Text strong>What is NOT shown:</Typography.Text> Elements without any malfunction are not rendered as cards. If no malfunction points to an element via <Typography.Text code>occurs_at</Typography.Text>, it will not appear here.
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}
