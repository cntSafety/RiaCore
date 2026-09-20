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
import type { ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';
import { resolveFiles, DEFAULT_ENABLED_CATEGORIES, type SysmlTextualImportConfig } from './config-loader.js';
import { parseSysmlTextualProject, resetParser } from './sysml-textual-parser.js';
import { mapModelToConceptBatches, mapModelToRelationshipBatches } from './sysml-textual-mapper.js';

export function createSysmlTextualRuntime(): ImporterRuntime {
  return {
    async run(context: ImporterContext): Promise<ImporterResult> {
      const config = context.config as SysmlTextualImportConfig;
      const t0 = Date.now();

      // Reset the Langium parser so a fresh service is used for each import run
      resetParser();

      // ── Step 1: Discover .sysml files ─────────────────────────────────────
      context.onProgress({ phase: 'parsing', message: 'Discovering .sysml files...' });

      // Already absolute — resolved against the workspace root upstream.
      const scanDir = context.projectDir;

      const files = resolveFiles(scanDir, config.files);

      if (files.length === 0) {
        return {
          stats: {
            conceptsCreated: 0,
            relationshipsCreated: 0,
            errors: 0,
            filesProcessed: 0,
            durationMs: Date.now() - t0,
          },
          diagnostics: [{ level: 'warning', message: `No .sysml files found under: ${scanDir}` }],
        };
      }

      // ── Step 2: Parse all .sysml files via Langium ────────────────────────
      context.onProgress({
        phase: 'parsing',
        message: `Parsing ${files.length} .sysml file(s)...`,
        current: 0,
        total: files.length,
      });

      const enabledCategories = { ...DEFAULT_ENABLED_CATEGORIES, ...config.elements };
      const model = await parseSysmlTextualProject(enabledCategories, files);

      context.onProgress({
        phase: 'parsing',
        message: `Parsed ${files.length} file(s) — ${model.elements.length} elements extracted`,
        current: files.length,
        total: files.length,
      });

      // ── Step 3: Map to ConceptBatches ─────────────────────────────────────
      // The parser resolved absolute paths so it could read the files; the
      // mapper anchors them back at the workspace root before they are stored.
      const conceptBatches = mapModelToConceptBatches(model, context.workspaceRoot);
      const totalConcepts = conceptBatches.reduce((s, b) => s + b.items.length, 0);

      context.onProgress({
        phase: 'concepts',
        message: `Writing ${totalConcepts} SysML concept(s)...`,
        current: 0,
        total: totalConcepts,
      });

      const nodeIdMap = await context.writeService.bulkCreateConcepts(
        context.session,
        conceptBatches,
      );

      context.onProgress({
        phase: 'concepts',
        message: `Created ${nodeIdMap.size} SysML concept(s)`,
        current: nodeIdMap.size,
        total: totalConcepts,
      });

      // ── Step 4: Map to RelationshipBatches ────────────────────────────────
      const relationshipBatches = mapModelToRelationshipBatches(model);
      const totalRelationships = relationshipBatches.reduce((s, b) => s + b.items.length, 0);

      context.onProgress({
        phase: 'relationships',
        message: `Writing ${totalRelationships} relationship(s)...`,
        current: 0,
        total: totalRelationships,
      });

      const relationshipsCreated = await context.writeService.bulkCreateRelationships(
        context.session,
        relationshipBatches,
      );

      context.onProgress({
        phase: 'relationships',
        message: `Created ${relationshipsCreated} relationship(s)`,
        current: relationshipsCreated,
        total: totalRelationships,
      });

      context.onProgress({ phase: 'finalizing', message: 'SysML v2 textual import complete.' });

      const errorDiagnostics = model.diagnostics.filter((d) => d.level === 'error');

      return {
        stats: {
          conceptsCreated: nodeIdMap.size,
          relationshipsCreated,
          errors: errorDiagnostics.length,
          filesProcessed: files.length,
          durationMs: Date.now() - t0,
        },
        diagnostics: model.diagnostics,
        parsedFiles: files,
        ...(model.skippedElements.size > 0
          ? { skippedElements: Object.fromEntries([...model.skippedElements.entries()]) }
          : {}),
      };
    },
  };
}
