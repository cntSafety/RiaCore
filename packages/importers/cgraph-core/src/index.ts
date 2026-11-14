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
 * @riacore/importer-cgraph
 *
 * CGraph Source Importer — loads a static C code graph that the CGraph
 * generator has already resolved.
 *
 * The generator is a clang-based toolchain that lives outside RiaCore. It emits
 * one JSONL collection per concept and per relationship, with every stable path
 * and attribute already assigned, so this package is a schema-driven loader:
 * it selects, streams, checks endpoint integrity, and reconciles what it wrote
 * against the generator's manifest. No C is parsed here.
 */

import { importerAssetPath } from '@riacore/importer-sdk';
import type { ImporterDescriptor } from '@riacore/importer-sdk';
import { createCgraphRuntime } from './cgraph-runtime.js';
import { CGRAPH_SOURCE_TYPE } from './cgraph-config.js';

const metamodelPath = importerAssetPath(
  '@riacore/importer-cgraph',
  'importer-data/metamodel/cgraph.linkml.yaml',
  __dirname,
);

const configTemplatePath = importerAssetPath(
  '@riacore/importer-cgraph',
  'importer-data/config-template/cgraph-import-config.yaml',
  __dirname,
);

export const cgraphImporterDescriptor: ImporterDescriptor = {
  name: 'cgraph',
  version: '1.0.0',
  sourceType: CGRAPH_SOURCE_TYPE,
  metamodelPath,
  configTemplatePath,
  createRuntime: () => createCgraphRuntime(),
};

export type { ImporterDescriptor, ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';

export {
  createCgraphRuntime,
  resolveScanResultDir,
  reconcileCounts,
  excludedEndpointConcepts,
  describeValueAnalysis,
} from './cgraph-runtime.js';
export { loadImportConfig, CGRAPH_SOURCE_TYPE } from './cgraph-config.js';
export type { CgraphImportConfig } from './cgraph-config.js';
export {
  CGRAPH_ELEMENT_GROUPS,
  DEFAULT_ELEMENT_SELECTION,
  normalizeElementSelection,
  resolveSelection,
} from './cgraph-selection.js';
export type {
  CgraphElementGroup,
  CgraphElementSelection,
  ResolvedSelection,
} from './cgraph-selection.js';
export {
  readManifest,
  gateSchemaVersion,
  manifestPath,
  nodeCollectionPath,
  edgeCollectionPath,
  diagnosticsPath,
  MANIFEST_FILENAME,
} from './cgraph-manifest.js';
export type { CgraphManifest, CgraphValueAnalysis, CgraphAnalysisUnit } from './cgraph-manifest.js';
export {
  CGRAPH_CONCEPTS,
  CGRAPH_SLOTS,
  CGRAPH_SLOT_ENDPOINTS,
  CGRAPH_ABSTRACT_EXPANSIONS,
  CGRAPH_METAMODEL_NAME,
  CGRAPH_SCHEMA_NAME,
  CGRAPH_SCHEMA_VERSION,
  CGRAPH_SCHEMA_MAJOR,
  expandConcepts,
} from './cgraph-schema.js';
export type { CgraphConcept, CgraphSlot } from './cgraph-schema.js';
