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
import type { ImporterContext, ImporterResult, ImporterRuntime } from '@riacore/importer-sdk';
import type { ImportDiagnostic } from '@riacore/app-contracts';
import type { SnImportConfig } from './config-loader.js';
import { resolveNeedsFile } from './config-loader.js';
import { parseNeedsFile } from './sn-parser.js';
import { mapModelToConceptBatches, mapModelToRelationshipBatches } from './sn-mapper.js';

export function createSnRuntime(): ImporterRuntime {
  return {
    async run(context: ImporterContext): Promise<ImporterResult> {
      const config = context.config as SnImportConfig;
      const diagnostics: ImportDiagnostic[] = [];
      const t0 = Date.now();

      context.onProgress({ phase: 'parsing', message: 'Resolving needs.json file...' });
      // Already absolute — resolved against the workspace root upstream.
      const scanDir = context.projectDir;

      const needsFilePath = resolveNeedsFile(config, scanDir, context.workspaceRoot);

      context.onProgress({ phase: 'parsing', message: `Parsing needs file: ${needsFilePath}` });
      const model = parseNeedsFile(needsFilePath, config.version);

      const conceptBatches = mapModelToConceptBatches(model);
      const totalConcepts = conceptBatches.reduce((sum, b) => sum + b.items.length, 0);
      context.onProgress({
        phase: 'concepts',
        message: `Creating ${totalConcepts} concept instances...`,
        current: 0,
        total: totalConcepts,
      });
      const nodeIdMap = await context.writeService.bulkCreateConcepts(context.session, conceptBatches);

      const relResult = mapModelToRelationshipBatches(model);
      diagnostics.push(...relResult.diagnostics);
      const totalRels = relResult.batches.reduce((sum, b) => sum + b.items.length, 0);
      context.onProgress({
        phase: 'relationships',
        message: `Creating ${totalRels} relationship instances...`,
        current: 0,
        total: totalRels,
      });
      const relsCreated = await context.writeService.bulkCreateRelationships(context.session, relResult.batches);

      context.onProgress({ phase: 'finalizing', message: 'Sphinx-Needs import complete.' });

      const skipped = new Map<string, number>(model.skippedElements);
      for (const [k, v] of relResult.skippedElements) skipped.set(k, (skipped.get(k) ?? 0) + v);

      return {
        stats: {
          conceptsCreated: nodeIdMap.size,
          relationshipsCreated: relsCreated,
          errors: diagnostics.filter((d) => d.level === 'error').length,
          filesProcessed: 1,
          durationMs: Date.now() - t0,
        },
        diagnostics,
        parsedFiles: [needsFilePath],
        ...(skipped.size > 0 ? { skippedElements: Object.fromEntries([...skipped.entries()]) } : {}),
      };
    },
  };
}
