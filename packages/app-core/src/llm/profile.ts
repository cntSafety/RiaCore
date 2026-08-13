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
 * Pure Review_Profile resolution helpers (worker side).
 *
 * Maps the namespace metamodel string to the corresponding
 * {@link LlmReviewProfile}. The renderer-side mirror in
 * `apps/renderer/src/lib/reviewProfile.ts` MUST match these semantics
 * byte-for-byte; cross-side equivalence is asserted by Property 5 in the
 * design document.
 *
 * Pure: no I/O, no logging, no globals.
 *
 * @see Requirement 13.1, 13.4
 */

import type { LlmReviewProfile } from '@riacore/app-contracts';

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
