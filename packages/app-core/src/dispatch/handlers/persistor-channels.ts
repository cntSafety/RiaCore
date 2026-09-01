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
import * as path from 'node:path';
import { createPersistorService, createImportLogger, createPersistorLoadLogger } from '../../index.js';
import { runStoreCommitHook } from '../../git/store-commit-hook.js';
import type { createRegistry } from '../channel-registry.js';

function errorContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };

  return {
    error: error.message,
    errorType: error.name,
    stack: error.stack,
    ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
  };
}

/**
 * Register persistor channels: store, load, repairManifest.
 *
 * Each operation creates a per-operation logger via `deps.createLogger`
 * (falling back to `createImportLogger` / `createPersistorLoadLogger`)
 * and a fresh `PersistorService` instance, matching the existing
 * worker-dispatch.ts behaviour.
 *
 * Persistor service failures emit a terminal error record before rethrowing,
 * and every created logger is closed in a `finally` block. Workspace-open
 * failures are handled by the worker request boundary before a logger is made,
 * preserving the rule that an invalid path must not be created as a side effect.
 */
export function registerPersistorChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register('persistor.store', async (payload, deps, _ctx) => {
    const startedAt = Date.now();
    const scopedNamespace = (payload as { namespace?: string }).namespace ?? '(full store)';
    const wsResult = await deps.workspaceService.open({ workingDir: payload.workingDir });
    if (!wsResult.ok) throw new Error(wsResult.error);

    const logger = deps.createLogger
      ? deps.createLogger(payload.workingDir)
      : createImportLogger(path.join(payload.workingDir, 'logs'));

    try {
      const svc = createPersistorService(deps.dbModule, logger);
      const storeResult = await svc.store(payload);

      // Update workspace lifecycle badge: "New workspace" / "Loaded from ria-data"
      // → "Exported to ria-data" so the UI reflects the current state without
      // requiring the user to close and reopen the workspace.
      deps.workspaceService.notifyStoreCompleted();

      // Phase 5: optional auto-commit hook (normally never throws).
      if (deps.gitService) {
        await runStoreCommitHook(payload.workingDir, storeResult, deps.gitService, logger).catch((error) =>
          logger.warn('[git] Auto-commit hook threw unexpectedly', errorContext(error)),
        );
      }

      return storeResult;
    } catch (error) {
      logger.error('Persistor store failed', {
        workingDir: payload.workingDir,
        scopedNamespace,
        durationMs: Date.now() - startedAt,
        ...errorContext(error),
      });
      throw error;
    } finally {
      logger.close();
    }
  }, {
    requiresWorkspace: true,
    category: 'persistor',
  });

  registry.register('persistor.load', async (payload, deps, _ctx) => {
    const startedAt = Date.now();
    const wsResult = await deps.workspaceService.open({ workingDir: payload.workingDir });
    if (!wsResult.ok) throw new Error(wsResult.error);

    const logger = deps.createLogger
      ? deps.createLogger(payload.workingDir)
      : createPersistorLoadLogger(path.join(payload.workingDir, 'logs'));

    try {
      const svc = createPersistorService(deps.dbModule, logger);
      return await svc.load(payload);
    } catch (error) {
      logger.error('Persistor load failed', {
        workingDir: payload.workingDir,
        durationMs: Date.now() - startedAt,
        ...errorContext(error),
      });
      throw error;
    } finally {
      logger.close();
    }
  }, {
    requiresWorkspace: true,
    category: 'persistor',
  });

  registry.register('persistor.repairManifest', async (payload, deps, _ctx) => {
    // repairManifest operates purely on the filesystem (ria-data/ JSON files and
    // manifest.json). It does NOT need an open DB — in fact, the primary use case
    // is recovering from a hash mismatch that prevents workspace.open() from
    // succeeding. Opening the workspace here would fail for the same reason.
    const logger = deps.createLogger
      ? deps.createLogger(payload.workingDir)
      : createImportLogger(path.join(payload.workingDir, 'logs'));
    const startedAt = Date.now();

    try {
      const svc = createPersistorService(deps.dbModule, logger);
      return await svc.repairManifest(payload);
    } catch (error) {
      logger.error('Persistor manifest repair failed', {
        workingDir: payload.workingDir,
        durationMs: Date.now() - startedAt,
        ...errorContext(error),
      });
      throw error;
    } finally {
      logger.close();
    }
  }, {
    requiresWorkspace: false,
    category: 'persistor',
  });
}
