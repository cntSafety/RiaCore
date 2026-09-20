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
import { WorkspaceConfig, WorkspaceInfo, WorkspaceStatus } from './workspace.js';
import { DbStatus } from './db.js';
import { RunImportParams, ImportRunSummary, ImportRunStatus, ImportSourceInfo, ImportConfigView, SaveImportConfigParams, RunFromSourceParams, ExportConfigParams, ImportConfigParams, ArxmlTreeData, ImpactReport, OrphanedEntry, OrphanedEntryWithContext, ListOrphanedEntriesParams, UpdateFromImportedBranchResult } from './import-types.js';
import { PersistorStoreParams, PersistorLoadParams, PersistorRepairParams, StoreResult, LoadResult, RepairManifestResult, DbStats, NamespaceStats } from './persistor-types.js';
import { ProvisionConfigParams, ImporterInfo } from './provisioning-types.js';
import { ProfileInfo, CreateAuthoredNamespaceParams, CreatedNamespaceInfo, NamespaceInfo, NamespaceDeleteImpactPreview } from './profile-types.js';
import { GraphQueryResult } from './graph-types.js';
import { ConceptInstanceData, MalfunctionData, PropagationMalfunctionData, CreateMalfunctionParams, CreateRiskRatingParams, ReviewItemData, TreeChildNode, GetChildrenResponse, DeleteImpactPreview, SearchResultNode, SearchResult, CreateTagParams, ScopedPropagationResult } from './safety-types.js';
import { ApplicableCheck, CheckRunSummary, CheckPageResult, NamespaceCheckSummary } from './check-types.js';
import { GetPortConnectorsInput, GetNamespacePortConnectorsInput, GetComponentPortConnectorsInput, PortConnectorResult, NamespacePortConnectorsResult, ComponentPortConnectorsResult } from './arxml-types.js';
import type { ShowInTreePayload } from './show-in-tree.js';
import type { DiffOptions, DiffSummary, DiffResultSection, DiffResultPage, MergeResult, NamespaceDiffResult, ThreeWayDiffSummary, ThreeWayDiffResult, ConflictResolution, UnionMergeResult, NamespaceSyncStatus, SupervisedMergePrepareResult } from './diff-types.js';
import type {
  GitRepoStatus, CommitParams, CommitResult, BranchInfo, TagInfo, LogParams,
  CommitEntry, CommitLog, RemoteInfo, FetchParams, FetchResult,
  PullParams, PullResult, PushParams, PushResult, GitUserConfig,
} from './git-types.js';
import type { GitSemanticDiffParams, GitSemanticDiffResult, GitEnsureGitignoreResult, WorkspaceGitConfig } from './git-types.js';
import type { SafetyExportData } from './safety-export-types.js';
import type { LlmSettings, LlmSaveSettingsInput, LlmStartReviewInput, LlmStartReviewResult, LlmCancelReviewInput, LlmTestConnectionResult, LlmDryRunInput, LlmDryRunResult } from './llm-types.js';
import type { MetamodelProfileMetadata, MetamodelRenderingConfig } from './metamodel-types.js';
import type { NamespaceConnectionGraph, ConnectionEntry, DisconnectResult, CrossNsLinkSettings } from './namespace-connection-types.js';
import type { ExportSettings } from './export-settings-types.js';
import type { LayoutRecord, DiagramLayout, ViewLayoutSourceRef } from './canvas-layout-types.js';
import type { ViewDefinition, CreateViewParams, UpdateViewParams, EvaluateViewParams, EvaluationResult, MaterializeViewParams, MaterializeResult } from './view-types.js';
import type { ConceptPresentation, GetPresentationInput } from './presentation-types.js';

export interface AppInfo {
  name: string;
  version: string;
}

export interface AppConfig {
  /** Enables verbose debug logging across all layers. */
  debug: boolean;
}

/** Result of a single cleanup step inside a CleanupReport. */
export interface CleanupStepResult {
  name: string;
  removedCount: number;
  details?: string;
}

/**
 * Report returned by the app.cleanup channel.
 * Contains one CleanupStepResult per registered cleanup routine.
 */
export interface CleanupReport {
  startedAt: string;
  finishedAt: string;
  steps: CleanupStepResult[];
  totalRemoved: number;
  errors: string[];
}

export interface RendererLogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  type: 'window.error' | 'unhandledrejection' | 'mutation.error' | 'renderer.info' | 'renderer.debug';
  message: string;
  stack?: string;
  component?: string;
  context?: Record<string, unknown>;
}

/**
 * IPC channels return the raw success value and throw on failure.
 * `Result<T>` is unwrapped inside the worker before crossing the bridge.
 */
