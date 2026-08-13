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
 * Singleton Zustand slice that owns the open/close state of the top-level
 * application `SettingsDialog` (File → Settings…).
 *
 * Modeled on `llmSettingsDialogStore.ts`: lifting the dialog open-state into a
 * tiny slice keeps the cross-component wiring trivial. The native File menu
 * action handler in `App.tsx` calls `openDialog()` and the dialog subscribes to
 * `open` for its `open` prop, calling `closeDialog()` on close.
 *
 * The dialog is designed to grow: it hosts multiple settings categories (the
 * first being "SysML v2 Tree View"), so this store is intentionally
 * category-agnostic — it only tracks visibility.
 *
 * `activeTab` can be set before opening to land on a specific settings tab
 * directly (e.g. "llm" when the user triggers settings from LlmReviewModal).
 */
interface AppSettingsDialogState {
  /** True when the SettingsDialog should be rendered as visible. */
  open: boolean;
  /** The tab key to activate when the dialog opens. null = default (first tab). */
  activeTab: string | null;
}

interface AppSettingsDialogActions {
  /** Open the dialog. Idempotent — calling twice has no extra effect. */
  openDialog: (tab?: string) => void;
  /** Close the dialog. Idempotent. */
  closeDialog: () => void;
  /** Set the active tab without opening/closing. */
  setActiveTab: (tab: string) => void;
}

type AppSettingsDialogStore = AppSettingsDialogState & AppSettingsDialogActions;

export const useAppSettingsDialogStore = create<AppSettingsDialogStore>((set) => ({
  open: false,
  activeTab: null,
  openDialog: (tab?: string) => set({ open: true, ...(tab ? { activeTab: tab } : {}) }),
  closeDialog: () => set({ open: false, activeTab: null }),
  setActiveTab: (tab: string) => set({ activeTab: tab }),
}));

/** Imperative helper for non-React call sites. */
export function openAppSettingsDialog(tab?: string): void {
  useAppSettingsDialogStore.getState().openDialog(tab);
}

/** Imperative helper for non-React call sites. */
export function closeAppSettingsDialog(): void {
  useAppSettingsDialogStore.getState().closeDialog();
}
