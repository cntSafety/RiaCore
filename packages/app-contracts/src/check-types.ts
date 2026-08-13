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
 * Types for the user-defined check engine.
 *
 * Checks are loaded from {workingDir}/ria-data/checks.json.
 * Each check has a Cypher query that returns one integer column named
 * `violation` per row. Each row is one violation.
 *
 * The engine injects $namespace as a query parameter automatically.
 */

export type CheckSeverity = 'Error' | 'Warning' | 'Hint';

/**
 * A single attribute entry in a check's `attributes` list.
 *
 * - **Plain string**: the key is both the attribute property name (used for DB
 *   lookup) and the column header shown to the user.
 *   Example: `"name"`
 * - **Single-key object**: the sole key is the attribute property name and the
 *   value is the human-readable column header (alias) shown to the user.
 *   Example: `{ "malfunction_asil": "ASIL" }`
 */
export type CheckAttributeEntry = string | { readonly [key: string]: string };

/**
 * Extracts the attribute key (used for DB lookup) from an attribute entry.
 * For plain strings this is the string itself; for alias objects it is the
 * sole object key.
 */
export function resolveAttributeKey(entry: CheckAttributeEntry): string {
  if (typeof entry === 'string') return entry;
  const keys = Object.keys(entry);
  return keys[0] ?? '';
}

/**
 * Extracts the display label for an attribute entry.
 * For plain strings the label equals the key; for alias objects it is the
 * value (the alias). Falls back to the key when the alias is absent or empty.
 */
export function resolveAttributeLabel(entry: CheckAttributeEntry): string {
  if (typeof entry === 'string') return entry;
  const key = Object.keys(entry)[0] ?? '';
  const alias = (entry as Record<string, string>)[key];
  return alias && alias.length > 0 ? alias : key;
}

/**
 * A single check definition as stored in checks.json.
 */
export interface UserCheckDefinition {
  /** Stable identifier, unique within the file. */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /**
   * Description of what the check tests, including possible mitigations.
   * May be empty.
   */
  description: string;
  /** Severity level displayed to the user. */
  severity: CheckSeverity;
  /**
   * Cypher query. Must return exactly one integer column named `violation`
   * (the primary node_id of each violation). Each row is one distinct
   * violation. The parameter `$namespace` is automatically injected with
   * the name of the selected namespace.
   *
   * The query must be read-only (no CREATE, MERGE, DELETE, SET, DROP, etc.).
   */
  query: string;
  /**
   * Ordered list of attribute entries to extract from the violation node's
   * `attributes` JSON blob and show as columns in the result table.
   * Each entry is either a plain string (attribute key = column header) or
   * a single-key object `{ attributeKey: "Display Label" }` for aliased
   * column headers. The node's `node_id`, `namespace`, and `concept` are
   * always included and do not need to be listed here.
   */
  attributes: CheckAttributeEntry[];
  /**
   * Category name. Checks with the same category are grouped together in
   * the UI. May be empty string (shown under an uncategorized group).
   */
  category: string;
  /**
   * Subset of metamodel names. The check is applicable to a namespace when
   * the namespace's metamodel is in this list.
   * Must contain at least one entry.
   */
  metamodel: string[];
  /**
   * When false the check is hidden from the UI entirely and never executed.
   */
  active: boolean;
}

/**
 * A check that has been loaded, validated, and confirmed applicable to the
 * current namespace. This is what the frontend receives.
 * (The `query` field is intentionally omitted — the frontend never sees raw Cypher.)
 */
export interface ApplicableCheck {
  id: string;
  name: string;
  description: string;
  severity: CheckSeverity;
  /** Ordered attribute entries for table columns (key or key+alias). */
  attributes: CheckAttributeEntry[];
  category: string;
  metamodel: string[];
}

/**
 * One row in the check result table — a single violation node plus the
 * extracted attribute values for the columns configured in the check.
 */
export interface CheckViolation {
  /** node_id of the primary violation node. */
  nodeId: number;
  /** Namespace the node belongs to. */
  namespace: string;
  /** Concept (type) of the node. */
  concept: string;
  /**
   * Extracted values from the node's `attributes` JSON blob, keyed by the
   * attribute names in `ApplicableCheck.attributes`. Missing keys are
   * represented as null.
   */
  attributeValues: Record<string, string | null>;
}

/**
 * Returned immediately after `checks.runCheck`. Contains the first page of
 * violations plus a run-token for fetching subsequent pages.
 */
export interface CheckRunSummary {
  /** Opaque server-side token for paginating this run's results. */
  runId: string;
  /** ID of the check that was run. */
  checkId: string;
  /** Total number of violation rows (across all pages). */
  totalViolations: number;
  /** First page of violations, pre-loaded for immediate display. */
  firstPage: CheckPageResult;
}

/**
 * Response to `checks.getPage`.
 */
export interface CheckPageResult {
  runId: string;
  page: number;
  pageSize: number;
  totalViolations: number;
  violations: CheckViolation[];
  /** True when there are more pages beyond this one. */
  hasMore: boolean;
}

/**
 * Error result when a check's query fails validation or execution.
 */
export interface CheckRunError {
  checkId: string;
  error: string;
}

/**
 * Aggregated summary of the last check run for a namespace.
 * Stored alongside namespace data and shown on the workspace canvas cards.
 */
export interface NamespaceCheckSummary {
  /** The namespace these results belong to. */
  namespace: string;
  /** ISO timestamp of when the checks were last run. */
  runTimestamp: string;
  /** Total number of Error-severity violations across all checks run. */
  errors: number;
  /** Total number of Warning-severity violations across all checks run. */
  warnings: number;
  /** Total number of Hint-severity violations across all checks run. */
  hints: number;
  /** Number of checks that were executed (including those that found 0 violations). */
  checksRun: number;
  /**
   * True when the check results may no longer reflect the current state of the data.
   * Computed by the backend at load time by comparing the run timestamp against:
   *  - The node count of the namespace at check time vs. now (structural analysis changes)
   *  - The completion timestamp of any import run that completed after the last check
   */
  isOutdated: boolean;
}