export interface IpcChannelMap {
  'app.getInfo': { input: void; output: AppInfo };
  'app.getConfig': { input: void; output: AppConfig };
  'app.logRendererEvent': { input: RendererLogEntry; output: void };
  /**
   * Run all registered database cleanup routines (remove temp namespaces,
   * dangling nodes, etc.).  Safe to call at any time; all steps are idempotent.
   * Automatically triggered when a workspace is opened.
   */
  'app.cleanup': { input: void; output: CleanupReport };
  'workspace.open': { input: WorkspaceConfig; output: WorkspaceInfo };
  'workspace.create': { input: WorkspaceConfig; output: WorkspaceInfo };
  'workspace.getStatus': { input: void; output: WorkspaceStatus };
  /**
   * Close the currently-open workspace: releases the DB handle and resets the
   * workspace to the no-workspace state. Safe against in-flight loads (the
   * service bound-awaits a tracked ria-data load before closing). Auto-save
   * means no explicit save is required before closing. No-op if nothing is open.
   */
  'workspace.close': { input: void; output: void };
  /**
   * Lightweight read-only probe: checks whether a directory already contains
   * a RIA workspace (DB and/or ria-data folder with a valid manifest).
   * No side effects — never creates or modifies anything.
   * Used by the UI to decide whether to show a "Create new workspace?" confirmation.
   */
  'workspace.probe': { input: { workingDir: string }; output: { hasDb: boolean; hasRiaData: boolean } };
  'db.getStatus': { input: void; output: DbStatus };
  'db.getStats': { input: void; output: DbStats };
  'db.getNamespaceStats': { input: void; output: NamespaceStats[] };
  'db.probe': { input: void; output: DbStatus };
  'db.close': { input: void; output: void };
  'imports.run': { input: RunImportParams; output: ImportRunSummary };
  'imports.getStatus': { input: { runId: string }; output: ImportRunStatus | null };
  'imports.listSources': { input: void; output: ImportSourceInfo[] };
  'imports.getConfig': { input: { sourceId: string }; output: ImportConfigView };
  'imports.saveConfig': { input: SaveImportConfigParams; output: void };
  'imports.runFromSource': { input: RunFromSourceParams; output: ImportRunSummary };
  'imports.getArxmlTree': { input: { sourceId: string }; output: ArxmlTreeData };
  'imports.getActiveImport': { input: void; output: { sourceId: string } | null };
  'imports.exportConfig': { input: ExportConfigParams; output: string };
  'imports.importConfig': { input: ImportConfigParams; output: void };
  'imports.getImpactReport': { input: { runId: string }; output: ImpactReport | null };
  'imports.listOrphanedEntries': { input: ListOrphanedEntriesParams | void; output: OrphanedEntryWithContext[] };
  'imports.reconnectOrphanedEntry': {
    input: { entry: OrphanedEntry; newImportedNodeId: number };
    output: number;
  };
  'persistor.store': { input: PersistorStoreParams; output: StoreResult };
  'persistor.load': { input: PersistorLoadParams; output: LoadResult };
  'persistor.repairManifest': { input: PersistorRepairParams; output: RepairManifestResult };
  'importers.provisionConfig': { input: ProvisionConfigParams; output: string };
  'importers.listAvailable': { input: void; output: ImporterInfo[] };
  'profiles.listAvailable': { input: void; output: ProfileInfo[] };
  'namespaces.list': { input: void; output: NamespaceInfo[] };
  'namespaces.createAuthored': { input: CreateAuthoredNamespaceParams; output: CreatedNamespaceInfo };
  'namespaces.previewDeleteImpact': { input: { namespace: string }; output: NamespaceDeleteImpactPreview };
  'namespaces.delete': { input: { namespace: string }; output: void };
  'namespace.getSyncStatus': { input: { namespace: string; workingDir: string }; output: NamespaceSyncStatus };
  'namespace.applyUnionMergeFromFiles': { input: { namespace: string; workingDir: string }; output: UnionMergeResult };
  'namespace.applyUnionMergeFromBranch': { input: { namespace: string; workingDir: string; repoDir: string; branchRef: string }; output: UnionMergeResult };
  /**
   * UC-15: Supervised Merge from Branch — prepare phase.
   * Checks out ria-data/ from the selected branch to a temp dir, computes a semantic diff
   * between the live namespace and the branch snapshot, and caches the result.
   * Returns the diff summary, resolved commit hash, temp dir path, and an optional sync warning.
   * The caller must later call namespace.supervisedMergeCleanup to delete the temp dir.
   */
  'namespace.supervisedMergeFromBranchPrepare': {
    input: { namespace: string; repoDir: string; branchRef: string; workingDir: string };
    output: SupervisedMergePrepareResult;
  };
  /**
   * UC-15: Supervised Merge from Branch — cleanup phase.
   * Deletes the temporary checkout directory created by namespace.supervisedMergeFromBranchPrepare.
   * Succeeds silently if the directory does not exist.
   */
  'namespace.supervisedMergeCleanup': {
    input: { tempDir: string };
    output: void;
  };
  'imports.deleteSource': { input: { sourceId: string }; output: void };
  /**
   * Run the importer for a source against files at a given git ref (branch or tag),
   * directly writing the result into the source's regular namespace.
   * UC2: "Update from Branch"
   */
  'imports.runFromSourceAtRef': {
    input: { sourceId: string; repoDir: string; ref: string; workingDir: string };
    output: ImportRunSummary;
  };
  /**
   * UC-12 direct: checks if the previously imported branch has a newer commit,
   * and if so, imports and updates the graph directly.
   */
  'imports.updateFromImportedBranch': {
    input: { sourceId: string; workingDir: string };
    output: UpdateFromImportedBranchResult;
  };
  'graph.query': { input: { cypher: string }; output: GraphQueryResult };
  'graph.expand': { input: { nodeId: string; nodeLabel: string; properties: Record<string, unknown> }; output: GraphQueryResult };

