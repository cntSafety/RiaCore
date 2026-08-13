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
import type { Result, WorkspaceConfig, WorkspaceInfo, WorkspaceStatus, DbStatus } from '@riacore/app-contracts';
import { WorkspaceConfigSchema } from '@riacore/app-contracts';
import type { LoadProgressPushEvent } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { AppCoreLogger } from '../db/db-module.js';
import type { IPersistorService } from '../persistor/persistor-types.js';
import type { Manifest } from '../persistor/persistor-types.js';
import { computeNamespaceHashFromFiles } from '../persistor/persistor.js';
import { migrateLegacyConnections } from './connection-migration.js';
import { createLayoutService } from '../namespaces/layout-service.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { runAllCleanups } from '../infra/cleanup-service.js';
import { DEFAULT_CHECKS } from './default-checks.js';

// Serialized content written verbatim to ria-data/checks.json for new (or
// check-less) workspaces. The source of truth is the typed DEFAULT_CHECKS
// array in ./default-checks.ts; this is just its on-disk JSON rendering.
const DEFAULT_CHECKS_FILE_CONTENT = JSON.stringify({ checks: DEFAULT_CHECKS }, null, 2);

export interface IWorkspaceService {
  open(config: WorkspaceConfig): Promise<Result<WorkspaceInfo>>;
  create(config: WorkspaceConfig): Promise<Result<WorkspaceInfo>>;
  close(): Promise<void>;
  getStatus(): Promise<WorkspaceStatus>;
  /**
   * Called after a successful persistor.store to update the in-memory
   * lifecycleAction so the UI badge transitions from "New workspace" /
   * "Loaded from ria-data" to "Exported to ria-data" without requiring
   * the user to close and reopen the workspace.
   */
  notifyStoreCompleted(): void;
  /**
   * Returns a promise that resolves when the current tracked load settles,
   * or immediately when no load is in flight (Requirement 6.2).
   * Implementation lands in task 5.1.
   */
  whenLoadSettled(): Promise<void>;
  /**
   * Exposes `performFreshLoad` for direct unit-testing only.
   * Do NOT call from production code — use `open()` instead.
   *
   * The caller must set the workspace state via `open()` first so that
   * `state.config` / `state.isOpen` are correctly primed; this function
   * then operates on the shared mutable state just as the staleness branch
   * will when task 3.1 is wired.
   *
   * @internal - for testing only (Requirements 2.2, 2.3, 2.4, 6.3)
   */
  _testOnly_performFreshLoad?: (config: WorkspaceConfig, dbPath: string) => Promise<void>;
}

interface WorkspaceState {
  config: WorkspaceConfig | null;
  dbPath: string | null;
  dbStatus: DbStatus;
  isOpen: boolean;
  lifecycleAction: import('@riacore/app-contracts').LifecycleAction;
  lifecycleWarning?: string;
}

/**
 * Returns true if `dir` exists AND contains a parseable `manifest.json`.
 */
