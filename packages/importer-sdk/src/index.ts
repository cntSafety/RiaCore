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
 * Importer SDK — contract between importers and the orchestration layer.
 *
 * Importers depend on this package for types, interfaces, and helpers.
 * All shared import types are re-exported from @riacore/app-contracts
 * so SDK consumers get everything from a single import.
 */

// Re-export shared types so consumers only need @riacore/importer-sdk
export type {
  ImportSession,
  BeginSessionParams,
  ConceptBatch,
  RelationshipBatch,
  NodeIdMap,
  ImportStats,
  ImportProgress,
  ImportDiagnostic,
} from '@riacore/app-contracts';

import type {
  ImportSession,
  BeginSessionParams,
  ConceptBatch,
  RelationshipBatch,
  NodeIdMap,
  ImportStats,
  ImportProgress,
  ImportDiagnostic,
} from '@riacore/app-contracts';

// The single anchor rule for every path inside an import config.
export {
  resolveWorkspacePath,
  toWorkspaceRelative,
  normalizeStoredPath,
} from './config-paths.js';

// ---------------------------------------------------------------------------
// IImportWriteService — the key contract importers use to write to the DB
// ---------------------------------------------------------------------------

export interface IImportWriteService {
  beginSession(params: BeginSessionParams): Promise<ImportSession>;
  bulkCreateConcepts(session: ImportSession, items: ConceptBatch[]): Promise<NodeIdMap>;
  bulkCreateRelationships(session: ImportSession, items: RelationshipBatch[]): Promise<number>;
  completeSession(session: ImportSession, stats: ImportStats): Promise<void>;
  abortSession(session: ImportSession, error: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ImporterRuntime — the execution contract every importer must implement
// ---------------------------------------------------------------------------

export interface ImporterRuntime {
  run(context: ImporterContext): Promise<ImporterResult>;
}

// ---------------------------------------------------------------------------
// ImporterContext — everything an importer receives when executed
// ---------------------------------------------------------------------------

export interface ImporterContext {
  session: ImportSession;
  config: unknown;
  /**
   * Absolute path to the YAML config file that mirrors this source.
   * Provenance and logging only — never an anchor for resolving other paths.
   */
  configPath: string;
  /**
   * Absolute workspace root. The anchor for every relative path in an import
   * config. Runtimes need it only for secondary paths they resolve themselves
   * (e.g. `needs_file`); `project_dir` arrives pre-resolved as `projectDir`.
   */
  workspaceRoot: string;
  /**
   * Absolute source directory to scan, already resolved from `config.project_dir`
   * against the workspace root. Runtimes must use this as-is and must not
   * re-resolve `config.project_dir` themselves.
   */
  projectDir: string;
  writeService: IImportWriteService;
  onProgress: (progress: ImportProgress) => void;
}

// ---------------------------------------------------------------------------
// ImporterResult — what an importer returns after execution
// ---------------------------------------------------------------------------

export interface ImporterResult {
  stats: ImportStats;
  diagnostics: ImportDiagnostic[];
  /** Absolute paths of all source files that were parsed */
  parsedFiles?: string[];
  /** Element types skipped because they are not in the metamodel, grouped by tag name */
  skippedElements?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// ImporterDescriptor — metadata about an importer + factory
// ---------------------------------------------------------------------------

export interface ImporterDescriptor {
  name: string;
  version: string;
  sourceType: string;
  metamodelPath: string;
  rulesPath?: string;
  configSchema?: unknown;
  configTemplatePath?: string;
  createRuntime: () => ImporterRuntime;
}
