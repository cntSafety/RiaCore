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
export interface ProfileInfo {
  profileId: string;
  label: string;
  version: string;
  description?: string;
  metamodelName: string;
  owningApplication: string;
  namespaceRole: 'authored';
}

export interface CreateAuthoredNamespaceParams {
  workingDir: string;
  namespace: string;
  profileId: string;
  overwrite?: boolean;
}

export interface CreatedNamespaceInfo {
  namespace: string;
  profileId: string;
  metamodel: string;
  namespaceRole: 'authored';
  namespaceOwningApplication: string;
}

export interface NamespaceInfo {
  namespaceId: string;
  name: string;
  /**
   * 'imported' — regular imported namespace visible to users.
   * 'authored' — user-created namespace visible to users.
   * 'supervised_update_temp' — temporary namespace created during a supervised
   * update review; never shown in normal user-facing views.
   */
  role: 'imported' | 'authored' | 'supervised_update_temp';
  owningApplication: string;
  metamodel: string;
}

export interface NamespaceCrossNsConnectionInfo {
  relationship: string;
  otherNamespace: string;
  otherNodeId: number;
  otherNodeName: string;
  otherConcept: string;
}

export interface NamespaceDeleteImpactPreview {
  namespace: string;
  role: 'imported' | 'authored' | 'supervised_update_temp';
  nodeCount: number;
  crossNsConnections: NamespaceCrossNsConnectionInfo[];
}