async function hasValidManifest(dir: string): Promise<boolean> {
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const content = await fs.promises.readFile(manifestPath, 'utf-8');
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes or upgrades `{workingDir}/ria-data/checks.json`.
 *
 * Strategy: compare each built-in check (by id) against what is on disk.
 * - If the file does not exist, write the full defaults.
 * - If the file exists, update only the checks whose query or metadata has
 *   changed (matched by id). User-added checks (ids not in the default set)
 *   are always preserved unchanged.
 *
 * This is intentionally id-based rather than version-based so that a user
 * manually editing the schemaVersion field cannot accidentally suppress a
 * legitimate query fix shipped in a future release.
 */
async function writeDefaultChecks(workingDir: string, logger?: AppCoreLogger): Promise<void> {
  const riaDataDir = path.join(workingDir, 'ria-data');
  await fs.promises.mkdir(riaDataDir, { recursive: true });
  const checksPath = path.join(riaDataDir, 'checks.json');

  if (!fs.existsSync(checksPath)) {
    await fs.promises.writeFile(checksPath, DEFAULT_CHECKS_FILE_CONTENT, 'utf-8');
    logger?.info?.('Created default checks.json for new workspace', { checksPath });
    return;
  }

  // File exists — merge built-in checks into it by id.
  try {
    const existing = JSON.parse(await fs.promises.readFile(checksPath, 'utf-8')) as {
      checks?: Array<Record<string, unknown>>;
    };
    const existingChecks: Array<Record<string, unknown>> = existing.checks ?? [];
    const defaultChecks = DEFAULT_CHECKS as unknown as Array<Record<string, unknown>>;

    // Index existing checks by id for fast lookup.
    const existingById = new Map<string, Record<string, unknown>>();
    for (const c of existingChecks) {
      if (typeof c.id === 'string') existingById.set(c.id, c);
    }

    // Index default checks by id.
    const defaultById = new Map<string, Record<string, unknown>>();
    for (const c of defaultChecks) {
      if (typeof c.id === 'string') defaultById.set(c.id, c);
    }

    // Determine whether any built-in check needs updating.
    // Serialise the entire check object so that changes to any field
    // (query, attributes, name, description, severity, category, metamodel,
    // active, or any future field) are detected automatically.
    let needsUpdate = false;
    for (const [id, defaultCheck] of defaultById) {
      const existingCheck = existingById.get(id);
      if (!existingCheck || JSON.stringify(existingCheck) !== JSON.stringify(defaultCheck)) {
        needsUpdate = true;
        break;
      }
    }
    // Also update if a new built-in check id is not present at all.
    if (!needsUpdate) {
      for (const id of defaultById.keys()) {
        if (!existingById.has(id)) { needsUpdate = true; break; }
      }
    }

    if (!needsUpdate) return;

    // Build the merged list: updated built-ins first (preserving their order),
    // then any user-added checks that are not in the default set.
    const userChecks = existingChecks.filter((c) => typeof c.id === 'string' && !defaultById.has(c.id));
    const merged = [...defaultChecks, ...userChecks];

    const output = { checks: merged };
    await fs.promises.writeFile(checksPath, JSON.stringify(output, null, 2), 'utf-8');
    logger?.info?.('Updated checks.json with latest built-in check definitions', { checksPath });
  } catch (err) {
    // Unparseable file — overwrite with defaults.
    logger?.warn?.('checks.json unreadable, overwriting with defaults', {
      checksPath,
      error: err instanceof Error ? err.message : String(err),
    });
    await fs.promises.writeFile(checksPath, DEFAULT_CHECKS_FILE_CONTENT, 'utf-8');
  }
}

/**
 * Result of the consistency check between manifest, on-disk files, and DB.
 *
 * - `consistent`: all three agree — DB is up to date.
 * - `db_stale`: manifest and files agree but DB differs — safe to reload from ria-data.
 * - `files_corrupted`: manifest hashes don't match what's computed from on-disk files.
 *   The DB is authoritative; do NOT reload from corrupted files.
 */
type ConsistencyResult =
  | { status: 'consistent' }
  | { status: 'db_stale' }
  | { status: 'files_corrupted'; corruptedNamespaces: string[] };

/**
 * Three-way consistency check: manifest ↔ files ↔ DB.
 *
 * 1. First verifies that on-disk JSON files match the manifest hashes (file integrity).
 *    If any namespace's files have been modified/corrupted, returns 'files_corrupted'.
 * 2. Then compares manifest hashes to DB content_hash values.
 *    If they differ, returns 'db_stale' (safe to reload from ria-data).
 * 3. If everything matches, returns 'consistent'.
 */
async function checkConsistency(workingDir: string, dbModule: IDbModule, logger?: AppCoreLogger): Promise<ConsistencyResult> {
  const exportDir = path.join(workingDir, 'ria-data');
  const manifestPath = path.join(exportDir, 'manifest.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')) as Manifest;
  const manifestHashes: Record<string, string> = manifest.namespace_hashes ?? {};

  // ── Step 1: Verify file integrity (disk files vs manifest hashes) ─────────
  const corruptedNamespaces: string[] = [];
  for (const nsEntry of manifest.namespaces) {
    const namespace = nsEntry.name;
    const manifestHash = manifestHashes[namespace];
    if (!manifestHash) continue; // No hash recorded — skip integrity check

    const dirName = nsEntry.directory ?? namespace;
    const nsDir = path.join(exportDir, dirName);

    try {
      // Collect per-section debug lines so we can emit them only on mismatch,
      // keeping the happy-path log clean.
      const sectionLines: string[] = [];
      const diskHash = computeNamespaceHashFromFiles(
        namespace, nsDir, exportDir,
        (msg) => sectionLines.push(msg),
      );
      if (diskHash !== manifestHash) {
        logger?.warn?.(
          `File integrity mismatch — namespace='${namespace}' ` +
          `manifest=${manifestHash.slice(0, 20)}... disk=${diskHash.slice(0, 20)}...`,
          { namespace, manifest_hash: manifestHash, disk_hash: diskHash },
        );
        // Emit each per-section hash line so the log immediately shows which
        // section (concepts / relationships / cross-ns) caused the difference.
        for (const line of sectionLines) {
          logger?.warn?.(`  [integrity/section] ${line}`, { namespace });
        }
        corruptedNamespaces.push(namespace);
      }
    } catch (err) {
      // If we can't compute the hash (missing files, etc.), treat as corrupted
      logger?.warn?.('File integrity check failed for namespace', { namespace, error: err instanceof Error ? err.message : String(err) });
      corruptedNamespaces.push(namespace);
    }
  }

  if (corruptedNamespaces.length > 0) {
    return { status: 'files_corrupted', corruptedNamespaces };
  }

  // ── Step 2: Compare manifest hashes to DB hashes ──────────────────────────
  const rows = await dbModule.runQuery(
    'MATCH (n:RIA_UNIV_Namespace) RETURN n.name AS name, n.content_hash AS hash',
  );
  const dbHashes: Record<string, string> = {};
  for (const row of rows) {
    if (row.name && row.hash) dbHashes[String(row.name)] = String(row.hash);
  }

  // Mismatch if manifest has namespaces not in DB, or hashes differ
  for (const [ns, manifestHash] of Object.entries(manifestHashes)) {
    if (dbHashes[ns] !== manifestHash) return { status: 'db_stale' };
  }
  // Also mismatch if DB has namespaces not in manifest
  for (const ns of Object.keys(dbHashes)) {
    if (!(ns in manifestHashes)) return { status: 'db_stale' };
  }
  return { status: 'consistent' };
}

/**
 * Returns `true` when the given `DbStatus` indicates the on-disk database is
 * stale relative to the current code — either because it could not be opened
 * cleanly (`state === 'error'`) or because its stored schema version does not
 * equal `SCHEMA_VERSION` (`migrationNeeded === true`).
 *
 * A cleanly opened database whose `schemaVersion` equals `SCHEMA_VERSION` is
 * never classified as stale.
 *
 * Exported for property-based testing only; treat as internal otherwise.
 */
export function isStaleDb(dbStatus: DbStatus): boolean {
  return dbStatus.state === 'error' || dbStatus.migrationNeeded === true;
}

/**
 * Minimal async mutex built on a promise chain. Guarantees:
 *  - mutual exclusion: at most one critical section runs at a time (Req 1.1, 1.2)
 *  - FIFO: acquirers run in the order runExclusive() was called (Req 1.4)
 *  - release-on-throw: the lock is always released, even if fn() rejects (Req 1.3)
 *
 * `tail` is the promise every new acquirer chains onto. It only ever resolves;
 * rejections inside runExclusive are surfaced to the caller, not to the chain,
 * so a rejecting critical section cannot poison later acquirers.
 */
function createMutex() {
  let tail: Promise<void> = Promise.resolve();

  function runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // Capture the current tail, then advance it to a gate this call controls.
    const run = tail.then(() => fn());
    // The chain must never reject (that would poison later acquirers), so swallow
    // here; the real result/rejection is returned to *this* caller via `run`.
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  return { runExclusive };
}

// Load_Timeout: upper bound on how long a bounded await for a tracked load
// will wait before proceeding regardless (Requirements 3.2–3.4).
const LOAD_TIMEOUT_MS = 5000;

/**
 * Wraps a promise so the returned promise resolves when `p` settles OR when
 * `ms` elapses — whichever comes first. It NEVER rejects: a rejection of `p`
 * is swallowed (the caller only cares that the load has settled, not how), and
 * the timeout path resolves cleanly. Used to bound awaits on the tracked load
 * (Requirements 3.2–3.4).
 */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, ms);
    void p.finally(() => { if (!done) { done = true; clearTimeout(t); resolve(); } });
  });
}

