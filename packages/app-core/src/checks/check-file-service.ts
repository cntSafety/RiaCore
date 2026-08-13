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
 * Reads, validates, and filters user-defined checks from
 * `{workingDir}/ria-data/checks.json`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { UserCheckDefinition, ApplicableCheck } from '@riacore/app-contracts';
import { resolveAttributeKey } from '@riacore/app-contracts';

// ── Zod schema ───────────────────────────────────────────────────────────────

const CheckSeveritySchema = z.enum(['Error', 'Warning', 'Hint']);

/**
 * Each attribute entry is either:
 *   - a non-empty string (key = label), or
 *   - a single-key object { attributeKey: "Display Label" } (key ≠ label alias).
 */
const AttributeEntrySchema = z.union([
  z.string().min(1, 'attribute key must be a non-empty string'),
  z
    .record(z.string().min(1), z.string().min(1))
    .refine((obj) => Object.keys(obj).length === 1, {
      message: 'attribute alias object must have exactly one key',
    }),
]);

const UserCheckDefinitionSchema = z.object({
  id: z.string().min(1, 'id must be a non-empty string'),
  name: z.string().min(1, 'name must be a non-empty string'),
  description: z.string().default(''),
  severity: CheckSeveritySchema,
  query: z.string().min(1, 'query must be a non-empty string'),
  attributes: z.array(AttributeEntrySchema),
  category: z.string().default(''),
  /**
   * Empty array means the check applies to every namespace regardless of
   * metamodel.  A non-empty array is treated as an allowlist.
   */
  metamodel: z.array(z.string().min(1)).default([]),
  active: z.boolean(),
});

const CheckFileSchema = z.object({
  checks: z.array(UserCheckDefinitionSchema),
});

// ── Forbidden write keywords ──────────────────────────────────────────────────

const WRITE_KEYWORD_RE = /\b(CREATE|MERGE|DELETE|DETACH|SET|DROP|ALTER|CALL|LOAD\s+CSV|IMPORT\s+DATABASE)\b/i;

/**
 * Returns a reason string if the query contains write keywords, or null if the
 * query appears read-only.
 */
export function detectWriteOperation(query: string): string | null {
  const match = query.match(WRITE_KEYWORD_RE);
  if (match) {
    return `Query contains forbidden keyword: ${match[0]}`;
  }
  return null;
}

// ── File path ────────────────────────────────────────────────────────────────

export function checksFilePath(workingDir: string): string {
  return path.join(workingDir, 'ria-data', 'checks.json');
}

// ── Load + validate ──────────────────────────────────────────────────────────

export interface LoadChecksResult {
  checks: UserCheckDefinition[];
  /** Non-fatal validation warnings (e.g. a single invalid check skipped). */
  warnings: string[];
}

/**
 * Reads `{workingDir}/ria-data/checks.json`, validates its structure, and
 * returns all checks that are syntactically valid.
 *
 * - If the file does not exist, returns an empty list (not an error).
 * - If the file exists but cannot be parsed as JSON or fails schema validation
 *   at the top level, returns an error.
 * - Individual check entries that fail validation are skipped with a warning.
 */
export async function loadChecksFromFile(workingDir: string): Promise<LoadChecksResult> {
  const filePath = checksFilePath(workingDir);

  // File does not exist → return empty, no error
  if (!fs.existsSync(filePath)) {
    return { checks: [], warnings: [] };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read checks file at ${filePath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`checks.json is not valid JSON at ${filePath}`);
  }

  // Validate top-level structure
  const topLevel = z.object({ checks: z.array(z.unknown()) }).safeParse(parsed);
  if (!topLevel.success) {
    throw new Error(`checks.json must have a top-level "checks" array: ${topLevel.error.message}`);
  }

  const checks: UserCheckDefinition[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < topLevel.data.checks.length; i++) {
    const entry = topLevel.data.checks[i];
    const result = UserCheckDefinitionSchema.safeParse(entry);
    if (!result.success) {
      warnings.push(`Check at index ${i} skipped (validation failed): ${result.error.message}`);
      continue;
    }
    const checkDef = result.data as UserCheckDefinition;

    // Validate read-only query
    const writeReason = detectWriteOperation(checkDef.query);
    if (writeReason) {
      warnings.push(`Check "${checkDef.id}" skipped: ${writeReason}`);
      continue;
    }

    // Ensure IDs are unique within the file
    if (checks.some(c => c.id === checkDef.id)) {
      warnings.push(`Check at index ${i} skipped: duplicate id "${checkDef.id}"`);
      continue;
    }

    checks.push(checkDef);
  }

  return { checks, warnings };
}

