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
 * cleanup-service.ts — Database cleanup routines for RIACore.
 *
 * Provides a registry of named cleanup steps that can be run on demand
 * (e.g., at workspace open, before app close, or via an explicit IPC call).
 * Each step is independent and idempotent; failures are logged but do not
 * prevent subsequent steps from running.
 *
 * ── How to add a new cleanup routine ────────────────────────────────────────
 *
 * 1. Define an `async function cleanupXxx(db: IDbModule): Promise<CleanupStepResult>`
 *    that performs one focused piece of cleanup and returns a `CleanupStepResult`
 *    with `{ name, removedCount, details? }`.
 *
 * 2. Add an entry to the `CLEANUP_STEPS` array below:
 *      { name: 'xxx', description: '…', run: cleanupXxx }
 *    Steps are executed in array order; keep independent steps first.
 *
 * 3. Write a unit test in __tests__/cleanup-service.test.ts covering the
 *    happy path and the empty-database case.
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { CleanupStepResult, CleanupReport } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';

// Re-export for convenience so callers can import the types from here too
export type { CleanupStepResult, CleanupReport };

// ---------------------------------------------------------------------------
// Step 1 — Remove all supervised_update_temp namespaces
// ---------------------------------------------------------------------------
// Temp namespaces are created by the supervised-update workflow.  Under normal
// operation they are deleted when the user accepts or cancels the review.  If
// the application is closed while the review is open, or if an unexpected error
// occurs, one or more temp namespaces may be left in the database.  This step
// removes all of them together with all their contained nodes and edges.

