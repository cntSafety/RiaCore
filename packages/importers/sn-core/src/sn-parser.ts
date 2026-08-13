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
import { readFileSync } from 'node:fs';

export interface JsonSchemaProperty {
  field_type?: string;
  type?: string | string[];
  items?: { type?: string | string[] };
  description?: string;
  required?: boolean;
}

export interface NeedRecord {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface ParsedNeedsModel {
  selectedVersion: string;
  needsFilePath: string;
  needs: NeedRecord[];
  properties: Record<string, JsonSchemaProperty>;
  linkFieldNames: string[];
  backlinkFieldNames: string[];
  skippedElements: Map<string, number>;
}

interface NeedsVersionSection {
  needs?: Record<string, Record<string, unknown>>;
  needs_schema?: { properties?: Record<string, JsonSchemaProperty> };
}

interface NeedsRoot {
  current_version?: string;
  versions?: Record<string, NeedsVersionSection>;
}

function normalizeTypeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function selectVersion(root: NeedsRoot, explicitVersion?: string): string {
  const versions = root.versions ?? {};
  const keys = Object.keys(versions);
  if (keys.length === 0) {
    throw new Error('needs.json has no versions section');
  }

  if (explicitVersion && versions[explicitVersion]) {
    return explicitVersion;
  }

  if (root.current_version && versions[root.current_version]) {
    return root.current_version;
  }

  if (versions['']) {
    return '';
  }

  return keys.sort()[keys.length - 1];
}

export function parseNeedsFile(needsFilePath: string, explicitVersion?: string): ParsedNeedsModel {
  const raw = readFileSync(needsFilePath, 'utf-8');
  const root = JSON.parse(raw) as NeedsRoot;

  const selectedVersion = selectVersion(root, explicitVersion);
  const versionBlock = root.versions?.[selectedVersion];
  if (!versionBlock) {
    throw new Error(`Selected version '${selectedVersion}' not found in needs.json`);
  }

  const needsMap = versionBlock.needs ?? {};
  const properties = versionBlock.needs_schema?.properties ?? {};
  const linkFieldNames = Object.entries(properties)
    .filter(([, p]) => p.field_type === 'links')
    .map(([name]) => name)
    .sort();
  const backlinkFieldNames = Object.entries(properties)
    .filter(([, p]) => p.field_type === 'backlinks')
    .map(([name]) => name)
    .sort();

  const skippedElements = new Map<string, number>();
  const needs: NeedRecord[] = [];

  for (const [fallbackId, obj] of Object.entries(needsMap)) {
    const id = typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id : fallbackId;
    const typeRaw = typeof obj.type === 'string' ? obj.type : 'unknown';
    const type = normalizeTypeName(typeRaw);

    if (!id) {
      skippedElements.set('missing_id', (skippedElements.get('missing_id') ?? 0) + 1);
      continue;
    }

    needs.push({
      id,
      type,
      attributes: obj,
    });
  }

  return {
    selectedVersion,
    needsFilePath,
    needs,
    properties,
    linkFieldNames,
    backlinkFieldNames,
    skippedElements,
  };
}

export function parseLinkToken(token: string): { targetId: string; condition?: string } {
  const trimmed = token.trim();
  const m = /^(.+?)\[(.+)\]$/.exec(trimmed);
  if (!m) {
    return { targetId: trimmed };
  }
  return {
    targetId: m[1].trim(),
    condition: m[2].trim(),
  };
}
