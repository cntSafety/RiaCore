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
 * Import-source readiness: determines whether each import source has its
 * mandatory configuration fields filled in before allowing a run.
 *
 * Mandatory fields by source type (mirrors the `required` rules in
 * ImporterConfigModal):
 *   arxml_file        → projectDir
 *   sysml_v2_json     → projectDir
 *   sysml_v2_textual  → projectDir
 *   sphinx_needs_json → needsFile OR projectDir (at least one must be set)
 *   unknown / other   → always considered configured (don't block unknown types)
 */
import { useQueries } from '@tanstack/react-query';
import type { ImportConfigView, ImportSourceInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';

// ── Pure predicate ────────────────────────────────────────────────────────────

/**
 * Returns `true` when the loaded `ImportConfigView` satisfies the minimum
 * required fields for its source type. Returns `false` only when a specific
 * field is provably missing — unknown types are treated as configured so we
 * never accidentally block a type we don't know about.
 */
export function isImportSourceConfigured(config: ImportConfigView): boolean {
  switch (config.sourceType) {
    case 'arxml_file':
    case 'arxml':
      return config.projectDir.trim().length > 0;

    case 'sysml_v2_json':
    case 'sysml_v2':
      return config.projectDir.trim().length > 0;

    case 'sysml_v2_textual':
      return config.projectDir.trim().length > 0;

    case 'sphinx_needs_json':
    case 'sphinx_needs':
      // Either needsFile (direct path) or projectDir (for glob discovery) must
      // be provided — the importer needs at least one to locate needs.json.
      return (config.needsFile ?? '').trim().length > 0 ||
             config.projectDir.trim().length > 0;

    default:
      // Unknown / future source type: don't block it.
      return true;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * For each import source in `sources`, fetches (or reuses from cache) the
 * `ImportConfigView` and evaluates `isImportSourceConfigured`. Returns a
 * `Map<sourceId, boolean>`:
 *   - `true`      → source is configured and can be run
 *   - `false`     → source is missing a mandatory field
 *   - not present → config not yet loaded (treat as runnable — don't block)
 *
 * Uses `staleTime: Infinity` so the config is fetched once per source per
 * workspace session and never re-fetched unless explicitly invalidated (e.g.
 * after saving the config in ImporterConfigModal). This matches the pattern
 * used by the config modal's own query.
 *
 * Enabled only while `enabled` is true (i.e. the DB is open).
 */
export function useImportSourcesReadiness(
  sources: ImportSourceInfo[],
  workingDir: string,
  enabled: boolean,
): Map<string, boolean> {
  const results = useQueries({
    queries: sources.map((source) => ({
      queryKey: ['imports.getConfig', workingDir || 'no-workspace', source.sourceId] as const,
      queryFn: (): Promise<ImportConfigView> => api.imports.getConfig(source.sourceId),
      enabled,
      staleTime: Infinity,
      // gcTime matches the modal's own query — keep cached across unmounts.
      gcTime: Infinity,
    })),
  });

  const readinessMap = new Map<string, boolean>();
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const result = results[i];
    if (result.data !== undefined) {
      readinessMap.set(source.sourceId, isImportSourceConfigured(result.data));
    }
    // While loading: don't add to map; callers treat absence as "unknown / allow"
  }
  return readinessMap;
}