async function cleanupTempNamespaces(db: IDbModule): Promise<CleanupStepResult> {
  // Collect names of all temp namespaces first
  const nsRows = await db.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace)
     WHERE ns.namespace_role = 'supervised_update_temp'
     RETURN ns.name AS name`,
  );

  if (nsRows.length === 0) {
    return { name: 'tempNamespaces', removedCount: 0 };
  }

  const names = nsRows.map(r => String(r.name ?? ''));

  // Delete in dependency order (mirrors deleteNamespace in persistor-helpers)
  for (const ns of names) {
    const esc = ns.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // Names of the views about to be cascade-deleted below, collected before the
    // cascade removes them. Their canvas layout records are keyed by the
    // Element_Kind 'view:<viewName>' (spec-view.md Phase 4.2) and there is
    // nothing left to derive that from afterwards.
    const cascadedViewRows = await db.runQuery(
      `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_SOURCE]->(nsNode:RIA_UNIV_Namespace)
       WHERE nsNode.name = $name RETURN DISTINCT v.name AS name`,
      { name: ns },
    );
    const cascadedViewNames = cascadedViewRows.map((row) => String(row.name ?? '')).filter((n) => n.length > 0);

    const stmts = [
      `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance)
       WHERE a.namespace = '${esc}' OR b.namespace = '${esc}' DELETE r`,
      `MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = '${esc}' DELETE ri`,
      `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance)
       WHERE a.namespace = '${esc}' OR b.namespace = '${esc}' DELETE r`,
      `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance)
       WHERE x.source_namespace = '${esc}' OR x.target_namespace = '${esc}' DELETE x`,
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = '${esc}' DETACH DELETE ci`,
      `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_SOURCE]->()
       WHERE nr.source_namespace = '${esc}' OR nr.target_namespace = '${esc}' DELETE r`,
      `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_TARGET]->()
       WHERE nr.source_namespace = '${esc}' OR nr.target_namespace = '${esc}' DELETE r`,
      `MATCH (nr:RIA_UNIV_NamespaceRelation)
       WHERE nr.source_namespace = '${esc}' OR nr.target_namespace = '${esc}' DELETE nr`,
      // Delete the associated Source record if one exists (supervised-update creates one)
      `MATCH (s:RIA_SRC_Source) WHERE s.target_namespace = '${esc}' DETACH DELETE s`,
      // A view does not outlive its sources (docs/coreSpecs/RiaViews.md), so a
      // namespace deletion cascades to every view referencing it. Must run
      // BEFORE the namespace DETACH DELETE below, which removes the VIEW_SOURCE
      // edge that finds them. Kept in step with the same statement in
      // deleteNamespace (persistor-helpers.ts) — the two sequences are separate
      // copies and this one had already drifted out of date once.
      `MATCH (v:RIA_UNIV_View)-[:RIA_UNIV_VIEW_SOURCE]->(ns:RIA_UNIV_Namespace)
       WHERE ns.name = '${esc}' WITH DISTINCT v DETACH DELETE v`,
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = '${esc}' DETACH DELETE ns`,
      // Companion statement for the cascade above — layout records of a deleted
      // view are keyed 'view:<viewName>' and no other statement here reaches
      // them. Mirrors deleteNamespace (persistor-helpers.ts).
      ...cascadedViewNames.map((viewName) => {
        const viewEsc = viewName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `MATCH (l:RIA_UNIV_CanvasLayout) WHERE l.element_kind = 'view:${viewEsc}' DELETE l`;
      }),
    ];
    for (const stmt of stmts) {
      await db.runQuery(stmt);
    }
  }

  await db.checkpoint();

  return {
    name: 'tempNamespaces',
    removedCount: names.length,
    details: `Removed temp namespace(s): ${names.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Remove dangling concept nodes (owned by a missing namespace)
// ---------------------------------------------------------------------------
// After a namespace is deleted, its ConceptInstance nodes should be gone too.
// This step is a safety net for cases where deletion was interrupted or only
// partially completed (e.g. process kill mid-transaction).

async function cleanupDanglingNodes(db: IDbModule): Promise<CleanupStepResult> {
  // Find concept instances whose namespace does not correspond to any
  // existing RIA_UNIV_Namespace node.
  const countRows = await db.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance)
     WHERE NOT EXISTS {
       MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = ci.namespace
     }
     RETURN count(ci) AS cnt`,
  );
  const count = Number(countRows[0]?.cnt ?? 0);

  if (count === 0) {
    return { name: 'danglingNodes', removedCount: 0 };
  }

  // Delete edges first, then the orphan nodes themselves
  await db.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance)
     WHERE NOT EXISTS {
       MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = ci.namespace
     }
     MATCH (ci)-[r:RIA_UNIV_INSTANCE_REL]-()
     DELETE r`,
  );
  await db.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance)
     WHERE NOT EXISTS {
       MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = ci.namespace
     }
     MATCH (ci)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]-()
     DELETE r`,
  );
  await db.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance)
     WHERE NOT EXISTS {
       MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = ci.namespace
     }
     DETACH DELETE ci`,
  );

  await db.checkpoint();

  return {
    name: 'danglingNodes',
    removedCount: count,
    details: `Removed ${count} concept node(s) owned by missing namespaces`,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — Remove dangling views (no remaining source namespace)
// ---------------------------------------------------------------------------
// A view is derived and is not meaningful without its full source set, so
// deleting a namespace deletes every view over it (docs/coreSpecs/RiaViews.md).
// A view left with zero RIA_UNIV_VIEW_SOURCE edges is therefore an invalid
// state — reachable only if a deletion path forgot the cascade, or was
// interrupted between the two statements. This is the safety net for that, the
// counterpart of danglingNodes for the view tables.
//
// Note this is NOT a change to cleanupDanglingNodes: that routine remains
// deliberately view-blind, because a view never writes a ConceptInstance. Any
// future change that materializes view content into RIA_UNIV_ConceptInstance
// must make that routine view-aware first.

async function cleanupDanglingViews(db: IDbModule): Promise<CleanupStepResult> {
  const rows = await db.runQuery(
    `MATCH (v:RIA_UNIV_View)
     WHERE NOT EXISTS { MATCH (v)-[:RIA_UNIV_VIEW_SOURCE]->(:RIA_UNIV_Namespace) }
     RETURN v.name AS name`,
  );

  if (rows.length === 0) {
    return { name: 'danglingViews', removedCount: 0 };
  }

  const names = rows.map(r => String(r.name ?? ''));

  // DETACH DELETE removes the view's DEFINEDBY/CATEGORIZEDBY edges with it; a
  // view has no stored content to clean up beyond its own relationships.
  await db.runQuery(
    `MATCH (v:RIA_UNIV_View)
     WHERE NOT EXISTS { MATCH (v)-[:RIA_UNIV_VIEW_SOURCE]->(:RIA_UNIV_Namespace) }
     DETACH DELETE v`,
  );

  // ...and the canvas layout records belonging to their content, which are
  // keyed by the Element_Kind 'view:<viewName>' and have no resolver, so
  // nothing else would ever prune them (spec-view.md Phase 4.2).
  for (const name of names) {
    await db.runQuery(
      `MATCH (l:RIA_UNIV_CanvasLayout) WHERE l.element_kind = $element_kind DELETE l`,
      { element_kind: `view:${name}` },
    );
  }

  await db.checkpoint();

  return {
    name: 'danglingViews',
    removedCount: names.length,
    details: `Removed view(s) with no source namespace: ${names.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------
// Add new cleanup steps here.  Steps are executed in order; earlier steps
// should remove the highest-level objects (namespaces) so that later steps
// (dangling node cleanup) produce smaller result sets.

interface CleanupStep {
  /** Short identifier used in CleanupStepResult.name and log messages. */
  name: string;
  /** Human-readable description shown in logs. */
  description: string;
  /** The async function that performs the cleanup. */
  run: (db: IDbModule) => Promise<CleanupStepResult>;
}

const CLEANUP_STEPS: CleanupStep[] = [
  {
    name: 'tempNamespaces',
    description: 'Delete all supervised_update_temp namespaces and their contents',
    run: cleanupTempNamespaces,
  },
  {
    name: 'danglingNodes',
    description: 'Delete concept nodes whose owning namespace no longer exists',
    run: cleanupDanglingNodes,
  },
  {
    name: 'danglingViews',
    description: 'Delete views left with no source namespace',
    run: cleanupDanglingViews,
  },
  // ── Future cleanup steps ─────────────────────────────────────────────────
  // To add another step, define a function above and add an entry here, e.g.:
  //
  //   {
  //     name: 'orphanedRelationships',
  //     description: 'Delete relationship instances with no source or target node',
  //     run: cleanupOrphanedRelationships,
  //   },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all registered cleanup steps and return a consolidated report.
 *
 * Each step is independent — a failure in one step is recorded in
 * `report.errors` but does not prevent subsequent steps from executing.
 *
 * @param db  Open database module to run queries against.
 * @param log Optional logger function for progress messages.
 */
export async function runAllCleanups(
  db: IDbModule,
  log?: (message: string) => void,
): Promise<CleanupReport> {
  const startedAt = new Date().toISOString();
  const steps: CleanupStepResult[] = [];
  const errors: string[] = [];

  for (const step of CLEANUP_STEPS) {
    log?.(`[cleanup] Running step: ${step.description}`);
    try {
      const result = await step.run(db);
      steps.push(result);
      if (result.removedCount > 0) {
        log?.(`[cleanup] ${step.name}: removed ${result.removedCount} item(s)${result.details ? ` — ${result.details}` : ''}`);
      } else {
        log?.(`[cleanup] ${step.name}: nothing to remove`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${step.name}: ${message}`);
      log?.(`[cleanup] ${step.name}: ERROR — ${message}`);
      // Push a zero-count result so every registered step appears in the report
      steps.push({ name: step.name, removedCount: 0, details: `Error: ${message}` });
    }
  }

  const finishedAt = new Date().toISOString();
  const totalRemoved = steps.reduce((sum, s) => sum + s.removedCount, 0);

  return { startedAt, finishedAt, steps, totalRemoved, errors };
}
