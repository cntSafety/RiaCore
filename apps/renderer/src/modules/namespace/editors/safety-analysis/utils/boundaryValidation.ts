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
 * Boundary validation utilities for the Safety Analysis tree.
 *
 * These functions validate API responses at the data boundary before they
 * enter the reducer. They detect anomalies but NEVER modify the input data —
 * detection only. The data passes through to the reducer unchanged.
 *
 * Design: detect-and-warn, never suppress.
 * See design.md §5 "Boundary Validation Utility".
 *
 * Requirements: 14.1, 14.2, 14.3
 */

import type { TreeChildNode } from '@riacore/app-contracts';
import type { AnomalyReport } from './treeIndexStore.js';

/**
 * Validate a getChildren response for duplicate `node_id` values.
 *
 * If two or more children share the same `node_id`, one `AnomalyReport` is
 * emitted per duplicate occurrence (i.e. N children with the same id → N-1
 * anomaly reports, one for each extra occurrence beyond the first).
 *
 * The input array is NOT modified.
 *
 * @param children  The children array from a getChildren response.
 * @param parentKey The tree key of the parent node (used in anomaly details).
 * @returns         An array of anomaly reports (empty when no duplicates found).
 */
export function validateChildrenResponse(
  children: TreeChildNode[],
  parentKey: string,
): AnomalyReport[] {
  const anomalies: AnomalyReport[] = [];
  const seen = new Map<number, number>(); // node_id → first-seen index

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const id = child.node_id;

    if (seen.has(id)) {
      anomalies.push({
        type: 'duplicate-node-id',
        message: `Duplicate node_id ${id} found in children of parent "${parentKey}" at index ${i} (first seen at index ${seen.get(id)})`,
        details: {
          parentKey,
          node_id: id,
          firstIndex: seen.get(id),
          duplicateIndex: i,
          concept: child.concept,
          name: child.name,
        },
      });
    } else {
      seen.set(id, i);
    }
  }

  return anomalies;
}

/**
 * Validate a namespace list for duplicate `name` values.
 *
 * If two or more namespaces share the same name, one `AnomalyReport` is
 * emitted per duplicate occurrence (N namespaces with the same name → N-1
 * anomaly reports).
 *
 * The input array is NOT modified.
 *
 * @param namespaces  An array of objects with at least a `name` field.
 * @returns           An array of anomaly reports (empty when no duplicates found).
 */
export function validateNamespaceList(
  namespaces: Array<{ name: string }>,
): AnomalyReport[] {
  const anomalies: AnomalyReport[] = [];
  const seen = new Map<string, number>(); // name → first-seen index

  for (let i = 0; i < namespaces.length; i++) {
    const ns = namespaces[i];
    const name = ns.name;

    if (seen.has(name)) {
      anomalies.push({
        type: 'duplicate-namespace-name',
        message: `Duplicate namespace name "${name}" found at index ${i} (first seen at index ${seen.get(name)})`,
        details: {
          name,
          firstIndex: seen.get(name),
          duplicateIndex: i,
        },
      });
    } else {
      seen.set(name, i);
    }
  }

  return anomalies;
}
