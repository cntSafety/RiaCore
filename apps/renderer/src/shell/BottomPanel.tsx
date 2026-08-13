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
 * BottomPanel — IDE-style status bar + collapsible activity drawer.
 *
 * Collapsed: a single 24px status bar showing workspace name, a unified
 *            status chip, HUD status pill, and a Logs button.
 *
 * Expanded: a resizable drawer with two tabs:
 *   • State    — workspace + DB status details
 *   • Activity — scrollable event log from lifecycleHudStore
 *
 * Status chip maps directly to the five workspace states:
 *   1. In sync          — workspace open, DB open, ria-data consistent
 *   2. Loading from ria-data — workspace open, ria-data present, loading into DB
 *   3. Saving to ria-data   — workspace open, DB present, exporting to ria-data
 *   4. No workspace     — nothing opened yet
 *   5. DB error / DB closed — error states
 */

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Button, Tabs, theme, Alert, Spin } from 'antd';
import {
  FolderOutlined,
  WarningOutlined,
  UpOutlined,
  DownOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  ToolOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useWorkspaceState } from '../hooks/useWorkspaceState';
import { useWorkspaceStatus } from '../hooks/useWorkspaceStatus';
import { useLifecycleHudStore, _registerBottomPanelActions } from '../store/lifecycleHudStore';
import { useBottomPanelStore } from '../store/bottomPanelStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { usePersistorRepairMutation } from '../hooks/useRiacoreMutations';
import { useOpenWorkspaceMutation } from '../hooks/useOpenWorkspaceMutation';
import { api } from '../api/riacore';
import { SaveStatusIndicator } from './SaveStatusIndicator';

const { useToken } = theme;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusChip = { label: string; color: string; icon?: React.ReactNode };

/** Derive a single unified status chip from the workspace phase + HUD state. */
function useStatusChip(): StatusChip {
  const { token } = useToken();
  const wsState = useWorkspaceState();
  const hudStatus = useLifecycleHudStore((s) => s.status);
  const hudTitle  = useLifecycleHudStore((s) => s.title);

  // Show in-progress operations (opening/creating workspace) on the left chip
  if (hudStatus === 'in_progress' && hudTitle) {
    return { label: hudTitle, color: token.colorWarning, icon: <LoadingOutlined style={{ fontSize: 10 }} spin /> };
  }

  switch (wsState.phase) {
    case 'no_workspace':
      return { label: 'No workspace', color: token.colorTextQuaternary };
    case 'loading_from_ria_data':
      return { label: 'Loading from ria-data…', color: token.colorWarning, icon: <LoadingOutlined style={{ fontSize: 10 }} spin /> };
    case 'load_failed':
      return { label: 'Load failed', color: token.colorError, icon: <WarningOutlined style={{ fontSize: 10 }} /> };
    case 'db_open':
      if (wsState.dbStatus.migrationNeeded)
        return { label: 'Migration needed', color: token.colorWarning, icon: <WarningOutlined style={{ fontSize: 10 }} /> };
      if (wsState.dbStatus.readOnly)
        return { label: 'Read-only', color: token.colorWarning, icon: <WarningOutlined style={{ fontSize: 10 }} /> };
      if (wsState.lifecycleWarning) {
        if (/file integrity check failed|files have been changed/i.test(wsState.lifecycleWarning))
          return { label: 'Files modified', color: token.colorWarning, icon: <WarningOutlined style={{ fontSize: 10 }} /> };
        return { label: 'ria-data export failed', color: token.colorError, icon: <WarningOutlined style={{ fontSize: 10 }} /> };
      }
      switch (wsState.lifecycleAction) {
        case 'created':                     return { label: 'New workspace',           color: token.colorSuccess };
        case 'opened_loaded_from_ria_data': return { label: 'Loaded from ria-data',   color: token.colorSuccess };
        case 'opened_saved_to_ria_data':    return { label: 'Exported to ria-data',   color: token.colorSuccess };
        default:                            return { label: 'In sync',                color: token.colorSuccess };
      }
    case 'db_error':
      return { label: 'DB error', color: token.colorError, icon: <WarningOutlined style={{ fontSize: 10 }} /> };
    case 'db_closed':
      return { label: 'DB closed', color: token.colorTextTertiary };
  }
}

