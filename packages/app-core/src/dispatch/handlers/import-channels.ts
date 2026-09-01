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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ImportSourceInfo, ImportConfigView, ImportConfigData, DiffSummary, NamespaceDiffResult, ArxmlTreeData } from '@riacore/app-contracts';
import type { IGitService } from '@riacore/git-service';
import { normalizeStoredPath, resolveWorkspacePath } from '@riacore/importer-sdk';
import type { createRegistry } from '../channel-registry.js';
import { e } from '../utils/cypher.js';
import { deleteNamespace } from '../../persistor/persistor-helpers.js';
import { createDiffService } from '../../diff/diff-service.js';
import { createImportLogger } from '../../infra/logger.js';

// ── Source config helpers ──────────────────────────────────────────────────────

interface SourceConfigMeta {
  configPath?: string;
  configDigest?: string;
  metamodelPath?: string;
  metamodelDigest?: string;
  configDirty?: boolean;
  lastAppliedAt?: string;
  /** Branch or tag name from which the last successful git-based import was loaded. */
  lastImportBranch?: string;
  /** Full commit hash at the time of the last successful git-based import. */
  lastImportCommitId?: string;
}

// ── Import git metadata file helpers ─────────────────────────────────────────

interface ImportGitMetadataSource {
  lastImportBranch: string;
  lastImportCommitId: string;
  lastImportAt: string;
}

interface ImportGitMetadataFile {
  version: 1;
  sources: Record<string, ImportGitMetadataSource>;
}

function readImportGitMetadata(workingDir: string): ImportGitMetadataFile {
  const filePath = path.join(workingDir, 'ria-config', 'import-git-metadata.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ImportGitMetadataFile;
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.sources) {
      return parsed;
    }
    return { version: 1, sources: {} };
  } catch {
    return { version: 1, sources: {} };
  }
}

