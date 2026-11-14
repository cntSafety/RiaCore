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
 * Dual-engine binding: looks like a single engine binding to its caller, runs
 * every statement on the master (primary) and a shadow engine, and records
 * every difference between the two.
 *
 * ## Guarantees
 *
 *  - **The application sees the master.** Results, errors and their order come
 *    from the primary exactly as the plain binding would produce them.
 *    A shadow failure of any kind is recorded and swallowed, never surfaced â€”
 *    unless `dual.onMismatch` is `throw`, which a test campaign can use to fail
 *    fast. (An engine that aborts the whole process cannot be contained
 *    in-process; that is why native shadows run in a process of their own.)
 *  - **A shadow never holds the application up for long.** Once the master
 *    has answered, the shadow has `dual.shadowTimeoutMs` to answer as well;
 *    otherwise it is stopped, recorded as `shadow-timeout`, and left out for
 *    the rest of the session.
 *  - **Both engines see the same statement sequence.** Each statement runs on
 *    the primary and the shadow inside the caller's own lock slot, so
 *    the db-module's write exclusion orders writes identically for both.
 *  - **Mismatches are recorded, and replayable on request.** Each mismatch is
 *    written with both outcomes (graph-engine-recorder.ts). With
 *    `dual.journal` every statement is journalled too, and a mismatch bundle
 *    lets scripts/graph-engine/replay-mismatch.mjs rebuild both databases.
 *
 * ## Keeping the two database files in step
 *
 * The comparison only means something if both engines start from the same
 * data. `prepareDualFiles` (run by db-module before opening) checks the sync
 * marker in the pair's directory (`<db>.dual/` with a RiaGraph shadow,
 * `<db>.dual.ladybug/` with a ladybug one). If the shadow file is missing, the
 * last session did not close cleanly or diverged, or either file changed since
 * (e.g. the workspace was opened in single-engine mode in between), the shadow
 * file is discarded and re-seeded from the master, and the journal restarts:
 *
 *  - a RiaGraph shadow of ladybug gets a byte copy of ladybug's file, which
 *    RiaGraph reads;
 *  - a ladybug shadow of RiaGraph cannot read RiaGraph's file, so once both
 *    are open the master's `EXPORT DATABASE` is loaded into it with
 *    `IMPORT DATABASE`, which keeps every value, SERIAL ids and sequences
 *    included.
 */
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AppCoreLogger } from './db-module.js';
import {
  type GraphConnection,
  type GraphDatabase,
  type GraphEngineBinding,
  type GraphEngineName,
  type GraphPreparedStatement,
  type GraphQueryResult,
  type GraphRow,
  type ResolvedGraphEngineConfig,
  dualStateDir,
  engineDbPath,
  isWriteStatement,
  ladybugBinding,
} from './graph-engine.js';
import { compareResults, digestRows, encodeValue, isUnorderedLimit, normalizeErrorMessage, sameResultShape } from './graph-engine-compare.js';
import { DualRecorder, type EngineOutcome, type JournalEntry, type MismatchInput, type MismatchSummary } from './graph-engine-recorder.js';
import { hasPendingWal } from './wal-recovery.js';
import { ShadowDatabaseClosedError, ShadowProcessExitedError } from './graph-engine-shadow.js';
import * as path from 'node:path';

/** Thrown in `onMismatch: 'throw'` mode after the mismatch has been recorded. */
export class GraphEngineMismatchError extends Error {
  static readonly CODE = 'GRAPH_ENGINE_MISMATCH';
  readonly code = GraphEngineMismatchError.CODE;
  constructor(readonly mismatch: MismatchSummary, engines: { primary: string; shadow: string } = { primary: 'ladybug', shadow: 'RiaGraph' }) {
    super(`Graph engine mismatch (${mismatch.category}) ${mismatch.id}: ${engines.primary} and ${engines.shadow} disagree on: ${mismatch.statement}. Record: ${mismatch.file}`);
    this.name = 'GraphEngineMismatchError';
    Object.setPrototypeOf(this, GraphEngineMismatchError.prototype);
  }
}

// â”€â”€ Sync marker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface FileStamp { size: number; mtimeMs: number }

interface DualStateMarker {
  version: 1;
  /** True while a dual session has the pair open; still true after a crash. */
  open: boolean;
  /** Session that last opened (and so owns) the pair. */
  owner?: string;
  journalEntries: number;
  seededFromPrimary: boolean;
  /** The last session recorded a mismatch on a write: the shadow's data may differ. */
  diverged?: boolean;
  /** The shadow file was discarded and is to be loaded from the master's export once both are open. */
  pendingSeed?: boolean;
  files: { ladybug: FileStamp | null; riagraph: FileStamp | null };
  updatedAt: string;
}

/**
 * How a shadow that keeps a file is brought to its master's data, for the
 * pairs whose files are kept in step: a byte copy where the shadow reads the
 * master's file format, the master's EXPORT DATABASE otherwise.
 */
