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
 * Canonical JSON serialization for the Persistor feature.
 *
 * Provides deterministic, git-friendly serialization of graph table records:
 * - Keys sorted alphabetically
 * - JSON-string columns inlined as nested objects
 * - Ephemeral/omitted columns excluded
 * - One record per line within a JSON array
 * - Trailing newline
 */

/**
 * Parse a JSON string, falling back to the raw string when it is not valid JSON.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // If parsing fails, keep the raw string value
    return value;
  }
}

/**
 * Serialize a single record into a single-line JSON string.
 *
 * - Keys are sorted alphabetically
 * - Columns in omitColumns are excluded
 * - Columns in jsonColumns are parsed from JSON strings and inlined as nested objects
 */
export function serializeRecord(
  record: Record<string, unknown>,
  jsonColumns: string[],
  omitColumns: string[]
): string {
  const omitSet = new Set(omitColumns);
  const jsonSet = new Set(jsonColumns);

  // Build a new object with omitted columns removed and JSON columns inlined
  const processed = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (omitSet.has(key)) continue;

    const value = record[key];
    if (jsonSet.has(key)) {
      // A JSON column arrives as a string from the DB and as an already-parsed
      // object from parseTable, so both shapes must be handled here. Either way
      // the inlined value is deep-sorted: sorting only the top-level keys (as
      // this function used to) leaves the serialized bytes dependent on the key
      // order of whatever produced the attributes. Round-trips are stable
      // regardless, because the file preserves the order it was written with;
      // the exposure is a writer that emits a different order — a new importer,
      // a changed JSON.stringify call site, a Kuzu version returning a JSON
      // column differently — which would shift every derived hash with no
      // semantic change, causing spurious re-exports and spurious diffs. The
      // namespace hash is a digest over these exact serialized bytes, so this
      // determinism is load-bearing rather than cosmetic.
      processed[key] = deepSortKeys(
        typeof value === "string" ? tryParseJson(value) : value
      );
    } else {
      processed[key] = value;
    }
  }

  // Sort keys alphabetically and produce a single-line JSON string
  const sortedKeys = Object.keys(processed).sort();
  const sortedObj = Object.create(null) as Record<string, unknown>;
  for (const key of sortedKeys) {
    sortedObj[key] = processed[key];
  }

  return JSON.stringify(sortedObj);
}

/**
 * Serialize a list of records into the canonical file format:
 *
 * ```
 * [
 * {"key": "value", ...},
 * {"key": "value", ...}
 * ]
 * ```
 *
 * - Opening `[` on its own line
 * - One record per line (each a single-line JSON object)
 * - Closing `]` on its own line
 * - Trailing newline
 * - Records sorted ascending by sortKey, then by all remaining keys for stability
 */
