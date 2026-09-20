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
import type { ImportDiagnostic } from '@riacore/app-contracts';
import { resolveFiles, DEFAULT_ENABLED_CATEGORIES, type SysmlImportConfig } from './config-loader.js';
import { parseSysmlProject } from './sysml-v2-parser.js';
import { mapModelToConceptBatches, mapModelToRelationshipBatches } from './sysml-v2-mapper.js';
import { materializeConnectorEndpoints } from './sysml-v2-endpoints.js';

export function createSysmlV2Runtime(): ImporterRuntime {
  return {
    async run(context: ImporterContext): Promise<ImporterResult> {
      const config = context.config as SysmlImportConfig;
      const diagnostics: ImportDiagnostic[] = [];
      const t0 = Date.now();

      context.onProgress({ phase: 'parsing', message: 'Resolving SysML JSON files...' });
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
          diagnostics: [{ level: 'warning', message: 'No SysML JSON files found' }],
        };
      }

      context.onProgress({
        phase: 'parsing',
        message: `Parsing ${files.length} SysML JSON files...`,
        current: 0,
        total: files.length,
      });
      const model = parseSysmlProject({ ...DEFAULT_ENABLED_CATEGORIES, ...config.elements }, files);
      // Before the batches are built, so the synthetic endpoint features are
      // written as ordinary concepts and relationships rather than needing a
      // second pass over the graph.
      const rewrittenEndpoints = materializeConnectorEndpoints(model);
      if (rewrittenEndpoints > 0) {
        diagnostics.push({
          level: 'info',
          message: `Resolved ${rewrittenEndpoints} flow/binding endpoint(s) to a (container, pin) pair. ` +
            'The pilot export names only the containing usage on these, so without this they carry no pin.',
        });
      }

      const conceptBatches = mapModelToConceptBatches(model);
      const totalConcepts = conceptBatches.reduce((sum, batch) => sum + batch.items.length, 0);
      context.onProgress({
        phase: 'concepts',
        message: `Creating ${totalConcepts} SysML concept instances...`,
        current: 0,
        total: totalConcepts,
      });
      const nodeIdMap = await context.writeService.bulkCreateConcepts(context.session, conceptBatches);
      context.onProgress({
        phase: 'concepts',
        message: `Created ${nodeIdMap.size} SysML concept instances`,
        current: nodeIdMap.size,
        total: totalConcepts,
      });

      const relationshipBatches = mapModelToRelationshipBatches(model);
      const totalRelationships = relationshipBatches.reduce((sum, batch) => sum + batch.items.length, 0);
      context.onProgress({
        phase: 'relationships',
        message: `Creating ${totalRelationships} SysML relationship instances...`,
        current: 0,
        total: totalRelationships,
      });
      const relationshipsCreated = await context.writeService.bulkCreateRelationships(
        context.session,
        relationshipBatches,
      );
      context.onProgress({
        phase: 'relationships',
        message: `Created ${relationshipsCreated} SysML relationship instances`,
        current: relationshipsCreated,
        total: totalRelationships,
      });

      context.onProgress({ phase: 'finalizing', message: 'SysML import complete.' });

      return {
        stats: {
          conceptsCreated: nodeIdMap.size,
          relationshipsCreated,
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