  // --- Safety channels ---
  'safety.getMalfunctions': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.getMalfunction': { input: { nodeId: number }; output: MalfunctionData };
  'safety.createMalfunction': { input: CreateMalfunctionParams; output: { node_id: number } };
  'safety.updateMalfunction': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteMalfunction': { input: { nodeId: number }; output: void };
  'safety.attachOccursAt': { input: { failureModeNodeId: number; targetNodeId: number }; output: { edge_id: number } };
  'safety.detachOccursAt': { input: { failureModeNodeId: number; targetNodeId: number }; output: void };
  'safety.moveOccursAt': { input: { failureModeNodeId: number; oldTargetNodeId: number; newTargetNodeId: number }; output: void };
  'safety.addPropagation': { input: { sourceFailureModeNodeId: number; targetFailureModeNodeId: number }; output: { edge_id: number } };
  'safety.removePropagation': { input: { sourceFailureModeNodeId: number; targetFailureModeNodeId: number }; output: void };
  'safety.getPropagations': { input: { failureModeNodeId: number }; output: { propagatesTo: PropagationMalfunctionData[]; propagatesFrom: PropagationMalfunctionData[] } };
  'safety.getPropagationsForComponent': { input: { structuralNodeId: number; safetyNamespace?: string }; output: ScopedPropagationResult };
  'safety.createRiskRating': { input: CreateRiskRatingParams; output: { node_id: number } };
  'safety.getRiskRating': { input: { failureModeNodeId: number }; output: ConceptInstanceData | null };
  'safety.updateRiskRating': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteRiskRating': { input: { nodeId: number }; output: void };
  'safety.createSafetyTask': { input: { namespace: string; name: string; description: string; status: string; type: string; responsible?: string; reference?: string }; output: { node_id: number } };
  'safety.linkSafetyTaskToFm': { input: { failureModeNodeId: number; safetyTaskNodeId: number }; output: { edge_id: number } };
  'safety.unlinkSafetyTaskFromFm': { input: { failureModeNodeId: number; safetyTaskNodeId: number }; output: void };
  'safety.getSafetyTasks': { input: { failureModeNodeId: number }; output: ConceptInstanceData[] };
  'safety.getMalfunctionForTask': { input: { safetyTaskNodeId: number }; output: ConceptInstanceData | null };
  'safety.getMalfunctionForRiskRating': { input: { riskRatingNodeId: number }; output: ConceptInstanceData | null };
  'safety.getMalfunctionForReviewItem': { input: { reviewItemNodeId: number }; output: ConceptInstanceData | null };
  'safety.getAllSafetyTasks': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.updateSafetyTask': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteSafetyTask': { input: { nodeId: number }; output: void };
  // SOTIF: functional insufficiencies (shared node, linked 1-to-n to malfunctions)
  'safety.createFunctionalInsufficiency': { input: { namespace: string; name: string; description?: string; source?: string }; output: { node_id: number } };
  'safety.linkFunctionalInsufficiencyToFm': { input: { failureModeNodeId: number; functionalInsufficiencyNodeId: number }; output: { edge_id: number } };
  'safety.unlinkFunctionalInsufficiencyFromFm': { input: { failureModeNodeId: number; functionalInsufficiencyNodeId: number }; output: void };
  'safety.getFunctionalInsufficiencies': { input: { failureModeNodeId: number }; output: ConceptInstanceData[] };
  'safety.getAllFunctionalInsufficiencies': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.getMalfunctionsForFunctionalInsufficiency': { input: { functionalInsufficiencyNodeId: number }; output: ConceptInstanceData[] };
  'safety.updateFunctionalInsufficiency': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteFunctionalInsufficiency': { input: { nodeId: number }; output: void };
  // SOTIF: triggering conditions (shared node, linked 1-to-n to malfunctions)
  'safety.createTriggeringCondition': { input: { namespace: string; name: string; description?: string; source?: string }; output: { node_id: number } };
  'safety.linkTriggeringConditionToFm': { input: { failureModeNodeId: number; triggeringConditionNodeId: number }; output: { edge_id: number } };
  'safety.unlinkTriggeringConditionFromFm': { input: { failureModeNodeId: number; triggeringConditionNodeId: number }; output: void };
  'safety.getTriggeringConditions': { input: { failureModeNodeId: number }; output: ConceptInstanceData[] };
  'safety.getAllTriggeringConditions': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.getMalfunctionsForTriggeringCondition': { input: { triggeringConditionNodeId: number }; output: ConceptInstanceData[] };
  'safety.updateTriggeringCondition': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteTriggeringCondition': { input: { nodeId: number }; output: void };
  'safety.createRequirement': { input: { namespace: string; name: string; reqId: string; reqText: string; asil?: string; linkedToUrl?: string }; output: { node_id: number } };
  'safety.getRequirement': { input: { nodeId: number }; output: ConceptInstanceData };
  'safety.getRequirements': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.unlinkRequirementFromFm': { input: { failureModeNodeId: number; requirementNodeId: number }; output: void };
  'safety.updateRequirement': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteRequirement': { input: { nodeId: number }; output: void };
  'safety.createSafetyNote': { input: { namespace: string; noteText: string; targetNodeId: number }; output: { node_id: number } };
  'safety.getSafetyNote': { input: { nodeId: number }; output: ConceptInstanceData };
  'safety.getSafetyNotes': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.updateSafetyNote': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteSafetyNote': { input: { nodeId: number }; output: void };
  'safety.getNoteParent': { input: { noteNodeId: number }; output: ConceptInstanceData | null };
  'safety.createReviewItem': { input: { namespace: string; reviewerComment: string; reviewedElementId: number; name?: string }; output: { node_id: number } };
  'safety.getReviewItem': { input: { nodeId: number }; output: ReviewItemData };
  'safety.getReviewItems': { input: { reviewedElementNodeId: number }; output: ReviewItemData[] };
  'safety.getAllReviewItems': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.updateReviewItem': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteReviewItem': { input: { nodeId: number }; output: void };
  'safety.getMalfunctionsForElement': { input: { targetNodeId: number }; output: ConceptInstanceData[] };
  /**
   * Batch peer of `safety.getMalfunctionsForElement`. Every requested node id
   * appears as a key, mapping to an empty array when it has none, so a caller
   * never has to distinguish "no malfunctions" from "not requested".
   */
  'safety.getMalfunctionsForElements': { input: { targetNodeIds: number[]; safetyNamespace?: string }; output: Record<number, ConceptInstanceData[]> };
  'safety.getMalfunctionsForRequirement': { input: { requirementNodeId: number }; output: ConceptInstanceData[] };
  'safety.getRequirementsForFm': { input: { failureModeNodeId: number }; output: ConceptInstanceData[] };
  'safety.linkRequirementToFm': { input: { failureModeNodeId: number; requirementNodeId: number }; output: { edge_id: number } };
  'safety.getNotesForFm': { input: { failureModeNodeId: number }; output: ConceptInstanceData[] };
  'safety.createNoteForFm': { input: { failureModeNodeId: number; namespace: string; noteText: string }; output: { node_id: number } };
  'safety.getNotesForElement': { input: { elementNodeId: number }; output: ConceptInstanceData[] };
  'safety.createNoteForElement': { input: { elementNodeId: number; namespace: string; noteText: string }; output: { node_id: number } };
  'safety.previewDeleteImpact': { input: { nodeId: number }; output: DeleteImpactPreview };
  'safety.getInstance': { input: { nodeId: number }; output: ConceptInstanceData };
  'safety.getInstanceByUuid': { input: { uuid: string }; output: ConceptInstanceData };

