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
import type { IpcChannelMap, NamespaceDiffResult, ThreeWayDiffResult } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { ServiceDependencies, DispatchContext } from './types.js';
import type { ChannelMeta, ChannelEntry } from './channel-registry.js';
import { createRegistry } from './channel-registry.js';
import { registerAppChannels } from './handlers/app-channels.js';
import { registerWorkspaceChannels } from './handlers/workspace-channels.js';
import { registerDbChannels } from './handlers/db-channels.js';
import { registerImportChannels } from './handlers/import-channels.js';
import { registerPersistorChannels } from './handlers/persistor-channels.js';
import { registerProvisioningChannels } from './handlers/provisioning-channels.js';
import { registerNamespaceChannels } from './handlers/namespace-channels.js';
import { registerMetamodelChannels } from './handlers/metamodel-channels.js';
import { registerNamespaceConnectionChannels } from './handlers/namespace-connection-channels.js';
import { registerCanvasLayoutChannels } from './handlers/canvas-layout-channels.js';
import { registerNamespaceMergeChannels } from './handlers/namespace-merge-channels.js';
import { registerGraphChannels } from './handlers/graph-channels.js';
import { registerSafetyChannels } from './handlers/safety-channels.js';
import { registerArxmlChannels } from './handlers/arxml-channels.js';
import { registerDiffChannels } from './handlers/diff-channels.js';
import { registerGitChannels } from '../git/git-commands.js';
import { registerCheckChannels } from './handlers/check-channels.js';
import { registerLlmChannels } from './handlers/llm-channels.js';

export interface ICommandDispatcher {
  /** Dispatch a channel call. Throws on unknown channel or service error. */
  dispatch<C extends keyof IpcChannelMap>(
    channel: C,
    payload: IpcChannelMap[C]['input'],
    deps: ServiceDependencies,
  ): Promise<IpcChannelMap[C]['output']>;

  /** List all registered (non-electronOnly) channel names */
  listChannels(): string[];

  /** Get metadata for a channel, or undefined if not registered */
  getChannelMeta(channel: string): ChannelMeta | undefined;

  /** Clear the containment cache (called after workspace open, import, load, close). */
  clearContainmentCache(): void;

  /** Get the active import source ID, or null. */
  getActiveImportSourceId(): string | null;

  /** Set the active import source ID (null to clear). */
  setActiveImportSourceId(sourceId: string | null): void;
}

