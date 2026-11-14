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
 * Value encoding and result comparison for dual-engine mode.
 *
 * `encodeValue` / `decodeValue` turn the values the bindings accept and return
 * (bigint, Date, Map, byte arrays, nested lists and structs) into plain JSON
 * and back without loss, so statements, parameters and results written to a
 * mismatch record replay with exactly the same types.
 *
 * `compareResults` decides whether two engines answered a statement the same:
 *
 *  - rows are compared as a multiset — row order is not part of the answer
 *    unless the statement says ORDER BY, and even then the engines are only
 *    compared on content (decided for the RiaGraph maturity campaign);
 *  - keys the engine generates from its storage layout (`_id`, `_src`, `_dst`
 *    by default) are left out at every nesting level;
 *  - everything else must match exactly: types, numbers bit-for-bit, strings,
 *    nulls, column names.
 *
 * A difference that disappears once nested lists are also compared as
 * multisets (e.g. `collect()` without ORDER BY) is reported as `orderOnly`
 * rather than as a mismatch.
 */
import { createHash } from 'node:crypto';
import type { GraphRow } from './graph-engine.js';

// ── Lossless JSON encoding ───────────────────────────────────────────────────

/** Encode a binding value as JSON-safe data. Inverse of {@link decodeValue}. */
export function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'bigint':
      return { $bigint: value.toString() };
    case 'number':
      // String(-0) is "0", so negative zero needs its own spelling.
      if (Object.is(value, -0)) return { $number: '-0' };
      if (Number.isNaN(value) || !Number.isFinite(value)) return { $number: String(value) };
      return value;
    case 'string':
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      return { $unsupported: String(value) };
  }
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [encodeValue(k), encodeValue(v)]) };
  if (Array.isArray(value)) return value.map(encodeValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k.startsWith('$') ? `$${k}` : k] = encodeValue(v);
  }
  return out;
}

/** Decode data produced by {@link encodeValue}. */
export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const [key] = keys;
    const v = obj[key];
    switch (key) {
      case '$bigint': return BigInt(v as string);
      case '$number': return Number(v);
      case '$date': return new Date(v as string);
      case '$bytes': return new Uint8Array(Buffer.from(v as string, 'base64'));
      case '$map': return new Map((v as unknown[][]).map(([k, val]) => [decodeValue(k), decodeValue(val)]));
      default: break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.startsWith('$$') ? k.slice(1) : k] = decodeValue(v);
  }
  return out;
}

// ── Canonical form ───────────────────────────────────────────────────────────

interface CanonicalOptions {
  ignoreKeys: ReadonlySet<string>;
  /** Compare nested lists as multisets too. */
  unorderedLists: boolean;
}

/**
 * Deterministic JSON-safe form of a value: object keys sorted, ignored keys
 * removed, Maps as sorted entry lists, and (optionally) nested lists sorted.
 */
function canonical(value: unknown, opts: CanonicalOptions): unknown {
  const encoded = encodeValue(value);
  return canonicalEncoded(encoded, opts);
}

function canonicalEncoded(value: unknown, opts: CanonicalOptions): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalEncoded(v, opts));
    return opts.unorderedLists ? sortByJson(items) : items;
  }
  const obj = value as Record<string, unknown>;
  if ('$map' in obj && Object.keys(obj).length === 1) {
    const entries = (obj.$map as unknown[][]).map(([k, v]) => [canonicalEncoded(k, opts), canonicalEncoded(v, opts)]);
    return { $map: sortByJson(entries) };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (opts.ignoreKeys.has(key)) continue;
    out[key] = canonicalEncoded(obj[key], opts);
  }
  return out;
}

function sortByJson(items: unknown[]): unknown[] {
  return items
    .map((item) => [JSON.stringify(item), item] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, item]) => item);
}

function rowKeys(rows: GraphRow[], opts: CanonicalOptions): string[] {
  return rows.map((row) => JSON.stringify(canonical(row, opts))).sort();
}

