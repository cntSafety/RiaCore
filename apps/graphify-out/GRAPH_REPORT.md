# Graph Report - apps  (2026-08-19)

## Corpus Check
- 393 files · ~376,812 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2834 nodes · 5503 edges · 180 communities (144 shown, 36 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 43 edges (avg confidence: 0.84)
- Token cost: 108,234 input · 0 output

## Community Hubs (Navigation)
- Renderer Vite Env
- Cli Cli Logger
- Renderer Hooks - Usecanvasautosave
- Renderer Hooks Usediffmutations
- Renderer Modules Graph Core
- Renderer Components Data
- Renderer Hooks - Usecanvasautosave Readcanvasdbsnapshot
- Renderer Modules Namespace Editors Safety
- Renderer Shell Canvasgraphgate
- Renderer Lib Optrace
- Renderer Api Git
- Renderer Lib
- Desktop Host Package
- Renderer Modules Namespace Editors Safety
- Desktop Host Scripts Prepare
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Desktop Host - App Config
- Renderer Hooks - Useriacoremutations
- Renderer Modules Namespace Editors Safety
- Cli Package
- Renderer Hooks - Usemetamodelprofilemetadata
- Renderer Hooks Tests Usellmreview Noinvalidation
- Desktop Host Spawn
- Renderer Modules Namespace - Editors Generic
- Renderer
- Renderer Hooks - Jobstatusbadge
- Renderer Modules Namespace Editors Safety
- Desktop Host Invalidation
- Renderer Api Browserbridge
- Renderer Modules Namespace Editors Safety
- Desktop Host App
- Desktop Host Utility
- Renderer
- Renderer Hooks
- Renderer Hooks - Useactiveimport
- Renderer Shell Importerconfigdrawer
- Renderer Modules Namespace Editors Model
- Desktop Host Tests Spawn Manager
- Renderer Modules
- Renderer Modules Namespace Editors Safety
- Renderer Shell Tests Autolayoutgeometry Property
- Renderer Shell
- Renderer - Design Icons
- Renderer - Api Riacore
- Renderer Hooks Tests Diagram Layout
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Hooks Tests Useriacoremutations Workspace
- Renderer Hooks Usemodelview
- Renderer Modules Safety Status Riskmatrix
- Desktop Host Navigation
- Renderer Shell Bottompanel
- Renderer - Hooks Usesafetydata
- Renderer Modules Settings
- Renderer Modules Namespace Editors Safety
- Renderer Modules Import Impactreportpanel
- Renderer Modules Namespace - Modelexpansion
- Renderer Modules Namespace Editors Model
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Tsconfig
- Renderer Store
- Renderer Shell Workspacecanvas
- Desktop Host - Git
- Desktop Host Tests Spawn Manager
- Desktop Host - Tests
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Shell Autolayoutrecords
- Renderer Shell Tests Autolayoutbutton Test
- Renderer Shell Tests Placementmode Test
- Desktop Host Web
- Renderer Modules Namespace Editors
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Hooks Tests Namespace Connections
- Renderer Lib Reviewprofile
- Renderer Modules Import Importmanager
- Renderer Modules Llm
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Safety Status Statuscard
- Renderer Lib Tests
- Renderer Modules Diff
- Renderer Modules Namespace Editors Safety
- Renderer Shell Autolayoutstate
- Desktop Host Tests Worker Dispatch
- Renderer Modules Namespace
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Shell Tests
- Renderer Lib Namespacetypedecoration
- Renderer Modules Import Generic
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors
- Cli Tsconfig
- Desktop Host Logo Generate
- Desktop Host Scripts Start
- Desktop Host Tests Worker Dispatch
- Desktop Host Tsconfig
- Renderer Package
- Renderer Components Tests Showintreetrigger Test
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Shell Placementrecord
- Renderer Tests Safety
- Desktop Host Electron Builder
- Desktop Host Tests Worker Dispatch
- Renderer Components Git Gitcommitmodal
- Renderer Modules Namespace Editors Generic
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Safety Status Componentdiagram
- Renderer Store Llmreviewmodalstore
- Cli Commands Tests Safety Export
- Cli Commands Tests Workspace Property
- Desktop Host Graph
- Desktop Host Worker
- Renderer Components Showintreetrigger
- Renderer Hooks Tests Modelview Refresh
- Renderer Modules Import Updatefrombranchmodal
- Renderer Modules Namespace Editors Safety
- Renderer
- Renderer Components Tests Show In
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Desktop Host
- Cli Commands Tests Integration Test
- Cli Commands Tests Llm Help
- Renderer Common Detailinspector
- Renderer Common Modeltreeview
- Renderer Store Themestore
- Cli Commands Tests Workspace Test
- Desktop Host Tests Load Gate
- Renderer Assets Icon
- Renderer Components Tests Show In
- Renderer Hooks Tests Useshowintree Test
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Modules Namespace Editors Safety
- Renderer Shell Tests Modal Initial
- Renderer Tests Hooks
- Misc - Cytoscape Fcose
- Misc - React Markdown
- Misc - Remark Gfm
- Renderer - Dark Mode
- Renderer Package - Dependencies Antd
- Renderer Package - Dependencies React
- Renderer Package - Dependencies Riacore
- Renderer Package - Dependencies Riacore
- Misc - Renderer Package
- Renderer Components Git Tests Remotestab
- Renderer Modules Graph Cytoscape Fcose
- Renderer Modules Import Tests Updatefrombranchmodal
- Misc - Desktop Host

## God Nodes (most connected - your core abstractions)
1. `api` - 91 edges
2. `useWorkspaceStore` - 60 edges
3. `useWorkspaceState()` - 50 edges
4. `useSafetyProfileMetadata()` - 47 edges
5. `WorkspaceCanvas()` - 39 edges
6. `setQuietMode()` - 38 edges
7. `createDeps()` - 38 edges
8. `openWorkspace()` - 37 edges
9. `CenterPanel()` - 33 edges
10. `NamespaceTreePanel` - 29 edges

## Surprising Connections (you probably didn't know these)
- `SpawnManagerSetup` --references--> `SpawnManager`  [EXTRACTED]
  desktop-host/src/__tests__/spawn-manager.pbt.test.ts → desktop-host/src/spawn-manager.ts
- `GenericModelBrowserModal()` --calls--> `useWorkspaceState()`  [EXTRACTED]
  renderer/src/modules/namespace/editors/generic/GenericModelBrowserModal.tsx → renderer/src/hooks/useWorkspaceState.ts
- `CreateTaskModal()` --calls--> `useSafetyProfileMetadata()`  [EXTRACTED]
  renderer/src/modules/namespace/editors/safety-analysis/SafetyTasksView.tsx → renderer/src/modules/namespace/editors/safety-analysis/hooks/useSafetyProfileMetadata.ts
- `TagsOverviewViewProps` --references--> `NamespaceContext`  [EXTRACTED]
  renderer/src/modules/namespace/editors/safety-analysis/TagsOverviewView.tsx → renderer/src/store/workspaceStore.ts
- `buildStateWithRecord()` --calls--> `treeReducer()`  [EXTRACTED]
  renderer/src/modules/namespace/editors/safety-analysis/__tests__/malfunctionAsilDisplay.property.test.ts → renderer/src/modules/namespace/editors/safety-analysis/utils/treeIndexStore.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **RiaCore Desktop Build and Packaging Flow** — desktop_host_electron_builder_config, desktop_host_logo_readme_icon_generation, renderer_index_html [INFERRED 0.75]

## Communities (180 total, 36 thin omitted)

### Community 1 - "Cli Cli Logger"
Cohesion: 0.07
Nodes (63): createCliLogger(), write(), createCliPersistorLoadLogger(), write(), isQuietMode(), Level, setQuietMode(), registerAppCommands() (+55 more)

### Community 2 - "Renderer Hooks - Usecanvasautosave"
Cohesion: 0.06
Nodes (57): CanvasAutoSaveApi, CanvasDbSnapshot, realClock, useCanvasAutoSave(), ScopedSaveVars, useScopedSaveMutation(), CanvasAutoSaveCoordinator, CoordinatorClock (+49 more)

### Community 3 - "Renderer Hooks Usediffmutations"
Cohesion: 0.06
Nodes (55): useApplyMerge(), useApplyThreeWayMerge(), useComputeDiff(), useComputeThreeWayDiff(), useDiffResult(), useDiffResultPage(), useThreeWayDiffResult(), useNamespaces() (+47 more)

### Community 4 - "Renderer Modules Graph Core"
Cohesion: 0.06
Nodes (43): GraphCoreWindowView(), CATEGORY_LABELS, groupByCategory(), PredefinedQueryList(), PredefinedQueryListProps, DetailPanel(), DetailPanelInnerProps, formatValue() (+35 more)

### Community 5 - "Renderer Components Data"
Cohesion: 0.06
Nodes (39): DataTable(), DataTableProps, PAGINATION_DEFAULTS, PaginationProp, resolvePagination(), ResizableTitle(), ResizableTitleProps, columns (+31 more)

### Community 6 - "Renderer Hooks - Usecanvasautosave Readcanvasdbsnapshot"
Cohesion: 0.06
Nodes (44): readCanvasDbSnapshot(), useLoadCheckSummary(), isImportSourceConfigured(), useImportSourcesReadiness(), countDependents(), invalidateConnectionCaches(), namespaceConnectionsQueryKey(), useConnectMutation() (+36 more)

### Community 7 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.08
Nodes (48): MalfunctionTabContent(), RequirementEditorCard(), RequirementSection(), ReviewSection(), TaskEditorCard(), CreateMalfunctionModal(), EditableRequirementTag(), EditableRiskRating() (+40 more)

### Community 8 - "Renderer Shell Canvasgraphgate"
Cohesion: 0.06
Nodes (35): ANALYSIS_ELEMENT_KIND, AuthoredNamespaceLike, buildCanvasGraph(), CanvasGraphEdge, CanvasGraphInput, CanvasGraphNode, CanvasGraphResult, CanvasPhase (+27 more)

### Community 9 - "Renderer Lib Optrace"
Cohesion: 0.10
Nodes (36): invalidateModelViewQueries(), beginOpTrace(), forward(), LogContext, logOpEvent(), nextOpId(), now(), OpLevel (+28 more)

### Community 10 - "Renderer Api Git"
Cohesion: 0.10
Nodes (34): useEnsureGitignore(), useGitBranches(), useGitCheckoutBranch(), useGitCommit(), useGitConfig(), useGitCreateBranch(), useGitDeleteBranch(), useGitFetch() (+26 more)

### Community 11 - "Renderer Lib"
Cohesion: 0.08
Nodes (28): App(), appQueryClient, COALESCING_WINDOW_HARD_CAP_MS, COALESCING_WINDOW_MS, installCacheInvalidationSubscriber(), handleLocalInvalidation(), scheduleCoalesced(), LruSet (+20 more)

### Community 12 - "Desktop Host Package"
Cohesion: 0.05
Nodes (39): dependencies, @riacore/app-contracts, @riacore/app-core, @riacore/git-service, @riacore/importer-sdk, yaml, devDependencies, electron (+31 more)

### Community 13 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.08
Nodes (29): collectDetailItems(), DETAIL_PRIORITY_KEYS, DetailItem, dot(), ELEMENT_TABS, ElementNoteEditorCard(), ElementTabContent(), ElementWorkspace() (+21 more)

### Community 14 - "Desktop Host Scripts Prepare"
Cohesion: 0.10
Nodes (35): appDir, assertExists(), assertPackagedPathLengths(), buildIconsDir, collectExternalDeps(), copyAboutIcon(), copyDir(), copyExternalDeps() (+27 more)

### Community 15 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.14
Nodes (28): CenterPanel(), LinkedElementBanner(), MalfunctionWorkspace(), NoteSection(), PropagationSection(), DeleteWithPreview(), DeleteWithPreviewProps, InlineAddNote() (+20 more)

### Community 16 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.08
Nodes (29): ModelViewCanvas(), CenterPanelProps, CreateMalfunctionModalProps, ElementHeader(), ElementHeaderProps, ImportedTreePanelProps, isPortConcept(), MalfunctionTableRow() (+21 more)

### Community 17 - "Desktop Host - App Config"
Cohesion: 0.13
Nodes (23): DEFAULT_CONFIG, getAppConfig(), resolveConfigPath(), createGraphCoreWindowManager(), attachNativeEditContextMenu(), bootstrap(), buildRecentSubmenu(), OPENABLE_EXTENSIONS (+15 more)

### Community 18 - "Renderer Hooks - Useriacoremutations"
Cohesion: 0.12
Nodes (25): autoPersistImportedNamespace(), reportMutationError(), resolveWorkingDir(), useCreateAuthoredNamespaceMutation(), useOpenWorkspaceMutation(), usePersistorLoadMutation(), usePersistorStoreMutation(), useProvisionImporterMutation() (+17 more)

### Community 19 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.08
Nodes (24): ReviewSection(), MalfunctionTableView(), MODAL_CLOSED, ModalKind, ModalState, TABLE_COLUMNS, ResizableColumn, ResizableColumnsHeader() (+16 more)

### Community 20 - "Cli Package"
Cohesion: 0.06
Nodes (30): bin, riacore, dependencies, commander, @riacore/app-contracts, @riacore/app-core, @riacore/git-service, yaml (+22 more)

### Community 21 - "Renderer Hooks - Usemetamodelprofilemetadata"
Cohesion: 0.12
Nodes (23): metamodelProfileMetadataQueryKey(), useMetamodelProfileMetadata(), metamodelRenderingQueryKey(), useMetamodelRendering(), useTagMutations(), useTags(), useTagsForElement(), useTagsForImportedElement() (+15 more)

### Community 22 - "Renderer Hooks Tests Usellmreview Noinvalidation"
Cohesion: 0.08
Nodes (24): deltasArb, ALL_ERROR_CODES, streamSequenceArb, ALL_ERROR_CODES, CancelStep, DoneTerminal, ErrorTerminal, MidRunStep (+16 more)

### Community 23 - "Desktop Host Spawn"
Cohesion: 0.12
Nodes (9): GraphCoreWindowManager, AppLogger, SpawnManager, SpawnManagerState, SpawnStatus, createMockWindow(), createSetup(), SentMessage (+1 more)

### Community 24 - "Renderer Modules Namespace - Editors Generic"
Cohesion: 0.12
Nodes (22): GenericModelBrowserViewProps, PropagationInfoBar(), PropagationInfoBarProps, SafetyEditorProps, AUTHORED_ONLY_EDITORS, EDITOR_OPTIONS, NamespaceHeader(), NamespaceHeaderProps (+14 more)

### Community 25 - "Renderer"
Cohesion: 0.10
Nodes (19): CONTENT_MUTATION_SOURCES, declaredRoots, FILES, gcTimeViolations, LIFECYCLE_MUTATIONS, SRC, targetedRoots, useDeleteNamespaceMutation() (+11 more)

### Community 26 - "Renderer Hooks - Jobstatusbadge"
Cohesion: 0.13
Nodes (19): JobStatusBadgeProps, PENDING_PHASES, useCloseWorkspaceMutation(), CREATED_PHASES, PENDING_PHASES, useCreateWorkspaceMutation(), buildPhaseSteps(), completionTitle() (+11 more)

### Community 27 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.11
Nodes (19): canHostCrossNSSafetyElements(), EXCLUDED_CONCEPTS, ALL_CONCEPTS, conceptArb, HOST_CONCEPTS, hostConceptArb, malfunctionDataArb, namespaceArb (+11 more)

### Community 28 - "Desktop Host Invalidation"
Cohesion: 0.09
Nodes (4): AppLogger, InvalidationBus, MockBrowserWindow, MockWebContents

### Community 29 - "Renderer Api Browserbridge"
Cohesion: 0.14
Nodes (22): addRecent(), cacheListeners, CHANNEL_OVERRIDES, createBrowserBridge(), createInvoker(), createSection(), emitFileAction(), ensureWebDevToolbar() (+14 more)

### Community 30 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.17
Nodes (13): initWithTwoNamespaces(), makeRecord(), buildStateWithNamespace(), makeModelRecord(), makeNamespaceRecord(), simulateHandleSearchResultSelect(), AntSafetyTreeNode, deriveVisibleRows() (+5 more)

### Community 31 - "Desktop Host App"
Cohesion: 0.19
Nodes (17): AppLogger, AppLogLevel, AppLogMode, AppLogState, buildLogFilePath(), createInitialState(), ensureAppLogsDirectory(), formatContext() (+9 more)

### Community 32 - "Desktop Host Utility"
Cohesion: 0.15
Nodes (5): handleStartReview(), handleTestConnection(), registerIpcRelay(), registeredHandlers, UtilityProcessManager

### Community 33 - "Renderer"
Cohesion: 0.09
Nodes (23): jsdom, devDependencies, fast-check, jsdom, @testing-library/jest-dom, @testing-library/react, @types/cytoscape, @types/react (+15 more)

### Community 34 - "Renderer Hooks"
Cohesion: 0.16
Nodes (14): RootApp(), View, AboutModal(), AboutModalProps, useExportSafetyXlsx(), useExportSphinxNeeds(), useFullWorkspaceSaveMutation(), useImportSources() (+6 more)

### Community 35 - "Renderer Hooks - Useactiveimport"
Cohesion: 0.22
Nodes (14): useActiveImport(), useDbStats(), diagramLayoutQueryKey, useDiagramLayout(), isDbOpen(), useWorkspaceState(), WorkspacePhase, useWorkspaceStatus() (+6 more)

### Community 36 - "Renderer Shell Importerconfigdrawer"
Cohesion: 0.15
Nodes (19): toSaveImportConfigParams(), useSaveImportConfigMutation(), ELEMENT_LABELS, ImporterConfigDrawer(), isArxmlSource(), isSphinxNeedsSource(), isSysmlSource(), isSysmlTextualSource() (+11 more)

### Community 37 - "Renderer Modules Namespace Editors Model"
Cohesion: 0.19
Nodes (18): asilLevel(), attr(), buildModelGraph(), displayName(), indexRelationships(), ModelEdge, portSourceHandle(), portTargetHandle() (+10 more)

### Community 38 - "Desktop Host Tests Spawn Manager"
Cohesion: 0.11
Nodes (8): createMockBus(), createMockWindow(), createSpawnManager(), MockBus, MockWebContents, MockWindow, Operation, SpawnManagerSetup

### Community 39 - "Renderer Modules"
Cohesion: 0.15
Nodes (16): useLlmSettings(), useSafetyInstance(), LlmReviewModal(), LlmReviewModalProps, subtitleForProfile(), truncateReviewTargetName(), buildLlmInitialValues(), LlmFormValues (+8 more)

### Community 40 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.15
Nodes (14): MalfunctionNode, MalfunctionNodeData, MalfunctionNodeType, buildOccursAtLabel(), computeScopeFrameColor(), edgeTypes, estimateNodeHeight(), formatConceptLabel() (+6 more)

### Community 41 - "Renderer Shell Tests Autolayoutgeometry Property"
Cohesion: 0.12
Nodes (16): computeElkLayout(), elk, ELK_OPTIONS, ElkLayoutInput, ElkLayoutResult, fallbackGridLayout(), ANALYSIS_NODE_SIZE, ANALYSIS_PARTITION (+8 more)

### Community 42 - "Renderer Shell"
Cohesion: 0.15
Nodes (15): FloatingActivityHUD(), formatElapsed(), formatTimestamp(), statusColor(), StatusDot(), buildGenericPhases(), buildPhaseSequence(), calculateProgressPercent() (+7 more)

### Community 43 - "Renderer - Design Icons"
Cohesion: 0.11
Nodes (19): @ant-design/icons, cytoscape, elkjs, @fontsource/inter, @fontsource/jetbrains-mono, react-dom, dependencies, @ant-design/icons (+11 more)

### Community 44 - "Renderer - Api Riacore"
Cohesion: 0.15
Nodes (7): api, HealthInfo, HealthStatus(), styles, LoadJsonModalProps, NamespaceDeleteWithPreview(), NamespaceDeleteWithPreviewProps

### Community 45 - "Renderer Hooks Tests Diagram Layout"
Cohesion: 0.11
Nodes (16): API_PATH, apiSource, Deferred, getLayoutCalls, IPC_PATH, ipcSource, LAYOUT_CHANNELS, MUTATION_HOOK_PATH (+8 more)

### Community 46 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.18
Nodes (18): AUTHORED_CONCEPTS, AUTHORED_NODE_TYPES, buildIcon(), ImportedTreePanel, ImportedTreePanelHandle, isAuthoredConcept(), isMalfunctionConcept(), malfunctionKey() (+10 more)

### Community 47 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.18
Nodes (15): InlineSelectCell(), InlineSelectCellProps, InlineTextCell(), InlineTextCellProps, TaskSection(), SafetyTaskSection(), useLinkSafetyTaskToFm(), useAllSafetyTasks() (+7 more)

### Community 48 - "Renderer Hooks Tests Useriacoremutations Workspace"
Cohesion: 0.11
Nodes (17): canvasSource, CLOSE_WS_MUTATION_PATH, closeWsMutationSource, INFINITE_CACHE_KEYS, METAMODEL_RENDERING_HOOK_PATH, metamodelRenderingHookSource, MUTATIONS_PATH, mutationsSource (+9 more)

### Community 49 - "Renderer Hooks Usemodelview"
Cohesion: 0.24
Nodes (17): anchorQueryKey(), connectionNeighbourhood(), containedElements(), definitionFor(), evaluateElement(), evaluateElements(), expansionKey(), fetchAnchor() (+9 more)

### Community 50 - "Renderer Modules Safety Status Riskmatrix"
Cohesion: 0.14
Nodes (15): bubbleDiameter(), CELL_COLORS, cellColor(), DETECTION_LABELS, DETECTION_LEVELS_TOP_TO_BOTTOM, OCCURRENCE_LABELS, OCCURRENCE_LEVELS, RiskMatrix() (+7 more)

### Community 51 - "Desktop Host Navigation"
Cohesion: 0.19
Nodes (12): EXTERNAL_SCHEMES, GuardedWebContents, installNavigationGuard(), isExternallyOpenable(), isInternalUrl(), NavigationGuardDeps, NavigationScope, devScope (+4 more)

### Community 52 - "Renderer Shell Bottompanel"
Cohesion: 0.18
Nodes (15): usePersistorRepairMutation(), ActivityTab(), BottomPanel(), CollapsedBar(), ExpandedDrawer(), StateTab(), StatusBarProps, StatusChip (+7 more)

### Community 53 - "Renderer - Hooks Usesafetydata"
Cohesion: 0.18
Nodes (8): useSafetyData(), StatusCardsEditorProps, StatusCardsView(), StatusCardsViewProps, arbitraryComponentExportData(), arbitraryMalfunctionExportData(), arbitraryRiskRatingData(), ResizeObserverStub

### Community 54 - "Renderer Modules Settings"
Cohesion: 0.15
Nodes (10): useSaveLlmSettings(), buildInitialValues(), FormValues, LlmSettingsDialog(), MODEL_OPTIONS, Props, PROVIDER_OPTIONS, currentSettings (+2 more)

### Community 55 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.14
Nodes (14): AnomalyBanner(), AnomalyBannerProps, validateChildrenResponse(), validateNamespaceList(), arbChildrenNoDuplicates, arbChildrenWithDuplicates, arbConcept, arbName (+6 more)

### Community 56 - "Renderer Modules Import Impactreportpanel"
Cohesion: 0.17
Nodes (7): useImpactReport(), groupByAuthoredNamespace(), ImpactReportPanel(), ImpactReportPanelProps, makeEdge(), makeModified(), makeOrphaned()

### Community 57 - "Renderer Modules Namespace - Modelexpansion"
Cohesion: 0.18
Nodes (13): ModelExpansion, COMMON_MODEL_METAMODEL, EMPTY, useCommonModelPresentation(), usePresentation(), tileHeight(), hintForLoneTile(), ModelViewCanvasInner() (+5 more)

### Community 58 - "Renderer Modules Namespace Editors Model"
Cohesion: 0.17
Nodes (13): expansionsFor(), ModelTile, EXPANSION_LABELS, expansionMenuId(), HIDDEN_HANDLE, ICONS, ModelTileNode, ModelTileNodeData (+5 more)

### Community 59 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.17
Nodes (14): ModelPort, ACTIVE_ELEMENT_CONCEPT, ASIL_ORDER, CONNECTION_CONCEPT, DiagramMalfunctionRef, getAsilHexColor(), isDiagramAnchorConcept(), isRelevantConcept() (+6 more)

### Community 60 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.16
Nodes (14): buildIcon(), buildIconCached(), anyAsilArb, anyConceptArb, buildIconForTest(), buildStateWithRecord(), containsTag(), coreAsilArb (+6 more)

### Community 61 - "Renderer Tsconfig"
Cohesion: 0.13
Nodes (14): ../../packages/profiles/*, compilerOptions, baseUrl, jsx, module, moduleResolution, noEmit, paths (+6 more)

### Community 62 - "Renderer Store"
Cohesion: 0.19
Nodes (10): LlmSettingsTrigger(), AppSettingsDialogActions, AppSettingsDialogState, AppSettingsDialogStore, closeAppSettingsDialog(), openAppSettingsDialog(), LlmSettingsDialogActions, LlmSettingsDialogState (+2 more)

### Community 63 - "Renderer Shell Workspacecanvas"
Cohesion: 0.15
Nodes (8): appApi, buildImportSource(), buildNamespace(), ConfirmConfig, DEFAULT_GRAPH, mocks, ResizeObserverStub, seedOpenWorkspace()

### Community 64 - "Desktop Host - Git"
Cohesion: 0.15
Nodes (5): getPackagedGitBinaryPath(), MessageHandler, { mockState }, PendingRequest, QueuedRequest

### Community 65 - "Desktop Host Tests Spawn Manager"
Cohesion: 0.15
Nodes (4): CapturedOpts, createMockWindow(), createSetup(), MockWindow

### Community 66 - "Desktop Host - Tests"
Cohesion: 0.16
Nodes (4): invokePrepareHandler(), makeMockDiffService(), makeNamespaceDiffResult(), MockCtx

### Community 67 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.14
Nodes (9): arbConcept, arbName, arbNamespace, arbNodeId, arbRelationship, arbTreeReferenceNode, PANEL_PATH, NOTE: Test environment is 'node' (no DOM / React hooks runtime). (+1 more)

### Community 68 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.19
Nodes (10): arbNamespace, arbNamespaceList, arbNodeId, arbNodeKey, arbTreeAction, arbTreeIndexState, arbTreeNodeRecord, collectNodes() (+2 more)

### Community 69 - "Renderer Shell Autolayoutrecords"
Cohesion: 0.24
Nodes (10): ANALYSIS_ELEMENT_KIND, AuthoredNamespaceLike, buildAutoLayoutRecords(), IMPORTED_ELEMENT_KIND, ImportSourceLike, Point, arbNodeId, arbPoint (+2 more)

### Community 70 - "Renderer Shell Tests Autolayoutbutton Test"
Cohesion: 0.16
Nodes (7): appApi, buildImportSource(), buildNamespace(), DEFAULT_GRAPH, mocks, ResizeObserverStub, seedOpenWorkspace()

### Community 71 - "Renderer Shell Tests Placementmode Test"
Cohesion: 0.16
Nodes (6): buildImportSource(), buildNamespace(), DEFAULT_GRAPH, mocks, ResizeObserverStub, seedOpenWorkspace()

### Community 72 - "Desktop Host Web"
Cohesion: 0.27
Nodes (12): ApiRequest, corsOrigin(), createRuntime(), EventClient, getConfig(), isAuthorized(), LOOPBACK_HOSTS, main() (+4 more)

### Community 73 - "Renderer Modules Namespace Editors"
Cohesion: 0.18
Nodes (9): GenericModelBrowserModal(), GenericModelBrowserModalProps, DEFAULT_SAFETY_METAMODEL, SafetyMetamodelContext, AUTHORED_ONLY_EDITORS, GenericModelBrowserView, NamespaceRouter(), NS_EDITOR_MAP (+1 more)

### Community 74 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.22
Nodes (9): FailurePropagationDiagram(), FailurePropagationDiagramProps, PropagationCanvasEdge, PropagationCanvasNode, buildPropagationGraph(), PropagationGraphEdge, PropagationGraphNode, PropagationGraphResult (+1 more)

### Community 75 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.22
Nodes (9): getElementId(), getLabel(), getNamespaceBadgeColor(), getNamespaceBadgeText(), ImportedRequirementPicker(), ImportedRequirementPickerProps, ResizeObserverStub, useLinkDirectRequirementToFm() (+1 more)

### Community 76 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.19
Nodes (10): catalogColumns(), ReviewInstructionsModal(), ReviewInstructionsModalProps, buildView(), enumOptions(), SAFETY_METAMODEL, SafetyAsilGroup, SafetyProfileSelectOption (+2 more)

### Community 77 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.15
Nodes (8): APP_QUERY_CLIENT_FILE, arbNamespace, arbParentNodeId, arbWorkspaceKey, HOOK_FILE, hookSource, NOTE: The test environment is 'node' (no DOM / React hooks runtime)., SPAWN_QUERY_CLIENT_FILE

### Community 78 - "Renderer Hooks Tests Namespace Connections"
Cohesion: 0.17
Nodes (10): API_PATH, apiSource, CONNECTION_CHANNELS, HOOK_PATH, hookCode, hookSource, IPC_PATH, ipcSource (+2 more)

### Community 79 - "Renderer Lib Reviewprofile"
Cohesion: 0.18
Nodes (8): EXCLUDED_GENERAL_REVIEW_CONCEPTS, isLlmReviewEligible(), REVIEW_PROFILE_BY_METAMODEL, SWC_COMPONENT_CONCEPTS, conceptArb, excludedGeneralConcepts, metamodelArb, unknownMetamodelArb

### Community 80 - "Renderer Modules Import Importmanager"
Cohesion: 0.18
Nodes (8): FILE_OPTIONS, ImporterConfigDrawer(), ImporterConfigDrawerProps, VERSION_OPTIONS, DEMO_IMPORTERS, ImporterDefinition, ImportManager(), TODO: wire to imports.run IPC with real params

### Community 81 - "Renderer Modules Llm"
Cohesion: 0.18
Nodes (6): buildSettings(), MockReviewState, mocks, resetMockState(), ResizeObserverStub, Slice

### Community 82 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.20
Nodes (6): candidateKey(), MalfunctionCandidate, ReconnectOrphanedModal(), ReconnectOrphanedModalProps, ResizeObserverStub, SOURCE

### Community 83 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.18
Nodes (8): ASIL_HEX_COLORS, buildGetPropagations(), cyclicGraphArb, cyclicGraphWithEntryArb, deepChainArb, directedGraphArb, graphWithEntryArb, makeMalfunctionData()

### Community 84 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.18
Nodes (10): ancestorPathArb, applySearchResultSelect(), buildBaseState(), makeNamespaceRecord(), namespaceArb, nodeIdArb, preExistingKeysArb, searchResultArb (+2 more)

### Community 85 - "Renderer Modules Safety Status Statuscard"
Cohesion: 0.23
Nodes (5): computeCoverage(), computeRiskMatrixBubbles(), metamodelLabel(), StatusCard(), StatusCardProps

### Community 86 - "Renderer Lib Tests"
Cohesion: 0.18
Nodes (4): arbMessage, arbQueryKey, arbStringKey, LruSet

### Community 87 - "Renderer Modules Diff"
Cohesion: 0.29
Nodes (9): attributeKeyLabels, conceptTypeLabels, labelAttributeKey(), labelConceptType(), labelRelationshipType(), relationshipTypeLabels, knownAttributeKeys, knownConceptTypes (+1 more)

### Community 88 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.40
Nodes (10): debug(), error(), info(), initDebugFlag(), isEnabled(), startTimer(), timestamp(), treeDebug (+2 more)

### Community 89 - "Renderer Shell Autolayoutstate"
Cohesion: 0.29
Nodes (9): anyRenderedElementHasRecord(), AutoLayoutInitialState, decideInitialAutoLayoutState(), encodeLayoutId(), LayoutKey, arbElementKey, arbKind, arbLayoutKey (+1 more)

### Community 90 - "Desktop Host Tests Worker Dispatch"
Cohesion: 0.20
Nodes (6): arbInstance, arbInstances, CONCEPTS, InstanceRow, SearchResult, VALID_NODE_TYPES

### Community 91 - "Renderer Modules Namespace"
Cohesion: 0.33
Nodes (6): useAutoSave(), ResizablePanelConfig, ResizablePanelState, useResizablePanel(), useSectionShortcuts(), SafetyEditor()

### Community 92 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.22
Nodes (3): HistoryEntry, TreeNavHistory, useTreeNavigationHistory()

### Community 93 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.20
Nodes (8): ANALYSIS_NODE_SIZE, ANALYSIS_PARTITION, GenGraph, GRAPH_LAYOUT_OPTIONS, IMPORTED_PARTITION, IMPORTER_NODE_SIZE, partitionedGraphArb, variedGraphArb

### Community 94 - "Renderer Shell Tests"
Cohesion: 0.27
Nodes (7): Point, resolveNodePosition(), arbElementKey, arbElementSet, arbKind, arbPoint, Element

### Community 95 - "Renderer Lib Namespacetypedecoration"
Cohesion: 0.28
Nodes (8): getNamespaceDecorationByMetamodel(), getNamespaceDecorationBySourceType(), KIND_DECORATION, kindFromMetamodel(), kindFromSourceType(), NamespaceKind, NamespaceTypeDecoration, UNKNOWN_IMPORT_DECORATION

### Community 96 - "Renderer Modules Import Generic"
Cohesion: 0.28
Nodes (7): conceptIcon(), GenericImportViewerModal(), GenericImportViewerModalProps, GenericTreeNode, IconProps, toTreeNode(), GenericImportViewerModal

### Community 97 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.22
Nodes (3): CENTER_PANEL_PATH, source, Target

### Community 98 - "Renderer Modules Namespace Editors"
Cohesion: 0.39
Nodes (6): TreeContextMenu(), TreeContextMenuProps, truncateReviewTargetName(), useSafetyMetamodel(), useAllNamespaces(), useTreeChildren()

### Community 99 - "Cli Tsconfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 100 - "Desktop Host Logo Generate"
Cohesion: 0.46
Nodes (7): ensure_dir(), generate_icns(), generate_ico(), generate_pngs(), main(), Generate all platform-specific icons for electron-builder from icon_1024.png.…, Generate .icns on macOS using iconutil, skip on other platforms.

### Community 101 - "Desktop Host Scripts Start"
Cohesion: 0.29
Nodes (7): children, path, { randomBytes }, repoRoot, shutdown(), { spawn }, start()

### Community 102 - "Desktop Host Tests Worker Dispatch"
Cohesion: 0.29
Nodes (6): arbChannel, arbRequestId, ARXML_EXAMPLE_DIR, createOpenStubDeps(), createStubDeps(), REPO_ROOT

### Community 103 - "Desktop Host Tsconfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 104 - "Renderer Package"
Cohesion: 0.25
Nodes (7): name, private, scripts, build, dev, test, version

### Community 105 - "Renderer Components Tests Showintreetrigger Test"
Cohesion: 0.25
Nodes (5): arbTarget, NOTE: This is the OLD logic before shortcut hints were added. The component, source, Target, TRIGGER_PATH

### Community 106 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.32
Nodes (3): buildStateWithFirstPage(), makeModelRecord(), makeNamespaceRecord()

### Community 107 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.29
Nodes (7): assertPropagationKeyInFunction(), extractFunctionBody(), MODAL_MAPPINGS, ModalKind, ModalMapping, MUTATIONS_FILE, mutationsSource

### Community 108 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.39
Nodes (6): arbKey, arbRecord(), arbSimpleState, arbStateWithChildren, makeState(), TreeNodeKey

### Community 109 - "Renderer Shell Placementrecord"
Cohesion: 0.36
Nodes (6): buildPlacementRecord(), FlowCoord, PlacementTarget, arbFlowCoord, arbKeyString, arbPlacement

### Community 110 - "Renderer Tests Safety"
Cohesion: 0.32
Nodes (4): arbitraryComponentExportData(), arbitraryMalfunctionExportData(), arbitraryRiskRatingData(), ResizeObserverStub

### Community 111 - "Desktop Host Electron Builder"
Cohesion: 0.29
Nodes (7): RiaCore Electron Builder Configuration, Dugite Git Binary Extra Resource, Platform Icon Paths (win/mac/linux), NSIS Installer Script (build/installer.nsh), .release/sidecar Extra Resource (node-sidecar), generate_icons.py Script, Icon Generation Process

### Community 112 - "Desktop Host Tests Worker Dispatch"
Cohesion: 0.29
Nodes (3): arbChild, arbChildren, ChildRow

### Community 113 - "Renderer Components Git Gitcommitmodal"
Cohesion: 0.33
Nodes (6): gitKeys, BASE_STAGE_PATTERNS, buildStagePatterns(), GitCommitModal(), GitCommitModalProps, Phase

### Community 114 - "Renderer Modules Namespace Editors Generic"
Cohesion: 0.29
Nodes (6): CENTER_PANEL_PATH, centerPanelSource, ELEMENT_HEADER_PATH, elementHeaderSource, MODAL_PATH, modalSource

### Community 115 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.29
Nodes (3): CENTER_PANEL_PATH, source, Target

### Community 116 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.29
Nodes (3): CENTER_PANEL_PATH, source, Target

### Community 117 - "Renderer Modules Safety Status Componentdiagram"
Cohesion: 0.38
Nodes (6): C, ComponentDiagram(), ComponentDiagramProps, derivePorts(), hasOutgoingPropagation(), PortInfo

### Community 118 - "Renderer Store Llmreviewmodalstore"
Cohesion: 0.29
Nodes (5): LlmReviewModalActions, LlmReviewModalState, LlmReviewModalStore, LlmReviewModalTarget, openLlmReviewModal()

### Community 123 - "Desktop Host Worker"
Cohesion: 0.93
Nodes (5): handleMessage(), initialize(), main(), send(), sendLog()

### Community 124 - "Renderer Components Showintreetrigger"
Cohesion: 0.53
Nodes (3): ShowInTreeTrigger(), ShowInTreeTriggerProps, formatShortcutHint()

### Community 125 - "Renderer Hooks Tests Modelview Refresh"
Cohesion: 0.33
Nodes (3): COMPONENT, evaluate, getMalfunctionsForElements

### Community 126 - "Renderer Modules Import Updatefrombranchmodal"
Cohesion: 0.40
Nodes (5): RefOption, RepoDetection, repoNameFromPath(), UpdateFromBranchModal(), UpdateFromBranchModalProps

### Community 127 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.33
Nodes (5): arbNamespace, arbParentNodeId, arbScope, arbShowAll, arbWorkspaceKey

### Community 129 - "Renderer Components Tests Show In"
Cohesion: 0.40
Nodes (3): arbTarget, Path, Target

### Community 130 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.40
Nodes (3): PropagationEdge, PropagationEdgeData, PropagationEdgeType

### Community 131 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.60
Nodes (4): ScopedPropagationDiagram(), ScopedPropagationDiagramProps, toCanvasNode(), usePropagationsForComponent()

### Community 132 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.40
Nodes (4): CENTER_PANEL_PATH, centerPanelSource, EDITOR_PATH, editorSource

### Community 133 - "Renderer Modules Namespace Editors Safety"
Cohesion: 0.40
Nodes (4): ALL, CONNECTIONS, NS, selectAnalysisRootNamespaces()

### Community 138 - "Renderer Common Modeltreeview"
Cohesion: 0.67
Nodes (3): filterTree(), ModelTreeView(), ModelTreeViewProps

### Community 139 - "Renderer Store Themestore"
Cohesion: 0.67
Nodes (3): getSystemDark(), ThemeStore, useThemeStore

### Community 143 - "Renderer Assets Icon"
Cohesion: 0.67
Nodes (3): App Icon (Stylized Woman Profile), Renderer App, RIA Brand Identity

## Knowledge Gaps
- **777 isolated node(s):** `name`, `version`, `private`, `main`, `types` (+772 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **36 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `api` connect `Renderer - Api Riacore` to `Renderer Hooks - Usecanvasautosave`, `Renderer Hooks Usediffmutations`, `Renderer Modules Graph Core`, `Renderer Components Data`, `Renderer Hooks - Usecanvasautosave Readcanvasdbsnapshot`, `Renderer Modules Namespace Editors Safety`, `Renderer Lib Optrace`, `Renderer Api Git`, `Renderer Lib`, `Renderer Modules Namespace Editors Safety`, `Renderer Hooks - Useriacoremutations`, `Renderer Hooks - Usemetamodelprofilemetadata`, `Renderer Hooks Tests Usellmreview Noinvalidation`, `Renderer Modules Namespace - Editors Generic`, `Renderer`, `Renderer Hooks - Jobstatusbadge`, `Renderer Hooks`, `Renderer Hooks - Useactiveimport`, `Renderer Shell Importerconfigdrawer`, `Renderer Modules`, `Renderer Shell`, `Renderer Hooks Tests Diagram Layout`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace Editors Safety`, `Renderer Hooks Usemodelview`, `Renderer Shell Bottompanel`, `Renderer - Hooks Usesafetydata`, `Renderer Modules Settings`, `Renderer Modules Import Impactreportpanel`, `Renderer Modules Namespace - Modelexpansion`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Import Importmanager`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace`, `Renderer Modules Import Generic`, `Renderer Modules Namespace Editors`, `Renderer Components Git Gitcommitmodal`, `Renderer Components Showintreetrigger`, `Renderer Modules Import Updatefrombranchmodal`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `useWorkspaceStore` connect `Renderer Modules Namespace - Editors Generic` to `Renderer Hooks Usediffmutations`, `Renderer Components Data`, `Renderer Hooks - Usecanvasautosave Readcanvasdbsnapshot`, `Renderer Lib Optrace`, `Renderer Api Git`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace Editors Safety`, `Renderer Hooks - Useriacoremutations`, `Renderer Modules Namespace Editors Safety`, `Renderer`, `Renderer Hooks - Jobstatusbadge`, `Renderer Hooks`, `Renderer Hooks - Useactiveimport`, `Renderer Modules`, `Renderer Modules Namespace Editors Safety`, `Renderer Modules Namespace Editors Safety`, `Renderer Shell Bottompanel`, `Renderer Modules Namespace Editors`, `Renderer Modules Namespace`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `useWorkspaceState()` connect `Renderer Hooks - Useactiveimport` to `Renderer Hooks - Usecanvasautosave`, `Renderer Hooks`, `Renderer Hooks Usediffmutations`, `Renderer Modules Graph Core`, `Renderer Hooks - Usecanvasautosave Readcanvasdbsnapshot`, `Renderer Modules Namespace Editors`, `Renderer Modules Namespace Editors`, `Renderer Lib Optrace`, `Renderer Shell`, `Renderer Modules Namespace Editors Safety`, `Renderer Hooks - Useriacoremutations`, `Renderer Shell Bottompanel`, `Renderer Hooks - Usemetamodelprofilemetadata`, `Renderer Modules Namespace`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _777 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Renderer Vite Env` be split into smaller, more focused modules?**
  _Cohesion score 0.008888888888888889 - nodes in this community are weakly interconnected._
- **Should `Cli Cli Logger` be split into smaller, more focused modules?**
  _Cohesion score 0.06626262626262626 - nodes in this community are weakly interconnected._
- **Should `Renderer Hooks - Usecanvasautosave` be split into smaller, more focused modules?**
  _Cohesion score 0.05997778600518327 - nodes in this community are weakly interconnected._