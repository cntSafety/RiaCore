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
 * cgraph-manifest.ts — reads and gates the generator's run manifest.
 *
 * The manifest is the importer's contract check and its progress oracle. It
 * states the schema version the output was produced against, and the exact node
 * and edge counts per collection — which is what lets preflight compute real
 * progress totals before reading a single data line, and what makes
 * reconciliation at the end a gate rather than a guess.
 *
 * The version gate exists because the schema is vendored. A vendored copy that
 * has fallen behind the generator would otherwise show up as unexplained
 * `skippedElements`, or worse, as attributes quietly landing on the wrong
 * concept. A major mismatch is refused; a minor one is tolerated with a warning,
 * since the schema's own changelog treats minor bumps as additive.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  CGRAPH_SCHEMA_MAJOR,
  CGRAPH_SCHEMA_NAME,
  CGRAPH_SCHEMA_VERSION,
} from './cgraph-schema.js';

export interface CgraphTranslationUnit {
  path: string;
  status: string;
  diagnostic_count?: number;
  duration_ms?: number;
}

export interface CgraphManifest {
  schema: string;
  schema_version: string;
  generator_version?: string;
  build_id?: string;
  generated_at?: string;
  counts: {
    nodes: Record<string, number>;
    edges: Record<string, number>;
  };
  diagnostics?: Record<string, number>;
  translation_units?: CgraphTranslationUnit[];
  totals?: Record<string, number>;
  /**
   * Provenance of the value-analysis facts (schema 2.6.0). The schema names no
   * analyser; this block is what says which tool produced `may_*`/`flows_to`
   * and over which analysis units, so two graphs from different analysers are
   * distinguishable. Absent for pre-2.6 output or a run without value analysis.
   */
  value_analysis?: CgraphValueAnalysis;
}

export interface CgraphAnalysisUnit {
  name: string;
  entry?: string;
  status?: string;
  roots?: string[];
  translation_units?: string[];
  functions_defined?: number;
  functions_reached?: number;
  alarms?: number;
}

export interface CgraphValueAnalysis {
  tool?: string;
  /** The remaining provenance fields (image, machdep, absolute_regions, ...), kept verbatim. */
  settings: Record<string, unknown>;
  units: CgraphAnalysisUnit[];
}

export const MANIFEST_FILENAME = 'manifest.json';
export const NODES_DIRNAME = 'nodes';
export const EDGES_DIRNAME = 'edges';

export function manifestPath(scanResultDir: string): string {
  return path.join(scanResultDir, MANIFEST_FILENAME);
}

export function nodeCollectionPath(scanResultDir: string, concept: string): string {
  return path.join(scanResultDir, NODES_DIRNAME, `${concept}.jsonl`);
}

export function edgeCollectionPath(scanResultDir: string, slot: string): string {
  return path.join(scanResultDir, EDGES_DIRNAME, `${slot}.jsonl`);
}

export function diagnosticsPath(scanResultDir: string): string {
  return path.join(scanResultDir, 'diagnostics.jsonl');
}

