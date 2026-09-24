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
 * Zustand store for the Diff and Merge view.
 *
 * Manages:
 *  - Namespace selector state (two-way vs three-way mode)
 *  - Active diff summary (returned from computeNamespaces / computeThreeWay)
 *  - Selected section + filter state for paginated result browsing
 *  - Merge selection (cherry-pick by stableId)
 *  - Conflict resolutions (for three-way merges)
 */

import { create } from 'zustand';
import type {
  DiffSummary,
  DiffResultSection,
  ThreeWayDiffSummary,
  ConflictResolution,
} from '@riacore/app-contracts';

// ── Mode ──────────────────────────────────────────────────────────────────────

export type DiffMode = 'two-way' | 'three-way';

// ── Store ─────────────────────────────────────────────────────────────────────

interface DiffStore {
  // Mode toggle
  mode: DiffMode;

  // Namespace selector inputs
  leftNs: string;
  rightNs: string;
  baseNs: string; // only for three-way mode

  // Active computed summary
  activeSummary: DiffSummary | null;
  activeThreeWaySummary: ThreeWayDiffSummary | null;

  // Result browsing state
  selectedSection: DiffResultSection;
  pageOffset: number;
  pageSize: number;

  // Filter state
  filterText: string;
  filterConceptType: string;
  filterRelationshipType: string;

  // Merge selection (set of stableIds to apply; empty = apply all)
  selectedChangeIds: Set<string>;
  mergeDirection: 'left-into-right' | 'right-into-left';

  // Three-way conflict resolutions
  conflictResolutions: ConflictResolution[];

  // Actions
  setMode: (mode: DiffMode) => void;
  setLeftNs: (ns: string) => void;
  setRightNs: (ns: string) => void;
  setBaseNs: (ns: string) => void;
  setActiveSummary: (summary: DiffSummary | null) => void;
  setActiveThreeWaySummary: (summary: ThreeWayDiffSummary | null) => void;
  setSelectedSection: (section: DiffResultSection) => void;
  setPageOffset: (offset: number) => void;
  setFilterText: (text: string) => void;
  setFilterConceptType: (type: string) => void;
  setFilterRelationshipType: (type: string) => void;
  toggleChangeSelection: (stableId: string) => void;
  selectAllChanges: (stableIds: string[]) => void;
  deselectAllChanges: () => void;
  setMergeDirection: (dir: 'left-into-right' | 'right-into-left') => void;
  setConflictResolution: (resolution: ConflictResolution) => void;
  clearConflictResolutions: () => void;
  reset: () => void;
}

const DEFAULT_PAGE_SIZE = 50;

export const useDiffStore = create<DiffStore>((set) => ({
  mode: 'two-way',
  leftNs: '',
  rightNs: '',
  baseNs: '',
  activeSummary: null,
  activeThreeWaySummary: null,
  selectedSection: 'addedNodes',
  pageOffset: 0,
  pageSize: DEFAULT_PAGE_SIZE,
  filterText: '',
  filterConceptType: '',
  filterRelationshipType: '',
  selectedChangeIds: new Set(),
  mergeDirection: 'left-into-right',
  conflictResolutions: [],

  setMode: (mode) => set({ mode, activeSummary: null, activeThreeWaySummary: null }),
  setLeftNs: (leftNs) => set({ leftNs }),
  setRightNs: (rightNs) => set({ rightNs }),
  setBaseNs: (baseNs) => set({ baseNs }),

  setActiveSummary: (activeSummary) => {
    // Default to the first section that has changes, so the list isn't empty on open
    let selectedSection: DiffResultSection = 'addedNodes';
    if (activeSummary) {
      const sectionOrder: { key: DiffResultSection; count: number }[] = [
        { key: 'modifiedNodes',       count: activeSummary.modifiedNodesCount },
        { key: 'addedNodes',          count: activeSummary.addedNodesCount },
        { key: 'deletedNodes',        count: activeSummary.deletedNodesCount },
        { key: 'modifiedEdges',       count: activeSummary.modifiedEdgesCount },
        { key: 'addedEdges',          count: activeSummary.addedEdgesCount },
        { key: 'deletedEdges',        count: activeSummary.deletedEdgesCount },
        { key: 'modifiedCrossNsEdges', count: activeSummary.modifiedCrossNsEdgesCount },
        { key: 'addedCrossNsEdges',   count: activeSummary.addedCrossNsEdgesCount },
        { key: 'deletedCrossNsEdges', count: activeSummary.deletedCrossNsEdgesCount },
      ];
      const firstNonEmpty = sectionOrder.find(s => s.count > 0);
      if (firstNonEmpty) selectedSection = firstNonEmpty.key;
    }
    set({ activeSummary, pageOffset: 0, selectedSection, selectedChangeIds: new Set() });
  },

  setActiveThreeWaySummary: (activeThreeWaySummary) =>
    set({ activeThreeWaySummary, pageOffset: 0, conflictResolutions: [] }),

  setSelectedSection: (selectedSection) => set({ selectedSection, pageOffset: 0 }),
  setPageOffset: (pageOffset) => set({ pageOffset }),

  setFilterText: (filterText) => set({ filterText, pageOffset: 0 }),
  setFilterConceptType: (filterConceptType) => set({ filterConceptType, pageOffset: 0 }),
  setFilterRelationshipType: (filterRelationshipType) => set({ filterRelationshipType, pageOffset: 0 }),

  toggleChangeSelection: (stableId) =>
    set((state) => {
      const next = new Set(state.selectedChangeIds);
      if (next.has(stableId)) {
        next.delete(stableId);
      } else {
        next.add(stableId);
      }
      return { selectedChangeIds: next };
    }),

  selectAllChanges: (stableIds) =>
    set({ selectedChangeIds: new Set(stableIds) }),

  deselectAllChanges: () =>
    set({ selectedChangeIds: new Set() }),

  setMergeDirection: (mergeDirection) => set({ mergeDirection }),

  setConflictResolution: (resolution) =>
    set((state) => {
      const existing = state.conflictResolutions.filter(r => r.stableId !== resolution.stableId);
      return { conflictResolutions: [...existing, resolution] };
    }),

  clearConflictResolutions: () => set({ conflictResolutions: [] }),

  reset: () =>
    set({
      activeSummary: null,
      activeThreeWaySummary: null,
      pageOffset: 0,
      filterText: '',
      filterConceptType: '',
      filterRelationshipType: '',
      selectedChangeIds: new Set(),
      conflictResolutions: [],
    }),
}));
