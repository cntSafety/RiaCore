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
 * Pure Review_Profile resolution helpers (renderer side).
 *
 * Mirror of the worker-side helpers in
 * `packages/app-core/src/llm/profile.ts`. The two implementations MUST stay
 * semantically identical; cross-side equivalence is asserted by Property 5
 * in the design document (kept in sync by the Property 5 cross-test).
 *
 * Pure: no I/O, no logging, no globals, no React imports.
 *
 * @see Requirement 4.1, 4.2, 4.3, 4.4, 4.5, 13.2, 13.4
 */

import type { LlmReviewProfile } from '@riacore/app-contracts';

// Inline copies of the concept arrays from `@riacore/app-contracts`.
// We cannot use a runtime import of the CJS-compiled package in Vite's
// Rollup build (named CJS exports are not supported). The cross-side
// property test (Property 5) ensures these stay in sync with the canonical
// arrays in `packages/app-contracts/src/llm-types.ts`.
const SWC_COMPONENT_CONCEPTS: readonly string[] = [
  'application_swc',
  'composition_swc',
  'service_swc',
  'ecu_abstraction_swc',
  'cdd_swc',
  'sensor_actuator_swc',
  'nv_block_swc',
  'parameter_swc',
  'service_proxy_swc',
];

const EXCLUDED_GENERAL_REVIEW_CONCEPTS: readonly string[] = [
  'malfunction',
  'safety_note',
  'risk_rating',
  'safety_task',
  'requirement',
  'safety_requirement',
  'review_item',
  'tag',
  'namespace',
  'sentinel',
];

/**
 * Mapping from namespace metamodel string to {@link LlmReviewProfile}.
 *
 * Only the two metamodels listed here support an LLM Review_Run today.
 * Any other metamodel resolves to `null` via {@link resolveReviewProfile}.
 */
export const REVIEW_PROFILE_BY_METAMODEL = {
  SW_ARXML: 'sw_arxml',
  SysMLv2: 'system_sysml',
  SysMLv2Textual: 'system_sysml',
} as const satisfies Record<string, LlmReviewProfile>;

/**
 * Resolve the Review_Profile for a namespace metamodel.
 *
 * Returns:
 * - `'sw_arxml'`     when `metamodel === 'SW_ARXML'`
 * - `'system_sysml'` when `metamodel === 'SysMLv2'`
 * - `null`           for every other input (including the empty string)
 *
 * Total, deterministic, and free of side effects.
 */
export function resolveReviewProfile(metamodel: string): LlmReviewProfile | null {
  // Own-property check only: a plain-object lookup would inherit from
  // Object.prototype and resolve inputs like 'valueOf' or 'toString' to the
  // prototype member instead of null.
  if (!Object.prototype.hasOwnProperty.call(REVIEW_PROFILE_BY_METAMODEL, metamodel)) {
    return null;
  }
  return (REVIEW_PROFILE_BY_METAMODEL as Record<string, LlmReviewProfile | undefined>)[metamodel] ?? null;
}

/**
 * Decide whether a tree node is eligible for the "Initial LLM review" entry
 * given its namespace metamodel and its concept.
 *
 * Returns `true` iff:
 * - `metamodel === 'SW_ARXML'` AND `concept` is one of {@link SWC_COMPONENT_CONCEPTS}; or
 * - `metamodel` is a SysML v2 variant AND `concept` can host safety data.
 *
 * Returns `false` for every other `(metamodel, concept)` pair, including
 * unknown metamodels, safety-element concepts, and intermediate
 * package/container concepts.
 *
 * Total, deterministic, and free of side effects.
 */
export function isLlmReviewEligible(metamodel: string, concept: string): boolean {
  if (metamodel === 'SW_ARXML') {
    return (SWC_COMPONENT_CONCEPTS as readonly string[]).includes(concept);
  }
  if (metamodel === 'SysMLv2' || metamodel === 'SysMLv2Textual') {
    return concept.length > 0 && !(EXCLUDED_GENERAL_REVIEW_CONCEPTS as readonly string[]).includes(concept);
  }
  return false;
}