  // --- User-defined checks ---
  'checks.loadApplicable': { input: { namespace: string }; output: ApplicableCheck[] };
  'checks.runCheck': { input: { checkId: string; namespace: string; pageSize?: number }; output: CheckRunSummary };
  'checks.getPage': { input: { runId: string; page: number; pageSize: number }; output: CheckPageResult };
  /**
   * Load the persisted check selection for a namespace from
   * {workingDir}/ria-config/check-selection/{namespace}.json.
   * Returns null when no selection has been saved yet.
   */
  'checks.loadSelection': { input: { namespace: string }; output: string[] | null };
  /**
   * Persist the selected check IDs for a namespace to
   * {workingDir}/ria-config/check-selection/{namespace}.json.
   */
  'checks.saveSelection': { input: { namespace: string; selectedIds: string[] }; output: void };
  /**
   * Persist the aggregated check result summary for a namespace to
   * {workingDir}/ria-config/check-summary/{namespace}.json.
   * Called by the renderer after completing a full check run.
   */
  'checks.saveSummary': {
    input: {
      namespace: string;
      errors: number;
      warnings: number;
      hints: number;
      checksRun: number;
    };
    output: void;
  };
  /**
   * Load the persisted check summary for a namespace.
   * Returns null when no summary has been saved yet.
   * The backend computes `isOutdated` by comparing against current DB state
   * and the most recent import run timestamp.
   */
  'checks.loadSummary': { input: { namespace: string }; output: NamespaceCheckSummary | null };

  // --- Tag channels ---
  'safety.createTag': { input: CreateTagParams; output: { node_id: number } };
  'safety.getTag': { input: { nodeId: number }; output: ConceptInstanceData };
  'safety.getAllTags': { input: { namespace: string }; output: ConceptInstanceData[] };
  'safety.updateTag': { input: { nodeId: number; updates: Record<string, unknown> }; output: void };
  'safety.deleteTag': { input: { nodeId: number }; output: void };
  'safety.linkTag': { input: { elementNodeId: number; tagNodeId: number }; output: { edge_id: number } };
  'safety.unlinkTag': { input: { elementNodeId: number; tagNodeId: number }; output: void };
  'safety.getTagsForElement': { input: { elementNodeId: number }; output: ConceptInstanceData[] };
  'safety.getElementsForTag': { input: { tagNodeId: number }; output: ConceptInstanceData[] };
  'safety.linkTagCrossNs': { input: { tagNodeId: number; importedElementNodeId: number }; output: { edge_id: number } };
  'safety.unlinkTagCrossNs': { input: { tagNodeId: number; importedElementNodeId: number }; output: void };
  'safety.getTagsForImportedElement': { input: { importedElementNodeId: number }; output: ConceptInstanceData[] };
  'safety.linkDirectRequirementToFm': { input: { failureModeNodeId: number; requirementNodeId: number }; output: { edge_id: number } };
  'safety.unlinkDirectRequirementFromFm': { input: { failureModeNodeId: number; requirementNodeId: number }; output: void };
  'safety.getDirectRequirementsForFm': { input: { failureModeNodeId: number }; output: ConceptInstanceData[] };
  'safety.searchRequirementsAcrossNamespaces': { input: { query: string }; output: ConceptInstanceData[] };
  /**
   * `includeRiskRatings` mirrors {@link ExportSettings.includeRiskRatings}. It is
   * passed in the payload rather than read from the store inside the handler
   * because the store lives in the Electron main process (`app.getPath('userData')`)
   * and is not injected into worker / CLI dependencies. Omitted → `true`, so
   * existing callers keep the historical output.
   */
  'safety.exportSphinxNeeds': { input: { namespace: string; outputDir: string; includeRiskRatings?: boolean }; output: { exportedFiles: string[]; outputDir: string } };
  'safety.exportXlsx': { input: { namespace: string; outputPath: string }; output: { outputPath: string } };
  'safety.getSafetyData': { input: { namespace: string }; output: SafetyExportData };

  // --- Tree channel ---
  'namespaces.getChildren': { input: { namespace: string; parentNodeId?: number; offset?: number; limit?: number; showAll?: boolean; scopeNamespace?: string }; output: GetChildrenResponse };
  'namespaces.getAncestorPath': { input: { namespace: string; nodeId: number }; output: number[] };
  'namespaces.search': { input: { query: string; offset?: number; limit?: number; exact?: boolean }; output: SearchResult };

