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
 * Shared types for the cross-window "Show in Tree" IPC channel.
 *
 * Requirements: 4.1
 */

/**
 * Identifies a single node in the namespace tree.
 */
export interface NavigationTarget {
  nodeId: number;
  namespace: string;
  concept: string;
}

/**
 * Payload sent from the originating renderer to the main process via
 * `window.showInTree`. The main process forwards it to the Spawn_Window
 * as a `NavigationRequest`.
 */
export interface ShowInTreePayload {
  homeTarget: NavigationTarget;
  referenceTarget?: NavigationTarget;
  requestKind: 'home' | 'reference';
  /** The authored safety namespace that the spawn window should use for SafetyEditor. */
  safetyNamespace?: string;
}

/**
 * Navigation request dispatched from the main process to the Spawn_Window's
 * renderer via `window.showInTree.dispatch` (webContents.send).
 * Shape is identical to ShowInTreePayload; the separate type makes the
 * direction explicit in code.
 */
export interface NavigationRequest {
  homeTarget: NavigationTarget;
  referenceTarget?: NavigationTarget;
  requestKind: 'home' | 'reference';
  /** The authored safety namespace that the spawn window should use for SafetyEditor. */
  safetyNamespace?: string;
}
