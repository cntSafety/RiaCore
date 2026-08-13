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
 * connection-migration.ts — Option B best-effort load-time migration for legacy
 * workspaces (manual-namespace-connections feature).
 *
 * Legacy workspaces (created before the two-edge model) contain
 * `RIA_META_CATEGORIZEDBY` edges (from the old blanket auto-wiring) but **no**
 * per-pair `RIA_UNIV_NamespaceConnection` edges. The derived CATEGORIZEDBY edge
 * alone cannot say which analysis a connection was meant for when several
 * analyses share the same metamodel.
 *
 * This migration implements **Option B** from the design's
 * "Migration / back-compat strategy" section:
 *
 *   For each imported namespace I (namespace_role = 'imported') that has NO
 *   `RIA_UNIV_NamespaceConnection` edges (idempotent skip if it already has any),
 *   and for each metamodel M that I has a `RIA_META_CATEGORIZEDBY` edge to:
 *     - if M resolves to EXACTLY ONE authored namespace A → create the per-pair
 *       edge I → A (via ConnectionService.connect, keeping CATEGORIZEDBY consistent);
 *     - if M resolves to TWO OR MORE authored namespaces → create nothing and
 *       record a "reconnect required" entry identifying I and M.
 *
 * It never creates derived `RIA_META_CATEGORIZEDBY` edges independently — the
 * only side-effect is `connect`, which keeps the derived edge a function of the
 * per-pair edges. It is idempotent: an imported namespace that already has any
 * per-pair edge is skipped entirely.
 *
 * Requirements: 1.3, 8.2
 */

import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import { createConnectionService } from '../namespaces/connection-service.js';

export interface MigratedConnection {
  imported: string;
  authored: string;
  metamodel: string;
}

export interface ReconnectRequiredEntry {
  imported: string;
  metamodel: string;
  /** The two-or-more authored namespaces the metamodel resolves to (ambiguous). */
  candidates: string[];
}

export interface LegacyConnectionMigrationResult {
  /** Per-pair edges created during migration (the unambiguous single-analysis case). */
  migrated: MigratedConnection[];
  /** Imported namespace + metamodel pairs left unmigrated because the metamodel maps to >= 2 analyses. */
  reconnectRequired: ReconnectRequiredEntry[];
}

/**
 * Run the Option B best-effort migration once at workspace load.
 *
 * Idempotent and non-fatal: imported namespaces that already have any per-pair
 * edge are skipped; any unexpected error is caught and logged rather than
 * aborting the workspace load.
 */
export async function migrateLegacyConnections(
  dbModule: IDbModule,
  logger?: ImportLogger,
): Promise<LegacyConnectionMigrationResult> {
  const result: LegacyConnectionMigrationResult = { migrated: [], reconnectRequired: [] };

  try {
    const connectionService = createConnectionService(dbModule, logger);

    // 1. Imported namespaces with NO per-pair edges (idempotent skip otherwise).
    const importedRows = await dbModule.runQuery(
      `MATCH (i:RIA_UNIV_Namespace)
       WHERE i.namespace_role = 'imported'
         AND NOT EXISTS { MATCH (i)-[:RIA_UNIV_NamespaceConnection]->(:RIA_UNIV_Namespace) }
       RETURN i.name AS name
       ORDER BY name`,
    );

    for (const importedRow of importedRows) {
      const imported = String(importedRow.name ?? '');
      if (!imported) continue;

      // 2. Metamodels this imported namespace is categorized by (the legacy signal).
      const metamodelRows = await dbModule.runQuery(
        `MATCH (i:RIA_UNIV_Namespace {name: $imported})-[:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel)
         RETURN DISTINCT mm.name AS metamodel
         ORDER BY metamodel`,
        { imported },
      );

      for (const metamodelRow of metamodelRows) {
        const metamodel = String(metamodelRow.metamodel ?? '');
        if (!metamodel) continue;

        // 3. Authored namespaces resolving to M (via DEFINEDBY, fallback ns.metamodel).
        const authoredRows = await dbModule.runQuery(
          `MATCH (a:RIA_UNIV_Namespace)
           WHERE a.namespace_role = 'authored'
           OPTIONAL MATCH (a)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
           WITH a, coalesce(mm.name, a.metamodel) AS mmName
           WHERE mmName = $metamodel
           RETURN DISTINCT a.name AS name
           ORDER BY name`,
          { metamodel },
        );

        const authoredNames = authoredRows
          .map((row) => String(row.name ?? ''))
          .filter((name) => name.length > 0);

        if (authoredNames.length === 1) {
          // Unambiguous: create the single per-pair edge via connect() so the
          // derived CATEGORIZEDBY edge stays consistent (never created on its own).
          const authored = authoredNames[0];
          const connectResult = await connectionService.connect(imported, authored);
          if (connectResult.ok) {
            result.migrated.push({ imported, authored, metamodel });
            logger?.info?.('Legacy connection migrated (single-analysis metamodel)', {
              imported,
              authored,
              metamodel,
            });
          } else {
            logger?.warn?.('Legacy connection migration failed to connect', {
              imported,
              authored,
              metamodel,
              error: connectResult.error,
            });
          }
        } else if (authoredNames.length >= 2) {
          // Ambiguous shared-metamodel case: do not guess. Surface "reconnect required".
          result.reconnectRequired.push({ imported, metamodel, candidates: authoredNames });
          logger?.warn?.(
            `Reconnect required: imported namespace '${imported}' was categorized by metamodel ` +
              `'${metamodel}', which maps to ${authoredNames.length} analyses (${authoredNames.join(', ')}). ` +
              `The connection could not be migrated automatically — reconnect it manually.`,
            { imported, metamodel, candidates: authoredNames },
          );
        }
        // authoredNames.length === 0: no analysis resolves to M — nothing to do.
      }
    }
  } catch (err) {
    logger?.warn?.('Legacy connection migration failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
