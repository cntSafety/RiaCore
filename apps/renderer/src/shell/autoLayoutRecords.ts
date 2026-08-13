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
// ── Auto_Layout_Button record building ──────────────────────────────────────
// Pure record-building function extracted from WorkspaceCanvas.tsx's onAutoLayout
// so it can be exercised directly by property tests against the REAL render code
// path (Req 4.3).
//
// When the Auto_Layout_Button runs, `computeElkLayout` produces a positions map
// (keyed by each node's id — an imported node's `targetNamespace` or an analysis
// node's `name`). buildAutoLayoutRecords maps every rendered Canvas_Element that
// has a computed position to exactly one Layout_Record at that position, so the
// computed layout becomes the persisted Diagram_Layout:
//   - imported namespace node → { elementKind: 'imported', elementKey: targetNamespace }
//   - analysis namespace node → { elementKind: 'analysis', elementKey: name }
//
// A rendered element with no entry in the positions map yields no record (it was
// not laid out), and no element ever produces more than one record.

import type { LayoutRecord } from '@riacore/app-contracts';

/** Element_Kinds positioned today (imported namespaces, analysis namespaces). */
export const IMPORTED_ELEMENT_KIND = 'imported';
export const ANALYSIS_ELEMENT_KIND = 'analysis';

export interface Point {
  x: number;
  y: number;
}

/** Minimal shape of an imported source needed to build its Layout_Record. */
export interface ImportSourceLike {
  targetNamespace: string;
}

/** Minimal shape of an authored (analysis) namespace needed to build its record. */
export interface AuthoredNamespaceLike {
  name: string;
}

/**
 * Build one Layout_Record per rendered Canvas_Element that has a computed
 * Element_Position (Req 4.3).
 *
 * @param importSources       rendered imported namespace nodes (keyed by targetNamespace)
 * @param authoredNamespaces  rendered analysis namespace nodes (keyed by name)
 * @param positions           Auto_Layout result indexed by node id
 * @returns exactly one LayoutRecord per rendered element present in `positions`,
 *          at that element's computed position, with the correct Layout_Key.
 */
export function buildAutoLayoutRecords(
  importSources: readonly ImportSourceLike[],
  authoredNamespaces: readonly AuthoredNamespaceLike[],
  positions: ReadonlyMap<string, Point>,
): LayoutRecord[] {
  return [
    ...importSources
      .map((s) => {
        const pos = positions.get(s.targetNamespace);
        return pos
          ? { elementKind: IMPORTED_ELEMENT_KIND, elementKey: s.targetNamespace, x: pos.x, y: pos.y }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
    ...authoredNamespaces
      .map((ns) => {
        const pos = positions.get(ns.name);
        return pos
          ? { elementKind: ANALYSIS_ELEMENT_KIND, elementKey: ns.name, x: pos.x, y: pos.y }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
  ];
}
