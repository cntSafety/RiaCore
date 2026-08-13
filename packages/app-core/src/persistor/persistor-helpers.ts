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
 * Persistor internal helpers — shared utility functions used by store, load, and repair.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IDbModule, DbTransaction } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import { parseTable } from './serializer.js';
import { CANONICAL_REL_TABLES, CANONICAL_NODE_TABLES } from '../db/schema.js';
import { getTableByName, getTablesByLayer, type TableDef } from './table-registry.js';
import { serializeTable, serializeRecord } from './serializer.js';
import { sortCrossNsRelationshipInstances, sortCrossNsInstanceRelEdges } from './persistor-sort.js';
import type { LoadProgressEvent, OnLoadProgress, NodeKeyAttrMap, EdgeKeyAttrMap } from './persistor-types.js';
import { LOAD_BATCH_SIZE } from './persistor-types.js';

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Write `content` to `filePath` atomically: write to `${filePath}.tmp-<rand>`,
 * fsync, then rename over the target. rename() is atomic on a single volume, so
 * a concurrent/subsequent reader sees either the complete old or complete new
 * content — never partial/empty/intermingled (Req 5.1, 5.2). On any failure the
 * temp file is removed and the original target is left untouched, then the error
 * is rethrown (Req 5.3, 5.4).
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${randomBytes(8).toString('hex')}`;
  let fd: number | undefined;
  try {
    // Write the full content and fsync so the bytes are durable on disk before
    // the rename makes them visible at the target path.
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, content, null, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // rename() atomically replaces the target on a single volume.
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    // Leave the original target untouched; clean up the temp file on failure.
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed / unusable */ }
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Errors that indicate a transient Windows file-lock, not a real failure. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * `fs.renameSync` with a bounded retry for transient sharing violations.
 *
 * On Windows a rename over an existing target fails with EPERM/EACCES/EBUSY
 * whenever another process holds a handle on either path — antivirus and the
 * search indexer both open files opportunistically right after they are
 * written, so a rewrite-heavy loop hits this regularly even though nothing is
 * wrong. POSIX has no such behaviour, so this loop is a no-op there.
 *
 * The retry stays synchronous (busy-wait) to keep `writeFileAtomic` sync, and
 * rethrows the original error once the attempts are exhausted so the caller's
 * cleanup and error contract (Req 5.3, 5.4) are unchanged.
 */
function renameWithRetry(tmpPath: string, filePath: string, attempts = 10): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      sleepSync(attempt * 5);
    }
  }
}

/** Block the current thread for `ms` milliseconds without an event-loop turn. */
function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* busy-wait: writeFileAtomic must stay sync */ }
}

/** Escape single quotes for inline Cypher string literals. */
export function e(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Normalize Kuzu row keys: strip the "alias." prefix that RETURN n.* produces.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const dotIdx = key.indexOf('.');
    result[dotIdx >= 0 ? key.slice(dotIdx + 1) : key] = value;
  }
  return result;
}

/**
 * Produce a Cypher-safe literal for a value.
 */
export function sqlVal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `'${e(String(value))}'`;
}

/** Parse the attributes JSON column of a record into a plain object. */
export function parseAttrs(record: Record<string, unknown>): Record<string, unknown> {
  const raw = record.attributes;
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Safely emit a progress event, catching any exception from the callback.
 * Logs a WARN and continues so a misbehaving callback never aborts the load.
 */
export function emitProgress(
  onProgress: OnLoadProgress | undefined,
  event: LoadProgressEvent,
  logger: ImportLogger
): void {
  if (!onProgress) return;
  try {
    onProgress(event);
  } catch (err) {
    logger.warn(`onProgress callback threw: ${String(err)}`);
  }
}

/**
 * Issue batched UNWIND queries for a set of rows, at most LOAD_BATCH_SIZE rows per query.
 * Accepts an optional DbTransaction; falls back to dbModule.runQuery if not provided.
 */
export async function batchInsertNodes(
  query: string,
  rows: Record<string, unknown>[],
  dbModule: IDbModule,
  tx?: DbTransaction
): Promise<void> {
  const runner = tx ?? dbModule;
  let i = 0;
  while (i < rows.length) {
    const batch = rows.slice(i, i + LOAD_BATCH_SIZE);
    await runner.runQuery(query, { rows: batch });
    i += LOAD_BATCH_SIZE;
  }
}

export const EDGE_BATCH_SIZE = 200;

/**
 * Create `RIA_UNIV_INSTANCE_REL` graph edges for a batch of resolved
 * relationship rows.  Derives the edge column list from `CANONICAL_REL_TABLES`
 * rather than hard-coding it, so schema changes propagate automatically.
 *
 * Uses batched UNWIND queries (EDGE_BATCH_SIZE rows per query) to avoid
 * oversized Cypher statements.
 */
export async function createInstanceRelEdges(
  relRows: Array<{
    source_node_id: number;
    target_node_id: number;
    edge_id: number;
    relationship: string;
    metamodel: string;
  }>,
  runner: IDbModule | DbTransaction,
  batchSize = EDGE_BATCH_SIZE,
): Promise<void> {
  const relTableDef = CANONICAL_REL_TABLES.find(t => t.name === 'RIA_UNIV_INSTANCE_REL');
  if (!relTableDef) throw new Error('Canonical relationship table not found: RIA_UNIV_INSTANCE_REL');
  const cols = relTableDef.columns ?? [];

  for (let i = 0; i < relRows.length; i += batchSize) {
    const batch = relRows.slice(i, i + batchSize);
    // Build inline UNWIND list — values are safe integers/escaped strings
    const items = batch.map(r => {
      const props = cols.map(col => {
        if (col.name === 'edge_instance_id') return `edge_instance_id: ${r.edge_id}`;
        if (col.name === 'relationship')     return `relationship: '${e(r.relationship)}'`;
        if (col.name === 'metamodel')        return `metamodel: '${e(r.metamodel)}'`;
        return `${col.name}: null`;
      }).join(', ');
      return `{src: ${r.source_node_id}, tgt: ${r.target_node_id}, ${props}}`;
    }).join(', ');

    const propParts = cols.map(col => `${col.name}: item.${col.name}`).join(', ');
    await runner.runQuery(
      `UNWIND [${items}] AS item
       MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
       WHERE src.node_id = item.src AND tgt.node_id = item.tgt
       CREATE (src)-[:RIA_UNIV_INSTANCE_REL { ${propParts} }]->(tgt)`
    );
  }
}

/**
 * Create `RIA_UNIV_CROSSNS_INSTANCE_REL` graph edges for a batch of resolved
 * cross-namespace rows.  Derives the edge column list from `CANONICAL_REL_TABLES`.
 */
export async function createCrossNsInstanceRelEdges(
  crossNsRows: Array<{
    source_node_id: number;
    target_node_id: number;
    edge_id: number;
    relationship: string;
    metamodel: string;
    source_namespace: string;
    target_namespace: string;
  }>,
  runner: IDbModule | DbTransaction,
  batchSize = EDGE_BATCH_SIZE,
): Promise<void> {
  const relTableDef = CANONICAL_REL_TABLES.find(t => t.name === 'RIA_UNIV_CROSSNS_INSTANCE_REL');
  if (!relTableDef) throw new Error('Canonical relationship table not found: RIA_UNIV_CROSSNS_INSTANCE_REL');
  const cols = relTableDef.columns ?? [];

  for (let i = 0; i < crossNsRows.length; i += batchSize) {
    const batch = crossNsRows.slice(i, i + batchSize);
    const items = batch.map(r => {
      const props = cols.map(col => {
        if (col.name === 'edge_instance_id')  return `edge_instance_id: ${r.edge_id}`;
        if (col.name === 'relationship')      return `relationship: '${e(r.relationship)}'`;
        if (col.name === 'metamodel')         return `metamodel: '${e(r.metamodel)}'`;
        if (col.name === 'source_namespace')  return `source_namespace: '${e(r.source_namespace)}'`;
        if (col.name === 'target_namespace')  return `target_namespace: '${e(r.target_namespace)}'`;
        return `${col.name}: null`;
      }).join(', ');
      return `{src: ${r.source_node_id}, tgt: ${r.target_node_id}, ${props}}`;
    }).join(', ');

    const propParts = cols.map(col => `${col.name}: item.${col.name}`).join(', ');
    await runner.runQuery(
      `UNWIND [${items}] AS item
       MATCH (src:RIA_UNIV_ConceptInstance), (tgt:RIA_UNIV_ConceptInstance)
       WHERE src.node_id = item.src AND tgt.node_id = item.tgt
       CREATE (src)-[:RIA_UNIV_CROSSNS_INSTANCE_REL { ${propParts} }]->(tgt)`
    );
  }
}

export function normalizeNodeInsertRow(row: Record<string, unknown>, table: TableDef): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const column of table.columns) {
    let value = row[column];
    if (value === undefined) value = null;
    if (value !== null && table.jsonColumns.includes(column) && typeof value === 'object') {
      value = JSON.stringify(value);
    }
    normalized[column] = value;
  }
  return normalized;
}

export function buildNodeInsertQuery(table: TableDef): string {
  const setParts = table.columns.map((c) => `${c}: row.${c}`).join(', ');
  return `UNWIND $rows AS row CREATE (:${table.name} { ${setParts} })`;
}

export interface EdgeImportSpec {
  file: string;
  rel: string;
  srcTable: string;
  srcPk: string;
  dstTable: string;
  dstPk: string;
}

export function buildEdgeImportSpec(relName: string, file: string): EdgeImportSpec {
  const canonicalRel = CANONICAL_REL_TABLES.find((rel) => rel.name === relName);
  if (!canonicalRel) {
    throw new Error(`Canonical relationship table not found: ${relName}`);
  }

  const registryRel = getTableByName(relName);
  if (!registryRel || registryRel.type !== 'rel' || !registryRel.srcPk || !registryRel.dstPk) {
    throw new Error(`Table registry relationship metadata incomplete: ${relName}`);
  }

  return {
    file,
    rel: relName,
    srcTable: canonicalRel.fromTable,
    srcPk: registryRel.srcPk,
    dstTable: canonicalRel.toTable,
    dstPk: registryRel.dstPk,
  };
}

export async function loadSharedNodeTable(
  table: TableDef,
  filePath: string,
  dbModule: IDbModule,
  tx?: DbTransaction,
): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;
  const rows = parseTable(fs.readFileSync(filePath, 'utf-8'));
  if (rows.length === 0) return 0;

  const batchRows = rows.map((row) => normalizeNodeInsertRow(row, table));
  await batchInsertNodes(buildNodeInsertQuery(table), batchRows, dbModule, tx);
  return rows.length;
}

/**
 * Pre-load attribute metadata from the DB.
 */
export async function loadAttributeMetadata(
  dbModule: IDbModule,
): Promise<{ nodeKeyAttrs: NodeKeyAttrMap; edgeKeyAttrs: EdgeKeyAttrMap }> {
  const nodeRows = await dbModule.runQuery(
    `MATCH (na:RIA_META_NodeAttribute) WHERE na.is_key = true OR na.is_identity = true
     RETURN na.concept AS concept, na.name AS name, na.is_identity AS is_identity
     ORDER BY na.concept, na.is_identity DESC, na.name`
  );
  const nodeKeyAttrs: NodeKeyAttrMap = new Map();
  for (const row of nodeRows) {
    const concept = String(row.concept ?? '');
    const name = String(row.name ?? '');
    if (!concept || !name) continue;
    const existing = nodeKeyAttrs.get(concept) ?? [];
    existing.push(name);
    nodeKeyAttrs.set(concept, existing);
  }

  const edgeRows = await dbModule.runQuery(
    `MATCH (ea:RIA_META_EdgeAttribute) WHERE ea.is_key = true
     RETURN ea.relationship AS relationship, ea.name AS name ORDER BY ea.relationship, ea.name`
  );
  const edgeKeyAttrs: EdgeKeyAttrMap = new Map();
  for (const row of edgeRows) {
    const rel = String(row.relationship ?? '');
    const name = String(row.name ?? '');
    if (!rel || !name) continue;
    const existing = edgeKeyAttrs.get(rel) ?? [];
    existing.push(name);
    edgeKeyAttrs.set(rel, existing);
  }

  return { nodeKeyAttrs, edgeKeyAttrs };
}

/**
 * Pre-load attribute metadata from exported meta JSON files (for file-path hash computation).
 */
export function loadAttributeMetadataFromFiles(exportDir: string): { nodeKeyAttrs: NodeKeyAttrMap; edgeKeyAttrs: EdgeKeyAttrMap } {
  const nodeKeyAttrs: NodeKeyAttrMap = new Map();
  const edgeKeyAttrs: EdgeKeyAttrMap = new Map();

  const nodeAttrPath = path.join(exportDir, 'meta', 'RIA_META_NodeAttribute.json');
  if (fs.existsSync(nodeAttrPath)) {
    const rows = parseTable(fs.readFileSync(nodeAttrPath, 'utf-8'));
    // Collect identity and key attrs separately so identity attrs sort first,
    // matching the ORDER BY na.concept, na.is_identity DESC, na.name used in loadAttributeMetadata.
    const identityAttrs = new Map<string, string[]>();
    const keyOnlyAttrs  = new Map<string, string[]>();
    for (const row of rows) {
      if (row.is_key !== true && row.is_identity !== true) continue;
      const concept = String(row.concept ?? '');
      const name = String(row.name ?? '');
      if (!concept || !name) continue;
      if (row.is_identity === true) {
        const existing = identityAttrs.get(concept) ?? [];
        existing.push(name);
        identityAttrs.set(concept, existing);
      } else {
        const existing = keyOnlyAttrs.get(concept) ?? [];
        existing.push(name);
        keyOnlyAttrs.set(concept, existing);
      }
    }
    // Merge: identity attrs first (sorted), then key-only attrs (sorted)
    const allConcepts = new Set([...identityAttrs.keys(), ...keyOnlyAttrs.keys()]);
    for (const concept of allConcepts) {
      const identity = (identityAttrs.get(concept) ?? []).sort();
      const keyOnly  = (keyOnlyAttrs.get(concept) ?? []).sort();
      nodeKeyAttrs.set(concept, [...identity, ...keyOnly]);
    }
  }

  const edgeAttrPath = path.join(exportDir, 'meta', 'RIA_META_EdgeAttribute.json');
  if (fs.existsSync(edgeAttrPath)) {
    const rows = parseTable(fs.readFileSync(edgeAttrPath, 'utf-8'));
    for (const row of rows) {
      if (row.is_key !== true) continue;
      const rel = String(row.relationship ?? '');
      const name = String(row.name ?? '');
      if (!rel || !name) continue;
      const existing = edgeKeyAttrs.get(rel) ?? [];
      existing.push(name);
      edgeKeyAttrs.set(rel, existing);
    }
    for (const [k, v] of edgeKeyAttrs) edgeKeyAttrs.set(k, v.sort());
  }

  return { nodeKeyAttrs, edgeKeyAttrs };
}

// ── Registry-driven shared-layer helpers ───────────────────────────────────────

/** Layers whose data is unconditionally cleared and re-imported on every load. */
const SHARED_LAYERS: Array<'meta' | 'sourcemaster' | 'cross_namespace'> = [
  'cross_namespace', 'sourcemaster', 'meta',
];

/**
 * Build the list of Cypher DELETE statements needed to clear all shared layers
 * (meta, sourcemaster, cross_namespace) before re-import.
 *
 * Derived from the canonical schema so that adding a new table to schema.ts +
 * table-registry automatically includes it in the clearing sequence.
 *
 * Deletion order: rel tables first (edges reference nodes), then node tables.
 * Within each group the order is cross_namespace → sourcemaster → meta so that
 * foreign-key-like references are removed before the nodes they point to.
 *
 * Excludes RIA_META_SchemaVersion — that node is managed separately and must
 * survive a load cycle.
 */
export function buildSharedLayerClearStatements(): string[] {
  const stmts: string[] = [];

  // 1. Rel tables — edges must be deleted before the nodes they connect.
  for (const layer of SHARED_LAYERS) {
    const relTables = CANONICAL_REL_TABLES.filter(t => t.layer === layer);
    for (const rel of relTables) {
      stmts.push(`MATCH ()-[r:${rel.name}]->() DELETE r`);
    }
  }

  // 2. Node tables — safe to delete after all edges are gone.
  for (const layer of SHARED_LAYERS) {
    const nodeTables = CANONICAL_NODE_TABLES.filter(
      t => t.layer === layer && t.name !== 'RIA_META_SchemaVersion',
    );
    for (const node of nodeTables) {
      stmts.push(`MATCH (n:${node.name}) DELETE n`);
    }
  }

  return stmts;
}

/**
 * Determine whether a rel table has an endpoint that references
 * `RIA_UNIV_Namespace`. Such edges must be imported *after* the namespace
 * loop because namespace nodes are created inside that loop.
 */
function isNamespaceDependentRel(rel: typeof CANONICAL_REL_TABLES[number]): boolean {
  return rel.fromTable === 'RIA_UNIV_Namespace' || rel.toTable === 'RIA_UNIV_Namespace';
}

/**
 * Build EdgeImportSpec entries for all rel tables in the given layers,
 * split into two groups:
 *
 * - `immediate`: can be imported right after the shared node tables
 * - `deferred`:  must wait until after the namespace loop (they reference
 *                RIA_UNIV_Namespace nodes that don't exist yet)
 *
 * Each spec's `file` is set to `{layerDir}/{relName}.json` so the caller
 * can resolve it relative to the export directory.
 */
export function buildSharedEdgeImportSpecs(
  layers: Array<'meta' | 'sourcemaster'>,
): { immediate: EdgeImportSpec[]; deferred: EdgeImportSpec[] } {
  const immediate: EdgeImportSpec[] = [];
  const deferred: EdgeImportSpec[] = [];

  for (const layer of layers) {
    const relTables = getTablesByLayer(layer).filter(t => t.type === 'rel');
    const layerDir = layer === 'meta' ? 'meta' : 'sourcemaster';

    for (const regEntry of relTables) {
      const canonical = CANONICAL_REL_TABLES.find(r => r.name === regEntry.name);
      if (!canonical) continue;

      const spec = buildEdgeImportSpec(regEntry.name, `${layerDir}/${regEntry.name}.json`);

      if (isNamespaceDependentRel(canonical)) {
        deferred.push(spec);
      } else {
        immediate.push(spec);
      }
    }
  }

  return { immediate, deferred };
}

/**
 * Export a shared layer (meta, sourcemaster, cross_namespace) to a subdirectory.
 */
export async function exportLayer(
  layer: 'meta' | 'sourcemaster' | 'cross_namespace',
  layerDir: string,
  dbModule: IDbModule,
  fileInventory: Record<string, number>,
  exportDir: string,
): Promise<number> {
  fs.mkdirSync(layerDir, { recursive: true });
  const tables = getTablesByLayer(layer);
  let totalRecords = 0;

  for (const table of tables) {
    let rows: Record<string, unknown>[];
    if (table.customQuery) {
      rows = await dbModule.runQuery(table.customQuery);
    } else if (table.type === 'node') {
      const raw = await dbModule.runQuery(`MATCH (n:${table.name}) RETURN n.*`);
      rows = raw.map(normalizeRow);
    } else {
      const srcPk = table.srcPk ?? 'node_id';
      const dstPk = table.dstPk ?? 'node_id';
      rows = await dbModule.runQuery(
        `MATCH (src)-[r:${table.name}]->(dst) RETURN src.${srcPk} AS src_${srcPk}, dst.${dstPk} AS dst_${dstPk}`
      );
    }

    // For RIA_UNIV_CrossNSRelationshipInstance, use a stable content-based sort
    // instead of the ephemeral edge_id primary key. This prevents false diffs
    // when the DB assigns new edge_ids after a load/store cycle.
    let content: string;
    if (table.name === 'RIA_UNIV_CrossNSRelationshipInstance') {
      const sorted = sortCrossNsRelationshipInstances(rows);
      const recordLines = sorted.map(record => serializeRecord(record, table.jsonColumns, table.omitColumns));
      content = recordLines.length === 0
        ? "[]\n"
        : "[\n" + recordLines.join(",\n") + "\n]\n";
    } else if (table.name === 'RIA_UNIV_CROSSNS_INSTANCE_REL') {
      // Sort cross-namespace instance rel edges by source → destination →
      // relationship to keep all edges from the same source grouped together.
      // This prevents reordering of occurs_at / has_direct_requirements within
      // a malfunction's block on every store cycle.
      const sorted = sortCrossNsInstanceRelEdges(rows);
      const recordLines = sorted.map(record => serializeRecord(record, table.jsonColumns, table.omitColumns));
      content = recordLines.length === 0
        ? "[]\n"
        : "[\n" + recordLines.join(",\n") + "\n]\n";
    } else if (table.name === 'RIA_UNIV_NamespaceRelation') {
      // Sort NamespaceRelation by content fields instead of ephemeral rel_id.
      // rel_id is a SERIAL that changes after load/store cycles.
      content = serializeTable(rows, 'source_namespace', table.jsonColumns, table.omitColumns);
    } else {
      content = serializeTable(rows, table.primaryKey, table.jsonColumns, table.omitColumns);
    }

    const filePath = path.join(layerDir, `${table.name}.json`);
    fs.writeFileSync(filePath, content, 'utf-8');

    const relPath = path.relative(exportDir, filePath).replace(/\\/g, '/');
    fileInventory[relPath] = rows.length;
    totalRecords += rows.length;
  }

  return totalRecords;
}

/**
 * Inline the deleteNamespace logic (adapted from backend/src/services/namespace.ts).
 * Deletes in dependency order without requiring the namespace to exist first.
 * Accepts an optional DbTransaction; falls back to dbModule.runQuery if not provided.
 */
export async function deleteNamespace(name: string, dbModule: IDbModule, tx?: DbTransaction): Promise<void> {
  const runner = tx ?? dbModule;
  const stmts = [
    // INSTANCE_REL edges are strictly intra-namespace: both endpoints always belong to the
    // same namespace. Scoping by source namespace alone is sufficient and safe — using OR on
    // the target namespace would incorrectly delete edges that belong to other namespaces
    // whose nodes happen to be the target of a relationship from the deleted namespace.
    `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance)
     WHERE a.namespace = '${e(name)}' DELETE r`,
    `MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = '${e(name)}' DELETE ri`,
    // CROSSNS_INSTANCE_REL edges span two namespaces by definition, so either endpoint
    // being in the deleted namespace is a valid reason to remove the edge.
    `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance)
     WHERE a.namespace = '${e(name)}' OR b.namespace = '${e(name)}' DELETE r`,
    `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance) WHERE x.source_namespace = '${e(name)}' OR x.target_namespace = '${e(name)}' DELETE x`,
    `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = '${e(name)}' DETACH DELETE ci`,
    `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_SOURCE]->()
     WHERE nr.source_namespace = '${e(name)}' OR nr.target_namespace = '${e(name)}' DELETE r`,
    `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_TARGET]->()
     WHERE nr.source_namespace = '${e(name)}' OR nr.target_namespace = '${e(name)}' DELETE r`,
    `MATCH (nr:RIA_UNIV_NamespaceRelation)
     WHERE nr.source_namespace = '${e(name)}' OR nr.target_namespace = '${e(name)}' DELETE nr`,
    // DETACH DELETE removes the namespace node and ALL directly-attached edges,
    // which includes RIA_UNIV_NamespaceConnection edges to/from this namespace —
    // those are implicitly cleaned up here without a separate statement.
    `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = '${e(name)}' DETACH DELETE ns`,
    // Remove the canvas layout record(s) for this namespace. The Layout_Key for
    // an imported namespace tile is ('imported', <name>) and for an analysis tile
    // is ('analysis', <name>). Deleting by element_key covers both roles in one
    // statement so the layout file written by the next universe-scoped auto-save
    // reflects the current (reduced) tile set rather than keeping a stale record.
    `MATCH (l:RIA_UNIV_CanvasLayout) WHERE l.element_key = '${e(name)}' DELETE l`,
  ];

  for (const stmt of stmts) {
    await runner.runQuery(stmt);
  }

  // Only checkpoint when not in a transaction (checkpoint commits implicitly)
  if (!tx) {
    await dbModule.checkpoint();
  }
}
