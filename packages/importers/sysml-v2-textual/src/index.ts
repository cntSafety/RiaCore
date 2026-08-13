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
 * @riacore/importer-sysml-v2-textual
 *
 * SysML v2 textual (.sysml) file importer for RiaCore.
 * Reads .sysml files directly using the Langium SysIDE grammar,
 * then maps the extracted AST elements to ConceptBatch / RelationshipBatch
 * for the importer SDK write service.
 *
 * Uses the same metamodel (sysml-v2.linkml.yaml) as the JSON importer
 * so both sources appear under the same concept hierarchy in the graph.
 */
import * as path from 'node:path';
import type { ImporterDescriptor } from '@riacore/importer-sdk';
import { createSysmlTextualRuntime } from './sysml-textual-runtime.js';

const metamodelPath = path.join(
  __dirname,
  '..',
  'importer-data',
  'metamodel',
  'sysml-v2-textual.linkml.yaml',
);

const configTemplatePath = path.join(
  __dirname,
  '..',
  'importer-data',
  'config-template',
  'sysml-v2-textual-import-config.yaml',
);

export const sysmlTextualImporterDescriptor: ImporterDescriptor = {
  name: 'sysml_v2_textual',
  version: '0.1.0',
  sourceType: 'sysml_v2_textual',
  metamodelPath,
  configTemplatePath,
  createRuntime: () => createSysmlTextualRuntime(),
};

export { loadImportConfig, resolveFiles } from './config-loader.js';
export type { SysmlTextualImportConfig, SysmlTextualEnabledCategories } from './config-loader.js';
