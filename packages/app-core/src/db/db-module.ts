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
import lbug, { type Database, type Connection, type LbugValue } from '@ladybugdb/core';
import type { DbStatus } from '@riacore/app-contracts';
import { createDbLock } from './db-lock.js';
import {
  DB_SCHEMA_VERSION_NODE_ID,
  DB_SCHEMA_VERSION_TABLE,
  SCHEMA_VERSION,
  ensureDbSchemaVersionSeed,
  initializeSchema,
} from './schema.js';

export class DbGenerationChangedError extends Error {
  /** Stable, serialization-safe discriminant (survives structured-clone / IPC). */
  static readonly CODE = 'DB_GENERATION_CHANGED';
  readonly code = DbGenerationChangedError.CODE;
  /**
   * `reason` replaces the generation-comparison wording. It exists because the
   * no-handle case reports `expected === actual`, and "generation changed
   * (expected 0, got 0)" reads as a contradiction that says nothing about the
   * real cause (the database was never opened, or `open()` failed).
   */
  constructor(expected: number, actual: number, reason?: string) {
    super(
      reason
        ? `${reason}; operation superseded`
        : `Database generation changed (expected ${expected}, got ${actual}); operation superseded`,
    );
    this.name = 'DbGenerationChangedError';
    // Restore prototype chain for instanceof after transpilation to ES5-ish targets.
    Object.setPrototypeOf(this, DbGenerationChangedError.prototype);
  }
  /** Type-safe detector that also works across module/realm boundaries via code. */
  static is(err: unknown): err is DbGenerationChangedError {
    return err instanceof DbGenerationChangedError
      || (typeof err === 'object' && err !== null
          && (err as { code?: unknown }).code === DbGenerationChangedError.CODE);
  }
}

export interface AppCoreLogger {
  debug?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}

