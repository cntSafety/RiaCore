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

export interface SysmlTextualEnabledCategories {
  structure: boolean;
  behavior: boolean;
  features: boolean;
  memberships: boolean;
  imports: boolean;
}

export interface FileSelection {
  include: string[];
  exclude: string[];
}

export interface SysmlTextualImportConfig {
  namespace: string;
  source_name?: string;
  sourceType?: string;
  project_dir?: string;
  files: FileSelection;
  elements: SysmlTextualEnabledCategories;
}

export const DEFAULT_ENABLED_CATEGORIES: SysmlTextualEnabledCategories = {
  structure: true,
  behavior: true,
  features: true,
  memberships: false,
  imports: true,
};

const DEFAULT_FILE_SELECTION: FileSelection = {
  include: ['**/*.sysml'],
  exclude: [],
};

const DEFAULT_NAMESPACE = 'SysMLModel';
const DEFAULT_CONFIG_FILENAME = 'sysml-v2-textual-import-config.yaml';

export function loadImportConfig(configPath?: string): SysmlTextualImportConfig {
  const resolvedPath = configPath ?? join(process.cwd(), DEFAULT_CONFIG_FILENAME);

  if (!existsSync(resolvedPath)) {
    return {
      namespace: DEFAULT_NAMESPACE,
      sourceType: 'sysml_v2_textual',
      files: { ...DEFAULT_FILE_SELECTION, exclude: [] },
      elements: { ...DEFAULT_ENABLED_CATEGORIES },
    };
  }

  const raw = parseYaml(readFileSync(resolvedPath, 'utf-8')) ?? {};

  const elements: SysmlTextualEnabledCategories = { ...DEFAULT_ENABLED_CATEGORIES };
  if (raw.elements && typeof raw.elements === 'object') {
    const keys: Array<keyof SysmlTextualEnabledCategories> = [
      'structure', 'behavior', 'features', 'memberships', 'imports',
    ];
    for (const key of keys) {
      if (key in raw.elements && typeof raw.elements[key] === 'boolean') {
        elements[key] = raw.elements[key] as boolean;
      }
    }
  }

  const files: FileSelection = { ...DEFAULT_FILE_SELECTION, exclude: [] };
  if (raw.files && typeof raw.files === 'object') {
    if (Array.isArray(raw.files.include) && raw.files.include.length > 0) {
      files.include = (raw.files.include as unknown[]).map(String);
    }
    if (Array.isArray(raw.files.exclude)) {
      files.exclude = (raw.files.exclude as unknown[]).map(String);
    }
  }

  return {
    namespace: typeof raw.namespace === 'string' ? raw.namespace : DEFAULT_NAMESPACE,
    source_name: typeof raw.source_name === 'string' ? raw.source_name : undefined,
    sourceType: typeof raw.sourceType === 'string' ? raw.sourceType : 'sysml_v2_textual',
    project_dir: typeof raw.project_dir === 'string' ? raw.project_dir : undefined,
    files,
    elements,
  };
}

// ── File discovery ────────────────────────────────────────────────────────────

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
  return new RegExp('^' + regexStr + '$').test(normPath);
}

function collectSysmlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      const stats = statSync(full);
      if (stats.isDirectory()) {
        results.push(...collectSysmlFiles(full));
      } else if (stats.isFile() && extname(entry).toLowerCase() === '.sysml') {
        results.push(full);
      }
    } catch {
      // skip inaccessible entries
    }
  }
  return results;
}

export function resolveFiles(projectDir: string, selection: FileSelection): string[] {
  const absDir = resolve(projectDir);
  const sysmlFiles = collectSysmlFiles(absDir);
  const matched: string[] = [];
  for (const absFile of sysmlFiles) {
    const relPath = relative(absDir, absFile).replace(/\\/g, '/');
    const included = selection.include.some((p) => globMatch(p, relPath));
    if (!included) continue;
    const excluded = selection.exclude.some((p) => globMatch(p, relPath));
    if (excluded) continue;
    matched.push(absFile);
  }
  return matched;
}