  // --- Metamodel channels ---
  /**
   * Read the resolved rendering configuration (icon/color/hidden per concept)
   * for a registered metamodel. Used by the tree to decorate and filter nodes.
   * Requirements: 2.2
   */
  'metamodel.getRenderingConfig': {
    input: { metamodel: string };
    output: MetamodelRenderingConfig;
  };
  /** Ordered enums, slots, classes, and profile-owned review guidance. */
  'metamodel.getProfileMetadata': {
    input: { metamodel: string };
    output: MetamodelProfileMetadata;
  };

  // --- Namespace connection channels ---
  /**
   * Return the full namespace connection graph (imported namespaces, analysis
   * namespaces, and the directed imported→authored connections between them).
   * Requirements: 2.2
   */
  'namespaceConnections:getGraph': { input: void; output: NamespaceConnectionGraph };
  /**
   * Create exactly one per-pair connection from an imported namespace to an
   * analysis namespace. Idempotent: reports `alreadyConnected` when the edge
   * already existed. Throws on invalid (same-role / reversed) pairs.
   * Requirements: 9.4
   */
  'namespaceConnections:connect': {
    input: { sourceNamespace: string; targetNamespace: string };
    output: ConnectionEntry;
  };
  /**
   * Remove one per-pair connection. When `deleteDependents` is true, also delete
   * the pair's dependent Cross_Namespace_Relationship instances. Throws when the
   * connection does not exist.
   * Requirements: 9.4
   */
  'namespaceConnections:disconnect': {
    input: { importedNamespace: string; authoredNamespace: string; deleteDependents: boolean };
    output: DisconnectResult;
  };
  /**
   * Count the dependent Cross_Namespace_Relationship instances for a specific
   * (imported, authored) pair, backing the disconnect confirmation step.
   * Requirements: 9.4
   */
  'namespaceConnections:countDependents': {
    input: { importedNamespace: string; authoredNamespace: string };
    output: number;
  };

  /**
   * Global (per-user, workspace-independent) preference governing what the
   * Imported Requirement picker does when a matching element's namespace
   * isn't yet connected to the current analysis. See `CrossNsLinkSettings`.
   */
  'crossNsLinkSettings.getSettings':  { input: void;                 output: CrossNsLinkSettings };
  'crossNsLinkSettings.saveSettings': { input: CrossNsLinkSettings;  output: void };

  /**
   * Global (per-user, workspace-independent) report-export preferences —
   * currently whether the semi-quantitative risk-rating values (Severity,
   * Occurrence, Detection, RPN) are written into exported reports.
   * See `ExportSettings`.
   */
  'exportSettings.getSettings':  { input: void;            output: ExportSettings };
  'exportSettings.saveSettings': { input: ExportSettings;  output: void };

  // --- Canvas layout channels ---
  /**
   * Return the current Diagram_Layout: one LayoutRecord per positioned
   * Canvas_Element (empty array when no records exist). Returns the value on
   * success and throws an Error on retrieval failure (no partial layout).
   * Requirements: 1.5
   */
  'canvasLayout:getLayout': { input: void; output: DiagramLayout };
  /**
   * Upsert one or more Layout_Records (MERGE on the stable composite layout_id).
   * Rejects the whole batch and leaves the stored layout unchanged when any record
   * has a non-finite coordinate. Returns the current Diagram_Layout on success and
   * throws an Error on failure.
   * Requirements: 1.5
   */
  'canvasLayout:setRecords': {
    input: { records: LayoutRecord[] };
    output: DiagramLayout;
  };
  /**
   * Positions stored for a view's content, keyed by the `node_id` of each
   * representative's source element — which is what an evaluation result
   * carries, so the caller does not have to redo the `stable_path` resolution
   * the service just did (spec-view.md Phase 4.2).
   *
   * `sources` names the representatives whose positions are wanted; a source
   * with no stored position, or one whose element no longer exists, is simply
   * absent from the result and is auto-laid-out by the consumer.
   *
   * The wire shape is an array of pairs rather than a Map, because a Map does
   * not survive structured cloning through every bridge this crosses.
   */
  'canvasLayout:getViewLayout': {
    input: { viewName: string; sources: ViewLayoutSourceRef[] };
    output: Array<{ nodeId: number; x: number; y: number }>;
  };
  /**
   * Persist positions for a view's representatives, keyed by the `stable_path`
   * of each one's source element so they survive a reimport and the node-id
   * reassignment it brings. A source that cannot be resolved to a `stable_path`
   * is skipped rather than keyed on something unstable.
   */
  'canvasLayout:setViewLayout': {
    input: { viewName: string; records: Array<{ source: ViewLayoutSourceRef; x: number; y: number }> };
    output: DiagramLayout;
  };

