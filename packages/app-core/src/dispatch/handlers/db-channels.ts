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
import fs from 'node:fs';
import type { DbStats, DbStatus, NamespaceStats } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';

/**
 * Register db channels: getStatus, getStats, close.
 * `db.probe` is marked electronOnly — it uses fs.existsSync on the DB path
 * and is a UI-polling concern that doesn't belong in headless dispatch.
 */
export function registerDbChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register('db.getStatus', async (_payload, deps, _ctx) => {
    return deps.dbModule.getStatus();
  }, {
    requiresWorkspace: true,
    category: 'db',
  });

  registry.register('db.getStats', async (_payload, deps, _ctx) => {
    // Return zeroed stats when no workspace is open — this is the normal
    // state on first launch before the user selects a workspace.
    if (deps.dbModule.getStatus().state !== 'open') {
      const empty: DbStats = { namespace_count: 0, node_count: 0, edge_count: 0 };
      return empty;
    }

    const [nsRows, nodeRows, edgeRows] = [
      await deps.dbModule.runQuery('MATCH (n:RIA_UNIV_Namespace) RETURN count(n) AS cnt'),
      await deps.dbModule.runQuery('MATCH (n:RIA_UNIV_ConceptInstance) RETURN count(n) AS cnt'),
      await deps.dbModule.runQuery('MATCH (n:RIA_UNIV_RelationshipInstance) RETURN count(n) AS cnt'),
    ];

    const stats: DbStats = {
      namespace_count: Number(nsRows[0]?.cnt ?? 0),
      node_count:      Number(nodeRows[0]?.cnt ?? 0),
      edge_count:      Number(edgeRows[0]?.cnt ?? 0),
    };
    return stats;
  }, {
    requiresWorkspace: true,
    category: 'db',
  });

  registry.register('db.getNamespaceStats', async (_payload, deps, _ctx) => {
    if (deps.dbModule.getStatus().state !== 'open') {
      return [] as NamespaceStats[];
    }

    const rows = await deps.dbModule.runQuery(
      `MATCH (n:RIA_UNIV_ConceptInstance)
       RETURN n.namespace AS name, count(n) AS node_count`,
    );
    const edgeRows = await deps.dbModule.runQuery(
      `MATCH (r:RIA_UNIV_RelationshipInstance)
       RETURN r.namespace AS name, count(r) AS edge_count`,
    );

    // Build a map of edge counts per namespace
    const edgeMap = new Map<string, number>();
    for (const row of edgeRows) {
      const ns = String(row.name ?? '');
      if (ns) edgeMap.set(ns, Number(row.edge_count ?? 0));
    }

    const stats: NamespaceStats[] = rows
      .filter((row) => row.name)
      .map((row) => ({
        name: String(row.name),
        node_count: Number(row.node_count ?? 0),
        edge_count: edgeMap.get(String(row.name)) ?? 0,
      }));

    return stats;
  }, {
    requiresWorkspace: true,
    category: 'db',
  });

  registry.register('db.close', async (_payload, deps, _ctx) => {
    return deps.dbModule.close();
  }, {
    requiresWorkspace: true,
    category: 'db',
  });

  // db.probe is electronOnly — it checks fs.existsSync on the DB path,
  // which is a UI-polling concern not suitable for headless dispatch.
  registry.register('db.probe', async (_payload, deps, _ctx) => {
    // Report the real DB state by checking if the file exists on disk.
    // If the file is gone, report 'closed' — but do NOT close the handle here.
    // Closing during probe can race with concurrent dispatch calls and cause
    // segfaults in KuzuDB's native layer. Instead, workspaceService.open()
    // handles the stale-handle cleanup when the workspace is next opened.
    const currentStatus = deps.dbModule.getStatus();
    if (currentStatus.state === 'open' && currentStatus.path) {
      if (!fs.existsSync(currentStatus.path)) {
        return { state: 'closed' } as DbStatus;
      }
    }
    return currentStatus;
  }, {
    requiresWorkspace: false,
    electronOnly: true,
    category: 'db',
  });
}
