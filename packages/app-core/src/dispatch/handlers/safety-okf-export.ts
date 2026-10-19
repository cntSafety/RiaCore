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
import * as path from 'node:path';
import type { ServiceDependencies } from '../types.js';
import { aggregateExportData } from './safety-export-aggregator.js';
import { loadSafetyOkfContext } from './safety-okf-context.js';
import { generateSafetyOkf } from './safety-okf-generator.js';
import { inspectOkfDestination, publishSafetyOkf } from './safety-okf-destination.js';

export async function exportSafetyOkf(
  payload: { namespace: string; outputDir: string; includeRiskRatings?: boolean }, deps: ServiceDependencies,
): Promise<{ exportedFiles: string[]; outputDir: string }> {
  if (!payload.namespace?.trim()) throw new Error('Namespace must be a non-empty string.');
  if (!payload.outputDir?.trim()) throw new Error('Output directory must be a non-empty string.');
  const outputDir = path.resolve(payload.outputDir);
  const previous = await inspectOkfDestination(outputDir, payload.namespace);
  const data = await aggregateExportData(payload.namespace, deps);
  if (!data.components.length) throw new Error('No safety analysis data available to export.');
  const context = await loadSafetyOkfContext(data, deps);
  const { files } = generateSafetyOkf(data, context, { includeRiskRatings: payload.includeRiskRatings });
  const exportedFiles = await publishSafetyOkf(outputDir, payload.namespace, files, previous);
  return { exportedFiles, outputDir };
}
