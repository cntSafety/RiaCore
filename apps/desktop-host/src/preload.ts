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
import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceConfig, RunImportParams, PersistorLoadParams, PersistorStoreParams, PersistorRepairParams, ProvisionConfigParams, SaveImportConfigParams, RunFromSourceParams, ExportConfigParams, ImportConfigParams, CreateAuthoredNamespaceParams, CreateMalfunctionParams, CreateRiskRatingParams, CreateTagParams, RendererLogEntry, GetPortConnectorsInput, GetNamespacePortConnectorsInput, GetComponentPortConnectorsInput, DiffOptions, DiffResultSection, ConflictResolution, WorkspaceGitConfig, GitSemanticDiffParams, SupervisedMergePrepareResult } from '@riacore/app-contracts';
import type { ShowInTreePayload, NavigationRequest, CacheInvalidationOutbound, CacheInvalidationMessage, LoadProgressPushEvent } from '@riacore/app-contracts';
import type { LlmSaveSettingsInput, LlmStartReviewInput, LlmStartReviewResult, LlmCancelReviewInput, LlmStreamEvent, LlmSettings } from '@riacore/app-contracts';
import type { LayoutRecord, ViewLayoutSourceRef } from '@riacore/app-contracts';
import type { CrossNsLinkSettings } from '@riacore/app-contracts';
import type { CreateViewParams, UpdateViewParams, EvaluateViewParams, MaterializeViewParams, GetPresentationInput } from '@riacore/app-contracts';
import type { CommitParams, FetchParams, PullParams, PushParams, LogParams } from '@riacore/git-service';
import type { IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('riacore', {
  app: {
    getInfo: () => ipcRenderer.invoke('app.getInfo'),
    getConfig: () => ipcRenderer.invoke('app.getConfig'),
    openLogsDirectory: () => ipcRenderer.invoke('app.openLogsDirectory') as Promise<string>,
    logRendererEvent: (entry: RendererLogEntry) => ipcRenderer.invoke('app.logRendererEvent', entry) as Promise<void>,
    cleanup: () => ipcRenderer.invoke('app.cleanup'),
  },
  workspace: {
    open:      (config: WorkspaceConfig) => ipcRenderer.invoke('workspace.open', config),
    create:    (config: WorkspaceConfig) => ipcRenderer.invoke('workspace.create', config),
    getStatus: ()                         => ipcRenderer.invoke('workspace.getStatus'),
    close:     ()                         => ipcRenderer.invoke('workspace.close') as Promise<void>,
    probe:     (workingDir: string)       => ipcRenderer.invoke('workspace.probe', { workingDir }) as Promise<{ hasDb: boolean; hasRiaData: boolean }>,
    openLogsDirectory: (workingDir: string) => ipcRenderer.invoke('workspace.openLogsDirectory', workingDir) as Promise<string>,
    getRecent: () => ipcRenderer.invoke('workspace.getRecent') as Promise<string[]>,
    addRecent: (workingDir: string) => ipcRenderer.invoke('workspace.addRecent', workingDir) as Promise<string[]>,
  },
  db: {
    getStatus: () => ipcRenderer.invoke('db.getStatus'),
    getStats:  () => ipcRenderer.invoke('db.getStats'),
    getNamespaceStats: () => ipcRenderer.invoke('db.getNamespaceStats'),
    probe:     () => ipcRenderer.invoke('db.probe'),
    close:     () => ipcRenderer.invoke('db.close'),
  },
  imports: {
    run:           (params: RunImportParams) => ipcRenderer.invoke('imports.run', params),
    getStatus:     (runId: string)           => ipcRenderer.invoke('imports.getStatus', { runId }),
    listSources:   ()                        => ipcRenderer.invoke('imports.listSources'),
    getConfig:     (sourceId: string)        => ipcRenderer.invoke('imports.getConfig', { sourceId }),
    saveConfig:    (params: SaveImportConfigParams) => ipcRenderer.invoke('imports.saveConfig', params),
    runFromSource: (params: RunFromSourceParams)    => ipcRenderer.invoke('imports.runFromSource', params),
    exportConfig:  (params: ExportConfigParams)     => ipcRenderer.invoke('imports.exportConfig', params),
    importConfig:  (params: ImportConfigParams)      => ipcRenderer.invoke('imports.importConfig', params),
    getArxmlTree:  (sourceId: string)               => ipcRenderer.invoke('imports.getArxmlTree', { sourceId }),
    getActiveImport: ()                              => ipcRenderer.invoke('imports.getActiveImport'),
    getImpactReport: (runId: string)                  => ipcRenderer.invoke('imports.getImpactReport', { runId }),
    listOrphanedEntries: (params?: { analysisNamespace?: string; targetNodeId?: number }) =>
      ipcRenderer.invoke('imports.listOrphanedEntries', params),
    reconnectOrphanedEntry: (params: { entry: unknown; newImportedNodeId: number }) => ipcRenderer.invoke('imports.reconnectOrphanedEntry', params),
    deleteSource:  (sourceId: string)               => ipcRenderer.invoke('imports.deleteSource', { sourceId }),
    runFromSourceAtRef: (params: { sourceId: string; repoDir: string; ref: string; workingDir: string }) => ipcRenderer.invoke('imports.runFromSourceAtRef', params),
    updateFromImportedBranch: (params: { sourceId: string; workingDir: string }) => ipcRenderer.invoke('imports.updateFromImportedBranch', params),
  },
  persistor: {
    load:           (params: PersistorLoadParams)   => ipcRenderer.invoke('persistor.load', params),
    store:          (params: PersistorStoreParams)  => ipcRenderer.invoke('persistor.store', params),
    repairManifest: (params: PersistorRepairParams) => ipcRenderer.invoke('persistor.repairManifest', params),
    onLoadProgress: (handler: (event: LoadProgressPushEvent) => void) => {
      const listener = (_evt: IpcRendererEvent, event: LoadProgressPushEvent) => handler(event);
      ipcRenderer.on('persistor.loadProgress', listener);
      return () => ipcRenderer.off('persistor.loadProgress', listener);
    },
  },
  dialog: {
    openDirectory: (options?: { title?: string; defaultPath?: string; relativeTo?: string }) =>
      ipcRenderer.invoke('dialog.openDirectory', options) as Promise<string | null>,
    saveFile: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog.saveFile', options) as Promise<string | null>,
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell.openPath', filePath) as Promise<void>,
  },
  contextMenu: {
    show: (items: { id: string; label: string }[]) => ipcRenderer.invoke('context-menu.show', items) as Promise<string | null>,
  },
  importers: {
    provisionConfig: (params: ProvisionConfigParams) => ipcRenderer.invoke('importers.provisionConfig', params) as Promise<string>,
    listAvailable:   ()                               => ipcRenderer.invoke('importers.listAvailable'),
  },
  profiles: {
    listAvailable: () => ipcRenderer.invoke('profiles.listAvailable'),
  },
  metamodel: {
    getRenderingConfig: (params: { metamodel: string }) => ipcRenderer.invoke('metamodel.getRenderingConfig', params),
    getProfileMetadata: (params: { metamodel: string }) => ipcRenderer.invoke('metamodel.getProfileMetadata', params),
  },
  namespaceConnections: {
    getGraph: () => ipcRenderer.invoke('namespaceConnections:getGraph'),
    connect: (params: { sourceNamespace: string; targetNamespace: string }) => ipcRenderer.invoke('namespaceConnections:connect', params),
    disconnect: (params: { importedNamespace: string; authoredNamespace: string; deleteDependents: boolean }) => ipcRenderer.invoke('namespaceConnections:disconnect', params),
    countDependents: (params: { importedNamespace: string; authoredNamespace: string }) => ipcRenderer.invoke('namespaceConnections:countDependents', params),
  },
  crossNsLinkSettings: {
    getSettings: () => ipcRenderer.invoke('crossNsLinkSettings.getSettings') as Promise<CrossNsLinkSettings>,
    saveSettings: (settings: CrossNsLinkSettings) => ipcRenderer.invoke('crossNsLinkSettings.saveSettings', settings) as Promise<void>,
  },
  canvasLayout: {
    getLayout: () => ipcRenderer.invoke('canvasLayout:getLayout'),
    setRecords: (records: LayoutRecord[]) => ipcRenderer.invoke('canvasLayout:setRecords', { records }),
    getViewLayout: (viewName: string, sources: ViewLayoutSourceRef[]) =>
      ipcRenderer.invoke('canvasLayout:getViewLayout', { viewName, sources }),
    setViewLayout: (viewName: string, records: Array<{ source: ViewLayoutSourceRef; x: number; y: number }>) =>
      ipcRenderer.invoke('canvasLayout:setViewLayout', { viewName, records }),
  },
  namespaces: {
    list: () => ipcRenderer.invoke('namespaces.list'),
    createAuthored: (params: CreateAuthoredNamespaceParams) => ipcRenderer.invoke('namespaces.createAuthored', params),
    getChildren: (params: { namespace: string; parentNodeId?: number; offset?: number; limit?: number; showAll?: boolean; scopeNamespace?: string }) => ipcRenderer.invoke('namespaces.getChildren', params),
    getAncestorPath: (params: { namespace: string; nodeId: number }) => ipcRenderer.invoke('namespaces.getAncestorPath', params),
    search: (params: { query: string; offset?: number; limit?: number }) => ipcRenderer.invoke('namespaces.search', params),
    previewDeleteImpact: (namespace: string) => ipcRenderer.invoke('namespaces.previewDeleteImpact', { namespace }),
    delete: (namespace: string) => ipcRenderer.invoke('namespaces.delete', { namespace }),
    getSyncStatus: (params: { namespace: string; workingDir: string }) => ipcRenderer.invoke('namespace.getSyncStatus', params),
    applyUnionMergeFromFiles: (params: { namespace: string; workingDir: string }) => ipcRenderer.invoke('namespace.applyUnionMergeFromFiles', params),
    applyUnionMergeFromBranch: (params: { namespace: string; workingDir: string; repoDir: string; branchRef: string }) => ipcRenderer.invoke('namespace.applyUnionMergeFromBranch', params),
    supervisedMergeFromBranchPrepare: (params: { namespace: string; repoDir: string; branchRef: string; workingDir: string }): Promise<SupervisedMergePrepareResult> => ipcRenderer.invoke('namespace.supervisedMergeFromBranchPrepare', params),
    supervisedMergeCleanup: (params: { tempDir: string }): Promise<void> => ipcRenderer.invoke('namespace.supervisedMergeCleanup', params),
  },
  safety: {
    getMalfunctions: (params: { namespace: string }) => ipcRenderer.invoke('safety.getMalfunctions', params),
    getMalfunction: (params: { nodeId: number }) => ipcRenderer.invoke('safety.getMalfunction', params),
    createMalfunction: (params: CreateMalfunctionParams) => ipcRenderer.invoke('safety.createMalfunction', params),
    updateMalfunction: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateMalfunction', params),
    deleteMalfunction: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteMalfunction', params),
    attachOccursAt: (params: { failureModeNodeId: number; targetNodeId: number }) => ipcRenderer.invoke('safety.attachOccursAt', params),
    detachOccursAt: (params: { failureModeNodeId: number; targetNodeId: number }) => ipcRenderer.invoke('safety.detachOccursAt', params),
    moveOccursAt: (params: { failureModeNodeId: number; oldTargetNodeId: number; newTargetNodeId: number }) => ipcRenderer.invoke('safety.moveOccursAt', params),
    addPropagation: (params: { sourceFailureModeNodeId: number; targetFailureModeNodeId: number }) => ipcRenderer.invoke('safety.addPropagation', params),
    removePropagation: (params: { sourceFailureModeNodeId: number; targetFailureModeNodeId: number }) => ipcRenderer.invoke('safety.removePropagation', params),
    getPropagations: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getPropagations', params),
    getPropagationsForComponent: (params: { structuralNodeId: number; safetyNamespace?: string }) => ipcRenderer.invoke('safety.getPropagationsForComponent', params),
    createRiskRating: (params: CreateRiskRatingParams) => ipcRenderer.invoke('safety.createRiskRating', params),
    getRiskRating: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getRiskRating', params),
    updateRiskRating: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateRiskRating', params),
    deleteRiskRating: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteRiskRating', params),
    createSafetyTask: (params: { namespace: string; name: string; description: string; status: string; type: string; responsible?: string; reference?: string }) => ipcRenderer.invoke('safety.createSafetyTask', params),
    linkSafetyTaskToFm: (params: { failureModeNodeId: number; safetyTaskNodeId: number }) => ipcRenderer.invoke('safety.linkSafetyTaskToFm', params),
    unlinkSafetyTaskFromFm: (params: { failureModeNodeId: number; safetyTaskNodeId: number }) => ipcRenderer.invoke('safety.unlinkSafetyTaskFromFm', params),
    getSafetyTasks: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getSafetyTasks', params),
    getMalfunctionForTask: (params: { safetyTaskNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionForTask', params),
    getMalfunctionForRiskRating: (params: { riskRatingNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionForRiskRating', params),
    getMalfunctionForReviewItem: (params: { reviewItemNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionForReviewItem', params),
    getAllSafetyTasks: (params: { namespace: string }) => ipcRenderer.invoke('safety.getAllSafetyTasks', params),
    updateSafetyTask: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateSafetyTask', params),
    deleteSafetyTask: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteSafetyTask', params),
    createFunctionalInsufficiency: (params: { namespace: string; name: string; description?: string; source?: string }) => ipcRenderer.invoke('safety.createFunctionalInsufficiency', params),
    linkFunctionalInsufficiencyToFm: (params: { failureModeNodeId: number; functionalInsufficiencyNodeId: number }) => ipcRenderer.invoke('safety.linkFunctionalInsufficiencyToFm', params),
    unlinkFunctionalInsufficiencyFromFm: (params: { failureModeNodeId: number; functionalInsufficiencyNodeId: number }) => ipcRenderer.invoke('safety.unlinkFunctionalInsufficiencyFromFm', params),
    getFunctionalInsufficiencies: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getFunctionalInsufficiencies', params),
    getAllFunctionalInsufficiencies: (params: { namespace: string }) => ipcRenderer.invoke('safety.getAllFunctionalInsufficiencies', params),
    getMalfunctionsForFunctionalInsufficiency: (params: { functionalInsufficiencyNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionsForFunctionalInsufficiency', params),
    updateFunctionalInsufficiency: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateFunctionalInsufficiency', params),
    deleteFunctionalInsufficiency: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteFunctionalInsufficiency', params),
    createTriggeringCondition: (params: { namespace: string; name: string; description?: string; source?: string }) => ipcRenderer.invoke('safety.createTriggeringCondition', params),
    linkTriggeringConditionToFm: (params: { failureModeNodeId: number; triggeringConditionNodeId: number }) => ipcRenderer.invoke('safety.linkTriggeringConditionToFm', params),
    unlinkTriggeringConditionFromFm: (params: { failureModeNodeId: number; triggeringConditionNodeId: number }) => ipcRenderer.invoke('safety.unlinkTriggeringConditionFromFm', params),
    getTriggeringConditions: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getTriggeringConditions', params),
    getAllTriggeringConditions: (params: { namespace: string }) => ipcRenderer.invoke('safety.getAllTriggeringConditions', params),
    getMalfunctionsForTriggeringCondition: (params: { triggeringConditionNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionsForTriggeringCondition', params),
    updateTriggeringCondition: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateTriggeringCondition', params),
    deleteTriggeringCondition: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteTriggeringCondition', params),
    createRequirement: (params: { namespace: string; name: string; reqId: string; reqText: string; asil?: string; linkedToUrl?: string }) => ipcRenderer.invoke('safety.createRequirement', params),
    getRequirement: (params: { nodeId: number }) => ipcRenderer.invoke('safety.getRequirement', params),
    getRequirements: (params: { namespace: string }) => ipcRenderer.invoke('safety.getRequirements', params),
    unlinkRequirementFromFm: (params: { failureModeNodeId: number; requirementNodeId: number }) => ipcRenderer.invoke('safety.unlinkRequirementFromFm', params),
    updateRequirement: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateRequirement', params),
    deleteRequirement: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteRequirement', params),
    createSafetyNote: (params: { namespace: string; noteText: string; targetNodeId: number }) => ipcRenderer.invoke('safety.createSafetyNote', params),
    getSafetyNote: (params: { nodeId: number }) => ipcRenderer.invoke('safety.getSafetyNote', params),
    getSafetyNotes: (params: { namespace: string }) => ipcRenderer.invoke('safety.getSafetyNotes', params),
    updateSafetyNote: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateSafetyNote', params),
    deleteSafetyNote: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteSafetyNote', params),
    getNoteParent: (params: { noteNodeId: number }) => ipcRenderer.invoke('safety.getNoteParent', params),
    createReviewItem: (params: { namespace: string; reviewerComment: string; reviewedElementId: number; name?: string }) => ipcRenderer.invoke('safety.createReviewItem', params),
    getReviewItem: (params: { nodeId: number }) => ipcRenderer.invoke('safety.getReviewItem', params),
    getReviewItems: (params: { reviewedElementNodeId: number }) => ipcRenderer.invoke('safety.getReviewItems', params),
    getAllReviewItems: (params: { namespace: string }) => ipcRenderer.invoke('safety.getAllReviewItems', params),
    updateReviewItem: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateReviewItem', params),
    deleteReviewItem: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteReviewItem', params),
    getMalfunctionsForElement: (params: { targetNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionsForElement', params),
    getMalfunctionsForElements: (params: { targetNodeIds: number[]; safetyNamespace?: string }) => ipcRenderer.invoke('safety.getMalfunctionsForElements', params),
    getMalfunctionsForRequirement: (params: { requirementNodeId: number }) => ipcRenderer.invoke('safety.getMalfunctionsForRequirement', params),
    getRequirementsForFm: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getRequirementsForFm', params),
    linkRequirementToFm: (params: { failureModeNodeId: number; requirementNodeId: number }) => ipcRenderer.invoke('safety.linkRequirementToFm', params),
    getNotesForFm: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getNotesForFm', params),
    getNotesForElement: (params: { elementNodeId: number }) => ipcRenderer.invoke('safety.getNotesForElement', params),
    createNoteForFm: (params: { failureModeNodeId: number; namespace: string; noteText: string }) => ipcRenderer.invoke('safety.createNoteForFm', params),
    createNoteForElement: (params: { elementNodeId: number; namespace: string; noteText: string }) => ipcRenderer.invoke('safety.createNoteForElement', params),
    previewDeleteImpact: (params: { nodeId: number }) => ipcRenderer.invoke('safety.previewDeleteImpact', params),
    getInstance: (params: { nodeId: number }) => ipcRenderer.invoke('safety.getInstance', params),
    createTag: (params: CreateTagParams) => ipcRenderer.invoke('safety.createTag', params),
    getTag: (params: { nodeId: number }) => ipcRenderer.invoke('safety.getTag', params),
    getAllTags: (params: { namespace: string }) => ipcRenderer.invoke('safety.getAllTags', params),
    updateTag: (params: { nodeId: number; updates: Record<string, unknown> }) => ipcRenderer.invoke('safety.updateTag', params),
    deleteTag: (params: { nodeId: number }) => ipcRenderer.invoke('safety.deleteTag', params),
    linkTag: (params: { elementNodeId: number; tagNodeId: number }) => ipcRenderer.invoke('safety.linkTag', params),
    unlinkTag: (params: { elementNodeId: number; tagNodeId: number }) => ipcRenderer.invoke('safety.unlinkTag', params),
    getTagsForElement: (params: { elementNodeId: number }) => ipcRenderer.invoke('safety.getTagsForElement', params),
    getElementsForTag: (params: { tagNodeId: number }) => ipcRenderer.invoke('safety.getElementsForTag', params),
    linkTagCrossNs: (params: { tagNodeId: number; importedElementNodeId: number }) => ipcRenderer.invoke('safety.linkTagCrossNs', params),
    unlinkTagCrossNs: (params: { tagNodeId: number; importedElementNodeId: number }) => ipcRenderer.invoke('safety.unlinkTagCrossNs', params),
    getTagsForImportedElement: (params: { importedElementNodeId: number }) => ipcRenderer.invoke('safety.getTagsForImportedElement', params),
    linkDirectRequirementToFm: (params: { failureModeNodeId: number; requirementNodeId: number }) => ipcRenderer.invoke('safety.linkDirectRequirementToFm', params),
    unlinkDirectRequirementFromFm: (params: { failureModeNodeId: number; requirementNodeId: number }) => ipcRenderer.invoke('safety.unlinkDirectRequirementFromFm', params),
    getDirectRequirementsForFm: (params: { failureModeNodeId: number }) => ipcRenderer.invoke('safety.getDirectRequirementsForFm', params),
    searchRequirementsAcrossNamespaces: (params: { query: string }) => ipcRenderer.invoke('safety.searchRequirementsAcrossNamespaces', params),
    exportSphinxNeeds: (params: { namespace: string; outputDir: string }) => ipcRenderer.invoke('safety.exportSphinxNeeds', params),
    exportXlsx: (params: { namespace: string; outputPath: string }) => ipcRenderer.invoke('safety.exportXlsx', params),
    getSafetyData: (params: { namespace: string }) =>
      ipcRenderer.invoke('safety.getSafetyData', params),
  },
  checks: {
    loadApplicable: (params: { namespace: string }) => ipcRenderer.invoke('checks.loadApplicable', params),
    runCheck: (params: { checkId: string; namespace: string; pageSize?: number }) => ipcRenderer.invoke('checks.runCheck', params),
    getPage: (params: { runId: string; page: number; pageSize: number }) => ipcRenderer.invoke('checks.getPage', params),
    loadSelection: (params: { namespace: string }) => ipcRenderer.invoke('checks.loadSelection', params),
    saveSelection: (params: { namespace: string; selectedIds: string[] }) => ipcRenderer.invoke('checks.saveSelection', params),
    saveSummary: (params: { namespace: string; errors: number; warnings: number; hints: number; checksRun: number }) => ipcRenderer.invoke('checks.saveSummary', params),
    loadSummary: (params: { namespace: string }) => ipcRenderer.invoke('checks.loadSummary', params),
  },
  // Views (docs/coreSpecs/RiaViews.md) and the concept presentation catalog
  // (spec-view.md Phase 4.1). `views.evaluate` is read-only and accepts either a
  // saved view name or an ad-hoc definition, which is what lets the connection
  // diagram evaluate a namespace it has no saved view for.
  views: {
    list: () => ipcRenderer.invoke('views.list'),
    get: (params: { name: string }) => ipcRenderer.invoke('views.get', params),
    create: (params: CreateViewParams) => ipcRenderer.invoke('views.create', params),
    update: (params: UpdateViewParams) => ipcRenderer.invoke('views.update', params),
    delete: (params: { name: string }) => ipcRenderer.invoke('views.delete', params),
    evaluate: (params: EvaluateViewParams) => ipcRenderer.invoke('views.evaluate', params),
    materialize: (params: MaterializeViewParams) => ipcRenderer.invoke('views.materialize', params),
  },
  presentation: {
    get: (params: GetPresentationInput) => ipcRenderer.invoke('presentation.get', params),
  },
  arxml: {
    getPortConnectors: (params: GetPortConnectorsInput) => ipcRenderer.invoke('arxml.getPortConnectors', params),
    getNamespacePortConnectors: (params: GetNamespacePortConnectorsInput) => ipcRenderer.invoke('arxml.getNamespacePortConnectors', params),
    getComponentPortConnectors: (params: GetComponentPortConnectorsInput) => ipcRenderer.invoke('arxml.getComponentPortConnectors', params),
  },
  graph: {
    query:  (params: { cypher: string })                    => ipcRenderer.invoke('graph.query', params),
    expand: (params: { nodeId: string; nodeLabel: string; properties: Record<string, unknown> }) => ipcRenderer.invoke('graph.expand', params),
  },
  menu: {
    setPropagationState: (state: { malfunctionSelected: boolean; propagationStarted: boolean; propagationEndAvailable: boolean }) =>
      ipcRenderer.send('menu.propagationState', state),
    onStartPropagation: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.startPropagation', listener);
      return () => ipcRenderer.off('menu.startPropagation', listener);
    },
    onEndPropagation: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.endPropagation', listener);
      return () => ipcRenderer.off('menu.endPropagation', listener);
    },
    onCancelPropagation: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.cancelPropagation', listener);
      return () => ipcRenderer.off('menu.cancelPropagation', listener);
    },
    /** Subscribe to native File menu actions. Returns an unsubscribe function. */
    onFileAction: (handler: (action: string) => void) => {
      const listener = (_evt: IpcRendererEvent, action: string) => handler(action);
      ipcRenderer.on('menu.fileAction', listener);
      return () => ipcRenderer.off('menu.fileAction', listener);
    },
    /** Subscribe to native Git menu actions. Returns an unsubscribe function. */
    onGitAction: (handler: (action: 'commit') => void) => {
      const listener = (_evt: IpcRendererEvent, action: 'commit') => handler(action);
      ipcRenderer.on('menu.gitAction', listener);
      return () => ipcRenderer.off('menu.gitAction', listener);
    },
    /** Subscribe to native Report menu actions. Returns an unsubscribe function. */
    onReportAction: (handler: (action: string) => void) => {
      const listener = (_evt: IpcRendererEvent, action: string) => handler(action);
      ipcRenderer.on('menu.reportAction', listener);
      return () => ipcRenderer.off('menu.reportAction', listener);
    },
    /** Send safety namespace active state to the main process to enable/disable the Report menu item. */
    setSafetyNamespaceState: (state: { active: boolean }) =>
      ipcRenderer.send('menu.safetyNamespaceState', state),
    /** Send malfunction copy/paste availability to drive the Edit menu items. */
    setMalfunctionClipboardState: (state: { canCopy: boolean; canPaste: boolean }) =>
      ipcRenderer.send('menu.malfunctionClipboardState', state),
    /** Subscribe to the Edit → Copy Malfunction menu action. Returns an unsubscribe function. */
    onCopyMalfunction: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.copyMalfunction', listener);
      return () => ipcRenderer.off('menu.copyMalfunction', listener);
    },
    /** Subscribe to the Edit → Paste Malfunction menu action. Returns an unsubscribe function. */
    onPasteMalfunction: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.pasteMalfunction', listener);
      return () => ipcRenderer.off('menu.pasteMalfunction', listener);
    },
    /** Push Show-in-Tree menu item enabled states to the main process. Fire-and-forget. */
    setShowInTreeState: (state: { showInTreeAvailable: boolean; showReferenceInTreeAvailable: boolean }) =>
      ipcRenderer.send('menu.showInTreeState', state),
    /** Push Add-Malfunction menu item enabled state to the main process. Fire-and-forget. */
    setAddMalfunctionState: (state: { canAddMalfunction: boolean }) =>
      ipcRenderer.send('menu.addMalfunctionState', state),
    /** Subscribe to Edit → Add Malfunction. Returns an unsubscribe function. */
    onAddMalfunction: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.addMalfunction', listener);
      return () => ipcRenderer.off('menu.addMalfunction', listener);
    },
    /** Push Delete-Malfunction menu item enabled state to the main process. Fire-and-forget. */
    setDeleteMalfunctionState: (state: { canDeleteMalfunction: boolean }) =>
      ipcRenderer.send('menu.deleteMalfunctionState', state),
    /** Subscribe to Edit → Delete Malfunction. Returns an unsubscribe function. */
    onDeleteMalfunction: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.deleteMalfunction', listener);
      return () => ipcRenderer.off('menu.deleteMalfunction', listener);
    },
    /** Subscribe to Edit → Show in Tree. Returns an unsubscribe function. */
    onShowInTree: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.showInTree', listener);
      return () => ipcRenderer.off('menu.showInTree', listener);
    },
    /** Subscribe to Edit → Show Reference in Tree. Returns an unsubscribe function. */
    onShowReferenceInTree: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.showReferenceInTree', listener);
      return () => ipcRenderer.off('menu.showReferenceInTree', listener);
    },
    /** Subscribe to Edit → Import All. Returns an unsubscribe function. */
    onImportAll: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu.importAll', listener);
      return () => ipcRenderer.off('menu.importAll', listener);
    },
    /** Subscribe to Help menu actions (e.g. 'about'). Returns an unsubscribe function. */
    onHelpAction: (handler: (action: string) => void) => {
      const listener = (_evt: IpcRendererEvent, action: string) => handler(action);
      ipcRenderer.on('menu.helpAction', listener);
      return () => ipcRenderer.off('menu.helpAction', listener);
    },
  },
  window: {
    openGraphCore: () => ipcRenderer.invoke('window.openGraphCore') as Promise<void>,
    showInTree: (payload: ShowInTreePayload) =>
      ipcRenderer.invoke('window.showInTree', payload) as Promise<void>,
    onShowInTreeRequest: (handler: (req: NavigationRequest) => void) => {
      const listener = (_evt: IpcRendererEvent, req: NavigationRequest) => handler(req);
      ipcRenderer.on('window.showInTree.dispatch', listener);
      return () => ipcRenderer.off('window.showInTree.dispatch', listener);
    },
    spawnReady: () => ipcRenderer.send('window.spawnReady'),
    /**
     * Renderer signals it has committed its first themed paint. Main process
     * uses this to show the window only after antd's dark canvas is on screen,
     * eliminating the white flash on dark-mode systems.
     */
    paintReady: () => ipcRenderer.send('window.paintReady'),
    /**
     * Renderer pushes the actual antd-resolved theme colors back to the main
     * process so they can be persisted and used as the splash on next launch.
     * Inspired by VS Code's `IPartsSplash`.
     */
    persistTheme: (payload: { isDark: boolean; backgroundColor: string; foregroundColor: string }) =>
      ipcRenderer.send('window.persistTheme', payload),
  },
  cache: {
    invalidate: (payload: CacheInvalidationOutbound): void =>
      ipcRenderer.send('cache.invalidate', payload),
    onCacheInvalidate: (handler: (msg: CacheInvalidationMessage) => void) => {
      const listener = (_evt: IpcRendererEvent, msg: CacheInvalidationMessage) => handler(msg);
      ipcRenderer.on('cache.invalidate', listener);
      return () => ipcRenderer.off('cache.invalidate', listener);
    },
  },
  diff: {
    computeNamespaces: (params: { leftNs: string; rightNs: string; workingDir: string; opts?: DiffOptions }) =>
      ipcRenderer.invoke('diff.computeNamespaces', params),
    computeFromPaths: (params: { leftDir: string; leftNs: string; rightDir: string; rightNs: string; opts?: DiffOptions }) =>
      ipcRenderer.invoke('diff.computeFromPaths', params),
    computeHybrid: (params: { liveNs: string; snapshotDir: string; snapshotNs: string; liveIsLeft: boolean; workingDir: string; opts?: DiffOptions }) =>
      ipcRenderer.invoke('diff.computeHybrid', params),
    getDiffResult: (params: { diffId: string }) =>
      ipcRenderer.invoke('diff.getDiffResult', params),
    getResultPage: (params: { diffId: string; section: DiffResultSection; offset: number; limit: number; filterText?: string; filterConceptType?: string; filterRelationshipType?: string }) =>
      ipcRenderer.invoke('diff.getResultPage', params),
    applyMerge: (params: { diffId: string; targetNs: string; direction: 'left-into-right' | 'right-into-left'; selectionIds?: string[]; workingDir: string }) =>
      ipcRenderer.invoke('diff.applyMerge', params),
    computeThreeWay: (params: { baseNs: string; leftNs: string; rightNs: string; workingDir: string; opts?: DiffOptions }) =>
      ipcRenderer.invoke('diff.computeThreeWay', params),
    getThreeWayResult: (params: { diffId: string }) =>
      ipcRenderer.invoke('diff.getThreeWayResult', params),
    applyThreeWayMerge: (params: { diffId: string; targetNs: string; resolutions: ConflictResolution[]; workingDir: string }) =>
      ipcRenderer.invoke('diff.applyThreeWayMerge', params),
  },
  git: {
    isRepo: (params: { dir: string }) => ipcRenderer.invoke('git.isRepo', params),
    init: (params: { dir: string; initialBranch?: string }) => ipcRenderer.invoke('git.init', params),
    getStatus: (params: { repoDir: string }) => ipcRenderer.invoke('git.getStatus', params),
    stageAll: (params: { repoDir: string }) => ipcRenderer.invoke('git.stageAll', params),
    stageFiles: (params: { repoDir: string; patterns: string[] }) => ipcRenderer.invoke('git.stageFiles', params),
    unstageAll: (params: { repoDir: string }) => ipcRenderer.invoke('git.unstageAll', params),
    commit: (params: CommitParams) => ipcRenderer.invoke('git.commit', params),
    getCurrentBranch: (params: { repoDir: string }) => ipcRenderer.invoke('git.getCurrentBranch', params),
    listBranches: (params: { repoDir: string }) => ipcRenderer.invoke('git.listBranches', params),
    createBranch: (params: { repoDir: string; name: string; from?: string }) => ipcRenderer.invoke('git.createBranch', params),
    checkoutBranch: (params: { repoDir: string; name: string }) => ipcRenderer.invoke('git.checkoutBranch', params),
    deleteBranch: (params: { repoDir: string; name: string; force?: boolean }) => ipcRenderer.invoke('git.deleteBranch', params),
    renameBranch: (params: { repoDir: string; oldName: string; newName: string }) => ipcRenderer.invoke('git.renameBranch', params),
    getLog: (params: LogParams) => ipcRenderer.invoke('git.getLog', params),
    getCommit: (params: { repoDir: string; ref: string }) => ipcRenderer.invoke('git.getCommit', params),
    listRemotes: (params: { repoDir: string }) => ipcRenderer.invoke('git.listRemotes', params),
    addRemote: (params: { repoDir: string; name: string; url: string }) => ipcRenderer.invoke('git.addRemote', params),
    removeRemote: (params: { repoDir: string; name: string }) => ipcRenderer.invoke('git.removeRemote', params),
    setRemoteUrl: (params: { repoDir: string; name: string; url: string }) => ipcRenderer.invoke('git.setRemoteUrl', params),
    fetch: (params: FetchParams) => ipcRenderer.invoke('git.fetch', params),
    pull: (params: PullParams) => ipcRenderer.invoke('git.pull', params),
    push: (params: PushParams) => ipcRenderer.invoke('git.push', params),
    getConfig: (params: { repoDir: string }) => ipcRenderer.invoke('git.getConfig', params),
    setConfig: (params: { repoDir: string; name?: string; email?: string }) => ipcRenderer.invoke('git.setConfig', params),
    getVersion: () => ipcRenderer.invoke('git.getVersion'),
    semanticDiffCommits: (params: GitSemanticDiffParams) => ipcRenderer.invoke('git.semanticDiffCommits', params),
    ensureGitignore: (params: { repoDir: string }) => ipcRenderer.invoke('git.ensureGitignore', params),
    getWorkspaceConfig: (params: { workingDir: string }) => ipcRenderer.invoke('git.getWorkspaceConfig', params),
    saveWorkspaceConfig: (params: { workingDir: string; config: WorkspaceGitConfig }) => ipcRenderer.invoke('git.saveWorkspaceConfig', params),
    listTags: (params: { repoDir: string }) => ipcRenderer.invoke('git.listTags', params),
    getRepoRoot: (params: { dir: string }) => ipcRenderer.invoke('git.getRepoRoot', params),
  },
  llm: {
    getSettings:  ()                              => ipcRenderer.invoke('llm.getSettings') as Promise<LlmSettings>,
    saveSettings: (input: LlmSaveSettingsInput)   => ipcRenderer.invoke('llm.saveSettings', input) as Promise<void>,
    startReview:  (input: LlmStartReviewInput)    => ipcRenderer.invoke('llm.startReview', input) as Promise<LlmStartReviewResult>,
    cancelReview: (input: LlmCancelReviewInput)   => ipcRenderer.invoke('llm.cancelReview', input) as Promise<void>,
    testConnection: ()                            => ipcRenderer.invoke('llm.testConnection') as Promise<import('@riacore/app-contracts').LlmTestConnectionResult>,
    dryRun: (input: import('@riacore/app-contracts').LlmDryRunInput) => ipcRenderer.invoke('llm.dryRun', input) as Promise<import('@riacore/app-contracts').LlmDryRunResult>,
    /**
     * Subscribe to `llm.stream` push events from the worker. Returns an
     * unsubscribe function. `llm.stream` is a one-way `webContents.send`
     * channel and is intentionally not part of `IpcChannelMap`.
     */
    onStream: (handler: (evt: LlmStreamEvent) => void) => {
      const listener = (_evt: IpcRendererEvent, event: LlmStreamEvent) => handler(event);
      ipcRenderer.on('llm.stream', listener);
      return () => ipcRenderer.off('llm.stream', listener);
    },
  },
});
