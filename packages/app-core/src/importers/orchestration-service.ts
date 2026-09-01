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
 * orchestration-service.ts — Coordinates the full import lifecycle.
 *
 * Resolves the importer, loads config, registers the metamodel, begins a
 * session, executes the importer runtime, and completes or aborts the session.
 */

import * as path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Result, ImportConfigData } from '@riacore/app-contracts';
import { seedDefaultViews } from '../views/view-service.js';
import type {
  RunImportParams,
  ImportRunSummary,
  ImportRunStatus,
  ImportProgress,
  ImportSession,
} from '@riacore/app-contracts';
import {
  loadImportConfig as loadArxmlImportConfig,
  resolveFiles as resolveArxmlFiles,
} from '@riacore/importer-arxml';
import {
  loadImportConfig as loadSnImportConfig,
  buildDynamicSchemaForConfig,
  computeDynamicMetamodelName,
} from '@riacore/importer-sn';
import type { SnImportConfig } from '@riacore/importer-sn';
import {
  loadImportConfig as loadSysmlImportConfig,
  resolveFiles as resolveSysmlFiles,
} from '@riacore/importer-sysml-v2';
import {
  loadImportConfig as loadSysmlTextualImportConfig,
  resolveFiles as resolveSysmlTextualFiles,
} from '@riacore/importer-sysml-v2-textual';
import { resolveWorkspacePath } from '@riacore/importer-sdk';
import type { ImpactReport, CrossNsSnapshot, OrphanedEntry, OrphanedEntryWithContext, ListOrphanedEntriesParams } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import { computeFileDigest } from './file-digest.js';
import { parseLinkMLSchema } from './linkml-parser.js';
import { createImportWriteService } from './import-write-service.js';
import { createImporterRegistry } from './importer-registry.js';
import { createImportLogger } from '../infra/logger.js';
import { createImportCrossNsImpactService } from './import-crossns-impact-service.js';

export interface IImporterOrchestrationService {
  runImport(params: RunImportParams): Promise<Result<ImportRunSummary>>;
  getImportStatus(runId: string): Promise<ImportRunStatus | null>;
  getImpactReport(runId: string): ImpactReport | null;
  /** Aggregate all in-memory orphaned entries across all recent import runs. */
  listAllOrphanedEntries(params?: ListOrphanedEntriesParams): Promise<OrphanedEntryWithContext[]>;
  reconnectOrphanedEntry(entry: OrphanedEntry, newImportedNodeId: number): Promise<number>;
}

function affectedEdgeKey(edge: OrphanedEntry['affectedEdges'][number]): string {
  return [
    edge.authoredNamespace,
    edge.authoredStableId || `${edge.authoredConcept}:${edge.authoredName}`,
    edge.relationship,
    edge.sourceNamespace,
    edge.targetNamespace,
  ].join('\u0001');
}

/**
 * Collapse repeated sightings of the same deleted imported element across
 * import runs. The newest report supplies the context and node-ID hints, while
 * affected authored artifacts are merged without duplicates.
 */
export function aggregateOrphanedEntries(
  reports: Iterable<ImpactReport>,
): OrphanedEntryWithContext[] {
  const merged = new Map<string, OrphanedEntryWithContext>();
  for (const report of reports) {
    for (const entry of report.orphaned) {
      const key = `${report.namespace}\u0001${entry.concept}\u0001${entry.stablePath}`;
      const previous = merged.get(key);
      const edges = new Map<string, OrphanedEntry['affectedEdges'][number]>();
      for (const edge of previous?.affectedEdges ?? []) edges.set(affectedEdgeKey(edge), edge);
      // Later reports replace stale numeric node-ID hints for the same authored edge.
      for (const edge of entry.affectedEdges) edges.set(affectedEdgeKey(edge), edge);
      merged.set(key, {
        ...entry,
        affectedEdges: [...edges.values()],
        importedNamespace: report.namespace,
        runId: report.runId,
      });
    }
  }
  return [...merged.values()];
}

