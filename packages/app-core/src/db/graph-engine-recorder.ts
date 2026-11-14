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
 * Bookkeeping for dual-engine mode: the mismatch log, per-session statistics
 * and, when `dual.journal` is on, the statement journal that makes every
 * mismatch replayable.
 *
 * ## Layout
 *
 * Next to the database (`<workspace>/db.dual/` for a RiaGraph shadow,
 * `db.dual.<engine>/` for another; survives across sessions and is deleted
 * together with the database files):
 *
 *   state.json     sync marker — whether the master's and the shadow's files
 *                  are known to hold the same data (see graph-engine-dual.ts)
 *   seed.lbug      copy of the ladybug master's file a RiaGraph shadow was
 *                  seeded from (journal only)
 *   seed-export/   the RiaGraph master's EXPORT DATABASE a ladybug shadow was
 *                  loaded from (journal only)
 *   journal.jsonl  every statement executed against the pair since creation
 *                  or seeding, in order, with both engines' outcomes (journal only)
 *
 * In the mismatch log directory (default `<workspace>/logs/graph-engine-mismatches`,
 * configurable so a test campaign can collect everything in one place):
 *
 *   sessions.jsonl     one line per dual session: engines, counts, timings
 *   mismatches.jsonl   one line per mismatch, pointing into its bundle
 *   <sessionId>/       the session's records, written on its first mismatch:
 *       session.json         engines, versions, RiaGraph commit, paths
 *       mismatch-0001.json   statement, params, journal position, both
 *                            engines' full results or errors, and the diff
 *       seed.lbug | seed-export/, journal.jsonl
 *                            with the journal: starting database and the
 *                            statements up to (and past) each mismatch
 *
 * At most `dual.maxMismatchRecords` mismatches are written per session; the
 * rest are counted in sessions.jsonl. With the journal,
 * `scripts/graph-engine/replay-mismatch.mjs <bundle>` rebuilds both databases
 * from seed + journal and re-runs the mismatching statement.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppCoreLogger } from './db-module.js';
import type { GraphEngineName, GraphRow } from './graph-engine.js';
import { encodeValue, type ResultDiff } from './graph-engine-compare.js';

export type MismatchCategory =
  /** Both engines succeeded with different results. */
  | 'content'
  /** One engine failed, the other did not. */
  | 'error'
  /** Both failed, with different (normalised) messages. */
  | 'error-message'
  /** The shadow engine could not be opened or connected at all. */
  | 'shadow-unavailable'
  /** The shadow process died (crashed or aborted) while executing the statement. */
  | 'shadow-crash'
  /** The shadow did not answer within dual.shadowTimeoutMs of the master and was stopped. */
  | 'shadow-timeout';

export interface EngineOutcome {
  ok: boolean;
  /** Row lists, one per result, when ok. */
  results?: GraphRow[][];
  error?: string;
  /** Normalised error, as compared. */
  normalizedError?: string;
  digest?: string;
  ms: number;
}

export interface JournalEntry {
  seq: number;
  conn: number;
  op: 'query' | 'execute' | 'prepare';
  statement: string;
  params?: unknown;
  write: boolean;
  primary: { ok: boolean; digest?: string; error?: string };
  shadow: { ok: boolean; digest?: string; error?: string } | null;
}

export interface MismatchInput {
  category: MismatchCategory;
  seq: number;
  conn: number;
  op: JournalEntry['op'];
  statement: string;
  params?: Record<string, unknown>;
  write: boolean;
  inTransaction: boolean;
  primary: EngineOutcome | null;
  shadow: EngineOutcome | null;
  diffs?: ResultDiff[];
  resultCountMismatch?: { primary: number; shadow: number };
}

export interface MismatchSummary {
  id: string;
  category: MismatchCategory;
  sessionId: string;
  bundle: string;
  file: string;
  seq: number;
  write: boolean;
  statement: string;
  /** Id of the first state-changing mismatch in this session, when this one came after it. */
  afterDivergence: string | null;
  dbPath: string;
  test: TestContext | null;
  at: string;
}

export interface DualSessionEngines {
  primary: { engine: GraphEngineName; version: string; modulePath?: string; build?: unknown };
  shadow: { engine: GraphEngineName; version: string; modulePath: string; build: unknown };
}

