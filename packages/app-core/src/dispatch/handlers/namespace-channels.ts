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
import type { NamespaceInfo, SearchResultNode, NamespaceCrossNsConnectionInfo } from '@riacore/app-contracts';
import type { TreeReferenceNode } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { resolveAncestorPath } from '../utils/ancestor-path.js';
import { e } from '../utils/cypher.js';
import { extractNodeName } from '../utils/node-name.js';
import { deleteNamespace } from '../../persistor/persistor-helpers.js';

/**
 * Compute a relevance score for a search hit. Lower is better.
 *
 * Search matches are found with a case-insensitive CONTAINS over the whole
 * serialised `attributes` blob, which produces many incidental hits: long
 * concatenated identifiers that merely embed the query as a substring, and
 * elements that mention the query only in a secondary field (refines,
 * description, etc.). Without ranking these incidental hits can appear ahead
 * of an exact name match, which is what surfaces the "exact match shown last"
 * problem.
 *
 * Ranking tiers, applied against the element's display name:
 *   0  name equals the query exactly
 *   1  name starts with the query (prefix match)
 *   2  query appears at a token boundary inside the name (e.g. after `_`)
 *   3  query appears mid-token inside the name
 *   4  name does not contain the query (matched only in other attributes)
 *
 * Ties are broken by earlier match position, then shorter name length, so a
 * concise exact-ish identifier beats a long concatenated one.
 */
export function searchRelevanceScore(name: string, queryLower: string): number {
  if (!name) return 5_000_000_000; // matched only in non-name attributes
  const lowerName = name.toLowerCase();
  const idx = lowerName.indexOf(queryLower);
  let tier: number;
  if (lowerName === queryLower) {
    tier = 0;
  } else if (idx === 0) {
    tier = 1;
  } else if (idx > 0 && !/[a-z0-9]/.test(lowerName[idx - 1] ?? '')) {
    tier = 2;
  } else if (idx > 0) {
    tier = 3;
  } else {
    tier = 4;
  }
  const matchIdx = idx < 0 ? 9999 : Math.min(idx, 9999);
  const len = Math.min(lowerName.length, 9999);
  return tier * 100_000_000 + matchIdx * 10_000 + len;
}

/** A tree sibling's stable ordering fields. */
interface TreeChildSortKey {
  concept: string;
  name: string;
  node_id: number;
  /**
   * Source-document line number, present only on Sphinx-Needs elements (from
   * `needs.json`). When set, it drives document-position ordering; other
   * importers omit it and keep concept-then-name ordering.
   */
  lineno?: number;
}

/**
 * Read a numeric `lineno` from a ConceptInstance's attributes, if present.
 * Sphinx-Needs stores it as a number, but tolerate a numeric string too. Returns
 * `undefined` for any concept/importer that does not carry a usable line number.
 */