function parseAttributes(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stableIdFromAttributes(attributes: Record<string, unknown>): string {
  for (const key of ['uuid', 'id', 'stable_path']) {
    const value = attributes[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function displayNameFromAttributes(attributes: Record<string, unknown>): string {
  for (const key of ['name', 'short_name', 'has_name']) {
    const value = attributes[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertExistingDirectory(dir: string, label: string): void {
  if (!existsSync(dir)) {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`${label} is not a directory: ${dir}`);
  }
}

function normalizeFileSelection(files: { include?: string[]; exclude?: string[] } | undefined, defaultInclude: string[]) {
  return {
    include: Array.isArray(files?.include) && files.include.length > 0 ? files.include.map(String) : defaultInclude,
    exclude: Array.isArray(files?.exclude) ? files.exclude.map(String) : [],
  };
}

/**
 * Validate the resolved source inputs before touching the DB.
 *
 * `scanDir` is already absolute — resolved from `config.project_dir` against the
 * workspace root by the caller. This function must not resolve paths itself.
 */
function preflightImportInputs(
  descriptorName: string,
  scanDir: string,
  config: {
    project_dir?: string;
    scan_result_dir?: string;
    files?: { include?: string[]; exclude?: string[] };
  },
): void {
  if (descriptorName === 'arxml') {
    assertExistingDirectory(scanDir, 'Project directory');
    const selection = normalizeFileSelection(config.files, ['**/*.arxml']);
    const files = resolveArxmlFiles(scanDir, selection);
    if (files.length === 0) {
      throw new Error(`No ARXML files matched ${selection.include.join(', ')} under: ${scanDir}`);
    }
    return;
  }

  if (descriptorName === 'sysml_v2') {
    assertExistingDirectory(scanDir, 'Project directory');
    const selection = normalizeFileSelection(config.files, ['**/*.json']);
    const files = resolveSysmlFiles(scanDir, selection);
    if (files.length === 0) {
      throw new Error(`No SysML JSON files matched ${selection.include.join(', ')} under: ${scanDir}`);
    }
    return;
  }

  if (descriptorName === 'sysml_v2_textual') {
    assertExistingDirectory(scanDir, 'SysML root directory');
    const selection = normalizeFileSelection(config.files, ['**/*.sysml']);
    const files = resolveSysmlTextualFiles(scanDir, selection);
    if (files.length === 0) {
      throw new Error(`No .sysml files matched ${selection.include.join(', ')} under: ${scanDir}`);
    }
    return;
  }
}

function loadConfigForDescriptor(
  descriptorName: string,
  configPath: string,
): {
  namespace: string;
  source_name?: string;
  base_url?: string;
  project_dir?: string;
  needs_file?: string;
  version?: string;
  scan_result_dir?: string;
  files?: { include?: string[]; exclude?: string[] };
  elements?: unknown;
} {
  if (descriptorName === 'sphinx_needs') {
    return loadSnImportConfig(configPath);
  }

  if (descriptorName === 'sysml_v2') {
    return loadSysmlImportConfig(configPath);
  }

  if (descriptorName === 'sysml_v2_textual') {
    return loadSysmlTextualImportConfig(configPath);
  }

  return loadArxmlImportConfig(configPath);
}

export function createImporterOrchestrationService(
  dbModule: IDbModule,
): IImporterOrchestrationService {
  // Keep run state scoped to this orchestration instance. This prevents separate
  // CLI/test/service instances in the same process from sharing report objects.
  const runStatusMap = new Map<string, ImportRunStatus>();
  const impactReportMap = new Map<string, ImpactReport>();
  const registry = createImporterRegistry();
  const writeService = createImportWriteService(dbModule);
  const impactService = createImportCrossNsImpactService(dbModule);

  function publishProgress(runId: string, progress: ImportProgress): void {
    const existing = runStatusMap.get(runId);
    if (existing) existing.progress = progress;
  }

  return {
    async runImport(params: RunImportParams): Promise<Result<ImportRunSummary>> {
      const logger = createImportLogger(path.join(params.workingDir, 'logs'));

      // Step 1: Resolve importer — by configData sourceType if available, else by file path
      const descriptor = params.configData
        ? registry.findBySourceType(params.configData.sourceType ?? '') ?? registry.resolve(params.configPath)
        : registry.resolve(params.configPath);
      if (!descriptor) {
        logger.error('No importer found', { configPath: params.configPath });
        return { ok: false, error: `No importer found for config: ${params.configPath}` };
      }

      // Step 2: Load config — use configData directly if provided, else read from file
      let config: {
        namespace: string;
        source_name?: string;
        base_url?: string;
        project_dir?: string;
        needs_file?: string;
        version?: string;
        scan_result_dir?: string;
        files?: { include?: string[]; exclude?: string[] };
        elements?: unknown;
      };
      if (params.configData) {
        const cd: ImportConfigData = params.configData;
        config = {
          base_url: 'http://localhost:8080',
          namespace: cd.namespace,
          source_name: cd.source_name,
          project_dir: cd.project_dir,
          scan_result_dir: cd.scan_result_dir,
          needs_file: cd.needs_file,
          files: { include: cd.files_include ?? [], exclude: cd.files_exclude ?? [] },
          elements: cd.elements ?? {},
        };
      } else {
        try {
          config = loadConfigForDescriptor(descriptor.name, params.configPath);
        } catch (err) {
          return { ok: false, error: `Failed to load config: ${errorMessage(err)}` };
        }
      }

      // ── The single path-resolution point ──────────────────────────────────
      // Every relative path in an import config is anchored at the workspace
      // root. Resolve once here; everything downstream receives absolute paths.
      const workspaceRoot = path.resolve(params.workingDir);
      const sourceDir = resolveWorkspacePath(workspaceRoot, config.project_dir, workspaceRoot);

      try {
        preflightImportInputs(descriptor.name, sourceDir, config);
      } catch (err) {
        logger.error('Import preflight failed', { error: errorMessage(err) });
        logger.close();
        return { ok: false, error: `Import preflight failed: ${errorMessage(err)}` };
      }

      // Step 3: Compute file digests (config digest skipped when using DB config)
      let configDigest = '';
      let metamodelDigest = '';
      try {
        if (!params.configData) configDigest = computeFileDigest(params.configPath);
        metamodelDigest = computeFileDigest(descriptor.metamodelPath);
      } catch (err) {
        return { ok: false, error: `Failed to compute file digest: ${errorMessage(err)}` };
      }

      // Step 4: Register metamodel (idempotent)
      const metamodelName = descriptor.name === 'arxml'
        ? 'SW_ARXML'
        : descriptor.name === 'sysml_v2'
          ? 'SysMLv2'
          : descriptor.name === 'sysml_v2_textual'
            ? 'SysMLv2Textual'
            : descriptor.name === 'sphinx_needs'
            ? computeDynamicMetamodelName(config.namespace)
            : descriptor.name;
      try {
        const schema = descriptor.name === 'sphinx_needs'
          ? buildDynamicSchemaForConfig(config as SnImportConfig, sourceDir, workspaceRoot).schema
          : parseLinkMLSchema(descriptor.metamodelPath);
        await writeService.registerMetamodelFromSchema(schema, metamodelName);
      } catch (err) {
        logger.error('Failed to register metamodel', { error: errorMessage(err) });
        return { ok: false, error: `Failed to register metamodel: ${errorMessage(err)}` };
      }


      const sessionConfigData: ImportConfigData = params.configData ?? {
        namespace: config.namespace,
        source_name: config.source_name ?? config.namespace,
        project_dir: config.project_dir,
        scan_result_dir: config.scan_result_dir,
        files_include: config.files?.include ?? [],
        files_exclude: config.files?.exclude ?? [],
        elements: (config.elements && typeof config.elements === 'object')
          ? config.elements as Record<string, boolean>
          : {},
        sourceType: descriptor.sourceType,
      };

      // Step 4b: Snapshot boundary nodes before wipe (fail-safe)
      let crossNsSnapshot: CrossNsSnapshot | null = null;
      try {
        crossNsSnapshot = await impactService.snapshotBoundary(config.namespace);
      } catch (snapshotErr) {
        logger.error(
          `Boundary snapshot failed for namespace '${config.namespace}': ${errorMessage(snapshotErr)}`,
        );
      }

      // Step 5: Begin import session
      let session: ImportSession;
      try {
        session = await writeService.beginSession({
          namespace: config.namespace,
          metamodel: metamodelName,
          sourceName: config.source_name ?? config.namespace,
          sourceType: descriptor.sourceType,
          configPath: params.configPath,
          configDigest,
          metamodelPath: descriptor.metamodelPath,
          metamodelDigest,
          triggeredBy: params.triggeredBy,
          importerVersion: descriptor.version,
          // Use caller-specified role when provided (e.g. 'supervised_update_temp' for
          // supervised-update temp namespaces); default to 'imported' for normal imports.
          namespaceRole: params.namespaceRole ?? 'imported',
          namespaceOwningApplication: 'Automotive-SW-Arch',
          configData: sessionConfigData,
          // Propagate: when true, the write service will not overwrite config_data
          // for existing sources (used by git-ref branch imports where project_dir
          // has been temporarily remapped to a checkout directory).
          preserveStoredConfigData: params.preserveStoredConfigData,
        });
      } catch (err) {
        logger.error('Failed to begin import session', { error: errorMessage(err) });
        return { ok: false, error: `Failed to begin import session: ${errorMessage(err)}` };
      }

      logger.info('Import started', {
        runId: session.runId,
        namespace: config.namespace,
        metamodel: metamodelName,
        configPath: params.configPath,
        triggeredBy: params.triggeredBy,
      });

      // Track status
      runStatusMap.set(session.runId, { runId: session.runId, status: 'running' });

      // Step 6: Execute importer runtime
      const runtime = descriptor.createRuntime();

      try {
        const result = await runtime.run({
          session,
          config,
          configPath: params.configPath,
          workspaceRoot,
          projectDir: sourceDir,
          writeService,
          onProgress: (progress) => {
            publishProgress(session.runId, progress);
            if (progress.message.startsWith('[SKIPPED_ELEMENTS]')) {
              logger.warn(progress.message.replace('[SKIPPED_ELEMENTS] ', ''));
            }
            (params as { onProgress?: (p: typeof progress) => void }).onProgress?.(progress);
          },
        });

        // Step 7: Complete session
        await writeService.completeSession(session, result.stats);

        // Step 7c: Classify boundary impact (fail-safe)
        let impactReport: ImpactReport | null = null;
        if (crossNsSnapshot) {
          try {
            impactReport = await impactService.classifyImpact(
              crossNsSnapshot,
              config.namespace,
              session.runId,
            );
          } catch (classifyErr) {
            logger.error(
              `Boundary impact classification failed for namespace '${config.namespace}': ${errorMessage(classifyErr)}`,
            );
          }
        }

        // Step 7d: Reconnect stable and modified boundary edges (fail-safe)
        if (impactReport && crossNsSnapshot) {
          try {
            const reconnected = await impactService.reconnectEdges(
              crossNsSnapshot,
              impactReport,
              config.namespace,
            );
            if (reconnected > 0) {
              logger.info(`Reconnected ${reconnected} cross-namespace edge(s) for stable/modified boundary nodes`);
            }
          } catch (reconnectErr) {
            logger.error(
              `Boundary edge reconnection failed for namespace '${config.namespace}': ${errorMessage(reconnectErr)}`,
            );
          }
        }

        // Log only the count. Full source paths can be numerous and may expose
        // project layout without adding useful incident-diagnosis signal.
        const parsedFiles = (result as { parsedFiles?: string[] }).parsedFiles;
        if (parsedFiles && parsedFiles.length > 0) {
          logger.info(`Parsed ${parsedFiles.length} source file(s)`);
        }

        // Log skipped element types
        const skippedElements = (result as { skippedElements?: Record<string, number> }).skippedElements;
        if (skippedElements && Object.keys(skippedElements).length > 0) {
          const sorted = Object.entries(skippedElements).sort((a, b) => b[1] - a[1]);
          logger.warn(
            `Skipped ${sorted.length} unrecognised element type(s) — not in metamodel`,
            { skipped: Object.fromEntries(sorted) },
          );
        }

        logger.info('Import completed', {
          runId: session.runId,
          namespace: session.namespace,
          conceptsCreated: result.stats.conceptsCreated,
          relationshipsCreated: result.stats.relationshipsCreated,
          filesProcessed: result.stats.filesProcessed,
          durationMs: result.stats.durationMs,
        });

        const summary: ImportRunSummary = {
          runId: session.runId,
          sourceId: session.sourceId,
          namespace: session.namespace,
          metamodel: session.metamodel,
          status: 'completed',
          stats: result.stats,
          startedAt: session.startedAt,
          completedAt: new Date().toISOString(),
          triggeredBy: session.triggeredBy,
        };

        // Attach impact report and populate boundary counters
        if (impactReport) {
          summary.impactReport = impactReport;
          summary.stats = {
            ...summary.stats,
            boundaryNodesChecked: crossNsSnapshot!.boundaryNodes.length,
            orphanedBoundaryNodes: impactReport.orphaned.length,
            modifiedBoundaryNodes: impactReport.modified.length,
          };
          impactReportMap.set(session.runId, impactReport);

          // Keep the log useful without serializing the complete impact report,
          // which may contain model attributes and a large number of edges.
          const hasImpact = impactReport.orphaned.length > 0 || impactReport.modified.length > 0;
          if (hasImpact) {
            logger.info(
              `Boundary impact: ${impactReport.orphaned.length} orphaned, ${impactReport.modified.length} modified, ${impactReport.stableCount} stable`,
              {
                orphanedCount: impactReport.orphaned.length,
                modifiedCount: impactReport.modified.length,
                stableCount: impactReport.stableCount,
              },
            );
          } else {
            logger.info('No cross-namespace boundary impact detected', {
              stableCount: impactReport.stableCount,
            });
          }
        }

        runStatusMap.set(session.runId, {
          runId: session.runId,
          status: 'completed',
          stats: result.stats,
        });

        // The import just created (or replaced) an imported namespace, so give
        // it a default CommonModel view if it has none. Here rather than in the
        // import channel handler because the CLI calls `runImport` directly and
        // never goes through the dispatcher; idempotent, so it is a no-op on a
        // re-import. Best-effort — a completed import is not failed by this.
        await seedDefaultViews(dbModule, logger, 'import');

        return { ok: true, data: summary };
      } catch (err) {
        await writeService.abortSession(session, errorMessage(err));
        logger.error('Import failed', { runId: session.runId, error: errorMessage(err) });
        runStatusMap.set(session.runId, { runId: session.runId, status: 'failed' });
        return { ok: false, error: `Import failed: ${errorMessage(err)}` };
      } finally {
        // Close the log stream so the file handle is released immediately.
        // Without this, the WriteStream stays open until the process exits,
        // which blocks directory deletion on Windows (EPERM on rmSync).
        logger.close();
      }
    },

    async getImportStatus(runId: string): Promise<ImportRunStatus | null> {
      return runStatusMap.get(runId) ?? null;
    },

    getImpactReport(runId: string): ImpactReport | null {
      return impactReportMap.get(runId) ?? null;
    },

    async listAllOrphanedEntries(params?: ListOrphanedEntriesParams): Promise<OrphanedEntryWithContext[]> {
      const analysisNamespace = params?.analysisNamespace?.trim();
      const targetNodeId = params?.targetNodeId;

      // The reconnect context menu must work after an app rebuild/restart, when
      // no in-memory ImpactReport exists. Derive the candidates from the live
      // graph: every malfunction in the active analysis with no occurs_at edge.
      if (analysisNamespace && Number.isFinite(targetNodeId)) {
        const targetRows = await dbModule.runQuery(
          `MATCH (target:RIA_UNIV_ConceptInstance {node_id: $targetNodeId})
           RETURN target.namespace AS namespace, target.concept AS concept,
                  target.attributes AS attributes`,
          { targetNodeId },
        );
        if (targetRows.length === 0) return [];

        const malfunctionRows = await dbModule.runQuery(
          `MATCH (fm:RIA_UNIV_ConceptInstance)
           WHERE fm.namespace = $analysisNamespace AND fm.concept = 'malfunction'
           OPTIONAL MATCH (fm)-[occurs:RIA_UNIV_CROSSNS_INSTANCE_REL]->(:RIA_UNIV_ConceptInstance)
           WHERE occurs.relationship = 'occurs_at'
           WITH fm, count(occurs) AS occursCount
           WHERE occursCount = 0
           RETURN fm.node_id AS nodeId, fm.attributes AS attributes
           ORDER BY fm.node_id`,
          { analysisNamespace },
        );
        if (malfunctionRows.length === 0) return [];

        const metamodelRows = await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace {name: $analysisNamespace})
           OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
           RETURN coalesce(mm.name, ns.metamodel, 'SAFETY_ANALYSIS') AS metamodel
           LIMIT 1`,
          { analysisNamespace },
        );
        const metamodel = String(metamodelRows[0]?.metamodel ?? 'SAFETY_ANALYSIS');
        const importedNamespace = String(targetRows[0].namespace ?? '');
        const concept = String(targetRows[0].concept ?? '');
        const targetAttributes = parseAttributes(targetRows[0].attributes);
        const targetStablePath = typeof targetAttributes.stable_path === 'string'
          ? targetAttributes.stable_path
          : `node:${targetNodeId}`;

        return [{
          stablePath: targetStablePath,
          concept,
          attributes: { ...targetAttributes, currentModelOrphans: true },
          affectedEdges: malfunctionRows.map((row) => {
            const attributes = parseAttributes(row.attributes);
            return {
              relationship: 'occurs_at',
              metamodel,
              sourceNamespace: analysisNamespace,
              targetNamespace: importedNamespace,
              authoredNodeId: Number(row.nodeId),
              authoredNamespace: analysisNamespace,
              authoredConcept: 'malfunction',
              authoredName: displayNameFromAttributes(attributes),
              authoredStableId: stableIdFromAttributes(attributes),
            };
          }),
          importedNamespace,
          runId: `current-model:${analysisNamespace}:${targetNodeId}`,
        }];
      }

      // CLI/report callers without a selected target retain the historical view.
      return aggregateOrphanedEntries(impactReportMap.values());
    },

    async reconnectOrphanedEntry(entry: OrphanedEntry, newImportedNodeId: number): Promise<number> {
      const reconnected = await impactService.reconnectOrphanedEntry(entry, newImportedNodeId);
      if (reconnected > 0) {
        const firstEdge = entry.affectedEdges[0];
        const inferredImportedNamespace = firstEdge
          ? (firstEdge.sourceNamespace === firstEdge.authoredNamespace
              ? firstEdge.targetNamespace
              : firstEdge.sourceNamespace)
          : undefined;
        const importedNamespace =
          (entry as Partial<OrphanedEntryWithContext>).importedNamespace
          ?? inferredImportedNamespace;
        // A successful reconnect resolves this deleted boundary element in every
        // historical report, so it must disappear from future picker results.
        for (const report of impactReportMap.values()) {
          if (importedNamespace && report.namespace !== importedNamespace) continue;
          report.orphaned = report.orphaned.filter(
            (candidate) => candidate.stablePath !== entry.stablePath || candidate.concept !== entry.concept,
          );
        }
      }
      return reconnected;
    },
  };
}
