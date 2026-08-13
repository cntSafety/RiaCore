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
 * Typed API layer over window.riacore (the Electron preload bridge).
 *
 * All IPC calls go through here — never call window.riacore directly
 * from components or hooks. This is the single place to fix if the
 * IPC contract changes.
 *
 * All methods return T directly and throw Error on failure.
 */
import { installBrowserRiaCoreBridge } from './browserBridge';
import type {
  AppInfo,
  AppConfig,
  RendererLogEntry,
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
  MetamodelProfileMetadata,
  OrphanedEntry,
  OrphanedEntryWithContext,
  PersistorLoadParams,
  PersistorStoreParams,
  PersistorRepairParams,
  LoadResult,
  StoreResult,
  RepairManifestResult,
  LoadProgressPushEvent,
  ImporterInfo,
  ProvisionConfigParams,
  ProfileInfo,
  CreateAuthoredNamespaceParams,
  CreatedNamespaceInfo,
  NamespaceInfo,
  NamespaceDeleteImpactPreview,
  GraphQueryResult,
  ConceptInstanceData,
  MalfunctionData,
  PropagationMalfunctionData,
  ScopedPropagationResult,
  CreateMalfunctionParams,
  CreateRiskRatingParams,
  CreateTagParams,
  ReviewItemData,
  SearchResult,
  GetChildrenResponse,
  PortConnectorResult,
  NamespacePortConnectorsResult,
  ComponentPortConnectorsResult,
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
  ShowInTreePayload,
  NavigationRequest,
  CacheInvalidationOutbound,
  CacheInvalidationMessage,
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
  MetamodelRenderingConfig,
  NamespaceConnectionGraph,
  ConnectionEntry,
  DisconnectResult,
  LayoutRecord,
  DiagramLayout,
} from '@riacore/app-contracts';
import type {
  GitRepoStatus,
  CommitParams,
  CommitResult,
  BranchInfo,
  TagInfo,
  LogParams,
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

installBrowserRiaCoreBridge();

export const api = {
  app: {
    getInfo: (): Promise<AppInfo> =>
      window.riacore.app.getInfo(),
    getConfig: (): Promise<AppConfig> =>
      window.riacore.app.getConfig(),
    openLogsDirectory: (): Promise<string> =>
      window.riacore.app.openLogsDirectory(),
    logRendererEvent: (entry: RendererLogEntry): Promise<void> =>
      window.riacore.app.logRendererEvent(entry),
    cleanup: (): Promise<CleanupReport> =>
      window.riacore.app.cleanup(),
  },

  workspace: {
    open: (workingDir: string, opts?: { forceRecheck?: boolean }): Promise<WorkspaceInfo> =>
      window.riacore.workspace.open({ workingDir, forceRecheck: opts?.forceRecheck } as WorkspaceConfig),
    create: (workingDir: string): Promise<WorkspaceInfo> =>
      window.riacore.workspace.create({ workingDir } as WorkspaceConfig),
    getStatus: (): Promise<WorkspaceStatus> =>
      window.riacore.workspace.getStatus(),
    close: (): Promise<void> =>
      window.riacore.workspace.close(),
    probe: (workingDir: string): Promise<{ hasDb: boolean; hasRiaData: boolean }> =>
      window.riacore.workspace.probe(workingDir),
    openLogsDirectory: (workingDir: string): Promise<string> =>
      window.riacore.workspace.openLogsDirectory(workingDir),
    getRecent: (): Promise<string[]> =>
      window.riacore.workspace.getRecent(),
    addRecent: (workingDir: string): Promise<string[]> =>
      window.riacore.workspace.addRecent(workingDir),
  },

  db: {
    getStatus: (): Promise<DbStatus> =>
      window.riacore.db.getStatus(),
    probe: (): Promise<DbStatus> =>
      window.riacore.db.probe(),
    getStats: (): Promise<DbStats> =>
      window.riacore.db.getStats(),
    getNamespaceStats: (): Promise<NamespaceStats[]> =>
      window.riacore.db.getNamespaceStats(),
    close: (): Promise<void> =>
      window.riacore.db.close(),
  },

  imports: {
    run: (params: RunImportParams): Promise<ImportRunSummary> =>
      window.riacore.imports.run(params),
    getStatus: (runId: string): Promise<ImportRunStatus | null> =>
      window.riacore.imports.getStatus(runId),
    listSources: (): Promise<ImportSourceInfo[]> =>
      window.riacore.imports.listSources(),
    getConfig: (sourceId: string): Promise<ImportConfigView> =>
      window.riacore.imports.getConfig(sourceId),
    saveConfig: (params: SaveImportConfigParams): Promise<void> =>
      window.riacore.imports.saveConfig(params),
    runFromSource: (params: RunFromSourceParams): Promise<ImportRunSummary> =>
      window.riacore.imports.runFromSource(params),
    exportConfig: (params: ExportConfigParams): Promise<string> =>
      window.riacore.imports.exportConfig(params),
    importConfig: (params: ImportConfigParams): Promise<void> =>
      window.riacore.imports.importConfig(params),
    getArxmlTree: (sourceId: string): Promise<ArxmlTreeData> =>
      window.riacore.imports.getArxmlTree(sourceId),
    getActiveImport: (): Promise<{ sourceId: string } | null> =>
      window.riacore.imports.getActiveImport(),
    getImpactReport: (runId: string): Promise<ImpactReport | null> =>
      window.riacore.imports.getImpactReport(runId),
    listOrphanedEntries: (params?: { analysisNamespace?: string; targetNodeId?: number }): Promise<OrphanedEntryWithContext[]> =>
      window.riacore.imports.listOrphanedEntries(params),
    reconnectOrphanedEntry: (entry: OrphanedEntry, newImportedNodeId: number): Promise<number> =>
      window.riacore.imports.reconnectOrphanedEntry({ entry, newImportedNodeId }),
    deleteSource: (sourceId: string): Promise<void> =>
      window.riacore.imports.deleteSource(sourceId),
    runFromSourceAtRef: (sourceId: string, repoDir: string, ref: string, workingDir: string): Promise<ImportRunSummary> =>
      window.riacore.imports.runFromSourceAtRef({ sourceId, repoDir, ref, workingDir }),
    updateFromImportedBranch: (sourceId: string, workingDir: string) =>
      window.riacore.imports.updateFromImportedBranch({ sourceId, workingDir }),
  },

  persistor: {
    load: (params: PersistorLoadParams): Promise<LoadResult> =>
      window.riacore.persistor.load(params),
    store: (params: PersistorStoreParams): Promise<StoreResult> =>
      window.riacore.persistor.store(params),
    /**
     * Universe-scoped store: write ONLY the two universe-layer files
     * (RIA_UNIV_CanvasLayout.json, RIA_UNIV_NamespaceConnection.json) and their
     * Universe_Hash + inventory in the manifest, leaving every namespace-layer
     * file and per-namespace hash byte-identical. Used by the canvas Auto_Save
     * (canvas-layout-auto-save, Req 10.1).
     */
    storeUniverse: (workingDir: string): Promise<StoreResult> =>
      window.riacore.persistor.store({ workingDir, scope: 'universe' }),
    repairManifest: (params: PersistorRepairParams): Promise<RepairManifestResult> =>
      window.riacore.persistor.repairManifest(params),
    onLoadProgress: (handler: (event: LoadProgressPushEvent) => void): (() => void) =>
      window.riacore.persistor.onLoadProgress(handler),
  },

  dialog: {
    openDirectory: (options?: { title?: string; defaultPath?: string; relativeTo?: string }): Promise<string | null> =>
      window.riacore.dialog.openDirectory(options),
    saveFile: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
      window.riacore.dialog.saveFile(options),
  },

  shell: {
    openPath: (filePath: string): Promise<void> =>
      window.riacore.shell.openPath(filePath),
  },

  contextMenu: {
    show: (items: { id: string; label: string }[]): Promise<string | null> =>
      window.riacore.contextMenu.show(items),
  },

  importers: {
    listAvailable: (): Promise<ImporterInfo[]> =>
      window.riacore.importers.listAvailable(),
    provisionConfig: (params: ProvisionConfigParams): Promise<string> =>
      window.riacore.importers.provisionConfig(params),
  },

  profiles: {
    listAvailable: (): Promise<ProfileInfo[]> =>
      window.riacore.profiles.listAvailable(),
  },

  metamodel: {
    getRenderingConfig: (metamodel: string): Promise<MetamodelRenderingConfig> =>
      window.riacore.metamodel.getRenderingConfig({ metamodel }),
    getProfileMetadata: (metamodel: string): Promise<MetamodelProfileMetadata> =>
      window.riacore.metamodel.getProfileMetadata({ metamodel }),
  },

  namespaceConnections: {
    getGraph: (): Promise<NamespaceConnectionGraph> =>
      window.riacore.namespaceConnections.getGraph(),
    connect: (sourceNamespace: string, targetNamespace: string): Promise<ConnectionEntry> =>
      window.riacore.namespaceConnections.connect({ sourceNamespace, targetNamespace }),
    disconnect: (importedNamespace: string, authoredNamespace: string, deleteDependents: boolean): Promise<DisconnectResult> =>
      window.riacore.namespaceConnections.disconnect({ importedNamespace, authoredNamespace, deleteDependents }),
    countDependents: (importedNamespace: string, authoredNamespace: string): Promise<number> =>
      window.riacore.namespaceConnections.countDependents({ importedNamespace, authoredNamespace }),
  },

  canvasLayout: {
    getLayout: (): Promise<DiagramLayout> =>
      window.riacore.canvasLayout.getLayout(),
    setRecords: (records: LayoutRecord[]): Promise<DiagramLayout> =>
      window.riacore.canvasLayout.setRecords(records),
  },

  namespaces: {
    list: (): Promise<NamespaceInfo[]> =>
      window.riacore.namespaces.list(),
    createAuthored: (params: CreateAuthoredNamespaceParams): Promise<CreatedNamespaceInfo> =>
      window.riacore.namespaces.createAuthored(params),
    getChildren: (namespace: string, parentNodeId?: number, offset?: number, limit?: number, showAll?: boolean, scopeNamespace?: string): Promise<GetChildrenResponse> =>
      window.riacore.namespaces.getChildren({ namespace, parentNodeId, offset, limit, showAll, scopeNamespace }),
    getAncestorPath: (namespace: string, nodeId: number): Promise<number[]> =>
      window.riacore.namespaces.getAncestorPath({ namespace, nodeId }),
    search: (query: string, offset?: number, limit?: number): Promise<SearchResult> =>
      window.riacore.namespaces.search({ query, offset, limit }),
    previewDeleteImpact: (namespace: string): Promise<NamespaceDeleteImpactPreview> =>
      window.riacore.namespaces.previewDeleteImpact(namespace),
    delete: (namespace: string): Promise<void> =>
      window.riacore.namespaces.delete(namespace),
    getSyncStatus: (namespace: string, workingDir: string): Promise<NamespaceSyncStatus> =>
      window.riacore.namespaces.getSyncStatus({ namespace, workingDir }),
    applyUnionMergeFromFiles: (namespace: string, workingDir: string): Promise<UnionMergeResult> =>
      window.riacore.namespaces.applyUnionMergeFromFiles({ namespace, workingDir }),
    applyUnionMergeFromBranch: (namespace: string, workingDir: string, repoDir: string, branchRef: string): Promise<UnionMergeResult> =>
      window.riacore.namespaces.applyUnionMergeFromBranch({ namespace, workingDir, repoDir, branchRef }),
    supervisedMergeFromBranchPrepare: (namespace: string, repoDir: string, branchRef: string, workingDir: string): Promise<SupervisedMergePrepareResult> =>
      window.riacore.namespaces.supervisedMergeFromBranchPrepare({ namespace, repoDir, branchRef, workingDir }),
    supervisedMergeCleanup: (tempDir: string): Promise<void> =>
      window.riacore.namespaces.supervisedMergeCleanup({ tempDir }),
  },

  safety: {
    getMalfunctions: (namespace: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getMalfunctions({ namespace }),
    getMalfunction: (nodeId: number): Promise<MalfunctionData> =>
      window.riacore.safety.getMalfunction({ nodeId }),
    createMalfunction: (params: CreateMalfunctionParams): Promise<{ node_id: number }> =>
      window.riacore.safety.createMalfunction(params),
    updateMalfunction: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateMalfunction({ nodeId, updates }),
    deleteMalfunction: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteMalfunction({ nodeId }),
    attachOccursAt: (failureModeNodeId: number, targetNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.attachOccursAt({ failureModeNodeId, targetNodeId }),
    detachOccursAt: (failureModeNodeId: number, targetNodeId: number): Promise<void> =>
      window.riacore.safety.detachOccursAt({ failureModeNodeId, targetNodeId }),
    moveOccursAt: (failureModeNodeId: number, oldTargetNodeId: number, newTargetNodeId: number): Promise<void> =>
      window.riacore.safety.moveOccursAt({ failureModeNodeId, oldTargetNodeId, newTargetNodeId }),
    addPropagation: (sourceFailureModeNodeId: number, targetFailureModeNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.addPropagation({ sourceFailureModeNodeId, targetFailureModeNodeId }),
    removePropagation: (sourceFailureModeNodeId: number, targetFailureModeNodeId: number): Promise<void> =>
      window.riacore.safety.removePropagation({ sourceFailureModeNodeId, targetFailureModeNodeId }),
    getPropagations: (failureModeNodeId: number): Promise<{ propagatesTo: PropagationMalfunctionData[]; propagatesFrom: PropagationMalfunctionData[] }> =>
      window.riacore.safety.getPropagations({ failureModeNodeId }),
    getPropagationsForComponent: (structuralNodeId: number): Promise<ScopedPropagationResult> =>
      window.riacore.safety.getPropagationsForComponent({ structuralNodeId }),
    createRiskRating: (params: CreateRiskRatingParams): Promise<{ node_id: number }> =>
      window.riacore.safety.createRiskRating(params),
    getRiskRating: (failureModeNodeId: number): Promise<ConceptInstanceData | null> =>
      window.riacore.safety.getRiskRating({ failureModeNodeId }),
    updateRiskRating: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateRiskRating({ nodeId, updates }),
    deleteRiskRating: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteRiskRating({ nodeId }),
    createSafetyTask: (namespace: string, name: string, description: string, status: string, type: string, responsible?: string, reference?: string): Promise<{ node_id: number }> =>
      window.riacore.safety.createSafetyTask({ namespace, name, description, status, type, responsible, reference }),
    linkSafetyTaskToFm: (failureModeNodeId: number, safetyTaskNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.linkSafetyTaskToFm({ failureModeNodeId, safetyTaskNodeId }),
    unlinkSafetyTaskFromFm: (failureModeNodeId: number, safetyTaskNodeId: number): Promise<void> =>
      window.riacore.safety.unlinkSafetyTaskFromFm({ failureModeNodeId, safetyTaskNodeId }),
    getSafetyTasks: (failureModeNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getSafetyTasks({ failureModeNodeId }),
    getAllSafetyTasks: (namespace: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getAllSafetyTasks({ namespace }),
    getMalfunctionForRiskRating: (riskRatingNodeId: number): Promise<ConceptInstanceData | null> =>
      window.riacore.safety.getMalfunctionForRiskRating({ riskRatingNodeId }),
    getMalfunctionForReviewItem: (reviewItemNodeId: number): Promise<ConceptInstanceData | null> =>
      window.riacore.safety.getMalfunctionForReviewItem({ reviewItemNodeId }),
    updateSafetyTask: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateSafetyTask({ nodeId, updates }),
    deleteSafetyTask: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteSafetyTask({ nodeId }),
    createRequirement: (namespace: string, name: string, reqId: string, reqText: string, asil?: string, linkedToUrl?: string): Promise<{ node_id: number }> =>
      window.riacore.safety.createRequirement({ namespace, name, reqId, reqText, asil, linkedToUrl }),
    getRequirement: (nodeId: number): Promise<ConceptInstanceData> =>
      window.riacore.safety.getRequirement({ nodeId }),
    getRequirements: (namespace: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getRequirements({ namespace }),
    unlinkRequirementFromFm: (failureModeNodeId: number, requirementNodeId: number): Promise<void> =>
      window.riacore.safety.unlinkRequirementFromFm({ failureModeNodeId, requirementNodeId }),
    updateRequirement: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateRequirement({ nodeId, updates }),
    deleteRequirement: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteRequirement({ nodeId }),
    createSafetyNote: (namespace: string, noteText: string, targetNodeId: number): Promise<{ node_id: number }> =>
      window.riacore.safety.createSafetyNote({ namespace, noteText, targetNodeId }),
    getSafetyNote: (nodeId: number): Promise<ConceptInstanceData> =>
      window.riacore.safety.getSafetyNote({ nodeId }),
    getSafetyNotes: (namespace: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getSafetyNotes({ namespace }),
    updateSafetyNote: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateSafetyNote({ nodeId, updates }),
    deleteSafetyNote: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteSafetyNote({ nodeId }),
    getNoteParent: (noteNodeId: number): Promise<ConceptInstanceData | null> =>
      window.riacore.safety.getNoteParent({ noteNodeId }),
    createReviewItem: (namespace: string, reviewerComment: string, reviewedElementId: number, name?: string): Promise<{ node_id: number }> =>
      window.riacore.safety.createReviewItem({ namespace, reviewerComment, reviewedElementId, name }),
    getReviewItem: (nodeId: number): Promise<ReviewItemData> =>
      window.riacore.safety.getReviewItem({ nodeId }),
    getReviewItems: (reviewedElementNodeId: number): Promise<ReviewItemData[]> =>
      window.riacore.safety.getReviewItems({ reviewedElementNodeId }),
    getAllReviewItems: (namespace: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getAllReviewItems({ namespace }),
    updateReviewItem: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateReviewItem({ nodeId, updates }),
    deleteReviewItem: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteReviewItem({ nodeId }),
    getMalfunctionsForElement: (targetNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getMalfunctionsForElement({ targetNodeId }),
    getMalfunctionsForRequirement: (requirementNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getMalfunctionsForRequirement({ requirementNodeId }),
    getMalfunctionForTask: (safetyTaskNodeId: number): Promise<ConceptInstanceData | null> =>
      window.riacore.safety.getMalfunctionForTask({ safetyTaskNodeId }),
    getRequirementsForFm: (failureModeNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getRequirementsForFm({ failureModeNodeId }),
    linkRequirementToFm: (failureModeNodeId: number, requirementNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.linkRequirementToFm({ failureModeNodeId, requirementNodeId }),
    getNotesForFm: (failureModeNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getNotesForFm({ failureModeNodeId }),
    createNoteForFm: (failureModeNodeId: number, namespace: string, noteText: string): Promise<{ node_id: number }> =>
      window.riacore.safety.createNoteForFm({ failureModeNodeId, namespace, noteText }),
    getNotesForElement: (elementNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getNotesForElement({ elementNodeId }),
    createNoteForElement: (elementNodeId: number, namespace: string, noteText: string): Promise<{ node_id: number }> =>
      window.riacore.safety.createNoteForElement({ elementNodeId, namespace, noteText }),
    previewDeleteImpact: (nodeId: number): Promise<import('@riacore/app-contracts').DeleteImpactPreview> =>
      window.riacore.safety.previewDeleteImpact({ nodeId }),
    getInstance: (nodeId: number): Promise<ConceptInstanceData> =>
      window.riacore.safety.getInstance({ nodeId }),
    createTag: (params: CreateTagParams): Promise<{ node_id: number }> =>
      window.riacore.safety.createTag(params),
    getTag: (nodeId: number): Promise<ConceptInstanceData> =>
      window.riacore.safety.getTag({ nodeId }),
    getAllTags: (namespace: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getAllTags({ namespace }),
    updateTag: (nodeId: number, updates: Record<string, unknown>): Promise<void> =>
      window.riacore.safety.updateTag({ nodeId, updates }),
    deleteTag: (nodeId: number): Promise<void> =>
      window.riacore.safety.deleteTag({ nodeId }),
    linkTag: (elementNodeId: number, tagNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.linkTag({ elementNodeId, tagNodeId }),
    unlinkTag: (elementNodeId: number, tagNodeId: number): Promise<void> =>
      window.riacore.safety.unlinkTag({ elementNodeId, tagNodeId }),
    getTagsForElement: (elementNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getTagsForElement({ elementNodeId }),
    getElementsForTag: (tagNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getElementsForTag({ tagNodeId }),
    linkTagCrossNs: (tagNodeId: number, importedElementNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.linkTagCrossNs({ tagNodeId, importedElementNodeId }),
    unlinkTagCrossNs: (tagNodeId: number, importedElementNodeId: number): Promise<void> =>
      window.riacore.safety.unlinkTagCrossNs({ tagNodeId, importedElementNodeId }),
    getTagsForImportedElement: (importedElementNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getTagsForImportedElement({ importedElementNodeId }),
    linkDirectRequirementToFm: (failureModeNodeId: number, requirementNodeId: number): Promise<{ edge_id: number }> =>
      window.riacore.safety.linkDirectRequirementToFm({ failureModeNodeId, requirementNodeId }),
    unlinkDirectRequirementFromFm: (failureModeNodeId: number, requirementNodeId: number): Promise<void> =>
      window.riacore.safety.unlinkDirectRequirementFromFm({ failureModeNodeId, requirementNodeId }),
    getDirectRequirementsForFm: (failureModeNodeId: number): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.getDirectRequirementsForFm({ failureModeNodeId }),
    searchRequirementsAcrossNamespaces: (query: string): Promise<ConceptInstanceData[]> =>
      window.riacore.safety.searchRequirementsAcrossNamespaces({ query }),
    exportSphinxNeeds: (namespace: string, outputDir: string): Promise<{ exportedFiles: string[]; outputDir: string }> =>
      window.riacore.safety.exportSphinxNeeds({ namespace, outputDir }),
    exportXlsx: (namespace: string, outputPath: string): Promise<{ outputPath: string }> =>
      window.riacore.safety.exportXlsx({ namespace, outputPath }),
    getSafetyData: (namespace: string): Promise<SafetyExportData> =>
      window.riacore.safety.getSafetyData({ namespace }),
  },

  graph: {
    query: (cypher: string): Promise<GraphQueryResult> =>
      window.riacore.graph.query({ cypher }),
    expand: (nodeId: string, nodeLabel: string, properties: Record<string, unknown>): Promise<GraphQueryResult> =>
      window.riacore.graph.expand({ nodeId, nodeLabel, properties }),
  },

  arxml: {
    getPortConnectors: (nodeId: number): Promise<PortConnectorResult> =>
      window.riacore.arxml.getPortConnectors({ nodeId }),
    getNamespacePortConnectors: (namespace: string): Promise<NamespacePortConnectorsResult> =>
      window.riacore.arxml.getNamespacePortConnectors({ namespace }),
    getComponentPortConnectors: (nodeId: number): Promise<ComponentPortConnectorsResult> =>
      window.riacore.arxml.getComponentPortConnectors({ nodeId }),
  },

  menu: {
    setPropagationState: (state: { malfunctionSelected: boolean; propagationStarted: boolean; propagationEndAvailable: boolean }): void =>
      window.riacore.menu.setPropagationState(state),
    onStartPropagation: (handler: () => void): (() => void) =>
      window.riacore.menu.onStartPropagation(handler),
    onEndPropagation: (handler: () => void): (() => void) =>
      window.riacore.menu.onEndPropagation(handler),
    onCancelPropagation: (handler: () => void): (() => void) =>
      window.riacore.menu.onCancelPropagation(handler),
    onFileAction: (handler: (action: string) => void): (() => void) =>
      window.riacore.menu.onFileAction(handler),
    onGitAction: (handler: (action: 'commit' | 'namespace-diff') => void): (() => void) =>
      window.riacore.menu.onGitAction(handler),
    onReportAction: (handler: (action: string) => void): (() => void) =>
      window.riacore.menu.onReportAction(handler),
    setSafetyNamespaceState: (state: { active: boolean }): void =>
      window.riacore.menu.setSafetyNamespaceState(state),
    setMalfunctionClipboardState: (state: { canCopy: boolean; canPaste: boolean }): void =>
      window.riacore.menu.setMalfunctionClipboardState(state),
    onCopyMalfunction: (handler: () => void): (() => void) =>
      window.riacore.menu.onCopyMalfunction(handler),
    onPasteMalfunction: (handler: () => void): (() => void) =>
      window.riacore.menu.onPasteMalfunction(handler),
    setShowInTreeState: (state: { showInTreeAvailable: boolean; showReferenceInTreeAvailable: boolean }): void =>
      window.riacore.menu.setShowInTreeState(state),
    setAddMalfunctionState: (state: { canAddMalfunction: boolean }): void =>
      window.riacore.menu.setAddMalfunctionState(state),
    onAddMalfunction: (handler: () => void): (() => void) =>
      window.riacore.menu.onAddMalfunction(handler),
    setDeleteMalfunctionState: (state: { canDeleteMalfunction: boolean }): void =>
      window.riacore.menu.setDeleteMalfunctionState(state),
    onDeleteMalfunction: (handler: () => void): (() => void) =>
      window.riacore.menu.onDeleteMalfunction(handler),
    onShowInTree: (handler: () => void): (() => void) =>
      window.riacore.menu.onShowInTree(handler),
    onShowReferenceInTree: (handler: () => void): (() => void) =>
      window.riacore.menu.onShowReferenceInTree(handler),
    onImportAll: (handler: () => void): (() => void) =>
      window.riacore.menu.onImportAll(handler),
    onHelpAction: (handler: (action: string) => void): (() => void) =>
      window.riacore.menu.onHelpAction(handler),
  },

  window: {
    openGraphCore: (): Promise<void> =>
      window.riacore.window.openGraphCore(),
    showInTree: (payload: ShowInTreePayload): Promise<void> =>
      window.riacore.window.showInTree(payload),
    onShowInTreeRequest: (handler: (req: NavigationRequest) => void): (() => void) =>
      window.riacore.window.onShowInTreeRequest(handler),
    spawnReady: (): void =>
      window.riacore.window.spawnReady(),
  },

  cache: {
    invalidate: (payload: CacheInvalidationOutbound): void =>
      window.riacore.cache.invalidate(payload),
    onCacheInvalidate: (handler: (msg: CacheInvalidationMessage) => void): (() => void) =>
      window.riacore.cache.onCacheInvalidate(handler),
  },

  diff: {
    computeNamespaces: (
      leftNs: string, rightNs: string, workingDir: string, opts?: DiffOptions,
    ): Promise<DiffSummary> =>
      window.riacore.diff.computeNamespaces({ leftNs, rightNs, workingDir, opts }),

    computeFromPaths: (
      leftDir: string, leftNs: string, rightDir: string, rightNs: string, opts?: DiffOptions,
    ): Promise<DiffSummary> =>
      window.riacore.diff.computeFromPaths({ leftDir, leftNs, rightDir, rightNs, opts }),

    computeHybrid: (
      liveNs: string, snapshotDir: string, snapshotNs: string, liveIsLeft: boolean,
      workingDir: string, opts?: DiffOptions,
    ): Promise<DiffSummary> =>
      window.riacore.diff.computeHybrid({ liveNs, snapshotDir, snapshotNs, liveIsLeft, workingDir, opts }),

    getDiffResult: (diffId: string): Promise<NamespaceDiffResult | null> =>
      window.riacore.diff.getDiffResult({ diffId }),

    getResultPage: (
      diffId: string, section: DiffResultSection, offset: number, limit: number,
      filterText?: string, filterConceptType?: string, filterRelationshipType?: string,
    ): Promise<DiffResultPage> =>
      window.riacore.diff.getResultPage({
        diffId, section, offset, limit, filterText, filterConceptType, filterRelationshipType,
      }),

    applyMerge: (
      diffId: string, targetNs: string,
      direction: 'left-into-right' | 'right-into-left',
      workingDir: string, selectionIds?: string[],
    ): Promise<MergeResult> =>
      window.riacore.diff.applyMerge({ diffId, targetNs, direction, selectionIds, workingDir }),

    computeThreeWay: (
      baseNs: string, leftNs: string, rightNs: string, workingDir: string, opts?: DiffOptions,
    ): Promise<ThreeWayDiffSummary> =>
      window.riacore.diff.computeThreeWay({ baseNs, leftNs, rightNs, workingDir, opts }),

    getThreeWayResult: (diffId: string): Promise<ThreeWayDiffResult | null> =>
      window.riacore.diff.getThreeWayResult({ diffId }),

    applyThreeWayMerge: (
      diffId: string, targetNs: string, resolutions: ConflictResolution[], workingDir: string,
    ): Promise<MergeResult> =>
      window.riacore.diff.applyThreeWayMerge({ diffId, targetNs, resolutions, workingDir }),
  },

  git: {
    isRepo: (dir: string): Promise<boolean> =>
      window.riacore.git.isRepo({ dir }),
    init: (dir: string, initialBranch?: string): Promise<void> =>
      window.riacore.git.init({ dir, initialBranch }),
    getStatus: (repoDir: string): Promise<GitRepoStatus> =>
      window.riacore.git.getStatus({ repoDir }),
    stageAll: (repoDir: string): Promise<void> =>
      window.riacore.git.stageAll({ repoDir }),
    stageFiles: (repoDir: string, patterns: string[]): Promise<void> =>
      window.riacore.git.stageFiles({ repoDir, patterns }),
    unstageAll: (repoDir: string): Promise<void> =>
      window.riacore.git.unstageAll({ repoDir }),
    commit: (params: CommitParams): Promise<CommitResult> =>
      window.riacore.git.commit(params),
    getCurrentBranch: (repoDir: string): Promise<string | null> =>
      window.riacore.git.getCurrentBranch({ repoDir }),
    listBranches: (repoDir: string): Promise<BranchInfo[]> =>
      window.riacore.git.listBranches({ repoDir }),
    createBranch: (repoDir: string, name: string, from?: string): Promise<void> =>
      window.riacore.git.createBranch({ repoDir, name, from }),
    checkoutBranch: (repoDir: string, name: string): Promise<void> =>
      window.riacore.git.checkoutBranch({ repoDir, name }),
    deleteBranch: (repoDir: string, name: string, force?: boolean): Promise<void> =>
      window.riacore.git.deleteBranch({ repoDir, name, force }),
    renameBranch: (repoDir: string, oldName: string, newName: string): Promise<void> =>
      window.riacore.git.renameBranch({ repoDir, oldName, newName }),
    getLog: (params: LogParams): Promise<CommitLog> =>
      window.riacore.git.getLog(params),
    getCommit: (repoDir: string, ref: string) =>
      window.riacore.git.getCommit({ repoDir, ref }),
    listRemotes: (repoDir: string): Promise<RemoteInfo[]> =>
      window.riacore.git.listRemotes({ repoDir }),
    addRemote: (repoDir: string, name: string, url: string): Promise<void> =>
      window.riacore.git.addRemote({ repoDir, name, url }),
    removeRemote: (repoDir: string, name: string): Promise<void> =>
      window.riacore.git.removeRemote({ repoDir, name }),
    setRemoteUrl: (repoDir: string, name: string, url: string): Promise<void> =>
      window.riacore.git.setRemoteUrl({ repoDir, name, url }),
    fetch: (params: FetchParams): Promise<FetchResult> =>
      window.riacore.git.fetch(params),
    pull: (params: PullParams): Promise<PullResult> =>
      window.riacore.git.pull(params),
    push: (params: PushParams): Promise<PushResult> =>
      window.riacore.git.push(params),
    getConfig: (repoDir: string): Promise<GitUserConfig> =>
      window.riacore.git.getConfig({ repoDir }),
    setConfig: (repoDir: string, name?: string, email?: string): Promise<void> =>
      window.riacore.git.setConfig({ repoDir, name, email }),
    getVersion: (): Promise<string> =>
      window.riacore.git.getVersion(),
    semanticDiffCommits: (params: GitSemanticDiffParams): Promise<GitSemanticDiffResult> =>
      window.riacore.git.semanticDiffCommits(params),
    ensureGitignore: (repoDir: string): Promise<GitEnsureGitignoreResult> =>
      window.riacore.git.ensureGitignore({ repoDir }),
    getWorkspaceConfig: (workingDir: string): Promise<WorkspaceGitConfig | null> =>
      window.riacore.git.getWorkspaceConfig({ workingDir }),
    saveWorkspaceConfig: (workingDir: string, config: WorkspaceGitConfig): Promise<void> =>
      window.riacore.git.saveWorkspaceConfig({ workingDir, config }),
    listTags: (repoDir: string): Promise<TagInfo[]> =>
      window.riacore.git.listTags({ repoDir }),
    getRepoRoot: (dir: string): Promise<string | null> =>
      window.riacore.git.getRepoRoot({ dir }),
  },
  checks: {
    loadApplicable: (namespace: string): Promise<ApplicableCheck[]> =>
      window.riacore.checks.loadApplicable({ namespace }),
    runCheck: (checkId: string, namespace: string, pageSize?: number): Promise<CheckRunSummary> =>
      window.riacore.checks.runCheck({ checkId, namespace, pageSize }),
    getPage: (runId: string, page: number, pageSize: number): Promise<CheckPageResult> =>
      window.riacore.checks.getPage({ runId, page, pageSize }),
    loadSelection: (namespace: string): Promise<string[] | null> =>
      window.riacore.checks.loadSelection({ namespace }),
    saveSelection: (namespace: string, selectedIds: string[]): Promise<void> =>
      window.riacore.checks.saveSelection({ namespace, selectedIds }),
    saveSummary: (namespace: string, errors: number, warnings: number, hints: number, checksRun: number): Promise<void> =>
      window.riacore.checks.saveSummary({ namespace, errors, warnings, hints, checksRun }),
    loadSummary: (namespace: string): Promise<NamespaceCheckSummary | null> =>
      window.riacore.checks.loadSummary({ namespace }),
  },

  llm: {
    getSettings: (): Promise<LlmSettings> =>
      window.riacore.llm.getSettings(),
    saveSettings: (input: LlmSaveSettingsInput): Promise<void> =>
      window.riacore.llm.saveSettings(input),
    startReview: (input: LlmStartReviewInput): Promise<LlmStartReviewResult> =>
      window.riacore.llm.startReview(input),
    cancelReview: (input: LlmCancelReviewInput): Promise<void> =>
      window.riacore.llm.cancelReview(input),
    testConnection: (): Promise<import('@riacore/app-contracts').LlmTestConnectionResult> =>
      window.riacore.llm.testConnection(),
    dryRun: (input: import('@riacore/app-contracts').LlmDryRunInput): Promise<import('@riacore/app-contracts').LlmDryRunResult> =>
      window.riacore.llm.dryRun(input),
    /**
     * Subscribe to one-way `llm.stream` push events from the worker for the
     * active Review_Run. Returns an unsubscribe function.
     */
    onStream: (handler: (evt: LlmStreamEvent) => void): (() => void) =>
      window.riacore.llm.onStream(handler),
  },
};
