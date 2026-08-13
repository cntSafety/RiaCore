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
 * ResizableColumnsHeader — a lightweight, dependency-free resizable column header
 * for the CSS-grid based MalfunctionTableView.
 *
 * The MalfunctionTableView is not an antd `<Table>` — it is a grid of
 * `MalfunctionTableRow` divs driven by a shared `gridTemplateColumns` string.
 * The standard antd resizable recipe (react-resizable + `components.header.cell`)
 * is built around `<Table>` and does not apply here, so we implement the same
 * underlying drag mechanic (pointerdown → pointermove → pointerup) directly on
 * the grid header and lift the resulting widths into state.
 *
 * Usage:
 *   const { widths, gridTemplateColumns, totalMinWidth, startResize } =
 *     useResizableColumns(COLUMNS, storageKey);
 *   <ResizableColumnsHeader columns={COLUMNS} widths={widths} startResize={startResize} />
 *   <MalfunctionTableRow gridTemplateColumns={gridTemplateColumns} ... />
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from 'antd';

// ---------------------------------------------------------------------------
// Column model
// ---------------------------------------------------------------------------

export interface ResizableColumn {
  /** Stable identifier used as the width map key. */
  key: string;
  /** Header label. */
  title: string;
  /** Minimum width in px the column may be dragged to. */
  min: number;
  /** Initial width in px. */
  default: number;
}

export interface UseResizableColumnsResult {
  /** Current width per column key, in px. */
  widths: Record<string, number>;
  /** `gridTemplateColumns` string: each column width in px + trailing `auto` (actions). */
  gridTemplateColumns: string;
  /** Sum of all column widths (+ a fixed allowance for the auto actions column). */
  totalMinWidth: number;
  /** Begin a drag on the given column's right edge. */
  startResize: (key: string, clientX: number) => void;
}

/** Width reserved for the trailing `auto` Actions column when computing min table width. */
const ACTIONS_ALLOWANCE = 240;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useResizableColumns(
  columns: ResizableColumn[],
  storageKey?: string,
): UseResizableColumnsResult {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const base: Record<string, number> = {};
    for (const col of columns) base[col.key] = col.default;
    if (storageKey) {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, number>;
          for (const col of columns) {
            if (typeof saved[col.key] === 'number') {
              base[col.key] = Math.max(col.min, saved[col.key]);
            }
          }
        }
      } catch {
        // Ignore malformed/unavailable storage — fall back to defaults.
      }
    }
    return base;
  });

  // Persist on change (debounced via effect, not per-pixel write).
  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Storage may be unavailable (private mode, quota) — non-fatal.
    }
  }, [storageKey, widths]);

  // Active drag bookkeeping kept in refs so listeners stay stable.
  const dragRef = useRef<{ key: string; startX: number; startWidth: number; min: number } | null>(null);

  const startResize = useCallback(
    (key: string, clientX: number) => {
      const col = columns.find((c) => c.key === key);
      if (!col) return;
      dragRef.current = { key, startX: clientX, startWidth: widths[key] ?? col.default, min: col.min };

      const handleMove = (e: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = Math.max(drag.min, drag.startWidth + (e.clientX - drag.startX));
        setWidths((prev) => (prev[drag.key] === next ? prev : { ...prev, [drag.key]: next }));
      };

      const handleUp = () => {
        dragRef.current = null;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };

      // Prevent text selection / change cursor for the duration of the drag.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
    },
    [columns, widths],
  );

  const gridTemplateColumns = `${columns.map((c) => `${widths[c.key] ?? c.default}px`).join(' ')} auto`;
  const totalMinWidth =
    columns.reduce((sum, c) => sum + (widths[c.key] ?? c.default), 0) + ACTIONS_ALLOWANCE;

  return { widths, gridTemplateColumns, totalMinWidth, startResize };
}

// ---------------------------------------------------------------------------
// Header component
// ---------------------------------------------------------------------------

export interface ResizableColumnsHeaderProps {
  columns: ResizableColumn[];
  widths: Record<string, number>;
  startResize: (key: string, clientX: number) => void;
  /** Label for the trailing (non-resizable) actions column. */
  actionsLabel?: string;
}

export function ResizableColumnsHeader({
  columns,
  widths,
  startResize,
  actionsLabel = 'Actions',
}: ResizableColumnsHeaderProps) {
  const { token } = theme.useToken();

  const gridTemplateColumns = `${columns.map((c) => `${widths[c.key] ?? c.default}px`).join(' ')} auto`;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns,
        position: 'sticky',
        top: 0,
        zIndex: 2,
        // Opaque background so scrolled rows don't show through the sticky header.
        background: token.colorBgElevated,
        boxShadow: `0 1px 0 ${token.colorBorder}`,
        borderBottom: `1px solid ${token.colorBorder}`,
        fontSize: 12,
        fontWeight: 600,
        color: token.colorTextSecondary,
        userSelect: 'none',
      }}
    >
      {columns.map((col) => (
        <div
          key={col.key}
          style={{
            position: 'relative',
            padding: '8px 12px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {col.title}
          {/* Drag handle on the right edge of the cell. */}
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${col.title} column`}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startResize(col.key, e.clientX);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 8,
              height: '100%',
              cursor: 'col-resize',
              // A thin visible line on the inner edge of the grip area.
              borderRight: `2px solid transparent`,
              touchAction: 'none',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLSpanElement).style.borderRight = `2px solid ${token.colorPrimary}`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLSpanElement).style.borderRight = '2px solid transparent';
            }}
          />
        </div>
      ))}
      {/* Trailing actions column header (not resizable). */}
      <div style={{ padding: '8px 12px' }}>{actionsLabel}</div>
    </div>
  );
}