/** Short stable digest of a result set, for journal entries. */
export function digestRows(results: GraphRow[][], ignoreKeys: readonly string[]): string {
  const opts = { ignoreKeys: new Set(ignoreKeys), unorderedLists: false };
  const hash = createHash('sha256');
  for (const rows of results) {
    hash.update(String(rows.length));
    for (const key of rowKeys(rows, opts)) hash.update(key).update('\n');
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

// ── Comparison ───────────────────────────────────────────────────────────────

export interface ResultDiff {
  /** Index into the statement's result list (multi-statement queries return several). */
  resultIndex: number;
  primaryRowCount: number;
  shadowRowCount: number;
  /** Canonical rows the primary returned that the shadow did not (multiset difference). */
  onlyInPrimary: unknown[];
  /** Canonical rows the shadow returned that the primary did not. */
  onlyInShadow: unknown[];
  /** True when the difference lists were cut at {@link MAX_DIFF_ROWS}. */
  truncated: boolean;
}

export type CompareOutcome =
  | { equal: true; orderOnly: boolean }
  | { equal: false; resultCountMismatch?: { primary: number; shadow: number }; diffs: ResultDiff[] };

const MAX_DIFF_ROWS = 50;

function multisetDifference(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  // Both inputs are sorted; walk them like a merge.
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) onlyA.push(a[i++]);
    else if (i >= a.length || b[j] < a[i]) onlyB.push(b[j++]);
    else { i += 1; j += 1; }
  }
  return { onlyA, onlyB };
}

/**
 * Compare the result sets two engines returned for one statement. Each entry
 * of `primary` / `shadow` is the row list of one result (a multi-statement
 * query yields several).
 */
export function compareResults(primary: GraphRow[][], shadow: GraphRow[][], ignoreKeys: readonly string[]): CompareOutcome {
  if (primary.length !== shadow.length) {
    return { equal: false, resultCountMismatch: { primary: primary.length, shadow: shadow.length }, diffs: [] };
  }
  const ignore = new Set(ignoreKeys);
  const strict: CanonicalOptions = { ignoreKeys: ignore, unorderedLists: false };
  const loose: CanonicalOptions = { ignoreKeys: ignore, unorderedLists: true };
  let orderOnly = false;
  const diffs: ResultDiff[] = [];
  for (let index = 0; index < primary.length; index += 1) {
    const p = rowKeys(primary[index], strict);
    const s = rowKeys(shadow[index], strict);
    if (p.length === s.length && p.every((key, k) => key === s[k])) continue;
    const pl = rowKeys(primary[index], loose);
    const sl = rowKeys(shadow[index], loose);
    if (pl.length === sl.length && pl.every((key, k) => key === sl[k])) {
      orderOnly = true;
      continue;
    }
    const { onlyA, onlyB } = multisetDifference(p, s);
    diffs.push({
      resultIndex: index,
      primaryRowCount: p.length,
      shadowRowCount: s.length,
      onlyInPrimary: onlyA.slice(0, MAX_DIFF_ROWS).map((k) => JSON.parse(k)),
      onlyInShadow: onlyB.slice(0, MAX_DIFF_ROWS).map((k) => JSON.parse(k)),
      truncated: onlyA.length > MAX_DIFF_ROWS || onlyB.length > MAX_DIFF_ROWS,
    });
  }
  return diffs.length === 0 ? { equal: true, orderOnly } : { equal: false, diffs };
}

/**
 * Whether `statement` caps its rows (LIMIT) without ordering anything: which
 * rows it returns is then the engine's choice, and two correct engines may
 * choose differently. Quoted text and comments are ignored. Any ORDER BY makes
 * the statement count as ordered (a conservative reading of subqueries).
 */
export function isUnorderedLimit(statement: string): boolean {
  const code = statement
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, "''")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  return /\bLIMIT\b/i.test(code) && !/\bORDER\s+BY\b/i.test(code);
}

/**
 * The same answer shape: as many results, each with as many rows and the same
 * column names. All that two correct engines must agree on for an unordered LIMIT.
 */
export function sameResultShape(primary: GraphRow[][], shadow: GraphRow[][]): boolean {
  const columns = (rows: GraphRow[]) => Object.keys(rows[0] ?? {}).sort().join('\u0000');
  return primary.length === shadow.length
    && primary.every((rows, i) => rows.length === shadow[i].length && columns(rows) === columns(shadow[i]));
}

/**
 * Error text with the parts that legitimately differ between the engines
 * removed: engine names (the fork renamed Lbug to RiaG) and each engine's own
 * database file path.
 */
export function normalizeErrorMessage(message: string, paths: readonly string[]): string {
  let out = message;
  for (const p of [...paths].sort((a, b) => b.length - a.length)) {
    if (p) out = out.split(p).join('<db>');
  }
  return out.replace(/ladybugdb|ladybug|lbug|riagraph|riag/gi, '<engine>').trim();
}
