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
import type { Result, LayoutRecord, DiagramLayout, ViewLayoutSourceRef } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The canonical Layout_Record / Diagram_Layout DTOs cross the IPC boundary, so they
// are owned by `@riacore/app-contracts`. They are re-exported here so existing
// app-core call sites (services, handlers, tests) can keep importing them from
// `layout-service.js` without duplicating the definitions.
export type { LayoutRecord, DiagramLayout };

// ---------------------------------------------------------------------------
// layout_id encoder
// ---------------------------------------------------------------------------

/**
 * NUL separator used to synthesize the stable composite primary key `layout_id`.
 * `\u0000` can never appear in an identifier-like Element_Kind or Element_Key, so
 * the encoding below is injective and reversible.
 */
const LAYOUT_ID_SEPARATOR = '\u0000';

/**
 * Encode a Layout_Key `(elementKind, elementKey)` into the stable composite key
 * string `` `${elementKind}\u0000${elementKey}` ``.
 *
 * The `\u0000` separator cannot occur in either component, so this encoding is
 * injective (distinct Layout_Keys → distinct ids) and reversible (see
 * {@link decodeLayoutId}). Because `layout_id` is content-derived rather than an
 * internal `node_id`, the record is stable across every node-ID-reassigning
 * operation.
 */
export function encodeLayoutId(elementKind: string, elementKey: string): string {
  return `${elementKind}${LAYOUT_ID_SEPARATOR}${elementKey}`;
}

/**
 * Reverse {@link encodeLayoutId}: split a `layout_id` back into its
 * `(elementKind, elementKey)` Layout_Key. Returns `null` when the input is not a
 * valid encoding (no separator present).
 */
export function decodeLayoutId(
  layoutId: string,
): { elementKind: string; elementKey: string } | null {
  const idx = layoutId.indexOf(LAYOUT_ID_SEPARATOR);
  if (idx === -1) return null;
  return {
    elementKind: layoutId.slice(0, idx),
    elementKey: layoutId.slice(idx + LAYOUT_ID_SEPARATOR.length),
  };
}

// ---------------------------------------------------------------------------
// View layout keying (spec-view.md Phase 4.2)
// ---------------------------------------------------------------------------

/**
 * Element_Kind prefix for a layout record belonging to a view's content.
 *
 * The existing Element_Key for a namespace tile is the bare namespace name, so
 * a view record keyed the same way could collide with one. This prefix is what
 * keeps the two record families apart — and it is also why
 * `deleteNamespace`'s `element_key = <name>` statement does not clear view
 * layouts, which is handled by a companion statement there instead.
 */
export const VIEW_LAYOUT_KIND_PREFIX = 'view:';

/** Separator between the source namespace and the source element's `stable_path`. */
const VIEW_LAYOUT_KEY_SEPARATOR = '#';

/** The Element_Kind for records belonging to `viewName`'s content. */
export function viewLayoutElementKind(viewName: string): string {
  return `${VIEW_LAYOUT_KIND_PREFIX}${viewName}`;
}

/**
 * The Element_Key for a representative, derived from the source element it
 * stands for.
 *
 * Keyed by `stable_path` rather than by the representative's technical id
 * because a representative id is a `node_id`, which is reassigned on reimport
 * and is session-scoped by design (docs/coreSpecs/RiaViews.md — Traceability).
 * A layout keyed on it would be lost on every reimport; a `stable_path` survives.
 */
export function viewLayoutElementKey(sourceNamespace: string, stablePath: string): string {
  return `${sourceNamespace}${VIEW_LAYOUT_KEY_SEPARATOR}${stablePath}`;
}

/** Whether a stored record belongs to any view. Used to keep the two families apart. */
export function isViewLayoutKind(elementKind: string): boolean {
  return elementKind.startsWith(VIEW_LAYOUT_KIND_PREFIX);
}

/**
 * Re-exported so existing importers of this module are unaffected. The type
 * itself moved to app-contracts when the view-layout channels were added, since
 * it now crosses the IPC boundary.
 */
export type { ViewLayoutSourceRef };