export function createWorkspaceService(
  dbModule: IDbModule,
  persistorFactory: (workingDir: string) => IPersistorService,
  onLoadProgress?: (event: LoadProgressPushEvent) => void,
  logger?: AppCoreLogger,
): IWorkspaceService {
  // Lifecycle_Mutex: serialises open / create / close (and the forceRecheck
  // branch of open) so overlapping lifecycle operations cannot interleave.
  const mutex = createMutex();

  let state: WorkspaceState = {
    config: null,
    dbPath: null,
    dbStatus: { state: 'closed' },
    isOpen: false,
    lifecycleAction: 'opened_consistent',
  };

  // Serialized status snapshot (Requirements 2.1, 2.2, 2.6). getStatus() reads
  // this snapshot WITHOUT taking the lifecycle mutex; commitStatus() recomputes
  // it from `state` in one synchronous assignment and is called at every
  // committed state transition. Initialized to a closed snapshot to match the
  // initial `state`.
  let statusSnapshot: WorkspaceStatus = { state: 'closed' };

  // Tracked-load state (Requirements 3.1, 4.2). `epoch` is bumped on every
  // committed transition so an in-flight load can detect it has been superseded
  // (wired in tasks 5.2/5.3). `currentLoad` holds the promise of the in-flight
  // Case B load, or null when none is running; it is read by whenLoadSettled().
  let epoch = 0; // used by tasks 5.2/5.3
  let currentLoad: Promise<void> | null = null;

  /**
   * Returns a promise that resolves when the current tracked load settles, or
   * immediately when no load is in flight (Requirement 6.2).
   */
  function whenLoadSettled(): Promise<void> {
    return currentLoad ?? Promise.resolve();
  }

  const commitStatus = (): void => {
    if (!state.isOpen || !state.config) {
      statusSnapshot = { state: 'closed' };
      return;
    }
    statusSnapshot = {
      state: 'open',
      info: {
        workingDir: state.config.workingDir,
        dbPath: state.dbPath!,
        dbStatus: state.dbStatus,
        lifecycleAction: state.lifecycleAction,
        lifecycleWarning: state.lifecycleWarning,
      },
    };
  };

  const resetState = (): void => {
    state = {
      config: null,
      dbPath: null,
      dbStatus: { state: 'closed' },
      isOpen: false,
      lifecycleAction: 'opened_consistent',
    };
    commitStatus();
  };

  /**
   * Opens the DB at `dbPath`, handling the lock-retry logic.
   * Returns the DbStatus or an error result.
   */
  async function openDb(dbPath: string, workingDir: string): Promise<{ ok: true; dbStatus: DbStatus } | { ok: false; dbStatus: DbStatus; error: string }> {
    let dbStatus = await dbModule.open(dbPath);

    // The DB engine can briefly report a file lock while the native handle is being
    // released. Force one cleanup pass and retry once for a smoother switch.
    if (dbStatus.state === 'error' && /lock/i.test(dbStatus.error ?? '')) {
      logger?.warn?.('DB open reported lock; retrying workspace open once', { workingDir, dbPath, error: dbStatus.error });
      await dbModule.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
      dbStatus = await dbModule.open(dbPath);
    }

    if (dbStatus.state === 'error') {
      logger?.error?.('Workspace open: DB open failed', { workingDir, dbPath, error: dbStatus.error });
      return { ok: false, dbStatus, error: `Database open failed: ${dbStatus.error}` };
    }

    return { ok: true, dbStatus };
  }

  /**
   * Performs a Fresh_Load: closes the currently-open database, deletes the
   * Db_Directory (and Db_Wal when present), opens a new empty database, and
   * rebuilds the graph from the Ria_Data_Snapshot via Persistor `load()`.
   *
   * On success  → `state.lifecycleAction` is set to `'opened_loaded_from_ria_data'`.
   * On load()   → DB is closed, partial Db_Directory + Db_Wal are removed,
   *   failure     `state.lifecycleAction` is set to `'load_failed'`, and
   *               `state.lifecycleWarning` records the originating error message.
   *
   * The caller is responsible for setting `state` fields (`config`, `isOpen`,
   * etc.) before invoking this function so that `getStatus()` returns a
   * meaningful value throughout the operation.
   *
   * Requirements: 2.2, 2.3, 2.4, 2.5, 6.1, 6.2, 6.3
   *
   * @internal
   */
  async function performFreshLoad(config: WorkspaceConfig, dbPath: string): Promise<void> {
    const workingDir = config.workingDir;

    // Requirement 2.2: close the open database before deleting the Db_Directory.
    await dbModule.close();

    // Requirement 2.3: delete Db_Directory recursively, then Db_Wal when present.
    try {
      await fs.promises.rm(dbPath, { recursive: true, force: true });
      const walPath = `${dbPath}.wal`;
      if (fs.existsSync(walPath)) {
        await fs.promises.rm(walPath, { force: true });
      }
    } catch (cleanupErr) {
      logger?.warn?.('performFreshLoad: failed to remove stale DB files', {
        workingDir,
        dbPath,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }

    // Requirement 2.4: open a new empty database.
    const openResult = await openDb(dbPath, workingDir);
    if (!openResult.ok) {
      // If the empty-DB open itself fails, record load_failed and surface the error.
      state.lifecycleAction = 'load_failed';
      state.lifecycleWarning = openResult.error;
      commitStatus();
      return;
    }

    // Update the in-state dbStatus to reflect the freshly opened empty DB.
    state.dbStatus = openResult.dbStatus;
    commitStatus();

    // Requirement 2.4 (cont.): rebuild the graph via Persistor.load().
    const persistor = persistorFactory(workingDir);
    try {
      await persistor.load({
        workingDir,
        onNamespaceProgress: onLoadProgress ?? undefined,
      });
      // Requirement 2.5: on success set lifecycleAction to 'opened_loaded_from_ria_data'.
      state.lifecycleAction = 'opened_loaded_from_ria_data';
      state.lifecycleWarning = undefined;
      commitStatus();
      logger?.info?.('performFreshLoad: load succeeded', { workingDir });
    } catch (err) {
      // Requirements 6.1, 6.2, 6.3: on load() failure close the DB, remove
      // the partial Db_Directory + Db_Wal, set lifecycleAction = 'load_failed',
      // and record the originating error message in lifecycleWarning.
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.error?.('performFreshLoad: load failed, cleaning up partial DB', { workingDir, error: errMsg });
      await dbModule.close();
      try {
        await fs.promises.rm(dbPath, { recursive: true, force: true });
        const walPath = `${dbPath}.wal`;
        if (fs.existsSync(walPath)) {
          await fs.promises.rm(walPath, { force: true });
        }
      } catch (cleanupErr) {
        logger?.warn?.('performFreshLoad: failed to clean up partial DB after load failure', {
          workingDir,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
      state.lifecycleAction = 'load_failed';
      state.lifecycleWarning = errMsg;
      commitStatus();
    }
  }

  /**
   * Ensure DEFINEDBY and CATEGORIZEDBY wiring is correct for all authored
   * namespaces. Called on every workspace open so that existing workspaces
   * with stale snapshots are repaired without needing a full reload.
   * Idempotent and non-fatal.
   */
  async function ensureNamespaceWiring(): Promise<void> {
    try {
      const authoredNsRows = await dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.namespace_role = 'authored' RETURN ns.name AS name`,
        {},
      );
      for (const row of authoredNsRows) {
        const nsName = String(row.name ?? '');
        if (!nsName) continue;
        // Re-create DEFINEDBY from the namespace's own metamodel property if missing.
        // This repairs stale snapshots without adding any connections beyond the
        // persisted set. Auto-wiring of CATEGORIZEDBY/NamespaceConnection edges is
        // intentionally NOT performed here — load must produce exactly the persisted
        // connection set and nothing more. (Requirement 1.3)
        await dbModule.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace {name: $nsName}), (mm:RIA_META_Metamodel {name: ns.metamodel})
           WHERE NOT EXISTS { MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm) }
           CREATE (ns)-[:RIA_META_DEFINEDBY]->(mm)`,
          { nsName },
        );
      }

      // Option B best-effort migration for legacy workspaces: derive per-pair
      // RIA_UNIV_NamespaceConnection edges from legacy CATEGORIZEDBY edges when a
      // metamodel maps to exactly one analysis; surface "reconnect required" for
      // ambiguous shared-metamodel cases. Idempotent — skips imported namespaces
      // that already have per-pair edges. (Requirements 1.3, 8.2)
      const migrationResult = await migrateLegacyConnections(
        dbModule,
        logger?.info ? (logger as import('../infra/logger.js').ImportLogger) : undefined,
      );

      // Make the migration STICKY: migrateLegacyConnections only creates the
      // edges in the DB, so without this the derived connections show in the UI
      // but never reach ria-data (RIA_UNIV_NamespaceConnection.json), and they
      // are re-derived on every open. When the migration actually created at
      // least one connection, persist the universe layer once so the edges land
      // on disk. On the next open they load from ria-data and the migration
      // skips (idempotent). Universe-scoped store writes ONLY the universe files
      // (layout + connections) and leaves every namespace hash byte-identical
      // (Req 10), so it does not disturb the just-loaded namespace data.
      // Non-fatal: a persist failure must not abort workspace load.
      if (migrationResult.migrated.length > 0) {
        const workingDir = state.config?.workingDir;
        if (workingDir) {
          try {
            const persistor = persistorFactory(workingDir);
            await persistor.store({ workingDir, scope: 'universe' });
            logger?.info?.(
              `Persisted ${migrationResult.migrated.length} migrated namespace connection(s) to ria-data`,
              { workingDir, migrated: migrationResult.migrated.length },
            );
          } catch (persistErr) {
            logger?.warn?.('Failed to persist migrated namespace connections (non-fatal)', {
              error: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }
        }
      }

      // Load-time layout reconciliation (connection-diagram-layout-persistence):
      // the bespoke persistor load step has already restored every persisted
      // Layout_Record verbatim; reconcile() prunes only the records of a resolvable
      // Element_Kind whose Canvas_Element is absent, surfacing a non-fatal warning
      // naming each skipped Layout_Record. Records of an unknown/unresolved kind are
      // never pruned. Run once here, mirroring the run-once, non-fatal load-migration
      // pattern above. (Requirement 5.6)
      try {
        const layoutService = createLayoutService(
          dbModule,
          logger?.info ? (logger as import('../infra/logger.js').ImportLogger) : undefined,
        );
        const reconcileResult = await layoutService.reconcile();
        if (!reconcileResult.ok) {
          // Non-fatal: a reconciliation failure must not abort workspace load.
          logger?.warn?.('Layout reconciliation failed (non-fatal)', {
            error: reconcileResult.error,
          });
        } else if (reconcileResult.data.skipped.length > 0) {
          for (const record of reconcileResult.data.skipped) {
            logger?.warn?.(
              `Skipped Layout_Record with a dangling reference: ` +
                `${record.elementKind}/${record.elementKey} — no matching Canvas_Element exists.`,
              { elementKind: record.elementKind, elementKey: record.elementKey },
            );
          }
        }
      } catch (layoutErr) {
        // Non-fatal: never abort workspace load on a layout reconciliation error.
        logger?.warn?.('Layout reconciliation threw (non-fatal)', {
          error: layoutErr instanceof Error ? layoutErr.message : String(layoutErr),
        });
      }
    } catch (err) {
      logger?.warn?.('ensureNamespaceWiring failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function openLocked(config: WorkspaceConfig): Promise<Result<WorkspaceInfo>> {
      logger?.info?.('Workspace open requested', { workingDir: config.workingDir });

      // Step 1: Validate input with Zod
      const parsed = WorkspaceConfigSchema.safeParse(config);
      if (!parsed.success) {
        logger?.warn?.('Workspace open rejected by validation', {
          workingDir: config.workingDir,
          error: parsed.error.message,
        });
        return { ok: false, error: parsed.error.message };
      }

      // Step 2: Validate working directory exists and is writable
      try {
        await fs.promises.access(config.workingDir, fs.constants.W_OK);
      } catch {
        logger?.warn?.('Workspace open failed writable check', { workingDir: config.workingDir });
        return { ok: false, error: `Working directory not writable: ${config.workingDir}` };
      }

      // Req 3.3 / 7.2: if a prior workspace's Case B load is still running, bound-await
      // it before switching. Bumping the epoch first neutralises that load's completion
      // closures (Req 4.2 / 7.3) so a switch-during-load ends on the new workspace. This
      // runs before the same-directory fast path inside `if (state.isOpen)`; a same-dir
      // re-open during a load simply lets the load settle, then the fast path returns.
      if (currentLoad) {
        epoch += 1;
        await withTimeout(currentLoad, LOAD_TIMEOUT_MS);
      }

      // Close any previously open workspace
      if (state.isOpen) {
        // If already open with the same directory AND the DB file still exists,
        // return current state immediately without re-running lifecycle detection.
        // This prevents channel handlers from triggering spurious reconciliation
        // on every dispatch.
        // When forceRecheck is true (explicit user "Open Workspace" action),
        // skip this optimisation and run the full consistency check so that
        // file-level corruption is detected even while the workspace is open.
        // If the DB file has been deleted externally, fall through to full
        // lifecycle detection so the workspace recovers (Case B: load from ria-data).
        if (state.config?.workingDir === config.workingDir && state.dbPath && fs.existsSync(state.dbPath)) {
          if (!config.forceRecheck) {
            logger?.debug?.('Workspace already open with same directory — skipping re-open', { workingDir: config.workingDir });
            return {
              ok: true,
              data: {
                workingDir: state.config.workingDir,
                dbPath: state.dbPath!,
                dbStatus: state.dbStatus,
                lifecycleAction: 'opened_consistent',
              },
            };
          }

          // forceRecheck on same directory: run consistency check without closing DB.
          logger?.info?.('Workspace already open — forceRecheck requested, running consistency check', { workingDir: config.workingDir });
          const riaDataDir = path.join(config.workingDir, 'ria-data');
          const riaDataValid = await hasValidManifest(riaDataDir);

          if (riaDataValid) {
            let consistencyResult: ConsistencyResult;
            try {
              consistencyResult = await checkConsistency(config.workingDir, dbModule, logger);
            } catch (err) {
              logger?.warn?.('forceRecheck: consistency check threw, treating as db_stale', { error: err instanceof Error ? err.message : String(err) });
              consistencyResult = { status: 'db_stale' };
            }

            if (consistencyResult.status === 'files_corrupted') {
              const warning = `ria-data file integrity check failed for namespace(s): ${consistencyResult.corruptedNamespaces.join(', ')}. ` +
                `The on-disk JSON files have been changed (e.g. manually edited) without updating the hash in manifest.json. ` +
                `The database is authoritative and your data is safe. ` +
                `Use "Repair Manifest" to accept the file changes and update the manifest hashes, ` +
                `or use "Save" (persistor store) to overwrite the files from the database.`;
              logger?.warn?.('forceRecheck: files corrupted, DB is authoritative', {
                workingDir: config.workingDir,
                corruptedNamespaces: consistencyResult.corruptedNamespaces,
              });
              state.lifecycleAction = 'opened_db_only';
              state.lifecycleWarning = warning;
              commitStatus();
              return {
                ok: true,
                data: {
                  workingDir: state.config.workingDir,
                  dbPath: state.dbPath!,
                  dbStatus: state.dbStatus,
                  lifecycleAction: 'opened_db_only',
                  lifecycleWarning: warning,
                },
              };
            }

            if (consistencyResult.status === 'consistent') {
              logger?.info?.('forceRecheck: workspace consistent', { workingDir: config.workingDir });
              state.lifecycleAction = 'opened_consistent';
              state.lifecycleWarning = undefined;
              commitStatus();
              return {
                ok: true,
                data: {
                  workingDir: state.config.workingDir,
                  dbPath: state.dbPath!,
                  dbStatus: state.dbStatus,
                  lifecycleAction: 'opened_consistent',
                },
              };
            }

            // db_stale: DB differs from ria-data — reload
            logger?.info?.('forceRecheck: DB stale, reloading from ria-data', { workingDir: config.workingDir });
            const persistor = persistorFactory(config.workingDir);
            try {
              await persistor.load({
                workingDir: config.workingDir,
                onNamespaceProgress: onLoadProgress ?? undefined,
              });
              state.lifecycleAction = 'opened_loaded_from_ria_data';
              state.lifecycleWarning = undefined;
              commitStatus();
              return {
                ok: true,
                data: {
                  workingDir: state.config.workingDir,
                  dbPath: state.dbPath!,
                  dbStatus: state.dbStatus,
                  lifecycleAction: 'opened_loaded_from_ria_data',
                },
              };
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger?.error?.('forceRecheck: reload failed', { workingDir: config.workingDir, error: errMsg });
              state.lifecycleAction = 'load_failed';
              state.lifecycleWarning = `Failed to reload workspace from ria-data: ${errMsg}`;
              commitStatus();
              return {
                ok: true,
                data: {
                  workingDir: state.config.workingDir,
                  dbPath: state.dbPath!,
                  dbStatus: state.dbStatus,
                  lifecycleAction: 'load_failed',
                  lifecycleWarning: state.lifecycleWarning,
                },
              };
            }
          }

          // No valid ria-data — nothing to check against, DB is authoritative
          logger?.info?.('forceRecheck: no valid ria-data, DB is authoritative', { workingDir: config.workingDir });
          return {
            ok: true,
            data: {
              workingDir: state.config.workingDir,
              dbPath: state.dbPath!,
              dbStatus: state.dbStatus,
              lifecycleAction: 'opened_consistent',
            },
          };
        }
        logger?.info?.('Closing previous workspace before re-open or switching', {
          previousWorkingDir: state.config?.workingDir ?? null,
          nextWorkingDir: config.workingDir,
          dbMissing: state.dbPath ? !fs.existsSync(state.dbPath) : false,
        });
        await dbModule.close();
        resetState();
      }

      const dbPath = path.join(config.workingDir, 'db');
      const riaDataDir = path.join(config.workingDir, 'ria-data');

      // Step 3: Probe filesystem state
      const dbExists = fs.existsSync(dbPath);
      const riaDataValid = await hasValidManifest(riaDataDir);

      logger?.info?.('Workspace lifecycle detection', { workingDir: config.workingDir, dbExists, riaDataValid });

      // ── Case A: no DB, no ria-data → CREATE ──────────────────────────────────
      if (!dbExists && !riaDataValid) {
        logger?.info?.('Lifecycle Case A: creating new workspace', { workingDir: config.workingDir });

        const openResult = await openDb(dbPath, config.workingDir);
        if (!openResult.ok) return { ok: false, error: openResult.error };

        await writeDefaultChecks(config.workingDir, logger);

        state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'created' };
        commitStatus();
        logger?.info?.('Workspace created (Case A)', { workingDir: config.workingDir });

        return {
          ok: true,
          data: {
            workingDir: config.workingDir,
            dbPath,
            dbStatus: openResult.dbStatus,
            lifecycleAction: 'created',
          },
        };
      }

      // ── Case B: no DB, ria-data valid → LOAD FROM RIA-DATA ───────────────────
      if (!dbExists && riaDataValid) {
        logger?.info?.('Lifecycle Case B: loading from ria-data (async)', { workingDir: config.workingDir });

        const openResult = await openDb(dbPath, config.workingDir);
        if (!openResult.ok) return { ok: false, error: openResult.error };

        // Mark workspace as open with 'loading_from_ria_data' BEFORE starting
        // the load so that:
        //  1. Concurrent dispatch calls hit the already-open optimisation and
        //     don't re-enter open() while the load is in progress.
        //  2. workspace.getStatus() can immediately return the loading state,
        //     allowing the UI to show a progress indicator without waiting for
        //     the full load to complete.
        state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'loading_from_ria_data' };
        // This transition owns a new epoch (Requirement 4.2). Bumping before the
        // long load begins means any later lifecycle operation that bumps the
        // epoch again will supersede this load's completion closures.
        epoch += 1;
        // Commit the loading snapshot BEFORE the long background load begins so
        // getStatus() returns 'loading_from_ria_data' promptly (Requirement 2.6).
        commitStatus();
        // Captured by the completion/failure closures (Requirement 4.1) so they
        // can detect at settle time whether they have been superseded.
        const loadEpoch = epoch;

        // Return immediately so the renderer can show the loading state.
        // The load runs in the background (tracked via `currentLoad`);
        // state.lifecycleAction is updated to 'opened_loaded_from_ria_data'
        // when it completes.
        const persistor = persistorFactory(config.workingDir);
        const load = persistor.load({
          workingDir: config.workingDir,
          onNamespaceProgress: onLoadProgress ?? undefined,
        }).then(async () => {
          if (epoch !== loadEpoch) {
            // Superseded by a later lifecycle operation — no-op (Req 4.3, 7.3, 9.4).
            logger?.info?.('Case B load completed but superseded (epoch mismatch) — skipping', { workingDir: config.workingDir });
            return;
          }
          await writeDefaultChecks(config.workingDir, logger);
          // Run post-load cleanup here, inside the background-load completion,
          // rather than in the workspace.open handler. The handler returns while
          // this load is still running (lifecycleAction === 'loading_from_ria_data'),
          // so running cleanup queries there would race against this load — and
          // against the .catch() below which closes and deletes the DB on failure.
          // That race caused a native use-after-free crash. Keeping the
          // 'loading_from_ria_data' gate up until cleanup finishes also ensures the
          // worker's load-wait queue holds other requests off the shared DB module
          // while cleanup runs.
          try {
            await runAllCleanups(dbModule, (msg) => logger?.info?.(msg));
          } catch (cleanupErr) {
            logger?.warn?.('Case B: post-load cleanup failed', {
              workingDir: config.workingDir,
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          }
          // Re-check after the await points above: a transition can commit while
          // cleanup runs (Requirement 4.3 — "before or during").
          if (epoch !== loadEpoch) return;
          state.lifecycleAction = 'opened_loaded_from_ria_data';
          commitStatus();
          logger?.info?.('Workspace loaded from ria-data (Case B)', { workingDir: config.workingDir });
        }).catch(async (err) => {
          if (epoch !== loadEpoch) {
            // Superseded failure — do NOT close the DB or delete files, since a
            // later lifecycle operation now owns the handle (Req 4.3).
            logger?.info?.('Case B load failed but superseded (epoch mismatch) — skipping cleanup', { workingDir: config.workingDir });
            return;
          }
          // Requirement 3.3: clean up partially initialized DB on load failure.
          // Keep the workspace "open" in load_failed state so the UI can surface
          // the error message and offer recovery actions (e.g. repair manifest).
          const errMsg = err instanceof Error ? err.message : String(err);
          logger?.error?.('Case B: load failed, cleaning up DB', { workingDir: config.workingDir, error: errMsg });
          await dbModule.close();
          try {
            await fs.promises.rm(dbPath, { recursive: true, force: true });
            const walPath = `${dbPath}.wal`;
            if (fs.existsSync(walPath)) {
              await fs.promises.rm(walPath, { force: true });
            }
          } catch (cleanupErr) {
            logger?.warn?.('Case B: failed to clean up DB after load failure', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
          }
          // Transition to load_failed — workspace stays open so getStatus() can
          // return the error to the renderer without relying on the HUD event log.
          state.lifecycleAction = 'load_failed';
          state.lifecycleWarning = errMsg;
          commitStatus();
        }).finally(() => {
          // Clear the tracked load on settle, but only if it is still this load
          // (a later lifecycle op may have already replaced it) — Requirement 3.5.
          if (currentLoad === load) currentLoad = null;
        });

        // Track the in-flight load so close()/open() can bound-await it (Req 3.1).
        currentLoad = load;

        return {
          ok: true,
          data: {
            workingDir: config.workingDir,
            dbPath,
            dbStatus: openResult.dbStatus,
            lifecycleAction: 'loading_from_ria_data',
          },
        };
      }

      // ── Case C: DB exists, no ria-data → SAVE TO RIA-DATA ───────────────────
      if (dbExists && !riaDataValid) {
        logger?.info?.('Lifecycle Case C: saving to ria-data', { workingDir: config.workingDir });

        const openResult = await openDb(dbPath, config.workingDir);

        // ── Staleness branch (Requirement 1.1, 1.4, 3.1, 3.2) ──────────────
        // Handle stale DB regardless of whether openDb succeeded or failed.
        // For Case C there is no ria-data snapshot, so we can never rebuild —
        // apply the no-snapshot safety guard directly.
        if (!openResult.ok || isStaleDb(openResult.dbStatus)) {
          const detectedVersion = openResult.dbStatus.schemaVersion ?? '(unknown)';
          logger?.warn?.('Case C: stale database detected — no ria-data snapshot available to rebuild from', {
            workingDir: config.workingDir,
            dbPath,
            detectedSchemaVersion: detectedVersion,
            expectedSchemaVersion: SCHEMA_VERSION,
          });
          // Requirement 3.1: do NOT delete the Db_Directory.
          // Requirement 3.2: set lifecycleAction = 'load_failed', record warning.
          const warning = `Stale database detected (schema version: ${detectedVersion}, expected: ${SCHEMA_VERSION}). No ria-data snapshot is available to rebuild from. The database has not been modified.`;
          state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'load_failed', lifecycleWarning: warning };
          commitStatus();
          return {
            ok: true,
            data: {
              workingDir: config.workingDir,
              dbPath,
              dbStatus: openResult.dbStatus,
              lifecycleAction: 'load_failed',
              lifecycleWarning: warning,
            },
          };
        }
        // ── End staleness branch ─────────────────────────────────────────────

        state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'opened_saved_to_ria_data' };
        commitStatus();

        await writeDefaultChecks(config.workingDir, logger);

        const persistor = persistorFactory(config.workingDir);
        try {
          await persistor.store({ workingDir: config.workingDir });
          logger?.info?.('Workspace saved to ria-data (Case C)', { workingDir: config.workingDir });

          return {
            ok: true,
            data: {
              workingDir: config.workingDir,
              dbPath,
              dbStatus: openResult.dbStatus,
              lifecycleAction: 'opened_saved_to_ria_data',
            },
          };
        } catch (err) {
          // Requirement 5.3: non-fatal — return opened_db_only with warning
          const warning = err instanceof Error ? err.message : String(err);
          logger?.warn?.('Case C: store failed, returning opened_db_only', { workingDir: config.workingDir, error: warning });

          state.lifecycleAction = 'opened_db_only';
          state.lifecycleWarning = warning;
          commitStatus();

          return {
            ok: true,
            data: {
              workingDir: config.workingDir,
              dbPath,
              dbStatus: openResult.dbStatus,
              lifecycleAction: 'opened_db_only',
              lifecycleWarning: warning,
            },
          };
        }
      }

      // ── Case D: both DB and ria-data → CONSISTENCY CHECK ────────────────────
      logger?.info?.('Lifecycle Case D: consistency check', { workingDir: config.workingDir });

      const openResult = await openDb(dbPath, config.workingDir);

      // ── Staleness branch (Requirement 1.1, 1.4, 2.1, 4.1) ──────────────────
      // If the DB is stale (schema mismatch or error), and ria-data is valid,
      // perform a Fresh_Load to rebuild from the snapshot.
      if (!openResult.ok || isStaleDb(openResult.dbStatus)) {
        const detectedVersion = openResult.dbStatus.schemaVersion ?? '(unknown)';
        logger?.warn?.('Case D: stale database detected — will rebuild from ria-data snapshot', {
          workingDir: config.workingDir,
          dbPath,
          detectedSchemaVersion: detectedVersion,
          expectedSchemaVersion: SCHEMA_VERSION,
        });
        // Set state so getStatus() returns meaningful info during the rebuild.
        state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'loading_from_ria_data' };
        // Commit the loading snapshot BEFORE the long Fresh_Load begins so
        // getStatus() returns 'loading_from_ria_data' promptly (Requirement 2.6).
        commitStatus();
        // Requirement 2.1, 4.1: perform Fresh_Load (close → delete → open empty → load).
        await performFreshLoad(config, dbPath);
        // performFreshLoad updates state.lifecycleAction and state.lifecycleWarning.
        // Refresh dbStatus from the module after the fresh open.
        const postLoadDbStatus = dbModule.getStatus();
        state.dbStatus = postLoadDbStatus;
        commitStatus();
        // When the rebuild succeeded, run the same load-time repair/migration the
        // consistent path runs (DEFINEDBY repair, legacy connection migration +
        // sticky persist, layout reconciliation). Without this, a legacy workspace
        // whose DB was rebuilt due to a schema bump would skip the connection
        // migration on this open and only migrate on the next one. Guarded on a
        // successful rebuild so a load_failed rebuild does not run wiring.
        if (state.lifecycleAction === 'opened_loaded_from_ria_data') {
          await ensureNamespaceWiring();
        }
        return {
          ok: true,
          data: {
            workingDir: config.workingDir,
            dbPath,
            dbStatus: state.dbStatus,
            lifecycleAction: state.lifecycleAction,
            lifecycleWarning: state.lifecycleWarning,
          },
        };
      }
      // ── End staleness branch ──────────────────────────────────────────────────

      state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'opened_consistent' };
      commitStatus();

      // Ensure checks.json exists for workspaces that predate the checks feature
      await writeDefaultChecks(config.workingDir, logger);

      let consistencyResult: ConsistencyResult;
      try {
        consistencyResult = await checkConsistency(config.workingDir, dbModule, logger);
      } catch (err) {
        logger?.warn?.('Case D: consistency check threw, treating as db_stale', { error: err instanceof Error ? err.message : String(err) });
        consistencyResult = { status: 'db_stale' };
      }

      // DIAGNOSTIC (temporary): identify which Case D branch fires on reopen —
      // correlates against persistor.store timestamps to investigate the
      // intermittent missing-tile/missing-connection bug. Remove once root-caused.
      logger?.info?.('[DIAG] Case D consistency check result', {
        workingDir: config.workingDir,
        status: consistencyResult.status,
      });

      if (consistencyResult.status === 'consistent') {
        logger?.info?.('Workspace consistent (Case D)', { workingDir: config.workingDir });
        await ensureNamespaceWiring();
        return {
          ok: true,
          data: {
            workingDir: config.workingDir,
            dbPath,
            dbStatus: openResult.dbStatus,
            lifecycleAction: 'opened_consistent',
          },
        };
      }

      if (consistencyResult.status === 'files_corrupted') {
        // On-disk JSON files have been modified/corrupted — the DB is authoritative.
        // Do NOT reload from corrupted files. Open with the DB data and warn the user.
        const warning = `ria-data file integrity check failed for namespace(s): ${consistencyResult.corruptedNamespaces.join(', ')}. ` +
          `The on-disk JSON files have been changed (e.g. manually edited) without updating the hash in manifest.json. ` +
          `The database is authoritative and your data is safe. ` +
          `Use "Repair Manifest" to accept the file changes and update the manifest hashes, ` +
          `or use "Save" (persistor store) to overwrite the files from the database.`;
        logger?.warn?.('Case D: files corrupted, DB is authoritative', {
          workingDir: config.workingDir,
          corruptedNamespaces: consistencyResult.corruptedNamespaces,
        });

        state.lifecycleAction = 'opened_db_only';
        state.lifecycleWarning = warning;
        commitStatus();

        await ensureNamespaceWiring();
        return {
          ok: true,
          data: {
            workingDir: config.workingDir,
            dbPath,
            dbStatus: openResult.dbStatus,
            lifecycleAction: 'opened_db_only',
            lifecycleWarning: warning,
          },
        };
      }

      // Hashes differ — reload from ria-data
      logger?.info?.('Case D: hashes differ, reloading from ria-data', { workingDir: config.workingDir });
      const persistor = persistorFactory(config.workingDir);
      try {
        await persistor.load({
          workingDir: config.workingDir,
          onNamespaceProgress: onLoadProgress ?? undefined,
        });
      } catch (err) {
        // Mirror Case B: keep the workspace "open" in load_failed state so the
        // UI can surface the error and offer recovery actions (Repair Manifest).
        // Clean up the partially-initialized DB so a subsequent open after a
        // successful repair re-runs the load path from scratch.
        const errMsg = err instanceof Error ? err.message : String(err);
        logger?.error?.('Case D: reload failed, cleaning up DB', { workingDir: config.workingDir, error: errMsg });
        await dbModule.close();
        try {
          await fs.promises.rm(dbPath, { recursive: true, force: true });
          const walPath = `${dbPath}.wal`;
          if (fs.existsSync(walPath)) {
            await fs.promises.rm(walPath, { force: true });
          }
        } catch (cleanupErr) {
          logger?.warn?.('Case D: failed to clean up DB after reload failure', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
        }
        // Transition to load_failed — workspace stays "open" so getStatus() can
        // return the error to the renderer and the Repair Manifest UI shows up.
        state.lifecycleAction = 'load_failed';
        state.lifecycleWarning = `Failed to reload workspace from ria-data: ${errMsg}`;
        commitStatus();
        return {
          ok: true,
          data: {
            workingDir: config.workingDir,
            dbPath,
            dbStatus: openResult.dbStatus,
            lifecycleAction: 'load_failed',
            lifecycleWarning: state.lifecycleWarning,
          },
        };
      }

      logger?.info?.('Workspace reloaded from ria-data (Case D)', { workingDir: config.workingDir });
      state.lifecycleAction = 'opened_loaded_from_ria_data';
      state.lifecycleWarning = undefined;
      commitStatus();
      return {
        ok: true,
        data: {
          workingDir: config.workingDir,
          dbPath,
          dbStatus: openResult.dbStatus,
          lifecycleAction: 'opened_loaded_from_ria_data',
        },
      };
  }

  async function createLocked(config: WorkspaceConfig): Promise<Result<WorkspaceInfo>> {
      logger?.info?.('Workspace create requested', { workingDir: config.workingDir });

      // Step 1: Validate input with Zod
      const parsed = WorkspaceConfigSchema.safeParse(config);
      if (!parsed.success) {
        logger?.warn?.('Workspace create rejected by validation', {
          workingDir: config.workingDir,
          error: parsed.error.message,
        });
        return { ok: false, error: parsed.error.message };
      }

      // Step 2: Validate working directory exists and is writable
      try {
        await fs.promises.access(config.workingDir, fs.constants.W_OK);
      } catch {
        logger?.warn?.('Workspace create failed writable check', { workingDir: config.workingDir });
        return { ok: false, error: `Working directory not writable: ${config.workingDir}` };
      }

      const dbPath = path.join(config.workingDir, 'db');
      const riaDataDir = path.join(config.workingDir, 'ria-data');

      // Step 3: Check for existing workspace data
      const dbExists = fs.existsSync(dbPath);
      const riaDataValid = await hasValidManifest(riaDataDir);

      if (dbExists || riaDataValid) {
        logger?.warn?.('Workspace create rejected: directory already contains workspace data', { workingDir: config.workingDir, dbExists, riaDataValid });
        return {
          ok: false,
          error: 'Directory already contains workspace data. Use workspace.open instead.',
        };
      }

      // Close any previously open workspace
      if (state.isOpen) {
        await dbModule.close();
        resetState();
      }

      // Step 4: Initialize empty DB
      const openResult = await openDb(dbPath, config.workingDir);
      if (!openResult.ok) return { ok: false, error: openResult.error };

      // Step 5: Write checks.json (create ria-data/ if needed)
      await writeDefaultChecks(config.workingDir, logger);

      state = { config, dbPath, dbStatus: openResult.dbStatus, isOpen: true, lifecycleAction: 'created' };
      commitStatus();
      logger?.info?.('Workspace created', { workingDir: config.workingDir, dbPath });

      return {
        ok: true,
        data: {
          workingDir: config.workingDir,
          dbPath,
          dbStatus: openResult.dbStatus,
          lifecycleAction: 'created',
        },
      };
  }

  async function closeLocked(): Promise<void> {
      logger?.info?.('Workspace close requested', { workingDir: state.config?.workingDir ?? null, dbPath: state.dbPath });
      // Supersede any in-flight Case B load (Req 4.2): bumping the epoch first
      // neutralises that load's completion closures (Req 7.3), then bound-await
      // it so the DB is not closed out from under an active load (Req 3.2). The
      // await never rejects and force-closes on timeout (Req 3.4); correctness
      // on timeout rests on the epoch + Db_Module generation guards.
      epoch += 1;
      const inflight = currentLoad;
      if (inflight) {
        await withTimeout(inflight, LOAD_TIMEOUT_MS);
      }
      await dbModule.close();
      // resetState() commits a closed snapshot, so the workspace ends closed
      // even if the superseded load later settles (Req 7.1).
      resetState();
      logger?.info?.('Workspace close completed');
  }

  return {
    open(config: WorkspaceConfig): Promise<Result<WorkspaceInfo>> {
      return mutex.runExclusive(() => openLocked(config));
    },

    create(config: WorkspaceConfig): Promise<Result<WorkspaceInfo>> {
      return mutex.runExclusive(() => createLocked(config));
    },

    close(): Promise<void> {
      return mutex.runExclusive(() => closeLocked());
    },

    notifyStoreCompleted(): void {
      if (state.isOpen) {
        state.lifecycleAction = 'opened_saved_to_ria_data';
        state.lifecycleWarning = undefined;
        commitStatus();
      }
    },

    whenLoadSettled,

    /**
     * Exposes `performFreshLoad` for direct unit-testing only.
     * @internal - for testing only.
     */
    _testOnly_performFreshLoad: performFreshLoad,

    // Async, lock-free status read (Requirements 2.1, 2.2, 2.6). Reads the
    // serialized `statusSnapshot` WITHOUT taking the lifecycle mutex, then
    // applies the live `dbModule.getStatus()` + `fs.existsSync` overlay only
    // when the snapshot is open.
    async getStatus(): Promise<WorkspaceStatus> {
      const snap = statusSnapshot;
      if (snap.state !== 'open') return snap;

      // Get live DB status from the native handle, then apply a filesystem
      // existence check. The DB engine's in-memory handle stays 'open' even after
      // the file is deleted on disk — we need to detect that here so the UI
      // transitions to db_closed within the next poll cycle (5s).
      // We do NOT close the handle here to avoid races with concurrent
      // dispatch calls (same reason db.probe never closed it).
      let liveDbStatus = dbModule.getStatus();
      if (liveDbStatus.state === 'open' && state.dbPath && !fs.existsSync(state.dbPath)) {
        liveDbStatus = { state: 'closed' };
      }

      return { state: 'open', info: { ...snap.info, dbStatus: liveDbStatus } };
    },
  };
}
