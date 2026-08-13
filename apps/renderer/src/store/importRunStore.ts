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
import { useJobStore } from './jobStore.js';

const MIN_VISUAL_RUN_MS = 1200;
const finishTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface ActiveRun {
  sourceId: string;
  sourceName: string;
  startedAt: number;
  jobId: string;
}

interface ImportRunStore {
  activeRuns: Map<string, ActiveRun>;

  startRun: (sourceId: string, sourceName: string) => void;
  endRun: (sourceId: string, outcome: 'done' | 'error', error?: string) => void;
  isRunning: (sourceId: string) => boolean;
  hasAnyRunning: () => boolean;
  reset: () => void;
}

export const useImportRunStore = create<ImportRunStore>((set, get) => ({
  activeRuns: new Map(),

  startRun: (sourceId, sourceName) => {
    const existingTimer = finishTimers.get(sourceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      finishTimers.delete(sourceId);
    }

    const startedAt = Date.now();
    const jobId = `import-${sourceId}-${startedAt}`;

    // Register in jobStore for status bar / job panel
    useJobStore.getState().addJob({
      id: jobId,
      type: 'import',
      label: `Import: ${sourceName}`,
      status: 'running',
      startedAt,
    });

    set((s) => {
      const next = new Map(s.activeRuns);
      next.set(sourceId, { sourceId, sourceName, startedAt, jobId });
      return { activeRuns: next };
    });
  },

  endRun: (sourceId, outcome, error) => {
    const run = get().activeRuns.get(sourceId);
    if (!run) return;

    const finish = () => {
      useJobStore.getState().updateJob(run.jobId, {
        status: outcome,
        endedAt: Date.now(),
        error,
      });

      set((s) => {
        const next = new Map(s.activeRuns);
        next.delete(sourceId);
        return { activeRuns: next };
      });

      finishTimers.delete(sourceId);
    };

    const elapsed = Date.now() - run.startedAt;
    const remaining = Math.max(0, MIN_VISUAL_RUN_MS - elapsed);

    if (remaining === 0) {
      finish();
      return;
    }

    const timer = setTimeout(finish, remaining);
    finishTimers.set(sourceId, timer);
  },

  isRunning: (sourceId) => get().activeRuns.has(sourceId),

  hasAnyRunning: () => get().activeRuns.size > 0,

  reset: () => {
    for (const timer of finishTimers.values()) {
      clearTimeout(timer);
    }
    finishTimers.clear();
    set({ activeRuns: new Map() });
  },
}));
