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
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RIACORE_WEB_DEV_URL?: string;
  readonly VITE_RIACORE_WEB_DEV_TOKEN?: string;
}

import type {
  AppInfo,
  AppConfig,
  RendererLogEntry,
  ShowInTreePayload,
  NavigationRequest,
  CacheInvalidationOutbound,
  CacheInvalidationMessage,
  WorkspaceConfig,
  WorkspaceInfo,
  WorkspaceStatus,
  DbStatus,
  DbStats,
  NamespaceStats,
  RunImportParams,
  ImportRunSummary,
  ImportRunStatus,
  ImportSourceInfo,
  ImportConfigView,
  SaveImportConfigParams,
  RunFromSourceParams,
  ExportConfigParams,
  ImportConfigParams,
  ArxmlTreeData,
  ImpactReport,
  OrphanedEntry,
  OrphanedEntryWithContext,
  UpdateFromImportedBranchResult,
  PersistorStoreParams,
  PersistorLoadParams,
  PersistorRepairParams,
  StoreResult,
  LoadResult,
  RepairManifestResult,
  LoadProgressPushEvent,
  ProvisionConfigParams,
  ImporterInfo,
  ProfileInfo,
  CreateAuthoredNamespaceParams,
  CreatedNamespaceInfo,
  NamespaceInfo,
  NamespaceDeleteImpactPreview,
  GraphQueryResult,
  ConceptInstanceData,
  MalfunctionData,
  CreateMalfunctionParams,
  CreateRiskRatingParams,
  ReviewItemData,
  TreeChildNode,
  SearchResultNode,
  SearchResult,
  CreateTagParams,
  ScopedPropagationResult,
  GetChildrenResponse,
  PortConnectorResult,
  NamespacePortConnectorsResult,
  ComponentPortConnectorsResult,
  GetPortConnectorsInput,
  GetNamespacePortConnectorsInput,
  GetComponentPortConnectorsInput,
  DiffOptions,
  DiffSummary,
  DiffResultSection,
  DiffResultPage,
  MergeResult,
  NamespaceDiffResult,
  ThreeWayDiffSummary,
  ThreeWayDiffResult,
  ConflictResolution,
  CleanupReport,
  WorkspaceGitConfig,
  GitSemanticDiffParams,
  GitSemanticDiffResult,
  GitEnsureGitignoreResult,
  UnionMergeResult,
  NamespaceSyncStatus,
  SupervisedMergePrepareResult,
  ApplicableCheck,
  CheckRunSummary,
  CheckPageResult,
  NamespaceCheckSummary,
  SafetyExportData,
  LlmSettings,
  LlmSaveSettingsInput,
  LlmStartReviewInput,
  LlmStartReviewResult,
  LlmCancelReviewInput,
  LlmStreamEvent,
  LlmTestConnectionResult,
  LlmDryRunInput,
  LlmDryRunResult,
  MetamodelRenderingConfig,
  MetamodelProfileMetadata,
  NamespaceConnectionGraph,
  ConnectionEntry,
  DisconnectResult,
  CrossNsLinkSettings,
  ExportSettings,
  LayoutRecord,
  ViewLayoutSourceRef,
  DiagramLayout,
  ViewDefinition,
  CreateViewParams,
  UpdateViewParams,
  EvaluateViewParams,
  EvaluationResult,
  MaterializeViewParams,
  MaterializeResult,
  ConceptPresentation,
  GetPresentationInput,
} from '@riacore/app-contracts';
import type {
  GitRepoStatus,
  CommitParams,
  CommitResult,
  BranchInfo,
  TagInfo,
  LogParams,
  CommitEntry,
  CommitLog,
  RemoteInfo,
  FetchParams,
  FetchResult,
  PullParams,
  PullResult,
  PushParams,
  PushResult,
  GitUserConfig,
} from '@riacore/git-service';

