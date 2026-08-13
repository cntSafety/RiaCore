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
import { Button, Card, Progress, Tag, Space, Badge, Alert, Empty, theme } from 'antd';
import {
  PlusOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ImporterConfigDrawer } from './ImporterConfigDrawer';
import { api } from '../../api/riacore';
import type { ImportRunStatus } from '@riacore/app-contracts';

const { useToken } = theme;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ImporterDefinition {
  id: string;
  label: string;
  tool: string;
  configPath?: string;
  lastRunId?: string;
}

// Demo data until workspace IPC exposes the importer list
const DEMO_IMPORTERS: ImporterDefinition[] = [
  { id: 'imp-arxml', label: 'AUTOSAR ARXML', tool: 'arxml-importer' },
  { id: 'imp-sysml', label: 'SysML v2', tool: 'sysml-importer' },
  { id: 'imp-sphinx', label: 'Sphinx-Needs', tool: 'sphinx-importer' },
];

// ── ImporterRow ───────────────────────────────────────────────────────────────

function StatusIcon({ runStatus }: { runStatus?: ImportRunStatus | null }) {
  if (!runStatus) return null;
  if (runStatus.status === 'running') return <SyncOutlined spin style={{ color: '#2563eb' }} />;
  if (runStatus.status === 'completed') return <CheckCircleOutlined style={{ color: '#16a34a' }} />;
  if (runStatus.status === 'failed') return <CloseCircleOutlined style={{ color: '#dc2626' }} />;
  return null;
}

function ImporterRow({
  importer,
  onConfig,
  onRun,
}: {
  importer: ImporterDefinition;
  onConfig: () => void;
  onRun: () => void;
}) {
  const { token } = useToken();

  const { data: runStatus } = useQuery({
    queryKey: ['imports.status', importer.lastRunId],
    queryFn: () =>
      importer.lastRunId
        ? api.imports.getStatus(importer.lastRunId)
        : Promise.resolve(null),
    enabled: !!importer.lastRunId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === 'running' ? 1000 : false;
    },
  });

  const isRunning = runStatus?.status === 'running';
  const prog = runStatus?.progress;
  const progress = prog?.current != null && prog?.total ? prog.current / prog.total : undefined;
  const phase = prog?.phase;

  return (
    <Card
      size="small"
      className="riacore-card"
      style={{ marginBottom: 8 }}
      styles={{ body: { padding: '8px 12px' } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusIcon runStatus={runStatus} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{importer.label}</span>
            <Tag style={{ fontSize: 10 }}>{importer.tool}</Tag>
          </div>

          {isRunning && progress !== undefined && (
            <div>
              <Progress
                percent={Math.round(progress * 100)}
                size="small"
                showInfo={false}
                style={{ margin: 0 }}
              />
              {phase && (
                <div style={{ fontSize: 11, color: token.colorTextTertiary }}>{phase}</div>
              )}
            </div>
          )}

          {runStatus?.status === 'failed' && (
            <Alert
              type="error"
              message={`Import failed (errors: ${runStatus.stats?.errors ?? 'unknown'})`}
              banner
              style={{ fontSize: 11, padding: '2px 6px' }}
            />
          )}
        </div>

        <Space size={4}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={onConfig}
            style={{ fontSize: 11 }}
          >
            Config
          </Button>
          <Button
            size="small"
            type={isRunning ? 'default' : 'primary'}
            icon={isRunning ? <StopOutlined /> : <PlayCircleOutlined />}
            onClick={onRun}
            disabled={isRunning}
            style={{ fontSize: 11 }}
          >
            {isRunning ? 'Running…' : 'Run'}
          </Button>
        </Space>
      </div>
    </Card>
  );
}

// ── ImportManager ─────────────────────────────────────────────────────────────

export function ImportManager() {
  const { token } = useToken();
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [activeImporterId, setActiveImporterId] = useState<string | null>(null);

  const openConfig = (id: string) => {
    setActiveImporterId(id);
    setConfigDrawerOpen(true);
  };

  const handleRun = async (importerId: string) => {
    // TODO: wire to imports.run IPC with real params
    console.log('Run import:', importerId);
  };

  return (
    <div style={{ padding: 20, flex: 1, overflow: 'auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>Import Manager</span>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          style={{ fontSize: 12 }}
        >
          Add Importer
        </Button>
      </div>

      {DEMO_IMPORTERS.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No importers configured"
        />
      ) : (
        DEMO_IMPORTERS.map((imp) => (
          <ImporterRow
            key={imp.id}
            importer={imp}
            onConfig={() => openConfig(imp.id)}
            onRun={() => handleRun(imp.id)}
          />
        ))
      )}

      <ImporterConfigDrawer
        open={configDrawerOpen}
        importerId={activeImporterId}
        onClose={() => setConfigDrawerOpen(false)}
        onRun={handleRun}
      />
    </div>
  );
}