function writeImportGitMetadata(workingDir: string, data: ImportGitMetadataFile): void {
  const dir = path.join(workingDir, 'ria-config');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'import-git-metadata.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Records the branch and commit provenance for a source after a successful
 * git-based import. Updates both the DB source config meta and the
 * ria-config/import-git-metadata.json file.
 */
async function recordGitImportProvenance(
  dbModule: { runQuery(q: string, p?: Record<string, unknown>): Promise<Record<string, unknown>[]> },
  sourceId: string,
  branch: string,
  commitId: string,
  workingDir: string,
  configRaw: unknown,
): Promise<void> {
  // Update DB source config meta
  const newMeta = serializeSourceConfigMeta(configRaw, {
    lastImportBranch: branch,
    lastImportCommitId: commitId,
  });
  await dbModule.runQuery(
    `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(sourceId)}'
     SET s.config = '${e(newMeta)}'`,
  );

  // Update the JSON provenance file (best-effort — do not throw if it fails)
  try {
    const meta = readImportGitMetadata(workingDir);
    meta.sources[sourceId] = {
      lastImportBranch: branch,
      lastImportCommitId: commitId,
      lastImportAt: new Date().toISOString(),
    };
    writeImportGitMetadata(workingDir, meta);
  } catch (err) {
    console.warn(`[recordGitImportProvenance] Failed to write import-git-metadata.json: ${String(err)}`);
  }
}

function parseSourceConfigMeta(raw: unknown): SourceConfigMeta {
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as SourceConfigMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serializeSourceConfigMeta(raw: unknown, patch: Partial<SourceConfigMeta>): string {
  const merged: Record<string, unknown> = { ...parseSourceConfigMeta(raw) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return JSON.stringify(merged);
}

function getSourceConfigPath(row: Record<string, unknown>): string | undefined {
  const directPath = row['s.config_path'];
  if (typeof directPath === 'string' && directPath.length > 0) return directPath;
  if (directPath !== undefined && directPath !== null) {
    const coerced = String(directPath);
    if (coerced.length > 0) return coerced;
  }
  const meta = parseSourceConfigMeta(row['s.config']);
  return typeof meta.configPath === 'string' && meta.configPath.length > 0
    ? meta.configPath
    : undefined;
}

function buildImportConfigDataFromYaml(
  sourceType: string,
  parsed: Record<string, unknown>,
  fallback: { namespace?: string; sourceName?: string },
): ImportConfigData {
  const files = (parsed.files ?? {}) as { include?: unknown[]; exclude?: unknown[] };
  const isArxml = sourceType === 'arxml_file' || sourceType === 'arxml';

  return {
    namespace: typeof parsed.namespace === 'string' && parsed.namespace.length > 0
      ? parsed.namespace
      : (fallback.namespace ?? ''),
    source_name: typeof parsed.source_name === 'string' && parsed.source_name.length > 0
      ? parsed.source_name
      : (fallback.sourceName ?? fallback.namespace ?? ''),
    sourceType,
    project_dir: typeof parsed.project_dir === 'string' && parsed.project_dir.length > 0
      ? parsed.project_dir
      : undefined,
    scan_result_dir: typeof parsed.scan_result_dir === 'string' && parsed.scan_result_dir.length > 0
      ? parsed.scan_result_dir
      : undefined,
    files_include: Array.isArray(files.include)
      ? files.include.map(String)
      : (isArxml ? ['**/*.arxml'] : []),
    files_exclude: Array.isArray(files.exclude) ? files.exclude.map(String) : [],
    elements: (parsed.elements && typeof parsed.elements === 'object')
      ? parsed.elements as Record<string, boolean>
      : {},
  };
}

export async function ensureSourceConfigData(
  dbModule: { runQuery(q: string, p?: Record<string, unknown>): Promise<Record<string, unknown>[]> },
  sourceId: string,
  row: Record<string, unknown>,
  missingConfigMessage: string,
): Promise<{ configData: ImportConfigData; configPath?: string }> {
  const configDataRaw = row['s.config_data'] ? String(row['s.config_data']) : '';
  if (configDataRaw) {
    try {
      return {
        configData: JSON.parse(configDataRaw) as ImportConfigData,
        configPath: getSourceConfigPath(row),
      };
    } catch {
      // Fall back to YAML re-hydration below.
    }
  }

  const configPath = getSourceConfigPath(row);
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(missingConfigMessage);
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    parsed = parseYaml(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('YAML did not parse to an object');
    }
  } catch {
    throw new Error(missingConfigMessage);
  }

  const sourceType = String(row['s.source_type'] ?? parsed.sourceType ?? '');
  const configData = buildImportConfigDataFromYaml(sourceType, parsed, {
    namespace: String(row['s.target_namespace'] ?? parsed.namespace ?? ''),
    sourceName: String(row['s.name'] ?? parsed.source_name ?? ''),
  });

  const configDataJson = JSON.stringify(configData);
  const sourceMetaJson = serializeSourceConfigMeta(row['s.config'], { configPath });
  const now = new Date().toISOString();
  await dbModule.runQuery(
    `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(sourceId)}'
     SET s.config_data = '${e(configDataJson)}',
         s.config_path = '${e(configPath)}',
         s.config = '${e(sourceMetaJson)}',
         s.updated_at = '${e(now)}'`,
  );

  return { configData, configPath };
}

function parseAttributes(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Channel registration ───────────────────────────────────────────────────────

// ── Git-ref checkout helper ────────────────────────────────────────────────────

/**
 * Validates that an absolute path is within the given repo root.
 * Returns the POSIX-relative path (forward slashes, no leading `..`).
 */
function requireWithinRepo(absPath: string, repoDir: string, label: string): string {
  const rel = path.relative(repoDir, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `${label} '${absPath}' is not within the git repository at '${repoDir}'. ` +
      `Only source files inside the repository can be loaded from a git ref.`,
    );
  }
  // Normalize to POSIX separators for git compatibility; use '.' when the
  // path is the repo root itself (rel === '') to avoid an empty pathspec.
  const posix = rel.replace(/\\/g, '/');
  return posix === '' ? '.' : posix;
}

/**
 * Checks out the source files at a specific git ref to a temporary directory,
 * and returns an ImportConfigData with the paths remapped to that temp dir.
 *
 * The git repository is auto-detected from the import source's `project_dir`
 * by walking up the directory tree to find a `.git` directory. This means
 * the source data may live in a completely different repository from the RIA
 * workspace — both layouts are supported:
 *   - Source data in a separate repo (external project repo)
 *   - Source data in the same repo as the RIA workspace
 *
 * All path operations (sparse-checkout patterns, temp-dir remapping) are
 * performed relative to the auto-detected repository root.
 */
async function checkoutSourceToRef(
  gitService: IGitService,
  ref: string,
  configData: ImportConfigData,
  sourceType: string,
  defaultInclude: string[],
  workspaceRoot: string,
): Promise<{ overriddenConfigData: ImportConfigData; checkedOutTempDir: string; gitRoot: string }> {
  const configuredProjectDir = typeof configData.project_dir === 'string' ? configData.project_dir : '';

  if (!configuredProjectDir) {
    throw new Error(`Source has no file paths (project_dir) configured — cannot load from a git ref.`);
  }

  // Git needs real filesystem paths: resolve the workspace-relative config
  // values to absolute before any repo-root discovery or containment check.
  const projectDir = resolveWorkspacePath(workspaceRoot, configuredProjectDir);

  // Discover the git repository that owns the source data by starting at
  // project_dir and walking up. This is the key design principle: the repo
  // is determined by the source data location, not the workspace config.
  const repoRootResult = await gitService.getRepoRoot(projectDir);
  if (!repoRootResult.ok || !repoRootResult.data) {
    throw new Error(
      `The import source data at '${projectDir}' is not inside a git repository. ` +
      `Branch-based updates require the source data to be tracked in git.`,
    );
  }
  const gitRoot = repoRootResult.data;

  const scanResultDir = typeof configData.scan_result_dir === 'string' && configData.scan_result_dir
    ? resolveWorkspacePath(workspaceRoot, configData.scan_result_dir)
    : undefined;
  const needsFile = typeof configData.needs_file === 'string' && configData.needs_file
    ? resolveWorkspacePath(workspaceRoot, configData.needs_file)
    : undefined;

  const pathsToCheckout: string[] = [];
  const relProjectDir = requireWithinRepo(projectDir, gitRoot, 'project_dir');
  const relScanResultDir = scanResultDir ? requireWithinRepo(scanResultDir, gitRoot, 'scan_result_dir') : undefined;
  const relNeedsFile = needsFile ? requireWithinRepo(needsFile, gitRoot, 'needs_file') : undefined;

  pathsToCheckout.push(relProjectDir);
  if (relScanResultDir) pathsToCheckout.push(relScanResultDir);
  if (relNeedsFile) pathsToCheckout.push(relNeedsFile);

  const checkoutResult = await gitService.checkoutCommitToTemp({
    repoDir: gitRoot,
    commitHash: ref,
    paths: pathsToCheckout,
  });
  if (!checkoutResult.ok) {
    if (checkoutResult.error.kind === 'paths-not-found') {
      throw new Error(
        `The source data files were not found on branch/ref '${ref}'. ` +
        `The paths configured for this import source do not exist on this branch. ` +
        `Please verify that the source files were committed to this branch.`,
      );
    }
    throw new Error(checkoutResult.error.message);
  }
  const tempDir = checkoutResult.data;

  const remapAbs = (relPosixPath: string): string => path.join(tempDir, relPosixPath);

  return {
    overriddenConfigData: {
      namespace:       String(configData.namespace ?? ''),
      source_name:     String(configData.source_name ?? ''),
      project_dir:     remapAbs(relProjectDir),
      scan_result_dir: relScanResultDir ? remapAbs(relScanResultDir) : undefined,
      needs_file:      relNeedsFile ? remapAbs(relNeedsFile) : undefined,
      files_include:   Array.isArray(configData.files_include) ? configData.files_include.map(String) : defaultInclude,
      files_exclude:   Array.isArray(configData.files_exclude) ? configData.files_exclude.map(String) : [],
      elements:        (configData.elements && typeof configData.elements === 'object') ? configData.elements as Record<string, boolean> : {},
      sourceType,
    },
    checkedOutTempDir: tempDir,
    gitRoot,
  };
}

/**
 * Register import channels.
 */
export function registerImportChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── imports.run ──────────────────────────────────────────────────────────────
  // Default views for the imported namespace are seeded inside
  // `orchestration.runImport` itself, not here: the CLI calls that service
  // directly and never reaches this handler.
  registry.register('imports.run', async (payload, deps, _ctx) => {
    if (!deps.orchestration) throw new Error('Import orchestration not configured');
    const result = await deps.orchestration.runImport(payload);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.getStatus ────────────────────────────────────────────────────────
  registry.register('imports.getStatus', async (payload, deps, _ctx) => {
    if (!deps.orchestration) return null;
    return deps.orchestration.getImportStatus(payload?.runId ?? '');
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.listSources ──────────────────────────────────────────────────────
  // Excludes sources that target a supervised_update_temp namespace so that
  // transient supervised-update artefacts are never shown in the source list.
  // Uses a property-based namespace lookup (not an edge traversal) so the check
  // remains correct even if the RIA_SRC_TARGETS_NS edge was removed by a
  // DETACH DELETE on the namespace node during cleanup.
  registry.register('imports.listSources', async (_payload, deps, _ctx) => {
    const sourceRows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source)
       WHERE NOT EXISTS {
         MATCH (ns:RIA_UNIV_Namespace)
         WHERE ns.name = s.target_namespace
           AND ns.namespace_role = 'supervised_update_temp'
       }
       RETURN s.source_id AS sourceId,
              s.name AS name,
              s.source_type AS sourceType,
              s.target_namespace AS targetNamespace,
              s.target_metamodel AS targetMetamodel,
              s.importer_version AS importerVersion,
              s.updated_at AS updatedAt,
              s.config AS config`,
    );

    const runRows = await deps.dbModule.runQuery(
      `MATCH (r:RIA_SRC_ImportRun)-[:RIA_SRC_RUN_FOR]->(s:RIA_SRC_Source)
       RETURN s.source_id AS sourceId,
              r.status AS status,
              r.completed_at AS completedAt
       ORDER BY r.started_at DESC`,
    );

    const latestRun = new Map<string, { status: string; completedAt: string }>();
    for (const r of runRows) {
      const sid = String(r.sourceId ?? '');
      if (!latestRun.has(sid)) {
        latestRun.set(sid, { status: String(r.status ?? ''), completedAt: String(r.completedAt ?? '') });
      }
    }

    return sourceRows.map((r): ImportSourceInfo => {
      const run = latestRun.get(String(r.sourceId ?? ''));
      const sourceMeta = parseSourceConfigMeta(r.config);
      return {
        sourceId:        String(r.sourceId ?? ''),
        name:            String(r.name ?? ''),
        sourceType:      String(r.sourceType ?? ''),
        targetNamespace: String(r.targetNamespace ?? ''),
        targetMetamodel: String(r.targetMetamodel ?? ''),
        importerVersion: String(r.importerVersion ?? ''),
        updatedAt:       String(r.updatedAt ?? ''),
        lastRunStatus:   (run?.status as ImportSourceInfo['lastRunStatus']) ?? null,
        lastRunAt:       run?.completedAt || null,
        configDirty:         sourceMeta.configDirty === true,
        lastImportBranch:   typeof sourceMeta.lastImportBranch === 'string' ? sourceMeta.lastImportBranch : undefined,
        lastImportCommitId: typeof sourceMeta.lastImportCommitId === 'string' ? sourceMeta.lastImportCommitId : undefined,
      };
    });
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.getConfig ────────────────────────────────────────────────────────
  registry.register('imports.getConfig', async (payload, deps, _ctx) => {
    const { sourceId } = payload;
    const rows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId
       RETURN s.config_data, s.name, s.target_namespace, s.source_type, s.config_path, s.config`,
      { sourceId },
    );
    if (!rows.length) throw new Error(`No source found: ${sourceId}`);
    const row = rows[0];
    const { configData, configPath } = await ensureSourceConfigData(
      deps.dbModule, sourceId, row,
      `Source '${sourceId}' has no config_data. Re-provision or use 'config import' to load configuration.`,
    );

    const sourceType = String(row['s.source_type'] ?? configData.sourceType ?? '');
    const isArxml = sourceType === 'arxml_file' || sourceType === 'arxml';

    const DEFAULT_ELEMENTS: Record<string, boolean> = {
      swc_types: true, ports: true, port_interfaces: true, data_types: true,
      swc_behavior: true, bsw_modules: true, connectors: true,
      communication: true, system: true, ecuc: true,
    };
    const elements: Record<string, boolean> = isArxml
      ? { ...DEFAULT_ELEMENTS, ...(configData.elements ?? {}) }
      : (configData.elements ?? {});

    // Resolve the stored (possibly workspace-relative) project_dir once, here, so
    // the renderer can hand a real filesystem path to git/fs channels. The stored
    // value is returned unchanged alongside it for editing.
    const storedProjectDir = configData.project_dir ?? '';
    const wsStatus = await deps.workspaceService.getStatus();
    const workspaceRoot = wsStatus.state === 'open' ? wsStatus.info.workingDir : '';

    const view: ImportConfigView = {
      sourceId,
      sourceType,
      namespace:     configData.namespace ?? String(row['s.target_namespace'] ?? ''),
      sourceName:    configData.source_name ?? String(row['s.name'] ?? ''),
      projectDir:    storedProjectDir,
      projectDirAbsolute: storedProjectDir && workspaceRoot
        ? resolveWorkspacePath(workspaceRoot, storedProjectDir)
        : storedProjectDir,
      scanResultDir: configData.scan_result_dir,
      needsFile:     configData.needs_file,
      filesInclude:  Array.isArray(configData.files_include) ? configData.files_include.map(String) : (isArxml ? ['**/*.arxml'] : []),
      filesExclude:  Array.isArray(configData.files_exclude) ? configData.files_exclude.map(String) : [],
      elements,
      ...(configPath ? { configPath } : {}),
    };
    return view;
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.saveConfig ───────────────────────────────────────────────────────
  registry.register('imports.saveConfig', async (payload, deps, _ctx) => {
    const params = payload;
    const rows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId RETURN s.config AS config`,
      { sourceId: params.sourceId },
    );
    if (!rows.length) throw new Error(`No source found: ${params.sourceId}`);

    // Store path fields exactly as entered, normalising separators only. Whether
    // a path is relative or absolute is the user's choice, decided when they pick
    // a folder (the picker returns a workspace-relative path) or when they type
    // one. Saving must never re-anchor it.
    const projectDir = normalizeStoredPath(params.projectDir);
    const scanResultDir = normalizeStoredPath(params.scanResultDir) || undefined;
    const needsFile = normalizeStoredPath(params.needsFile) || undefined;

    const configData = JSON.stringify({
      namespace: params.namespace,
      source_name: params.sourceName,
      sourceType: params.sourceType,
      project_dir: projectDir,
      scan_result_dir: scanResultDir,
      needs_file: needsFile,
      files_include: params.filesInclude,
      files_exclude: params.filesExclude,
      elements: params.elements,
    });

    const sourceMetaJson = serializeSourceConfigMeta(rows[0].config, {
      configPath: params.configPath,
      configDirty: true,
    });

    const configPathSet = params.configPath
      ? `,\n             s.config_path = '${e(params.configPath)}'`
      : '';

    const now = new Date().toISOString();
    await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(params.sourceId)}'
       SET s.config_data = '${e(configData)}',
           s.config = '${e(sourceMetaJson)}',
           s.name = '${e(params.sourceName)}',
           s.updated_at = '${e(now)}'${configPathSet}`,
    );

    // Keep the YAML file on disk in sync with the DB record.
    // The file is the secondary artifact (DB is primary), but it must reflect
    // the saved values so that re-running via CLI or re-opening the config
    // drawer shows the correct project_dir / source_name / etc.
    const yamlPath = params.configPath ?? parseSourceConfigMeta(rows[0].config).configPath;
    if (yamlPath) {
      const yamlDoc: Record<string, unknown> = {
        namespace: params.namespace,
        source_name: params.sourceName,
      };
      if (projectDir) yamlDoc.project_dir = projectDir;
      if (scanResultDir) yamlDoc.scan_result_dir = scanResultDir;
      if (needsFile) yamlDoc.needs_file = needsFile;
      const include = Array.isArray(params.filesInclude) ? params.filesInclude : [];
      const exclude = Array.isArray(params.filesExclude) ? params.filesExclude : [];
      if (include.length > 0 || exclude.length > 0) {
        yamlDoc.files = { include, exclude };
      }
      if (params.elements && typeof params.elements === 'object' && Object.keys(params.elements).length > 0) {
        yamlDoc.elements = params.elements;
      }
      try {
        fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
        fs.writeFileSync(yamlPath, stringifyYaml(yamlDoc), 'utf-8');
      } catch (err) {
        // YAML write is best-effort — DB record is the primary artifact.
        // Log but do not fail the save operation.
        console.warn(`[imports.saveConfig] Could not write config file '${yamlPath}': ${String(err)}`);
      }
    }
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.getArxmlTree ─────────────────────────────────────────────────────
  registry.register('imports.getArxmlTree', async (payload, deps, _ctx) => {
    const { sourceId } = payload;

    const sourceRows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId
       OPTIONAL MATCH (r:RIA_SRC_ImportRun)-[:RIA_SRC_RUN_FOR]->(s)
       RETURN s.name AS sourceName,
              s.target_namespace AS namespace,
              s.target_metamodel AS metamodel,
              r.status AS runStatus,
              r.completed_at AS completedAt,
              r.stats AS stats
       ORDER BY r.started_at DESC
       LIMIT 1`,
      { sourceId },
    );
    if (!sourceRows.length) throw new Error(`No source found: ${sourceId}`);

    const sourceRow = sourceRows[0];
    const namespace = String(sourceRow.namespace ?? '');
    const sourceName = String(sourceRow.sourceName ?? sourceId);
    const metamodel = String(sourceRow.metamodel ?? '');
    const runStatus = sourceRow.runStatus != null ? String(sourceRow.runStatus) : null;
    const completedAt = sourceRow.completedAt != null ? String(sourceRow.completedAt) : null;

    const atIdx = metamodel.indexOf('@');
    const metamodelName = atIdx >= 0 ? metamodel.slice(0, atIdx) : metamodel;
    const metamodelVersion = atIdx >= 0 ? metamodel.slice(atIdx + 1) : '';

    let errorSummary: string | undefined;
    if (runStatus === 'failed' && sourceRow.stats != null) {
      try {
        const statsObj = JSON.parse(String(sourceRow.stats)) as Record<string, unknown>;
        if (typeof statsObj.errorSummary === 'string') errorSummary = statsObj.errorSummary;
      } catch { /* ignore */ }
    }

    const conceptRows = await deps.dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance)
       WHERE ci.namespace = $namespace
       RETURN ci.node_id AS nodeId,
              ci.concept AS concept,
              ci.attributes AS attributes`,
      { namespace },
    );

    const relRows = await deps.dbModule.runQuery(
      `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(dst:RIA_UNIV_ConceptInstance)
       WHERE src.namespace = $namespace
         AND dst.namespace = $namespace
         AND (r.relationship STARTS WITH 'contains_' OR r.relationship STARTS WITH 'has_')
       RETURN src.node_id AS srcId,
              dst.node_id AS dstId`,
      { namespace },
    );

    const nodeById = new Map<number, { concept: string; attributes: Record<string, unknown> }>();
    for (const row of conceptRows) {
      const nodeId = Number(row.nodeId);
      if (!Number.isFinite(nodeId)) continue;
      nodeById.set(nodeId, { concept: String(row.concept ?? ''), attributes: parseAttributes(row.attributes) });
    }

    const parentByNodeId = new Map<number, number>();
    for (const row of relRows) {
      const srcId = Number(row.srcId);
      const dstId = Number(row.dstId);
      if (!Number.isFinite(srcId) || !Number.isFinite(dstId)) continue;
      parentByNodeId.set(dstId, srcId);
    }

    const stablePathByNodeId = new Map<number, string>();
    for (const [nodeId, entry] of nodeById) {
      const stablePath = typeof entry.attributes.stable_path === 'string' ? entry.attributes.stable_path : '';
      if (stablePath) stablePathByNodeId.set(nodeId, stablePath);
    }

    const nodes: ArxmlTreeData['nodes'] = [];
    for (const [nodeId, entry] of nodeById) {
      const stablePath = stablePathByNodeId.get(nodeId) ?? '';
      const parentNodeId = parentByNodeId.get(nodeId);
      const parentId = parentNodeId !== undefined ? (stablePathByNodeId.get(parentNodeId) ?? null) : null;
      nodes.push({ stable_path: stablePath, concept: entry.concept, parentId, attributes: entry.attributes });
    }

    const result: ArxmlTreeData = {
      sourceId,
      namespace,
      importDetails: {
        sourceId, sourceName, metamodelName, metamodelVersion,
        lastRunStatus: runStatus as ArxmlTreeData['importDetails']['lastRunStatus'],
        lastRunAt: completedAt,
        ...(errorSummary !== undefined ? { errorSummary } : {}),
      },
      nodes,
    };
    return result;
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.exportConfig ─────────────────────────────────────────────────────
  registry.register('imports.exportConfig', async (payload, deps, _ctx) => {
    const { sourceId, outputPath } = payload;
    const rows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId
       RETURN s.config_data, s.source_type, s.target_namespace, s.config_path, s.config, s.name`,
      { sourceId },
    );
    if (!rows.length) throw new Error(`No source found: ${sourceId}`);

    const { configData } = await ensureSourceConfigData(
      deps.dbModule, sourceId, rows[0],
      `No config_data on source '${sourceId}'. Save config first.`,
    );
    const yamlDoc: Record<string, unknown> = {
      namespace: configData.namespace,
      source_name: configData.source_name,
    };

    if (typeof configData.project_dir === 'string' && configData.project_dir.length > 0) {
      yamlDoc.project_dir = configData.project_dir;
    }
    if (typeof configData.scan_result_dir === 'string' && configData.scan_result_dir.length > 0) {
      yamlDoc.scan_result_dir = configData.scan_result_dir;
    }

    const include = Array.isArray(configData.files_include) ? configData.files_include : [];
    const exclude = Array.isArray(configData.files_exclude) ? configData.files_exclude : [];
    if (include.length > 0 || exclude.length > 0) {
      yamlDoc.files = { include, exclude };
    }

    if (configData.elements && typeof configData.elements === 'object' && Object.keys(configData.elements).length > 0) {
      yamlDoc.elements = configData.elements;
    }

    const yamlContent = stringifyYaml(yamlDoc);

    let writePath: string;
    if (outputPath) {
      writePath = outputPath;
    } else {
      const sourceType = String(rows[0]['s.source_type'] ?? 'unknown');
      const namespace = String(rows[0]['s.target_namespace'] ?? 'default');
      const safeName = namespace.replace(/[^a-zA-Z0-9_-]/g, '_');
      const wsStatus = await deps.workspaceService.getStatus();
      const workingDir = wsStatus.state === 'open' ? wsStatus.info.workingDir : '.';
      writePath = path.join(workingDir, 'ria-config', 'importer-config', sourceType, `${sourceType}-${safeName}-import-config.yaml`);
    }

    try {
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, yamlContent, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot write to ${writePath}: ${message}`);
    }
    return writePath;
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.importConfig ─────────────────────────────────────────────────────
  registry.register('imports.importConfig', async (payload, deps, _ctx) => {
    const { sourceId, filePath } = payload;
    const rows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId RETURN s.source_type AS sourceType, s.config AS config`,
      { sourceId },
    );
    if (!rows.length) throw new Error(`No source found: ${sourceId}`);
    const sourceType = String(rows[0].sourceType ?? '');

    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read file ${filePath}: ${message}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('YAML did not parse to an object');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse YAML: ${message}`);
    }

    const files = (parsed.files ?? {}) as { include?: unknown[]; exclude?: unknown[] };
    const configData = JSON.stringify({
      namespace: parsed.namespace ?? '',
      source_name: parsed.source_name ?? '',
      sourceType,
      project_dir: parsed.project_dir ?? '',
      scan_result_dir: parsed.scan_result_dir ?? undefined,
      needs_file: typeof parsed.needs_file === 'string' && parsed.needs_file.trim().length > 0
        ? parsed.needs_file
        : undefined,
      files_include: Array.isArray(files.include) ? files.include.map(String) : [],
      files_exclude: Array.isArray(files.exclude) ? files.exclude.map(String) : [],
      elements: (parsed.elements && typeof parsed.elements === 'object') ? parsed.elements : {},
    });

    const sourceMetaJson = serializeSourceConfigMeta(rows[0].config, {
      configPath: filePath,
      configDirty: true,
    });

    const now = new Date().toISOString();
    await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(sourceId)}'
       SET s.config_data = '${e(configData)}',
           s.config = '${e(sourceMetaJson)}',
           s.config_path = '${e(filePath)}',
           s.updated_at = '${e(now)}'`,
    );
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.getImpactReport ────────────────────────────────────────────────────
  registry.register('imports.getImpactReport', async (payload, deps, _ctx) => {
    if (!deps.orchestration) return null;
    return deps.orchestration.getImpactReport(payload.runId ?? '');
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.listOrphanedEntries ────────────────────────────────────────────────
  registry.register('imports.listOrphanedEntries', async (payload, deps, _ctx) => {
    if (!deps.orchestration) return [];
    return deps.orchestration.listAllOrphanedEntries(payload || undefined);
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.reconnectOrphanedEntry ────────────────────────────────────────────
  registry.register('imports.reconnectOrphanedEntry', async (payload, deps, _ctx) => {
    if (!deps.orchestration) throw new Error('Orchestration service not available');
    const { entry, newImportedNodeId } = payload;
    return deps.orchestration.reconnectOrphanedEntry(entry, newImportedNodeId);
  }, { requiresWorkspace: true, category: 'imports' });

  // ── Active import channels ────────────────────────────────────────────────────

  registry.register('imports.getActiveImport', async (_payload, _deps, ctx) => {
    const sourceId = ctx.getActiveImportSourceId();
    return sourceId ? { sourceId } : null;
  }, { requiresWorkspace: true, category: 'imports' });

  registry.register('imports.runFromSource', async (payload, deps, ctx) => {
    const { sourceId, workingDir } = payload;

    // Acquire the lock synchronously — before any await — so that concurrent IPC
    // calls (e.g. from a double-click) cannot both pass the guard and start
    // parallel imports that race on the single-write-transaction KuzuDB limit.
    const currentActive = ctx.getActiveImportSourceId();
    if (currentActive) {
      throw new Error(`Import already running for source '${currentActive}'`);
    }
    ctx.setActiveImportSourceId(sourceId);

    try {
      const rows = await deps.dbModule.runQuery(
        `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId
         RETURN s.config_data, s.source_type, s.config_path, s.name, s.target_namespace, s.config`,
        { sourceId },
      );
      if (!rows.length) throw new Error(`No source found: ${sourceId}`);

      const { configData, configPath } = await ensureSourceConfigData(
        deps.dbModule,
        sourceId,
        rows[0],
        `No config_data on source '${sourceId}'. Re-provision or use 'config import'.`,
      );
      if (!deps.orchestration) throw new Error('Import orchestration not configured');

      const sourceType = String(rows[0]['s.source_type'] ?? configData.sourceType ?? '');
      const defaultInclude = sourceType === 'arxml_file' || sourceType === 'arxml' ? ['**/*.arxml'] : [];

      const result = await deps.orchestration.runImport({
        configPath: configPath ?? '',
        workingDir,
        triggeredBy: 'gui',
        configData: {
          namespace:       String(configData.namespace ?? ''),
          source_name:     String(configData.source_name ?? ''),
          project_dir:     typeof configData.project_dir === 'string' ? configData.project_dir : '',
          scan_result_dir: typeof configData.scan_result_dir === 'string' ? configData.scan_result_dir : undefined,
          needs_file:      typeof configData.needs_file === 'string' ? configData.needs_file : undefined,
          files_include:   Array.isArray(configData.files_include) ? configData.files_include.map(String) : defaultInclude,
          files_exclude:   Array.isArray(configData.files_exclude) ? configData.files_exclude.map(String) : [],
          elements:        (configData.elements && typeof configData.elements === 'object') ? configData.elements as Record<string, boolean> : {},
          sourceType,
        },
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    } finally {
      ctx.setActiveImportSourceId(null);
    }
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.deleteSource ──────────────────────────────────────────────────
  registry.register('imports.deleteSource', async (payload, deps, _ctx) => {
    const { sourceId } = payload;

    // 1. Look up source to get targetNamespace and configPath
    const sourceRows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source {source_id: $sourceId})
       RETURN s.target_namespace AS targetNamespace, s.config AS config`,
      { sourceId },
    );
    if (sourceRows.length === 0) throw new Error(`Source '${sourceId}' not found`);

    const targetNamespace = String(sourceRows[0].targetNamespace ?? '');
    const configMeta = parseSourceConfigMeta(sourceRows[0].config);
    const configPath = configMeta.configPath;

    // 2. Delete the namespace (nodes, edges, namespace node)
    if (targetNamespace) {
      await deleteNamespace(targetNamespace, deps.dbModule);
    }

    // 3. Delete SourceMaster edges and nodes
    await deps.dbModule.runQuery(
      `MATCH (r:RIA_SRC_ImportRun)-[e:RIA_SRC_RUN_FOR]->(s:RIA_SRC_Source {source_id: $sourceId})
       DELETE e, r`,
      { sourceId },
    );
    await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source {source_id: $sourceId})-[e:RIA_SRC_TARGETS_NS]->()
       DELETE e`,
      { sourceId },
    );
    await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source {source_id: $sourceId}) DELETE s`,
      { sourceId },
    );
    await deps.dbModule.checkpoint();

    // 4. Remove config YAML — best effort
    if (configPath) {
      try {
        fs.unlinkSync(configPath);
      } catch (err) {
        console.warn(`[imports.deleteSource] Could not remove config file '${configPath}': ${String(err)}`);
      }
    }
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.runFromSourceAtRef ────────────────────────────────────────────
  // Runs the importer for a source against files at a specific git ref
  // (branch or tag), writing the result directly into the source's regular
  // namespace.
  // UC2: "Update from Branch"
  registry.register('imports.runFromSourceAtRef', async (payload, deps, ctx) => {
    const { sourceId, ref, workingDir } = payload;

    // The git repository is auto-detected from the source's project_dir inside
    // checkoutSourceToRef — we no longer rely on the workspace git config here.

    const currentActive = ctx.getActiveImportSourceId();
    if (currentActive) {
      throw new Error(`Import already running for source '${currentActive}'`);
    }
    ctx.setActiveImportSourceId(sourceId);

    let tempDir: string | undefined;
    try {
      const rows = await deps.dbModule.runQuery(
        `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId
         RETURN s.config_data, s.source_type, s.config_path, s.name, s.target_namespace, s.config`,
        { sourceId },
      );
      if (!rows.length) throw new Error(`No source found: ${sourceId}`);

      const { configData, configPath } = await ensureSourceConfigData(
        deps.dbModule, sourceId, rows[0],
        `No config_data on source '${sourceId}'. Re-provision or use 'config import'.`,
      );
      if (!deps.orchestration) throw new Error('Import orchestration not configured');
      if (!deps.gitService) throw new Error('Git service not available');

      const sourceType = String(rows[0]['s.source_type'] ?? configData.sourceType ?? '');
      const defaultInclude = sourceType === 'arxml_file' || sourceType === 'arxml' ? ['**/*.arxml'] : [];

      const { overriddenConfigData, checkedOutTempDir, gitRoot } = await checkoutSourceToRef(
        deps.gitService, ref, configData, sourceType, defaultInclude, workingDir,
      );
      tempDir = checkedOutTempDir;

      // Resolve the actual commit hash for the given ref (best-effort)
      let resolvedCommitId = ref;
      const commitResult = await deps.gitService.getCommit(gitRoot, ref);
      if (commitResult.ok && commitResult.data) {
        resolvedCommitId = commitResult.data.hash;
      }

      const result = await deps.orchestration.runImport({
        configPath: configPath ?? '',
        workingDir,
        triggeredBy: 'gui',
        configData: overriddenConfigData,
        // The overriddenConfigData.project_dir points to a temporary checkout
        // directory and must NOT be persisted to the source's config_data in
        // the DB. The canonical project_dir (already stored) must be preserved.
        preserveStoredConfigData: true,
      });
      if (!result.ok) throw new Error(result.error);

      // Log and record provenance after a successful import
      const logger = createImportLogger(path.join(workingDir, 'logs'));
      logger.info('Import completed from git ref', {
        sourceId,
        branch: ref,
        commitId: resolvedCommitId,
        namespace: result.data.namespace,
      });

      await recordGitImportProvenance(
        deps.dbModule, sourceId, ref, resolvedCommitId, workingDir, rows[0]['s.config'],
      );

      return result.data;
    } finally {
      ctx.setActiveImportSourceId(null);
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, { requiresWorkspace: true, category: 'imports' });

  // ── imports.updateFromImportedBranch ──────────────────────────────────────
  // UC-12 direct variant: checks if there is a newer commit on the branch
  // from which data was last imported. If so, imports from that commit and
  // records the new provenance. Returns upToDate flag + summary.
  registry.register('imports.updateFromImportedBranch', async (payload, deps, ctx) => {
    const { sourceId, workingDir } = payload;

    const currentActive = ctx.getActiveImportSourceId();
    if (currentActive) {
      throw new Error(`Import already running for source '${currentActive}'`);
    }

    // Load source and get the previously imported branch
    const rows = await deps.dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId
       RETURN s.config_data, s.source_type, s.config_path, s.name, s.target_namespace, s.config`,
      { sourceId },
    );
    if (!rows.length) throw new Error(`No source found: ${sourceId}`);

    const sourceMeta = parseSourceConfigMeta(rows[0]['s.config']);
    const lastBranch = sourceMeta.lastImportBranch;
    const lastCommitId = sourceMeta.lastImportCommitId;
    if (!lastBranch) {
      throw new Error(
        `Source '${sourceId}' has no recorded import branch. ` +
        `Use 'Update from Branch' to import from a branch first.`,
      );
    }

    if (!deps.gitService) throw new Error('Git service not available');

    const { configData, configPath } = await ensureSourceConfigData(
      deps.dbModule, sourceId, rows[0],
      `No config_data on source '${sourceId}'. Re-provision or use 'config import'.`,
    );

    // Discover the repo root via the source's project_dir, resolved to an
    // absolute path first (config values may be workspace-relative).
    const configuredProjectDir = typeof configData.project_dir === 'string' ? configData.project_dir : '';
    if (!configuredProjectDir) throw new Error(`Source '${sourceId}' has no project_dir configured.`);
    const projectDir = resolveWorkspacePath(workingDir, configuredProjectDir);

    const repoRootResult = await deps.gitService.getRepoRoot(projectDir);
    if (!repoRootResult.ok || !repoRootResult.data) {
      throw new Error(`Source data at '${projectDir}' is not inside a git repository.`);
    }
    const gitRoot = repoRootResult.data;

    // Get the latest commit on the branch
    const latestCommitResult = await deps.gitService.getCommit(gitRoot, lastBranch);
    if (!latestCommitResult.ok || !latestCommitResult.data) {
      throw new Error(`Could not resolve branch '${lastBranch}' in repository at '${gitRoot}'.`);
    }
    const latestCommitId = latestCommitResult.data.hash;

    // If already up to date, return early
    if (lastCommitId && lastCommitId === latestCommitId) {
      return { upToDate: true as const, branch: lastBranch, latestCommitId };
    }

    // New commit available — run import into a temp namespace to preserve
    // original data if the import fails. On success, auto-apply all changes.
    const logger = createImportLogger(path.join(workingDir, 'logs'));
    ctx.setActiveImportSourceId(sourceId);
    const originalNamespace = String(configData.namespace ?? '');
    if (!originalNamespace) throw new Error('Source config has no target namespace');
    const suffix = crypto.randomBytes(4).toString('hex');
    const tempNamespace = `${originalNamespace}__upd_${suffix}`;
    let tempDir: string | undefined;
    try {
      const sourceType = String(rows[0]['s.source_type'] ?? configData.sourceType ?? '');
      const defaultInclude = sourceType === 'arxml_file' || sourceType === 'arxml' ? ['**/*.arxml'] : [];

      const { overriddenConfigData, checkedOutTempDir } = await checkoutSourceToRef(
        deps.gitService, lastBranch, configData, sourceType, defaultInclude, workingDir,
      );
      tempDir = checkedOutTempDir;

      if (!deps.orchestration) throw new Error('Import orchestration not configured');

      // Step 1: Import into temp namespace — preserveStoredConfigData ensures the
      // temp checkout path is NOT persisted back to the source's config_data in DB.
      logger.info('imports.updateFromImportedBranch: importing into temp namespace', {
        sourceId, originalNamespace, tempNamespace, branch: lastBranch,
      });
      const result = await deps.orchestration.runImport({
        configPath: configPath ?? '',
        workingDir,
        triggeredBy: 'gui',
        namespaceRole: 'supervised_update_temp',
        configData: { ...overriddenConfigData, namespace: tempNamespace },
        preserveStoredConfigData: true,
      });
      if (!result.ok) {
        logger.error('imports.updateFromImportedBranch: importer failed — original data preserved', {
          error: result.error, tempNamespace,
        });
        // Best-effort cleanup of the failed temp namespace + source record
        try { await deleteNamespace(tempNamespace, deps.dbModule); } catch { /* best-effort */ }
        try {
          await deps.dbModule.runQuery(
            `MATCH (s:RIA_SRC_Source) WHERE s.target_namespace = $ns DETACH DELETE s`,
            { ns: tempNamespace },
          );
        } catch { /* best-effort */ }
        throw new Error(result.error);
      }
      logger.info('imports.updateFromImportedBranch: import into temp namespace complete', {
        tempNamespace, conceptsCreated: result.data.stats?.conceptsCreated,
      });

      // Step 2: Compute diff original → temp
      const diffSvc = createDiffService(deps.dbModule);
      let diffResult: NamespaceDiffResult;
      let diffSummary: DiffSummary;
      try {
        ({ summary: diffSummary, result: diffResult } = await diffSvc.diffNamespaces({
          leftNs: originalNamespace,
          rightNs: tempNamespace,
          workingDir,
          opts: { includeCrossNamespaceEdges: false },
        }));
      } catch (diffErr) {
        logger.error('imports.updateFromImportedBranch: diff failed — cleaning up temp', {
          tempNamespace, error: String(diffErr),
        });
        try { await deleteNamespace(tempNamespace, deps.dbModule); } catch { /* best-effort */ }
        try {
          await deps.dbModule.runQuery(
            `MATCH (s:RIA_SRC_Source) WHERE s.target_namespace = $ns DETACH DELETE s`,
            { ns: tempNamespace },
          );
        } catch { /* best-effort */ }
        throw diffErr;
      }
      logger.info('imports.updateFromImportedBranch: diff computed', {
        diffId: diffSummary.diffId, originalNamespace, tempNamespace,
        addedNodes: diffSummary.addedNodesCount, deletedNodes: diffSummary.deletedNodesCount,
        modifiedNodes: diffSummary.modifiedNodesCount,
      });

      // Step 3: Auto-apply ALL changes from temp into original namespace
      const { createMergeService } = await import('../../diff/merge-service.js');
      const mergeSvc = createMergeService(deps.dbModule);
      try {
        const mergeResult = await mergeSvc.applyMerge({
          diffResult,
          targetNamespace: originalNamespace,
          direction: 'right-into-left',
        });
        if (!mergeResult.mergeApplied) {
          throw new Error(
            `Merge could not be applied cleanly: ${mergeResult.warnings.join('; ') || 'unknown merge error'}`,
          );
        }
      } catch (mergeErr) {
        logger.error('imports.updateFromImportedBranch: merge apply failed', {
          error: String(mergeErr),
        });
        try { await deleteNamespace(tempNamespace, deps.dbModule); } catch { /* best-effort */ }
        try {
          await deps.dbModule.runQuery(
            `MATCH (s:RIA_SRC_Source) WHERE s.target_namespace = $ns DETACH DELETE s`,
            { ns: tempNamespace },
          );
        } catch { /* best-effort */ }
        throw mergeErr;
      }
      logger.info('imports.updateFromImportedBranch: merge applied', {
        originalNamespace, diffId: diffSummary.diffId,
      });

      // Step 4: Clean up temp namespace
      try { await deleteNamespace(tempNamespace, deps.dbModule); } catch { /* best-effort */ }
      try {
        await deps.dbModule.runQuery(
          `MATCH (s:RIA_SRC_Source) WHERE s.target_namespace = $ns DETACH DELETE s`,
          { ns: tempNamespace },
        );
      } catch { /* best-effort */ }

      // Step 5: Record provenance
      await recordGitImportProvenance(
        deps.dbModule, sourceId, lastBranch, latestCommitId, workingDir, rows[0]['s.config'],
      );
      logger.info('imports.updateFromImportedBranch: complete', {
        sourceId, branch: lastBranch, commitId: latestCommitId, previousCommitId: lastCommitId,
      });

      return {
        upToDate: false as const,
        branch: lastBranch,
        latestCommitId,
        previousCommitId: lastCommitId,
        runSummary: result.data,
      };
    } finally {
      ctx.setActiveImportSourceId(null);
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, { requiresWorkspace: true, category: 'imports' });
}
