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
import { openAppSettingsDialog, closeAppSettingsDialog } from './appSettingsDialogStore';

/**
 * Singleton Zustand slice that owns the open/close state of the LLM settings
 * panel — now a tab inside the main `SettingsDialog` rather than a standalone
 * modal.
 *
 * The LLM Component Review feature has two entry points that need to open the
 * LLM settings:
 *
 *  1. The "Open Settings" shortcut inside `LlmReviewModal` (pre-flight gate
 *     and error banner) — Requirements 4.8, 10.8.
 *  2. Previously the top-bar gear button; now File → Settings → LLM tab.
 *
 * Callers (`LlmReviewModal`, any future entry point) use `openDialog()` /
 * `closeDialog()` unchanged. Internally those now delegate to
 * `appSettingsDialogStore` with tab='llm' so the SettingsDialog opens directly
 * on the LLM configuration tab.
 *
 * The `open` field is kept for backward compatibility with components that
 * read it (e.g. `App.tsx` guard, tests).
 */
interface LlmSettingsDialogState {
  /** Reflects whether the LLM settings tab is currently requested open. */
  open: boolean;
}

interface LlmSettingsDialogActions {
  openDialog: () => void;
  closeDialog: () => void;
}

type LlmSettingsDialogStore = LlmSettingsDialogState & LlmSettingsDialogActions;

export const useLlmSettingsDialogStore = create<LlmSettingsDialogStore>((set) => ({
  open: false,
  openDialog: () => {
    set({ open: true });
    openAppSettingsDialog('llm');
  },
  closeDialog: () => {
    set({ open: false });
    closeAppSettingsDialog();
  },
}));

/** Imperative helper for non-React call sites. */
export function openLlmSettingsDialog(): void {
  useLlmSettingsDialogStore.getState().openDialog();
}

/** Imperative helper for non-React call sites. */
export function closeLlmSettingsDialog(): void {
  useLlmSettingsDialogStore.getState().closeDialog();
}
