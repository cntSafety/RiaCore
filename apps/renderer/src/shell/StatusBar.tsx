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
import { Button, Dropdown, Space, theme } from 'antd';
import { DownOutlined, LinkOutlined, FolderOutlined, WarningOutlined, NodeIndexOutlined } from '@ant-design/icons';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useWorkspaceState, isDbOpen } from '../hooks/useWorkspaceState';
import { useWorkspaceStatus } from '../hooks/useWorkspaceStatus';

const { useToken } = theme;

interface StatusBarProps {
  onOpenAppLogs?: () => void;
  onOpenWorkspaceLogs?: () => void;
}

export function StatusBar({ onOpenAppLogs, onOpenWorkspaceLogs }: StatusBarProps) {
  const { token } = useToken();
  const { activeNamespace } = useWorkspaceStore();
  const wsState = useWorkspaceState();
  const { data: wsStatus } = useWorkspaceStatus();

  // Pending propagation source for the active namespace (mirrors the main
  // window's BottomPanel propagation chip so the spawn window offers the same
  // "cancel propagation" affordance once a propagation gesture is started).
  const pendingPropagation = useWorkspaceStore((s) =>
    activeNamespace ? (s.pendingPropagationSource[activeNamespace.name] ?? null) : null,
  );
  const setPendingSource = useWorkspaceStore((s) => s.setPendingPropagationSource);

  const dbStatus = wsStatus?.state === 'open' ? wsStatus.info.dbStatus : null;

  const wsLabel =
    wsState.phase === 'no_workspace'
      ? 'No workspace'
      : wsState.workingDir.split(/[\\/]/).pop() ?? wsState.workingDir;

  // Unified status label + color
  const { statusLabel, statusColor, showWarningIcon } = (() => {
    switch (wsState.phase) {
      case 'no_workspace':
        return { statusLabel: 'No workspace', statusColor: token.colorTextQuaternary, showWarningIcon: false };
      case 'loading_from_ria_data':
        return { statusLabel: 'Loading from ria-data…', statusColor: token.colorWarning, showWarningIcon: false };
      case 'load_failed':
        return { statusLabel: 'Load failed', statusColor: token.colorError, showWarningIcon: true };
      case 'db_open':
        if (dbStatus?.migrationNeeded)
          return { statusLabel: 'Migration needed', statusColor: token.colorWarning, showWarningIcon: true };
        if (dbStatus?.readOnly)
          return { statusLabel: 'Read-only', statusColor: token.colorWarning, showWarningIcon: true };
        if (wsState.lifecycleWarning)
          return { statusLabel: 'ria-data export failed', statusColor: token.colorError, showWarningIcon: true };
        switch (wsState.lifecycleAction) {
          case 'created':                     return { statusLabel: 'New workspace',         statusColor: token.colorSuccess, showWarningIcon: false };
          case 'opened_loaded_from_ria_data': return { statusLabel: 'Loaded from ria-data', statusColor: token.colorSuccess, showWarningIcon: false };
          case 'opened_saved_to_ria_data':    return { statusLabel: 'Exported to ria-data', statusColor: token.colorSuccess, showWarningIcon: false };
          default:                            return { statusLabel: 'In sync',              statusColor: token.colorSuccess, showWarningIcon: false };
        }
      case 'db_error':
        return { statusLabel: 'DB error', statusColor: token.colorError, showWarningIcon: true };
      case 'db_closed':
        return { statusLabel: 'DB closed', statusColor: token.colorTextTertiary, showWarningIcon: false };
    }
  })();

  const dbDetails = [
    { key: 'state',               label: 'state',               value: dbStatus?.state ?? 'unknown' },
    { key: 'schemaVersion',       label: 'schemaVersion',       value: dbStatus?.schemaVersion ?? '-' },
    { key: 'expectedSchemaVersion', label: 'expectedSchemaVersion', value: dbStatus?.expectedSchemaVersion ?? '-' },
    { key: 'readOnly',            label: 'readOnly',            value: String(Boolean(dbStatus?.readOnly)) },
    { key: 'migrationNeeded',     label: 'migrationNeeded',     value: String(Boolean(dbStatus?.migrationNeeded)) },
    { key: 'warning',             label: 'warning',             value: dbStatus?.warning ?? 'false' },
    { key: 'path',                label: 'path',                value: dbStatus?.path ?? '-' },
  ];

  const hasWorkspace = wsState.phase !== 'no_workspace';

  const logMenuItems = [
    {
      key: 'app-logs',
      label: 'Open App Logs',
      onClick: onOpenAppLogs,
    },
    {
      key: 'workspace-logs',
      label: 'Open Workspace Logs',
      onClick: onOpenWorkspaceLogs,
      disabled: !hasWorkspace,
    },
  ];

  return (
    <div
      className="status-bar"
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgLayout,
        fontSize: 11,
        color: token.colorTextSecondary,
        gap: 16,
        flexShrink: 0,
      }}
    >
      {/* Workspace indicator */}
      <Space size={4}>
        <FolderOutlined style={{ color: statusColor, fontSize: 11 }} />
        <span style={{ color: token.colorTextSecondary }}>{wsLabel}</span>
      </Space>

      {/* Unified status chip — shows DB details on click */}
      <Dropdown
        trigger={['click']}
        disabled={!isDbOpen(wsState)}
        menu={{ items: [] }}
        dropdownRender={() => (
          <div style={{
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            padding: '8px 12px',
            minWidth: 280,
            maxWidth: 420,
            fontSize: 11,
            boxShadow: token.boxShadowSecondary,
          }}>
            {dbDetails.map((item) => (
              <div key={item.key} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <span style={{ width: 130, color: token.colorTextTertiary }}>{item.label}</span>
                <span style={{ color: token.colorText }}>{item.value}</span>
              </div>
            ))}
          </div>
        )}
      >
        <Button
          type="text"
          size="small"
          style={{ padding: 0, height: 'auto', color: statusColor, fontSize: 11 }}
        >
          <Space size={4}>
            {showWarningIcon
              ? <WarningOutlined style={{ color: statusColor, fontSize: 11 }} />
              : <span style={{ color: statusColor }}>●</span>
            }
            <span style={{ color: statusColor }}>{statusLabel}</span>
            {isDbOpen(wsState) && <DownOutlined style={{ fontSize: 8 }} />}
          </Space>
        </Button>
      </Dropdown>

      {/* Active namespace */}
      {activeNamespace && (
        <Space size={4}>
          <span style={{ color: token.colorTextTertiary }}>NS:</span>
          <span>{activeNamespace.name}</span>
        </Space>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Propagation chip — visible only while a propagation gesture is pending */}
      {pendingPropagation && activeNamespace && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 6px',
          height: 18,
          borderRadius: 3,
          background: token.colorWarningBg,
          border: `1px solid ${token.colorWarningBorder}`,
          color: token.colorWarning,
          fontSize: 11,
          flexShrink: 0,
        }}>
          <NodeIndexOutlined style={{ fontSize: 10 }} />
          <span>
            Propagation from <strong>{pendingPropagation.name}</strong>
          </span>
          <Button
            type="text"
            size="small"
            onClick={() => setPendingSource(activeNamespace.name, null)}
            style={{ padding: '0 3px', height: 14, fontSize: 10, color: token.colorWarning, marginLeft: 2 }}
          >
            Cancel
          </Button>
        </span>
      )}

      {/* Log link */}
      <Dropdown menu={{ items: logMenuItems }} trigger={['click']}>
        <Button
          type="text"
          size="small"
          style={{ padding: 0, height: 'auto', color: token.colorTextSecondary, fontSize: 11 }}
        >
          <Space size={3}>
            <LinkOutlined style={{ fontSize: 10 }} />
            <span>Logs</span>
            <DownOutlined style={{ fontSize: 8 }} />
          </Space>
        </Button>
      </Dropdown>
    </div>
  );
}
