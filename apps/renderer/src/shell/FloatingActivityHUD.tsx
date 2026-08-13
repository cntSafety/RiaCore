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
 * FloatingActivityHUD — activity card pinned bottom-right.
 *
 * Uses Ant Design theme tokens so it respects light/dark mode.
 *
 * Requirements: 14.1–14.15, 15.1–15.19, 16.5, 16.6, 16.8
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Progress, Button, Tooltip, theme } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  DownOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import {
  useLifecycleHudStore,
  type HudPhaseStep,
  type HudOperationStatus,
} from '../store/lifecycleHudStore';
import { api } from '../api/riacore';
import type { LoadProgressPushEvent } from '@riacore/app-contracts';
import { calculateProgressPercent } from './phaseSequences';
import { useWorkspaceState } from '../hooks/useWorkspaceState';

// Re-export for consumers (e.g. mutation hooks)
export { buildPhaseSequence, buildGenericPhases } from './phaseSequences';
export type { LifecycleAction } from './phaseSequences';

const { useToken } = theme;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Status dot color — these are semantic and stay the same in both themes. */
function statusColor(status: HudOperationStatus): string {
  switch (status) {
    case 'in_progress': return '#f59e0b'; // amber
    case 'success':     return '#22c55e'; // green
    case 'error':       return '#ef4444'; // red
    default:            return 'transparent';
  }
}

// ---------------------------------------------------------------------------
// StatusDot
// ---------------------------------------------------------------------------

function StatusDot({ status, size = 10 }: { status: HudOperationStatus; size?: number }) {
  const color = statusColor(status);
  const isPulsing = status === 'in_progress';
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink: 0,
        boxShadow: isPulsing ? `0 0 0 2px rgba(245,158,11,0.3)` : undefined,
        animation: isPulsing ? 'hud-pulse 1.5s ease-in-out infinite' : undefined,
      }}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// PhaseStepRow — uses theme tokens for label colors
// ---------------------------------------------------------------------------

