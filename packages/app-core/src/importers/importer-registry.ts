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
 * importer-registry.ts — Resolves importers from config file paths.
 *
 * For v1, the ARXML importer is the only built-in importer.
 * Detection reads the YAML config and checks for ARXML-specific fields.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ImporterDescriptor } from '@riacore/importer-sdk';
import { arxmlImporterDescriptor } from '@riacore/importer-arxml';
import { snImporterDescriptor } from '@riacore/importer-sn';
import { sysmlV2ImporterDescriptor } from '@riacore/importer-sysml-v2';
import { sysmlTextualImporterDescriptor } from '@riacore/importer-sysml-v2-textual';

export interface IImporterRegistry {
  resolve(configPath: string): ImporterDescriptor | null;
  listAvailable(): ImporterDescriptor[];
  findByName(name: string): ImporterDescriptor | null;
  findBySourceType(sourceType: string): ImporterDescriptor | null;
}

/** Fields present in an ARXML import config YAML */
interface RawConfig {
  namespace?: unknown;
  elements?: Record<string, unknown>;
  files?: { include?: string[]; exclude?: string[] };
  source_name?: unknown;
  sourceType?: unknown;
  format?: unknown;
  base_url?: unknown;
}

const ARXML_ELEMENT_KEYS = new Set([
  'swc_types', 'ports', 'port_interfaces', 'data_types',
  'swc_behavior', 'bsw_modules', 'connectors', 'communication', 'system', 'ecuc',
]);

const SYSML_ELEMENT_KEYS = new Set([
  'structure',
  'behavior',
  'features',
  'memberships',
  'imports',
  // legacy keys for backward compat
  'actions',
  'literals',
]);

function isArxmlConfig(configPath: string, raw: RawConfig): boolean {
  // 1. Filename contains "arxml"
  if (basename(configPath).toLowerCase().includes('arxml')) return true;

  // 2. elements section has ARXML-specific category keys
  if (raw.elements && typeof raw.elements === 'object') {
    const keys = Object.keys(raw.elements);
    if (keys.some((k) => ARXML_ELEMENT_KEYS.has(k))) return true;
  }

  // 3. files.include contains .arxml glob patterns
  const includes = raw.files?.include ?? [];
  if (includes.some((p) => typeof p === 'string' && p.includes('.arxml'))) return true;

  return false;
}

function isSphinxNeedsConfig(configPath: string, raw: RawConfig & Record<string, unknown>): boolean {
  const filename = basename(configPath).toLowerCase();
  if (filename.includes('sphinx') || filename.includes('needs')) return true;

  if (raw.sourceType === 'sphinx_needs_json') return true;

  if (typeof raw.format === 'string' && raw.format.toLowerCase().includes('sphinx')) {
    return true;
  }

  if (typeof raw['needs_file'] === 'string') return true;

  const includes = raw.files?.include ?? [];
  if (includes.some((p) => typeof p === 'string' && p.toLowerCase().includes('needs.json'))) return true;

  return false;
}

function isSysmlTextualConfig(configPath: string, raw: RawConfig): boolean {
  const filename = basename(configPath).toLowerCase();
  if (filename.includes('sysml') && (filename.includes('textual') || filename.includes('.sysml'))) return true;
  if (raw.sourceType === 'sysml_v2_textual') return true;
  // files.include contains .sysml glob patterns
  const includes = raw.files?.include ?? [];
  if (includes.some((p) => typeof p === 'string' && p.includes('.sysml'))) return true;
  return false;
}

function isSysmlConfig(configPath: string, raw: RawConfig): boolean {
  const filename = basename(configPath).toLowerCase();
  if (filename.includes('sysml')) return true;

  if (raw.sourceType === 'sysml_v2_json') return true;

  if (typeof raw.format === 'string' && raw.format.toLowerCase().includes('sysml')) {
    return true;
  }

  if (raw.elements && typeof raw.elements === 'object') {
    const keys = Object.keys(raw.elements);
    if (keys.some((k) => SYSML_ELEMENT_KEYS.has(k))) return true;
  }

  const includes = raw.files?.include ?? [];
  if (includes.some((p) => typeof p === 'string' && p.includes('.json')) && filename.includes('import')) return true;

  return false;
}

const BUILT_IN_IMPORTERS: ImporterDescriptor[] = [
  arxmlImporterDescriptor,
  snImporterDescriptor,
  sysmlV2ImporterDescriptor,
  sysmlTextualImporterDescriptor,
];

export function createImporterRegistry(): IImporterRegistry {
  return {
    resolve(configPath: string): ImporterDescriptor | null {
      const rawFromFilenameOnly: RawConfig = {};
      if (isArxmlConfig(configPath, rawFromFilenameOnly)) return arxmlImporterDescriptor;
      if (isSysmlTextualConfig(configPath, rawFromFilenameOnly)) return sysmlTextualImporterDescriptor;
      if (isSysmlConfig(configPath, rawFromFilenameOnly)) return sysmlV2ImporterDescriptor;
      if (isSphinxNeedsConfig(configPath, rawFromFilenameOnly as RawConfig & Record<string, unknown>)) return snImporterDescriptor;

      if (!existsSync(configPath)) return null;
      try {
        const source = readFileSync(configPath, 'utf-8');
        const raw = parseYaml(source) as RawConfig;
        if (isArxmlConfig(configPath, raw)) return arxmlImporterDescriptor;
        if (isSphinxNeedsConfig(configPath, raw as RawConfig & Record<string, unknown>)) return snImporterDescriptor;
        if (isSysmlTextualConfig(configPath, raw)) return sysmlTextualImporterDescriptor;
        if (isSysmlConfig(configPath, raw)) return sysmlV2ImporterDescriptor;
      } catch {
        // unreadable or invalid YAML — no match
      }
      return null;
    },

    listAvailable(): ImporterDescriptor[] {
      return [...BUILT_IN_IMPORTERS];
    },

    findByName(name: string): ImporterDescriptor | null {
      return BUILT_IN_IMPORTERS.find((d) => d.name === name) ?? null;
    },

    findBySourceType(sourceType: string): ImporterDescriptor | null {
      return BUILT_IN_IMPORTERS.find((d) => d.sourceType === sourceType) ?? null;
    },
  };
}
