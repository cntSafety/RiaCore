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
export { createDbModule, DbGenerationChangedError } from './db/db-module.js';
export type { IDbModule, AppCoreLogger } from './db/db-module.js';
export { SCHEMA_VERSION, DB_SCHEMA_VERSION_TABLE, DB_SCHEMA_VERSION_NODE_ID } from './db/schema.js';
export { createWorkspaceService } from './workspace/workspace-service.js';
export type { IWorkspaceService } from './workspace/workspace-service.js';
export { createImportLogger, createPersistorLoadLogger, createDiffMergeLogger } from './infra/logger.js';
export type { ImportLogger, PersistorLoadLogger } from './infra/logger.js';
export { createImportWriteService } from './importers/import-write-service.js';
export type { IImportWriteServiceExt, LinkMLSchema, LinkMLClass, LinkMLSlot, LinkMLAttribute, LinkMLEnum, LinkMLPermissibleValue } from './importers/import-write-service.js';
export { buildMetamodelProfileMetadata } from './importers/profile-metadata.js';
export { computeFileDigest } from './importers/file-digest.js';
export { parseLinkMLSchema, composeProfileSchema } from './importers/linkml-parser.js';
export { createImporterOrchestrationService } from './importers/orchestration-service.js';
export type { IImporterOrchestrationService } from './importers/orchestration-service.js';
export { createImporterRegistry } from './importers/importer-registry.js';
export type { IImporterRegistry } from './importers/importer-registry.js';
export { createProvisioningService } from './importers/provisioning-service.js';
export type { IProvisioningService } from './importers/provisioning-service.js';
export { createImportCrossNsImpactService } from './importers/import-crossns-impact-service.js';
export type { IImportCrossNsImpactService } from './importers/import-crossns-impact-service.js';
export { createProfileRegistry } from './profiles/profile-registry.js';
export type { IProfileRegistry, AuthoredProfileDescriptor } from './profiles/profile-registry.js';
export { createNamespaceService } from './namespaces/namespace-service.js';
export type { INamespaceService } from './namespaces/namespace-service.js';
export { createConnectionService } from './namespaces/connection-service.js';
export type { IConnectionService, WiringResult, ConnectionEntry } from './namespaces/connection-service.js';
export { createLayoutService, RESOLVERS, encodeLayoutId, decodeLayoutId } from './namespaces/layout-service.js';
export type { ILayoutService, ElementResolver, LayoutRecord, DiagramLayout } from './namespaces/layout-service.js';
export { createInstanceService } from './namespaces/instance-service.js';
export type { IInstanceService, ConceptInstanceData, RelationshipData } from './namespaces/instance-service.js';
export { createSafetyCommands } from './safety/safety-commands.js';
export type { ISafetyCommands, CreateMalfunctionParams, CreateTagParams, MalfunctionData,
  CreateRiskRatingParams, ReviewItemData, DeleteImpactPreview } from './safety/safety-commands.js';
export { createPersistorService, computeNamespaceHashFromFiles } from './persistor/persistor.js';
export type { IPersistorService, StoreResult, LoadResult, LoadProgressEvent, OnLoadProgress, PersistorLoadParams, RepairManifestResult, Manifest } from './persistor/persistor.js';
export { createCommandDispatcher } from './dispatch/index.js';
export type { ICommandDispatcher, ServiceDependencies, ChannelMeta } from './dispatch/index.js';
export { buildGraphQueryResult } from './dispatch/index.js';
export { ensureSourceConfigData } from './dispatch/index.js';
export { e } from './dispatch/index.js';
export { extractNodeName } from './dispatch/index.js';
export { resolveAncestorPath } from './dispatch/index.js';
export { createLoadGate, READ_ONLY_EXEMPTION_SET } from './dispatch/load-gating.js';
export type { LoadGate, GatedResult } from './dispatch/load-gating.js';
export { createDiffService } from './diff/diff-service.js';
export type { IDiffService, IThreeWayDiffService } from './diff/diff-service.js';
export { createMergeService } from './diff/merge-service.js';
export type { IMergeService } from './diff/merge-service.js';
export { REVIEW_PROFILE_BY_METAMODEL, resolveReviewProfile } from './llm/profile.js';
export { ReviewRunRegistry } from './llm/review-run-registry.js';
export type { WebContentsLike, ReviewRunEntry } from './llm/review-run-registry.js';
export {
  LlmSettingsStore,
  DEFAULT_LLM_SETTINGS,
  LLM_SETTINGS_FILENAME,
  LLM_CREDENTIALS_FILENAME,
} from './llm/llm-settings-store.js';
export type {
  SafeStorageLike,
  LlmSettingsStoreOptions,
} from './llm/llm-settings-store.js';
export {
  LLM_STREAM_CHANNEL,
  pushStreamEvent,
  consumePumpedStream,
} from './llm/llm-stream.js';
export type {
  StreamEventBody,
  PumpedTextChunk,
  PumpedUsage,
  PumpBedrockStreamResult,
  PumpLlmStreamArgs,
} from './llm/llm-stream.js';
export { createBedrockModel, createLanguageModel } from './llm/provider-factory.js';
export type { BedrockModelConfig } from './llm/provider-factory.js';
export {
  collectContextElements_swArxml,
  collectContextElements_sysml,
  SYSML_OWNS_ELEMENT_DESCENDANTS_QUERY,
} from './llm/context-collectors.js';
export type { ContextElementRef, ContextCollectorDeps } from './llm/context-collectors.js';
