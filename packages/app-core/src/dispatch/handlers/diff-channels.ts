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
 * Diff and Merge IPC channel handlers.
 *
 * Registers all 9 diff.* channels on the command dispatcher.
 * Relies on DispatchContext for server-side storage of full diff results
 * (keyed by diffId) so that only lightweight DiffSummary is serialized
 * over IPC; full arrays are accessed via diff.getResultPage.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { DiffResultPage, DiffResultSection } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { createDiffService, createThreeWayDiffService } from '../../diff/diff-service.js';
import { renderDiffHtmlReport } from '../../diff/diff-html-report.js';
import { createMergeService } from '../../diff/merge-service.js';
import { createPersistorService, createImportLogger, createDiffMergeLogger } from '../../index.js';
import { deleteNamespace } from '../../persistor/persistor-helpers.js';
import { runStoreCommitHook } from '../../git/store-commit-hook.js';

type Registry = ReturnType<typeof createRegistry>;

export function registerDiffChannels(registry: Registry): void {

  // ── diff.computeNamespaces ─────────────────────────────────────────────────
  registry.register('diff.computeNamespaces', async (payload, deps, ctx) => {
    const logger = createDiffMergeLogger(path.join(payload.workingDir, 'logs'));
    logger.info('diff.computeNamespaces: start', {
      leftNs: payload.leftNs,
      rightNs: payload.rightNs,
      workingDir: payload.workingDir,
    });
    const svc = createDiffService(deps.dbModule);
    const { summary, result } = await svc.diffNamespaces(payload);
    ctx.storeDiffResult(summary.diffId, result);
    logger.info('diff.computeNamespaces: complete', {
      diffId: summary.diffId,
      addedNodes: summary.addedNodesCount,
      deletedNodes: summary.deletedNodesCount,
      modifiedNodes: summary.modifiedNodesCount,
      addedEdges: summary.addedEdgesCount,
      deletedEdges: summary.deletedEdgesCount,
      modifiedEdges: summary.modifiedEdgesCount,
    });
    return summary;
  }, {
    requiresWorkspace: true,
    category: 'diff',
  });

  // ── diff.computeFromPaths ──────────────────────────────────────────────────
  registry.register('diff.computeFromPaths', async (payload, deps, ctx) => {
    const svc = createDiffService(deps.dbModule);
    const { summary, result } = await svc.diffFromPaths(payload);
    ctx.storeDiffResult(summary.diffId, result);
    return summary;
  }, {
    requiresWorkspace: false,
    category: 'diff',
  });

  // ── diff.computeHybrid ─────────────────────────────────────────────────────
  registry.register('diff.computeHybrid', async (payload, deps, ctx) => {
    const logger = createDiffMergeLogger(path.join(payload.workingDir, 'logs'));
    logger.info('diff.computeHybrid: start', {
      liveNs: payload.liveNs,
      snapshotNs: payload.snapshotNs,
      snapshotDir: payload.snapshotDir,
      liveIsLeft: payload.liveIsLeft,
      workingDir: payload.workingDir,
    });
    const svc = createDiffService(deps.dbModule);
    const { summary, result } = await svc.diffHybrid(payload);
    ctx.storeDiffResult(summary.diffId, result);
    logger.info('diff.computeHybrid: complete', {
      diffId: summary.diffId,
      addedNodes: summary.addedNodesCount,
      deletedNodes: summary.deletedNodesCount,
      modifiedNodes: summary.modifiedNodesCount,
      addedEdges: summary.addedEdgesCount,
      deletedEdges: summary.deletedEdgesCount,
      modifiedEdges: summary.modifiedEdgesCount,
    });
    return summary;
  }, {
    requiresWorkspace: true,
    category: 'diff',
  });

  // ── diff.getDiffResult ─────────────────────────────────────────────────────
  registry.register('diff.getDiffResult', async ({ diffId }, _deps, ctx) => {
    return ctx.getDiffResult(diffId) ?? null;
  }, {
    requiresWorkspace: false,
    category: 'diff',
  });

  // ── diff.getResultPage ─────────────────────────────────────────────────────
  registry.register('diff.getResultPage', async (payload, _deps, ctx) => {
    const { diffId, section, offset, limit, filterText, filterConceptType, filterRelationshipType } = payload;
    const result = ctx.getDiffResult(diffId);
    if (!result) {
      return {
        items: [],
        totalCount: 0,
        offset,
        hasMore: false,
        section,
      } satisfies DiffResultPage;
    }

    // Extract raw array for the section
    const raw = (result as unknown as Record<string, unknown[]>)[section as string] ?? [];

    // Apply filters
    let filtered = raw;

    if (filterConceptType) {
      filtered = filtered.filter((item: unknown) => {
        const node = item as { conceptType?: string };
        return node.conceptType === filterConceptType;
      });
    }

    if (filterRelationshipType) {
      filtered = filtered.filter((item: unknown) => {
        const edge = item as { relationshipType?: string };
        return edge.relationshipType === filterRelationshipType;
      });
    }

    if (filterText) {
      const lower = filterText.toLowerCase();
      filtered = filtered.filter((item: unknown) => {
        return JSON.stringify(item).toLowerCase().includes(lower);
      });
    }

    const totalCount = filtered.length;
    const pageItems = filtered.slice(offset, offset + limit);

    return {
      items: pageItems as DiffResultPage['items'],
      totalCount,
      offset,
      hasMore: offset + limit < totalCount,
      section: section as DiffResultSection,
    } satisfies DiffResultPage;
  }, {
    requiresWorkspace: false,
    category: 'diff',
  });

  // ── diff.exportHtml ────────────────────────────────────────────────────────
  registry.register('diff.exportHtml', async (payload, _deps, ctx) => {
    const { diffId, outputPath, targetNamespace, sourceRef, sourceCommit, selectedChangeIds } = payload;

    const result = ctx.getDiffResult(diffId);
    if (!result) {
      throw new Error(
        `No diff result found for diffId '${diffId}'. Compute a diff first, and ` +
        `note that a result is disposed once its merge has been applied.`,
      );
    }

    // Guard the extension rather than silently writing HTML to an arbitrary
    // name: the output is meant to be opened in a browser, and a mistyped
    // destination is far easier to notice here than later in an archive.
    const ext = path.extname(outputPath).toLowerCase();
    if (ext !== '.html' && ext !== '.htm') {
      throw new Error(`Export path must end in .html or .htm, got '${outputPath}'`);
    }

    const html = renderDiffHtmlReport(result, {
      targetNamespace,
      sourceRef,
      sourceCommit,
      selectedChangeIds,
    });

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, 'utf-8');

    return { outputPath, bytesWritten: Buffer.byteLength(html, 'utf-8') };
  }, {
    requiresWorkspace: false,
    category: 'diff',
  });

  // ── diff.applyMerge ────────────────────────────────────────────────────────
  registry.register('diff.applyMerge', async (payload, deps, ctx) => {
    const { diffId, targetNs, direction, selectionIds, workingDir } = payload;
    const logger = createDiffMergeLogger(path.join(workingDir, 'logs'));
    logger.info('diff.applyMerge: start', {
      diffId,
      targetNs,
      direction,
      selectionCount: selectionIds ? selectionIds.length : 'all',
      workingDir,
    });
    const diffResult = ctx.getDiffResult(diffId);
    if (!diffResult) {
      logger.error('diff.applyMerge: diff result not found in cache', { diffId });
      throw new Error(`Diff result '${diffId}' not found. Re-compute the diff before merging.`);
    }
    logger.debug('diff.applyMerge: diff result retrieved from cache', {
      diffId,
      addedNodes: diffResult.addedNodes?.length ?? 0,
      deletedNodes: diffResult.deletedNodes?.length ?? 0,
      modifiedNodes: diffResult.modifiedNodes?.length ?? 0,
      addedEdges: diffResult.addedEdges?.length ?? 0,
      deletedEdges: diffResult.deletedEdges?.length ?? 0,
      modifiedEdges: diffResult.modifiedEdges?.length ?? 0,
    });
    const svc = createMergeService(deps.dbModule);
    const mergeResult = await svc.applyMerge({
      diffResult,
      targetNamespace: targetNs,
      direction,
      selectionIds,
    });
    logger.info('diff.applyMerge: merge applied to DB', {
      diffId,
      targetNs,
      nodesAdded: mergeResult.nodesAdded,
      nodesModified: mergeResult.nodesModified,
      nodesDeleted: mergeResult.nodesDeleted,
      edgesAdded: mergeResult.edgesAdded,
      edgesModified: mergeResult.edgesModified,
      edgesDeleted: mergeResult.edgesDeleted,
      skipped: mergeResult.skipped,
      warningCount: mergeResult.warnings.length,
    });
    if (mergeResult.warnings.length > 0) {
      for (const w of mergeResult.warnings) {
        logger.warn('diff.applyMerge: merge warning', { warning: w, diffId, targetNs });
      }
    }
    if (!mergeResult.mergeApplied) {
      throw new Error(
        `Merge could not be applied cleanly: ${mergeResult.warnings.join('; ') || 'unknown merge error'}`,
      );
    }

    // A supervised import diff uses a DB-backed temporary namespace as its
    // source side. Remove it before persisting so the full store never writes a
    // __upd_* namespace into ria-data/ or the manifest. The renderer's cleanup
    // call remains as an idempotent safety net for older backends.
    const sourceNamespace = direction === 'right-into-left'
      ? diffResult.rightNamespace
      : diffResult.leftNamespace;
    if (sourceNamespace !== targetNs) {
      const sourceNsRows = await deps.dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
         RETURN ns.namespace_role AS namespace_role`,
        { namespace: sourceNamespace },
      );
      if (String(sourceNsRows[0]?.namespace_role ?? '') === 'supervised_update_temp') {
        logger.info('diff.applyMerge: removing supervised-update temp namespace before persist', {
          sourceNamespace,
        });
        await deleteNamespace(sourceNamespace, deps.dbModule);
        await deps.dbModule.runQuery(
          `MATCH (s:RIA_SRC_Source) WHERE s.target_namespace = $namespace DETACH DELETE s`,
          { namespace: sourceNamespace },
        );
      }
    }

    // Persist the updated DB state to ria-data/ files so the merged content
    // is visible after restart and can be committed via git without a
    // separate explicit "Store" step.
    const persistLogger = deps.createLogger
      ? deps.createLogger(workingDir)
      : createImportLogger(path.join(workingDir, 'logs'));
    logger.info('diff.applyMerge: persisting DB to ria-data/', { workingDir });
    try {
      const storeResult = await createPersistorService(deps.dbModule, persistLogger).store({ workingDir });
      logger.info('diff.applyMerge: persist complete');
      // Run the auto-commit hook so that the files written here are staged
      // consistently with files written via the persistor.store IPC channel.
      if (deps.gitService) {
        await runStoreCommitHook(workingDir, storeResult, deps.gitService).catch((err) =>
          console.warn('[diff.applyMerge] Auto-commit hook failed:', err instanceof Error ? err.message : String(err)),
        );
      }
    } catch (persistErr) {
      logger.error('diff.applyMerge: persist FAILED', {
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
      throw persistErr;
    }

    return mergeResult;
  }, {
    requiresWorkspace: true,
    category: 'diff',
  });

  // ── diff.computeThreeWay ───────────────────────────────────────────────────
  registry.register('diff.computeThreeWay', async (payload, deps, ctx) => {
    const svc = createThreeWayDiffService(deps.dbModule);
    const { summary, result } = await svc.computeThreeWay(payload);
    ctx.storeThreeWayDiffResult(summary.diffId, result);
    return summary;
  }, {
    requiresWorkspace: true,
    category: 'diff',
  });

  // ── diff.getThreeWayResult ─────────────────────────────────────────────────
  registry.register('diff.getThreeWayResult', async ({ diffId }, _deps, ctx) => {
    return ctx.getThreeWayDiffResult(diffId) ?? null;
  }, {
    requiresWorkspace: false,
    category: 'diff',
  });

  // ── diff.applyThreeWayMerge ────────────────────────────────────────────────
  registry.register('diff.applyThreeWayMerge', async (payload, deps, ctx) => {
    const { diffId, targetNs, resolutions, workingDir } = payload;
    const logger = createDiffMergeLogger(path.join(workingDir, 'logs'));
    logger.info('diff.applyThreeWayMerge: start', {
      diffId,
      targetNs,
      resolutionCount: resolutions.length,
      workingDir,
    });
    const threeWayResult = ctx.getThreeWayDiffResult(diffId);
    if (!threeWayResult) {
      logger.error('diff.applyThreeWayMerge: three-way diff result not found in cache', { diffId });
      throw new Error(`Three-way diff result '${diffId}' not found. Re-compute before merging.`);
    }
    const svc = createMergeService(deps.dbModule);
    const mergeResult = await svc.applyThreeWayMerge({
      threeWayResult,
      targetNamespace: targetNs,
      conflictResolutions: resolutions,
    });
    logger.info('diff.applyThreeWayMerge: merge applied to DB', {
      diffId,
      targetNs,
      nodesAdded: mergeResult.nodesAdded,
      nodesModified: mergeResult.nodesModified,
      edgesAdded: mergeResult.edgesAdded,
      edgesModified: mergeResult.edgesModified,
    });

    // Persist the updated DB state to ria-data/ files so the merged content
    // is visible after restart and can be committed via git without a
    // separate explicit "Store" step.
    const persistLogger = deps.createLogger
      ? deps.createLogger(workingDir)
      : createImportLogger(path.join(workingDir, 'logs'));
    logger.info('diff.applyThreeWayMerge: persisting DB to ria-data/', { workingDir });
    try {
      await createPersistorService(deps.dbModule, persistLogger).store({ workingDir });
      logger.info('diff.applyThreeWayMerge: persist complete');
    } catch (persistErr) {
      logger.error('diff.applyThreeWayMerge: persist FAILED', {
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
      throw persistErr;
    }

    return mergeResult;
  }, {
    requiresWorkspace: true,
    category: 'diff',
  });
}