// ---------------------------------------------------------------------------
// Element_Kind resolver registry
// ---------------------------------------------------------------------------

/**
 * Maps an Element_Kind to how its existing Element_Keys are enumerated. A resolver
 * returns the {@link Set} of Element_Keys that currently identify an existing
 * Canvas_Element of that kind.
 *
 * This is the single, optional extension point for reconciliation: adding a resolver
 * entry enables dangling-pruning for a kind, but is NOT part of the persisted schema,
 * IPC, or CLI contract. A kind with NO resolver is never considered dangling — its
 * records are preserved verbatim (Req 5.4, 8.3).
 */
export type ElementResolver = (db: IDbModule) => Promise<Set<string>>;

/** Collect a single string column from every row into a {@link Set}. */
async function selectNames(db: IDbModule, cypher: string): Promise<Set<string>> {
  const rows = await db.runQuery(cypher);
  return new Set(rows.map((row) => String(row.name ?? '')));
}

/**
 * Registry of the currently-resolvable Element_Kinds. Future kinds add one entry here
 * to opt into dangling-pruning; kinds absent from this map survive reconciliation
 * untouched.
 *
 * - `imported` → names of imported namespaces (`namespace_role = 'imported'`).
 * - `analysis` → names of authored/analysis namespaces (`namespace_role = 'authored'`).
 */
