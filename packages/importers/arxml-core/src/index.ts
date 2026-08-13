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
 * @riacore/importer-arxml
 *
 * ARXML Source Importer — parses AUTOSAR ARXML files and maps
 * the extracted model to Import Write Service bulk operations.
 */

import * as path from 'node:path';
import type { ImporterDescriptor } from '@riacore/importer-sdk';
import { createArxmlRuntime } from './arxml-runtime.js';

/**
 * Resolve the absolute path to the LinkML metamodel schema file.
 * The metamodel lives in importer-data/metamodel/ relative to the package root.
 * Works from both `src/` (dev) and `dist/` (compiled) locations.
 */
const metamodelPath = path.join(
  __dirname,
  '..',
  'importer-data',
  'metamodel',
  'sw-arxml.linkml.yaml',
);

/**
 * Resolve the absolute path to the bundled config template file.
 * The template lives in importer-data/config-template/ relative to the package root.
 * Works from both `src/` (dev) and `dist/` (compiled) locations.
 */
const configTemplatePath = path.join(
  __dirname,
  '..',
  'importer-data',
  'config-template',
  'arxml-import-config.yaml',
);

/**
 * ARXML importer descriptor — metadata + factory for the orchestration layer.
 */
export const arxmlImporterDescriptor: ImporterDescriptor = {
  name: 'arxml',
  version: '2.0.0',
  sourceType: 'arxml_file',
  metamodelPath,
  configTemplatePath,
  createRuntime: () => createArxmlRuntime(),
};

// Re-export key types consumers might need
export type { ImporterDescriptor, ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';

// Re-export metamodel-loader utilities for the orchestration layer
export { loadSchema, registerMetamodelFromSchema } from './metamodel-loader.js';
export type { LinkMLSchema, LinkMLClass, LinkMLSlot, RegisterMetamodelFn } from './metamodel-loader.js';

// Re-export config-loader for the orchestration layer
export { loadImportConfig, resolveFiles } from './config-loader.js';
export type { ImportConfig, EnabledCategories, FileSelection } from './config-loader.js';
