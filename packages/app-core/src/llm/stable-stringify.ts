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
 * Stable JSON serialization for byte-deterministic prompt assembly.
 *
 * Canonicalizes a JSON-shaped value by sorting object keys alphabetically
 * (lexicographic on UTF-16 code units, matching `Array.prototype.sort`'s
 * default comparator) at every nesting level while preserving the order
 * of array elements, then JSON-serializes the canonicalized value via
 * the platform `JSON.stringify`. The resulting string is byte-identical
 * across calls for any two structurally-equal inputs, regardless of how
 * the input object literals were constructed or how their keys were
 * inserted (Requirements 7.5, 7.6, 7.7).
 *
 * `undefined` is handled exactly like `JSON.stringify`:
 * - In a plain object, a property whose value is `undefined` is dropped.
 * - In an array, an `undefined` element is converted to `null`.
 *
 * Pure: no I/O, no logging, no global state, no mutation of the input.
 *
 * @see Requirement 7.5, 7.6, 7.7
 */

/**
 * Recursively walk a JSON-shaped value and produce a canonical clone:
 * - `null`, `boolean`, `number`, `string` → returned as-is.
 * - `undefined` → returned as-is; callers in array/object context
 *   translate it (array → `null`, object → drop) before recursing.
 * - Array → new array of the same length whose elements are the
 *   canonicalized elements in the same order; `undefined` elements
 *   become `null`.
 * - Plain object → new object whose own enumerable keys are emitted in
 *   lexicographically-ascending order, with each value canonicalized
 *   recursively; properties whose value is `undefined` are dropped.
 *
 * The function is total over JSON-shaped values. Inputs containing
 * functions, symbols, BigInts, class instances with custom prototypes,
 * Maps, Sets, etc. are not part of the supported domain and may produce
 * outputs that mirror `JSON.stringify`'s default handling. Cyclic inputs
 * cause unbounded recursion, mirroring the runtime error raised by
 * `JSON.stringify` for circular structures.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    // string, number, boolean — primitives are immutable and already canonical.
    return value;
  }
  if (Array.isArray(value)) {
    // Preserve order; map `undefined` → `null` to match JSON.stringify
    // semantics for sparse / undefined-bearing arrays.
    return value.map((entry) => (entry === undefined ? null : canonicalize(entry)));
  }
  // Treat any non-array object as a plain object: sort own enumerable keys,
  // drop undefined values, and recurse on the remaining values.
  const source = value as Record<string, unknown>;
  const sortedKeys = Object.keys(source).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const child = source[key];
    if (child === undefined) {
      // JSON.stringify drops object properties whose value is `undefined`.
      continue;
    }
    result[key] = canonicalize(child);
  }
  return result;
}

/**
 * Serialize an arbitrary JSON-shaped value to a string with deterministic
 * key ordering.
 *
 * Two structurally-equal inputs presented with different object key
 * insertion orders SHALL produce byte-identical outputs. Two successive
 * calls with the same input SHALL produce byte-identical outputs.
 *
 * Uses 2-space indentation for readability in both the LLM prompt and
 * the dry-run preview.
 *
 * @param value JSON-shaped value (primitives, arrays, plain objects).
 * @returns The JSON serialization of the canonicalized value, with
 *   object keys sorted alphabetically at every nesting level. Returns
 *   the same value `JSON.stringify` would for unsupported top-level
 *   inputs (`undefined`, functions, symbols).
 *
 * @see Requirement 7.5, 7.6, 7.7
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}
