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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveWorkspacePath } from '@riacore/importer-sdk';

export interface SnEnabledCategories {
  concepts: boolean;
  relationships: boolean;
}

export interface FileSelection {
  include: string[];
  exclude: string[];
}

export interface SnImportConfig {
  namespace: string;
  source_name?: string;
  sourceType?: string;
  format?: string;
  project_dir?: string;
  needs_file?: string;
  version?: string;
  files: FileSelection;
  elements: SnEnabledCategories;
}

export const DEFAULT_ENABLED_CATEGORIES: SnEnabledCategories = {
  concepts: true,
  relationships: true,
};

const DEFAULT_FILE_SELECTION: FileSelection = {
  include: ['**/needs.json'],
  exclude: [],
};

const DEFAULT_NAMESPACE = 'SphinxNeedsModel';
const DEFAULT_CONFIG_FILENAME = 'sn-import-config.yaml';

export function loadImportConfig(configPath?: string): SnImportConfig {
  const resolvedPath = configPath ?? join(process.cwd(), DEFAULT_CONFIG_FILENAME);

  if (!existsSync(resolvedPath)) {
    return {
      namespace: DEFAULT_NAMESPACE,
      sourceType: 'sphinx_needs_json',
      format: 'sphinx_needs',
      needs_file: 'needs.json',
      files: { ...DEFAULT_FILE_SELECTION, exclude: [] },
      elements: { ...DEFAULT_ENABLED_CATEGORIES },
    };
  }

  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};

  const elements: SnEnabledCategories = { ...DEFAULT_ENABLED_CATEGORIES };
  if (parsed.elements && typeof parsed.elements === 'object') {
    for (const key of Object.keys(DEFAULT_ENABLED_CATEGORIES) as Array<keyof SnEnabledCategories>) {
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
    namespace: typeof parsed.namespace === 'string' ? parsed.namespace : DEFAULT_NAMESPACE,
    source_name: typeof parsed.source_name === 'string' ? parsed.source_name : undefined,
    sourceType: typeof parsed.sourceType === 'string' ? parsed.sourceType : 'sphinx_needs_json',
    format: typeof parsed.format === 'string' ? parsed.format : 'sphinx_needs',
    project_dir: typeof parsed.project_dir === 'string' ? parsed.project_dir : undefined,
    needs_file: typeof parsed.needs_file === 'string' ? parsed.needs_file : undefined,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
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
    const segRegex = segment.split('*').map((s) => escapeRegex(s)).join('[^/]*');
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

/**
 * Resolve the needs.json to parse.
 *
 * `projectDir` must already be absolute. `needs_file` is absolute or relative
 * to the workspace root — never to the config file's location.
 */
export function resolveNeedsFile(
  config: SnImportConfig,
  projectDir: string,
  workspaceRoot: string,
): string {
  if (config.needs_file && config.needs_file.trim().length > 0) {
    const explicitPath = resolveWorkspacePath(workspaceRoot, config.needs_file);
    if (!existsSync(explicitPath)) {
      throw new Error(
        `The configured needs file was not found at "${explicitPath}". ` +
        `Check the "needs_file" setting in your import configuration and make sure the file exists. ` +
        `Relative paths are resolved against the workspace root "${workspaceRoot}".`,
      );
    }
    return explicitPath;
  }

  const files = resolveFiles(projectDir, config.files).sort();
  if (files.length === 0) {
    throw new Error(
      `No needs.json file was found under the project directory "${projectDir}". ` +
      `Make sure the project has been built (run "sphinx-build" or equivalent) and that ` +
      `the "project_dir" setting in your import configuration points to the correct location.`,
    );
  }

  const exactNeeds = files.find((f) => f.toLowerCase().endsWith('/needs.json') || f.toLowerCase().endsWith('\\needs.json'));
  return exactNeeds ?? files[0];
}