function PhaseStepRow({ step }: { step: HudPhaseStep }) {
  const { token } = useToken();
  const isError  = step.status === 'error';
  const isDone   = step.status === 'done';
  const isActive = step.status === 'active';

  const labelColor = isError
    ? token.colorError
    : isDone
    ? token.colorSuccess
    : isActive
    ? token.colorText
    : token.colorTextTertiary;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ width: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {isDone   && <CheckCircleFilled  style={{ color: token.colorSuccess, fontSize: 13 }} />}
        {isError  && <CloseCircleFilled  style={{ color: token.colorError,   fontSize: 13 }} />}
        {isActive && <LoadingOutlined    style={{ color: '#f59e0b',           fontSize: 13 }} spin />}
        {step.status === 'pending' && (
          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: token.colorBorderSecondary, display: 'inline-block' }} />
        )}
      </span>

      <span style={{ fontSize: 12, color: labelColor, flexShrink: 0, minWidth: 80 }}>
        {step.label}
      </span>

      <div style={{ flex: 1, minWidth: 60 }}>
        {(isActive || isDone) && (
          <Progress
            percent={isDone ? 100 : step.progressPercent}
            size="small"
            showInfo={false}
            status={isError ? 'exception' : isDone ? 'success' : 'active'}
            strokeColor={isError ? token.colorError : isActive ? '#f59e0b' : token.colorSuccess}
            style={{ margin: 0 }}
          />
        )}
        {(step.status === 'pending' || step.status === 'error') && !isActive && !isDone && (
          <div style={{ height: 4, backgroundColor: token.colorFillSecondary, borderRadius: 2 }} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FloatingActivityHUD() {
  const { token } = useToken();

  const {
    visible,
    collapsed,
    status,
    title,
    startedAt,
    completedAt,
    phases,
    eventLog,
    workingDir,
    appendLogEntry,
    updatePhaseProgress,
    collapse,
    expand,
  } = useLifecycleHudStore();

  const wsPhase = useWorkspaceState();

  // -------------------------------------------------------------------------
  // React to external DB state changes (e.g. db file deleted on disk).
  // -------------------------------------------------------------------------
  const prevPhaseRef = useRef(wsPhase.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const curr = wsPhase.phase;
    prevPhaseRef.current = curr;

    // Detect transition from any open-DB phase to db_closed (file deleted externally)
    const wasDbOpen = prev === 'db_open';
    if (wasDbOpen && curr === 'db_closed') {
      const { completedAt: lastCompleted } = useLifecycleHudStore.getState();
      const msSinceOpen = lastCompleted !== null ? Date.now() - lastCompleted : Infinity;
      if (msSinceOpen < 6000) return; // race condition guard
      const ts = formatTimestamp(Date.now());
      const errorMsg = `${ts} · Database file not found on disk. Open workspace again to reload from ria-data.`;
      useLifecycleHudStore.setState((s) => ({
        visible: true,
        collapsed: false,
        userCollapsed: false,
        status: 'error',
        title: 'Database missing — ria-data still available',
        completedAt: Date.now(),
        phases: [
          { id: 'locate',  label: 'Locate',  status: 'done'  },
          { id: 'open_db', label: 'Open DB', status: 'error' },
        ],
        // Append to existing log so workspace open history is preserved
        eventLog: [
          ...s.eventLog,
          ...(s.eventLog.length > 0
            ? [{ timestamp: Date.now(), message: '─────────────────────────', kind: 'info' as const }]
            : []),
          { timestamp: Date.now(), message: errorMsg, kind: 'error' as const },
        ],
        workingDir: wsPhase.workingDir,
      }));
    }

    if (prev !== 'no_workspace' && curr === 'no_workspace') {
      useLifecycleHudStore.getState().reset();
    }
  }, [wsPhase.phase]);

  // -------------------------------------------------------------------------
  // Elapsed time ticker
  // -------------------------------------------------------------------------
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === 'in_progress' && startedAt !== null) {
      setElapsedMs(Date.now() - startedAt);
      tickerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt!), 1000);
    } else {
      if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
      if (completedAt !== null && startedAt !== null) setElapsedMs(completedAt - startedAt);
    }
    return () => { if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; } };
  }, [status, startedAt, completedAt]);

  // -------------------------------------------------------------------------
  // Event log auto-scroll
  // -------------------------------------------------------------------------
  const logPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logPanelRef.current) logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
  }, [eventLog.length]);

  // -------------------------------------------------------------------------
  // Load progress subscription
  // -------------------------------------------------------------------------
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const indeterminateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleProgressEvent = useCallback((event: LoadProgressPushEvent) => {
    if (indeterminateTimerRef.current) { clearTimeout(indeterminateTimerRef.current); indeterminateTimerRef.current = null; }
    const ts = formatTimestamp(Date.now());
    if (event.kind === 'namespace_start') {
      const total = event.totalNamespaces ?? '?';
      appendLogEntry({ timestamp: Date.now(), message: `${ts} · Loading namespace ${event.namespaceName} (${event.namespaceIndex} of ${total})`, kind: 'info' });
      const activeLoadPhase = useLifecycleHudStore.getState().phases.find(
        (p) => (p.id === 'load_ria_data' || p.id === 'reload_ria_data') && p.status === 'active',
      );
      if (activeLoadPhase && event.totalNamespaces && event.totalNamespaces > 0) {
        updatePhaseProgress(activeLoadPhase.id, calculateProgressPercent(event.namespaceIndex, event.totalNamespaces));
      }
    } else if (event.kind === 'namespace_done') {
      appendLogEntry({ timestamp: Date.now(), message: `${ts} ✓ ${event.namespaceName} · loaded`, kind: 'success' });
    }
  }, [appendLogEntry, updatePhaseProgress]);

  useEffect(() => {
    if (status === 'in_progress') {
      unsubscribeRef.current = api.persistor.onLoadProgress(handleProgressEvent);
      indeterminateTimerRef.current = setTimeout(() => {}, 2000);
    } else {
      unsubscribeRef.current?.(); unsubscribeRef.current = null;
      if (indeterminateTimerRef.current) { clearTimeout(indeterminateTimerRef.current); indeterminateTimerRef.current = null; }
    }
    return () => {
      unsubscribeRef.current?.(); unsubscribeRef.current = null;
      if (indeterminateTimerRef.current) { clearTimeout(indeterminateTimerRef.current); indeterminateTimerRef.current = null; }
    };
  }, [status, handleProgressEvent]);

  if (!visible) return null;

  const elapsedLabel = formatElapsed(elapsedMs);

  // Derived theme values
  const cardBg     = token.colorBgElevated;
  const cardBorder = token.colorBorderSecondary;
  const textPrimary    = token.colorText;
  const textSecondary  = token.colorTextSecondary;
  const textTertiary   = token.colorTextTertiary;
  const logBg      = token.colorFillQuaternary;
  const shadow     = token.boxShadowSecondary;

  // -------------------------------------------------------------------------
  // Pill state
  // -------------------------------------------------------------------------
  if (collapsed) {
    return (
      <>
        <style>{hudKeyframes}</style>
        <div
          role="button"
          tabIndex={0}
          aria-label="Expand activity HUD"
          onClick={expand}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') expand(); }}
          style={{
            position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
            display: 'flex', alignItems: 'center', gap: 8,
            backgroundColor: cardBg,
            border: `1px solid ${cardBorder}`,
            borderRadius: 20,
            padding: '6px 14px',
            boxShadow: shadow,
            cursor: 'pointer',
            maxWidth: 280,
            userSelect: 'none',
          }}
        >
          <StatusDot status={status} size={8} />
          <span style={{ fontSize: 12, color: textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          <span style={{ fontSize: 11, color: textTertiary, flexShrink: 0 }}>
            {elapsedLabel}
          </span>
        </div>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Expanded card state
  // -------------------------------------------------------------------------
  return (
    <>
      <style>{hudKeyframes}</style>
      <div
        role="region"
        aria-label="Workspace activity"
        style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
          width: 360,
          backgroundColor: cardBg,
          border: `1px solid ${cardBorder}`,
          borderRadius: token.borderRadiusLG,
          padding: '12px 14px',
          boxShadow: shadow,
          color: textPrimary,
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <StatusDot status={status} size={10} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          <span style={{ fontSize: 11, color: textTertiary, flexShrink: 0 }}>
            {elapsedLabel}
          </span>
          <Tooltip title="Collapse">
            <Button
              type="text"
              size="small"
              icon={<DownOutlined style={{ fontSize: 11 }} />}
              onClick={collapse}
              aria-label="Collapse HUD"
              style={{ color: textTertiary, padding: '0 4px', height: 20, minWidth: 20 }}
            />
          </Tooltip>
        </div>

        {/* Phase steps */}
        {phases.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {phases.map((step) => <PhaseStepRow key={step.id} step={step} />)}
          </div>
        )}

        {/* Event log */}
        <div
          ref={logPanelRef}
          aria-label="Event log"
          aria-live="polite"
          style={{
            maxHeight: 120, overflowY: 'auto',
            backgroundColor: logBg,
            borderRadius: token.borderRadius,
            padding: '6px 8px',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {eventLog.length === 0 ? (
            <span style={{ color: textTertiary, fontSize: 11, fontStyle: 'italic' }}>
              Waiting for events…
            </span>
          ) : (
            eventLog.map((entry, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  color: entry.kind === 'error' ? token.colorError : entry.kind === 'success' ? token.colorSuccess : textSecondary,
                  lineHeight: '1.5',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                {entry.message}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 11, color: textTertiary }}>
            {eventLog.length} {eventLog.length === 1 ? 'event' : 'events'}
          </span>
          {workingDir && (
            <Button
              type="link"
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => api.workspace.openLogsDirectory(workingDir)}
              style={{ fontSize: 11, padding: 0, height: 'auto' }}
            >
              Open log →
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

const hudKeyframes = `
  @keyframes hud-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.5; }
  }
`;
