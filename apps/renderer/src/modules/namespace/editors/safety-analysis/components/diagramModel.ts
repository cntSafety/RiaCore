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
 * The `CommonModel` vocabulary the model view renders in, plus the ASIL
 * ordering the safety workflows read it by.
 *
 * Every concept named here belongs to `CommonModel`, the immediate metamodel of
 * the view the diagram renders (docs/coreSpecs/RiaViews.md). No ARXML concept
 * name appears in this file: which source concepts become a port or an active
 * element is the mapping's business, and the diagram never learns it. The
 * source concept survives only as the representative's `kind` attribute, which
 * consumers pass to tree navigation because the tree has never seen a
 * `CommonModel` concept.
 *
 * The three port concepts are what replaced the old `p_port` / `r_port` /
 * `pr_port` union — port direction is expressed by subtyping precisely so that
 * the sender-left / receiver-right reading order is selectable by concept
 * rather than by a per-metamodel lookup table.
 *
 * This file used to also hold the connection diagram's render model — a fixed
 * decomposition into a focus component, sender and receiver columns, and the
 * Bezier path helper for the SVG overlay that joined them. That decomposition
 * went with the grid it described; the model view's render model is
 * `model-view/modelGraph.ts`, and edge routing is React Flow's job.
 */
import type { MalfunctionInfo, ConceptPresentation } from '@riacore/app-contracts';

export type { MalfunctionInfo };

// ---------------------------------------------------------------------------
// Concept classification
// ---------------------------------------------------------------------------

/** The `CommonModel` port concepts, in `Port`-subtype order. */
export const PORT_CONCEPTS = new Set(['InPort', 'OutPort', 'InOutPort']);

/** The `CommonModel` concept for anything that exposes ports. */
export const ACTIVE_ELEMENT_CONCEPT = 'ActiveElement';

/** The `CommonModel` concept for a connector, which is a node, not an edge. */
export const CONNECTION_CONCEPT = 'Connection';

/**
 * A `CommonModel` port concept. Replaces the former
 * `'p_port' | 'r_port' | 'pr_port'` union: the concept *is* the direction.
 */
export type PortConcept = 'InPort' | 'OutPort' | 'InOutPort';

/**
 * Display direction for a port, derived from its concept alone.
 *
 * `OutPort` provides and therefore sits on the sending side; `InPort` and
 * `InOutPort` both receive, and `InOutPort` is placed conservatively on the
 * receiving side exactly as the previous `pr_port` rule did.
 */
export function portDirection(concept: string): 'in' | 'out' {
  return concept === 'OutPort' ? 'out' : 'in';
}

/**
 * Whether the diagram renders a concept at all — "has a presentation entry for
 * the view's immediate metamodel" (spec-view.md Phase 4.4), replacing the two
 * hardcoded ARXML concept sets.
 *
 * Passing an empty catalog (not yet loaded) classifies nothing, which is the
 * safe direction: the diagram declines to render rather than guessing.
 */
export function isRelevantConcept(concept: string, presentation: ConceptPresentation[]): boolean {
  return presentation.some((entry) => entry.concept === concept);
}

/**
 * Whether a link is drawn dashed.
 *
 * `CommonModel` has one `Connection` concept; the source discriminator survives
 * in its `kind` attribute (RiaViews.md — "`kind` is where that distinction
 * survives"). Matched as a substring rather than against a literal source
 * concept name, so an unrecognized kind renders solid instead of failing.
 */
export function isDelegationLink(connectorType: string): boolean {
  return /delegation/i.test(connectorType);
}

/**
 * Whether a representative can anchor the model view.
 *
 * Anything the presentation catalog describes, except a `Connection` — which is
 * a relationship-as-node and gets no tile, so there would be nothing to centre
 * on. This is wider than the connection diagram's rule, which admitted only
 * components and ports: the model view opens a package on the elements it
 * contains, which is a perfectly good thing to look at and to expand from
 * (spec-view.md Phase 5.3).
 */
export function isDiagramAnchorConcept(concept: string, presentation: ConceptPresentation[]): boolean {
  if (!isRelevantConcept(concept, presentation)) return false;
  return concept !== CONNECTION_CONCEPT;
}

// ---------------------------------------------------------------------------
// Malfunction references
// ---------------------------------------------------------------------------

/** Lightweight malfunction reference for navigation from port pins. */
export interface DiagramMalfunctionRef {
  /** node_id of the malfunction. */
  nodeId: number;
  /** Display name of the malfunction. */
  name: string;
  /** Malfunction description text. */
  description: string;
}

// ---------------------------------------------------------------------------
// ASIL ordering
// ---------------------------------------------------------------------------

export const ASIL_ORDER: Record<string, number> = {
  QM: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

/**
 * Converts an ASIL string to a numeric level for comparison.
 *
 * Core levels map directly: QM=0, A=1, B=2, C=3, D=4.
 * Decomposition variants (e.g. `A(B)`, `QM(D)`) resolve to the highest
 * component level. Unrecognized strings return -1.
 */
export function parseAsilLevel(asil: string): number {
  if (!asil) return -1;

  const trimmed = asil.trim();

  // Check for decomposition variant like "A(B)" or "QM(D)"
  const decompositionMatch = trimmed.match(/^([A-Z]+)\(([A-Z]+)\)$/);
  if (decompositionMatch) {
    const level1 = ASIL_ORDER[decompositionMatch[1]] ?? -1;
    const level2 = ASIL_ORDER[decompositionMatch[2]] ?? -1;
    return Math.max(level1, level2);
  }

  // Direct lookup
  const level = ASIL_ORDER[trimmed];
  return level !== undefined ? level : -1;
}

/**
 * Returns the ASIL string with the highest resolved level from a list of
 * malfunctions, or `null` for empty arrays.
 *
 * Uses the ordering QM < A < B < C < D. Decomposition variants resolve to
 * their highest component level.
 */
export function resolveMaxAsil(malfunctions: MalfunctionInfo[]): string | null {
  if (malfunctions.length === 0) return null;

  let maxLevel = -1;
  let maxAsil: string | null = null;

  for (const malfunction of malfunctions) {
    const level = parseAsilLevel(malfunction.asil);
    if (level > maxLevel) {
      maxLevel = level;
      maxAsil = malfunction.asil;
    }
  }

  // Malfunctions exist but none have a recognized ASIL → treat as QM
  if (maxAsil === null || maxLevel < 0) return 'QM';

  return maxAsil;
}

/**
 * Maps an ASIL rating string to a CSS hex color for diagram rendering.
 * Uses the same ASIL ordering as getAsilColor but returns hex values
 * suitable for inline styles (borders, squares).
 *
 * Returns null when there is no ASIL (no malfunctions).
 */
export function getAsilHexColor(asil: string | null): string | null {
  if (!asil) return null;

  // Resolve decomposition to highest component
  const level = parseAsilLevel(asil);
  const LEVEL_COLORS: Record<number, string> = {
    0: '#8c8c8c', // QM — neutral grey
    1: '#52c41a', // A — green
    2: '#a0d911', // B — lime
    3: '#ffa940', // C — light orange
    4: '#d4380d', // D — dark orange-red (volcano)
  };
  return LEVEL_COLORS[level] ?? null;
}
