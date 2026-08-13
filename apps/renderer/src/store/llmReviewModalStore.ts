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

/**
 * Singleton Zustand slice that owns the open/close state of the
 * top-level `LlmReviewModal`.
 *
 * The modal is mounted once at the application root (`App.tsx`) so any
 * component — most importantly the namespace `TreeContextMenu` — can open
 * a review for a specific Eligible_Element_Node by calling
 * `openLlmReviewModal({ nodeId, namespace })`, without any prop-drilling
 * down through the tree panels.
 *
 * The `target` field encodes both visibility and the run target:
 *   - `null`                     → modal is hidden
 *   - `{ nodeId, namespace, displayName? }` → modal is visible for that element
 *
 * Mirrors the pattern of `llmSettingsDialogStore` for consistency.
 *
 * Implements task 10.6 of the `llm-component-review` spec — Requirement 4.6.
 */
export interface LlmReviewModalTarget {
  /** `node_id` of the right-clicked Eligible_Element_Node. */
  nodeId: number;
  /** Namespace of the right-clicked Eligible_Element_Node. */
  namespace: string;
  /** Optional display name captured from the tree node at open time. */
  displayName?: string;
  /**
   * Metamodel of the active authored safety analysis the review was launched
   * from (e.g. `MONITORING_ANALYSIS`). Selects the review checklist injected
   * into the LLM system prompt. Captured from `useSafetyMetamodel()` at open
   * time so it survives the imperative (non-React) menu callback.
   */
  reviewMetamodel?: string;
}

interface LlmReviewModalState {
  /** Non-null when the modal should be rendered as visible. */
  target: LlmReviewModalTarget | null;
}

interface LlmReviewModalActions {
  /** Open the modal for the given Eligible_Element_Node. */
  openModal: (target: LlmReviewModalTarget) => void;
  /** Close the modal. Idempotent. */
  closeModal: () => void;
}

type LlmReviewModalStore = LlmReviewModalState & LlmReviewModalActions;

export const useLlmReviewModalStore = create<LlmReviewModalStore>((set) => ({
  target: null,
  openModal: (target) => set({ target }),
  closeModal: () => set({ target: null }),
}));

/** Imperative helper for non-React call sites (e.g. native context-menu callbacks). */
export function openLlmReviewModal(target: LlmReviewModalTarget): void {
  useLlmReviewModalStore.getState().openModal(target);
}

/** Imperative helper for non-React call sites. */
export function closeLlmReviewModal(): void {
  useLlmReviewModalStore.getState().closeModal();
}
