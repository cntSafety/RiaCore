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

/** Escape single-quotes and backslashes for Cypher string literals. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionEntry {
  importedNamespace: string;
  authoredNamespace: string;
  authoredMetamodel: string;
  alreadyConnected: boolean;
}

export interface WiringResult {
  connections: ConnectionEntry[];
  errors: string[];
}

export interface DisconnectResult {
  importedNamespace: string;
  authoredNamespace: string;
  deletedDependentCount: number;
  removedCategorizedBy: boolean;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IConnectionService {
  /**
   * Create exactly one per-pair connection (imported → authored). Idempotent.
   * Side-effect: ensure the derived RIA_META_CATEGORIZEDBY(imported → metamodel) edge.
   * Rejects same-role pairs and the authored→imported direction.
   */
  connect(
    sourceNamespace: string,
    targetNamespace: string,
  ): Promise<Result<ConnectionEntry>>;

  /**
   * Count dependent Cross_Namespace_Relationship instances for the specific pair.
   */
  countDependents(
    importedNamespace: string,
    authoredNamespace: string,
  ): Promise<Result<number>>;

  /**
   * Remove one per-pair connection. When deleteDependents is true, also delete the
   * pair's dependent cross-NS relationship instances. Ref-count the derived
   * CATEGORIZEDBY edge: remove it only when the imported namespace has zero remaining
   * per-pair connections to ANY authored namespace resolving to the same metamodel.
   */
  disconnect(
    importedNamespace: string,
    authoredNamespace: string,
    deleteDependents: boolean,
  ): Promise<Result<DisconnectResult>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConnectionService(
  dbModule: IDbModule,
  logger?: ImportLogger,
) {
  // NOTE: `connect`, `countDependents`, and `disconnect` are stubbed here and will
  // be implemented in later tasks (2.2, 2.5, 2.7). The existing `wireConnection` /
  // `wireAllConnections` logic is retained as the basis those tasks build on. The
  // factory return type is left inferred (rather than pinned to `IConnectionService`)
  // so the retained `wireAllConnections` helper stays reachable by its current callers
  // until the auto-wiring call sites are removed in a later task; the returned object
  // still structurally satisfies `IConnectionService`.
  const service = {
    async connect(
      sourceNamespace: string,
      targetNamespace: string,
    ): Promise<Result<ConnectionEntry>> {
      const DIRECTION_ERROR =
        'a connection is only allowed from an Imported_Namespace to an Analysis_Namespace';

      // 1. Validate both namespaces exist and read their roles.
      const sourceRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $name})
         RETURN ns.namespace_role AS role`,
        { name: sourceNamespace },
      );
      if (sourceRows.length === 0) {
        return { ok: false, error: `Namespace '${sourceNamespace}' not found` };
      }
      const sourceRole = String(sourceRows[0].role ?? '');

      const targetRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $name})
         RETURN ns.namespace_role AS role`,
        { name: targetNamespace },
      );
      if (targetRows.length === 0) {
        return { ok: false, error: `Namespace '${targetNamespace}' not found` };
      }
      const targetRole = String(targetRows[0].role ?? '');

      // 2. Reject same-role pairs and the reversed (authored → imported) direction.
      //    The only allowed direction is source=imported → target=authored.
      if (sourceRole === targetRole) {
        return { ok: false, error: DIRECTION_ERROR };
      }
      if (sourceRole !== 'imported' || targetRole !== 'authored') {
        return { ok: false, error: DIRECTION_ERROR };
      }

      const importedNamespace = sourceNamespace;
      const authoredNamespace = targetNamespace;

      // 3. Resolve the authored namespace's metamodel via RIA_META_DEFINEDBY.
      //    Fall back to the namespace's own metamodel property if the DEFINEDBY
      //    edge is missing (e.g. stale snapshot restored before the edge exists).
      const mmRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $authoredNamespace})
         OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
         RETURN coalesce(mm.name, ns.metamodel) AS metamodelName`,
        { authoredNamespace },
      );
      if (mmRows.length === 0 || !mmRows[0].metamodelName) {
        return {
          ok: false,
          error: `No metamodel found for authored namespace '${authoredNamespace}'`,
        };
      }
      const authoredMetamodel = String(mmRows[0].metamodelName);

      // 4. MERGE the per-pair RIA_UNIV_NamespaceConnection edge (imported → authored).
      //    Detect pre-existence (count-then-create) to report alreadyConnected so a
      //    repeated connect is an idempotent success (Req 3.3).
      const pairRows = await dbModule.runQuery(
        `MATCH (i:RIA_UNIV_Namespace {name: $imported})-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace {name: $authored})
         RETURN count(*) AS cnt`,
        { imported: importedNamespace, authored: authoredNamespace },
      );
      const alreadyConnected = Number(pairRows[0]?.cnt ?? 0) > 0;

      if (!alreadyConnected) {
        await dbModule.runQuery(
          `MATCH (i:RIA_UNIV_Namespace), (a:RIA_UNIV_Namespace)
           WHERE i.name = '${esc(importedNamespace)}' AND a.name = '${esc(authoredNamespace)}'
           CREATE (i)-[:RIA_UNIV_NamespaceConnection]->(a)`,
        );
      }

      // 5. Ensure the derived RIA_META_CATEGORIZEDBY(imported → metamodel) edge
      //    idempotently. It is a function of the per-pair edges and keeps vocabulary
      //    resolution (DEFINEDBY|CATEGORIZEDBY lookups) working unchanged.
      const catRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $importedNs})-[:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel {name: $metamodel})
         RETURN count(*) AS cnt`,
        { importedNs: importedNamespace, metamodel: authoredMetamodel },
      );
      const hasCategorizedBy = Number(catRows[0]?.cnt ?? 0) > 0;

      if (!hasCategorizedBy) {
        await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace), (mm:RIA_META_Metamodel)
           WHERE ns.name = '${esc(importedNamespace)}' AND mm.name = '${esc(authoredMetamodel)}'
           CREATE (ns)-[:RIA_META_CATEGORIZEDBY]->(mm)`,
        );
      }

      return {
        ok: true,
        data: {
          importedNamespace,
          authoredNamespace,
          authoredMetamodel,
          alreadyConnected,
        },
      };
    },

    async countDependents(
      importedNamespace: string,
      authoredNamespace: string,
    ): Promise<Result<number>> {
      // Count Cross_Namespace_Relationship instances whose (source_namespace,
      // target_namespace) equals the unordered pair {imported, authored}. Either
      // ordering is counted because cross-NS instances may be stored with the
      // authored namespace as source (e.g. occurs_at) or the imported as source
      // depending on the relationship type.
      const rows = await dbModule.runQuery(
        `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
         WHERE (cri.source_namespace = $imported AND cri.target_namespace = $authored)
            OR (cri.source_namespace = $authored AND cri.target_namespace = $imported)
         RETURN count(*) AS cnt`,
        { imported: importedNamespace, authored: authoredNamespace },
      );
      const count = Number(rows[0]?.cnt ?? 0);
      return { ok: true, data: count };
    },

    async disconnect(
      importedNamespace: string,
      authoredNamespace: string,
      deleteDependents: boolean,
    ): Promise<Result<DisconnectResult>> {
      // 1. Verify the per-pair edge exists (imported → authored). Absent → error.
      const pairRows = await dbModule.runQuery(
        `MATCH (i:RIA_UNIV_Namespace {name: $imported})-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace {name: $authored})
         RETURN count(*) AS cnt`,
        { imported: importedNamespace, authored: authoredNamespace },
      );
      if (Number(pairRows[0]?.cnt ?? 0) === 0) {
        return {
          ok: false,
          error: `connection not found between '${importedNamespace}' and '${authoredNamespace}'`,
        };
      }

      // 2. Resolve the authored namespace's metamodel M (via RIA_META_DEFINEDBY,
      //    fallback to ns.metamodel for stale snapshots) so we can ref-count the
      //    derived CATEGORIZEDBY edge after removing the per-pair edge.
      const mmRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $authoredNamespace})
         OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
         RETURN coalesce(mm.name, ns.metamodel) AS metamodelName`,
        { authoredNamespace },
      );
      const authoredMetamodel = mmRows.length > 0 ? mmRows[0].metamodelName : null;

      // 3. When requested, delete the pair's dependent cross-NS relationship data:
      //    the RIA_UNIV_CrossNSRelationshipInstance nodes AND their backing
      //    RIA_UNIV_CROSSNS_INSTANCE_REL graph edges, matched on the unordered pair
      //    {imported, authored} (either ordering — mirrors countDependents).
      let deletedDependentCount = 0;
      if (deleteDependents) {
        const depRows = await dbModule.runQuery(
          `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
           WHERE (cri.source_namespace = $imported AND cri.target_namespace = $authored)
              OR (cri.source_namespace = $authored AND cri.target_namespace = $imported)
           RETURN count(*) AS cnt`,
          { imported: importedNamespace, authored: authoredNamespace },
        );
        deletedDependentCount = Number(depRows[0]?.cnt ?? 0);

        // Delete the backing CROSSNS_INSTANCE_REL edges between concept instances
        // living in the two namespaces (either direction).
        await dbModule.runQuery(
          `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
           WHERE (src.namespace = $imported AND tgt.namespace = $authored)
              OR (src.namespace = $authored AND tgt.namespace = $imported)
           DELETE r`,
          { imported: importedNamespace, authored: authoredNamespace },
        );

        // Delete the cross-NS relationship instance nodes for the pair.
        await dbModule.runQuery(
          `MATCH (cri:RIA_UNIV_CrossNSRelationshipInstance)
           WHERE (cri.source_namespace = $imported AND cri.target_namespace = $authored)
              OR (cri.source_namespace = $authored AND cri.target_namespace = $imported)
           DELETE cri`,
          { imported: importedNamespace, authored: authoredNamespace },
        );
      }

      // 4. Delete the per-pair connection edge.
      await dbModule.runQuery(
        `MATCH (i:RIA_UNIV_Namespace {name: $imported})-[r:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace {name: $authored})
         DELETE r`,
        { imported: importedNamespace, authored: authoredNamespace },
      );

      // 5. Ref-count the derived RIA_META_CATEGORIZEDBY(imported → M) edge: remove it
      //    only when the imported namespace has zero remaining per-pair edges to ANY
      //    authored namespace resolving to the same metamodel M.
      let removedCategorizedBy = false;
      if (authoredMetamodel) {
        const remainingRows = await dbModule.runQuery(
          `MATCH (i:RIA_UNIV_Namespace {name: $imported})-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace)
           OPTIONAL MATCH (a)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
           WITH coalesce(mm.name, a.metamodel) AS mmName
           WHERE mmName = $metamodel
           RETURN count(*) AS cnt`,
          { imported: importedNamespace, metamodel: authoredMetamodel },
        );
        const remaining = Number(remainingRows[0]?.cnt ?? 0);

        if (remaining === 0) {
          const catRows = await dbModule.runQuery(
            `MATCH (ns:RIA_UNIV_Namespace {name: $imported})-[:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel {name: $metamodel})
             RETURN count(*) AS cnt`,
            { imported: importedNamespace, metamodel: String(authoredMetamodel) },
          );
          if (Number(catRows[0]?.cnt ?? 0) > 0) {
            await dbModule.runQuery(
              `MATCH (ns:RIA_UNIV_Namespace)-[r:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel)
               WHERE ns.name = '${esc(importedNamespace)}' AND mm.name = '${esc(String(authoredMetamodel))}'
               DELETE r`,
            );
            removedCategorizedBy = true;
          }
        }
      }

      return {
        ok: true,
        data: {
          importedNamespace,
          authoredNamespace,
          deletedDependentCount,
          removedCategorizedBy,
        },
      };
    },

    async wireConnection(
      importedNamespace: string,
      authoredNamespace: string,
    ): Promise<Result<ConnectionEntry>> {
      // 1. Validate both namespaces exist
      const importedRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $name}) RETURN ns.name AS name`,
        { name: importedNamespace },
      );
      if (importedRows.length === 0) {
        return { ok: false, error: `Namespace '${importedNamespace}' not found` };
      }

      const authoredRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $name}) RETURN ns.name AS name`,
        { name: authoredNamespace },
      );
      if (authoredRows.length === 0) {
        return { ok: false, error: `Namespace '${authoredNamespace}' not found` };
      }

      // 2. Lookup authored namespace's metamodel via RIA_META_DEFINEDBY.
      //    Fall back to the namespace's own metamodel property if the DEFINEDBY
      //    edge is missing (e.g. stale snapshot — the post-load wiring step runs
      //    before the edge is restored, so we must be able to derive it from the
      //    namespace node itself).
      const mmRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $authoredNamespace})
         OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
         RETURN coalesce(mm.name, ns.metamodel) AS metamodelName`,
        { authoredNamespace },
      );
      if (mmRows.length === 0 || !mmRows[0].metamodelName) {
        return {
          ok: false,
          error: `No metamodel found for authored namespace '${authoredNamespace}'`,
        };
      }
      const authoredMetamodel = String(mmRows[0].metamodelName);

      // 3. Attach authored metamodel as RIA_META_CATEGORIZEDBY to imported namespace (idempotent).
      //    This is the sole connection signal: createCrossNsRelationship checks for this edge
      //    to confirm the two namespaces are wired before allowing cross-namespace links.
      const catRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $importedNs})-[:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel {name: $metamodel})
         RETURN count(*) AS cnt`,
        { importedNs: importedNamespace, metamodel: authoredMetamodel },
      );
      const alreadyConnected = Number(catRows[0]?.cnt ?? 0) > 0;

      if (!alreadyConnected) {
        await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace), (mm:RIA_META_Metamodel)
           WHERE ns.name = '${esc(importedNamespace)}' AND mm.name = '${esc(authoredMetamodel)}'
           CREATE (ns)-[:RIA_META_CATEGORIZEDBY]->(mm)`,
        );
      }

      return {
        ok: true,
        data: {
          importedNamespace,
          authoredNamespace,
          authoredMetamodel,
          alreadyConnected,
        },
      };
    },

    async wireAllConnections(
      namespaceName: string,
      namespaceRole: 'imported' | 'authored',
    ): Promise<Result<WiringResult>> {
      // 1. Query all namespaces with the opposite role
      const oppositeRole = namespaceRole === 'imported' ? 'authored' : 'imported';
      const oppositeNamespaces = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace)
         WHERE ns.namespace_role = $role
         RETURN ns.name AS name`,
        { role: oppositeRole },
      );

      const connections: ConnectionEntry[] = [];
      const errors: string[] = [];

      // 2. For each opposite namespace, wire the connection
      for (const ns of oppositeNamespaces) {
        const nsName = String(ns.name ?? '');
        const imported = namespaceRole === 'imported' ? namespaceName : nsName;
        const authored = namespaceRole === 'authored' ? namespaceName : nsName;

        const result = await this.wireConnection(imported, authored);
        if (result.ok) {
          connections.push(result.data);
        } else {
          errors.push(result.error);
          logger?.error(`Auto-wiring failed for ${imported} ↔ ${authored}`, {
            importedNamespace: imported,
            authoredNamespace: authored,
            error: result.error,
          });
        }
      }

      return { ok: true, data: { connections, errors } };
    },
  };

  return service;
}
