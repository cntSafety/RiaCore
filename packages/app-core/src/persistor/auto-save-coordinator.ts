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
// packages/app-core/src/persistor/auto-save-coordinator.ts
/**
 * Auto_Save_Coordinator — the backend choke point that keeps `ria-data/` in sync
 * with the database.
 *
 * ## Why this exists
 *
 * Auto-save used to live in the renderer: `useAutoSave` fired a scoped
 * `persistor.store` after a mutation, and every safety mutation hook took an
 * **optional** `triggerAutoSave?: () => void`. Saving therefore depended on each
 * call site remembering to pass it. Several did not — tag mutations, the
 * malfunction expanded-row inline edits, imported-tree deletions, and view
 * definitions all wrote the DB with no store anywhere in the flow. Those changes
 * existed only in the database and were lost on the next `persistor.load`, which
 * `WorkspaceLifecycle.md` documents as the intended "load-as-undo" path. The CLI
 * had no auto-save at all, since it has no renderer.
 *
 * Moving the trigger to the dispatcher fixes the whole class of bug at once: a
 * channel is covered by its `ChannelMeta.mutates` declaration rather than by a
 * callback someone has to thread through the component tree, and every host —
 * Electron, web dev server, CLI — inherits it.
 *
 * ## Design notes
 *
 * - **Dirty namespaces are resolved from the DB, not from the payload.** Every
 *   write through `instance-service` sets `content_hash = ''`, so the dirty set
 *   is `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.content_hash = ''`. A channel
 *   cannot declare the wrong namespace, and a new write path is covered as soon
 *   as it goes through the instance service. This is why `'namespace'` carries no
 *   namespace name.
 *
 * - **Temp namespaces are excluded.** Supervised and branch-update flows import
 *   into namespaces marked `namespace_role = 'supervised_update_temp'`. Those are
 *   scratch state for a diff and must never reach `ria-data/`.
 *
 * - **No mutex here.** `persistor-store.ts` already serializes every `store()`
 *   variant through a per-`workingDir` promise chain, so a background flush
 *   cannot interleave with an explicit store even though worker dispatches run
 *   concurrently.
 *
 * - **A namespace flush subsumes a universe flush.** A namespace-scoped store
 *   also writes the meta, sourcemaster, cross-namespace, and universe files
 *   (they are emitted before the per-namespace loop), so when both are pending
 *   the universe store is skipped.
 */

import type { IDbModule, AppCoreLogger } from '../db/db-module.js';
import type { IWorkspaceService } from '../workspace/workspace-service.js';
import type { MutationScope } from '../dispatch/channel-registry.js';
import type { IPersistorService } from './persistor-types.js';

/** Namespace role used for scratch namespaces that must never be persisted. */
const TEMP_NAMESPACE_ROLE = 'supervised_update_temp';

/**
 * Debounce window for coalescing a burst of mutations into one store.
 *
 * Chosen to batch the common multi-write interaction (a create followed
 * immediately by a link, or a drag that emits several layout writes) without
 * being long enough to lose meaningful work if the process dies. The renderer's
 * `useAutoSave` used 0 ms because it was driven by a single user action; here the
 * coordinator sees every channel from every window and the CLI, so coalescing
 * matters more.
 */
export const DEFAULT_AUTO_SAVE_DEBOUNCE_MS = 150;

export interface AutoSaveFlushResult {
  /** Namespaces written by a namespace-scoped store. */
  namespacesWritten: string[];
  /** Whether a universe-scoped store ran. */
  universeWritten: boolean;
  /** Whether a full store ran. */
  fullWritten: boolean;
  /** Error message when the flush failed; absent on success. */
  error?: string;
}

export interface IAutoSaveCoordinator {
  /**
   * Record that a dispatch changed persisted content and schedule a coalesced
   * store. Never throws and never blocks the caller — the dispatcher calls this
   * synchronously on the response path.
   *
   * `'self'` is accepted and ignored, so callers can pass a channel's declared
   * scope straight through without branching.
   */
  markDirty(scope: MutationScope): void;

