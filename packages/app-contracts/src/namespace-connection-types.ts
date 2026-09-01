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
 * DTOs for the manual namespace-connections feature.
 *
 * These types cross the IPC boundary, so they are defined here in app-contracts.
 * app-core imports them from `@riacore/app-contracts`; app-contracts must never
 * depend on app-core.
 */

/**
 * Full connection graph for the overview canvas.
 * Each namespace appears exactly once (distinct by name); every connection is
 * directed imported (`source`) → authored (`target`).
 */
export interface NamespaceConnectionGraph {
  /** Distinct imported namespaces (namespace_role = 'imported'). */
  imported: { name: string }[];
  /** Distinct analysis namespaces (namespace_role = 'authored') with their metamodel. */
  analyses: { name: string; metamodel: string }[];
  /** Distinct directed connections, source = imported, target = authored. */
  connections: { source: string; target: string }[];
}

/**
 * Result of a `connect` mutation. `alreadyConnected` is true when the per-pair
 * edge already existed (idempotent success).
 */
export interface ConnectionEntry {
  importedNamespace: string;
  authoredNamespace: string;
  /** Metamodel of the authored namespace, resolved via RIA_META_DEFINEDBY. */
  authoredMetamodel: string;
  alreadyConnected: boolean;
}

/**
 * Result of a `disconnect` mutation.
 */
export interface DisconnectResult {
  importedNamespace: string;
  authoredNamespace: string;
  /** Number of dependent Cross_Namespace_Relationship instances deleted. */
  deletedDependentCount: number;
  /** Whether the derived RIA_META_CATEGORIZEDBY edge was ref-counted away. */
  removedCategorizedBy: boolean;
}

/**
 * Governs what happens when the user tries to link a cross-namespace element
 * (e.g. an imported requirement) whose namespace has no `RIA_UNIV_NamespaceConnection`
 * to the current authored namespace yet.
 *
 * - `'prompt'`   — the picker shows every match regardless of connection state;
 *                  selecting an unconnected one asks the user to create the
 *                  connection and the link together (or neither, on cancel).
 * - `'restrict'` — the picker only shows matches whose namespace is already
 *                  connected, so every visible result links immediately.
 */
export type CrossNsLinkUnconnectedMode = 'prompt' | 'restrict';

export interface CrossNsLinkSettings {
  unconnectedNamespaceMode: CrossNsLinkUnconnectedMode;
}
