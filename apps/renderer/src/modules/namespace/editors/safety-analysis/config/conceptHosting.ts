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
 * Concepts that must NOT host malfunctions or safety notes.
 * - Safety-authored concepts: created by the safety editor itself
 * - Infrastructure concepts: namespace roots and pagination sentinels
 */
export const EXCLUDED_CONCEPTS: ReadonlySet<string> = new Set([
  'malfunction',
  'safety_note',
  'risk_rating',
  'safety_task',
  'requirement',
  'review_item',
  'tag',
  'namespace',
  'sentinel',
]);

/**
 * Returns true if the given concept can host malfunctions and safety notes.
 * A concept is eligible unless it appears in the EXCLUDED_CONCEPTS set.
 */
export function canHostCrossNSSafetyElements(concept: string): boolean {
  return !EXCLUDED_CONCEPTS.has(concept);
}
