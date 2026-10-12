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
// ── Declared_Dimensions per Element_Kind ────────────────────────────────────
//
// Single source of truth for how big a Canvas_Element's box is *before* the
// browser has measured it. Introduced by the `overview-canvas-render-robustness`
// spec (Decisions 1 and 2).
//
// WHY THIS MODULE EXISTS
//
// The Overview_Canvas rebuilds its controlled `nodes` array from fresh object
// literals on every data change. React Flow 12 reconstructs a node's internal
// record whenever the user object reference changes, taking `measured` from that
// object alone — so each rebuild erases the dimensions it had measured. A node
// with no known dimensions is painted `visibility: hidden`, is excluded from
// `nodesInitialized`, and cannot anchor an edge path. Recovery depends on a
// resize-observation callback that is not guaranteed to be delivered, so a lost
// notification leaves the card invisible for the rest of the session.
//
// Declaring the dimensions up front removes that dependency entirely: a node has
// a usable box from the first frame it exists, whether or not any measurement
// notification ever arrives.
//
// THE INVARIANT THIS MODULE GUARANTEES
//
// Every Element_Kind — including one added to the canvas before it is added to
// the table below — resolves to a finite, positive width and height. There is no
// input for which the canvas can emit a dimensionless node.
//
// ONE TABLE, TWO CONSUMERS
//
// These same numbers are consumed twice:
//
//   1. as the node size handed to `buildElkGraph` (ELK reserves non-overlapping
//      room for each card during Auto_Layout), and
//   2. as React Flow's `initialWidth` / `initialHeight` on each node object,
//      which React Flow consults for rendering and geometry only while that node
//      has no `measured` dimensions.
//
// Deriving both from one table is what makes it impossible for the layout
// engine's idea of a card's footprint and React Flow's pre-measurement idea to
// drift apart. A future Element_Kind adds one entry here and is covered by both.
//
// NOT `width` / `height`: React Flow 12 applies those as authoritative inline
// styles, which would freeze every card at a fixed height and break the analysis
// cards whose height grows with their check badges.

// ── Element_Kind constants ──────────────────────────────────────────────────
//
// These live here, alongside the dimension table keyed by them, rather than in
// `canvasGraphGate.ts` where they used to be declared. `canvasGraphGate.ts` now
// needs `declaredDimensions` (so the pure gate mirrors the real build), and this
// module needs the kinds to key `NODE_DIMENSIONS` — declaring them in the gate
// would make the two modules import each other. `canvasGraphGate.ts` re-exports
// both names, so every existing import site is unaffected.
//
// Imported namespace nodes are keyed by their `targetNamespace`, analysis
// namespace nodes by their `name`.
export const IMPORTED_ELEMENT_KIND = 'imported';
export const ANALYSIS_ELEMENT_KIND = 'analysis';

export interface NodeDimensions {
  width: number;
  height: number;
}

/**
 * Declared_Dimensions per Element_Kind. The only definition in the renderer.
 *
 * The cards render at width 270; analysis cards are a little taller because of
 * their check badges. These values were previously duplicated inside
 * `WorkspaceCanvas.tsx` as `IMPORTER_NODE_SIZE` / `ANALYSIS_NODE_SIZE`.
 */
export const NODE_DIMENSIONS: Readonly<Record<string, NodeDimensions>> = {
  [IMPORTED_ELEMENT_KIND]: { width: 290, height: 172 },
  [ANALYSIS_ELEMENT_KIND]: { width: 290, height: 196 },
};

/**
 * Declared_Dimensions for an Element_Kind.
 *
 * Total by construction: an Element_Kind that is not registered in
 * `NODE_DIMENSIONS` yields the `imported` footprint rather than nothing. A
 * slightly wrong box is recoverable the moment measurement lands; a missing box
 * is the defect this module exists to make unreachable.
 *
 * The `Object.hasOwn` guard is load-bearing, not defensive noise. A plain index
 * read (`NODE_DIMENSIONS[elementKind]`) resolves through the object's prototype,
 * so an Element_Kind named `valueOf`, `toString`, `constructor`, or
 * `hasOwnProperty` would return the inherited `Object.prototype` member — a
 * truthy non-dimension that survives `??` and then reaches React Flow as
 * `initialWidth: undefined`, producing exactly the dimensionless node this
 * module exists to prevent. Restricting the lookup to own properties makes the
 * fallback the only outcome for every unregistered kind. Found by the Property 6
 * test in `__tests__/nodeDimensions.pbt.test.ts`.
 */
export function declaredDimensions(elementKind: string): NodeDimensions {
  const registered = Object.hasOwn(NODE_DIMENSIONS, elementKind)
    ? NODE_DIMENSIONS[elementKind]
    : undefined;
  return registered ?? NODE_DIMENSIONS[IMPORTED_ELEMENT_KIND];
}
