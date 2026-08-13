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
import type { IDbModule } from '../db/db-module.js';
import type { IWorkspaceService } from '../workspace/workspace-service.js';
import type { IImporterOrchestrationService } from '../importers/orchestration-service.js';
import type { IImporterRegistry } from '../importers/importer-registry.js';
import type { IProvisioningService } from '../importers/provisioning-service.js';
import type { IProfileRegistry } from '../profiles/profile-registry.js';
import type { INamespaceService } from '../namespaces/namespace-service.js';
import type { IConnectionService } from '../namespaces/connection-service.js';
import type { IInstanceService } from '../namespaces/instance-service.js';
import type { ISafetyCommands } from '../safety/safety-commands.js';
import type { IPersistorService } from '../persistor/persistor.js';
import type { ImportLogger } from '../infra/logger.js';
import type { NamespaceDiffResult, ThreeWayDiffResult, CheckAttributeEntry } from '@riacore/app-contracts';
import type { IGitService } from '@riacore/git-service';
import type { LlmSettingsStore } from '../llm/llm-settings-store.js';
import type { WebContentsLike, ReviewRunRegistry } from '../llm/review-run-registry.js';
import type { LanguageModel } from 'ai';

/**
 * Server-side state stored between `checks.runCheck` and `checks.getPage` calls.
 * The full list of violation node IDs is captured once; attribute data is loaded
 * lazily per page.
 */
export interface CheckRunState {
  checkId: string;
  namespace: string;
  /** All violation node IDs in result order. */
  nodeIds: number[];
  /**
   * Ordered attribute entries (plain key string or {key: alias} object) for the
   * result table columns. Keys are used for DB lookup; aliases are displayed as
   * column headers in the UI.
   */
  attributes: CheckAttributeEntry[];
}

export interface ServiceDependencies {
  dbModule: IDbModule;
  workspaceService: IWorkspaceService;
  orchestration?: IImporterOrchestrationService;
  registry?: IImporterRegistry;
  provisioningService?: IProvisioningService;
  profileRegistry?: IProfileRegistry;
  namespaceService?: INamespaceService;
  connectionService?: IConnectionService;
  instanceService?: IInstanceService;
  safetyCommands?: ISafetyCommands;
  persistorService?: IPersistorService;
  /** Factory for creating per-operation loggers; receives workingDir */
  createLogger?: (workingDir: string) => ImportLogger;
  /** Git service for version control operations */
  gitService?: IGitService;
  /**
   * Persistent store for {@link LlmSettings} and the encrypted
   * Bedrock_Credentials blob. Injected by the host process so that
   * `Electron.safeStorage` and `app.getPath('userData')` stay scoped to
   * the Electron main process and never leak into worker / CLI code.
   *
   * Optional: the worker / CLI dispatchers leave this `undefined`; the
   * `llm.*` channel handlers are responsible for surfacing a clean error
   * when the store is missing.
   *
   * @see Requirement 11.2 — handler dependencies
   * @see Requirement 12.4 — credential boundary
   */
  llmSettingsStore?: LlmSettingsStore;
  /**
   * Test seam: a pre-built Vercel AI SDK `LanguageModel` to use instead of
   * constructing one from stored credentials. When set, the `llm.startReview`
   * handler skips the `createBedrockModel` call entirely.
   *
   * Production wiring leaves this `undefined`. Unit and property tests
   * inject a fake `LanguageModel` so the streaming pump can be exercised
   * without a live network call or real credentials.
   *
   * @see Requirement 11.2 — handler dependencies
   */
  llmModel?: LanguageModel;
  /**
   * Sink for one-way `llm.stream` push events.
   *
   * The Electron host injects the focused window's
   * {@link Electron.WebContents}; the CLI bridge injects an
   * `EventEmitter`-backed adapter; tests inject a `vi.fn()`-backed fake.
   * Optional because most handlers do not push events back to the
   * renderer; the `llm.startReview` handler is the only consumer today.
   *
   * Kept loose (`WebContentsLike`) so neither the worker nor the CLI
   * pulls in Electron types.
   *
   * @see Requirement 8.3, 11.2 — Stream events flow back to the renderer
   *      over a one-way push channel.
   */
  llmStreamSink?: WebContentsLike;
  /**
   * Override for the in-memory {@link ReviewRunRegistry}.
   *
   * Production wiring leaves this `undefined` and the
   * `registerLlmChannels` site instantiates one at module scope so the
   * `cancelReview` handler can reach in-flight runs registered by
   * earlier `startReview` invocations on the same dispatcher. Tests
   * substitute their own registry to inspect lifecycle transitions.
   *
   * @see Requirement 9.3, 9.5, 9.6
   */
  reviewRunRegistry?: ReviewRunRegistry;
  /**
   * Absolute path to the bundled `packages/profiles` directory used by
   * the FM_List loader (Requirement 14).
   *
   * Optional: when omitted the handler resolves the path the same way
   * `profile-registry.ts` does (walking up from `__dirname`). Tests
   * inject a fixture path so the loader can be driven through both
   * success and failure cases without touching the bundled file.
   *
   * @see Requirement 14.1, 14.2
   */
  profileRoot?: string;
}

export interface DispatchContext {
  /** Get cached containment rels for a metamodel, or query and cache them. */
  getContainmentRels(dbModule: IDbModule, metamodel: string): Promise<string[]>;
  /** Get cached hidden concept names for a metamodel, or query and cache them. */
  getHiddenConcepts(dbModule: IDbModule, metamodel: string): Promise<Set<string>>;
  /** Clear the containment cache. */
  clearContainmentCache(): void;
  /** Get the active import source ID. */
  getActiveImportSourceId(): string | null;
  /** Set the active import source ID. */
  setActiveImportSourceId(sourceId: string | null): void;

  // ── Diff result cache (server-side storage for paginated access) ──────────
  storeDiffResult(diffId: string, result: NamespaceDiffResult): void;
  getDiffResult(diffId: string): NamespaceDiffResult | undefined;
  storeThreeWayDiffResult(diffId: string, result: ThreeWayDiffResult): void;
  getThreeWayDiffResult(diffId: string): ThreeWayDiffResult | undefined;

  // ── Check run cache (server-side storage for paginated check results) ─────
  storeCheckRun(runId: string, state: CheckRunState): void;
  getCheckRun(runId: string): CheckRunState | undefined;
}
