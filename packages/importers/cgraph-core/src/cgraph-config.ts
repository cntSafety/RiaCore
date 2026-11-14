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
 * cgraph-config.ts — the import config for the CGraph importer.
 *
 * `scan_result_dir` is the real input: the generator's output directory.
 * `project_dir` is advisory and the importer resolves nothing against it — the
 * generator already emitted repo-relative stable paths. It is carried so a
 * consumer view can open a file from a node, and so the branch-update flow has
 * a repository to point at.
 *
 * Neither path is resolved here. Both are stored exactly as the user entered
 * them, relative or absolute, and resolved against the WORKSPACE ROOT at the
 * orchestration boundary. The config file's own directory is never an anchor —
 * see `config-paths.ts` in the SDK.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_ELEMENT_SELECTION,
  normalizeElementSelection,
  type CgraphElementSelection,
} from './cgraph-selection.js';

export const CGRAPH_SOURCE_TYPE = 'cgraph_graph';

const DEFAULT_NAMESPACE = 'CodeGraph';

export interface CgraphImportConfig {
  namespace: string;
  source_name?: string;
  sourceType: string;
  /** Generator output directory. Absolute, or relative to the workspace root. */
  scan_result_dir?: string;
  /** Repository root the stable paths are relative to. Advisory. */
  project_dir?: string;
  elements: CgraphElementSelection;
}

export function loadImportConfig(configPath?: string): CgraphImportConfig {
  if (!configPath || !existsSync(configPath)) {
    return {
      namespace: DEFAULT_NAMESPACE,
      sourceType: CGRAPH_SOURCE_TYPE,
      elements: { ...DEFAULT_ELEMENT_SELECTION },
    };
  }

  const parsed = (parseYaml(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;

  return {
    namespace: typeof parsed.namespace === 'string' && parsed.namespace.trim()
      ? parsed.namespace
      : DEFAULT_NAMESPACE,
    source_name: typeof parsed.source_name === 'string' ? parsed.source_name : undefined,
    sourceType: typeof parsed.sourceType === 'string' ? parsed.sourceType : CGRAPH_SOURCE_TYPE,
    scan_result_dir: typeof parsed.scan_result_dir === 'string' ? parsed.scan_result_dir : undefined,
    project_dir: typeof parsed.project_dir === 'string' ? parsed.project_dir : undefined,
    elements: normalizeElementSelection(
      (parsed.elements && typeof parsed.elements === 'object')
        ? parsed.elements as Record<string, unknown>
        : undefined,
    ),
  };
}
