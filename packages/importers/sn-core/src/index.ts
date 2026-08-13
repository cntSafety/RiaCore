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
 * @riacore/importer-sn
 *
 * Sphinx-Needs Source Importer — dynamically generates a metamodel from needs.json.
 */

import * as path from 'node:path';
import type { ImporterDescriptor } from '@riacore/importer-sdk';
import { createSnRuntime } from './sn-runtime.js';
import type { SnImportConfig } from './config-loader.js';
import { resolveNeedsFile } from './config-loader.js';
import { parseNeedsFile } from './sn-parser.js';
import { buildSchemaFromModel, computeDynamicMetamodelName } from './schema-generator.js';

const metamodelPath = path.join(
  __dirname,
  '..',
  'importer-data',
  'metamodel',
  'sphinx-needs-dynamic.linkml.yaml',
);

const configTemplatePath = path.join(
  __dirname,
  '..',
  'importer-data',
  'config-template',
  'sn-import-config.yaml',
);

export const snImporterDescriptor: ImporterDescriptor = {
  name: 'sphinx_needs',
  version: '0.1.0',
  sourceType: 'sphinx_needs_json',
  metamodelPath,
  configTemplatePath,
  createRuntime: () => createSnRuntime(),
};

export function buildDynamicSchemaForConfig(
  config: SnImportConfig,
  projectDir: string,
  workspaceRoot: string,
): ReturnType<typeof buildSchemaFromModel> {
  const needsFilePath = resolveNeedsFile(config, projectDir, workspaceRoot);
  const model = parseNeedsFile(needsFilePath, config.version);
  return buildSchemaFromModel(model, config.namespace);
}

export { computeDynamicMetamodelName };

export type { ImporterDescriptor, ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';
export { loadSchema, registerMetamodelFromSchema } from './metamodel-loader.js';
export type { LinkMLSchema, LinkMLClass, LinkMLSlot, RegisterMetamodelFn } from './metamodel-loader.js';
export { loadImportConfig, resolveFiles, resolveNeedsFile } from './config-loader.js';
export type { SnImportConfig, SnEnabledCategories, FileSelection } from './config-loader.js';
