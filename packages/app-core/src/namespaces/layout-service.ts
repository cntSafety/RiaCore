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
import type { Result, LayoutRecord, DiagramLayout } from '@riacore/app-contracts';
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
  };

  return service;
}