  // --- View channels (docs/coreSpecs/RiaViews.md) ---
  /** Enumerate view definitions. */
  'views.list': { input: void; output: ViewDefinition[] };
  /** Retrieve one view definition with its sources and metamodels. */
  'views.get': { input: { name: string }; output: ViewDefinition };
  /**
   * Create a view definition. Validates name uniqueness across views and
   * namespaces, at least one source namespace, existence of every referenced
   * namespace/metamodel, resolvability of the mapping, and that `CommonModel` is
   * not attached as a categorizational metamodel.
   */
  'views.create': { input: CreateViewParams; output: ViewDefinition };
  /**
   * Update a view definition. Changing `newName` or `metamodel` is
   * identity-bearing and is handled as delete-and-create.
   */
  'views.update': { input: UpdateViewParams; output: ViewDefinition };
  /** Delete a view definition and its relationships. No content cascade (no stored content). */
  'views.delete': { input: { name: string }; output: void };
  /**
   * Compute a view's content in one of the four evaluation modes. Read-only:
   * acquires no write lock and produces no writes to the graph.
   */
  'views.evaluate': { input: EvaluateViewParams; output: EvaluationResult };
  /**
   * Materialize a view's content into a new authored namespace. A write
   * operation, unlike evaluation.
   */
  'views.materialize': { input: MaterializeViewParams; output: MaterializeResult };

  // --- Presentation channels (spec-view.md Phase 4.1) ---
  /**
   * Concept presentation entries for one metamodel, ordered by `order` then
   * `concept`. Read-only, and read from a JSON catalog rather than the graph:
   * presentation is deliberately stored outside the view and outside
   * `CommonModel` (docs/coreSpecs/RiaViews.md — P6). A consumer uses this
   * instead of hardcoding per-metamodel concept lists; a concept with no entry
   * is one the consumer does not render.
   */
  'presentation.get': { input: GetPresentationInput; output: ConceptPresentation[] };

  // --- Window channels (main-process only, not relayed to worker) ---
  'window.openGraphCore': { input: void; output: void };
  /**
   * Cross-window "Show in Tree" request. Handled in the main process by
   * Spawn_Manager. NOT added to IPC_CHANNELS and NOT routed to the worker.
   * Requirements: 4.1, 4.2, 4.3
   */
  'window.showInTree': { input: ShowInTreePayload; output: void };

  // --- ARXML channels ---
  'arxml.getPortConnectors': { input: GetPortConnectorsInput; output: PortConnectorResult };
  'arxml.getNamespacePortConnectors': { input: GetNamespacePortConnectorsInput; output: NamespacePortConnectorsResult };
  'arxml.getComponentPortConnectors': { input: GetComponentPortConnectorsInput; output: ComponentPortConnectorsResult };

  // --- Diff channels ---
  /**
   * Compute a two-way diff between two live namespaces in the active workspace.
   * Returns a lightweight DiffSummary (counts only). Full arrays are server-side;
   * retrieve pages via diff.getResultPage and the full result via diff.getDiffResult.
   */
  'diff.computeNamespaces': {
    input: { leftNs: string; rightNs: string; workingDir: string; opts?: DiffOptions };
    output: DiffSummary;
  };
  /** Compute a two-way diff between two serialized snapshot directories (no live DB needed). */
  'diff.computeFromPaths': {
    input: { leftDir: string; leftNs: string; rightDir: string; rightNs: string; opts?: DiffOptions };
    output: DiffSummary;
  };
  /** Compute a two-way diff between a live namespace and a serialized snapshot. */
  'diff.computeHybrid': {
    input: { liveNs: string; snapshotDir: string; snapshotNs: string; liveIsLeft: boolean; workingDir: string; opts?: DiffOptions };
    output: DiffSummary;
  };
  /** Fetch the full NamespaceDiffResult for a previously computed diff (by diffId). */
  'diff.getDiffResult': {
    input: { diffId: string };
    output: NamespaceDiffResult | null;
  };
  /**
   * Fetch a paginated page from a specific section of a diff result.
   * Supports optional text filter and concept/relationship type filters.
   */
  'diff.getResultPage': {
    input: {
      diffId: string;
      section: DiffResultSection;
      offset: number;
      limit: number;
      filterText?: string;
      filterConceptType?: string;
      filterRelationshipType?: string;
    };
    output: DiffResultPage;
  };
  /** Apply a merge: write the diff changes to the target namespace in the live DB. */
  'diff.applyMerge': {
    input: {
      diffId: string;
      targetNs: string;
      direction: 'left-into-right' | 'right-into-left';
      /** Stable IDs to apply; if omitted all changes are applied */
      selectionIds?: string[];
      workingDir: string;
    };
    output: MergeResult;
  };
  /**
   * Compute a three-way diff (base, left variant, right variant).
   * Returns a ThreeWayDiffSummary. Full data accessible via diff.getThreeWayResult.
   */
  'diff.computeThreeWay': {
    input: { baseNs: string; leftNs: string; rightNs: string; workingDir: string; opts?: DiffOptions };
    output: ThreeWayDiffSummary;
  };
  /** Fetch the full ThreeWayDiffResult for a previously computed three-way diff. */
  'diff.getThreeWayResult': {
    input: { diffId: string };
    output: ThreeWayDiffResult | null;
  };
  /** Apply conflict resolutions to a three-way diff and produce a merged namespace. */
  'diff.applyThreeWayMerge': {
    input: {
      diffId: string;
      targetNs: string;
      resolutions: ConflictResolution[];
      workingDir: string;
    };
    output: MergeResult;
  };

