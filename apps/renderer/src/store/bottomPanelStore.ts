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

interface BottomPanelState {
  expanded: boolean;
  height: number; // px, only relevant when expanded
  activeTab: 'state' | 'activity';
  /** True when the user explicitly collapsed the panel. Prevents logActivity
   *  from re-expanding it until the user opens it again themselves. */
  userCollapsed: boolean;
}

interface BottomPanelActions {
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
  setHeight: (h: number) => void;
  setActiveTab: (tab: BottomPanelState['activeTab']) => void;
}

type BottomPanelStore = BottomPanelState & BottomPanelActions;

export const useBottomPanelStore = create<BottomPanelStore>((set) => ({
  expanded: false,
  height: 220,
  activeTab: 'activity',
  userCollapsed: false,

  toggle:   () => set((s) => ({ expanded: !s.expanded, userCollapsed: s.expanded })),
  expand:   () => set({ expanded: true, userCollapsed: false }),
  collapse: () => set({ expanded: false, userCollapsed: true }),
  setHeight: (h) => set({ height: Math.max(120, Math.min(h, 600)) }),
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
