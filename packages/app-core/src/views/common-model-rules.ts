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
 * Evaluation validation rules that belong to the `CommonModel` metamodel
 * itself, as distinct from the generic typing checks every view gets
 * (docs/coreSpecs/RiaViews.md — "Ownership direction constraint").
 *
 * These are applied only to views whose immediate metamodel is
 * {@link COMMON_MODEL_METAMODEL}; a view typed by any other metamodel is
 * validated by the generic rules alone.
 */

export const COMMON_MODEL_METAMODEL = 'COMMON_MODEL';

/**
 * The permitted `Ownership` source/target concept pairs, verbatim from
 * RiaViews.md.
 *
 * This stays an explicit table rather than being derived from the registered
 * metamodel, because the whole point of the abstract `Element` supertype is
 * that the type system does *not* encode this: `Ownership` is typed
 * `Element -> Element`, so every pair below and every disallowed one alike
 * satisfies the declared relationship. RiaViews.md calls this out as "a
 * mapping obligation and an evaluation validation rule, not a typing rule",
 * and this constant is that rule.
 *
 * Notably absent, and deliberately so:
 *   ActiveElement -> StructuralElement  (no)
 *   ActiveElement -> Requirement        (no — use `Implements`)
 *   Requirement   -> anything           (no — use `Refinement`)
 */
export const OWNERSHIP_PERMITTED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['StructuralElement', 'StructuralElement'],
  ['StructuralElement', 'ActiveElement'],
  ['StructuralElement', 'Requirement'],
  ['ActiveElement', 'ActiveElement'],
];

const PERMITTED = new Set(OWNERSHIP_PERMITTED_PAIRS.map(([from, to]) => `${from}->${to}`));

/**
 * Whether an `Ownership` edge between two known concepts is permitted.
 *
 * Callers pass `undefined` for an endpoint whose concept is not part of the
 * current evaluation result — which happens legitimately in traversal mode,
 * where the start representatives are held by the consumer rather than
 * returned again. Such an edge is accepted here: the endpoint was validated
 * when it was itself resolved, and re-reporting it would turn every ordinary
 * traversal into a stream of diagnostics.
 */
export function isPermittedOwnership(sourceConcept?: string, targetConcept?: string): boolean {
  if (sourceConcept === undefined || targetConcept === undefined) return true;
  return PERMITTED.has(`${sourceConcept}->${targetConcept}`);
}