function majorOf(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Read the manifest, failing with an actionable message rather than a parse
 * error. Every throw here happens in preflight, before namespace replacement
 * begins, which is the only point at which an import can still be abandoned
 * without having destroyed the previous namespace contents.
 */
export function readManifest(scanResultDir: string): CgraphManifest {
  if (!existsSync(scanResultDir)) {
    throw new Error(`CGraph output directory does not exist: ${scanResultDir}`);
  }
  if (!statSync(scanResultDir).isDirectory()) {
    throw new Error(`CGraph output path is not a directory: ${scanResultDir}`);
  }

  const file = manifestPath(scanResultDir);
  if (!existsSync(file)) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${scanResultDir}. ` +
      'Point scan_result_dir at a CGraph generator output directory ' +
      `(it holds ${MANIFEST_FILENAME}, ${NODES_DIRNAME}/ and ${EDGES_DIRNAME}/).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${file}: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }

  const raw = parsed as Record<string, unknown>;
  const schema = typeof raw.schema === 'string' ? raw.schema : '';
  const schemaVersion = typeof raw.schema_version === 'string' ? raw.schema_version : '';

  if (!schema || !schemaVersion) {
    throw new Error(
      `${file} does not declare "schema" and "schema_version". ` +
      'It does not look like CGraph generator output.',
    );
  }

  const countsRaw = (raw.counts ?? {}) as Record<string, unknown>;
  const counts = {
    nodes: numberMap(countsRaw.nodes),
    edges: numberMap(countsRaw.edges),
  };

  return {
    schema,
    schema_version: schemaVersion,
    generator_version: asString(raw.generator_version),
    build_id: asString(raw.build_id),
    generated_at: asString(raw.generated_at),
    counts,
    diagnostics: numberMap(raw.diagnostics),
    translation_units: Array.isArray(raw.translation_units)
      ? raw.translation_units.filter(isRecord).map((tu) => ({
        path: String(tu.path ?? ''),
        status: String(tu.status ?? ''),
        diagnostic_count: typeof tu.diagnostic_count === 'number' ? tu.diagnostic_count : undefined,
        duration_ms: typeof tu.duration_ms === 'number' ? tu.duration_ms : undefined,
      }))
      : undefined,
    totals: numberMap(raw.totals),
    value_analysis: readValueAnalysis(raw.value_analysis),
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

function readValueAnalysis(value: unknown): CgraphValueAnalysis | undefined {
  if (!isRecord(value)) return undefined;
  const { tool, units, ...settings } = value;
  return {
    tool: asString(tool),
    settings,
    units: Array.isArray(units)
      ? units.filter(isRecord).map((u) => ({
        name: String(u.name ?? ''),
        entry: asString(u.entry),
        status: asString(u.status),
        roots: asStringArray(u.roots),
        translation_units: asStringArray(u.translation_units),
        functions_defined: asNumber(u.functions_defined),
        functions_reached: asNumber(u.functions_reached),
        alarms: asNumber(u.alarms),
      }))
      : [],
  };
}

export interface SchemaGateResult {
  /** Non-fatal mismatch worth telling the user about. */
  warning?: string;
}

/**
 * Compare the manifest's schema against the vendored copy.
 *
 * Throws on a name mismatch or a major-version mismatch. Returns a warning for
 * a minor difference in either direction: ahead means the generator may emit
 * concepts this schema does not describe, behind means some are simply absent.
 */
export function gateSchemaVersion(manifest: CgraphManifest): SchemaGateResult {
  if (manifest.schema !== CGRAPH_SCHEMA_NAME) {
    throw new Error(
      `Unexpected schema "${manifest.schema}" in ${MANIFEST_FILENAME}; ` +
      `this importer reads "${CGRAPH_SCHEMA_NAME}".`,
    );
  }

  const major = majorOf(manifest.schema_version);
  if (major === null) {
    throw new Error(
      `Unreadable schema_version "${manifest.schema_version}" in ${MANIFEST_FILENAME}; ` +
      'expected a MAJOR.MINOR.PATCH value.',
    );
  }

  if (major !== CGRAPH_SCHEMA_MAJOR) {
    throw new Error(
      `CGraph schema version ${manifest.schema_version} is incompatible with this ` +
      `importer, which carries ${CGRAPH_SCHEMA_VERSION}. A major version change ` +
      'alters concepts or identity, so the import is refused rather than ' +
      'producing a partial graph. Update RiaCore, or regenerate with a ' +
      `${CGRAPH_SCHEMA_MAJOR}.x generator.`,
    );
  }

  if (manifest.schema_version !== CGRAPH_SCHEMA_VERSION) {
    return {
      warning:
        `CGraph output declares schema ${manifest.schema_version} but this importer ` +
        `carries ${CGRAPH_SCHEMA_VERSION}. Same major version, so the import ` +
        'proceeds; any concept or relationship the vendored schema does not ' +
        'describe is reported as skipped rather than imported.',
    };
  }

  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}