export function readLineno(attrs: Record<string, unknown>): number | undefined {
  const raw = attrs.lineno;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/**
 * Order tree siblings. Sphinx-Needs elements carry a source `lineno`, so when
 * both siblings expose one they are ordered by document position — matching how
 * the requirements appear in the `.rst`/`needs.json` source. Everything else
 * keeps the universal policy: elements of the same metamodel concept together,
 * then display names alphabetically, with node IDs as a deterministic final
 * tie-breaker. Because only Sphinx-Needs populates `lineno`, other importers
 * (SysML-v2 JSON and textual, ARXML, …) are unaffected.
 */
export function compareTreeChildrenByConceptThenName<T extends TreeChildSortKey>(a: T, b: T): number {
  if (a.lineno !== undefined && b.lineno !== undefined && a.lineno !== b.lineno) {
    return a.lineno - b.lineno;
  }

  const conceptComparison = a.concept.localeCompare(b.concept);
  if (conceptComparison !== 0) return conceptComparison;

  const nameComparison = a.name.localeCompare(b.name);
  if (nameComparison !== 0) return nameComparison;

  return a.node_id - b.node_id;
}

/** Apply the tree's offset/limit contract after ordering the complete sibling set. */
function paginateTreeChildren<T>(children: readonly T[], offset: number, limit?: number): T[] {
  return limit === undefined
    ? children.slice(offset)
    : children.slice(offset, offset + limit);
}

/**
 * Register namespace channels: list, createAuthored, getChildren.
 * All require an open workspace.
 *
 * TODO(multi-profile): This file currently mixes generic namespace channel logic
 * with safety-profile-specific domain knowledge. Examples:
 *
 *   - `getChildren`: hard-codes `occurs_at` as the relationship that determines
 *     `hasChildren` for structural nodes, and hard-codes `['occurs_at', 'has_notes',
 *     'has_tag']` as the cross-namespace reference relationships to return.
 *
 *   - `namespaces.search`: hard-codes concept name mappings (`malfunction`,
 *     `safety_task`, `safety_requirement`, `safety_note`, `review_item`) to derive
 *     `nodeType`, and hard-codes the intra-namespace parent relationship map
 *     (`has_safety_tasks`, `has_safety_requirements`, etc.) for ancestor path
 *     resolution.
 *
 * This is intentional while the safety profile is the only profile. When adding
 * new profiles, this domain logic should be extracted into profile-specific
 * handlers or a metamodel-driven configuration layer so that each profile can
 * declare its own cross-namespace relationships, concept-to-nodeType mappings,
 * and ancestor resolution strategies without modifying this generic channel.
 */
export function registerNamespaceChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── namespaces.list ──────────────────────────────────────────────────────────
  // Returns all user-visible namespaces. Namespaces with role
  // 'supervised_update_temp' are excluded because they are internal
  // transient artefacts of the supervised-update workflow and should
  // never be presented directly to the user.
  registry.register('namespaces.list', async (_payload, deps, _ctx) => {
    const rows = await deps.dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace)
       WHERE ns.namespace_role <> 'supervised_update_temp'
          OR ns.namespace_role IS NULL
       OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
       RETURN ns.name AS name,
              ns.namespace_role AS role,
              ns.namespace_owning_application AS owningApplication,
              coalesce(mm.name, ns.metamodel) AS metamodel
       ORDER BY ns.name`,
    );

    return rows.map((row): NamespaceInfo => ({
      namespaceId: String(row.name ?? ''),
      name: String(row.name ?? ''),
      role: String(row.role ?? 'imported') === 'authored' ? 'authored' : 'imported',
      owningApplication: String(row.owningApplication ?? ''),
      metamodel: String(row.metamodel ?? ''),
    }));
  }, {
    requiresWorkspace: true,
    category: 'namespaces',
  });

  // ── namespaces.createAuthored ────────────────────────────────────────────────
  registry.register('namespaces.createAuthored', async (payload, deps, _ctx) => {
    if (!deps.namespaceService) throw new Error('Namespace service not configured');
    const params = payload ?? {};
    const wsResult = await deps.workspaceService.open({ workingDir: params.workingDir });
    if (!wsResult.ok) throw new Error(wsResult.error);
    const result = await deps.namespaceService.createAuthoredNamespace(params);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, {
    requiresWorkspace: true,
    category: 'namespaces',
  });


  // ── namespaces.getChildren ───────────────────────────────────────────────────
  registry.register('namespaces.getChildren', async (payload, deps, ctx) => {
    const { namespace, parentNodeId, offset, limit, showAll, scopeNamespace } = payload;
    // When browsing an imported structural namespace in the context of a specific
    // authored analysis, `scopeNamespace` is that analysis. Cross-namespace
    // authored artifacts (occurs_at malfunctions, notes, tags) are then filtered
    // to that analysis so a shared imported element does not leak malfunctions
    // from a *different* analysis (e.g. a monitoring analysis vs a design one).
    const scope = typeof scopeNamespace === 'string' && scopeNamespace.length > 0 ? scopeNamespace : undefined;

    // Verify namespace exists and get its metamodel
    const nsRows = await deps.dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) RETURN ns.metamodel AS metamodel`,
      { namespace },
    );
    if (nsRows.length === 0) throw new Error(`Namespace '${namespace}' not found`);

    const metamodel = String(nsRows[0]?.metamodel ?? '');

    // Resolve containment rels via cached lookup (avoids repeated DB queries)
    const containmentRels = await ctx.getContainmentRels(deps.dbModule, metamodel);

    // Resolve the hidden-concept set for visibility filtering. When `showAll` is
    // falsy and the set is non-empty, hidden concepts are excluded from both the
    // data rows and the counts so that `hasChildren`, `totalCount`, and `hasMore`
    // are computed over exactly the visible set (Req 5.1–5.3). When `showAll` is
    // truthy, no exclusion is applied and queries stay exactly as before (Req 5.2).
    const hiddenConcepts = await ctx.getHiddenConcepts(deps.dbModule, metamodel);
    const applyHiddenFilter = !showAll && hiddenConcepts.size > 0;
    const hiddenList = [...hiddenConcepts].map(c => `'${e(c)}'`).join(', ');
    // Exclusion fragment for a ConceptInstance bound as `ci` (flat + root branches).
    const ciHiddenClause = applyHiddenFilter ? ` AND NOT ci.concept IN [${hiddenList}]` : '';

    const effectiveOffset = (typeof offset === 'number' && offset >= 0) ? Math.floor(offset) : 0;
    const effectiveLimit = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : undefined;

    // Flat namespace (no containment rels): all nodes are roots, no node has children
    const isFlatNamespace = containmentRels.length === 0;

    if (isFlatNamespace) {
      // Requesting children of a specific node in a flat namespace → always empty
      if (parentNodeId !== undefined) {
        return { children: [], references: [], totalCount: 0, offset: effectiveOffset, hasMore: false };
      }
      // Requesting roots → all concept instances in the namespace
      const flatWhere = `ci.namespace = $namespace${ciHiddenClause}`;
      const flatCountQuery = `MATCH (ci:RIA_UNIV_ConceptInstance)
                 WHERE ${flatWhere}
                 RETURN count(DISTINCT ci) AS cnt`;
      const flatDataQuery = `MATCH (ci:RIA_UNIV_ConceptInstance)
                 WHERE ${flatWhere}
                 WITH DISTINCT ci
                 RETURN ci.node_id AS node_id, ci.concept AS concept, ci.attributes AS attributes`;
      const [flatCountRows, flatRows] = await Promise.all([
        deps.dbModule.runQuery(flatCountQuery, { namespace }),
        deps.dbModule.runQuery(flatDataQuery, { namespace }),
      ]);
      const flatTotal = Number(flatCountRows[0]?.cnt ?? 0);
      const flatChildren = flatRows.map((row) => {
        const attrs = JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>;
        const concept = String(row.concept);
        const asil = concept === 'malfunction' ? String(attrs.malfunction_asil ?? '') : '';
        return {
          node_id: Number(row.node_id),
          concept,
          name: extractNodeName(attrs, concept),
          lineno: readLineno(attrs),
          hasChildren: false,
          asil,
        };
      });
      flatChildren.sort(compareTreeChildrenByConceptThenName);
      const pagedFlatChildren = paginateTreeChildren(flatChildren, effectiveOffset, effectiveLimit);
      const flatHasMore = (effectiveOffset + pagedFlatChildren.length) < flatTotal;
      return {
        children: pagedFlatChildren,
        references: [],
        totalCount: flatTotal,
        offset: effectiveOffset,
        hasMore: flatHasMore,
      };
    }

    const relFilter = containmentRels.map(r => `'${e(r)}'`).join(', ');

    // Resolve the rows for this level + the total count.
    // Containment child ids are resolved via the RIA_UNIV_RelationshipInstance
    // node table and node data is fetched by id.
    // The root branch pins on the *child* (`NOT EXISTS { ...->(ci) }`),
    // which uses the backward direction and is safe.
    let rows: Record<string, unknown>[];
    let totalCount: number;

    if (parentNodeId === undefined) {
      const whereClause = `ci.namespace = $namespace
                 AND NOT EXISTS {
                   MATCH (parent:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(ci)
                   WHERE r.relationship IN [${relFilter}]
                 }${ciHiddenClause}`;

      const countQuery = `MATCH (ci:RIA_UNIV_ConceptInstance)
                 WHERE ${whereClause}
                 RETURN count(DISTINCT ci) AS cnt`;

      const dataQuery = `MATCH (ci:RIA_UNIV_ConceptInstance)
                 WHERE ${whereClause}
                 WITH DISTINCT ci
                 RETURN ci.node_id AS node_id, ci.concept AS concept, ci.attributes AS attributes`;
      const params = { namespace };
      const [countRows, dataRows] = await Promise.all([
        deps.dbModule.runQuery(countQuery, params),
        deps.dbModule.runQuery(dataQuery, params),
      ]);
      totalCount = Number(countRows[0]?.cnt ?? 0);
      rows = dataRows;
    } else {
      const parentRows = await deps.dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $parentNodeId}) RETURN ci.node_id`,
        { parentNodeId },
      );
      if (parentRows.length === 0) throw new Error(`Node ${parentNodeId} not found`);

      // Distinct containment child ids via RelationshipInstance.
      // When filtering, join to the target ConceptInstance so hidden child
      // concepts are excluded from the id set *before* pagination, keeping
      // totalCount and the page slice consistent with the visible set (Req 5.3).
      const childIdRows = await deps.dbModule.runQuery(
        applyHiddenFilter
          ? `MATCH (ri:RIA_UNIV_RelationshipInstance)
             WHERE ri.source_node_id = $parentNodeId AND ri.relationship IN [${relFilter}]
             MATCH (tgt:RIA_UNIV_ConceptInstance {node_id: ri.target_node_id})
             WHERE NOT tgt.concept IN [${hiddenList}]
             RETURN DISTINCT ri.target_node_id AS node_id`
          : `MATCH (ri:RIA_UNIV_RelationshipInstance)
             WHERE ri.source_node_id = $parentNodeId AND ri.relationship IN [${relFilter}]
             RETURN DISTINCT ri.target_node_id AS node_id`,
        { parentNodeId },
      );
      const childIds = childIdRows.map(r => Number(r.node_id));
      totalCount = childIds.length;

      // Fetch all sibling data before paging. Display names are extracted from
      // attributes, so sorting by concept/name must happen in application code.
      rows = childIds.length > 0
        ? await deps.dbModule.runQuery(
            `MATCH (ci:RIA_UNIV_ConceptInstance)
             WHERE ci.node_id IN $ids
             RETURN ci.node_id AS node_id, ci.concept AS concept, ci.attributes AS attributes`,
            { ids: childIds },
          )
        : [];
    }

    // Sort the entire sibling set before selecting a page. Names are stored in
    // the attributes JSON, so this cannot be expressed as a database ORDER BY.
    const sortedRows = rows.map((row) => {
      const attrs = JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>;
      const concept = String(row.concept);
      return {
        node_id: Number(row.node_id),
        concept,
        name: extractNodeName(attrs, concept),
        lineno: readLineno(attrs),
        attrs,
      };
    }).sort(compareTreeChildrenByConceptThenName);
    const pageRows = paginateTreeChildren(sortedRows, effectiveOffset, effectiveLimit);

    const children = await Promise.all(pageRows.map(async ({ node_id: nodeId, concept, name, attrs }) => {
      const asil = concept === 'malfunction' ? String(attrs.malfunction_asil ?? '') : '';
      const [childCountRows, crossNsCountRows] = await Promise.all([
        // Does this child have its own (visible) containment children?
        // When filtering, join to the grandchild ConceptInstance and exclude
        // hidden concepts so a node whose only children are hidden reports
        // hasChildren:false (Req 5.1); when showAll, any child counts (Req 5.2).
        deps.dbModule.runQuery(
          applyHiddenFilter
            ? `MATCH (ri:RIA_UNIV_RelationshipInstance)
               WHERE ri.source_node_id = $nodeId AND ri.relationship IN [${relFilter}]
               MATCH (gc:RIA_UNIV_ConceptInstance {node_id: ri.target_node_id})
               WHERE NOT gc.concept IN [${hiddenList}]
               RETURN count(DISTINCT ri.target_node_id) AS cnt`
            : `MATCH (ri:RIA_UNIV_RelationshipInstance)
               WHERE ri.source_node_id = $nodeId AND ri.relationship IN [${relFilter}]
               RETURN count(DISTINCT ri.target_node_id) AS cnt`, { nodeId },
        ),
        deps.dbModule.runQuery(
          `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance {node_id: $nodeId})
           WHERE r.relationship = 'occurs_at'${scope ? ' AND fm.namespace = $scope' : ''}
           RETURN count(fm) AS cnt`, scope ? { nodeId, scope } : { nodeId },
        ),
      ]);
      return {
        node_id: nodeId,
        concept,
        name,
        hasChildren: Number(childCountRows[0]?.cnt ?? 0) > 0 || Number(crossNsCountRows[0]?.cnt ?? 0) > 0,
        asil,
      };
    }));

    const hasMore = (effectiveOffset + children.length) < totalCount;

    // Query cross-namespace references for the parent node (only when a specific
    // parent is requested — root-level queries don't have a structural parent to
    // attach references to).
    let references: TreeReferenceNode[] = [];
    if (parentNodeId !== undefined) {
      // Query 1 (outgoing): find safety nodes that point TO parentNodeId.
      //   occurs_at:  malfunction → imported_element  → shows malfunction when expanding imported element
      //   has_notes:  imported_element → note         → shows imported element when expanding a note
      //   has_tag:    imported_element → tag          → shows imported element when expanding a tag
      // `occurs_at` rows carry the authored malfunction on the source side, so
      // scope them to the active analysis. `has_notes` / `has_tag` rows have the
      // imported element on the source side (we are expanding a note/tag to show
      // its host element), so they must not be scoped by the analysis namespace.
      const refRowsOutgoing = await deps.dbModule.runQuery(
        `MATCH (authored:RIA_UNIV_ConceptInstance)-[xr:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance {node_id: $parentNodeId})
         WHERE xr.relationship IN ['occurs_at', 'has_notes', 'has_tag']${scope ? " AND (xr.relationship <> 'occurs_at' OR authored.namespace = $scope)" : ''}
         RETURN authored.node_id AS node_id,
                authored.concept AS concept,
                authored.attributes AS attributes,
                authored.namespace AS sourceNamespace,
                xr.relationship AS relationship`,
        scope ? { parentNodeId, scope } : { parentNodeId },
      );

      // Query 2 (incoming): find nodes that parentNodeId points TO.
      //   occurs_at:  malfunction → imported_element  → shows imported element when expanding a malfunction
      //   has_notes:  imported_element → note         → shows note when expanding an imported element
      //   has_tag:    imported_element → tag          → shows tag when expanding an imported element
      // `has_notes` / `has_tag` rows carry the authored note/tag on the target
      // side, so scope them to the active analysis. `occurs_at` rows have the
      // imported element on the target side (expanding a malfunction to show its
      // host element), so they must not be scoped.
      const refRowsIncoming = await deps.dbModule.runQuery(
        `MATCH (tgt:RIA_UNIV_ConceptInstance {node_id: $parentNodeId})-[xr:RIA_UNIV_CROSSNS_INSTANCE_REL]->(ref:RIA_UNIV_ConceptInstance)
         WHERE xr.relationship IN ['occurs_at', 'has_notes', 'has_tag']${scope ? " AND (xr.relationship = 'occurs_at' OR ref.namespace = $scope)" : ''}
         RETURN ref.node_id AS node_id,
                ref.concept AS concept,
                ref.attributes AS attributes,
                ref.namespace AS sourceNamespace,
                xr.relationship AS relationship`,
        scope ? { parentNodeId, scope } : { parentNodeId },
      );

      const allRefRows = [...refRowsOutgoing, ...refRowsIncoming];
      references = allRefRows.map((row): TreeReferenceNode => {
        const attrs = JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>;
        const concept = String(row.concept);
        const asil = concept === 'malfunction' ? String(attrs.malfunction_asil ?? '') : '';
        return {
          node_id: Number(row.node_id),
          concept,
          name: extractNodeName(attrs, concept),
          sourceNamespace: String(row.sourceNamespace),
          relationship: String(row.relationship),
          asil,
        };
      }).sort(compareTreeChildrenByConceptThenName);
    }

    return { children, references, totalCount, offset: effectiveOffset, hasMore };
  }, {
    requiresWorkspace: true,
    category: 'namespaces',
  });

  // ── namespaces.getAncestorPath ───────────────────────────────────────────────
  registry.register('namespaces.getAncestorPath', async (payload, deps, _ctx) => {
    const { namespace, nodeId } = payload;

    // Look up the namespace's metamodel
    const nsRows = await deps.dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) RETURN ns.metamodel AS metamodel`,
      { namespace },
    );
    if (nsRows.length === 0) return [];

    const metamodel = String(nsRows[0]?.metamodel ?? '');
    return resolveAncestorPath(deps.dbModule, nodeId, metamodel);
  }, {
    requiresWorkspace: true,
    category: 'namespaces',
  });

  // ── namespaces.search ────────────────────────────────────────────────────────
  registry.register('namespaces.search', async (payload, deps, _ctx) => {
    const { query, offset, limit, exact } = payload;

    // Return empty result for blank/empty queries without hitting the DB
    if (!query || !query.trim()) {
      return { results: [], totalCount: 0, hasMore: false };
    }

    const queryLower = query.toLowerCase();
    const effectiveOffset = (typeof offset === 'number' && offset >= 0) ? Math.floor(offset) : 0;
    const effectiveLimit = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 50;

    let structuralRows: Record<string, unknown>[];
    let authoredRows: Record<string, unknown>[];

    try {
      // Query structural elements (imported namespaces only; exclude temp namespaces
      // so supervised-update artefacts are never surfaced in search results)
      structuralRows = await deps.dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance)
         WHERE toLower(ci.attributes) CONTAINS $queryLower
           AND NOT EXISTS {
             MATCH (ns:RIA_UNIV_Namespace {name: ci.namespace})
             WHERE ns.namespace_role = 'supervised_update_temp'
           }
         RETURN ci.node_id AS nodeId, ci.namespace AS namespace, ci.concept AS concept,
                ci.attributes AS attributes, ci.metamodel AS metamodel`,
        { queryLower },
      );
    } catch (err) {
      throw new Error(`namespaces.search: structural query failed — ${String(err)}`);
    }

    try {
      // Get authored namespaces first
      const authoredNsRows = await deps.dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.namespace_role = 'authored' RETURN ns.name AS name`,
        {},
      );
      const authoredNamespaces = authoredNsRows.map(r => String(r.name));

      if (authoredNamespaces.length > 0) {
        const nsFilter = authoredNamespaces.map(n => `'${e(n)}'`).join(', ');
        authoredRows = await deps.dbModule.runQuery(
          `MATCH (ci:RIA_UNIV_ConceptInstance)
           WHERE ci.namespace IN [${nsFilter}]
             AND toLower(ci.attributes) CONTAINS $queryLower
           RETURN ci.node_id AS nodeId, ci.namespace AS namespace, ci.concept AS concept,
                  ci.attributes AS attributes, ci.metamodel AS metamodel`,
          { queryLower },
        );
      } else {
        authoredRows = [];
      }
    } catch (err) {
      throw new Error(`namespaces.search: authored namespace query failed — ${String(err)}`);
    }

    // Union and deduplicate by nodeId
    const seen = new Set<number>();
    let combined: Record<string, unknown>[] = [];
    for (const row of [...structuralRows, ...authoredRows]) {
      const nodeId = Number(row.nodeId);
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        combined.push(row);
      }
    }

    // When --exact is set, post-filter to only include elements whose 'id'
    // attribute exactly matches the query. This eliminates false positives from
    // elements that merely reference the ID in other fields (refines, satisfies, etc.).
    if (exact) {
      combined = combined.filter((row) => {
        try {
          const attrs = JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>;
          return attrs.id === query || attrs.has_id === query || attrs.stable_path === `/need/${query}`;
        } catch {
          return false;
        }
      });
    }

    // Rank by relevance to the query so exact and prefix matches on the
    // element's display name float to the top, ahead of incidental substring
    // matches in long concatenated identifiers or matches that only occur in
    // secondary attributes. Stable sort preserves the structural-then-authored
    // order within a tier. Ranking happens before pagination so the best hits
    // land on the first page.
    const rankCache = new Map<number, number>();
    const rankOf = (row: Record<string, unknown>): number => {
      const nodeId = Number(row.nodeId);
      const cached = rankCache.get(nodeId);
      if (cached !== undefined) return cached;
      let name = '';
      try {
        const attrs = JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>;
        name = extractNodeName(attrs, String(row.concept ?? ''));
      } catch { /* leave name empty → lowest tier */ }
      const score = searchRelevanceScore(name, queryLower);
      rankCache.set(nodeId, score);
      return score;
    };
    combined.sort((a, b) => rankOf(a) - rankOf(b));

    const totalCount = combined.length;
    const page = combined.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    // Resolve ancestor paths for each result
    const results: SearchResultNode[] = await Promise.all(page.map(async (row) => {
      const nodeId = Number(row.nodeId);
      const namespace = String(row.namespace);
      const concept = String(row.concept);
      const metamodel = String(row.metamodel ?? '');
      const attrs = JSON.parse(String(row.attributes || '{}')) as Record<string, unknown>;
      const name = extractNodeName(attrs, concept);

      // Determine nodeType from concept name
      const conceptLower = concept.toLowerCase();
      let nodeType: SearchResultNode['nodeType'] = 'model';
      if (conceptLower === 'malfunction') {
        nodeType = 'malfunction';
      } else if (conceptLower === 'safety_task') {
        nodeType = 'safety-task';
      } else if (conceptLower === 'safety_requirement') {
        nodeType = 'requirement';
      } else if (conceptLower === 'safety_note') {
        nodeType = 'safety-note';
      } else if (conceptLower === 'review_item') {
        nodeType = 'review-item';
      }

      // Resolve ancestor path
      let ancestorPath: number[] = [];
      let crossNsTarget: { nodeId: number; namespace: string } | null = null;
      try {
        // Check if this node has a cross-namespace edge to a structural node
        // in a different namespace (the "attachment" edge, e.g. occurs_at).
        // We filter to targets in a different namespace to skip intra-namespace
        // edges like propagation links between authored elements.
        const crossNsRows = await deps.dbModule.runQuery(
          `MATCH (ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(target:RIA_UNIV_ConceptInstance)
           WHERE target.namespace <> ci.namespace
           RETURN target.node_id AS targetId, target.namespace AS targetNamespace, target.metamodel AS targetMetamodel
           LIMIT 1`,
          { nodeId },
        );

        if (crossNsRows.length > 0) {
          // Authored element: resolve ancestor path of the structural target
          const targetId = Number(crossNsRows[0]?.targetId);
          const targetNamespace = String(crossNsRows[0]?.targetNamespace ?? '');
          const targetMetamodel = String(crossNsRows[0]?.targetMetamodel ?? '');
          if (Number.isFinite(targetId)) {
            ancestorPath = await resolveAncestorPath(deps.dbModule, targetId, targetMetamodel);
            // Append the target itself — the ancestor path goes from root to
            // the target's parent, but the frontend needs the target in the
            // path too so it can load and expand it to reveal the authored element.
            ancestorPath.push(targetId);
            crossNsTarget = { nodeId: targetId, namespace: targetNamespace };
          }
        } else {
          // For intra-namespace authored types (safety_task, requirement, safety_note,
          // review_item) the link to the model tree goes through their parent malfunction
          // via an intra-namespace RIA_UNIV_INSTANCE_REL edge, not a CROSSNS edge.
          // Walk up to the parent malfunction and follow its CROSSNS edge to get the
          // structural anchor so the item is not incorrectly shown as "unlinked".
          const intraParentRelMap: Partial<Record<string, string>> = {
            safety_task:  'has_safety_tasks',
            requirement:  'has_safety_requirements',
            safety_note:  'has_safety_notes',
            review_item:  'has_review',
          };
          const intraRel = intraParentRelMap[concept];
          if (intraRel) {
            const parentRows = await deps.dbModule.runQuery(
              `MATCH (parent:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(ci:RIA_UNIV_ConceptInstance {node_id: $nodeId})
               WHERE r.relationship = $rel
               RETURN parent.node_id AS parentId, parent.namespace AS parentNamespace, parent.metamodel AS parentMetamodel
               LIMIT 1`,
              { nodeId, rel: intraRel },
            );
            if (parentRows.length > 0) {
              const parentId = Number(parentRows[0]?.parentId);
              const parentMetamodel = String(parentRows[0]?.parentMetamodel ?? '');
              if (Number.isFinite(parentId)) {
                // Follow the parent's CROSSNS edge to find the structural anchor
                const parentCrossNsRows = await deps.dbModule.runQuery(
                  `MATCH (parent:RIA_UNIV_ConceptInstance {node_id: $parentId})-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(target:RIA_UNIV_ConceptInstance)
                   WHERE target.namespace <> parent.namespace
                   RETURN target.node_id AS targetId, target.namespace AS targetNamespace, target.metamodel AS targetMetamodel
                   LIMIT 1`,
                  { parentId },
                );
                if (parentCrossNsRows.length > 0) {
                  const targetId = Number(parentCrossNsRows[0]?.targetId);
                  const targetNamespace = String(parentCrossNsRows[0]?.targetNamespace ?? '');
                  const targetMetamodel = String(parentCrossNsRows[0]?.targetMetamodel ?? '');
                  if (Number.isFinite(targetId)) {
                    ancestorPath = await resolveAncestorPath(deps.dbModule, targetId, targetMetamodel);
                    ancestorPath.push(targetId);
                    crossNsTarget = { nodeId: targetId, namespace: targetNamespace };
                  }
                } else {
                  // Parent malfunction has no CROSSNS edge either — walk parent's own path
                  ancestorPath = await resolveAncestorPath(deps.dbModule, parentId, parentMetamodel);
                  crossNsTarget = { nodeId: parentId, namespace: String(parentRows[0]?.parentNamespace ?? '') };
                }
              }
            } else {
              // Truly unlinked intra-namespace authored element — no parent found
              ancestorPath = [];
            }
          } else {
            // Structural node: walk containment edges upward
            ancestorPath = await resolveAncestorPath(deps.dbModule, nodeId, metamodel);
          }
        }
      } catch {
        // Orphan node — return empty path
        ancestorPath = [];
      }

      return { nodeId, namespace, concept, name, nodeType, ancestorPath, crossNsTarget };
    }));

    return { results, totalCount, hasMore: effectiveOffset + results.length < totalCount };
  }, {
    requiresWorkspace: true,
    category: 'namespaces',
  });

  // ── namespaces.previewDeleteImpact ───────────────────────────────────────────
  registry.register('namespaces.previewDeleteImpact', async (payload, deps, _ctx) => {
    const { namespace } = payload;

    // Count nodes in namespace
    const countRows = await deps.dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
       RETURN count(ci) AS cnt`,
      { namespace },
    );
    const nodeCount = Number(countRows[0]?.cnt ?? 0);

    // Determine role
    const nsRows = await deps.dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
       RETURN ns.namespace_role AS role`,
      { namespace },
    );
    const role: 'imported' | 'authored' = String(nsRows[0]?.role ?? 'imported') === 'authored' ? 'authored' : 'imported';

    // Helper to map a DB row to NamespaceCrossNsConnectionInfo
    const toConnection = (row: Record<string, unknown>): NamespaceCrossNsConnectionInfo => {
      const attrs = (() => { try { return JSON.parse(String(row.otherAttributes ?? '{}')); } catch { return {} as Record<string, unknown>; } })();
      const otherConcept = String(row.otherConcept ?? '');
      return {
        relationship: String(row.relationship ?? ''),
        otherNamespace: String(row.otherNamespace ?? ''),
        otherNodeId: Number(row.otherNodeId ?? 0),
        otherNodeName: extractNodeName(attrs, otherConcept),
        otherConcept,
      };
    };

    // Cross-NS connections where this namespace is SOURCE
    const sourceEdgeRows = await deps.dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance)-[xr:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE xr.source_namespace = $namespace
       RETURN xr.relationship AS relationship,
              tgt.namespace AS otherNamespace,
              tgt.node_id AS otherNodeId,
              tgt.concept AS otherConcept,
              tgt.attributes AS otherAttributes`,
      { namespace },
    );

    // Cross-NS connections where this namespace is TARGET
    const targetEdgeRows = await deps.dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance)-[xr:RIA_UNIV_CROSSNS_INSTANCE_REL]->(tgt:RIA_UNIV_ConceptInstance)
       WHERE xr.target_namespace = $namespace
       RETURN xr.relationship AS relationship,
              src.namespace AS otherNamespace,
              src.node_id AS otherNodeId,
              src.concept AS otherConcept,
              src.attributes AS otherAttributes`,
      { namespace },
    );

    const crossNsConnections: NamespaceCrossNsConnectionInfo[] = [
      ...sourceEdgeRows.map(toConnection),
      ...targetEdgeRows.map(toConnection),
    ];

    return { namespace, role, nodeCount, crossNsConnections };
  }, { requiresWorkspace: true, category: 'namespaces' });

  // ── namespaces.delete ────────────────────────────────────────────────────────
  registry.register('namespaces.delete', async (payload, deps, _ctx) => {
    const { namespace } = payload;
    await deleteNamespace(namespace, deps.dbModule);
  }, { requiresWorkspace: true, category: 'namespaces' });
}
