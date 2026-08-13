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
 * @riacore/importer-sysml-v2
 *
 * SysML v2 Source Importer — reads serialized SysML JSON exports and maps
 * a first useful subset of elements to Import Write Service bulk operations.
 */

import * as path from 'node:path';
import type { ImporterDescriptor } from '@riacore/importer-sdk';
import { createSysmlV2Runtime } from './sysml-v2-runtime.js';

const metamodelPath = path.join(
  __dirname,
  '..',
  'importer-data',
  'metamodel',
  'sysml-v2.linkml.yaml',
);

const configTemplatePath = path.join(
  __dirname,
  '..',
  'importer-data',
  'config-template',
  'sysml-v2-import-config.yaml',
);

export const sysmlV2ImporterDescriptor: ImporterDescriptor = {
  name: 'sysml_v2',
  version: '0.2.0',
  sourceType: 'sysml_v2_json',
  metamodelPath,
  configTemplatePath,
  createRuntime: () => createSysmlV2Runtime(),
};

export type { ImporterDescriptor, ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';
export { loadSchema, registerMetamodelFromSchema } from './metamodel-loader.js';
export type { LinkMLSchema, LinkMLClass, LinkMLSlot, RegisterMetamodelFn } from './metamodel-loader.js';
export { loadImportConfig, resolveFiles } from './config-loader.js';
export type { SysmlImportConfig, SysmlEnabledCategories, FileSelection } from './config-loader.js';