declare global {
  interface Window {
    riacore: {
      app: {
        getInfo(): Promise<AppInfo>;
        getConfig(): Promise<AppConfig>;
        openLogsDirectory(): Promise<string>;
        logRendererEvent(entry: RendererLogEntry): Promise<void>;
        /** Run all cleanup routines (remove temp namespaces, dangling nodes, etc.). */
        cleanup(): Promise<CleanupReport>;
      };
      workspace: {
        /** Throws on error */
        open(config: WorkspaceConfig): Promise<WorkspaceInfo>;
        /** Throws on error */
        create(config: WorkspaceConfig): Promise<WorkspaceInfo>;
        getStatus(): Promise<WorkspaceStatus>;
        /** Close the currently-open workspace (releases the DB handle). No-op if nothing is open. */
        close(): Promise<void>;
        /** Read-only probe — no side effects. Returns whether a DB and/or ria-data exist in the directory. */
        probe(workingDir: string): Promise<{ hasDb: boolean; hasRiaData: boolean }>;
        openLogsDirectory(workingDir: string): Promise<string>;
        getRecent(): Promise<string[]>;
        addRecent(workingDir: string): Promise<string[]>;
      };
      db: {
        getStatus(): Promise<DbStatus>;
        /** Checks if DB file still exists on disk; closes stale handle if not */
        probe(): Promise<DbStatus>;
        /** Throws if DB is not open */
        getStats(): Promise<DbStats>;
        /** Per-namespace node and edge counts. Returns [] when DB is closed. */
        getNamespaceStats(): Promise<NamespaceStats[]>;
        close(): Promise<void>;
      };
      imports: {
        /** Throws on error */
        run(params: RunImportParams): Promise<ImportRunSummary>;
        getStatus(runId: string): Promise<ImportRunStatus | null>;
        listSources(): Promise<ImportSourceInfo[]>;
        getConfig(sourceId: string): Promise<ImportConfigView>;
        saveConfig(params: SaveImportConfigParams): Promise<void>;
        runFromSource(params: RunFromSourceParams): Promise<ImportRunSummary>;
        exportConfig(params: ExportConfigParams): Promise<string>;
        importConfig(params: ImportConfigParams): Promise<void>;
        getArxmlTree(sourceId: string): Promise<ArxmlTreeData>;
        getActiveImport(): Promise<{ sourceId: string } | null>;
        getImpactReport(runId: string): Promise<ImpactReport | null>;
        listOrphanedEntries(params?: { analysisNamespace?: string; targetNodeId?: number }): Promise<OrphanedEntryWithContext[]>;
        reconnectOrphanedEntry(params: { entry: OrphanedEntry; newImportedNodeId: number }): Promise<number>;
        deleteSource(sourceId: string): Promise<void>;
        runFromSourceAtRef(params: { sourceId: string; repoDir: string; ref: string; workingDir: string }): Promise<ImportRunSummary>;
        updateFromImportedBranch(params: { sourceId: string; workingDir: string }): Promise<UpdateFromImportedBranchResult>;
      };
      persistor: {
        /** Throws on error */
        load(params: PersistorLoadParams): Promise<LoadResult>;
        /** Throws on error */
        store(params: PersistorStoreParams): Promise<StoreResult>;
        repairManifest(params: PersistorRepairParams): Promise<RepairManifestResult>;
        /** Subscribe to namespace-level load progress push events. Returns an unsubscribe function. */
        onLoadProgress(handler: (event: LoadProgressPushEvent) => void): () => void;
      };
      dialog: {
        openDirectory(options?: { title?: string; defaultPath?: string; relativeTo?: string }): Promise<string | null>;
        saveFile(options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
      };
      shell: {
        openPath(filePath: string): Promise<void>;
      };
      contextMenu: {
        show(items: { id: string; label: string }[]): Promise<string | null>;
      };
      importers: {
        provisionConfig(params: ProvisionConfigParams): Promise<string>;
        listAvailable(): Promise<ImporterInfo[]>;
      };
      profiles: {
        listAvailable(): Promise<ProfileInfo[]>;
      };
      metamodel: {
        getRenderingConfig(params: { metamodel: string }): Promise<MetamodelRenderingConfig>;
        getProfileMetadata(params: { metamodel: string }): Promise<MetamodelProfileMetadata>;
      };
      namespaceConnections: {
        getGraph(): Promise<NamespaceConnectionGraph>;
        connect(params: { sourceNamespace: string; targetNamespace: string }): Promise<ConnectionEntry>;
        disconnect(params: { importedNamespace: string; authoredNamespace: string; deleteDependents: boolean }): Promise<DisconnectResult>;
        countDependents(params: { importedNamespace: string; authoredNamespace: string }): Promise<number>;
      };
      crossNsLinkSettings: {
        getSettings(): Promise<CrossNsLinkSettings>;
        saveSettings(settings: CrossNsLinkSettings): Promise<void>;
      };
      exportSettings: {
        getSettings(): Promise<ExportSettings>;
        saveSettings(settings: ExportSettings): Promise<void>;
      };
      canvasLayout: {
        getLayout(): Promise<DiagramLayout>;
        setRecords(records: LayoutRecord[]): Promise<DiagramLayout>;
        getViewLayout(
          viewName: string,
          sources: ViewLayoutSourceRef[],
        ): Promise<Array<{ nodeId: number; x: number; y: number }>>;
        setViewLayout(
          viewName: string,
          records: Array<{ source: ViewLayoutSourceRef; x: number; y: number }>,
        ): Promise<DiagramLayout>;
      };
      namespaces: {
        list(): Promise<NamespaceInfo[]>;
        createAuthored(params: CreateAuthoredNamespaceParams): Promise<CreatedNamespaceInfo>;
        getChildren(params: { namespace: string; parentNodeId?: number; offset?: number; limit?: number; showAll?: boolean; scopeNamespace?: string }): Promise<GetChildrenResponse>;
        getAncestorPath(params: { namespace: string; nodeId: number }): Promise<number[]>;
        search(params: { query: string; offset?: number; limit?: number }): Promise<SearchResult>;
        previewDeleteImpact(namespace: string): Promise<NamespaceDeleteImpactPreview>;
        delete(namespace: string): Promise<void>;
        getSyncStatus(params: { namespace: string; workingDir: string }): Promise<NamespaceSyncStatus>;
        applyUnionMergeFromFiles(params: { namespace: string; workingDir: string }): Promise<UnionMergeResult>;
        applyUnionMergeFromBranch(params: { namespace: string; workingDir: string; repoDir: string; branchRef: string }): Promise<UnionMergeResult>;
        supervisedMergeFromBranchPrepare(params: { namespace: string; repoDir: string; branchRef: string; workingDir: string }): Promise<SupervisedMergePrepareResult>;
        supervisedMergeCleanup(params: { tempDir: string }): Promise<void>;
      };
      safety: {
        getMalfunctions(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        getMalfunction(params: { nodeId: number }): Promise<MalfunctionData>;
        createMalfunction(params: CreateMalfunctionParams): Promise<{ node_id: number }>;
        updateMalfunction(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteMalfunction(params: { nodeId: number }): Promise<void>;
        attachOccursAt(params: { failureModeNodeId: number; targetNodeId: number }): Promise<{ edge_id: number }>;
        detachOccursAt(params: { failureModeNodeId: number; targetNodeId: number }): Promise<void>;
        moveOccursAt(params: { failureModeNodeId: number; oldTargetNodeId: number; newTargetNodeId: number }): Promise<void>;
        addPropagation(params: { sourceFailureModeNodeId: number; targetFailureModeNodeId: number }): Promise<{ edge_id: number }>;
        removePropagation(params: { sourceFailureModeNodeId: number; targetFailureModeNodeId: number }): Promise<void>;
        getPropagations(params: { failureModeNodeId: number }): Promise<{ propagatesTo: (ConceptInstanceData & { occursAtTarget?: { node_id: number; namespace: string; concept: string } | null })[]; propagatesFrom: (ConceptInstanceData & { occursAtTarget?: { node_id: number; namespace: string; concept: string } | null })[] }>;
        getPropagationsForComponent(params: { structuralNodeId: number; safetyNamespace?: string }): Promise<ScopedPropagationResult>;
        createRiskRating(params: CreateRiskRatingParams): Promise<{ node_id: number }>;
        getRiskRating(params: { failureModeNodeId: number }): Promise<ConceptInstanceData | null>;
        updateRiskRating(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteRiskRating(params: { nodeId: number }): Promise<void>;
        createSafetyTask(params: { namespace: string; name: string; description: string; status: string; type: string; responsible?: string; reference?: string }): Promise<{ node_id: number }>;
        linkSafetyTaskToFm(params: { failureModeNodeId: number; safetyTaskNodeId: number }): Promise<{ edge_id: number }>;
        unlinkSafetyTaskFromFm(params: { failureModeNodeId: number; safetyTaskNodeId: number }): Promise<void>;
        getSafetyTasks(params: { failureModeNodeId: number }): Promise<ConceptInstanceData[]>;
        getAllSafetyTasks(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        getMalfunctionForRiskRating(params: { riskRatingNodeId: number }): Promise<ConceptInstanceData | null>;
        getMalfunctionForReviewItem(params: { reviewItemNodeId: number }): Promise<ConceptInstanceData | null>;
        updateSafetyTask(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteSafetyTask(params: { nodeId: number }): Promise<void>;
        createFunctionalInsufficiency(params: { namespace: string; name: string; description?: string; source?: string }): Promise<{ node_id: number }>;
        linkFunctionalInsufficiencyToFm(params: { failureModeNodeId: number; functionalInsufficiencyNodeId: number }): Promise<{ edge_id: number }>;
        unlinkFunctionalInsufficiencyFromFm(params: { failureModeNodeId: number; functionalInsufficiencyNodeId: number }): Promise<void>;
        getFunctionalInsufficiencies(params: { failureModeNodeId: number }): Promise<ConceptInstanceData[]>;
        getAllFunctionalInsufficiencies(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        getMalfunctionsForFunctionalInsufficiency(params: { functionalInsufficiencyNodeId: number }): Promise<ConceptInstanceData[]>;
        updateFunctionalInsufficiency(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteFunctionalInsufficiency(params: { nodeId: number }): Promise<void>;
        createTriggeringCondition(params: { namespace: string; name: string; description?: string; source?: string }): Promise<{ node_id: number }>;
        linkTriggeringConditionToFm(params: { failureModeNodeId: number; triggeringConditionNodeId: number }): Promise<{ edge_id: number }>;
        unlinkTriggeringConditionFromFm(params: { failureModeNodeId: number; triggeringConditionNodeId: number }): Promise<void>;
        getTriggeringConditions(params: { failureModeNodeId: number }): Promise<ConceptInstanceData[]>;
        getAllTriggeringConditions(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        getMalfunctionsForTriggeringCondition(params: { triggeringConditionNodeId: number }): Promise<ConceptInstanceData[]>;
        updateTriggeringCondition(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteTriggeringCondition(params: { nodeId: number }): Promise<void>;
        createRequirement(params: { namespace: string; name: string; reqId: string; reqText: string; asil?: string; linkedToUrl?: string }): Promise<{ node_id: number }>;
        getRequirement(params: { nodeId: number }): Promise<ConceptInstanceData>;
        getRequirements(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        unlinkRequirementFromFm(params: { failureModeNodeId: number; requirementNodeId: number }): Promise<void>;
        updateRequirement(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteRequirement(params: { nodeId: number }): Promise<void>;
        createSafetyNote(params: { namespace: string; noteText: string; targetNodeId: number }): Promise<{ node_id: number }>;
        getSafetyNote(params: { nodeId: number }): Promise<ConceptInstanceData>;
        getSafetyNotes(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        updateSafetyNote(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteSafetyNote(params: { nodeId: number }): Promise<void>;
        getNoteParent(params: { noteNodeId: number }): Promise<ConceptInstanceData | null>;
        createReviewItem(params: { namespace: string; reviewerComment: string; reviewedElementId: number; name?: string }): Promise<{ node_id: number }>;
        getReviewItem(params: { nodeId: number }): Promise<ReviewItemData>;
        getReviewItems(params: { reviewedElementNodeId: number }): Promise<ReviewItemData[]>;
        getAllReviewItems(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        updateReviewItem(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteReviewItem(params: { nodeId: number }): Promise<void>;
        getMalfunctionsForElement(params: { targetNodeId: number }): Promise<ConceptInstanceData[]>;
        getMalfunctionsForElements(params: { targetNodeIds: number[]; safetyNamespace?: string }): Promise<Record<number, ConceptInstanceData[]>>;
        getMalfunctionsForRequirement(params: { requirementNodeId: number }): Promise<ConceptInstanceData[]>;
        getMalfunctionForTask(params: { safetyTaskNodeId: number }): Promise<ConceptInstanceData | null>;
        getRequirementsForFm(params: { failureModeNodeId: number }): Promise<ConceptInstanceData[]>;
        linkRequirementToFm(params: { failureModeNodeId: number; requirementNodeId: number }): Promise<{ edge_id: number }>;
        getNotesForFm(params: { failureModeNodeId: number }): Promise<ConceptInstanceData[]>;
        createNoteForFm(params: { failureModeNodeId: number; namespace: string; noteText: string }): Promise<{ node_id: number }>;
        getNotesForElement(params: { elementNodeId: number }): Promise<ConceptInstanceData[]>;
        createNoteForElement(params: { elementNodeId: number; namespace: string; noteText: string }): Promise<{ node_id: number }>;
        previewDeleteImpact(params: { nodeId: number }): Promise<import('@riacore/app-contracts').DeleteImpactPreview>;
        getInstance(params: { nodeId: number }): Promise<ConceptInstanceData>;
        createTag(params: CreateTagParams): Promise<{ node_id: number }>;
        getTag(params: { nodeId: number }): Promise<ConceptInstanceData>;
        getAllTags(params: { namespace: string }): Promise<ConceptInstanceData[]>;
        updateTag(params: { nodeId: number; updates: Record<string, unknown> }): Promise<void>;
        deleteTag(params: { nodeId: number }): Promise<void>;
        linkTag(params: { elementNodeId: number; tagNodeId: number }): Promise<{ edge_id: number }>;
        unlinkTag(params: { elementNodeId: number; tagNodeId: number }): Promise<void>;
        getTagsForElement(params: { elementNodeId: number }): Promise<ConceptInstanceData[]>;
        getElementsForTag(params: { tagNodeId: number }): Promise<ConceptInstanceData[]>;
        linkTagCrossNs(params: { tagNodeId: number; importedElementNodeId: number }): Promise<{ edge_id: number }>;
        unlinkTagCrossNs(params: { tagNodeId: number; importedElementNodeId: number }): Promise<void>;
        getTagsForImportedElement(params: { importedElementNodeId: number }): Promise<ConceptInstanceData[]>;
        linkDirectRequirementToFm(params: { failureModeNodeId: number; requirementNodeId: number }): Promise<{ edge_id: number }>;
        unlinkDirectRequirementFromFm(params: { failureModeNodeId: number; requirementNodeId: number }): Promise<void>;
        getDirectRequirementsForFm(params: { failureModeNodeId: number }): Promise<ConceptInstanceData[]>;
        searchRequirementsAcrossNamespaces(params: { query: string }): Promise<ConceptInstanceData[]>;
        exportSphinxNeeds(params: { namespace: string; outputDir: string; includeRiskRatings?: boolean }): Promise<{ exportedFiles: string[]; outputDir: string }>;
        exportXlsx(params: { namespace: string; outputPath: string }): Promise<{ outputPath: string }>;
        getSafetyData(params: { namespace: string }): Promise<SafetyExportData>;
      };
      graph: {
        query(params: { cypher: string }): Promise<GraphQueryResult>;
        expand(params: { nodeId: string; nodeLabel: string; properties: Record<string, unknown> }): Promise<GraphQueryResult>;
      };
      menu: {
        setPropagationState(state: { malfunctionSelected: boolean; propagationStarted: boolean; propagationEndAvailable: boolean }): void;
        onStartPropagation(handler: () => void): () => void;
        onEndPropagation(handler: () => void): () => void;
        onCancelPropagation(handler: () => void): () => void;
        /** Subscribe to native File menu actions. Returns an unsubscribe function. */
        onFileAction(handler: (action: string) => void): () => void;
        /** Subscribe to native Git menu actions. Returns an unsubscribe function. */
        onGitAction(handler: (action: 'commit') => void): () => void;
        /** Subscribe to native Report menu actions. Returns an unsubscribe function. */
        onReportAction(handler: (action: string) => void): () => void;
        /** Enable or disable the Report menu item based on whether a Safety_Namespace is active. */
        setSafetyNamespaceState(state: { active: boolean }): void;
        /** Drive the Edit → Copy/Paste Malfunction enabled state. */
        setMalfunctionClipboardState(state: { canCopy: boolean; canPaste: boolean }): void;
        /** Subscribe to Edit → Copy Malfunction. Returns an unsubscribe function. */
        onCopyMalfunction(handler: () => void): () => void;
        /** Subscribe to Edit → Paste Malfunction. Returns an unsubscribe function. */
        onPasteMalfunction(handler: () => void): () => void;
        /** Push Show-in-Tree menu item enabled states to the main process. */
        setShowInTreeState(state: { showInTreeAvailable: boolean; showReferenceInTreeAvailable: boolean }): void;
        /** Drive the Edit → Add Malfunction enabled state. */
        setAddMalfunctionState(state: { canAddMalfunction: boolean }): void;
        /** Subscribe to Edit → Add Malfunction. Returns an unsubscribe function. */
        onAddMalfunction(handler: () => void): () => void;
        /** Drive the Edit → Delete Malfunction enabled state. */
        setDeleteMalfunctionState(state: { canDeleteMalfunction: boolean }): void;
        /** Subscribe to Edit → Delete Malfunction. Returns an unsubscribe function. */
        onDeleteMalfunction(handler: () => void): () => void;
        /** Subscribe to Edit → Show in Tree. Returns an unsubscribe function. */
        onShowInTree(handler: () => void): () => void;
        /** Subscribe to Edit → Show Reference in Tree. Returns an unsubscribe function. */
        onShowReferenceInTree(handler: () => void): () => void;
        /** Subscribe to Edit → Import All. Returns an unsubscribe function. */
        onImportAll(handler: () => void): () => void;
        /** Subscribe to Help menu actions (e.g. 'about'). Returns an unsubscribe function. */
        onHelpAction(handler: (action: string) => void): () => void;
      };
      window: {
        openGraphCore(): Promise<void>;
        /** Cross-window "Show in Tree" request. Requirements: 4.4 */
        showInTree(payload: ShowInTreePayload): Promise<void>;
        /** Subscribe to navigation requests dispatched from the main process. Requirements: 4.7 */
        onShowInTreeRequest(handler: (req: NavigationRequest) => void): () => void;
        /** Signal to the main process that this spawn renderer is ready. */
        spawnReady(): void;
        /**
         * Renderer signals first themed paint is committed. Main process uses
         * this to show the window only after antd's dark canvas is on screen,
         * eliminating the white flash on dark-mode systems.
         */
        paintReady(): void;
        /**
         * Push the actual antd-resolved theme colors back to the main process
         * so they can be persisted and used as the splash on next launch.
         * Inspired by VS Code's `IPartsSplash`.
         */
        persistTheme(payload: { isDark: boolean; backgroundColor: string; foregroundColor: string }): void;
      };
      cache: {
        /** Fire-and-forget send to the Invalidation_Bus. Requirements: 15.5 */
        invalidate(payload: CacheInvalidationOutbound): void;
        /** Subscribe to inbound cache-invalidation messages. Requirements: 15.5 */
        onCacheInvalidate(handler: (msg: CacheInvalidationMessage) => void): () => void;
      };
      views: {
        list(): Promise<ViewDefinition[]>;
        get(params: { name: string }): Promise<ViewDefinition>;
        create(params: CreateViewParams): Promise<ViewDefinition>;
        update(params: UpdateViewParams): Promise<ViewDefinition>;
        delete(params: { name: string }): Promise<void>;
        evaluate(params: EvaluateViewParams): Promise<EvaluationResult>;
        materialize(params: MaterializeViewParams): Promise<MaterializeResult>;
      };
      presentation: {
        get(params: GetPresentationInput): Promise<ConceptPresentation[]>;
      };
      arxml: {
        getPortConnectors(params: GetPortConnectorsInput): Promise<PortConnectorResult>;
        getNamespacePortConnectors(params: GetNamespacePortConnectorsInput): Promise<NamespacePortConnectorsResult>;
        getComponentPortConnectors(params: GetComponentPortConnectorsInput): Promise<ComponentPortConnectorsResult>;
      };
      diff: {
        computeNamespaces(params: { leftNs: string; rightNs: string; workingDir: string; opts?: DiffOptions }): Promise<DiffSummary>;
        computeFromPaths(params: { leftDir: string; leftNs: string; rightDir: string; rightNs: string; opts?: DiffOptions }): Promise<DiffSummary>;
        computeHybrid(params: { liveNs: string; snapshotDir: string; snapshotNs: string; liveIsLeft: boolean; workingDir: string; opts?: DiffOptions }): Promise<DiffSummary>;
        getDiffResult(params: { diffId: string }): Promise<NamespaceDiffResult | null>;
        getResultPage(params: { diffId: string; section: DiffResultSection; offset: number; limit: number; filterText?: string; filterConceptType?: string; filterRelationshipType?: string }): Promise<DiffResultPage>;
        exportHtml(params: { diffId: string; outputPath: string; targetNamespace?: string; sourceRef?: string; sourceCommit?: string; selectedChangeIds?: string[] }): Promise<{ outputPath: string; bytesWritten: number }>;
        applyMerge(params: { diffId: string; targetNs: string; direction: 'left-into-right' | 'right-into-left'; selectionIds?: string[]; workingDir: string }): Promise<MergeResult>;
        computeThreeWay(params: { baseNs: string; leftNs: string; rightNs: string; workingDir: string; opts?: DiffOptions }): Promise<ThreeWayDiffSummary>;
        getThreeWayResult(params: { diffId: string }): Promise<ThreeWayDiffResult | null>;
        applyThreeWayMerge(params: { diffId: string; targetNs: string; resolutions: ConflictResolution[]; workingDir: string }): Promise<MergeResult>;
      };
      git: {
        isRepo(params: { dir: string }): Promise<boolean>;
        init(params: { dir: string; initialBranch?: string }): Promise<void>;
        getStatus(params: { repoDir: string }): Promise<GitRepoStatus>;
        stageAll(params: { repoDir: string }): Promise<void>;
        stageFiles(params: { repoDir: string; patterns: string[] }): Promise<void>;
        unstageAll(params: { repoDir: string }): Promise<void>;
        commit(params: CommitParams): Promise<CommitResult>;
        getCurrentBranch(params: { repoDir: string }): Promise<string | null>;
        listBranches(params: { repoDir: string }): Promise<BranchInfo[]>;
        createBranch(params: { repoDir: string; name: string; from?: string }): Promise<void>;
        checkoutBranch(params: { repoDir: string; name: string }): Promise<void>;
        deleteBranch(params: { repoDir: string; name: string; force?: boolean }): Promise<void>;
        renameBranch(params: { repoDir: string; oldName: string; newName: string }): Promise<void>;
        getLog(params: LogParams): Promise<CommitLog>;
        getCommit(params: { repoDir: string; ref: string }): Promise<CommitEntry>;
        listRemotes(params: { repoDir: string }): Promise<RemoteInfo[]>;
        addRemote(params: { repoDir: string; name: string; url: string }): Promise<void>;
        removeRemote(params: { repoDir: string; name: string }): Promise<void>;
        setRemoteUrl(params: { repoDir: string; name: string; url: string }): Promise<void>;
        fetch(params: FetchParams): Promise<FetchResult>;
        pull(params: PullParams): Promise<PullResult>;
        push(params: PushParams): Promise<PushResult>;
        getConfig(params: { repoDir: string }): Promise<GitUserConfig>;
        setConfig(params: { repoDir: string; name?: string; email?: string }): Promise<void>;
        getVersion(): Promise<string>;
        semanticDiffCommits(params: GitSemanticDiffParams): Promise<GitSemanticDiffResult>;
        ensureGitignore(params: { repoDir: string }): Promise<GitEnsureGitignoreResult>;
        getWorkspaceConfig(params: { workingDir: string }): Promise<WorkspaceGitConfig | null>;
        saveWorkspaceConfig(params: { workingDir: string; config: WorkspaceGitConfig }): Promise<void>;
        listTags(params: { repoDir: string }): Promise<TagInfo[]>;
        getRepoRoot(params: { dir: string }): Promise<string | null>;
      };
      checks: {
        loadApplicable(params: { namespace: string }): Promise<ApplicableCheck[]>;
        runCheck(params: { checkId: string; namespace: string; pageSize?: number }): Promise<CheckRunSummary>;
        getPage(params: { runId: string; page: number; pageSize: number }): Promise<CheckPageResult>;
        loadSelection(params: { namespace: string }): Promise<string[] | null>;
        saveSelection(params: { namespace: string; selectedIds: string[] }): Promise<void>;
        saveSummary(params: { namespace: string; errors: number; warnings: number; hints: number; checksRun: number }): Promise<void>;
        loadSummary(params: { namespace: string }): Promise<NamespaceCheckSummary | null>;
      };
      llm: {
        getSettings(): Promise<LlmSettings>;
        saveSettings(input: LlmSaveSettingsInput): Promise<void>;
        startReview(input: LlmStartReviewInput): Promise<LlmStartReviewResult>;
        cancelReview(input: LlmCancelReviewInput): Promise<void>;
        testConnection(): Promise<LlmTestConnectionResult>;
        dryRun(input: LlmDryRunInput): Promise<LlmDryRunResult>;
        /** Subscribe to one-way push events from the worker for the active Review_Run. Returns an unsubscribe function. */
        onStream(handler: (evt: LlmStreamEvent) => void): () => void;
      };
    };
  }
}
