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
 * config-loader.ts — YAML-based import configuration for the ARXML importer.
 *
 * Reads `arxml-import-config.yaml`, applies defaults for missing fields,
 * and resolves file include/exclude glob patterns against a project directory.
 *
 * Uses only Node.js built-ins and the `yaml` package.
 *
 * Reused from importer/arxml/arxml-src/config-loader.ts with no logic changes.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface EnabledCategories {
  swc_types: boolean;
  ports: boolean;
  port_interfaces: boolean;
  data_types: boolean;
  swc_behavior: boolean;
  bsw_modules: boolean;
  connectors: boolean;
  communication: boolean;
  system: boolean;
  ecuc: boolean;
}

export interface FileSelection {
  include: string[];
  exclude: string[];
}

export interface ImportConfig {
  base_url: string;
  namespace: string;
  source_name?: string;
  project_dir?: string;
  files: FileSelection;
  elements: EnabledCategories;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_ENABLED_CATEGORIES: EnabledCategories = {
  swc_types: true,
  ports: true,
  port_interfaces: true,
  data_types: true,
  swc_behavior: true,
  bsw_modules: true,
  connectors: true,
  communication: true,
  system: true,
  ecuc: true,
};

const DEFAULT_FILE_SELECTION: FileSelection = {
  include: ['**/*.arxml'],
  exclude: [],
};

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_NAMESPACE = 'ARXMLProject';
const DEFAULT_CONFIG_FILENAME = 'arxml-import-config.yaml';

// ── Config loader ─────────────────────────────────────────────────────────────

/**
 * Load import configuration from a YAML file.
 *
 * - If `configPath` is provided and exists, reads that file.
 * - If `configPath` is not provided, looks for `arxml-import-config.yaml` in the CWD.
 * - If the file doesn't exist, returns defaults (all categories true,
 *   include: `["**\/*.arxml"]`, base_url: `"http://localhost:8080"`, namespace: `"ARXMLProject"`).
 * - Missing fields in a partial config are filled with defaults.
 */
export function loadImportConfig(configPath?: string): ImportConfig {
  const resolvedPath = configPath ?? join(process.cwd(), DEFAULT_CONFIG_FILENAME);

  if (!existsSync(resolvedPath)) {
    return {
      base_url: DEFAULT_BASE_URL,
      namespace: DEFAULT_NAMESPACE,
      files: { ...DEFAULT_FILE_SELECTION, exclude: [] },
      elements: { ...DEFAULT_ENABLED_CATEGORIES },
    };
  }

  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};

  const elements: EnabledCategories = { ...DEFAULT_ENABLED_CATEGORIES };
  if (parsed.elements && typeof parsed.elements === 'object') {
    for (const key of Object.keys(DEFAULT_ENABLED_CATEGORIES) as Array<keyof EnabledCategories>) {
      if (key in parsed.elements && typeof parsed.elements[key] === 'boolean') {
        elements[key] = parsed.elements[key];
      }
    }
  }

  const files: FileSelection = { ...DEFAULT_FILE_SELECTION, exclude: [] };
  if (parsed.files && typeof parsed.files === 'object') {
    if (Array.isArray(parsed.files.include) && parsed.files.include.length > 0) {
      files.include = parsed.files.include.map(String);
    }
    if (Array.isArray(parsed.files.exclude)) {
      files.exclude = parsed.files.exclude.map(String);
    }
  }

  return {
    base_url: typeof parsed.base_url === 'string' ? parsed.base_url : DEFAULT_BASE_URL,
    namespace: typeof parsed.namespace === 'string' ? parsed.namespace : DEFAULT_NAMESPACE,
    source_name: typeof parsed.source_name === 'string' ? parsed.source_name : undefined,
    project_dir: typeof parsed.project_dir === 'string' ? parsed.project_dir : undefined,
    files,
    elements,
  };
}

// ── Glob matching ─────────────────────────────────────────────────────────────

/** Characters that need escaping in a regular expression. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(REGEX_SPECIAL, (ch) => '\\' + ch);
}

/**
 * Simple glob matcher supporting:
 *   - `**` matches any number of path segments (including zero)
 *   - `*`  matches any characters within a single path segment
 *
 * Patterns are matched against forward-slash-normalised relative paths.
 */
function globMatch(pattern: string, filePath: string): boolean {
  const normPath = filePath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');

  // Build regex: split on '**' boundaries, handle each segment
  let regexStr = '';
  const parts = normPattern.split('**');

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    // Convert single * to [^/]* and escape the rest
    const segRegex = segment
      .split('*')
      .map((s) => escapeRegex(s))
      .join('[^/]*');
    regexStr += segRegex;

    // Insert '**' replacement between parts (not after the last)
    if (i < parts.length - 1) {
      // ** matches zero or more path segments
      // If next segment starts with /, make the whole ** + / match optional
      const next = parts[i + 1];
      if (next.startsWith('/')) {
        regexStr += '(?:.*/)?';
        // Remove the leading / from the next segment so it's not doubled
        parts[i + 1] = next.slice(1);
      } else {
        regexStr += '.*';
      }
    }
  }

  const endAnchor = String.fromCharCode(36); // '$'
  const regex = new RegExp('^' + regexStr + endAnchor);
  return regex.test(normPath);
}

// ── File resolution ───────────────────────────────────────────────────────────

/**
 * Recursively collect all `.arxml` files under `dir`, returning absolute paths.
 * Skips `node_modules` and hidden directories to avoid unnecessary traversal.
 */
function collectArxmlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectArxmlFiles(full));
      } else if (stat.isFile() && extname(entry).toLowerCase() === '.arxml') {
        results.push(full);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return results;
}

/**
 * Resolve files in `projectDir` matching the include patterns and not matching
 * exclude patterns. Returns absolute file paths.
 */
export function resolveFiles(projectDir: string, selection: FileSelection): string[] {
  const absDir = resolve(projectDir);
  const arxmlFiles = collectArxmlFiles(absDir);

  const matched: string[] = [];

  for (const absFile of arxmlFiles) {
    const relPath = relative(absDir, absFile).replace(/\\/g, '/');

    const included = selection.include.some((pattern) => globMatch(pattern, relPath));
    if (!included) continue;

    const excluded = selection.exclude.some((pattern) => globMatch(pattern, relPath));
    if (excluded) continue;

    matched.push(absFile);
  }

  return matched;
}
