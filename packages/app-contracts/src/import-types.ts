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
export interface ImportSession {
  sessionId: string;
  runId: string;
  sourceId: string;
  namespace: string;
  metamodel: string;
  startedAt: string;
  triggeredBy: 'cli' | 'gui';
}

export interface BeginSessionParams {
  namespace: string;
  metamodel: string;
  sourceName: string;
  sourceType: string;
  configPath: string;
  configDigest: string;
  metamodelPath: string;
  metamodelDigest: string;
  triggeredBy: 'cli' | 'gui';
  importerVersion: string;
  namespaceRole: 'imported' | 'authored' | 'supervised_update_temp';
  namespaceOwningApplication: string;
  /** Optional structured config data to store on the Source node. */
  configData?: ImportConfigData;
  /**
   * When true, the write service will NOT overwrite config_data for existing
   * sources. Propagated from RunImportParams.preserveStoredConfigData.
   */
  preserveStoredConfigData?: boolean;
}

export interface ConceptBatch {
  concept: string;
  items: Array<{
    stablePath: string;
    attributes: Record<string, unknown>;
  }>;
}

export interface RelationshipBatch {
  relationship: string;
  items: Array<{
    sourceStablePath: string;
    targetStablePath: string;
    attributes?: Record<string, unknown>;
  }>;
}

export type NodeIdMap = Map<string, number>;

export interface ImportStats {
  conceptsCreated: number;
  relationshipsCreated: number;
  errors: number;
  filesProcessed: number;
  durationMs: number;
  boundaryNodesChecked?: number;
  orphanedBoundaryNodes?: number;
  modifiedBoundaryNodes?: number;
}

export interface ImportRunSummary {
  runId: string;
  sourceId: string;
  namespace: string;
  metamodel: string;
  status: 'completed' | 'failed';
  stats: ImportStats;
  startedAt: string;
  completedAt: string;
  triggeredBy: 'cli' | 'gui';
  impactReport?: ImpactReport;
}

export interface ImportRunStatus {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  progress?: ImportProgress;
  stats?: ImportStats;
}

export interface ImportProgress {
  phase: 'parsing' | 'metamodel' | 'namespace' | 'concepts' | 'relationships' | 'finalizing' | 'skipped';
  message: string;
  current?: number;
  total?: number;
}

export interface RunImportParams {
  configPath: string;
  workingDir: string;
  triggeredBy: 'cli' | 'gui';
  /** Optional pre-parsed config data — when provided, skips reading the YAML file */
  configData?: import('./import-types.js').ImportConfigData;
  /**
   * Optional namespace role override. Defaults to 'imported'.
   * Use 'supervised_update_temp' for supervised-update temporary namespaces
   * so they can be distinguished from regular imported namespaces and excluded
   * from normal user-facing views.
   */
  namespaceRole?: 'imported' | 'authored' | 'supervised_update_temp';
  /**
   * When true, the write service will NOT overwrite the stored config_data
   * on the Source node in the DB for existing sources.
   *
   * Use this for git-ref branch imports where configData.project_dir has been
   * temporarily remapped to a checkout directory and must NOT be persisted —
   * the source's canonical project_dir (already in the DB) must be preserved.
   */
  preserveStoredConfigData?: boolean;
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void;
}

export interface ImportDiagnostic {
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
}

/** A SourceMaster source record — one per imported namespace in the DB. */
export interface ImportSourceInfo {
  sourceId: string;
  name: string;
  sourceType: string;
  targetNamespace: string;
  targetMetamodel: string;
  importerVersion: string;
  updatedAt: string;
  lastRunStatus: 'completed' | 'failed' | 'running' | null;
  lastRunAt: string | null;
  /** True when the saved DB config no longer matches the last successfully imported state. */
  configDirty: boolean;
  /** Branch name from which data was last imported via git ref. */
  lastImportBranch?: string;
  /** Commit hash from which data was last imported via git ref. */
  lastImportCommitId?: string;
}

/** Parsed import config returned to the UI. */
export interface ImportConfigView {
  sourceId: string;
  sourceType: string;
  namespace: string;
  sourceName: string;
  /** Absolute, or relative to the workspace root. This is the stored, editable value. */
  projectDir: string;
  /**
   * `projectDir` resolved to an absolute filesystem path against the workspace
   * root (see `resolveWorkspacePath`). Derived and read-only — never sent back on
   * save. The UI must use this, not `projectDir`, whenever it hands the path to a
   * filesystem- or git-facing channel, since the renderer has no working
   * directory to resolve a relative value against.
   */
  projectDirAbsolute: string;
  scanResultDir?: string;
  needsFile?: string;
  filesInclude: string[];
  filesExclude: string[];
  elements: Record<string, boolean>;
  /** Absolute path to the YAML config file on disk (optional). */
  configPath?: string;
}

export interface SaveImportConfigParams {
  sourceId: string;
  sourceType: string;
  namespace: string;
  sourceName: string;
  projectDir: string;
  scanResultDir?: string;
  needsFile?: string;
  filesInclude: string[];
  filesExclude: string[];
  elements: Record<string, boolean>;
  configPath?: string;
}

