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
 * SaveStatusIndicator (canvas-layout-auto-save, task 9.2).
 *
 * A small, low-key text indicator that subscribes to `useAutoSaveStatusStore`
 * and reports the current Auto_Save Save_Status (idle / pending / saving /
 * saved / failed). It lives in the app footer (`BottomPanel`'s collapsed
 * status bar) alongside the other workspace status chips, rather than as a
 * prominent overlay on the canvas — the transition from "Unsaved changes" to
 * "Saved changes" is the only feedback most users need. The store is written
 * by the Auto_Save_Coordinator at each lifecycle transition, so this
 * component re-renders within the 500 ms budget of Req 9.1–9.6 as soon as the
 * status changes.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */
import { theme, Tooltip } from 'antd';
import { useAutoSaveStatusStore, type SaveStatus } from '../store/autoSaveStatusStore';

const { useToken } = theme;

function displayFor(status: SaveStatus, token: ReturnType<typeof useToken>['token']): { label: string; color: string } | null {
  switch (status) {
    case 'pending':
      return { label: 'Unsaved changes', color: token.colorTextTertiary };
    case 'saving':
      return { label: 'Saving…', color: token.colorTextTertiary };
    case 'saved':
      return { label: 'Saved changes', color: token.colorSuccess };
    case 'failed':
      return { label: 'Auto-save failed', color: token.colorError };
    case 'idle':
    default:
      // Nothing to report yet — no canvas mutation has happened this session.
      return null;
  }
}

export function SaveStatusIndicator() {
  const { token } = useToken();
  const status = useAutoSaveStatusStore((s) => s.status);
  const lastError = useAutoSaveStatusStore((s) => s.lastError);
  const display = displayFor(status, token);

  if (!display) return null;
  const { label, color } = display;

  const content = (
    <span
      data-testid="save-status-indicator"
      data-status={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color,
      }}
    >
      <span aria-hidden style={{ fontSize: 9 }}>●</span>
      {label}
    </span>
  );

  return status === 'failed' && lastError ? (
    <Tooltip title={lastError}>{content}</Tooltip>
  ) : (
    content
  );
}
