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
import { useCallback, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Tree Navigation History Hook
//
// Tracks the last N tree selections in a circular buffer with a cursor.
// Back/Forward move the cursor without pushing new entries.
// A new selection while the cursor is not at the end discards forward history.
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  nodeId: number;
  namespace: string;
  concept: string;
  name?: string;
  /** The tree key that was selected. For reference nodes this differs from `${namespace}:${nodeId}`. */
  treeKey?: string;
  /** For reference nodes: the host node where the reference appears. */
  hostNodeId?: number;
  /** For reference nodes: the host namespace where the reference appears. */
  hostNamespace?: string;
}

export interface TreeNavHistory {
  /** Push a new selection onto the history stack. */
  push(entry: HistoryEntry): void;
  /** Navigate back. Returns the entry to navigate to, or null if at the start. */
  back(): HistoryEntry | null;
  /** Navigate forward. Returns the entry to navigate to, or null if at the end. */
  forward(): HistoryEntry | null;
  /** Navigate to a specific index in the stack. Returns the entry, or null if invalid. */
  goTo(index: number): HistoryEntry | null;
  /** Update the name of all history entries matching the given nodeId + namespace. */
  rename(nodeId: number, namespace: string, name: string): void;
  /** Clear all history entries. */
  clear(): void;
  /** Whether back navigation is available. */
  canGoBack: boolean;
  /** Whether forward navigation is available. */
  canGoForward: boolean;
  /** Whether the current navigation is a history traversal (back/forward). Resets after each push. */
  isHistoryNavigation: boolean;
  /** Current stack entries (read-only snapshot). */
  entries: readonly HistoryEntry[];
  /** Current cursor position (0-based). -1 if empty. */
  cursor: number;
}

/**
 * Hook that manages a navigation history stack for tree selections.
 * @param maxSize Maximum number of entries to keep (default 10).
 * @param initialEntries Optional pre-populated entries (e.g. restored from persisted state).
 * @param initialCursor Optional cursor position within initialEntries (-1 if empty).
 */
export function useTreeNavigationHistory(
  maxSize = 10,
  initialEntries?: HistoryEntry[],
  initialCursor?: number,
): TreeNavHistory {
  // Use a ref for the stack to avoid re-renders on every push.
  // We only trigger re-renders when canGoBack/canGoForward changes.
  const stackRef = useRef<HistoryEntry[]>(initialEntries ?? []);
  const cursorRef = useRef(initialCursor ?? (initialEntries ? initialEntries.length - 1 : -1));
  const isHistoryNavRef = useRef(false);

  // These state values drive button enabled/disabled states.
  const [canGoBack, setCanGoBack] = useState(cursorRef.current > 0);
  const [canGoForward, setCanGoForward] = useState(cursorRef.current < stackRef.current.length - 1);

  const updateButtonStates = useCallback(() => {
    setCanGoBack(cursorRef.current > 0);
    setCanGoForward(cursorRef.current < stackRef.current.length - 1);
  }, []);

  const push = useCallback((entry: HistoryEntry) => {
    // If this push is happening as a result of a history navigation, skip it.
    if (isHistoryNavRef.current) {
      isHistoryNavRef.current = false;
      return;
    }

    const stack = stackRef.current;

    // Deduplicate: don't push if the entry is identical to the last entry
    if (stack.length > 0) {
      const last = stack[stack.length - 1];
      if (
        last.nodeId === entry.nodeId &&
        last.namespace === entry.namespace &&
        last.treeKey === entry.treeKey
      ) {
        // Just move cursor to the end
        cursorRef.current = stack.length - 1;
        updateButtonStates();
        return;
      }
    }

    // Always append — never discard forward history (log-style)
    stack.push(entry);

    // Trim to maxSize (drop oldest entries)
    if (stack.length > maxSize) {
      stackRef.current = stack.slice(stack.length - maxSize);
    }

    // Move cursor to the end
    cursorRef.current = stackRef.current.length - 1;
    updateButtonStates();
  }, [maxSize, updateButtonStates]);

  const back = useCallback((): HistoryEntry | null => {
    if (cursorRef.current <= 0) return null;
    cursorRef.current -= 1;
    isHistoryNavRef.current = true;
    updateButtonStates();
    return stackRef.current[cursorRef.current];
  }, [updateButtonStates]);

  const forward = useCallback((): HistoryEntry | null => {
    if (cursorRef.current >= stackRef.current.length - 1) return null;
    cursorRef.current += 1;
    isHistoryNavRef.current = true;
    updateButtonStates();
    return stackRef.current[cursorRef.current];
  }, [updateButtonStates]);

  const goTo = useCallback((index: number): HistoryEntry | null => {
    if (index < 0 || index >= stackRef.current.length || index === cursorRef.current) return null;
    cursorRef.current = index;
    isHistoryNavRef.current = true;
    updateButtonStates();
    return stackRef.current[cursorRef.current];
  }, [updateButtonStates]);

  const rename = useCallback((nodeId: number, namespace: string, name: string) => {
    const stack = stackRef.current;
    for (let i = 0; i < stack.length; i++) {
      if (stack[i].nodeId === nodeId && stack[i].namespace === namespace) {
        stack[i] = { ...stack[i], name };
      }
    }
  }, []);

  const clear = useCallback(() => {
    stackRef.current = [];
    cursorRef.current = -1;
    updateButtonStates();
  }, [updateButtonStates]);

  return {
    push,
    back,
    forward,
    goTo,
    rename,
    clear,
    canGoBack,
    canGoForward,
    get isHistoryNavigation() { return isHistoryNavRef.current; },
    get entries() { return stackRef.current as readonly HistoryEntry[]; },
    get cursor() { return cursorRef.current; },
  };
}