export interface DbTransaction {
  runQuery(query: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface IDbModule {
  open(dbPath: string): Promise<DbStatus>;
  close(): Promise<void>;
  getStatus(): DbStatus;
  getConnection(): Connection;
  runQuery(
    statement: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]>;
  checkpoint(): Promise<void>;
  beginTransaction?(): Promise<DbTransaction>;
}

/**
 * Upper bound on how long close() waits for exclusive access to the native
 * handle before giving up. Bounded so a leaked lock holder can never make
 * close() (and with it workspace switching) hang forever.
 *
 * Giving up does NOT mean closing anyway — see close() for what happens instead.
 *
 * Note for the quit path: the main process force-kills the worker
 * `shutdownTimeout` ms (5 s) after asking it to shut down, and workspace-service
 * spends up to `LOAD_TIMEOUT_MS` bound-awaiting an in-flight load before it even
 * calls close(). A kill mid-statement is an abrupt but safe abort — unlike
 * freeing the handle under one — so this budget is deliberately not tuned around
 * that deadline.
 */
const CLOSE_LOCK_TIMEOUT_MS = 5000;

/**
 * How long a deferred close waits for the stragglers to finish before giving up
 * on reclaiming a handle it could not free synchronously.
 *
 * Generous on purpose: an unreclaimed handle is not a mere memory leak. The
 * buffer manager reserves an 8 TiB virtual address range per handle, so roughly
 * fifteen of them are enough to make every later `open()` fail with
 * "Buffer manager exception: VirtualAlloc for size 8796093022208 failed".
 * Reclaiming late is far better than never.
 */
const DEFERRED_CLOSE_TIMEOUT_MS = 120_000;

export interface DbModuleOptions {
  /** Override {@link CLOSE_LOCK_TIMEOUT_MS}. Intended for tests. */
  closeLockTimeoutMs?: number;
}

export function createDbModule(logger?: AppCoreLogger, options?: DbModuleOptions): IDbModule {
  const closeLockTimeoutMs = options?.closeLockTimeoutMs ?? CLOSE_LOCK_TIMEOUT_MS;
  let database: Database | null = null;
  let currentPath: string | null = null;
  let currentStatus: DbStatus = { state: 'closed' };
  let generation = 0; // Generation counter, bumped on every open() success and close()

  // Serialises access to the single native handle: shared for reads, exclusive
  // for writes / CHECKPOINT / transactions. See db-lock.ts for the rationale
  // (concurrent read + CHECKPOINT faulted the worker with 0xC0000005).
  const lock = createDbLock();

  function assertGeneration(captured: number): void {
    if (captured !== generation) {
      throw new DbGenerationChangedError(captured, generation);
    }
  }

  /**
   * Free a handle that `close()` could not free safely, as soon as every holder
   * from before the close has released. Fire-and-forget: `close()` has already
   * returned and the module is logically closed by then.
   */
  function scheduleDeferredClose(db: Database, dbPath: string | null): void {
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reclaimable = await Promise.race([
        lock.whenStaleHoldersReleased().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), DEFERRED_CLOSE_TIMEOUT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);

      if (!reclaimable) {
        logger?.error?.(
          'DB deferred close gave up waiting for in-flight statements; the native handle stays open for the life of the process',
          { dbPath, timeoutMs: DEFERRED_CLOSE_TIMEOUT_MS, ...lock.stats() },
        );
        return;
      }

      try {
        // Exclusive against current work: the module may have been reopened on a
        // different handle by now, and freeing one handle should not overlap
        // statements running on the other.
        await lock.write(async () => {
          await db.close();
        });
        logger?.info?.('DB deferred close completed', { dbPath });
      } catch (err) {
        logger?.error?.('DB deferred close failed', {
          dbPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  function isWriteStatement(statement: string): boolean {
    return /\b(CREATE|MERGE|DELETE|SET|DROP|ALTER|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|DETACH)\b/i.test(statement);
  }

  async function readDbSchemaVersion(db: Database): Promise<string | undefined> {
    const conn = new lbug.Connection(db);
    let result: { getAll(): Promise<Record<string, LbugValue>[]>; close?: () => Promise<void> | void } | null = null;
    try {
      const raw = await conn.query(
        `MATCH (sv:${DB_SCHEMA_VERSION_TABLE}) WHERE sv.id = '${DB_SCHEMA_VERSION_NODE_ID}' RETURN sv.schema_version AS schema_version`
      );
      const queryResult = Array.isArray(raw) ? raw[0] : raw;
      result = queryResult;
      const rows = await queryResult.getAll();
      const version = rows[0]?.schema_version;
      if (typeof version === 'string') {
        return version;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      if (result && typeof result.close === 'function') {
        await result.close();
      }
      await conn.close();
    }
  }

  return {
    async open(dbPath: string): Promise<DbStatus> {
      logger?.info?.('DB open started', { dbPath });
      if (database) {
        logger?.warn?.('DB already open; closing existing database before reopen', { currentPath });
        // Closed OUTSIDE the write lock below: close() drains the lock, so
        // acquiring first would deadlock against its own drain.
        await this.close();
      }

      // Exclusive: schema initialisation and the version probe use raw
      // connections, and no other operation may touch the handle until the
      // status/generation are published.
      return lock.write(async () => {
        try {
          const dbDir = path.dirname(dbPath);
          if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
          }

          database = new lbug.Database(dbPath);
          currentPath = dbPath;

          logger?.info?.('DB schema initialization started', { dbPath });
          await initializeSchema(database);
          // Seed the schema version record for new databases and for existing
          // databases that predate version tracking. ensureDbSchemaVersionSeed
          // is idempotent — it does nothing when the record already exists.
          await ensureDbSchemaVersionSeed(database);
          logger?.info?.('DB schema initialization completed', { dbPath });

          const dbSchemaVersion = await readDbSchemaVersion(database);
          const schemaMismatch = dbSchemaVersion !== SCHEMA_VERSION;
          const warning = schemaMismatch
            ? `DB schema version mismatch: db=${dbSchemaVersion ?? 'missing'}, expected=${SCHEMA_VERSION}`
            : undefined;
          if (warning) {
            logger?.warn?.(warning, { dbPath, dbSchemaVersion: dbSchemaVersion ?? null, expectedSchemaVersion: SCHEMA_VERSION });
          }

          currentStatus = {
            state: 'open',
            path: dbPath,
            expectedSchemaVersion: SCHEMA_VERSION,
            migrationNeeded: schemaMismatch,
            readOnly: schemaMismatch,
            schemaVersion: dbSchemaVersion,
            warning,
          };
          generation += 1; // Req 5.1
          logger?.info?.('DB open completed', { dbPath });
          return currentStatus;
        } catch (err) {
          database = null;
          currentPath = null;
          const message = err instanceof Error ? err.message : String(err);
          currentStatus = { state: 'error', path: dbPath, error: message };
          logger?.error?.('DB open failed', { dbPath, error: message });
          return currentStatus;
        }
      });
    },

    async close(): Promise<void> {
      // Free the native handle under the exclusive lock, so nothing — read,
      // write, CHECKPOINT or open transaction — can be mid-statement against it.
      // Waiting for "no operation looks in flight" and then freeing outside the
      // lock is not sufficient: a queued waiter is granted in the gap, and the
      // wait itself can never succeed under continuous read load (a fresh read
      // is granted as soon as it arrives, so the reader count need never reach
      // zero).
      const release = await lock.tryAcquireWrite(closeLockTimeoutMs);
      const db = database;
      const closingPath = currentPath;

      if (release === null) {
        // Something is still executing against the handle. Calling db.close()
        // now is precisely the use-after-free that faults the worker with
        // 0xC0000005, so hand the free-ing off to scheduleDeferredClose, which
        // performs it once the straggler releases.
        //
        // The module still ends up logically closed here, and the generation bump
        // below fails every later caller fast, so the outgoing handle is already
        // unreachable from this module. Reopening the SAME path may report a lock
        // error until the deferred close lands (workspace-service retries that
        // case); a different path is unaffected.
        logger?.warn?.(
          'DB close could not obtain exclusive access within the timeout; deferring the native close rather than freeing the handle under an in-flight statement',
          { dbPath: closingPath, timeoutMs: closeLockTimeoutMs, ...lock.stats() },
        );
        database = null;
        currentPath = null;
        currentStatus = { state: 'closed' };
        generation += 1; // Req 5.2 — must precede reset() so nothing newly
        lock.reset();    // granted can reach the outgoing handle
        // After reset(), so the deferred close waits on the holders it discarded.
        if (db) scheduleDeferredClose(db, closingPath);
        return;
      }

      database = null;
      currentPath = null;

      logger?.info?.('DB close started', { dbPath: closingPath });

      try {
        if (db) {
          await db.close();
        }
      } finally {
        currentStatus = { state: 'closed' };
        generation += 1; // Req 5.2
        // Lock state must never survive a generation boundary: the handle is
        // gone and every queued operation now fails fast with
        // DbGenerationChangedError. Without this, a transaction left open across
        // a close (Req 5.5) would hold the write lock and block the next open().
        // reset() before release() so the next waiter is granted in the new
        // epoch; release() is then a no-op on the superseded epoch.
        lock.reset();
        release();
        logger?.info?.('DB close completed', { dbPath: closingPath });
      }
    },

    getStatus(): DbStatus {
      return currentStatus;
    },

    getConnection(): Connection {
      // Capture the generation at hand-out. A `null` handle means a concurrent
      // close() already superseded this database, so fail fast (Req 5.5). Callers
      // that hold a Connection across a close will additionally see the runQuery /
      // transaction re-checks throw DbGenerationChangedError.
      if (!database) {
        // Same error type in every no-handle case, because every caller that
        // treats a superseded operation as benign must keep doing so. Only the
        // wording differs: a module that was never opened, or whose open()
        // failed, is not a "generation change", and reporting it as one hides
        // the recorded open error from whoever has to diagnose it.
        throw new DbGenerationChangedError(
          generation,
          generation,
          currentStatus.state === 'error'
            ? `Database is not open — open() failed: ${currentStatus.error}`
            : generation === 0
              ? 'Database is not open — open() was never called'
              : undefined,
        );
      }
      return new lbug.Connection(database);
    },

    async runQuery(
      statement: string,
      params?: Record<string, unknown>
    ): Promise<Record<string, unknown>[]> {
      const captured = generation; // Req 5.3
      const isWrite = isWriteStatement(statement);
      if (currentStatus.readOnly && isWrite) {
        throw new Error(currentStatus.warning ?? 'Database is read-only until schema migration is completed');
      }

      // Mutating statements (including CHECKPOINT) are exclusive; reads share.
      // The generation is captured BEFORE queueing, so an operation that waited
      // behind a close() fails fast with DbGenerationChangedError (Req 5.4).
      const run = async (): Promise<Record<string, unknown>[]> => {
        assertGeneration(captured); // before acquiring the connection (Req 5.4)
        const conn = this.getConnection();
        const startedAt = Date.now();
        let result: { getAll(): Promise<Record<string, LbugValue>[]>; close?: () => Promise<void> | void } | null = null;
        try {
          if (params && Object.keys(params).length > 0) {
            const stmt = await conn.prepare(statement);
            const raw = await conn.execute(stmt, params as Record<string, LbugValue>);
            const queryResult = Array.isArray(raw) ? raw[0] : raw;
            result = queryResult;
            const rows = await queryResult.getAll();
            assertGeneration(captured); // after the await, before returning rows (Req 5.4)
            return rows;
          } else {
            const raw = await conn.query(statement);
            const queryResult = Array.isArray(raw) ? raw[0] : raw;
            result = queryResult;
            const rows = await queryResult.getAll();
            assertGeneration(captured); // after the await, before returning rows (Req 5.4)
            return rows;
          }
        } catch (error) {
          // If a concurrent open/close bumped the generation mid-flight, any native
          // error is noise — surface the benign DbGenerationChangedError instead.
          if (captured !== generation) {
            throw new DbGenerationChangedError(captured, generation);
          }
          logger?.error?.('DB query failed', {
            durationMs: Date.now() - startedAt,
            hasParams: Boolean(params && Object.keys(params).length > 0),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          // Best-effort cleanup: tolerate throws when the handle is already gone.
          try {
            if (result && typeof result.close === 'function') {
              await result.close();
            }
          } catch {
            /* handle superseded — ignore */
          }
          try {
            await conn.close();
          } catch {
            /* handle superseded — ignore */
          }
        }
      };

      return isWrite ? lock.write(run) : lock.read(run);
    },

    async checkpoint(): Promise<void> {
      if (currentStatus.readOnly) {
        throw new Error(currentStatus.warning ?? 'Database is read-only until schema migration is completed');
      }
      const captured = generation;
      // Exclusive. CHECKPOINT commits implicitly and reclaims WAL pages; running
      // it while another connection has a query in flight is what faulted the
      // worker with 0xC0000005.
      return lock.write(async () => {
        assertGeneration(captured);
        const conn = this.getConnection();
        logger?.info?.('DB checkpoint started');
        try {
          const raw = await conn.query('CHECKPOINT');
          const result = Array.isArray(raw) ? raw[0] : raw;
          result.close();
        } finally {
          await conn.close();
          logger?.info?.('DB checkpoint completed');
        }
      });
    },

    async beginTransaction(): Promise<DbTransaction> {
      if (currentStatus.readOnly) {
        throw new Error(currentStatus.warning ?? 'Database is read-only until schema migration is completed');
      }
      const txnGeneration = generation; // captured at begin (Req 5.5)
      // The write lock is held for the whole transaction, so no read, write,
      // CHECKPOINT or close can interleave with it. Statements inside the
      // transaction use DbTransaction.runQuery, which reuses this connection and
      // does NOT re-acquire the lock (the lock is not re-entrant).
      const release = await lock.acquireWrite({ isTransaction: true });
      let conn!: Connection;
      try {
        assertGeneration(txnGeneration);
        conn = this.getConnection();
        const beginRaw = await conn.query('BEGIN TRANSACTION');
        const beginResult = Array.isArray(beginRaw) ? beginRaw[0] : beginRaw;
        beginResult.close();
      } catch (error) {
        release(); // never leave the lock held when BEGIN never took effect
        throw error;
      }
      // A close() that bumps the generation mid-transaction turns the next
      // runQuery/commit into a benign DbGenerationChangedError rather than a
      // native fault (Req 5.5).
      const guard = (): void => {
        if (txnGeneration !== generation) {
          throw new DbGenerationChangedError(txnGeneration, generation);
        }
      };
      return {
        async runQuery(statement: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
          guard();
          let result: { getAll(): Promise<Record<string, LbugValue>[]>; close?: () => Promise<void> | void } | null = null;
          try {
            if (params && Object.keys(params).length > 0) {
              const stmt = await conn.prepare(statement);
              const raw = await conn.execute(stmt, params as Record<string, LbugValue>);
              const queryResult = Array.isArray(raw) ? raw[0] : raw;
              result = queryResult;
              return await queryResult.getAll();
            } else {
              const raw = await conn.query(statement);
              const queryResult = Array.isArray(raw) ? raw[0] : raw;
              result = queryResult;
              return await queryResult.getAll();
            }
          } finally {
            if (result && typeof result.close === 'function') {
              await result.close();
            }
          }
        },
        async commit(): Promise<void> {
          try {
            guard();
            try {
              const raw = await conn.query('COMMIT');
              const result = Array.isArray(raw) ? raw[0] : raw;
              result.close();
            } finally {
              await conn.close();
            }
          } finally {
            // Release even when guard()/COMMIT throws: the caller's catch block
            // then runs rollback(), whose release() call is a no-op.
            release();
          }
        },
        async rollback(): Promise<void> {
          // Best-effort ROLLBACK: tolerate a handle that is already gone (Req 5.5).
          try {
            const raw = await conn.query('ROLLBACK');
            const result = Array.isArray(raw) ? raw[0] : raw;
            result.close();
          } catch {
            /* handle superseded — ignore */
          } finally {
            try {
              await conn.close();
            } catch {
              /* handle superseded — ignore */
            }
            release();
          }
        },
      };
    },
  };
}
