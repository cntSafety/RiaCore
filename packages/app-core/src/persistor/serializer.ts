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
  const processed: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (omitSet.has(key)) continue;

    const value = record[key];
    if (jsonSet.has(key) && typeof value === "string") {
      try {
        processed[key] = JSON.parse(value);
      } catch {
        // If parsing fails, keep the raw string value
        processed[key] = value;
      }
    } else {
      processed[key] = value;
    }
  }

  // Sort keys alphabetically and produce a single-line JSON string
  const sortedKeys = Object.keys(processed).sort();
  const sortedObj: Record<string, unknown> = {};
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
      const aStr = String(aVal);
      const bStr = String(bVal);
      if (aStr < bStr) return -1;
      if (aStr > bStr) return 1;
    }

    // Tie-break: compare remaining columns alphabetically
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const secondaryKeys = [...allKeys]
      .filter(k => k !== sortKey && !omitSet.has(k))
      .sort();
    for (const key of secondaryKeys) {
      const aStr = String(a[key] ?? '');
      const bStr = String(b[key] ?? '');
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
 */
function deepSortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = deepSortKeys(obj[key]);
  }
  return result;
}

/**
 * Serialize a single metadata object (for `namespace.json`, `manifest.json`).
 *
 * - Keys sorted alphabetically (deep sort)
 * - Pretty-printed with 2-space indent
 * - Trailing newline
 */
export function serializeMetadata(obj: Record<string, unknown>): string {
  const sorted = deepSortKeys(obj) as Record<string, unknown>;
  return JSON.stringify(sorted, null, 2) + "\n";
}
