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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SysmlEnabledCategories {
  structure: boolean;
  behavior: boolean;
  features: boolean;
  memberships: boolean;
  imports: boolean;
  /** @deprecated use `behavior` instead */
  actions?: boolean;
  /** @deprecated merged into `features` */
  literals?: boolean;
}

export interface FileSelection {
  include: string[];
  exclude: string[];
}

export interface SysmlImportConfig {
  namespace: string;
  source_name?: string;
  sourceType?: string;
  format?: string;
  project_dir?: string;
  files: FileSelection;
  elements: SysmlEnabledCategories;
}

export const DEFAULT_ENABLED_CATEGORIES: SysmlEnabledCategories = {
  structure: true,
  behavior: true,
  features: true,
  memberships: false,
  imports: true,
};

const DEFAULT_FILE_SELECTION: FileSelection = {
  include: ['**/*.json'],
  exclude: [],
};

const DEFAULT_NAMESPACE = 'SysMLModel';
const DEFAULT_CONFIG_FILENAME = 'sysml-v2-import-config.yaml';

export function loadImportConfig(configPath?: string): SysmlImportConfig {
  const resolvedPath = configPath ?? join(process.cwd(), DEFAULT_CONFIG_FILENAME);

  if (!existsSync(resolvedPath)) {
    return {
      namespace: DEFAULT_NAMESPACE,
      sourceType: 'sysml_v2_json',
      format: 'sysml_v2',
      files: { ...DEFAULT_FILE_SELECTION, exclude: [] },
      elements: { ...DEFAULT_ENABLED_CATEGORIES },
    };
  }

  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};

  const elements: SysmlEnabledCategories = { ...DEFAULT_ENABLED_CATEGORIES };
  if (parsed.elements && typeof parsed.elements === 'object') {
    const canonical: Array<keyof SysmlEnabledCategories> = ['structure', 'behavior', 'features', 'memberships', 'imports'];
    for (const key of canonical) {
      if (key in parsed.elements && typeof parsed.elements[key] === 'boolean') {
        elements[key] = parsed.elements[key];
      }
    }
    // Backward compat: old `actions` maps to `behavior`, old `literals` maps to `features`
    if ('actions' in parsed.elements && typeof parsed.elements.actions === 'boolean' && !('behavior' in parsed.elements)) {
      elements.behavior = parsed.elements.actions;
    }
    if ('literals' in parsed.elements && typeof parsed.elements.literals === 'boolean') {
      // literals was a sub-category of features; if explicitly set, keep features enabled
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
    namespace: typeof parsed.namespace === 'string' ? parsed.namespace : DEFAULT_NAMESPACE,
    source_name: typeof parsed.source_name === 'string' ? parsed.source_name : undefined,
    sourceType: typeof parsed.sourceType === 'string' ? parsed.sourceType : 'sysml_v2_json',
    format: typeof parsed.format === 'string' ? parsed.format : 'sysml_v2',
    project_dir: typeof parsed.project_dir === 'string' ? parsed.project_dir : undefined,
    files,
    elements,
  };
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(str: string): string {
  return str.replace(REGEX_SPECIAL, (ch) => '\\' + ch);
}

function globMatch(pattern: string, filePath: string): boolean {
  const normPath = filePath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');

  let regexStr = '';
  const parts = normPattern.split('**');

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    const segRegex = segment
      .split('*')
      .map((s) => escapeRegex(s))
      .join('[^/]*');
    regexStr += segRegex;

    if (i < parts.length - 1) {
      const next = parts[i + 1];
      if (next.startsWith('/')) {
        regexStr += '(?:.*/)?';
        parts[i + 1] = next.slice(1);
      } else {
        regexStr += '.*';
      }
    }
  }

  const regex = new RegExp('^' + regexStr + '$');
  return regex.test(normPath);
}

function collectJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      const stats = statSync(full);
      if (stats.isDirectory()) {
        results.push(...collectJsonFiles(full));
      } else if (stats.isFile() && extname(entry).toLowerCase() === '.json') {
        results.push(full);
      }
    } catch {
      // Skip inaccessible entries.
    }
  }

  return results;
}

export function resolveFiles(projectDir: string, selection: FileSelection): string[] {
  const absDir = resolve(projectDir);
  const jsonFiles = collectJsonFiles(absDir);
  const matched: string[] = [];

  for (const absFile of jsonFiles) {
    const relPath = relative(absDir, absFile).replace(/\\/g, '/');

    const included = selection.include.some((pattern) => globMatch(pattern, relPath));
    if (!included) continue;

    const excluded = selection.exclude.some((pattern) => globMatch(pattern, relPath));
    if (excluded) continue;

    matched.push(absFile);
  }

  return matched;
}