export function serializeTable(
  records: Record<string, unknown>[],
  sortKey: string,
  jsonColumns: string[],
  omitColumns: string[]
): string {
  const omitSet = new Set(omitColumns);
  const jsonSet = new Set(jsonColumns);

  // Comparison values must be canonical, not raw.
  //
  // A JSON column arrives as whatever string its writer produced, and
  // `String(value)` on that string makes the record order depend on the
  // column's incoming key order. That is not stable across a store → load →
  // store cycle: load reconstructs the column from the file, where
  // `serializeRecord` already deep-sorted it, so the second store sees a
  // different string for semantically identical content and emits the records
  // in a different order. The files are then byte-different from the ones the
  // first store wrote, with no change in content.
  //
  // That used to be invisible, because the namespace hash was computed from
  // records and re-sorted them itself. Now that the hash is a digest over the
  // written bytes, an unstable order is an unreproducible hash: the recorded
  // value cannot be recomputed from the files, and store and load disagree.
  //
  // So JSON columns are compared by the same deep-sorted, stringified form
  // `serializeRecord` emits. The order is then a function of the bytes, which
  // is exactly the property the byte-based hash needs.
  // Canonicalizing a JSON column means parsing and re-stringifying it, so the
  // result is memoized per record: the comparator is called O(n log n) times.
  const canonCache = new Map<Record<string, unknown>, Map<string, string>>();
  const canon = (record: Record<string, unknown>, key: string): string => {
    let perRecord = canonCache.get(record);
    if (!perRecord) {
      perRecord = new Map();
      canonCache.set(record, perRecord);
    }
    const hit = perRecord.get(key);
    if (hit !== undefined) return hit;

    const value = record[key];
    const result = JSON.stringify(
      deepSortKeys(typeof value === 'string' ? tryParseJson(value) : value)
    );
    perRecord.set(key, result);
    return result;
  };
  /**
   * `nullishAsEmpty` preserves the two call sites' pre-existing difference: the
   * primary sort key has already had `undefined` handled by the caller and
   * stringifies `null` as `"null"`, while the tie-break collapses both to `''`.
   */
  const cmp = (
    record: Record<string, unknown>,
    key: string,
    nullishAsEmpty: boolean,
  ): string => {
    if (jsonSet.has(key)) return canon(record, key);
    return nullishAsEmpty ? String(record[key] ?? '') : String(record[key]);
  };

  // Sort records by the sortKey ascending, then by all remaining columns
  // alphabetically to guarantee a fully deterministic order even when
  // multiple records share the same primary sort key.
  const sorted = [...records].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal === undefined && bVal === undefined) { /* fall through */ }
    else if (aVal === undefined) return 1;
    else if (bVal === undefined) return -1;
    else {
      const aStr = cmp(a, sortKey, false);
      const bStr = cmp(b, sortKey, false);
      if (aStr < bStr) return -1;
      if (aStr > bStr) return 1;
    }

    // Tie-break: compare remaining columns alphabetically
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const secondaryKeys = [...allKeys]
      .filter(k => k !== sortKey && !omitSet.has(k))
      .sort();
    for (const key of secondaryKeys) {
      const aStr = cmp(a, key, true);
      const bStr = cmp(b, key, true);
      if (aStr < bStr) return -1;
      if (aStr > bStr) return 1;
    }
    return 0;
  });

  if (sorted.length === 0) return "[]\n";

  const recordLines = sorted.map(record => serializeRecord(record, jsonColumns, omitColumns));
  return "[\n" + recordLines.join(",\n") + "\n]\n";
}

/**
 * Parse the canonical file format back into an array of record objects.
 *
 * JSON-string columns are NOT re-stringified here — they remain as parsed
 * objects (the caller handles reconstruction if needed).
 */
export function parseTable(content: string): Record<string, unknown>[] {
  const trimmed = content.trim();
  if (!trimmed || trimmed === "[]") return [];

  // Parse the outer JSON array
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("parseTable: expected a JSON array");
  }

  return parsed as Record<string, unknown>[];
}

/**
 * Deep-sort the keys of an object alphabetically (recursive).
 *
 * Arrays keep their element order — it is semantic — but every object nested
 * inside them is sorted. Non-object values pass through unchanged, which is what
 * lets a failed JSON parse carry its raw string through untouched.
 */
export function deepSortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  // Null prototype, not `{}`: assigning `result['__proto__']` on an ordinary
  // object hits the inherited accessor and sets the prototype instead of
  // defining an own property, so the key vanishes from `Object.keys` and from
  // `JSON.stringify`. `JSON.parse` admits it as an own property, so a document
  // carrying one would be silently truncated here and then hashed as complete.
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of sortedKeys) {
    result[key] = deepSortKeys(obj[key]);
  }
  return result;
}

/**
 * Serialize a single metadata object (for `manifest.json`).
 *
 * - Keys sorted alphabetically (deep sort)
 * - Pretty-printed with 2-space indent
 * - Trailing newline
 */
export function serializeMetadata(obj: Record<string, unknown>): string {
  const sorted = deepSortKeys(obj) as Record<string, unknown>;
  return JSON.stringify(sorted, null, 2) + "\n";
}