// ---------------------------------------------------------------------------
// Collapsed status bar
// ---------------------------------------------------------------------------

interface StatusBarProps {
  onOpenAppLogs?: () => void;
  onOpenWorkspaceLogs?: () => void;
}

function CollapsedBar({ onOpenAppLogs }: StatusBarProps) {
  const { token } = useToken();
  const wsState   = useWorkspaceState();
  const chip      = useStatusChip();
  const { expanded, toggle, expand, setActiveTab } = useBottomPanelStore();

  const activeNamespace = useWorkspaceStore((s) => s.activeNamespace);
  const pendingPropagation = useWorkspaceStore((s) =>
    activeNamespace ? (s.pendingPropagationSource[activeNamespace.name] ?? null) : null,
  );
  const setPendingSource = useWorkspaceStore((s) => s.setPendingPropagationSource);

  const wsName =
    wsState.phase === 'no_workspace'
      ? 'No workspace'
      : wsState.workingDir.split(/[\\/]/).pop() ?? wsState.workingDir;

  const hasWorkspace = wsState.phase !== 'no_workspace';

  const barStyle: React.CSSProperties = {
    height: 24,
    display: 'flex',
    alignItems: 'center',
    padding: '0 10px',
    borderTop: `1px solid ${token.colorBorderSecondary}`,
    background: token.colorBgLayout,
    fontSize: 11,
    color: token.colorTextSecondary,
    gap: 12,
    flexShrink: 0,
    userSelect: 'none',
  };

  const chipStyle: React.CSSProperties = {
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '0 4px',
    borderRadius: 3,
    height: 18,
  };

  return (
    <div style={barStyle}>
      {/* Workspace folder name */}
      <span
        style={{ ...chipStyle, color: token.colorTextSecondary }}
        onClick={() => { setActiveTab('state'); expand(); }}
        title="Show workspace state"
      >
        <FolderOutlined style={{ fontSize: 11 }} />
        {wsName}
      </span>

      {/* Unified status chip */}
      <span
        style={{ ...chipStyle, color: chip.color }}
        onClick={() => { setActiveTab('state'); expand(); }}
        title="Show workspace state"
      >
        {chip.icon ?? <span style={{ fontSize: 9 }}>●</span>}
        {chip.label}
      </span>

      {/* Canvas Auto_Save status — only meaningful while the workspace DB is
          open; renders nothing until the first qualifying mutation (Req 9). */}
      {hasWorkspace && <SaveStatusIndicator />}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Propagation chip */}
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

      {/* Logs button */}
      <Button
        type="text"
        size="small"
        icon={<LinkOutlined style={{ fontSize: 10 }} />}
        style={{ padding: '0 4px', height: 18, fontSize: 11, color: token.colorTextSecondary }}
        onClick={() => {
          if (hasWorkspace) {
            const wd = (wsState as { workingDir: string }).workingDir;
            api.workspace.openLogsDirectory(wd).catch(() => onOpenAppLogs?.());
          } else {
            onOpenAppLogs?.();
          }
        }}
      >
        Logs
      </Button>

      {/* Expand/collapse toggle */}
      <Button
        type="text"
        size="small"
        icon={expanded
          ? <DownOutlined style={{ fontSize: 9 }} />
          : <UpOutlined   style={{ fontSize: 9 }} />
        }
        style={{ padding: '0 4px', height: 18, color: token.colorTextTertiary }}
        onClick={toggle}
        title={expanded ? 'Collapse panel' : 'Expand panel'}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// State tab — workspace & DB status with prominent visual hierarchy
// ---------------------------------------------------------------------------

function StateTab() {
  const { token } = useToken();
  const wsState   = useWorkspaceState();
  const { data: wsStatus } = useWorkspaceStatus();

  // Repair manifest state — shown when workspace open failed due to hash mismatch
  // or when files are corrupted but workspace is open (opened_db_only with file integrity warning)
  const repairMutation = usePersistorRepairMutation();
  const openMutation   = useOpenWorkspaceMutation();
  const [repairResult, setRepairResult] = useState<{ repaired: string[]; unchanged: string[]; manifestUpdated: boolean } | null>(null);

  // Handler for repair from the db_open/files_corrupted warning state
  const handleRepairFromWarning = async () => {
    if (wsState.phase === 'no_workspace') return;
    setRepairResult(null);
    try {
      const result = await repairMutation.mutateAsync(wsState.workingDir);
      setRepairResult({ repaired: result.namespaces_repaired, unchanged: result.namespaces_unchanged, manifestUpdated: result.manifest_updated });
      // Re-open with forceRecheck to verify the repair resolved the mismatch
      openMutation.mutate(wsState.workingDir);
    } catch {
      // error shown via repairMutation.error
    }
  };

  if (wsState.phase === 'no_workspace') {
    return (
      <div style={{ padding: '16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '3px 10px', borderRadius: 12,
          background: token.colorFillSecondary,
          color: token.colorTextTertiary,
          fontSize: 12, fontWeight: 500,
          alignSelf: 'flex-start',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: token.colorTextQuaternary, display: 'inline-block' }} />
          No workspace open
        </span>
      </div>
    );
  }

  // Use live dbStatus from wsStatus (getStatus() now returns dbModule.getStatus() live)
  // Handle load_failed phase — show error with repair action if it's a hash mismatch
  if (wsState.phase === 'load_failed') {
    const folderName = wsState.workingDir.split(/[\\/]/).pop() ?? wsState.workingDir;
    const isHashMismatch = /integrity check failed|file integrity/i.test(wsState.error);
    // Namespace mismatch: error contains "namespace 'Foo'"
    const affectedNs = wsState.error.match(/namespace '([^']+)'/)?.[1] ?? null;
    // Universe-file mismatch: error contains "Universe file 'universe/...'"
    const affectedUniverseFile = wsState.error.match(/Universe file '([^']+)'/)?.[1] ?? null;

    const handleRepair = async () => {
      setRepairResult(null);
      try {
        const result = await repairMutation.mutateAsync(wsState.workingDir);
        setRepairResult({ repaired: result.namespaces_repaired, unchanged: result.namespaces_unchanged, manifestUpdated: result.manifest_updated });
        openMutation.mutate(wsState.workingDir);
      } catch {
        // error shown via repairMutation.error
      }
    };

    return (
      <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>{folderName}</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 9px', borderRadius: 10,
            background: token.colorErrorBg,
            color: token.colorError,
            fontSize: 11, fontWeight: 600,
          }}>
            <WarningOutlined style={{ fontSize: 10 }} />
            Load failed
          </span>
        </div>
        <div style={{ fontSize: 11, color: token.colorTextTertiary, fontFamily: 'JetBrains Mono, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={wsState.workingDir}>
          {wsState.workingDir}
        </div>
        {isHashMismatch ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Alert
              type="warning"
              showIcon
              message="Manifest hash mismatch"
              description={
                <span style={{ fontSize: 11 }}>
                  The ria-data files have been modified since the last save and the manifest hashes are out of date.
                  {affectedUniverseFile && <> Affected universe file: <strong>{affectedUniverseFile}</strong>.</>}
                  {affectedNs && !affectedUniverseFile && <> Affected namespace: <strong>{affectedNs}</strong>.</>}
                  {' '}If you intentionally edited the JSON files, click <strong>Repair Manifest</strong> to recompute the hashes and reopen the workspace.
                </span>
              }
            />
            {repairMutation.error && (
              <Alert type="error" showIcon message="Repair failed" description={repairMutation.error.message} style={{ fontSize: 11 }} />
            )}
            {repairResult && (
              <Alert
                type="success"
                showIcon
                message={
                  repairResult.repaired.length > 0
                    ? `Repaired ${repairResult.repaired.length} namespace(s) — reopening workspace…`
                    : repairResult.manifestUpdated
                      ? 'Manifest hashes updated — reopening workspace…'
                      : 'Manifest already up to date — reopening workspace…'
                }
                description={
                  repairResult.repaired.length > 0
                    ? <span style={{ fontSize: 11 }}>Namespaces repaired: <strong>{repairResult.repaired.join(', ')}</strong></span>
                    : undefined
                }
                style={{ fontSize: 11 }}
              />
            )}
            <Button
              type="primary"
              icon={<ToolOutlined />}
              loading={repairMutation.isPending || openMutation.isPending}
              disabled={repairMutation.isPending || openMutation.isPending}
              onClick={() => void handleRepair()}
              size="small"
              style={{ alignSelf: 'flex-start' }}
            >
              Repair Manifest
            </Button>
          </div>
        ) : (
          <Alert
            type="error"
            showIcon
            message="Failed to load workspace from ria-data"
            description={<span style={{ fontSize: 11 }}>{wsState.error}</span>}
          />
        )}
      </div>
    );
  }

  // Handle loading_from_ria_data phase — show progress indicator
  if (wsState.phase === 'loading_from_ria_data') {
    const folderName = wsState.workingDir.split(/[\\/]/).pop() ?? wsState.workingDir;
    return (
      <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>{folderName}</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 9px', borderRadius: 10,
            background: token.colorWarningBg,
            color: token.colorWarning,
            fontSize: 11, fontWeight: 600,
          }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 10, color: token.colorWarning }} spin />} />
            Loading from ria-data…
          </span>
        </div>
        <div style={{ fontSize: 11, color: token.colorTextTertiary, fontFamily: 'JetBrains Mono, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={wsState.workingDir}>
          {wsState.workingDir}
        </div>
        <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
          Importing namespaces from ria-data into the database. This may take a moment for large workspaces.
        </div>
      </div>
    );
  }

  const dbStatus = wsStatus?.state === 'open' ? wsStatus.info.dbStatus : null;

  // Determine badge from phase — single source of truth
  type Badge = { label: string; color: string; bg: string; dot: string };
  const badge: Badge = (() => {
    switch (wsState.phase) {
      case 'db_open': {
        if (dbStatus?.migrationNeeded)
          return { label: 'Migration needed',      color: token.colorWarning,      bg: token.colorWarningBg,     dot: token.colorWarning };
        if (dbStatus?.readOnly)
          return { label: 'Read-only',             color: token.colorWarning,      bg: token.colorWarningBg,     dot: token.colorWarning };
        if (wsState.lifecycleWarning) {
          if (/file integrity check failed|files have been changed/i.test(wsState.lifecycleWarning))
            return { label: 'Files modified',        color: token.colorWarning,      bg: token.colorWarningBg,     dot: token.colorWarning };
          return { label: 'ria-data export failed',color: token.colorError,        bg: token.colorErrorBg,       dot: token.colorError };
        }
        if (dbStatus?.warning && dbStatus.warning !== 'false')
          return { label: 'Warning',               color: token.colorWarning,      bg: token.colorWarningBg,     dot: token.colorWarning };
        switch (wsState.lifecycleAction) {
          case 'created':                     return { label: 'New workspace',         color: token.colorSuccess, bg: token.colorSuccessBg, dot: token.colorSuccess };
          case 'opened_loaded_from_ria_data': return { label: 'Loaded from ria-data', color: token.colorSuccess, bg: token.colorSuccessBg, dot: token.colorSuccess };
          case 'opened_saved_to_ria_data':    return { label: 'Exported to ria-data', color: token.colorSuccess, bg: token.colorSuccessBg, dot: token.colorSuccess };
          default:                            return { label: 'In sync',              color: token.colorSuccess, bg: token.colorSuccessBg, dot: token.colorSuccess };
        }
      }
      case 'db_error':
        return { label: 'DB error',   color: token.colorError,        bg: token.colorErrorBg,       dot: token.colorError };
      case 'db_closed':
        return { label: 'DB closed',  color: token.colorTextTertiary, bg: token.colorFillSecondary, dot: token.colorTextQuaternary };
      default:
        return { label: 'Loading…',   color: token.colorWarning,      bg: token.colorWarningBg,     dot: token.colorWarning };
    }
  })();

  const folderName = wsState.workingDir.split(/[\\/]/).pop() ?? wsState.workingDir;

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Top row: folder name + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>
          {folderName}
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '2px 9px', borderRadius: 10,
          background: badge.bg,
          color: badge.color,
          fontSize: 11, fontWeight: 600, letterSpacing: '0.03em',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: badge.dot, display: 'inline-block' }} />
          {badge.label}
        </span>
      </div>

      {/* Full path — muted, monospace, truncated */}
      <div style={{
        fontSize: 11,
        color: token.colorTextTertiary,
        fontFamily: 'JetBrains Mono, Consolas, monospace',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} title={wsState.workingDir}>
        {wsState.workingDir}
      </div>

      {/* Detail grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 20,
        rowGap: 3,
        fontSize: 12,
      }}>
        {dbStatus?.path && (
          <>
            <span style={{ color: token.colorTextTertiary }}>DB file</span>
            <span style={{ color: token.colorText, fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={dbStatus.path}>
              {dbStatus.path.split(/[\\/]/).pop()}
            </span>
          </>
        )}
        {dbStatus?.schemaVersion && (
          <>
            <span style={{ color: token.colorTextTertiary }}>Schema</span>
            <span style={{ color: token.colorText }}>{dbStatus.schemaVersion}</span>
          </>
        )}
        {dbStatus?.expectedSchemaVersion && (
          <>
            <span style={{
              color: dbStatus.expectedSchemaVersion !== dbStatus.schemaVersion
                ? token.colorWarning : token.colorTextTertiary,
            }}>
              Expected schema
            </span>
            <span style={{
              color: dbStatus.expectedSchemaVersion !== dbStatus.schemaVersion ? token.colorWarning : token.colorText,
              fontWeight: dbStatus.expectedSchemaVersion !== dbStatus.schemaVersion ? 600 : 400,
            }}>
              {dbStatus.expectedSchemaVersion}
              {dbStatus.expectedSchemaVersion !== dbStatus.schemaVersion && ' ⚠'}
            </span>
          </>
        )}
        {dbStatus?.state === 'error' && dbStatus.error && (
          <>
            <span style={{ color: token.colorError }}>Error</span>
            <span style={{ color: token.colorError }}>{dbStatus.error}</span>
          </>
        )}
        {(wsState.phase === 'db_open' || wsState.phase === 'db_error') && wsState.lifecycleWarning && (
          /file integrity check failed|files have been changed/i.test(wsState.lifecycleWarning) ? (
            <>
              <span style={{ gridColumn: '1 / -1', color: token.colorWarning, fontSize: 11 }}>
                {wsState.lifecycleWarning}
              </span>
              <span style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, marginTop: 4 }}>
                <Button
                  type="primary"
                  icon={<ToolOutlined />}
                  loading={repairMutation.isPending || openMutation.isPending}
                  disabled={repairMutation.isPending || openMutation.isPending}
                  onClick={() => void handleRepairFromWarning()}
                  size="small"
                >
                  Repair Manifest
                </Button>
              </span>
              {repairMutation.error && (
                <span style={{ gridColumn: '1 / -1' }}>
                  <Alert type="error" showIcon message="Repair failed" description={repairMutation.error.message} style={{ fontSize: 11 }} />
                </span>
              )}
              {repairResult && (
                <span style={{ gridColumn: '1 / -1' }}>
                  <Alert
                    type="success"
                    showIcon
                    message={
                      repairResult.repaired.length > 0
                        ? `Repaired ${repairResult.repaired.length} namespace(s) — reopening workspace…`
                        : repairResult.manifestUpdated
                          ? 'Manifest hashes updated — reopening workspace…'
                          : 'Manifest already up to date — reopening workspace…'
                    }
                    description={
                      repairResult.repaired.length > 0
                        ? <span style={{ fontSize: 11 }}>Namespaces repaired: <strong>{repairResult.repaired.join(', ')}</strong></span>
                        : undefined
                    }
                    style={{ fontSize: 11 }}
                  />
                </span>
              )}
            </>
          ) : (
            <>
              <span style={{ color: token.colorWarning }}>Warning</span>
              <span style={{ color: token.colorWarning }}>{wsState.lifecycleWarning}</span>
            </>
          )
        )}
        {wsState.phase === 'db_open' && dbStatus?.warning && dbStatus.warning !== 'false' && (
          <>
            <span style={{ color: token.colorWarning }}>DB warning</span>
            <span style={{ color: token.colorWarning }}>{dbStatus.warning}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity tab — event log
// ---------------------------------------------------------------------------

function ActivityTab() {
  const { token } = useToken();
  const eventLog = useLifecycleHudStore((s) => s.eventLog);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [eventLog.length]);

  return (
    <div
      ref={logRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '6px 12px',
        fontFamily: 'JetBrains Mono, Consolas, monospace',
        fontSize: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {eventLog.length === 0 ? (
        <span style={{ color: token.colorTextTertiary, fontStyle: 'italic' }}>
          No activity yet — open a workspace to get started.
        </span>
      ) : (
        eventLog.map((entry, i) => (
          <div
            key={i}
            style={{
              color:
                entry.kind === 'error'   ? token.colorError :
                entry.kind === 'success' ? token.colorSuccess :
                token.colorTextSecondary,
              lineHeight: 1.6,
            }}
          >
            {entry.message}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded drawer
// ---------------------------------------------------------------------------

function ExpandedDrawer() {
  const { token } = useToken();
  const { height, setHeight, activeTab, setActiveTab, collapse } = useBottomPanelStore();
  const dragStartY = useRef<number | null>(null);
  const dragStartH = useRef<number>(height);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragStartY.current = e.clientY;
    dragStartH.current = height;
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (dragStartY.current === null) return;
      const delta = dragStartY.current - ev.clientY;
      setHeight(dragStartH.current + delta);
    };
    const onUp = () => {
      dragStartY.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height, setHeight]);

  const tabItems = [
    { key: 'state',    label: 'State',    children: <StateTab /> },
    { key: 'activity', label: 'Activity', children: <ActivityTab /> },
  ];

  return (
    <div
      style={{
        height,
        display: 'flex',
        flexDirection: 'column',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        style={{
          height: 4,
          cursor: 'row-resize',
          background: 'transparent',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = token.colorBorderSecondary; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
      />

      {/* Tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'state' | 'activity')}
        size="small"
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        tabBarStyle={{ marginBottom: 0, paddingLeft: 8, flexShrink: 0 }}
        tabBarExtraContent={{
          right: (
            <Button
              type="text"
              size="small"
              icon={<DownOutlined style={{ fontSize: 9 }} />}
              onClick={collapse}
              style={{ marginRight: 8, color: token.colorTextTertiary }}
              title="Collapse panel"
            />
          ),
        }}
        items={tabItems.map((t) => ({
          key: t.key,
          label: t.label,
          children: (
            <div style={{ height: height - 60, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              {t.children}
            </div>
          ),
        }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export function BottomPanel({ onOpenAppLogs, onOpenWorkspaceLogs }: StatusBarProps) {
  const expanded = useBottomPanelStore((s) => s.expanded);
  const { expand, setActiveTab, collapse } = useBottomPanelStore();

  useEffect(() => {
    _registerBottomPanelActions(
      expand,
      collapse,
      setActiveTab,
      () => useBottomPanelStore.getState().userCollapsed,
    );
  }, [expand, collapse, setActiveTab]);

  return (
    <>
      {expanded && <ExpandedDrawer />}
      <CollapsedBar onOpenAppLogs={onOpenAppLogs} onOpenWorkspaceLogs={onOpenWorkspaceLogs} />
    </>
  );
}