  // ── Git channels ────────────────────────────────────────────────────────────
  'git.isRepo':                { input: { dir: string }; output: boolean };
  'git.init':                  { input: { dir: string; initialBranch?: string }; output: void };
  'git.getStatus':             { input: { repoDir: string }; output: GitRepoStatus };
  'git.stageAll':              { input: { repoDir: string }; output: void };
  'git.stageFiles':            { input: { repoDir: string; patterns: string[] }; output: void };
  'git.unstageAll':            { input: { repoDir: string }; output: void };
  'git.commit':                { input: CommitParams; output: CommitResult };
  'git.getCurrentBranch':      { input: { repoDir: string }; output: string | null };
  'git.listBranches':          { input: { repoDir: string }; output: BranchInfo[] };
  'git.createBranch':          { input: { repoDir: string; name: string; from?: string }; output: void };
  'git.checkoutBranch':        { input: { repoDir: string; name: string }; output: void };
  'git.deleteBranch':          { input: { repoDir: string; name: string; force?: boolean }; output: void };
  'git.renameBranch':          { input: { repoDir: string; oldName: string; newName: string }; output: void };
  'git.getLog':                { input: LogParams; output: CommitLog };
  'git.getCommit':             { input: { repoDir: string; ref: string }; output: CommitEntry | null };
  'git.listRemotes':           { input: { repoDir: string }; output: RemoteInfo[] };
  'git.addRemote':             { input: { repoDir: string; name: string; url: string }; output: void };
  'git.removeRemote':          { input: { repoDir: string; name: string }; output: void };
  'git.setRemoteUrl':          { input: { repoDir: string; name: string; url: string }; output: void };
  'git.fetch':                 { input: FetchParams; output: FetchResult };
  'git.pull':                  { input: PullParams; output: PullResult };
  'git.push':                  { input: PushParams; output: PushResult };
  'git.getConfig':             { input: { repoDir: string }; output: GitUserConfig };
  'git.setConfig':             { input: { repoDir: string } & Partial<GitUserConfig>; output: void };
  'git.getVersion':            { input: void; output: string };
  'git.semanticDiffCommits':   { input: GitSemanticDiffParams; output: GitSemanticDiffResult };
  'git.ensureGitignore':       { input: { repoDir: string }; output: GitEnsureGitignoreResult };
  'git.getWorkspaceConfig':    { input: { workingDir: string }; output: WorkspaceGitConfig | null };
  'git.saveWorkspaceConfig':   { input: { workingDir: string; config: WorkspaceGitConfig }; output: void };
  /** List all tags in the repository. */
  'git.listTags':              { input: { repoDir: string }; output: TagInfo[] };
  /** Return the absolute path to the repo root for the given directory, or null if not in a repo. */
  'git.getRepoRoot':           { input: { dir: string }; output: string | null };

  // ── LLM channels ───────────────────────────────────────────────────────────
  // Category: `llm`. Registration metadata (set in handlers/llm-channels.ts):
  //   - llm.getSettings  → requiresWorkspace: false (Settings_Dialog must work before any workspace is opened)
  //   - llm.saveSettings → requiresWorkspace: false (same)
  //   - llm.cancelReview → requiresWorkspace: false (cancel must succeed even if the workspace was just closed)
  //   - llm.startReview  → requiresWorkspace: true  (reads safety / arxml / SysML graph for bundle assembly)
  // `llm.stream` is intentionally NOT in this map — it is a one-way `webContents.send` push channel.
  'llm.getSettings':  { input: void;                 output: LlmSettings };
  'llm.saveSettings': { input: LlmSaveSettingsInput; output: void };
  'llm.startReview':  { input: LlmStartReviewInput;  output: LlmStartReviewResult };
  'llm.cancelReview': { input: LlmCancelReviewInput; output: void };
  'llm.testConnection': { input: void;               output: LlmTestConnectionResult };
  'llm.dryRun':         { input: LlmDryRunInput;      output: LlmDryRunResult };
}

export type WorkerIpcChannel = Exclude<keyof IpcChannelMap, 'app.logRendererEvent' | 'app.getConfig' | 'window.openGraphCore' | 'window.showInTree'>;