export type ShadowSeedMethod = 'copy' | 'export';

export function shadowSeedMethod(master: GraphEngineName, shadow: GraphEngineName): ShadowSeedMethod | null {
  if (master === 'ladybug' && shadow === 'riagraph') return 'copy';
  if (master === 'riagraph' && shadow === 'ladybug') return 'export';
  return null;
}

function stamp(file: string): FileStamp | null {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function markerPath(logicalDbPath: string, shadow: GraphEngineName): string {
  return path.join(dualStateDir(logicalDbPath, shadow), 'state.json');
}

function readMarker(logicalDbPath: string, shadow: GraphEngineName): DualStateMarker | null {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(logicalDbPath, shadow), 'utf-8')) as DualStateMarker;
    return marker.version === 1 ? marker : null;
  } catch {
    return null;
  }
}

function writeMarker(logicalDbPath: string, shadow: GraphEngineName, marker: Omit<DualStateMarker, 'version' | 'updatedAt' | 'files'>): void {
  fs.mkdirSync(dualStateDir(logicalDbPath, shadow), { recursive: true });
  const full: DualStateMarker = {
    version: 1,
    ...marker,
    files: {
      ladybug: stamp(engineDbPath(logicalDbPath, 'ladybug')),
      riagraph: stamp(engineDbPath(logicalDbPath, 'riagraph')),
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(markerPath(logicalDbPath, shadow), `${JSON.stringify(full, null, 2)}\n`);
}

export interface PrepareDualFilesOptions {
  master: GraphEngineName;
  shadow: GraphEngineName;
  /** Keep a copy of the seed for replay bundles (only when the journal is kept). */
  keepSeed: boolean;
  logger?: AppCoreLogger;
}

/**
 * Make sure the master's and the shadow's database files hold the same data
 * before a pair opens them, re-seeding the shadow from the master when that
 * cannot be established. Never touches the master's file except to
 * checkpoint a pending ladybug WAL into it, which is what opening it would do
 * anyway.
 */
export async function prepareDualFiles(logicalDbPath: string, options: PrepareDualFilesOptions): Promise<void> {
  const { master, shadow, logger } = options;
  const method = shadowSeedMethod(master, shadow);
  if (!method) throw new Error(`Graph engine pair ${master} + ${shadow} keeps no files in step`);
  const stateDir = dualStateDir(logicalDbPath, shadow);
  const primaryFile = engineDbPath(logicalDbPath, master);
  const shadowFile = engineDbPath(logicalDbPath, shadow);
  const marker = readMarker(logicalDbPath, shadow);
  const primaryExists = fs.existsSync(primaryFile);
  const shadowExists = fs.existsSync(shadowFile);

  if (!primaryExists && !shadowExists) {
    // Fresh pair: drop any stale bookkeeping so the journal starts empty.
    fs.rmSync(stateDir, { recursive: true, force: true });
    return;
  }
  let reason: string | null = null;
  if (!marker) reason = 'no sync marker';
  else if (marker.pendingSeed) reason = 'the shadow was never seeded';
  else if (marker.open) reason = 'the previous dual session did not close cleanly';
  else if (marker.diverged) reason = 'the previous dual session diverged';
  else if (!primaryExists || !shadowExists) reason = `the ${primaryExists ? shadow : master} database file is missing`;
  else if (!sameStamp(marker.files[master as 'ladybug' | 'riagraph'], stamp(primaryFile)) || !sameStamp(marker.files[shadow as 'ladybug' | 'riagraph'], stamp(shadowFile))) {
    reason = 'a database file changed outside a dual session';
  }
  if (!reason) return;

  logger?.warn?.(`Dual graph engine: ${shadow} database is not known to match ${master}; re-seeding it`, {
    dbPath: logicalDbPath,
    reason,
  });
  if (!marker && shadowExists) {
    // Not a file this pair made: the engine's own database from a time it ran
    // alone. It is not deleted but kept aside, in case it holds what ria-data does not.
    const kept = keepReplacedDatabase(logicalDbPath, shadowFile);
    logger?.warn?.(`Dual graph engine: kept the ${shadow} database the shadow replaces`, { dbPath: logicalDbPath, keptAt: kept });
  }
  for (const file of [shadowFile, `${shadowFile}.wal`, stateDir]) {
    fs.rmSync(file, { recursive: true, force: true });
  }
  if (!primaryExists) return;

  if (method === 'export') {
    // Both have to be open for this; the pair does it right after opening.
    writeMarker(logicalDbPath, shadow, { open: false, journalEntries: 0, seededFromPrimary: false, pendingSeed: true });
    return;
  }
  if (hasPendingWal(primaryFile)) {
    // Fold the WAL into the database file so the copy below is complete.
    const db = new ladybugBinding.Database(primaryFile);
    const conn = new ladybugBinding.Connection(db);
    try {
      const raw = await conn.query('CHECKPOINT');
      for (const r of Array.isArray(raw) ? raw : [raw]) await r.close();
    } finally {
      await conn.close();
      await db.close();
    }
  }
  fs.cpSync(primaryFile, shadowFile, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  if (options.keepSeed) fs.cpSync(primaryFile, path.join(stateDir, 'seed.lbug'), { recursive: true });
  writeMarker(logicalDbPath, shadow, { open: false, journalEntries: 0, seededFromPrimary: true });
}

/**
 * Where a pair keeps databases it replaced but did not create. The name is
 * covered by the workspace .gitignore's pair-directory entry (see extraGitignoreEntries).
 */
export function replacedDatabasesDir(logicalDbPath: string): string {
  return `${logicalDbPath}.dual.replaced`;
}

/** Move `file` (and its WAL) into replacedDatabasesDir under a timestamped name; returns the new path. */
function keepReplacedDatabase(logicalDbPath: string, file: string): string {
  const dir = replacedDatabasesDir(logicalDbPath);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${path.basename(file)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(file, target);
  if (fs.existsSync(`${file}.wal`)) fs.renameSync(`${file}.wal`, `${target}.wal`);
  return target;
}

/** A Cypher string literal of `text` (a file path), with forward slashes. */
function cypherPath(text: string): string {
  return `'${text.split(path.sep).join('/').replace(/\\/g, '/').replace(/'/g, "\\'")}'`;
}

/** Run one statement on its own connection and read it to the end. */
async function runOnce(binding: GraphEngineBinding, database: GraphDatabase, statement: string): Promise<void> {
  const conn = new binding.Connection(database);
  try {
    const raw = await conn.query(statement);
    for (const r of Array.isArray(raw) ? raw : [raw]) {
      await r.getAll();
      await r.close();
    }
  } finally {
    await conn.close();
  }
}

/**
 * EXPORT DATABASE writes every sequence as `CREATE SEQUENCE â€¦ START <current>`
 * followed by `RETURN nextval(â€¦)`, which makes `<current>` taken. For a
 * sequence that was never used (a SERIAL table that never had a row) that is
 * one too many: the master's next value is the start value, the import's is
 * the one after. Remove the nextval of every sequence the master has not used
 * (its `currval` is undefined), so the imported database continues exactly
 * where the master does. Fixed in RiaGraph by cntSafety/RiaGraph#87 (pinned
 * from nodejs-v0.22.0-2 on), whose exports then contain no such line, so this
 * changes nothing; it still covers an older RiaGraph given as `modulePath`,
 * and ladybug 0.19, which has the defect too.
 */
async function keepUnusedSequencesUnused(exportDir: string, master: DualMaster): Promise<void> {
  const schemaFile = path.join(exportDir, 'schema.cypher');
  const schema = fs.readFileSync(schemaFile, 'utf-8');
  const lines = schema.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const sequence = /^RETURN nextval\('([^']+)'\);\s*$/.exec(line.trim())?.[1];
    if (sequence && !(await sequenceUsed(master, sequence))) continue;
    kept.push(line);
  }
  if (kept.length !== lines.length) fs.writeFileSync(schemaFile, kept.join('\n'));
}

async function sequenceUsed(master: DualMaster, sequence: string): Promise<boolean> {
  try {
    await runOnce(master.binding, master.database, `RETURN currval('${sequence.replace(/'/g, "\\'")}')`);
    return true;
  } catch (err) {
    if (/not yet defined/i.test(errorText(err))) return false;
    throw err;
  }
}

/** The shadow did not answer within `dual.shadowTimeoutMs` of the master. */
export class ShadowTimeoutError extends Error {
  static readonly CODE = 'GRAPH_ENGINE_SHADOW_TIMEOUT';
  readonly code = ShadowTimeoutError.CODE;
  constructor(readonly timeoutMs: number, what: string, label: string) {
    super(`${label} shadow did not ${what} within ${timeoutMs} ms of the master; it is left out for the rest of the session`);
    this.name = 'ShadowTimeoutError';
    Object.setPrototypeOf(this, ShadowTimeoutError.prototype);
  }
  static is(err: unknown): err is ShadowTimeoutError {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ShadowTimeoutError.CODE;
  }
}

// â”€â”€ Buffered results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * A query result whose rows were already read (they had to be, to compare
 * them). Serves the cached rows through the subset of the QueryResult API
 * RiaCore and its tests use, and closes the underlying primary result.
 */
class BufferedQueryResult implements GraphQueryResult {
  private cursor = 0;
  constructor(private readonly rows: GraphRow[], private readonly underlying: GraphQueryResult) {}
  async getAll(): Promise<GraphRow[]> { return this.rows; }
  getAllSync(): GraphRow[] { return this.rows; }
  getNumTuples(): number { return this.rows.length; }
  hasNext(): boolean { return this.cursor < this.rows.length; }
  async getNext(): Promise<GraphRow | null> { return this.getNextSync(); }
  getNextSync(): GraphRow | null { return this.cursor < this.rows.length ? this.rows[this.cursor++] : null; }
  resetIterator(): void { this.cursor = 0; }
  getColumnNames(): Promise<string[]> { return (this.underlying as unknown as { getColumnNames(): Promise<string[]> }).getColumnNames(); }
  getColumnDataTypes(): Promise<string[]> { return (this.underlying as unknown as { getColumnDataTypes(): Promise<string[]> }).getColumnDataTypes(); }
  close(): void | Promise<void> { return this.underlying.close(); }
}

interface Collected {
  value: GraphQueryResult | GraphQueryResult[];
  rows: GraphRow[][];
}

async function collect(raw: GraphQueryResult | GraphQueryResult[], keepOpen: boolean): Promise<Collected> {
  const list = Array.isArray(raw) ? raw : [raw];
  const rows: GraphRow[][] = [];
  const wrapped: BufferedQueryResult[] = [];
  for (const result of list) {
    const r = await result.getAll();
    rows.push(r);
    if (keepOpen) wrapped.push(new BufferedQueryResult(r, result));
    else await result.close();
  }
  return { value: Array.isArray(raw) ? wrapped : wrapped[0], rows };
}

type Settled = { ok: true; collected: Collected; ms: number } | { ok: false; error: unknown; ms: number };

async function settle(run: () => Promise<Collected>): Promise<Settled> {
  const t0 = performance.now();
  try {
    const collected = await run();
    return { ok: true, collected, ms: performance.now() - t0 };
  } catch (error) {
    return { ok: false, error, ms: performance.now() - t0 };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// â”€â”€ Binding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** One side of a pair: an engine, its binding, and where it keeps its database. */
export interface DualEndpoint {
  engine: GraphEngineName;
  binding: GraphEngineBinding;
  /** Path the binding opens for the logical path `<workspace>/db` (a nested pair maps its own). */
  pathFor(logicalDbPath: string): string;
  /** Files whose paths appear in this engine's error messages, to be normalised away. */
  errorPaths(logicalDbPath: string): string[];
  /** Where the engine's package came from, for the session record. */
  module?: { modulePath: string; build: unknown };
}

/** The engine that really holds the data, as seen from a shadow that is to be loaded from it. */
export interface DualMaster {
  binding: GraphEngineBinding;
  database: GraphDatabase;
}

export interface DualBindingOptions {
  resolved: ResolvedGraphEngineConfig;
  primary: DualEndpoint;
  shadow: DualEndpoint;
  /**
   * How prepareDualFiles keeps the two database files in step (ladybug and
   * RiaGraph, either way round). Null when the pair has no sync marker and
   * starts a new journal every time it is opened.
   */
  seedMethod: ShadowSeedMethod | null;
  logger?: AppCoreLogger;
}

/** The pair's master after unwrapping nested pairs: the engine that really holds the data. */
interface RootedDatabase extends GraphDatabase { masterRoot?(): DualMaster }

/** Mismatch log directory for the workspace owning `logicalDbPath`. */
function mismatchLogDirFor(logicalDbPath: string, resolved: ResolvedGraphEngineConfig): string {
  const configured = resolved.config.dual.mismatchLogDir;
  return configured
    ? path.resolve(resolved.baseDir, configured)
    : path.join(path.dirname(logicalDbPath), 'logs', 'graph-engine-mismatches');
}

/** A shadow database that can be stopped at once (its process killed) when it stops answering. */
interface AbortableDatabase extends GraphDatabase { abort?(): void }

/** Seeding a shadow may take this many times the per-statement allowance. */
const SEED_TIMEOUT_FACTOR = 10;

export function createDualBinding(options: DualBindingOptions): GraphEngineBinding {
  const { resolved, logger, seedMethod } = options;
  const fileSync = seedMethod !== null;
  const primaryBinding = options.primary.binding;
  // A shadow RiaGraph or ladybug arrives here already wrapped in its own process
  // (graph-engine-shadow.ts): the two must never share one with the other.
  const shadowBinding = options.shadow.binding;
  const primaryEngine = options.primary.engine;
  const shadowEngine = options.shadow.engine;
  const shadowLabel = shadowEngine === 'riagraph' ? 'RiaGraph' : shadowEngine;
  const primaryLabel = primaryEngine === 'riagraph' ? 'RiaGraph' : primaryEngine;
  const dual = resolved.config.dual;
  let nextConnectionId = 0;

  class DualPreparedStatement implements GraphPreparedStatement {
    constructor(
      readonly statement: string,
      readonly primary: GraphPreparedStatement,
      readonly shadow: GraphPreparedStatement | null,
      readonly shadowError: unknown,
    ) {}
    isSuccess(): boolean { return this.primary.isSuccess(); }
    getErrorMessage(): string { return this.primary.getErrorMessage(); }
  }

  class DualDatabase implements GraphDatabase {
    readonly logicalPath: string;
    readonly primary: GraphDatabase;
    shadow: GraphDatabase | null = null;
    readonly recorder: DualRecorder;
    readonly errorPaths: string[];
    readonly stateDir: string;
    private closed = false;
    /** The shadow is to be loaded from the master's export in afterOpen. */
    private pendingSeed = false;

    constructor(logicalPath: string, ...rest: unknown[]) {
      this.logicalPath = logicalPath;
      const primaryPath = options.primary.pathFor(logicalPath);
      const shadowPath = options.shadow.pathFor(logicalPath);
      const stateDir = dualStateDir(logicalPath, shadowEngine);
      this.stateDir = stateDir;
      this.errorPaths = [...options.primary.errorPaths(logicalPath), ...options.shadow.errorPaths(logicalPath)];
      // The primary is constructed first and exactly as the plain binding
      // would be; if it throws, so does this, before anything else happens.
      this.primary = new (primaryBinding.Database as new (...a: unknown[]) => GraphDatabase)(primaryPath, ...rest);

      const marker = fileSync ? readMarker(logicalPath, shadowEngine) : null;
      this.pendingSeed = !!marker?.pendingSeed;
      const inSync = !!marker && !marker.pendingSeed && fs.existsSync(shadowPath);
      if (!inSync) {
        // Without a marker the journal on disk (if any) does not describe this
        // pair's history; start a new one rather than append to it.
        fs.rmSync(path.join(stateDir, 'journal.jsonl'), { force: true });
      }
      this.recorder = new DualRecorder({
        logicalDbPath: logicalPath,
        dualDir: stateDir,
        mismatchLogDir: mismatchLogDirFor(logicalPath, resolved),
        journal: dual.journal,
        maxMismatchRecords: dual.maxMismatchRecords,
        engineGeneratedKeys: dual.engineGeneratedKeys,
        configSource: resolved.source,
        seed: !inSync ? 'fresh' : marker!.seededFromPrimary && marker!.journalEntries === 0 ? 'seeded-from-primary' : 'in-sync',
        journalEntries: inSync ? marker!.journalEntries : 0,
        engines: {
          primary: { engine: primaryEngine, version: primaryBinding.version, ...(options.primary.module ?? {}) },
          shadow: { engine: shadowEngine, version: shadowBinding.version, modulePath: options.shadow.module?.modulePath ?? '', build: options.shadow.module?.build ?? null },
        },
        logger,
      });
      if (fileSync) {
        try {
          writeMarker(logicalPath, shadowEngine, {
            open: true,
            owner: this.recorder.sessionId,
            journalEntries: this.recorder.journalEntries,
            seededFromPrimary: inSync ? marker!.seededFromPrimary : false,
          });
        } catch (err) {
          logger?.warn?.('Dual graph engine: could not write sync marker', { dbPath: logicalPath, error: errorText(err) });
        }
      }
      try {
        this.shadow = new (shadowBinding.Database as new (...a: unknown[]) => GraphDatabase)(shadowPath, ...rest);
      } catch (err) {
        this.shadowUnavailable('open', err);
      }
    }

    /** The engine that really holds the data: this pair's primary, or the master of a nested pair. */
    masterRoot(): DualMaster {
      return (this.primary as RootedDatabase).masterRoot?.() ?? { binding: primaryBinding, database: this.primary };
    }

    /**
     * After both databases are constructed, before the schema is initialised:
     * lets a nested pair finish its own set-up, then loads a shadow that cannot
     * read the master's file from the master's export. A shadow that cannot be
     * seeded is recorded as unavailable and left out, as when its open fails.
     */
    async afterOpen(): Promise<void> {
      await this.primary.afterOpen?.();
      if (!this.shadow) return;
      const shadow = this.shadow;
      const seedDeadline = dual.shadowTimeoutMs * SEED_TIMEOUT_FACTOR;
      try {
        await this.withinDeadline(shadow.afterOpen?.() ?? Promise.resolve(), seedDeadline, 'open');
        if (this.pendingSeed) {
          await this.seedFromExport(seedDeadline);
          this.recorder.noteSeededFromPrimary();
        }
      } catch (err) {
        if (this.shadow) {
          try { await this.withinDeadline(this.shadow.close(), dual.shadowTimeoutMs, 'close'); } catch { /* already unusable */ }
        }
        this.shadowUnavailable('open', err);
      }
    }

    /**
     * Load the master's data into a shadow that cannot read the master's file
     * (ladybug behind RiaGraph): the master's EXPORT DATABASE, then IMPORT
     * DATABASE on the shadow's new, empty database. The export is kept as the
     * seed of replay bundles only when the journal is.
     */
    private async seedFromExport(deadlineMs: number): Promise<void> {
      const dir = path.join(this.stateDir, 'seed-export');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(this.stateDir, { recursive: true });
      const master = this.masterRoot();
      const startedAt = performance.now();
      await runOnce(master.binding, master.database, `EXPORT DATABASE ${cypherPath(dir)} (format='parquet')`);
      await keepUnusedSequencesUnused(dir, master);
      await this.withinDeadline(runOnce(shadowBinding, this.shadow!, `IMPORT DATABASE ${cypherPath(dir)}`), deadlineMs, 'import the master\'s data');
      if (!dual.journal) fs.rmSync(dir, { recursive: true, force: true });
      this.pendingSeed = false;
      logger?.info?.(`Dual graph engine: ${shadowLabel} database seeded from the ${primaryEngine} master`, {
        dbPath: this.logicalPath,
        ms: Math.round(performance.now() - startedAt),
      });
    }

    /**
     * Wait for a shadow operation, but not longer than `ms` (0: no limit). On
     * time-out the shadow is stopped and dropped from the session; the
     * returned promise rejects with ShadowTimeoutError.
     */
    withinDeadline<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
      if (ms <= 0) return operation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.abandonShadow();
          reject(new ShadowTimeoutError(ms, what, shadowLabel));
        }, ms);
      });
      operation.catch(() => { /* a late failure of an abandoned shadow is of no interest */ });
      return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    }

    /** Stop a shadow that no longer answers and leave it out from here on. */
    abandonShadow(): void {
      const shadow = this.shadow as AbortableDatabase | null;
      this.shadow = null;
      try { shadow?.abort?.(); } catch { /* already gone */ }
    }

    shadowUnavailable(stage: string, err: unknown): void {
      this.recorder.recordMismatch({
        category: ShadowTimeoutError.is(err) ? 'shadow-timeout' : 'shadow-unavailable',
        seq: this.recorder.journalEntries,
        conn: -1,
        op: 'query',
        statement: `<${stage} ${shadowLabel} database>`,
        write: true,
        inTransaction: false,
        primary: null,
        shadow: { ok: false, error: errorText(err), ms: 0 },
      });
      this.shadow = null;
    }

    async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      let primaryCloseFailed = false;
      let shadowCloseError: unknown = null;
      try {
        await this.primary.close();
      } catch (err) {
        primaryCloseFailed = true;
        throw err;
      } finally {
        if (this.shadow) {
          try {
            await this.withinDeadline(this.shadow.close(), dual.shadowTimeoutMs, 'close');
          } catch (err) {
            shadowCloseError = err;
          }
        }
        if (shadowCloseError) {
          logger?.warn?.(`Dual graph engine: ${shadowLabel} database close failed`, { dbPath: this.logicalPath, error: errorText(shadowCloseError) });
        }
        this.recorder.close({ shadowCloseError: shadowCloseError ? errorText(shadowCloseError) : null });
        // A `return` here would swallow the primary's close error thrown above.
        if (fileSync) {
          try {
            const current = readMarker(this.logicalPath, shadowEngine);
            // A deferred close of an earlier handle can land after a newer
            // session on the same files opened; the marker is that session's now.
            if (!current?.owner || current.owner === this.recorder.sessionId) {
              // Only a pair that both closed cleanly is trusted as in sync next time.
              const trusted = !primaryCloseFailed && !shadowCloseError && this.shadow !== null;
              writeMarker(this.logicalPath, shadowEngine, {
                open: !trusted,
                owner: this.recorder.sessionId,
                journalEntries: this.recorder.journalEntries,
                seededFromPrimary: current?.seededFromPrimary ?? false,
                // A mismatch on a write may have left different data behind:
                // the next pair re-seeds, and the shadow's file is not used alone.
                diverged: this.recorder.divergence !== null,
                pendingSeed: this.pendingSeed,
              });
            }
          } catch (err) {
            logger?.warn?.('Dual graph engine: could not write sync marker', { dbPath: this.logicalPath, error: errorText(err) });
          }
        }
      }
    }
  }

  class DualConnection implements GraphConnection {
    private readonly db: DualDatabase;
    private readonly primary: GraphConnection;
    private shadow: GraphConnection | null = null;
    private readonly id = (nextConnectionId += 1);
    private inTransaction = false;

    constructor(database: GraphDatabase) {
      if (!(database instanceof DualDatabase)) {
        throw new Error('Dual graph engine: Connection requires a database opened through the dual binding');
      }
      this.db = database;
      this.primary = new primaryBinding.Connection(database.primary);
      if (database.shadow) {
        try {
          this.shadow = new shadowBinding.Connection(database.shadow);
        } catch (err) {
          database.shadowUnavailable('connect to', err);
        }
      }
    }

    query(statement: string): Promise<GraphQueryResult | GraphQueryResult[]> {
      return this.pair('query', statement, undefined, () => this.primary.query(statement), (s) => s.query(statement));
    }

    async prepare(statement: string): Promise<GraphPreparedStatement> {
      let primary: GraphPreparedStatement | null = null;
      let primaryError: unknown = null;
      let primaryMs = 0;
      let shadow: GraphPreparedStatement | null = null;
      let shadowError: unknown = null;
      const t1 = performance.now();
      const shadowConn = this.db.shadow ? this.shadow : null;
      // Concurrently, as in pair().
      const shadowDone = shadowConn
        ? (async () => { try { shadow = await shadowConn.prepare(statement); } catch (err) { shadowError = err; } })()
        : Promise.resolve();
      const t0 = performance.now();
      try { primary = await this.primary.prepare(statement); } catch (err) { primaryError = err; }
      primaryMs = performance.now() - t0;
      try {
        await this.db.withinDeadline(shadowDone, dual.shadowTimeoutMs, 'prepare a statement');
      } catch (err) {
        // Timed out: the shadow is out of the session from here on.
        shadow = null;
        shadowError = err;
        this.recordShadowTimeout('prepare', statement, err, primaryMs);
      }
      if (primary) return new DualPreparedStatement(statement, primary, shadow, shadowError);

      // The primary rejected outright, so execute() will never run: compare the
      // rejection here. (A shadow-only rejection surfaces at execute time.)
      if (this.db.shadow && this.shadow && !ShadowTimeoutError.is(shadowError)) {
        const norm = (e: unknown) => normalizeErrorMessage(errorText(e), this.db.errorPaths);
        const category = shadow ? 'error'
          : ShadowDatabaseClosedError.is(shadowError) || norm(primaryError) === norm(shadowError) ? null
          : 'error-message';
        if (category) {
          this.db.recorder.recordMismatch({
            category,
            seq: this.db.recorder.journalEntries,
            conn: this.id,
            op: 'prepare',
            statement,
            write: isWriteStatement(statement),
            inTransaction: this.inTransaction,
            primary: { ok: false, error: errorText(primaryError), normalizedError: norm(primaryError), ms: primaryMs },
            shadow: shadow
              ? { ok: true, results: [], ms: performance.now() - t1 }
              : { ok: false, error: errorText(shadowError), normalizedError: norm(shadowError), ms: performance.now() - t1 },
          });
        }
      }
      throw primaryError;
    }

    execute(preparedStatement: GraphPreparedStatement, params?: Record<string, unknown>): Promise<GraphQueryResult | GraphQueryResult[]> {
      if (!(preparedStatement instanceof DualPreparedStatement)) {
        // Not prepared through this connection: nothing to compare against.
        return this.primary.execute(preparedStatement, params);
      }
      const ps = preparedStatement;
      return this.pair(
        'execute',
        ps.statement,
        params,
        () => this.primary.execute(ps.primary, params),
        (s) => (ps.shadow ? s.execute(ps.shadow, params) : Promise.reject(ps.shadowError ?? new Error(`${shadowLabel} statement was not prepared`))),
      );
    }

    async close(): Promise<void> {
      try {
        await this.primary.close();
      } finally {
        if (this.shadow && this.db.shadow) {
          try {
            await this.db.withinDeadline(this.shadow.close(), dual.shadowTimeoutMs, 'close a connection');
          } catch { /* recorded nowhere: closing is not a result */ }
        }
      }
    }

    /** A shadow that took too long outside a statement's comparison (prepare). */
    private recordShadowTimeout(op: 'prepare', statement: string, err: unknown, primaryMs: number): void {
      this.db.recorder.recordMismatch({
        category: 'shadow-timeout',
        seq: this.db.recorder.journalEntries,
        conn: this.id,
        op,
        statement,
        write: isWriteStatement(statement),
        inTransaction: this.inTransaction,
        primary: null,
        shadow: { ok: false, error: errorText(err), ms: primaryMs + dual.shadowTimeoutMs },
      });
    }

    private async pair(
      op: 'query' | 'execute',
      statement: string,
      params: Record<string, unknown> | undefined,
      runPrimary: () => Promise<GraphQueryResult | GraphQueryResult[]>,
      runShadow: (shadow: GraphConnection) => Promise<GraphQueryResult | GraphQueryResult[]>,
    ): Promise<GraphQueryResult | GraphQueryResult[]> {
      const recorder = this.db.recorder;
      const seq = recorder.nextSeq();
      const write = isWriteStatement(statement);
      const inTransaction = this.inTransaction;

      // Both engines run the statement at the same time: each binding executes
      // on its own native worker, so the wall time is the slower engine's, not
      // the sum. Ordering across statements is unaffected â€” both run inside the
      // caller's lock slot, and writes hold that slot exclusively.
      const shadowConn = this.db.shadow ? this.shadow : null;
      const shadowRun = shadowConn ? settle(async () => collect(await runShadow(shadowConn), false)) : Promise.resolve(null);
      const p = await settle(async () => collect(await runPrimary(), true));
      // The shadow gets dual.shadowTimeoutMs more once the master has answered.
      const s: Settled | null = await this.db.withinDeadline(shadowRun, dual.shadowTimeoutMs, 'answer')
        .catch((error: unknown): Settled => ({ ok: false, error, ms: p.ms + dual.shadowTimeoutMs }));

      if (p.ok && /^\s*BEGIN\b/i.test(statement)) this.inTransaction = true;
      if (/^\s*(COMMIT|ROLLBACK)\b/i.test(statement)) this.inTransaction = false;

      const ignore = dual.engineGeneratedKeys;
      const outcome = (r: Settled): EngineOutcome => (r.ok
        ? { ok: true, results: r.collected.rows, digest: digestRows(r.collected.rows, ignore), ms: r.ms }
        : { ok: false, error: errorText(r.error), normalizedError: normalizeErrorMessage(errorText(r.error), this.db.errorPaths), ms: r.ms });
      const po = outcome(p);
      // A statement that was still running on a shadow stopped for another
      // statement's time-out has nothing to compare.
      const abandoned = s !== null && !s.ok && ShadowDatabaseClosedError.is(s.error) && this.db.shadow === null;
      const so = s && !abandoned ? outcome(s) : null;

      let mismatch: Omit<MismatchInput, 'seq' | 'conn' | 'op' | 'statement' | 'params' | 'write' | 'inTransaction' | 'primary' | 'shadow'> | null = null;
      let orderOnly = false;
      let unorderedLimit = false;
      const shadowCrashed = s !== null && !s.ok && ShadowProcessExitedError.is(s.error);
      const shadowTimedOut = s !== null && !s.ok && ShadowTimeoutError.is(s.error);
      // Dual mode closed the shadow because the application closed the database:
      // when the master refuses the statement too, both engines agree.
      const shadowClosed = s !== null && !s.ok && ShadowDatabaseClosedError.is(s.error);
      if (shadowCrashed) {
        // The shadow process died: this statement is the prime suspect when
        // it was in flight, and nothing can be compared from here on.
        mismatch = { category: 'shadow-crash' };
        this.db.shadow = null;
      } else if (shadowTimedOut) {
        // withinDeadline already stopped the shadow and dropped it.
        mismatch = { category: 'shadow-timeout' };
      } else if (shadowClosed && !po.ok) {
        // Nothing to compare.
      } else if (so) {
        if (po.ok && so.ok) {
          const cmp = compareResults(po.results!, so.results!, ignore);
          if (cmp.equal) orderOnly = cmp.orderOnly;
          // A LIMIT without ORDER BY lets each engine pick its rows: both are
          // right as long as the answers have the same shape.
          else if (isUnorderedLimit(statement) && sameResultShape(po.results!, so.results!)) unorderedLimit = true;
          else mismatch = { category: 'content', diffs: cmp.diffs, resultCountMismatch: cmp.resultCountMismatch };
        } else if (po.ok !== so.ok) {
          mismatch = { category: 'error' };
        } else if (po.normalizedError !== so.normalizedError) {
          mismatch = { category: 'error-message' };
        }
      }

      const entry: JournalEntry = {
        seq,
        conn: this.id,
        op,
        statement,
        ...(params && Object.keys(params).length > 0 ? { params: encodeValue(params) } : {}),
        write,
        primary: po.ok ? { ok: true, digest: po.digest } : { ok: false, error: po.error },
        shadow: so ? (so.ok ? { ok: true, digest: so.digest } : { ok: false, error: so.error }) : null,
      };
      recorder.noteStatement(entry, { primaryMs: po.ms, shadowMs: so?.ms ?? 0 }, so !== null, orderOnly, unorderedLimit);

      let summary: MismatchSummary | null = null;
      if (mismatch) {
        summary = recorder.recordMismatch({
          ...mismatch,
          seq,
          conn: this.id,
          op,
          statement,
          params,
          write,
          inTransaction,
          primary: po,
          shadow: so,
        });
      }

      if (!p.ok) throw p.error;
      if (summary && dual.onMismatch === 'throw') {
        for (const r of Array.isArray(p.collected.value) ? p.collected.value : [p.collected.value]) {
          try { await r.close(); } catch { /* already reported */ }
        }
        throw new GraphEngineMismatchError(summary, { primary: primaryLabel, shadow: shadowLabel });
      }
      return p.collected.value;
    }
  }

  return {
    name: 'dual',
    get version() { return `${primaryEngine} ${primaryBinding.version} + ${shadowEngine} ${shadowBinding.version}`; },
    Database: DualDatabase as unknown as GraphEngineBinding['Database'],
    Connection: DualConnection as unknown as GraphEngineBinding['Connection'],
  };
}
