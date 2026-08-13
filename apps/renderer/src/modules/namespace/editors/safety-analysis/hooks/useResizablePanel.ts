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
import { useState, useCallback, useEffect, useRef } from 'react';

export interface ResizablePanelConfig {
  default: number;
  min: number;
  max: number;
  storageKey: string;
  /**
   * When set, dragging the panel narrower than this many pixels collapses it
   * (hides it entirely). The panel can then be re-opened via `expand()`.
   */
  collapseThreshold?: number;
}

export interface ResizablePanelState {
  width: number;
  onMouseDown: (e: React.MouseEvent) => void;
  collapsed: boolean;
  collapse: () => void;
  expand: () => void;
  toggle: () => void;
}

export function useResizablePanel(config: ResizablePanelConfig): ResizablePanelState {
  const { min, max, storageKey, collapseThreshold } = config;

  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = Number(stored);
        if (!Number.isNaN(parsed)) return Math.min(max, Math.max(min, parsed));
      }
    } catch { /* ignore */ }
    return config.default;
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`${storageKey}:collapsed`) === '1';
    } catch { /* ignore */ }
    return false;
  });

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - startX.current;
    const raw = startWidth.current + delta;

    // Collapse when dragged below the threshold.
    if (collapseThreshold !== undefined && raw < collapseThreshold) {
      setCollapsed(true);
      return;
    }

    setCollapsed(false);
    const next = Math.min(max, Math.max(min, raw));
    setWidth(next);
  }, [min, max, collapseThreshold]);

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  // Persist width.
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(width)); } catch { /* ignore */ }
  }, [width, storageKey]);

  // Persist collapsed flag.
  useEffect(() => {
    try { localStorage.setItem(`${storageKey}:collapsed`, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed, storageKey]);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  const collapse = useCallback(() => setCollapsed(true), []);
  const expand = useCallback(() => setCollapsed(false), []);
  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  return { width, onMouseDown, collapsed, collapse, expand, toggle };
}
