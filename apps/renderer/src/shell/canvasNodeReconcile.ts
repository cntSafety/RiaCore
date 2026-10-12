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
// Feature: overview-canvas-render-robustness
//
// ── Node_Array reconciliation: carry measurements forward, reuse identities ──
//
// The Overview_Canvas rebuilds its whole controlled `nodes` array from fresh
// object literals whenever its data fingerprint changes (import, update-from-
// branch, persisted drag position, stats refresh, connection create/remove, …).
// Those literals carry no dimension information, and `@xyflow/react` 12.11.3
// takes a node's dimensions from the user object rather than carrying them over.
// From `adoptUserNodes`:
//
//     if (_options.checkEquality && userNode === internalNode?.internals.userNode)
//       nodeLookup.set(userNode.id, internalNode);
//     else {
//       internalNode = { ..._options.defaults, ...userNode,
//         measured: { width: userNode.measured?.width, height: userNode.measured?.height },
//
// So React Flow keeps its existing internal record for a node ONLY when the user
// object is referentially identical. Any other rebuild discards the measurements
// it had taken, which forces every card to be re-observed and re-measured. That
// burst of observation work is what makes the browser drop notification batches
// ("ResizeObserver loop completed with undelivered notifications"), and a node
// whose notification is lost never acquires dimensions again — nothing will ever
// change its size.
//
// This module is the fix for the rebuild side of that: given the previous array
// and the freshly built one, it carries measurements across and hands back the
// PREVIOUS object for every node that did not actually change, so React Flow's
// `checkEquality` branch is taken and no re-observe happens at all.
//
// Guarantees (Properties 1-5 of the design):
//
//  1. **Element set preserved exactly** — the output has the same length and the
//     same ids in the same order as `next`, and contains only objects that came
//     from `previous` or `next` (or a spread copy of a `next` node carrying a
//     `measured` value forward). Reconciliation never adds, drops, or reorders a
//     Canvas_Element (Req 4.1, 4.2, 4.3).
//  2. **Measured dimensions survive a rebuild** — when the previous node for an
//     id had `measured`, the output node for that id carries those same width and
//     height values (Req 4.1).
//  3. **New ids start clean** — an id absent from `previous` keeps whatever
//     `measured` it arrived with (normally none, since it renders on its
//     Declared_Dimensions) and can never receive `measured` belonging to another
//     id (Req 4.3).
//  4. **Unchanged nodes keep their object identity** — when `id`, `type`,
//     `position`, `measured` (after carry-over), `hidden`, and `data.fingerprint`
//     all agree, the output element is referentially the previous object, so
//     React Flow retains its internal record: no re-observe, no re-measure, no
//     contribution to the per-frame observation budget (Req 4.2).
//  5. **Idempotent** — reconciling the output against `next` again yields
//     referentially equal elements, so a rebuild that changes nothing produces no
//     new node identities at all (Req 4.2).
//
// Retention is keyed off the `previous` array ONLY — there is deliberately no
// module-level or closure cache. An id that leaves the array takes its retained
// `measured` with it, so a later Canvas_Element reusing the same Element_Key is
// measured afresh (Req 4.4).
//
// Pure and total: neither input array nor any node object in them is mutated.
// Carrying `measured` onto a `next` node produces a new object via spread.
//
// Node ids are assumed unique within each array, as `@xyflow/react` requires.

export interface Measured {
  width?: number;
  height?: number;
}

export interface ReconcilableNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  measured?: Measured;
  hidden?: boolean;
  data: { fingerprint: string } & Record<string, unknown>;
}

/** Value equality for a `measured` slot, treating absence as a distinct state. */
function sameMeasured(a: Measured | undefined, b: Measured | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.width === b.width && a.height === b.height;
}

/**
 * Reconcile a freshly built Node_Array against the previous one.
 *
 * @param previous the Node_Array currently held by `@xyflow/react`
 * @param next     the Node_Array just built from current data
 * @returns an array with the ids of `next`, in the order of `next`, reusing the
 *          previous object for every unchanged node and carrying each previously
 *          measured node's dimensions forward onto its replacement
 */
export function reconcileCanvasNodes<T extends ReconcilableNode>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  if (previous.length === 0) return next.slice();

  const byId = new Map<string, T>();
  for (const node of previous) byId.set(node.id, node);

  return next.map((incoming) => {
    const prior = byId.get(incoming.id);
    // A new id: no retained measurement exists for it, and it must never inherit
    // one from another id (Req 4.3). A removed id simply never appears here,
    // which is how its retention is dropped (Req 4.4).
    if (prior === undefined) return incoming;

    // Carry the previous measurement forward (Req 4.1). When the previous node
    // had none, the incoming node's own value stands.
    const measured = prior.measured !== undefined ? prior.measured : incoming.measured;

    const unchanged =
      prior.type === incoming.type &&
      prior.position.x === incoming.position.x &&
      prior.position.y === incoming.position.y &&
      sameMeasured(prior.measured, measured) &&
      prior.hidden === incoming.hidden &&
      prior.data.fingerprint === incoming.data.fingerprint;

    // Referential reuse is the whole point: it is the only thing that makes
    // React Flow keep the internal record it already built (Req 4.2).
    if (unchanged) return prior;

    if (measured === incoming.measured) return incoming;
    return { ...incoming, measured };
  });
}