export interface DualRecorderOptions {
  logicalDbPath: string;
  dualDir: string;
  mismatchLogDir: string;
  journal: boolean;
  engines: DualSessionEngines;
  configSource: string | null;
  seed: 'fresh' | 'in-sync' | 'seeded-from-primary';
  /** Result keys excluded from comparison (dual.engineGeneratedKeys). */
  engineGeneratedKeys: readonly string[];
  /** Number of journal entries already in `<dualDir>/journal.jsonl`. */
  journalEntries: number;
  /** Mismatch records written in this session; later mismatches are counted only. 0: no limit. */
  maxMismatchRecords?: number;
  logger?: AppCoreLogger;
}

interface TestContext {
  file?: string;
  name?: string;
  context?: string;
}

/** Results kept in a mismatch file per engine; the diff covers everything. */
const MAX_RECORDED_ROWS = 2000;
/** Journal lines are buffered and written in batches of about this many bytes. */
const JOURNAL_FLUSH_BYTES = 1 << 20;

/** Best-effort name of the running test, so a campaign mismatch points at its source. */
function currentTestContext(): TestContext | null {
  const ctx: TestContext = {};
  const worker = (globalThis as { __vitest_worker__?: { filepath?: string; current?: { name?: string }; ctx?: { files?: Array<string | { filepath?: string }> } } }).__vitest_worker__;
  if (worker) {
    const firstFile = worker.ctx?.files?.[0];
    ctx.file = worker.filepath ?? (typeof firstFile === 'string' ? firstFile : firstFile?.filepath);
    ctx.name = worker.current?.name;
  }
  if (process.env.RIACORE_GRAPH_TEST_CONTEXT) ctx.context = process.env.RIACORE_GRAPH_TEST_CONTEXT;
  if (process.env.PYTEST_CURRENT_TEST) ctx.context = process.env.PYTEST_CURRENT_TEST;
  return ctx.file || ctx.name || ctx.context ? ctx : null;
}

function encodeOutcome(outcome: EngineOutcome | null): unknown {
  if (!outcome) return null;
  const results = outcome.results?.map((rows) => ({
    rowCount: rows.length,
    rows: rows.slice(0, MAX_RECORDED_ROWS).map((row) => encodeValue(row)),
    truncated: rows.length > MAX_RECORDED_ROWS,
  }));
  return {
    ok: outcome.ok,
    ms: Math.round(outcome.ms * 1000) / 1000,
    ...(outcome.ok ? { digest: outcome.digest, results } : { error: outcome.error, normalizedError: outcome.normalizedError }),
  };
}

export class DualRecorder {
  readonly sessionId: string;
  private readonly opts: { -readonly [K in keyof DualRecorderOptions]: DualRecorderOptions[K] };
  private readonly journalFile: string;
  private readonly startedAt = new Date();
  private seq: number;
  private pending: string[] = [];
  private pendingBytes = 0;
  private bundleDir: string | null = null;
  /** Bytes of journal.jsonl already copied into the bundle. */
  private bundleJournalBytes = 0;
  private mismatchCount = 0;
  private divergedAt: string | null = null;
  private closed = false;
  private journalBroken = false;
  readonly stats = {
    statements: 0,
    writes: 0,
    compared: 0,
    uncompared: 0,
    orderOnly: 0,
    /** LIMIT without ORDER BY: different rows of the same shape, accepted (see isUnorderedLimit). */
    unorderedLimit: 0,
    primaryMs: 0,
    shadowMs: 0,
    mismatches: { content: 0, error: 0, 'error-message': 0, 'shadow-unavailable': 0, 'shadow-crash': 0, 'shadow-timeout': 0 } as Record<MismatchCategory, number>,
    /** Mismatches counted but not written, past maxMismatchRecords. */
    unrecorded: 0,
  };

