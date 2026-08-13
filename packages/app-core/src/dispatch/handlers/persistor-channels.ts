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

/**
 * Register persistor channels: store, load, repairManifest.
 *
 * Each operation creates a per-operation logger via `deps.createLogger`
 * (falling back to `createImportLogger` / `createPersistorLoadLogger`)
 * and a fresh `PersistorService` instance, matching the existing
 * worker-dispatch.ts behaviour.
 *
 * Every logger is closed in a `finally` block so the underlying WriteStream
 * file handle is released as soon as the operation completes. Without this,
 * the handle stays open until the process exits, which causes EPERM errors
 * when test teardown tries to delete the workspace directory on Windows.
 */
export function registerPersistorChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register('persistor.store', async (payload, deps, _ctx) => {
    const wsResult = await deps.workspaceService.open({ workingDir: payload.workingDir });
    if (!wsResult.ok) throw new Error(wsResult.error);

    const logger = deps.createLogger
      ? deps.createLogger(payload.workingDir)
      : createImportLogger(path.join(payload.workingDir, 'logs'));

    try {
      // DIAGNOSTIC (temporary): correlate "last disk write" against canvas
      // mutations and window-close timestamps to investigate the intermittent
      // missing-tile/missing-connection bug on reopen. Remove once root-caused.
      const diagStart = Date.now();
      logger.info('[DIAG] persistor.store: requested', {
        workingDir: payload.workingDir,
        scopedNamespace: (payload as { namespace?: string }).namespace ?? '(full store)',
      });

      const svc = createPersistorService(deps.dbModule, logger);
      const storeResult = await svc.store(payload);

      logger.info('[DIAG] persistor.store: completed', {
        workingDir: payload.workingDir,
        durationMs: Date.now() - diagStart,
        namespacesWritten: storeResult.namespaces_written,
        namespacesSkipped: storeResult.namespaces_skipped,
        totalRecords: storeResult.total_records,
        filesWritten: storeResult.files_written,
      });

      // Update workspace lifecycle badge: "New workspace" / "Loaded from ria-data"
      // → "Exported to ria-data" so the UI reflects the current state without
      // requiring the user to close and reopen the workspace.
      deps.workspaceService.notifyStoreCompleted();

      // Phase 5: optional auto-commit hook (never throws)
      if (deps.gitService) {
        await runStoreCommitHook(payload.workingDir, storeResult, deps.gitService).catch((err) =>
          console.warn('[persistor.store] Auto-commit hook failed:', err instanceof Error ? err.message : String(err)),
        );
      }

      return storeResult;
    } finally {
      logger.close();
    }
  }, {
    requiresWorkspace: true,
    category: 'persistor',
  });

  registry.register('persistor.load', async (payload, deps, _ctx) => {
    const wsResult = await deps.workspaceService.open({ workingDir: payload.workingDir });
    if (!wsResult.ok) throw new Error(wsResult.error);

    const logger = deps.createLogger
      ? deps.createLogger(payload.workingDir)
      : createPersistorLoadLogger(path.join(payload.workingDir, 'logs'));

    try {
      // DIAGNOSTIC (temporary): see persistor.store above.
      logger.info('[DIAG] persistor.load: requested', { workingDir: payload.workingDir });
      const diagStart = Date.now();

      const svc = createPersistorService(deps.dbModule, logger);
      const loadResult = await svc.load(payload);

      logger.info('[DIAG] persistor.load: completed', {
        workingDir: payload.workingDir,
        durationMs: Date.now() - diagStart,
      });

      return loadResult;
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
    try {
      const svc = createPersistorService(deps.dbModule, logger);
      return await svc.repairManifest(payload);
    } finally {
      logger.close();
    }
  }, {
    requiresWorkspace: false,
    category: 'persistor',
  });
}
