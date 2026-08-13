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
 * Spawn-window navigation store.
 *
 * Holds the pending NavigationRequest received from the main process via
 * `window.showInTree.dispatch`. SafetyAnalysisSpawnApp reads from this store
 * to know which namespace/node to navigate to.
 *
 * Requirements: 6.1, 6.2, 6.3
 */
import { create } from 'zustand';
import type { NavigationRequest } from '@riacore/app-contracts';

interface SpawnNavState {
  pending: NavigationRequest | null;
  /** Enqueue a navigation request (replaces any existing pending request). */
  enqueue: (req: NavigationRequest) => void;
  /** Consume and clear the pending request. Returns null if none. */
  consume: () => NavigationRequest | null;
}

export const useSpawnNavStore = create<SpawnNavState>((set, get) => ({
  pending: null,

  enqueue: (req: NavigationRequest) => {
    set({ pending: req });
  },

  consume: () => {
    const { pending } = get();
    if (pending !== null) {
      set({ pending: null });
    }
    return pending;
  },
}));

/** Imperative accessor for use outside React components. */
export const spawnNavStore = {
  enqueue: (req: NavigationRequest) => useSpawnNavStore.getState().enqueue(req),
  consume: () => useSpawnNavStore.getState().consume(),
};
