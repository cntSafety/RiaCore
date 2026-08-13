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
 * arxml-runtime.ts — ARXML Importer Runtime
 *
 * Implements the ImporterRuntime interface from the Importer SDK.
 * Orchestrates: config loading → file resolution → parsing → mapping → bulk writes.
 */

import type { ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';
import type { ImportDiagnostic } from '@riacore/app-contracts';
import { loadImportConfig, resolveFiles, type ImportConfig } from './config-loader.js';
import { parseArxmlProject } from './arxml-parser.js';
import { mapModelToConceptBatches, mapModelToRelationshipBatches } from './arxml-mapper.js';

/**
 * Factory function that creates an ARXML ImporterRuntime instance.
 */
export function createArxmlRuntime(): ImporterRuntime {
  return {
    async run(context: ImporterContext): Promise<ImporterResult> {
      const config = context.config as ImportConfig;
      const diagnostics: ImportDiagnostic[] = [];
      const t0 = Date.now();

      // Phase 1: Resolve files
      // `projectDir` is already absolute — resolved from config.project_dir
      // against the workspace root by the orchestration layer.
      context.onProgress({ phase: 'parsing', message: 'Resolving ARXML files...' });
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
          diagnostics: [{ level: 'warning', message: 'No ARXML files found' }],
        };
      }

      // Phase 2: Parse all ARXML files
      context.onProgress({
        phase: 'parsing',
        message: `Parsing ${files.length} ARXML files...`,
        current: 0,
        total: files.length,
      });
      const model = parseArxmlProject(scanDir, config.elements, files);

      // Skipped elements are logged via the orchestration service logger
      // Phase 3: Map model to concept batches and write
      const conceptBatches = mapModelToConceptBatches(model);
      const totalConcepts = conceptBatches.reduce((s, b) => s + b.items.length, 0);
      context.onProgress({ phase: 'concepts', message: `Creating ${totalConcepts} concept instances...`, current: 0, total: totalConcepts });
      const nodeIdMap = await context.writeService.bulkCreateConcepts(
        context.session,
        conceptBatches,
      );
      context.onProgress({ phase: 'concepts', message: `Created ${nodeIdMap.size} concept instances`, current: nodeIdMap.size, total: totalConcepts });

      // Phase 4: Map model to relationship batches and write
      const relBatches = mapModelToRelationshipBatches(model);
      const totalRels = relBatches.reduce((s, b) => s + b.items.length, 0);
      context.onProgress({ phase: 'relationships', message: `Creating ${totalRels} relationship instances...`, current: 0, total: totalRels });
      const relsCreated = await context.writeService.bulkCreateRelationships(
        context.session,
        relBatches,
      );
      context.onProgress({ phase: 'relationships', message: `Created ${relsCreated} relationship instances`, current: relsCreated, total: totalRels });

      // Phase 5: Finalizing
      context.onProgress({ phase: 'finalizing', message: 'Import complete.' });

      return {
        stats: {
          conceptsCreated: nodeIdMap.size,
          relationshipsCreated: relsCreated,
          errors: diagnostics.filter((d) => d.level === 'error').length,
          filesProcessed: files.length,
          durationMs: Date.now() - t0,
        },
        diagnostics,
        parsedFiles: files,
        ...(model.skippedElements.size > 0 ? {
          skippedElements: Object.fromEntries([...model.skippedElements.entries()]),
        } : {}),
      };
    },
  };
}
