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

export interface PendingPropagationSource {
  nodeId: number;
  name: string;
  namespace: string;
  concept: 'malfunction';
}

export interface CopiedMalfunctionData {
  sourceNodeId: number;
  sourceNamespace: string;
  name: string;
  description: string;
  asil?: string;
  riskRating?: {
    severity?: string;
    occurrence?: string;
    detection?: string;
    note?: string;
  } | null;
  safetyTaskNodeIds: number[];
  requirementNodeIds: number[];
  directRequirementNodeIds: number[];
}

export interface NamespaceContext {
  namespaceId: string;
  name: string;
  role: 'imported' | 'authored';
  owningApplication: string;
  metamodel: string;
  workingDir: string;
}

/** Persisted tree UI state for the safety editor, keyed by namespace name. */
export interface SafetyTreeSnapshot {
  expandedKeys: string[];
  selectedKey: string | null;
  selectedElement: {
    nodeId: number;
    namespace: string;
    concept: string;
    name?: string;
    /** Present when the selected element is a cross-namespace reference child. */
    hostNodeId?: number;
    hostNamespace?: string;
  } | null;
}

/** Persisted navigation history for the safety editor, keyed by namespace name. */
export interface NavigationHistorySnapshot {
  entries: {
    nodeId: number;
    namespace: string;
    concept: string;
    name?: string;
    treeKey?: string;
    hostNodeId?: number;
    hostNamespace?: string;
  }[];
  cursor: number;
}

interface WorkspaceStore {
  workingDir: string | null;
  projectName: string | null;
  activeNamespace: NamespaceContext | null;
  // editor overrides: namespaceId → owningApplication override
  editorOverrides: Record<string, string>;
  sidebarWidth: number;
  // Persisted tree state per safety namespace
  safetyTreeState: Record<string, SafetyTreeSnapshot>;
  // Persisted navigation history (shared across all namespaces)
  navigationHistory: NavigationHistorySnapshot | null;
  // Pending propagation source per safety namespace (cleared on completion or cancel)
  pendingPropagationSource: Record<string, PendingPropagationSource | null>;
  /**
   * When a namespace ID is present in this map with value `true`, the
   * ModelCheckView should automatically run checks using the persisted
   * selection (or all applicable checks) as soon as it mounts and loads
   * the applicable checks. The flag is consumed (set to false) immediately
   * before the run starts to prevent re-triggering.
   */
  pendingCheckAutoRun: Record<string, boolean>;
  copiedMalfunction: CopiedMalfunctionData | null;
  /**
   * Persisted tab selection for the element detail view (Model / Propagation /
   * Malfunctions / Notes / Details).
   * Stored globally as a session-level UI preference — survives navigation between nodes.
   */
  elementLensView: 'diagram' | 'propagation' | 'table' | 'notes' | 'details';
  /**
   * When true, the safety tree renders all model elements regardless of the
   * per-metamodel tree rendering config. Session-level UI/view preference —
   * survives workspace switches (not reset by resetWorkspaceState).
   */
  showAllTreeElements: boolean;

  // ── Overview_Canvas Auto_Layout / Placement UI state ───────────────────────
  // Workspace-scoped UI state for the connection-diagram-layout-persistence
  // feature. `autoLayoutActive === false` is the Auto_Layout_Deactivated_State;
  // `placement !== null` is Placement_Mode (a newly created Canvas_Element whose
  // Element_Position has not been committed yet). Both are reset on workspace
  // switch via resetWorkspaceState().
  /** false = Auto_Layout_Deactivated_State; true = Auto_Layout_Active_State. */
  autoLayoutActive: boolean;
  /** Non-null while a newly created Canvas_Element is being placed (Placement_Mode). */
  placement: { elementKind: string; elementKey: string } | null;

  setWorkingDir: (dir: string, projectName?: string) => void;
  setActiveNamespace: (ns: NamespaceContext | null) => void;
  setEditorOverride: (namespaceId: string, owningApp: string) => void;
  setSidebarWidth: (width: number) => void;
  setSafetyTreeState: (namespace: string, snapshot: SafetyTreeSnapshot) => void;
  setNavigationHistory: (snapshot: NavigationHistorySnapshot) => void;
  setPendingPropagationSource: (safetyNs: string, src: PendingPropagationSource | null) => void;
  setPendingCheckAutoRun: (namespaceId: string, pending: boolean) => void;
  setCopiedMalfunction: (data: CopiedMalfunctionData | null) => void;
  setElementLensView: (view: 'diagram' | 'propagation' | 'table' | 'notes' | 'details') => void;
  setShowAllTreeElements: (v: boolean) => void;
  /** Enter/leave the Auto_Layout_Active_State (true) or Deactivated (false). */
  setAutoLayoutActive: (active: boolean) => void;
  /** Enter Placement_Mode for a newly created Canvas_Element. */
  enterPlacement: (elementKind: string, elementKey: string) => void;
  /** Exit Placement_Mode. */
  exitPlacement: () => void;
  /** Reset all workspace-scoped state on workspace switch. */
  resetWorkspaceState: () => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  workingDir: null,
  projectName: null,
  activeNamespace: null,
  editorOverrides: {},
  sidebarWidth: 240,
  safetyTreeState: {},
  navigationHistory: null,
  pendingPropagationSource: {},
  pendingCheckAutoRun: {},
  copiedMalfunction: null,
  elementLensView: 'diagram',
  showAllTreeElements: false,
  autoLayoutActive: false,
  placement: null,

  setWorkingDir: (dir, projectName) =>
    set({ workingDir: dir, projectName: projectName ?? dir.split(/[\\/]/).pop() ?? dir }),

  setActiveNamespace: (ns) => set({ activeNamespace: ns }),

  setEditorOverride: (namespaceId, owningApp) =>
    set((s) => ({ editorOverrides: { ...s.editorOverrides, [namespaceId]: owningApp } })),

  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  setSafetyTreeState: (namespace, snapshot) =>
    set((s) => ({ safetyTreeState: { ...s.safetyTreeState, [namespace]: snapshot } })),

  setNavigationHistory: (snapshot) =>
    set({ navigationHistory: snapshot }),

  setPendingPropagationSource: (safetyNs, src) =>
    set((s) => ({ pendingPropagationSource: { ...s.pendingPropagationSource, [safetyNs]: src } })),

  setPendingCheckAutoRun: (namespaceId, pending) =>
    set((s) => ({ pendingCheckAutoRun: { ...s.pendingCheckAutoRun, [namespaceId]: pending } })),

  setCopiedMalfunction: (data) => set({ copiedMalfunction: data }),

  setElementLensView: (view) => set({ elementLensView: view }),

  setShowAllTreeElements: (v) => set({ showAllTreeElements: v }),

  setAutoLayoutActive: (active) => set({ autoLayoutActive: active }),

  enterPlacement: (elementKind, elementKey) =>
    set({ placement: { elementKind, elementKey } }),

  exitPlacement: () => set({ placement: null }),

  resetWorkspaceState: () =>
    set({ activeNamespace: null, editorOverrides: {}, safetyTreeState: {}, navigationHistory: null, pendingPropagationSource: {}, pendingCheckAutoRun: {}, copiedMalfunction: null, autoLayoutActive: false, placement: null }),
}));
