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
import type { GraphQueryResult, GraphNode, GraphEdge } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { getCanonicalNodeTable } from '../../db/schema.js';
import { e } from '../utils/cypher.js';

// ── Graph result helpers ───────────────────────────────────────────────────────

/** Internal metadata keys to exclude when extracting node properties. */
const NODE_META_KEYS = new Set(['_id', '_label']);
/** Internal metadata keys to exclude when extracting edge properties. */
const EDGE_META_KEYS = new Set(['_src', '_dst', '_label', '_id']);

function getNodePrimaryKeyColumn(nodeLabel: string): string | undefined {
  return getCanonicalNodeTable(nodeLabel)?.primaryKey;
}

/**
 * Detect whether a column value is a graph node object.
 * Nodes have `_id` (with `offset` and `table`) and `_label`.
 */
function isKuzuNode(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj._label === 'string' &&
    typeof obj._id === 'object' &&
    obj._id !== null &&
    typeof (obj._id as Record<string, unknown>).offset === 'number' &&
    typeof (obj._id as Record<string, unknown>).table === 'number'
  );
}

/**
 * Detect whether a column value is a graph relationship object.
 * Relationships have `_src` and `_dst` (each with `offset` and `table`).
 */
function isKuzuRelationship(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  const hasSrc =
    typeof obj._src === 'object' &&
    obj._src !== null &&
    typeof (obj._src as Record<string, unknown>).offset === 'number' &&
    typeof (obj._src as Record<string, unknown>).table === 'number';
  const hasDst =
    typeof obj._dst === 'object' &&
    obj._dst !== null &&
    typeof (obj._dst as Record<string, unknown>).offset === 'number' &&
    typeof (obj._dst as Record<string, unknown>).table === 'number';
  return hasSrc && hasDst;
}

/** Stringify an internal ID object (`{ table, offset }`) to `"<table>:<offset>"`. */
function stringifyKuzuId(idObj: Record<string, unknown>): string {
  return `${idObj.table}:${idObj.offset}`;
}

/**
 * Extract `GraphNode` and `GraphEdge` objects from raw DB rows,
 * deduplicate by id, apply truncation limits, and set the `truncated` flag.
 */
export function buildGraphQueryResult(
  rows: Record<string, unknown>[],
  nodeLimit: number,
  edgeLimit: number,
): GraphQueryResult {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  for (const row of rows) {
    for (const val of Object.values(row)) {
      // Check relationship FIRST — relationships also have _label and _id,
      // so isKuzuNode would match them too. isKuzuRelationship is more
      // specific (requires _src and _dst).
      if (isKuzuRelationship(val)) {
        const srcId = stringifyKuzuId(val._src as Record<string, unknown>);
        const dstId = stringifyKuzuId(val._dst as Record<string, unknown>);
        const relType = (typeof val._label === 'string' ? val._label : '') as string;
        const edgeId = `${relType}:${srcId}->${dstId}`;
        if (!edgeMap.has(edgeId)) {
          const properties: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val)) {
            if (!EDGE_META_KEYS.has(k)) properties[k] = v;
          }
          edgeMap.set(edgeId, {
            id: edgeId,
            source: srcId,
            target: dstId,
            type: relType,
            properties,
          });
        }
      } else if (isKuzuNode(val)) {
        const id = stringifyKuzuId(val._id as Record<string, unknown>);
        if (!nodeMap.has(id)) {
          const properties: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val)) {
            if (!NODE_META_KEYS.has(k)) properties[k] = v;
          }
          nodeMap.set(id, {
            id,
            label: val._label as string,
            properties,
          });
        }
      }
    }
  }

  let nodes = Array.from(nodeMap.values());
  let edges = Array.from(edgeMap.values());
  const truncated = nodes.length > nodeLimit || edges.length > edgeLimit;

  if (nodes.length > nodeLimit) nodes = nodes.slice(0, nodeLimit);
  if (edges.length > edgeLimit) edges = edges.slice(0, edgeLimit);

  return { nodes, edges, truncated };
}

// ── Channel registration ───────────────────────────────────────────────────────

/**
 * Register graph channels: query, expand.
 * Both require an open workspace.
 */
export function registerGraphChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── graph.query ──────────────────────────────────────────────────────────────
  registry.register('graph.query', async (payload, deps, _ctx) => {
    const { cypher } = payload ?? {};
    if (deps.dbModule.getStatus().state !== 'open') throw new Error('No database is open');
    const rows = await deps.dbModule.runQuery(cypher);
    return buildGraphQueryResult(rows, 500, 2000);
  }, {
    requiresWorkspace: true,
    category: 'graph',
  });

  // ── graph.expand ─────────────────────────────────────────────────────────────
  registry.register('graph.expand', async (payload, deps, _ctx) => {
    const { nodeId, nodeLabel, properties } = payload ?? {};
    if (deps.dbModule.getStatus().state !== 'open') throw new Error('No database is open');

    // Build a WHERE clause that matches the node by its primary key.
    const pkCol = getNodePrimaryKeyColumn(nodeLabel);
    let whereClause: string;
    if (pkCol && properties[pkCol] !== undefined) {
      const pkVal = properties[pkCol];
      whereClause = typeof pkVal === 'string'
        ? `n.${pkCol} = '${e(pkVal)}'`
        : `n.${pkCol} = ${pkVal}`;
    } else {
      // Fallback: try to match by all known properties (limited to first 3)
      const conditions = Object.entries(properties)
        .slice(0, 3)
        .map(([k, v]) =>
          typeof v === 'string' ? `n.${k} = '${e(v)}'` : `n.${k} = ${v}`,
        );
      if (conditions.length === 0) throw new Error('Cannot expand node: no properties available');
      whereClause = conditions.join(' AND ');
    }

    const expandCypher = `MATCH (n:${nodeLabel})-[r]-(m) WHERE ${whereClause} RETURN n, r, m`;
    const rows = await deps.dbModule.runQuery(expandCypher);
    return buildGraphQueryResult(rows, 500, 2000);
  }, {
    requiresWorkspace: true,
    category: 'graph',
  });
}