  /**
   * Resolve once any pending or in-flight flush has settled. Used by tests and
   * by shutdown paths that must not lose a pending save.
   */
  flush(): Promise<void>;

  /** True while a store is in flight or a debounce timer is armed. */
  isPending(): boolean;
}

export interface AutoSaveCoordinatorDeps {
  dbModule: IDbModule;
  workspaceService: IWorkspaceService;
  /** Builds a persistor bound to a working directory. */
  persistorFactory: (workingDir: string) => IPersistorService;
  logger?: AppCoreLogger;
  /** Override the debounce window. Tests pass 0 to flush on the next tick. */
  debounceMs?: number;
  /**
   * Observability hook, invoked after every flush attempt (including failures).
   * The Electron host uses it to push save status to the renderer.
   */
  onFlushed?: (result: AutoSaveFlushResult) => void;
}

export function createAutoSaveCoordinator(
  deps: AutoSaveCoordinatorDeps,
): IAutoSaveCoordinator {
  const {
    dbModule,
    workspaceService,
    persistorFactory,
    logger,
    debounceMs = DEFAULT_AUTO_SAVE_DEBOUNCE_MS,
    onFlushed,
  } = deps;

  // Pending work, accumulated between flushes. `full` dominates `universe`
  // because a full store writes the universe files too.
  let namespaceDirty = false;
  let universeDirty = false;
  let fullDirty = false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  /** Set when markDirty arrives while a flush is running, so we re-run after. */
  let requeued = false;
  /** Whether the most recent round failed — gates retry so we never spin. */
  let lastFlushFailed = false;

  function hasPendingWork(): boolean {
    return namespaceDirty || universeDirty || fullDirty;
  }

  /**
   * Resolve the namespaces whose DB content has diverged from `ria-data/`.
   * Excludes supervised-update scratch namespaces.
   */
  async function resolveDirtyNamespaces(): Promise<string[]> {
    const rows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace)
       WHERE ns.content_hash = '' AND ns.namespace_role <> $tempRole
       RETURN ns.name AS name
       ORDER BY name`,
      { tempRole: TEMP_NAMESPACE_ROLE },
    );
    return rows
      .map((row) => String(row.name ?? ''))
      .filter((name) => name !== '');
  }

  /** Current working directory, or null when no workspace is usably open. */
  async function resolveWorkingDir(): Promise<string | null> {
    const status = await workspaceService.getStatus();
    if (status.state !== 'open') return null;
    // Never store from a half-built DB: a Case B load still in flight owns the
    // handle, and 'load_failed' means the DB was torn down.
    const action = status.info.lifecycleAction;
    if (action === 'loading_from_ria_data' || action === 'load_failed') return null;
    if (status.info.dbStatus.state !== 'open') return null;
    return status.info.workingDir;
  }

  async function runFlush(): Promise<AutoSaveFlushResult> {
    // Take and clear the pending flags up front, so mutations arriving during
    // the store are recorded for the next round rather than silently absorbed
    // into this one.
    const wantNamespace = namespaceDirty;
    const wantUniverse = universeDirty;
    const wantFull = fullDirty;
    namespaceDirty = false;
    universeDirty = false;
    fullDirty = false;

    const result: AutoSaveFlushResult = {
      namespacesWritten: [],
      universeWritten: false,
      fullWritten: false,
    };

    const workingDir = await resolveWorkingDir();
    if (!workingDir) {
      // No usable workspace. Drop the flags rather than retrying forever: the
      // content_hash markers survive in the DB, so the next workspace open
      // reconciles through the normal Case D consistency check.
      logger?.debug?.('[autosave] skipped — no open workspace');
      onFlushed?.(result);
      return result;
    }

    const persistor = persistorFactory(workingDir);

    try {
      if (wantFull) {
        await persistor.store({ workingDir });
        result.fullWritten = true;
        logger?.info?.('[autosave] full store complete', { workingDir });
      } else if (wantNamespace) {
        const dirty = await resolveDirtyNamespaces();
        for (const namespace of dirty) {
          await persistor.store({ workingDir, namespace });
          result.namespacesWritten.push(namespace);
        }
        if (dirty.length > 0) {
          logger?.info?.('[autosave] namespace store complete', {
            workingDir,
            namespaces: dirty,
          });
        } else {
          logger?.debug?.('[autosave] nothing dirty — namespace store skipped');
        }
        // A namespace-scoped store also rewrites the universe files, so a
        // pending universe flush is already satisfied. When nothing was dirty,
        // the universe store still has to run.
        if (wantUniverse && dirty.length === 0) {
          await persistor.store({ workingDir, scope: 'universe' });
          result.universeWritten = true;
        }
      } else if (wantUniverse) {
        await persistor.store({ workingDir, scope: 'universe' });
        result.universeWritten = true;
        logger?.info?.('[autosave] universe store complete', { workingDir });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.error = message;
      logger?.error?.('[autosave] store failed', { workingDir, error: message });
      // Re-arm only the scopes the DB cannot recover on its own. Namespace work
      // stays marked via content_hash = '', so the next flush picks it up
      // without a flag. Deliberately does NOT restart the timer — that would
      // spin on a persistent failure. The next mutation triggers a retry.
      if (wantUniverse) universeDirty = true;
      if (wantFull) fullDirty = true;
    }

    onFlushed?.(result);
    return result;
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleFlush(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void startFlush();
    }, debounceMs);
  }

  function startFlush(): Promise<void> {
    if (inFlight) {
      // Coalesce: one follow-up round after the current store finishes, however
      // many mutations arrived while it was running.
      requeued = true;
      return inFlight;
    }
    const run = (async () => {
      try {
        lastFlushFailed = false;
        const result = await runFlush();
        lastFlushFailed = result.error !== undefined;
      } finally {
        inFlight = null;
        if (requeued) {
          requeued = false;
          // Chain a follow-up only when the previous round succeeded. Retrying a
          // failing store immediately would spin.
          if (hasPendingWork() && !lastFlushFailed) await startFlush();
        }
      }
    })();
    inFlight = run;
    return run;
  }

  /**
   * Upper bound on rounds a single `flush()` will drive. A store that keeps
   * marking new work would otherwise let `flush()` run forever and wedge the
   * shutdown path that awaits it.
   */
  const MAX_FLUSH_ROUNDS = 8;

  return {
    markDirty(scope: MutationScope): void {
      // 'self' channels perform their own store; scheduling another would double
      // the work and, for a full store, be expensive.
      if (scope === 'self') return;

      if (scope === 'full') fullDirty = true;
      else if (scope === 'universe') universeDirty = true;
      else namespaceDirty = true;

      if (inFlight) {
        // A store is already running and has read its data, so this change is
        // not in it. Hand the work to the running flush's follow-up round rather
        // than to a timer: `flush()` awaits the chain, so a mutation landing
        // mid-store is still covered by a shutdown flush.
        requeued = true;
        return;
      }
      scheduleFlush();
    },

    async flush(): Promise<void> {
      clearTimer();
      // Drive rounds until quiescent. Each awaited round can surface new work —
      // either chained via `requeued` or marked by a concurrent dispatch.
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
        if (!hasPendingWork() && !inFlight) return;
        await startFlush();
        clearTimer();
        // Stop after a failure: the flags stay armed so the next mutation
        // retries, but looping here would hammer a persistently failing store.
        if (lastFlushFailed) return;
      }
      logger?.warn?.('[autosave] flush did not settle within the round limit', {
        rounds: MAX_FLUSH_ROUNDS,
      });
    },

    isPending(): boolean {
      return timer !== null || inFlight !== null || hasPendingWork();
    },
  };
}
