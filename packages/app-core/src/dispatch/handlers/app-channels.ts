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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { createRegistry } from '../channel-registry.js';
import { runAllCleanups } from '../../infra/cleanup-service.js';

// Resolve the app version at module load time.
//
// Priority order:
//  1. RIACORE_APP_VERSION env var — set by the Electron main process before
//     forking the worker. This works in both dev and portable/packaged builds.
//  2. Monorepo root package.json — relative path walk that only works in dev
//     when compiled output lives at packages/app-core/dist/dispatch/handlers/.
//     Portable/packaged builds do not include the monorepo root package.json,
//     so this falls through to the fallback.
//  3. '0.0.0' — last-resort fallback so the channel never throws.
function readRootVersion(): string {
  if (process.env.RIACORE_APP_VERSION) {
    return process.env.RIACORE_APP_VERSION;
  }
  try {
    const rootPkg = path.resolve(__dirname, '../../../../..', 'package.json');
    const pkg = JSON.parse(readFileSync(rootPkg, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readRootVersion();

/**
 * Register app-level channels that do not require an open workspace.
 */
export function registerAppChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register('app.getInfo', async (_payload, _deps, _ctx) => {
    return { name: 'RiaCore', version: APP_VERSION };
  }, {
    requiresWorkspace: false,
    category: 'app',
  });

  // ── app.cleanup ───────────────────────────────────────────────────────────
  // Runs all registered database cleanup routines:
  //  - Removes supervised_update_temp namespaces (abandoned supervised-update sessions)
  //  - Removes dangling concept nodes whose owning namespace no longer exists
  //
  // This is called automatically when a workspace is opened (workspace.open)
  // and can also be triggered explicitly at any time (e.g. from diagnostics UI).
  // All steps are idempotent; a clean database incurs minimal overhead.
  registry.register('app.cleanup', async (_payload, deps, _ctx) => {
    return runAllCleanups(deps.dbModule, (msg) => console.info(msg));
  }, {
    requiresWorkspace: true,
    category: 'app',
  });
}
