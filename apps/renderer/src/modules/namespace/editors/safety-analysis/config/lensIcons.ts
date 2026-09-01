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
  ApartmentOutlined,
  AuditOutlined,
  CheckSquareOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  NodeIndexOutlined,
  ProfileOutlined,
  SafetyOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ComponentType } from 'react';

/**
 * Icon component per lens/tab key, covering both `ELEMENT_TABS` and
 * `MALFUNCTION_TABS`. The two sets are never rendered at the same time, so a
 * shared icon between them is fine.
 *
 * Where an option stands for a concept the icon matches `nodeTypeConfig` — in
 * particular `table` (the malfunction table) uses the malfunction icon.
 *
 * Components, not elements, so this module stays plain TypeScript and the
 * mapping can be asserted by identity in a test.
 */
export const LENS_ICONS: Record<string, ComponentType> = {
  // Element lenses (model browser)
  diagram: ApartmentOutlined,
  propagation: NodeIndexOutlined,
  table: WarningOutlined,
  notes: FileTextOutlined,
  details: InfoCircleOutlined,
  // Malfunction tabs (analysis view)
  overview: ProfileOutlined,
  'risk-rating': SafetyOutlined,
  'safety-tasks': CheckSquareOutlined,
  requirements: FileTextOutlined,
  review: AuditOutlined,
};