  constructor(opts: DualRecorderOptions) {
    this.opts = opts;
    this.sessionId = `${this.startedAt.toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(3).toString('hex')}`;
    this.journalFile = path.join(opts.dualDir, 'journal.jsonl');
    this.seq = opts.journalEntries;
    try {
      fs.mkdirSync(opts.mismatchLogDir, { recursive: true });
      fs.appendFileSync(path.join(opts.mismatchLogDir, 'started.jsonl'), `${JSON.stringify({
        sessionId: this.sessionId,
        dbPath: opts.logicalDbPath,
        startedAt: this.startedAt.toISOString(),
        pid: process.pid,
        engines: opts.engines,
        test: currentTestContext(),
      })}\n`);
    } catch (err) {
      opts.logger?.warn?.('Graph engine mismatch log directory is not writable', {
        dir: opts.mismatchLogDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The shadow was brought to data the master already held (not created empty beside it). */
  noteSeededFromPrimary(): void {
    this.opts.seed = 'seeded-from-primary';
  }

  get journalEntries(): number {
    return this.seq;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Id of the first mismatch after which the shadow's state may differ. */
  get divergence(): string | null {
    return this.divergedAt;
  }

  noteStatement(entry: JournalEntry, timing: { primaryMs: number; shadowMs: number }, compared: boolean, orderOnly: boolean, unorderedLimit = false): void {
    this.stats.statements += 1;
    if (entry.write) this.stats.writes += 1;
    if (compared) this.stats.compared += 1; else this.stats.uncompared += 1;
    if (orderOnly) this.stats.orderOnly += 1;
    if (unorderedLimit) this.stats.unorderedLimit += 1;
    this.stats.primaryMs += timing.primaryMs;
    this.stats.shadowMs += timing.shadowMs;
    if (!this.opts.journal || this.journalBroken) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.pending.push(line);
    this.pendingBytes += line.length;
    if (this.pendingBytes >= JOURNAL_FLUSH_BYTES) this.flushJournal();
  }

  flushJournal(): void {
    if (this.pending.length === 0) return;
    try {
      fs.mkdirSync(this.opts.dualDir, { recursive: true });
      fs.appendFileSync(this.journalFile, this.pending.join(''));
    } catch (err) {
      // A journal that silently loses lines would make replays lie. Stop
      // journalling instead and say so; mismatches are still recorded.
      this.journalBroken = true;
      this.opts.logger?.error?.('Graph engine journal write failed; mismatches from now on are not replayable', {
        journal: this.journalFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Record a mismatch, write its reproduction bundle entry, and return its summary. */
  recordMismatch(input: MismatchInput): MismatchSummary {
    this.mismatchCount += 1;
    this.stats.mismatches[input.category] += 1;
    const id = `${this.sessionId}#${String(this.mismatchCount).padStart(4, '0')}`;
    const afterDivergence = this.divergedAt;
    // A mismatch on anything that changes state (or inside a transaction, whose
    // effect is only decided at COMMIT) means the shadow may now hold different
    // data, so later mismatches in this session may just be consequences.
    if (!this.divergedAt && (input.write || input.inTransaction)) this.divergedAt = id;

    const limit = this.opts.maxMismatchRecords ?? 0;
    if (limit > 0 && this.mismatchCount > limit) {
      // Past the limit (a diverged shadow can mismatch on every statement):
      // counted in the session summary, not written.
      this.stats.unrecorded += 1;
      if (this.stats.unrecorded === 1) {
        this.opts.logger?.warn?.(`Graph engine mismatch limit reached (${limit}); further mismatches of this session are counted only`, {
          sessionId: this.sessionId,
          dbPath: this.opts.logicalDbPath,
        });
      }
      return {
        id,
        category: input.category,
        sessionId: this.sessionId,
        bundle: this.bundleDir ?? '',
        file: '(not recorded: mismatch limit reached)',
        seq: input.seq,
        write: input.write,
        statement: input.statement.length > 400 ? `${input.statement.slice(0, 400)}…` : input.statement,
        afterDivergence,
        dbPath: this.opts.logicalDbPath,
        test: null,
        at: new Date().toISOString(),
      };
    }

    const bundle = this.ensureBundle();
    const file = path.join(bundle, `mismatch-${String(this.mismatchCount).padStart(4, '0')}.json`);
    const test = currentTestContext();
    const record = {
      id,
      category: input.category,
      at: new Date().toISOString(),
      dbPath: this.opts.logicalDbPath,
      test,
      seq: input.seq,
      conn: input.conn,
      op: input.op,
      write: input.write,
      inTransaction: input.inTransaction,
      afterDivergence,
      statement: input.statement,
      params: input.params === undefined ? undefined : encodeValue(input.params),
      replay: this.opts.journal && !this.journalBroken
        ? `node scripts/graph-engine/replay-mismatch.mjs "${bundle}" --mismatch ${this.mismatchCount}`
        : 'not replayable: the statement journal is disabled or failed',
      resultCountMismatch: input.resultCountMismatch,
      diffs: input.diffs,
      primary: encodeOutcome(input.primary),
      shadow: encodeOutcome(input.shadow),
    };
    const summary: MismatchSummary = {
      id,
      category: input.category,
      sessionId: this.sessionId,
      bundle,
      file,
      seq: input.seq,
      write: input.write,
      statement: input.statement.length > 400 ? `${input.statement.slice(0, 400)}…` : input.statement,
      afterDivergence,
      dbPath: this.opts.logicalDbPath,
      test,
      at: record.at,
    };
    try {
      this.syncBundleJournal(bundle);
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      fs.appendFileSync(path.join(this.opts.mismatchLogDir, 'mismatches.jsonl'), `${JSON.stringify(summary)}\n`);
    } catch (err) {
      this.opts.logger?.error?.('Failed to write graph engine mismatch record', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.opts.logger?.warn?.(`Graph engine mismatch (${this.opts.engines.primary.engine} vs ${this.opts.engines.shadow.engine})`, {
      id,
      category: input.category,
      write: input.write,
      afterDivergence,
      record: file,
      statement: summary.statement,
    });
    return summary;
  }

  private ensureBundle(): string {
    if (this.bundleDir) return this.bundleDir;
    const dir = path.join(this.opts.mismatchLogDir, this.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // The seed only serves a replay, which needs the journal as well. It is a
    // byte copy of a ladybug master's file (seed.lbug) or the export a ladybug
    // shadow was loaded from (seed-export/).
    let seedFile: string | null = null;
    if (this.opts.journal) {
      for (const name of ['seed.lbug', 'seed-export']) {
        const seed = path.join(this.opts.dualDir, name);
        if (!fs.existsSync(seed)) continue;
        fs.cpSync(seed, path.join(dir, name), { recursive: true });
        seedFile = name;
        break;
      }
    }
    fs.writeFileSync(path.join(dir, 'session.json'), `${JSON.stringify({
      sessionId: this.sessionId,
      startedAt: this.startedAt.toISOString(),
      dbPath: this.opts.logicalDbPath,
      configSource: this.opts.configSource,
      seed: this.opts.seed,
      seedFile,
      journal: this.opts.journal ? 'journal.jsonl' : null,
      engineGeneratedKeys: this.opts.engineGeneratedKeys,
      engines: this.opts.engines,
      process: { pid: process.pid, argv: process.argv, cwd: process.cwd(), node: process.version, platform: `${process.platform}-${process.arch}` },
    }, null, 2)}\n`);
    this.bundleDir = dir;
    return dir;
  }

  /** Append the journal lines written since the last copy to the bundle's journal. */
  private syncBundleJournal(bundle: string): void {
    if (!this.opts.journal || this.journalBroken) return;
    this.flushJournal();
    if (!fs.existsSync(this.journalFile)) return;
    const size = fs.statSync(this.journalFile).size;
    if (size <= this.bundleJournalBytes) return;
    const fd = fs.openSync(this.journalFile, 'r');
    try {
      const buf = Buffer.alloc(size - this.bundleJournalBytes);
      fs.readSync(fd, buf, 0, buf.length, this.bundleJournalBytes);
      fs.appendFileSync(path.join(bundle, 'journal.jsonl'), buf);
      this.bundleJournalBytes = size;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Flush the journal and append this session's line to sessions.jsonl. */
  close(extra: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.flushJournal();
    if (this.bundleDir) {
      try { this.syncBundleJournal(this.bundleDir); } catch { /* best effort */ }
    }
    const line = {
      sessionId: this.sessionId,
      dbPath: this.opts.logicalDbPath,
      startedAt: this.startedAt.toISOString(),
      closedAt: new Date().toISOString(),
      seed: this.opts.seed,
      engines: this.opts.engines,
      test: currentTestContext(),
      bundle: this.bundleDir,
      divergedAt: this.divergedAt,
      journalComplete: this.opts.journal && !this.journalBroken,
      ...this.stats,
      primaryMs: Math.round(this.stats.primaryMs),
      shadowMs: Math.round(this.stats.shadowMs),
      ...extra,
    };
    try {
      fs.mkdirSync(this.opts.mismatchLogDir, { recursive: true });
      fs.appendFileSync(path.join(this.opts.mismatchLogDir, 'sessions.jsonl'), `${JSON.stringify(line)}\n`);
    } catch (err) {
      this.opts.logger?.error?.('Failed to write graph engine session summary', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const total = Object.values(this.stats.mismatches).reduce((a, b) => a + b, 0);
    this.opts.logger?.[total > 0 ? 'warn' : 'info']?.('Dual graph engine session closed', {
      sessionId: this.sessionId,
      dbPath: this.opts.logicalDbPath,
      engines: `${this.opts.engines.primary.engine} + ${this.opts.engines.shadow.engine}`,
      statements: this.stats.statements,
      compared: this.stats.compared,
      mismatches: total,
      unrecorded: this.stats.unrecorded,
      bundle: this.bundleDir,
    });
  }
}
