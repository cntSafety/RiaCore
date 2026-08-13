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
import type { ComponentType } from 'react';
import {
  ApartmentOutlined,
  FileTextOutlined,
  DeploymentUnitOutlined,
  SafetyCertificateOutlined,
  SecurityScanOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

/**
 * Shared namespace "kind" → icon/color mapping.
 *
 * Single source of truth for the type-specific icon and accent color shown
 * for a namespace, whether on the workspace canvas card (WorkspaceCanvas.tsx)
 * or the namespace root row in the safety-analysis tree (NamespaceTreePanel.tsx).
 * Keeping this in one place is what keeps the two views visually consistent.
 */
export interface NamespaceTypeDecoration {
  icon: ComponentType;
  color: string;
  label: string;
}

type NamespaceKind =
  | 'arxml'
  | 'sphinx_needs'
  | 'sysml'
  | 'safety_analysis'
  | 'system_safety_analysis'
  | 'monitoring_analysis'
  | 'security_analysis';

const KIND_DECORATION: Record<NamespaceKind, NamespaceTypeDecoration> = {
  arxml:             { icon: ApartmentOutlined,         color: '#1890ff', label: 'AUTOSAR (ARXML)' },
  sphinx_needs:      { icon: FileTextOutlined,           color: '#52c41a', label: 'SW Requirements' },
  sysml:             { icon: DeploymentUnitOutlined,      color: '#9254de', label: 'SysML' },
  // Matches the riacoreTokens.colorWarning override in theme/tokens.ts — fixed
  // regardless of light/dark algorithm, so hardcoding here stays in sync.
  safety_analysis:   { icon: SafetyCertificateOutlined,   color: '#d97706', label: 'SW Safety Analysis' },
  // System safety shares Safety's certificate shield but uses a lighter orange
  // accent (icon + card frame) and its own label so it's visually distinct from
  // SW Safety on the canvas and in the tree. Keyed off the SYSTEM_SAFETY_ANALYSIS
  // metamodel, so it stays driven by the profile's YAML identity, not per-tile.
  system_safety_analysis: { icon: SafetyCertificateOutlined, color: '#f59e0b', label: 'System Safety Analysis' },
  // Monitoring analysis shares the safety family's orange accent so it reads as
  // "a safety analysis", but uses a thunderbolt/sparks icon to signal the
  // runtime-monitoring viewpoint. Keyed off the MONITORING_ANALYSIS metamodel.
  monitoring_analysis: { icon: ThunderboltOutlined,        color: '#ea7317', label: 'Monitoring Analysis' },
  security_analysis: { icon: SecurityScanOutlined,         color: '#d4a017', label: 'Security Analysis' },
};

/** Resolve a namespace "kind" from a SourceMaster sourceType (import tiles). */
function kindFromSourceType(sourceType: string): NamespaceKind | null {
  switch (sourceType) {
    case 'arxml_file': return 'arxml';
    case 'sphinx_needs_json': return 'sphinx_needs';
    case 'sysml_v2_json':
    case 'sysml_v2_textual': return 'sysml';
    default: return null;
  }
}

/**
 * Resolve a namespace "kind" from a RIA_UNIV_Namespace metamodel name
 * (used for authored analysis namespaces and imported namespace roots in
 * the tree, which only carry `metamodel`, not the originating `sourceType`).
 *
 * Sphinx-Needs namespaces get a dynamically generated metamodel name of the
 * form `SN_<namespace>` (see computeDynamicMetamodelName), so that case is
 * matched by prefix rather than an exact string.
 */
function kindFromMetamodel(metamodel: string): NamespaceKind | null {
  if (metamodel === 'SW_ARXML') return 'arxml';
  if (metamodel === 'SysMLv2' || metamodel === 'SysMLv2Textual') return 'sysml';
  if (metamodel.startsWith('SN_')) return 'sphinx_needs';
  if (metamodel === 'SAFETY_ANALYSIS') return 'safety_analysis';
  if (metamodel === 'SYSTEM_SAFETY_ANALYSIS') return 'system_safety_analysis';
  if (metamodel === 'MONITORING_ANALYSIS') return 'monitoring_analysis';
  if (metamodel === 'SECURITY_ANALYSIS') return 'security_analysis';
  return null;
}

/** Fallback decoration for a sourceType/metamodel this module doesn't recognize. */
export const UNKNOWN_IMPORT_DECORATION: NamespaceTypeDecoration = {
  icon: FileTextOutlined,
  color: '#8c8c8c',
  label: 'Import',
};

export function getNamespaceDecorationBySourceType(sourceType: string): NamespaceTypeDecoration {
  const kind = kindFromSourceType(sourceType);
  return kind ? KIND_DECORATION[kind] : UNKNOWN_IMPORT_DECORATION;
}

/**
 * Returns null when the metamodel isn't one of the recognized kinds, so
 * callers (e.g. the tree's namespace-root icon) can fall back to their own
 * role-based default instead of the generic import icon above.
 */
export function getNamespaceDecorationByMetamodel(metamodel: string): NamespaceTypeDecoration | null {
  const kind = kindFromMetamodel(metamodel);
  return kind ? KIND_DECORATION[kind] : null;
}
