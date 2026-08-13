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
 * Auto_Save Save_Status store (canvas-layout-auto-save).
 *
 * Holds the user-visible Save_Status of the Overview_Canvas Auto_Save. This is
 * transient UI state derived from the Auto_Save_Coordinator's lifecycle, so it
 * lives in Zustand (not TanStack Query), per the RIACore UI data architecture.
 *
 * The coordinator writes Save_Status at each transition; the canvas subscribes
 * to render the indicator. `reset()` returns the store to `idle` with a cleared
 * error and is called on workspace open/switch (Req 9.5).
 *
 * Requirements: 9.5
 */
import { create } from 'zustand';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

interface AutoSaveStatusStore {
  status: SaveStatus;
  lastError: string | null;
  /**
   * Set the current Save_Status. When `error` is provided it is stored as
   * `lastError`; when omitted (or null) the stored error is cleared.
   */
  setStatus: (s: SaveStatus, error?: string | null) => void;
  /** Return to `idle` with a cleared error. Called on workspace open. */
  reset: () => void;
}

export const useAutoSaveStatusStore = create<AutoSaveStatusStore>((set) => ({
  status: 'idle',
  lastError: null,

  setStatus: (s, error) => set({ status: s, lastError: error ?? null }),

  reset: () => set({ status: 'idle', lastError: null }),
}));
