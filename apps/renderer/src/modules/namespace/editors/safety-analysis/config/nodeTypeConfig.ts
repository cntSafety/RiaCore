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
import {
  WarningOutlined,
  SafetyOutlined,
  CheckSquareOutlined,
  FileTextOutlined,
  MessageOutlined,
  AuditOutlined,
  CodeOutlined,
  ApiOutlined,
  BlockOutlined,
  BranchesOutlined,
  FolderOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  SwapOutlined,
  SettingOutlined,
  LockOutlined,
  TagOutlined,
  ShareAltOutlined,
  ContainerOutlined,
  FunctionOutlined,
} from '@ant-design/icons';
import type { ComponentType } from 'react';
import type { MetamodelRenderingConfig } from '@riacore/app-contracts';

export interface NodeDecoration {
  icon: ComponentType;
  color: string;
}

export const NODE_TYPE_CONFIG: Record<string, NodeDecoration> = {
  // Architecture concepts
  application_swc:       { icon: CodeOutlined,          color: '#1677ff' },
  composition_swc:       { icon: BlockOutlined,         color: '#1677ff' },
  cdd_swc:               { icon: CodeOutlined,          color: '#13c2c2' },
  service_swc:           { icon: ApiOutlined,           color: '#722ed1' },
  ecu_abstraction_swc:   { icon: SettingOutlined,       color: '#597ef7' },
  bsw_module_description:{ icon: DatabaseOutlined,      color: '#36cfc9' },
  p_port:                { icon: ApiOutlined,           color: '#52c41a' },
  r_port:                { icon: ApiOutlined,           color: '#597ef7' },
  runnable_entity:       { icon: BranchesOutlined,      color: '#2f54eb' },
  ar_package:            { icon: FolderOutlined,        color: '#8c8c8c' },
  sr_interface:          { icon: SwapOutlined,          color: '#9254de' },
  cs_interface:          { icon: SwapOutlined,          color: '#9254de' },
  swc_internal_behavior: { icon: BranchesOutlined,      color: '#597ef7' },
  swc_implementation:    { icon: CodeOutlined,          color: '#389e0d' },
  swc_prototype:         { icon: BlockOutlined,         color: '#1890ff' },
  timing_event:          { icon: ThunderboltOutlined,   color: '#9254de' },
  init_event:            { icon: ThunderboltOutlined,   color: '#9254de' },
  data_received_event:   { icon: ThunderboltOutlined,   color: '#9254de' },
  variable_data_proto:   { icon: DatabaseOutlined,      color: '#13c2c2' },
  impl_data_type:        { icon: DatabaseOutlined,      color: '#13c2c2' },
  exclusive_area:        { icon: LockOutlined,          color: '#cf1322' },
  assembly_connector:    { icon: SwapOutlined,          color: '#8c8c8c' },
  delegation_connector:  { icon: SwapOutlined,          color: '#8c8c8c' },

  // Safety concepts
  malfunction:          { icon: WarningOutlined,       color: '#faad14' },
  risk_rating:           { icon: SafetyOutlined,        color: '#cf1322' },
  safety_task:           { icon: CheckSquareOutlined,   color: '#52c41a' },
  requirement:           { icon: FileTextOutlined,      color: '#722ed1' },
  safety_note:           { icon: MessageOutlined,       color: '#1677ff' },
  review_item:           { icon: AuditOutlined,         color: '#eb2f96' },
  tag:                   { icon: TagOutlined,           color: '#597ef7' },

  // SOTIF concepts
  functional_insufficiency: { icon: FunctionOutlined,    color: '#9254de' },
  triggering_condition:     { icon: ThunderboltOutlined, color: '#fa8c16' },

  // Default fallback
  default:               { icon: CodeOutlined,          color: '#8c8c8c' },
};

/**
 * Resolve icon + color for a concept type.
 *
 * Precedence: the static {@link NODE_TYPE_CONFIG} (ARXML + safety concepts) is
 * authoritative, then the optional SysML overlay (built from the metamodel
 * rendering config), then a Sphinx-Needs fallback (any `need_*` concept renders
 * as a document), then the static `default` fallback.
 */
export function getNodeDecoration(
  concept: string,
  sysmlDecorations?: Record<string, NodeDecoration>,
): NodeDecoration {
  return (
    NODE_TYPE_CONFIG[concept] ??
    sysmlDecorations?.[concept] ??
    (concept.startsWith('need_') ? SPHINX_NEEDS_DECORATION : undefined) ??
    NODE_TYPE_CONFIG['default']
  );
}

/**
 * Fallback decoration for Sphinx-Needs elements. Their concepts are dynamically
 * named `need_<type>` and carry no static config or SysML overlay, so without
 * this they render with the generic `default` (code) icon. A document icon keeps
 * them consistent with the SW-Requirements namespace decoration.
 */
export const SPHINX_NEEDS_DECORATION: NodeDecoration = {
  icon: FileTextOutlined,
  color: '#52c41a',
};

/**
 * Maps ant-design icon component names (as declared in the metamodel rendering
 * config) to their React components. Concepts referencing a name not present here
 * fall back to {@link DEFAULT_DECORATION}'s icon.
 */
export const ICON_REGISTRY: Record<string, ComponentType> = {
  BlockOutlined,
  ApiOutlined,
  SwapOutlined,
  FileTextOutlined,
  AuditOutlined,
  BranchesOutlined,
  ThunderboltOutlined,
  ShareAltOutlined,
  DatabaseOutlined,
  FolderOutlined,
  CodeOutlined,
  ContainerOutlined,
};

/** Fallback decoration used when a concept omits an icon name or color. */
export const DEFAULT_DECORATION: NodeDecoration = {
  icon: CodeOutlined,
  color: '#8c8c8c',
};

/**
 * Build a concept → {@link NodeDecoration} overlay from the metamodel rendering
 * config. Unknown icon names fall back to the default icon and absent colors fall
 * back to the default color, so every entry resolves to a valid decoration.
 */
export function buildSysmlDecorations(
  config: MetamodelRenderingConfig,
): Record<string, NodeDecoration> {
  const out: Record<string, NodeDecoration> = {};
  for (const [concept, r] of Object.entries(config)) {
    const icon = (r.icon && ICON_REGISTRY[r.icon]) || DEFAULT_DECORATION.icon;
    const color = r.color || DEFAULT_DECORATION.color;
    out[concept] = { icon, color };
  }
  return out;
}