export function createCommandDispatcher(): ICommandDispatcher {
  const reg = createRegistry();

  // Register channel handlers by category
  registerAppChannels(reg);
  registerWorkspaceChannels(reg);
  registerDbChannels(reg);
  registerImportChannels(reg);
  registerPersistorChannels(reg);
  registerProvisioningChannels(reg);
  registerNamespaceChannels(reg);
  registerMetamodelChannels(reg);
  registerNamespaceConnectionChannels(reg);
  registerCanvasLayoutChannels(reg);
  registerNamespaceMergeChannels(reg);
  registerGraphChannels(reg);
  registerSafetyChannels(reg);
  registerArxmlChannels(reg);
  registerDiffChannels(reg);
  registerGitChannels(reg);
  registerCheckChannels(reg);
  registerLlmChannels(reg);

  const { map: registry } = reg;

  // --- Instance-scoped state (closure variables) ---

  /** Cache of containment relationship names per metamodel. */
  const containmentCache = new Map<string, string[]>();

  /** Cache of hidden concept names per metamodel. */
  const hiddenCache = new Map<string, Set<string>>();

  /** Source ID of the currently running import, or null. */
  let activeImportSourceId: string | null = null;

  /** Server-side storage for two-way diff results (diffId → result). */
  const activeDiffResults = new Map<string, NamespaceDiffResult>();

  /** Server-side storage for three-way diff results (diffId → result). */
  const activeThreeWayDiffResults = new Map<string, ThreeWayDiffResult>();

  /** Server-side storage for check run results (runId → CheckRunState). */
  const activeCheckRuns = new Map<string, import('./types.js').CheckRunState>();

  // --- DispatchContext passed to handlers ---

  const ctx: DispatchContext = {
    async getContainmentRels(dbModule: IDbModule, metamodel: string): Promise<string[]> {
      const cached = containmentCache.get(metamodel);
      if (cached) return cached;

      const rows = await dbModule.runQuery(
        `MATCH (r:RIA_META_Relationship)
         WHERE r.metamodel = $metamodel AND r.is_containment = true
         RETURN r.name AS name`,
        { metamodel },
      );
      const rels = rows.map((r) => String(r.name));

      // Only cache non-empty results. During persistor.load the meta layer is
      // transiently deleted before being re-imported; caching an empty list
      // would poison the cache and make every subsequent getChildren call treat
      // the namespace as a flat (unstructured) list until the cache is cleared.
      if (rels.length > 0) {
        containmentCache.set(metamodel, rels);
      }
      return rels;
    },

    async getHiddenConcepts(dbModule: IDbModule, metamodel: string): Promise<Set<string>> {
      const cached = hiddenCache.get(metamodel);
      if (cached) return cached;

      const rows = await dbModule.runQuery(
        `MATCH (c:RIA_META_Concept)
         WHERE c.metamodel = $metamodel AND c.render_hidden = true
         RETURN c.name AS name`,
        { metamodel },
      );
      const set = new Set(rows.map((r) => String(r.name)));

      // Only cache non-empty results. During persistor.load the meta layer is
      // transiently deleted before being re-imported; caching an empty set
      // would poison the cache and make every subsequent getChildren call treat
      // every concept as visible until the cache is cleared.
      if (set.size > 0) {
        hiddenCache.set(metamodel, set);
      }
      return set;
    },

    clearContainmentCache(): void {
      containmentCache.clear();
      hiddenCache.clear();
    },

    getActiveImportSourceId(): string | null {
      return activeImportSourceId;
    },

    setActiveImportSourceId(sourceId: string | null): void {
      activeImportSourceId = sourceId;
    },

    storeDiffResult(diffId: string, result: NamespaceDiffResult): void {
      activeDiffResults.set(diffId, result);
    },

    getDiffResult(diffId: string): NamespaceDiffResult | undefined {
      return activeDiffResults.get(diffId);
    },

    storeThreeWayDiffResult(diffId: string, result: ThreeWayDiffResult): void {
      activeThreeWayDiffResults.set(diffId, result);
    },

    getThreeWayDiffResult(diffId: string): ThreeWayDiffResult | undefined {
      return activeThreeWayDiffResults.get(diffId);
    },

    storeCheckRun(runId: string, state: import('./types.js').CheckRunState): void {
      activeCheckRuns.set(runId, state);
    },

    getCheckRun(runId: string): import('./types.js').CheckRunState | undefined {
      return activeCheckRuns.get(runId);
    },
  };

  /** Channels whose successful dispatch should clear the containment cache. */
  const CACHE_INVALIDATING_CHANNELS = new Set([
    'workspace.open',
    'imports.run',
    'persistor.load',
    'db.close',
  ]);

  return {
    async dispatch<C extends keyof IpcChannelMap>(
      channel: C,
      payload: IpcChannelMap[C]['input'],
      deps: ServiceDependencies,
    ): Promise<IpcChannelMap[C]['output']> {
      const entry: ChannelEntry | undefined = registry.get(channel as string);
      if (!entry) {
        throw new Error(`Unknown channel: ${channel as string}`);
      }

      if (entry.meta.requiresWorkspace) {
        const dbStatus = deps.dbModule.getStatus();
        if (dbStatus.state === 'closed') {
          throw new Error(
            `Channel ${channel as string} requires an open workspace`,
          );
        }
      }

      const result = await entry.handler(payload, deps, ctx);

      // Post-dispatch side effect: clear containment + hidden caches after state-changing operations
      if (CACHE_INVALIDATING_CHANNELS.has(channel as string)) {
        containmentCache.clear();
        hiddenCache.clear();
      }

      return result;
    },

    listChannels(): string[] {
      const channels: string[] = [];
      for (const [name, entry] of registry) {
        if (!entry.meta.electronOnly) {
          channels.push(name);
        }
      }
      return channels;
    },

    getChannelMeta(channel: string): ChannelMeta | undefined {
      const entry = registry.get(channel);
      return entry?.meta;
    },

    clearContainmentCache(): void {
      containmentCache.clear();
      hiddenCache.clear();
    },

    getActiveImportSourceId(): string | null {
      return activeImportSourceId;
    },

    setActiveImportSourceId(sourceId: string | null): void {
      activeImportSourceId = sourceId;
    },
  };
}
