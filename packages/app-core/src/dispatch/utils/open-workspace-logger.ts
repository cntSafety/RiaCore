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
/**
 * Resolve a workspace logger for a channel whose payload carries no `workingDir`.
 *
 * Most handlers take `workingDir` from their payload and call
 * `deps.loggers.workspace(workingDir)` directly. A few channels — `app.cleanup`,
 * `canvasLayout:setRecords`, `namespaceConnections:connect` / `:disconnect` —
 * have no such field, and before this helper existed they logged with
 * `console.log`, which writes to stdout and therefore corrupted the CLI's
 * machine-readable output (see CoreArchPrinciples.md §Logger infrastructure).
 *
 * All of them declare `requiresWorkspace: true`, so an open workspace is
 * guaranteed and its `workingDir` is the correct log destination.
 *
 * Returns `null` when no workspace is open, which callers should treat as
 * "nowhere to log" rather than an error: these are diagnostics, and none of them
 * is worth failing an operation over.
 */

import type { ServiceDependencies } from '../types.js';
import type { ImportLogger } from '../../infra/logger.js';

export async function openWorkspaceLogger(
  deps: ServiceDependencies,
): Promise<ImportLogger | null> {
  const status = await deps.workspaceService.getStatus();
  if (status.state !== 'open') return null;
  const workingDir = status.info.workingDir;
  if (!workingDir) return null;
  return deps.loggers.workspace(workingDir);
}