export interface RunFromSourceParams {
  sourceId: string;
  workingDir: string;
}

/** Structured config data stored in DB on the Source node. */
export interface ImportConfigData {
  namespace: string;
  source_name: string;
  project_dir?: string;
  scan_result_dir?: string;
  needs_file?: string;
  files_include?: string[];
  files_exclude?: string[];
  elements?: Record<string, boolean>;
  /** Source type used to resolve the importer (e.g. 'arxml_file') */
  sourceType?: string;
}

/** Params for exporting config from DB to YAML. */
export interface ExportConfigParams {
  sourceId: string;
  outputPath?: string;
}

/** Params for importing config from YAML into DB. */
export interface ImportConfigParams {
  sourceId: string;
  filePath: string;
}

/** A single node in the ARXML tree — flat representation. */
export interface ArxmlTreeNode {
  /** Stable unique identifier — the stable path (e.g. /Components/MySwc). */
  stable_path: string;
  /** AUTOSAR metamodel concept type (e.g. 'application_swc', 'ar_package'). */
  concept: string;
  /** stable_path of the parent node; null for top-level ar_package nodes. */
  parentId: string | null;
  /** All stored attributes for this node, including 'uuid' when present. */
  attributes: Record<string, unknown>;
}

/** Import run and source metadata shown in the viewer header. */
export interface ArxmlImportDetails {
  sourceId: string;
  sourceName: string;
  metamodelName: string;
  metamodelVersion: string;
  lastRunStatus: 'completed' | 'failed' | 'running' | null;
  lastRunAt: string | null;
  errorSummary?: string;
}

/** Full payload returned by imports.getArxmlTree. */
export interface ArxmlTreeData {
  sourceId: string;
  namespace: string;
  importDetails: ArxmlImportDetails;
  /** Flat array of all concept nodes; renderer builds hierarchy via parentId. */
  nodes: ArxmlTreeNode[];
}

/** Metadata about a cross-NS edge connecting a boundary node to an authored node. */
export interface AffectedEdge {
  relationship: string;
  metamodel: string;
  sourceNamespace: string;
  targetNamespace: string;
  authoredNodeId: number;
  authoredNamespace: string;
  authoredConcept: string;
  authoredName: string;
  /**
   * Stable identifier of the authored-side node (e.g. uuid for SAFETY_ANALYSIS).
   * Stored at snapshot time so reconnect can populate `source_external_id` /
   * `target_external_id` in the CrossNSRelationshipInstance attributes without
   * an extra DB round-trip.
   */
  authoredStableId: string;
}

/** A single boundary node captured before the namespace wipe. */
export interface BoundaryNodeSnapshot {
  stablePath: string;
  concept: string;
  attributes: Record<string, unknown>;
  affectedEdges: AffectedEdge[];
}

/** The pre-wipe capture of all boundary nodes for a namespace. */
export interface CrossNsSnapshot {
  namespace: string;
  boundaryNodes: BoundaryNodeSnapshot[];
  /** ISO timestamp of when the snapshot was taken. */
  capturedAt: string;
}

/** Hint for a probable rename when a uuid match is found in the new namespace. */
export interface PossibleRenameTarget {
  stablePath: string;
  nodeId: number;
}

/** A boundary node that no longer exists in the new namespace. */
export interface OrphanedEntry {
  stablePath: string;
  concept: string;
  attributes: Record<string, unknown>;
  affectedEdges: AffectedEdge[];
  possibleRenameTarget?: PossibleRenameTarget;
}

/** A boundary node that exists but has changed attributes. */
export interface ModifiedEntry {
  stablePath: string;
  concept: string;
  changedKeys: string[];
  oldAttributes: Record<string, unknown>;
  newAttributes: Record<string, unknown>;
  newNodeId: number;
  affectedEdges: AffectedEdge[];
}

/** The structured impact report produced after re-import. */
export interface ImpactReport {
  namespace: string;
  runId: string;
  orphaned: OrphanedEntry[];
  modified: ModifiedEntry[];
  stableCount: number;
}

/**
 * An orphaned entry enriched with the namespace it came from.
 * Returned by `imports.listOrphanedEntries` for display in the reconnect picker.
 */
export interface OrphanedEntryWithContext extends OrphanedEntry {
  /** The imported namespace the orphaned element belonged to (e.g. 'SafetySystem'). */
  importedNamespace: string;
  /** The run ID of the import that produced this orphan. */
  runId: string;
}

/** Scope for discovering reconnectable orphaned malfunctions from the live DB. */
export interface ListOrphanedEntriesParams {
  analysisNamespace?: string;
  targetNodeId?: number;
}

/** Result of imports.updateFromImportedBranch (UC-12 direct). */
export type UpdateFromImportedBranchResult =
  | { upToDate: true; branch: string; latestCommitId: string }
  | {
      upToDate: false;
      branch: string;
      latestCommitId: string;
      previousCommitId: string | undefined;
      runSummary: ImportRunSummary;
    };
