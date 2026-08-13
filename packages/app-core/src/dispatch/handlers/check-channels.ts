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
 * IPC channel handlers for the user-defined check system.
 *
 * Channels registered here:
 *  - checks.loadApplicable  → load & filter checks from checks.json
 *  - checks.runCheck        → execute a check query, store results server-side
 *  - checks.getPage         → retrieve a page of violation rows from a stored run
 */

import { randomUUID } from 'node:crypto';
import type { ApplicableCheck, CheckRunSummary, CheckPageResult, CheckViolation } from '@riacore/app-contracts';
import { resolveAttributeKey } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { extractNodeName } from '../utils/node-name.js';
import {
  loadChecksFromFile,
  filterApplicableChecks,
  findCheckById,
  detectWriteOperation,
  loadCheckSelection,
  saveCheckSelection,
  loadCheckSummaryFromFile,
  saveCheckSummaryToFile,
} from '../../checks/check-file-service.js';

type Registry = ReturnType<typeof createRegistry>;

function resolveCheckAttributeValue(
  attrs: Record<string, unknown>,
  attrKey: string,
  concept: string,
): string | null {
  const direct = attrs[attrKey];
  if (direct !== undefined && direct !== null) {
    return String(direct);
  }

  // Keep checks ergonomic across metamodels where display name may be stored
  // under short_name/stable_path instead of has_name.
  if (attrKey === 'has_name' || attrKey === 'name' || attrKey === 'short_name') {
    const derived = extractNodeName(attrs, concept);
    return derived.length > 0 ? derived : null;
  }

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Queries the DB for the metamodel of the given namespace.
 * Uses the RIA_UNIV_Namespace table (not concept instances) so the result
 * is available even when the namespace has no nodes yet.
 * Returns the metamodel string, or null if the namespace does not exist.
 */
async function resolveNamespaceMetamodel(
  dbModule: import('../../db/db-module.js').IDbModule,
  namespace: string,
): Promise<string | null> {
  const rows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace}) RETURN ns.metamodel AS metamodel LIMIT 1`,
    { namespace },
  );
  if (rows.length === 0) return null;
  const val = rows[0].metamodel;
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Given a list of node IDs, fetches each node's `attributes` JSON blob from
 * the DB and extracts the requested attribute keys.
 *
 * Returns one `CheckViolation` per node ID.
 */
async function loadViolationRows(
  dbModule: import('../../db/db-module.js').IDbModule,
  nodeIds: number[],
  attributeKeys: string[],
): Promise<CheckViolation[]> {
  if (nodeIds.length === 0) return [];

  // KuzuDB doesn't support list parameters; build an inline literal list.
  // node_id values come from our own DB query (integers) so this is safe.
  const idList = nodeIds.join(', ');

  const rows = await dbModule.runQuery(
    `MATCH (n:RIA_UNIV_ConceptInstance)
     WHERE n.node_id IN [${idList}]
     RETURN n.node_id AS node_id, n.namespace AS namespace,
            n.concept AS concept, n.attributes AS attributes`,
    {},
  );

  // Re-order rows to match the requested nodeIds order (DB may return any order)
  const byId = new Map<number, (typeof rows)[0]>();
  for (const row of rows) {
    byId.set(Number(row.node_id), row);
  }

  return nodeIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      return {
        nodeId: id,
        namespace: '',
        concept: '',
        attributeValues: Object.fromEntries(attributeKeys.map((k) => [k, null])),
      };
    }

    let parsedAttrs: Record<string, unknown> = {};
    if (typeof row.attributes === 'string' && row.attributes.length > 0) {
      try {
        parsedAttrs = JSON.parse(row.attributes) as Record<string, unknown>;
      } catch {
        // leave empty
      }
    }

    return {
      nodeId: id,
      namespace: String(row.namespace ?? ''),
      concept: String(row.concept ?? ''),
      attributeValues: Object.fromEntries(
        attributeKeys.map((k) => [k, resolveCheckAttributeValue(parsedAttrs, k, String(row.concept ?? ''))]),
      ),
    } satisfies CheckViolation;
  });
}

// ── Channel registration ──────────────────────────────────────────────────────

export function registerCheckChannels(registry: Registry): void {

  // ── checks.loadApplicable ───────────────────────────────────────────────────
  registry.register('checks.loadApplicable', async (payload, deps, _ctx) => {
    const wsStatus = await deps.workspaceService.getStatus();
    if (wsStatus.state !== 'open') {
      throw new Error('No workspace is open');
    }
    const { workingDir } = wsStatus.info;

    const { checks, warnings } = await loadChecksFromFile(workingDir);
    if (warnings.length > 0) {
      console.warn('[check-channels] checks.json warnings:', warnings);
    }

    // Resolve the namespace's metamodel from the DB
    const metamodel = await resolveNamespaceMetamodel(deps.dbModule, payload.namespace);
    if (!metamodel) {
      // Namespace doesn't exist or has no nodes yet → return empty
      return [] as ApplicableCheck[];
    }

    return filterApplicableChecks(checks, metamodel);
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });

  // ── checks.runCheck ─────────────────────────────────────────────────────────
  registry.register('checks.runCheck', async (payload, deps, ctx) => {
    const wsStatus = await deps.workspaceService.getStatus();
    if (wsStatus.state !== 'open') {
      throw new Error('No workspace is open');
    }
    const { workingDir } = wsStatus.info;

    const { checks, warnings } = await loadChecksFromFile(workingDir);
    if (warnings.length > 0) {
      console.warn('[check-channels] checks.json warnings:', warnings);
    }

    const checkDef = findCheckById(checks, payload.checkId);
    if (!checkDef) {
      throw new Error(`Check "${payload.checkId}" not found or is invalid`);
    }

    // Belt-and-suspenders: re-validate query even though check-file-service
    // already validated at load time
    const writeReason = detectWriteOperation(checkDef.query);
    if (writeReason) {
      throw new Error(`Check "${payload.checkId}" contains a write operation: ${writeReason}`);
    }

    // Execute the user Cypher with $namespace auto-injected
    let rawRows: Record<string, unknown>[];
    try {
      rawRows = await deps.dbModule.runQuery(checkDef.query, { namespace: payload.namespace });
    } catch (err) {
      throw new Error(`Check query execution failed: ${String(err)}`);
    }

    // Extract violation node IDs: use the first column that contains integer values
    // (named `violation` by convention, but we fall back to the first numeric column)
    const nodeIds: number[] = [];
    for (const row of rawRows) {
      const keys = Object.keys(row);
      const violationKey =
        keys.find((k) => k === 'violation') ??
        keys.find((k) => typeof row[k] === 'number' || typeof row[k] === 'bigint');
      if (violationKey !== undefined) {
        const val = row[violationKey];
        const id = typeof val === 'bigint' ? Number(val) : typeof val === 'number' ? val : NaN;
        if (Number.isInteger(id)) {
          nodeIds.push(id);
        }
      }
    }

    // Store run state for pagination
    const runId = randomUUID();
    ctx.storeCheckRun(runId, {
      checkId: checkDef.id,
      namespace: payload.namespace,
      nodeIds,
      attributes: checkDef.attributes,
    });

    // Load first page eagerly
    const pageSize = payload.pageSize ?? 50;
    const firstPageIds = nodeIds.slice(0, pageSize);
    const attributeKeys = checkDef.attributes.map(resolveAttributeKey);
    const firstPageRows = await loadViolationRows(deps.dbModule, firstPageIds, attributeKeys);

    const summary: CheckRunSummary = {
      runId,
      checkId: checkDef.id,
      totalViolations: nodeIds.length,
      firstPage: {
        runId,
        page: 0,
        pageSize,
        totalViolations: nodeIds.length,
        violations: firstPageRows,
        hasMore: nodeIds.length > pageSize,
      },
    };

    return summary;
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });

  // ── checks.getPage ──────────────────────────────────────────────────────────
  registry.register('checks.getPage', async (payload, deps, ctx) => {
    const runState = ctx.getCheckRun(payload.runId);
    if (!runState) {
      throw new Error(`Check run "${payload.runId}" not found. It may have expired.`);
    }

    const { page, pageSize } = payload;
    const start = page * pageSize;
    const end = start + pageSize;
    const pageIds = runState.nodeIds.slice(start, end);

    const runAttributeKeys = runState.attributes.map(resolveAttributeKey);
    const violations = await loadViolationRows(deps.dbModule, pageIds, runAttributeKeys);

    return {
      runId: payload.runId,
      page,
      pageSize,
      totalViolations: runState.nodeIds.length,
      violations,
      hasMore: end < runState.nodeIds.length,
    } satisfies CheckPageResult;
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });

  // ── checks.loadSelection ────────────────────────────────────────────────────
  registry.register('checks.loadSelection', async (payload, deps, _ctx) => {
    const wsStatus = await deps.workspaceService.getStatus();
    if (wsStatus.state !== 'open') {
      throw new Error('No workspace is open');
    }
    const { workingDir } = wsStatus.info;
    return loadCheckSelection(workingDir, payload.namespace);
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });

  // ── checks.saveSelection ────────────────────────────────────────────────────
  registry.register('checks.saveSelection', async (payload, deps, _ctx) => {
    const wsStatus = await deps.workspaceService.getStatus();
    if (wsStatus.state !== 'open') {
      throw new Error('No workspace is open');
    }
    const { workingDir } = wsStatus.info;
    await saveCheckSelection(workingDir, payload.namespace, payload.selectedIds);
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });

  // ── checks.saveSummary ──────────────────────────────────────────────────────
  registry.register('checks.saveSummary', async (payload, deps, _ctx) => {
    const wsStatus = await deps.workspaceService.getStatus();
    if (wsStatus.state !== 'open') {
      throw new Error('No workspace is open');
    }
    const { workingDir } = wsStatus.info;

    // Snapshot current node count for the namespace so we can detect
    // structural changes (added/deleted nodes) on subsequent loads.
    let nodeCountSnapshot = 0;
    try {
      const countRows = await deps.dbModule.runQuery(
        `MATCH (n:RIA_UNIV_ConceptInstance) WHERE n.namespace = $namespace
         RETURN count(n) AS cnt`,
        { namespace: payload.namespace },
      );
      if (countRows.length > 0) {
        const val = countRows[0].cnt;
        nodeCountSnapshot = typeof val === 'bigint' ? Number(val) : typeof val === 'number' ? val : 0;
      }
    } catch {
      // Non-fatal — proceed without count snapshot
    }

    await saveCheckSummaryToFile(workingDir, {
      namespace: payload.namespace,
      runTimestamp: new Date().toISOString(),
      errors: payload.errors,
      warnings: payload.warnings,
      hints: payload.hints,
      checksRun: payload.checksRun,
      nodeCountSnapshot,
    });
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });

  // ── checks.loadSummary ──────────────────────────────────────────────────────
  registry.register('checks.loadSummary', async (payload, deps, _ctx) => {
    const wsStatus = await deps.workspaceService.getStatus();
    if (wsStatus.state !== 'open') {
      throw new Error('No workspace is open');
    }
    const { workingDir } = wsStatus.info;

    const stored = await loadCheckSummaryFromFile(workingDir, payload.namespace);
    if (!stored) {
      return null;
    }

    // ── Staleness detection ───────────────────────────────────────────────────
    let isOutdated = false;

    // 1. Check if the namespace node count has changed since the last run.
    //    A count mismatch means nodes were added or deleted.
    try {
      const countRows = await deps.dbModule.runQuery(
        `MATCH (n:RIA_UNIV_ConceptInstance) WHERE n.namespace = $namespace
         RETURN count(n) AS cnt`,
        { namespace: payload.namespace },
      );
      if (countRows.length > 0) {
        const val = countRows[0].cnt;
        const currentCount = typeof val === 'bigint' ? Number(val) : typeof val === 'number' ? val : 0;
        if (currentCount !== stored.nodeCountSnapshot) {
          isOutdated = true;
        }
      }
    } catch {
      // If the query fails we cannot confirm freshness → mark as outdated
      isOutdated = true;
    }

    // 2. Check if any import run completed after the last check run.
    //    Any completed import may have changed data that the checks rely on.
    if (!isOutdated) {
      try {
        const importRows = await deps.dbModule.runQuery(
          `MATCH (r:RIA_SRC_ImportRun)
           WHERE r.status = 'completed' AND r.completed_at > $runTimestamp
           RETURN count(r) AS cnt`,
          { runTimestamp: stored.runTimestamp },
        );
        if (importRows.length > 0) {
          const val = importRows[0].cnt;
          const importCount = typeof val === 'bigint' ? Number(val) : typeof val === 'number' ? val : 0;
          if (importCount > 0) {
            isOutdated = true;
          }
        }
      } catch {
        // Cannot confirm freshness — mark as outdated to be safe
        isOutdated = true;
      }
    }

    return {
      namespace: stored.namespace,
      runTimestamp: stored.runTimestamp,
      errors: stored.errors,
      warnings: stored.warnings,
      hints: stored.hints,
      checksRun: stored.checksRun,
      isOutdated,
    };
  }, {
    requiresWorkspace: true,
    category: 'checks',
  });
}

