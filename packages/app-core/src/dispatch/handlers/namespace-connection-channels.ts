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
import type {
  NamespaceConnectionGraph,
  ConnectionEntry,
  DisconnectResult,
} from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { createConnectionService } from '../../namespaces/connection-service.js';
import { createConnectionQueryService } from '../../namespaces/connection-query-service.js';

/**
 * Register the manual namespace-connection channels:
 *   - namespaceConnections:getGraph
 *   - namespaceConnections:connect
 *   - namespaceConnections:disconnect
 *   - namespaceConnections:countDependents
 *
 * All require an open workspace. The backing services return `Result<T>`; the IPC
 * contract instead returns `T` directly and throws `Error` on failure, so each
 * handler unwraps the Result: throw `new Error(result.error)` on failure, otherwise
 * return `result.data`.
 */
export function registerNamespaceConnectionChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── namespaceConnections:getGraph ────────────────────────────────────────────
  // Returns the full connection graph (all imported namespaces, all analysis
  // namespaces with their metamodels, and every existing per-pair connection).
  registry.register('namespaceConnections:getGraph', async (_payload, deps, _ctx) => {
    const service = createConnectionQueryService(deps.dbModule);
    const result = await service.getConnectionGraph();
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data satisfies NamespaceConnectionGraph;
  }, {
    requiresWorkspace: true,
    category: 'namespaceConnections',
  });

  // ── namespaceConnections:connect ─────────────────────────────────────────────
  // Create exactly one per-pair connection (imported → authored). Idempotent.
  registry.register('namespaceConnections:connect', async (payload, deps, _ctx) => {
    const { sourceNamespace, targetNamespace } = payload;
    // DIAGNOSTIC (temporary): correlate connection-create timestamps against
    // persistor.store timestamps to investigate the intermittent
    // missing-connection-on-reopen bug. Remove once root-caused.
    console.log('[DIAG] namespaceConnections:connect: requested', {
      ts: new Date().toISOString(), sourceNamespace, targetNamespace,
    });
    const service = createConnectionService(deps.dbModule);
    const result = await service.connect(sourceNamespace, targetNamespace);
    if (!result.ok) {
      throw new Error(result.error);
    }
    console.log('[DIAG] namespaceConnections:connect: completed', {
      ts: new Date().toISOString(), sourceNamespace, targetNamespace,
      alreadyConnected: result.data.alreadyConnected,
    });
    return result.data satisfies ConnectionEntry;
  }, {
    requiresWorkspace: true,
    category: 'namespaceConnections',
  });

  // ── namespaceConnections:disconnect ──────────────────────────────────────────
  // Remove one per-pair connection, optionally deleting dependent cross-NS
  // relationship instances when deleteDependents is true.
  registry.register('namespaceConnections:disconnect', async (payload, deps, _ctx) => {
    const { importedNamespace, authoredNamespace, deleteDependents } = payload;
    // DIAGNOSTIC (temporary): see namespaceConnections:connect above.
    console.log('[DIAG] namespaceConnections:disconnect: requested', {
      ts: new Date().toISOString(), importedNamespace, authoredNamespace, deleteDependents,
    });
    const service = createConnectionService(deps.dbModule);
    const result = await service.disconnect(
      importedNamespace,
      authoredNamespace,
      deleteDependents,
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data satisfies DisconnectResult;
  }, {
    requiresWorkspace: true,
    category: 'namespaceConnections',
  });

  // ── namespaceConnections:countDependents ─────────────────────────────────────
  // Count dependent cross-NS relationship instances for the specific pair. Backs
  // the disconnect confirmation step so the UI can show the exact count.
  registry.register('namespaceConnections:countDependents', async (payload, deps, _ctx) => {
    const { importedNamespace, authoredNamespace } = payload;
    const service = createConnectionService(deps.dbModule);
    const result = await service.countDependents(importedNamespace, authoredNamespace);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data;
  }, {
    requiresWorkspace: true,
    category: 'namespaceConnections',
  });
}
