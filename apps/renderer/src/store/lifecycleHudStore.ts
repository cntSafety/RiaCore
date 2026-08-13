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
import { create } from 'zustand';

// Lazy import to avoid circular dependency — bottomPanelStore imports nothing from here
let _expandBottomPanel: (() => void) | null = null;
let _collapseBottomPanel: (() => void) | null = null;
let _setBottomPanelTab: ((tab: 'state' | 'activity') => void) | null = null;
let _isBottomPanelUserCollapsed: (() => boolean) | null = null;
export function _registerBottomPanelActions(
  expand: () => void,
  _collapse: () => void,
  setTab: (tab: 'state' | 'activity') => void,
  isUserCollapsed?: () => boolean,
) {
  _expandBottomPanel = expand;
  _collapseBottomPanel = _collapse;
  _setBottomPanelTab = setTab;
  _isBottomPanelUserCollapsed = isUserCollapsed ?? null;
}

export type HudPhaseStep = {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  progressPercent?: number; // 0-100, undefined = indeterminate
};

export type HudOperationStatus = 'idle' | 'in_progress' | 'success' | 'error';

export interface HudLogEntry {
  timestamp: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

interface LifecycleHudState {
  visible: boolean;
  collapsed: boolean;       // pill vs expanded card
  /** True when the user explicitly clicked the collapse chevron. Prevents
   *  logActivity and auto-collapse from re-expanding the HUD until the next
   *  workspace open/create operation resets it. */
  userCollapsed: boolean;
  status: HudOperationStatus;
  title: string;
  startedAt: number | null; // Date.now() when operation started
  completedAt: number | null;
  phases: HudPhaseStep[];
  eventLog: HudLogEntry[];
  workingDir: string | null;
}

interface LifecycleHudActions {
  /**
   * Begin a new lifecycle operation. Always re-expands the HUD (resets
   * userCollapsed) so the user sees progress for the new operation.
   */
  startOperation: (title: string, phases: HudPhaseStep[], workingDir: string) => void;

  advancePhase: (phaseId: string) => void;
  updatePhaseProgress: (phaseId: string, percent: number) => void;
  appendLogEntry: (entry: HudLogEntry) => void;

  /**
   * Mark the operation as successful. Auto-collapses after 3 seconds unless
   * the user has already manually collapsed the HUD.
   */
  completeOperation: () => void;

  /**
   * Mark the operation as failed. Does NOT auto-collapse.
   */
  failOperation: (phaseId: string, errorMsg: string) => void;

  /** User explicitly collapsed the HUD — sets userCollapsed=true so it stays
   *  collapsed until the next workspace operation. */
  collapse: () => void;

  /** User explicitly expanded the HUD — clears userCollapsed. */
  expand: () => void;

  reset: () => void;

  /**
   * Append a timestamped activity entry to the event log (Save, auto-save).
   * Makes the HUD visible but respects userCollapsed — if the user already
   * collapsed it, the entry is added silently without re-expanding.
   */
  logActivity: (message: string, kind: HudLogEntry['kind'], workingDir?: string) => void;
}

type LifecycleHudStore = LifecycleHudState & LifecycleHudActions;

const initialState: LifecycleHudState = {
  visible: false,
  collapsed: false,
  userCollapsed: false,
  status: 'idle',
  title: '',
  startedAt: null,
  completedAt: null,
  phases: [],
  eventLog: [],
  workingDir: null,
};

export const useLifecycleHudStore = create<LifecycleHudStore>((set, get) => ({
  ...initialState,

  startOperation: (title, phases, workingDir) => {
    // Always re-expand on a new operation — this is the intentional interrupt.
    // Preserve the existing event log and append a separator so the user can
    // see the history of all operations in one scrollable log.
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    set((s) => ({
      visible: true,
      collapsed: false,
      userCollapsed: false,
      status: 'in_progress',
      title,
      startedAt: Date.now(),
      completedAt: null,
      phases,
      workingDir,
      // Keep existing log, append a divider + start entry
      eventLog: [
        ...s.eventLog,
        ...(s.eventLog.length > 0
          ? [{ timestamp: Date.now(), message: '─────────────────────────', kind: 'info' as const }]
          : []),
        { timestamp: Date.now(), message: `${ts} · ${title}`, kind: 'info' as const },
      ],
    }));
    // Do not change bottom panel visibility or active tab automatically.
    // Respect the user's explicit visibility preference — only user actions
    // should expand/collapse or change the active tab of the bottom panel.
  },

  advancePhase: (phaseId) => {
    set((s) => {
      const afterDone = s.phases.map((p) =>
        p.id === phaseId ? { ...p, status: 'done' as const } : p,
      );
      const doneIndex = afterDone.findIndex((p) => p.id === phaseId);
      let activatedNext = false;
      const updatedPhases = afterDone.map((p, i) => {
        if (i > doneIndex && p.status === 'pending' && !activatedNext) {
          activatedNext = true;
          return { ...p, status: 'active' as const };
        }
        return p;
      });
      return { phases: updatedPhases };
    });
  },

  updatePhaseProgress: (phaseId, percent) => {
    set((s) => ({
      phases: s.phases.map((p) =>
        p.id === phaseId ? { ...p, progressPercent: percent } : p,
      ),
    }));
  },

  appendLogEntry: (entry) => {
    set((s) => ({ eventLog: [...s.eventLog, entry] }));
  },

  completeOperation: () => {
    const completedAt = Date.now();
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    set((s) => ({
      status: 'success',
      completedAt,
      phases: s.phases.map((p) => ({ ...p, status: 'done' as const })),
      eventLog: [
        ...s.eventLog,
        { timestamp: completedAt, message: `${ts} ✓ ${s.title}`, kind: 'success' as const },
      ],
    }));
  },

  failOperation: (phaseId, errorMsg) => {
    set((s) => ({
      status: 'error',
      phases: s.phases.map((p) =>
        p.id === phaseId ? { ...p, status: 'error' as const } : p,
      ),
      eventLog: [
        ...s.eventLog,
        { timestamp: Date.now(), message: errorMsg, kind: 'error' as const },
      ],
    }));
  },

  collapse: () => set({ collapsed: true, userCollapsed: true }),

  expand: () => set({ collapsed: false, userCollapsed: false }),

  reset: () => set({ ...initialState }),

  logActivity: (msg, kind, workingDir) => {
    set((s) => ({
      visible: true,
      // Respect the user's collapse preference — don't re-expand if they
      // already dismissed the HUD. The entry is still appended to the log.
      collapsed: s.userCollapsed ? true : s.collapsed,
      workingDir: workingDir ?? s.workingDir,
      eventLog: [
        ...s.eventLog,
        { timestamp: Date.now(), message: msg, kind },
      ],
    }));
    // Do not auto-expand or switch tabs when logging activity. Just append
    // the entry to the event log and leave the bottom panel's visibility
    // and active tab unchanged so that only explicit user actions control
    // the bottom panel state.
  },
}));
