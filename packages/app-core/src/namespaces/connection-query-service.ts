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
import type { Result } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NamespaceConnectionGraph {
  /** Distinct imported namespaces (namespace_role = 'imported'). */
  imported: { name: string }[];
  /** Distinct analysis namespaces (namespace_role = 'authored') with resolved metamodel. */
  analyses: { name: string; metamodel: string }[];
  /** Distinct per-pair connections, directed imported (source) → authored (target). */
  connections: { source: string; target: string }[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IConnectionQueryService {
  /**
   * Return the full connection graph: every imported namespace, every analysis
   * namespace (with its metamodel), and every existing per-pair connection.
   * Lists are distinct-by-name so no duplicates appear even when namespaces share a
   * role. When no connections exist, the connections list is empty but the imported
   * and analysis lists are still fully populated. On any retrieval failure the whole
   * operation fails with an error and returns no partial graph.
   */
  getConnectionGraph(): Promise<Result<NamespaceConnectionGraph>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConnectionQueryService(
  dbModule: IDbModule,
  logger?: ImportLogger,
): IConnectionQueryService {
  return {
    async getConnectionGraph(): Promise<Result<NamespaceConnectionGraph>> {
      try {
        // 1. Distinct imported namespaces.
        const importedRows = await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace)
           WHERE ns.namespace_role = 'imported'
           RETURN DISTINCT ns.name AS name
           ORDER BY name`,
        );

        // 2. Distinct analysis namespaces, each with its metamodel resolved via
        //    RIA_META_DEFINEDBY (fallback to the namespace's own metamodel property
        //    for stale snapshots where the edge has not been restored yet).
        const analysisRows = await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace)
           WHERE ns.namespace_role = 'authored'
           OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
           RETURN DISTINCT ns.name AS name, coalesce(mm.name, ns.metamodel) AS metamodel
           ORDER BY name`,
        );

        // 3. Distinct per-pair connections (source = imported, target = authored).
        const connectionRows = await dbModule.runQuery(
          `MATCH (i:RIA_UNIV_Namespace)-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace)
           RETURN DISTINCT i.name AS source, a.name AS target
           ORDER BY source, target`,
        );

        const imported = importedRows.map((row) => ({
          name: String(row.name),
        }));

        const analyses = analysisRows.map((row) => ({
          name: String(row.name),
          metamodel: String(row.metamodel ?? ''),
        }));

        const connections = connectionRows.map((row) => ({
          source: String(row.source),
          target: String(row.target),
        }));

        // Only assemble and return the graph once every query has succeeded, so a
        // failure never yields a partial graph.
        return { ok: true, data: { imported, analyses, connections } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Failed to retrieve namespace connection graph', {
          error: message,
        });
        return {
          ok: false,
          error: `Failed to retrieve connection graph: ${message}`,
        };
      }
    },
  };
}
