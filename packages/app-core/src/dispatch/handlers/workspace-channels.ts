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
import type { createRegistry } from '../channel-registry.js';
import { runAllCleanups } from '../../infra/cleanup-service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Register workspace channels (open, getStatus).
 * Both require an open workspace context — `workspace.open` is the entry point
 * that transitions the workspace to open state, so it is tagged requiresWorkspace: true
 * to match the existing IPC contract where the DB must be accessible.
 */
export function registerWorkspaceChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register('workspace.open', async (payload, deps, ctx) => {
    const result = await deps.workspaceService.open(payload);
    if (!result.ok) throw new Error(result.error);

    // Clear any stale import lock from a previous session or workspace.
    // This prevents false "Import already running" errors after the user
    // opens a different workspace or restarts the app while an import was
    // in progress.
    ctx.setActiveImportSourceId(null);

    // Run cleanup after the workspace opens successfully to remove any
    // artefacts left over from previous sessions (e.g. supervised_update_temp
    // namespaces that were not deleted because the app was closed mid-review).
    // The cleanup is best-effort: failures are logged but do not prevent the
    // workspace from opening.
    //
    // Skip it when a background ria-data load is still in progress (Case B,
    // lifecycleAction === 'loading_from_ria_data'): the load runs as a
    // fire-and-forget task on the SAME dbModule, and its failure handler closes
    // and deletes the DB. Running cleanup queries here concurrently caused a
    // native use-after-free crash. For that path, workspace-service runs the
    // cleanup itself once the load has settled.
    if (result.data.lifecycleAction !== 'loading_from_ria_data') {
      try {
        await runAllCleanups(deps.dbModule, (msg) => console.info(msg));
      } catch (cleanupErr) {
        console.warn(`[workspace.open] Post-open cleanup failed: ${String(cleanupErr)}`);
      }
    }

    return result.data;
  }, {
    requiresWorkspace: false,
    category: 'workspace',
  });

  registry.register('workspace.create', async (payload, deps, ctx) => {
    const result = await deps.workspaceService.create(payload);
    if (!result.ok) throw new Error(result.error);

    // Clear any stale import lock, consistent with workspace.open behaviour.
    ctx.setActiveImportSourceId(null);

    // Run cleanup after the workspace is created to remove any artefacts
    // left over from previous sessions. Best-effort: failures are logged
    // but do not prevent the workspace from being created.
    try {
      await runAllCleanups(deps.dbModule, (msg) => console.info(msg));
    } catch (cleanupErr) {
      console.warn(`[workspace.create] Post-create cleanup failed: ${String(cleanupErr)}`);
    }

    return result.data;
  }, {
    requiresWorkspace: false,
    category: 'workspace',
  });

  registry.register('workspace.getStatus', async (_payload, deps, _ctx) => {
    return await deps.workspaceService.getStatus();
  }, {
    requiresWorkspace: false,
    category: 'workspace',
  });

  registry.register('workspace.close', async (_payload, deps, ctx) => {
    // Close the currently-open workspace. The service serialises this behind the
    // lifecycle mutex and bound-awaits any in-flight ria-data load before
    // releasing the DB handle, so it is safe to call at any time. Auto-save
    // means no explicit save is required first. A no-op when nothing is open.
    await deps.workspaceService.close();

    // Clear any stale import lock, consistent with open/create, so a subsequent
    // open in the same session starts clean.
    ctx.setActiveImportSourceId(null);
  }, {
    requiresWorkspace: false,
    category: 'workspace',
  });

  registry.register('workspace.probe', async (payload, _deps, _ctx) => {
    const workingDir = payload.workingDir;
    const dbPath = path.join(workingDir, 'db');
    const riaDataDir = path.join(workingDir, 'ria-data');
    const hasDb = fs.existsSync(dbPath);
    // Mirror the hasValidManifest logic from workspace-service: dir must exist
    // and contain a parseable manifest.json.
    let hasRiaData = false;
    try {
      const manifestPath = path.join(riaDataDir, 'manifest.json');
      const content = await fs.promises.readFile(manifestPath, 'utf-8');
      JSON.parse(content);
      hasRiaData = true;
    } catch {
      hasRiaData = false;
    }
    return { hasDb, hasRiaData };
  }, {
    requiresWorkspace: false,
    category: 'workspace',
  });
}
