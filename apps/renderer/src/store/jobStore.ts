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

export type JobStatus = 'running' | 'done' | 'error' | 'idle';

export interface Job {
  id: string;
  type: 'import' | 'export';
  label: string;
  status: JobStatus;
  progress?: number;      // 0–100
  phase?: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

interface JobStore {
  jobs: Job[];
  addJob: (job: Job) => void;
  updateJob: (id: string, patch: Partial<Job>) => void;
  clearCompleted: () => void;
  /** Reset all jobs on workspace switch. */
  resetAll: () => void;
}

export const useJobStore = create<JobStore>((set) => ({
  jobs: [],

  addJob: (job) => set((s) => ({ jobs: [job, ...s.jobs] })),

  updateJob: (id, patch) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    })),

  clearCompleted: () =>
    set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'running') })),

  resetAll: () => set({ jobs: [] }),
}));
