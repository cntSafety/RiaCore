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
 * Turns an impact-report `ModifiedEntry`'s before/after attribute maps into the
 * same `PropertyChange[]` vocabulary the namespace diff view uses.
 *
 * The impact report already carries `oldAttributes` and `newAttributes` in full
 * — only `changedKeys` was ever rendered. This adapter exists so the import
 * panel can show the actual values without a second diff engine: the backend has
 * already decided *which* keys changed, and this only reshapes what it found.
 *
 * `changedKeys` is deliberately treated as authoritative rather than recomputed.
 * It is produced by `diffAttributeKeys` in
 * `packages/app-core/src/importers/import-crossns-impact-service.ts`, which
 * compares `JSON.stringify` per value over the union of both key sets. Re-deriving
 * the set here would be a second source of truth that could silently disagree
 * with the count shown in the report header.
 */

import type { PropertyChange } from '@riacore/app-contracts';

/**
 * Build the per-attribute change list for a modified boundary node.
 *
 * The change kind is inferred from key presence, matching how the diff view
 * classifies node property changes:
 *  - missing on the left  → `added`
 *  - missing on the right → `deleted`
 *  - present on both      → `modified`
 *
 * A key listed in `changedKeys` but absent from both maps cannot arise from the
 * backend's union-of-keys comparison; it is skipped rather than rendered as an
 * empty row, so a malformed report degrades quietly instead of showing a change
 * with nothing on either side.
 */
export function toPropertyChanges(
  changedKeys: string[],
  oldAttributes: Record<string, unknown>,
  newAttributes: Record<string, unknown>,
): PropertyChange[] {
  const changes: PropertyChange[] = [];

  for (const attribute of changedKeys) {
    const inOld = Object.prototype.hasOwnProperty.call(oldAttributes, attribute);
    const inNew = Object.prototype.hasOwnProperty.call(newAttributes, attribute);
    if (!inOld && !inNew) continue;

    changes.push({
      attribute,
      changeKind: !inOld ? 'added' : !inNew ? 'deleted' : 'modified',
      // Left/right are left `undefined` on the side where the key is absent,
      // which is exactly what PropertyChange documents for added/deleted.
      leftValue: inOld ? oldAttributes[attribute] : undefined,
      rightValue: inNew ? newAttributes[attribute] : undefined,
    });
  }

  return changes;
}