// ── Applicability filter ─────────────────────────────────────────────────────

/**
 * Filters a list of check definitions to those applicable to the given
 * namespace metamodel.
 *
 * A check is applicable when:
 * 1. `active` is true, AND
 * 2. The check's `metamodel` array is empty (applies to all namespaces), OR
 *    the namespace's metamodel string appears in the check's `metamodel` array.
 *
 * The returned objects omit the raw `query` field (not needed by the frontend).
 */
export function filterApplicableChecks(
  checks: UserCheckDefinition[],
  namespaceMetamodel: string,
): ApplicableCheck[] {
  return checks
    .filter(
      c =>
        c.active &&
        (c.metamodel.length === 0 || c.metamodel.includes(namespaceMetamodel)),
    )
    .map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      severity: c.severity,
      attributes: c.attributes,
      category: c.category,
      metamodel: c.metamodel,
    }));
}

/**
 * Looks up a single check definition by ID.
 * Returns undefined when not found.
 */
export function findCheckById(
  checks: UserCheckDefinition[],
  id: string,
): UserCheckDefinition | undefined {
  return checks.find(c => c.id === id);
}

// ── Check selection persistence ───────────────────────────────────────────────

/**
 * Sanitizes a namespace name for safe use as a filename component.
 * Replaces any character that is not alphanumeric, a dash, or an underscore
 * with an underscore to prevent path traversal.
 */
function sanitizeForFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Returns the path for the check-selection config file for a given namespace.
 * Stored at: {workingDir}/ria-config/check-selection/{sanitized-namespace}.json
 */
export function checkSelectionFilePath(workingDir: string, namespace: string): string {
  const safeName = sanitizeForFilename(namespace);
  return path.join(workingDir, 'ria-config', 'check-selection', `${safeName}.json`);
}

/**
 * Loads the persisted check selection for a namespace.
 * Returns null when no selection file exists yet.
 * Throws only on unexpected I/O or parse errors.
 */
export async function loadCheckSelection(
  workingDir: string,
  namespace: string,
): Promise<string[] | null> {
  const filePath = checkSelectionFilePath(workingDir, namespace);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read check selection at ${filePath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file — treat as no saved selection
    return null;
  }

  const schema = z.object({ selectedCheckIds: z.array(z.string()) });
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return result.data.selectedCheckIds;
}

/**
 * Persists the given check selection for a namespace to
 * {workingDir}/ria-config/check-selection/{namespace}.json.
 * Creates parent directories as needed.
 */
export async function saveCheckSelection(
  workingDir: string,
  namespace: string,
  selectedIds: string[],
): Promise<void> {
  const filePath = checkSelectionFilePath(workingDir, namespace);
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const content = JSON.stringify({ selectedCheckIds: selectedIds }, null, 2);
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

// ── Check summary persistence ─────────────────────────────────────────────────

/**
 * Internal on-disk format for the check summary.
 * Includes a node count snapshot used to detect namespace content changes.
 */
interface CheckSummaryFileData {
  namespace: string;
  runTimestamp: string;
  errors: number;
  warnings: number;
  hints: number;
  checksRun: number;
  /** Count of concept instance nodes in the namespace at the time of the run. */
  nodeCountSnapshot: number;
}

const CheckSummaryFileSchema = z.object({
  namespace: z.string(),
  runTimestamp: z.string(),
  errors: z.number().int().min(0),
  warnings: z.number().int().min(0),
  hints: z.number().int().min(0),
  checksRun: z.number().int().min(0),
  nodeCountSnapshot: z.number().int().min(0),
});

/**
 * Returns the path for the check-summary file for a given namespace.
 * Stored at: {workingDir}/ria-config/check-summary/{sanitized-namespace}.json
 */
export function checkSummaryFilePath(workingDir: string, namespace: string): string {
  const safeName = sanitizeForFilename(namespace);
  return path.join(workingDir, 'ria-config', 'check-summary', `${safeName}.json`);
}

/**
 * Loads the persisted check summary for a namespace.
 * Returns null when no summary file exists or the file is invalid.
 */
export async function loadCheckSummaryFromFile(
  workingDir: string,
  namespace: string,
): Promise<CheckSummaryFileData | null> {
  const filePath = checkSummaryFilePath(workingDir, namespace);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = CheckSummaryFileSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return result.data;
}

/**
 * Persists a check summary for a namespace.
 * Creates parent directories as needed.
 */
export async function saveCheckSummaryToFile(
  workingDir: string,
  data: CheckSummaryFileData,
): Promise<void> {
  const filePath = checkSummaryFilePath(workingDir, data.namespace);
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const content = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

export type { CheckSummaryFileData };