export const IPC_CHANNELS: WorkerIpcChannel[] = [
  'app.getInfo',
  'app.cleanup',
  'workspace.open',
  'workspace.create',
  'workspace.getStatus',
  'workspace.close',
  'workspace.probe',
  'db.getStatus',
  'db.getStats',
  'db.getNamespaceStats',
  'db.probe',
  'db.close',
  'imports.run',
  'imports.getStatus',
  'imports.listSources',
  'imports.getConfig',
  'imports.saveConfig',
  'imports.runFromSource',
  'imports.getArxmlTree',
  'imports.getActiveImport',
  'imports.exportConfig',
  'imports.importConfig',
  'imports.getImpactReport',
  'imports.listOrphanedEntries',
  'imports.reconnectOrphanedEntry',
  'persistor.store',
  'persistor.load',
  'persistor.repairManifest',
  'importers.provisionConfig',
  'importers.listAvailable',
  'profiles.listAvailable',
  'namespaces.list',
  'namespaces.createAuthored',
  'graph.query',
  'graph.expand',
  'safety.getMalfunctions',
  'safety.getMalfunction',
  'safety.createMalfunction',
  'safety.updateMalfunction',
  'safety.deleteMalfunction',
  'safety.attachOccursAt',
  'safety.detachOccursAt',
  'safety.moveOccursAt',
  'safety.addPropagation',
  'safety.removePropagation',
  'safety.getPropagations',
  'safety.getPropagationsForComponent',
  'safety.createRiskRating',
  'safety.getRiskRating',
  'safety.updateRiskRating',
  'safety.deleteRiskRating',
  'safety.createSafetyTask',
  'safety.linkSafetyTaskToFm',
  'safety.unlinkSafetyTaskFromFm',
  'safety.getSafetyTasks',
  'safety.getMalfunctionForTask',
  'safety.getMalfunctionForRiskRating',
  'safety.getMalfunctionForReviewItem',
  'safety.getAllSafetyTasks',
  'safety.updateSafetyTask',
  'safety.deleteSafetyTask',
  'safety.createFunctionalInsufficiency',
  'safety.linkFunctionalInsufficiencyToFm',
  'safety.unlinkFunctionalInsufficiencyFromFm',
  'safety.getFunctionalInsufficiencies',
  'safety.getAllFunctionalInsufficiencies',
  'safety.getMalfunctionsForFunctionalInsufficiency',
  'safety.updateFunctionalInsufficiency',
  'safety.deleteFunctionalInsufficiency',
  'safety.createTriggeringCondition',
  'safety.linkTriggeringConditionToFm',
  'safety.unlinkTriggeringConditionFromFm',
  'safety.getTriggeringConditions',
  'safety.getAllTriggeringConditions',
  'safety.getMalfunctionsForTriggeringCondition',
  'safety.updateTriggeringCondition',
  'safety.deleteTriggeringCondition',
  'safety.createRequirement',
  'safety.getRequirement',
  'safety.getRequirements',
  'safety.unlinkRequirementFromFm',
  'safety.updateRequirement',
  'safety.deleteRequirement',
  'safety.createSafetyNote',
  'safety.getSafetyNote',
  'safety.getSafetyNotes',
  'safety.updateSafetyNote',
  'safety.deleteSafetyNote',
  'safety.getNoteParent',
  'safety.createReviewItem',
  'safety.getReviewItem',
  'safety.getReviewItems',
  'safety.getAllReviewItems',
  'safety.updateReviewItem',
  'safety.deleteReviewItem',
  'safety.getMalfunctionsForElement',
  'safety.getMalfunctionsForElements',
  'safety.getMalfunctionsForRequirement',
  'safety.getRequirementsForFm',
  'safety.linkRequirementToFm',
  'safety.getNotesForFm',
  'safety.createNoteForFm',
  'safety.getNotesForElement',
  'safety.createNoteForElement',
  'safety.previewDeleteImpact',
  'safety.getInstance',
  'safety.getInstanceByUuid',
  'safety.createTag',
  'safety.getTag',
  'safety.getAllTags',
  'safety.updateTag',
  'safety.deleteTag',
  'safety.linkTag',
  'safety.unlinkTag',
  'safety.getTagsForElement',
  'safety.getElementsForTag',
  'safety.linkTagCrossNs',
  'safety.unlinkTagCrossNs',
  'safety.getTagsForImportedElement',
  'safety.linkDirectRequirementToFm',
  'safety.unlinkDirectRequirementFromFm',
  'safety.getDirectRequirementsForFm',
  'safety.searchRequirementsAcrossNamespaces',
  'safety.exportSphinxNeeds',
  'safety.exportXlsx',
  'safety.getSafetyData',
  // user-defined checks
  'checks.loadApplicable',
  'checks.runCheck',
  'checks.getPage',
  'checks.loadSelection',
  'checks.saveSelection',
  'checks.saveSummary',
  'checks.loadSummary',
  'namespaces.getChildren',
  'namespaces.getAncestorPath',
  'namespaces.search',
  // metamodel channels
  'metamodel.getRenderingConfig',
  'metamodel.getProfileMetadata',
  // namespace connection channels
  'namespaceConnections:getGraph',
  'namespaceConnections:connect',
  'namespaceConnections:disconnect',
  'namespaceConnections:countDependents',
  'crossNsLinkSettings.getSettings',
  'crossNsLinkSettings.saveSettings',
  // report-export settings channels
  'exportSettings.getSettings',
  'exportSettings.saveSettings',
  // canvas layout channels
  'canvasLayout:getLayout',
  'canvasLayout:setRecords',
  'canvasLayout:getViewLayout',
  'canvasLayout:setViewLayout',
  // view channels
  'views.list',
  'views.get',
  'views.create',
  'views.update',
  'views.delete',
  'views.evaluate',
  'views.materialize',
  // presentation channels
  'presentation.get',
  'namespaces.previewDeleteImpact',
  'namespaces.delete',
  'namespace.getSyncStatus',
  'namespace.applyUnionMergeFromFiles',
  'namespace.applyUnionMergeFromBranch',
  'namespace.supervisedMergeFromBranchPrepare',
  'namespace.supervisedMergeCleanup',
  'imports.deleteSource',
  'arxml.getPortConnectors',
  'arxml.getNamespacePortConnectors',
  'arxml.getComponentPortConnectors',
  'imports.runFromSourceAtRef',
  'imports.updateFromImportedBranch',
  // diff channels
  'diff.computeNamespaces',
  'diff.computeFromPaths',
  'diff.computeHybrid',
  'diff.getDiffResult',
  'diff.getResultPage',
  'diff.applyMerge',
  'diff.computeThreeWay',
  'diff.getThreeWayResult',
  'diff.applyThreeWayMerge',
  // git channels
  'git.isRepo',
  'git.init',
  'git.getStatus',
  'git.stageAll',
  'git.stageFiles',
  'git.unstageAll',
  'git.commit',
  'git.getCurrentBranch',
  'git.listBranches',
  'git.createBranch',
  'git.checkoutBranch',
  'git.deleteBranch',
  'git.renameBranch',
  'git.getLog',
  'git.getCommit',
  'git.listRemotes',
  'git.addRemote',
  'git.removeRemote',
  'git.setRemoteUrl',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.getConfig',
  'git.setConfig',
  'git.getVersion',
  'git.semanticDiffCommits',
  'git.ensureGitignore',
  'git.getWorkspaceConfig',
  'git.saveWorkspaceConfig',
  'git.listTags',
  'git.getRepoRoot',
  // llm channels
  'llm.getSettings',
  'llm.saveSettings',
  'llm.startReview',
  'llm.cancelReview',
  'llm.testConnection',
  'llm.dryRun',
] as const;