export const RESOLVERS: Record<string, ElementResolver> = {
  imported: (db) =>
    selectNames(
      db,
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.namespace_role = 'imported'
       RETURN ns.name AS name`,
    ),
  analysis: (db) =>
    selectNames(
      db,
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.namespace_role = 'authored'
       RETURN ns.name AS name`,
    ),
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ILayoutService {
  /** Return the current Diagram_Layout (empty array when no records exist). */
  getLayout(): Promise<Result<DiagramLayout>>;

  /**
   * Upsert one or more Layout_Records (MERGE on layout_id, SET x,y).
   * Rejects the whole batch if ANY record has a non-finite x or y (Req 1.8),
   * leaving the stored Diagram_Layout unchanged. Returns the written records.
   */
  setRecords(records: LayoutRecord[]): Promise<Result<DiagramLayout>>;

  /**
   * Load-time reconciliation: drop records of a RESOLVABLE Element_Kind whose
   * Element_Key no longer identifies an existing Canvas_Element, and report them.
   * Records of an unregistered (unknown) Element_Kind are never pruned.
   */
  reconcile(): Promise<Result<{ layout: DiagramLayout; skipped: LayoutRecord[] }>>;

  /**
   * Every stored position belonging to `viewName`'s content, returned keyed by
   * the source element's `node_id` rather than by `stable_path` — because
   * `node_id` is what an evaluation result carries, and the caller would
   * otherwise have to redo the resolution this method just did.
   *
   * A representative whose source element no longer exists yields no entry, so
   * it is auto-laid-out. Records are NOT pruned here: a source may be
   * temporarily absent mid-reimport, and discarding a position on a read would
   * make the layout lossy in exactly the case Phase 4.2 exists to survive.
   */
  getViewLayout(viewName: string, sources: ViewLayoutSourceRef[]): Promise<Result<Map<number, { x: number; y: number }>>>;

  /**
   * Persist positions for a view's representatives, keyed by the `stable_path`
   * of each one's source element. A representative with no source reference
   * gets no record and is auto-laid-out; one with several uses its first, which
   * is deterministic because catalog queries return sources in a fixed order.
   */
  setViewLayout(
    viewName: string,
    records: Array<{ source: ViewLayoutSourceRef; x: number; y: number }>,
  ): Promise<Result<DiagramLayout>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLayoutService(
  dbModule: IDbModule,
  logger?: ImportLogger,
): ILayoutService {
  void logger;

  /**
   * Read every persisted Layout_Record back as a {@link DiagramLayout}. Used by
   * `setRecords` to return the current layout without depending on the (still stubbed)
   * `getLayout`. Ordered by `layout_id` for a stable, deterministic result.
   */
  async function readLayout(): Promise<DiagramLayout> {
    const rows = await dbModule.runQuery(
      `MATCH (l:RIA_UNIV_CanvasLayout)
       RETURN l.element_kind AS element_kind, l.element_key AS element_key,
              l.x AS x, l.y AS y
       ORDER BY l.layout_id`,
    );
    return rows.map((row) => ({
      elementKind: String(row.element_kind ?? ''),
      elementKey: String(row.element_key ?? ''),
      x: Number(row.x),
      y: Number(row.y),
    }));
  }

  /**
   * Resolve `node_id -> stable_path` for the given source elements in ONE
   * bounded query, whichever namespaces they span.
   *
   * `stable_path` lives inside the opaque `attributes` JSON column rather than
   * as a column of its own, so it is parsed here rather than projected. A node
   * that does not exist, or whose attributes carry no `stable_path`, is simply
   * absent from the result — the caller treats that as "no persisted position".
   */
  async function resolveStablePaths(sources: ViewLayoutSourceRef[]): Promise<Map<number, string>> {
    const resolved = new Map<number, string>();
    const nodeIds = [...new Set(sources.map((s) => s.nodeId))].filter((id) => Number.isFinite(id));
    if (nodeIds.length === 0) return resolved;

    const rows = await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.node_id IN $ids
       RETURN ci.node_id AS node_id, ci.attributes AS attributes`,
      { ids: nodeIds },
    );
    for (const row of rows) {
      try {
        const attrs = JSON.parse(String(row.attributes ?? '{}')) as Record<string, unknown>;
        if (typeof attrs.stable_path === 'string' && attrs.stable_path.length > 0) {
          resolved.set(Number(row.node_id), attrs.stable_path);
        }
      } catch { /* a node with unparseable attributes simply has no persisted position */ }
    }
    return resolved;
  }

  const service: ILayoutService = {
    async getLayout(): Promise<Result<DiagramLayout>> {
      // Return the complete current Diagram_Layout (empty array when no records
      // exist — readLayout naturally yields []). On any retrieval failure return an
      // Error and no partial layout (Req 2.6).
      try {
        return { ok: true, data: await readLayout() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async setRecords(records: LayoutRecord[]): Promise<Result<DiagramLayout>> {
      // 1. Validate every record up front so the batch is all-or-nothing: if any
      //    coordinate is non-finite, perform NO writes and leave the stored layout
      //    unchanged (Req 1.8).
      for (const r of records) {
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) {
          return {
            ok: false,
            error: `invalid coordinate for ${r.elementKind}/${r.elementKey}: x=${r.x}, y=${r.y}`,
          };
        }
      }

      try {
        // 2. Upsert each record: MERGE on the stable composite layout_id, then SET the
        //    kind/key/x/y. MERGE+SET makes the write an idempotent upsert so the newest
        //    coordinate wins and at most one row exists per Layout_Key (Req 1.1-1.3, 8.4).
        for (const r of records) {
          const layoutId = encodeLayoutId(r.elementKind, r.elementKey);
          // Use parameterized placeholders for every value. This avoids interpolating
          // numbers into Cypher, where a finite double outside the fixed-notation range
          // (e.g. 1e+21) would stringify to scientific notation the parser rejects — so
          // every finite coordinate is stored exactly (Req 1.8).
          await dbModule.runQuery(
            `MERGE (l:RIA_UNIV_CanvasLayout {layout_id: $layout_id})
             SET l.element_kind = $element_kind,
                 l.element_key  = $element_key,
                 l.x = $x, l.y = $y`,
            {
              layout_id: layoutId,
              element_kind: r.elementKind,
              element_key: r.elementKey,
              x: r.x,
              y: r.y,
            },
          );
        }

        // 3. Return the current (post-write) layout.
        return { ok: true, data: await readLayout() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async reconcile(): Promise<
      Result<{ layout: DiagramLayout; skipped: LayoutRecord[] }>
    > {
      // The bespoke persistor load step has already restored every persisted
      // Layout_Record verbatim. Here we prune ONLY records of a resolvable Element_Kind
      // whose Element_Key no longer identifies an existing Canvas_Element (Req 5.6);
      // records of an unknown/unresolved kind are never pruned (Req 5.4, 8.3).
      try {
        const layout = await readLayout();

        // Resolve the set of existing Element_Keys once per distinct resolvable kind
        // that actually appears in the stored layout (avoids redundant queries).
        const existingByKind = new Map<string, Set<string>>();
        for (const kind of new Set(layout.map((r) => r.elementKind))) {
          const resolver = RESOLVERS[kind];
          if (resolver) existingByKind.set(kind, await resolver(dbModule));
        }

        // Determine which records are dangling: only records of a resolvable kind whose
        // Element_Key is absent from that kind's existing set.
        const skipped: LayoutRecord[] = [];
        for (const record of layout) {
          const existing = existingByKind.get(record.elementKind);
          if (existing && !existing.has(record.elementKey)) {
            skipped.push(record);
          }
        }

        // Prune each dangling record by its stable composite layout_id.
        for (const record of skipped) {
          const layoutId = encodeLayoutId(record.elementKind, record.elementKey);
          await dbModule.runQuery(
            `MATCH (l:RIA_UNIV_CanvasLayout {layout_id: $layout_id})
             DELETE l`,
            { layout_id: layoutId },
          );
        }

        // Return the post-prune layout plus the list of pruned (skipped) records so the
        // caller can surface a warning naming each one (Req 5.6).
        return { ok: true, data: { layout: await readLayout(), skipped } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async getViewLayout(
      viewName: string,
      sources: ViewLayoutSourceRef[],
    ): Promise<Result<Map<number, { x: number; y: number }>>> {
      try {
        const byNodeId = new Map<number, { x: number; y: number }>();
        if (sources.length === 0) return { ok: true, data: byNodeId };

        const elementKind = viewLayoutElementKind(viewName);
        const stablePaths = await resolveStablePaths(sources);
        if (stablePaths.size === 0) return { ok: true, data: byNodeId };

        // Read only this view's records. Every other Element_Kind — namespace
        // tiles, other views — is untouched and invisible here.
        const rows = await dbModule.runQuery(
          `MATCH (l:RIA_UNIV_CanvasLayout) WHERE l.element_kind = $element_kind
           RETURN l.element_key AS element_key, l.x AS x, l.y AS y`,
          { element_kind: elementKind },
        );
        const positionByKey = new Map<string, { x: number; y: number }>();
        for (const row of rows) {
          positionByKey.set(String(row.element_key ?? ''), { x: Number(row.x), y: Number(row.y) });
        }

        for (const source of sources) {
          const stablePath = stablePaths.get(source.nodeId);
          if (stablePath === undefined) continue;
          const position = positionByKey.get(viewLayoutElementKey(source.namespace, stablePath));
          if (position !== undefined) byNodeId.set(source.nodeId, position);
        }
        return { ok: true, data: byNodeId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async setViewLayout(
      viewName: string,
      records: Array<{ source: ViewLayoutSourceRef; x: number; y: number }>,
    ): Promise<Result<DiagramLayout>> {
      try {
        const elementKind = viewLayoutElementKind(viewName);
        const stablePaths = await resolveStablePaths(records.map((r) => r.source));

        // A source that cannot be resolved to a stable_path is skipped rather
        // than keyed on something unstable: a record we could not key correctly
        // would silently resurface on the wrong element after a reimport, which
        // is worse than not persisting the position at all.
        const layoutRecords: LayoutRecord[] = [];
        for (const record of records) {
          const stablePath = stablePaths.get(record.source.nodeId);
          if (stablePath === undefined) continue;
          layoutRecords.push({
            elementKind,
            elementKey: viewLayoutElementKey(record.source.namespace, stablePath),
            x: record.x,
            y: record.y,
          });
        }
        // Reuse setRecords so the all-or-nothing coordinate validation and the
        // MERGE-on-layout_id upsert are shared rather than reimplemented.
        return await service.setRecords(layoutRecords);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return service;
}
