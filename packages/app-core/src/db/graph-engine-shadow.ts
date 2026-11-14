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
import { packagedAssetPath } from '@riacore/importer-sdk';
/**
 * A native engine (RiaGraph, or ladybug behind a RiaGraph master) in a child
 * process, behind the ordinary binding interface — the shadow engine of dual mode.
 *
 * ## Why a separate process
 *
 * ladybug and RiaGraph are forks of the same C++ code base, and both native
 * libraries embed and export the same third-party code (the ANTLR runtime
 * among it). On Linux ladybug's binding dlopens its library RTLD_GLOBAL, so a
 * RiaGraph library in the same process binds to ladybug's copies of those
 * symbols: merely loading both and exiting crashes Node with SIGSEGV, and
 * nothing guarantees the two do not interfere before that. A comparison is only worth something
 * if each engine runs exactly as it would on its own, so RiaGraph runs in its
 * own process and ladybug stays in the application's process, untouched.
 *
 * The isolation also contains RiaGraph failures: if the engine aborts, only
 * the shadow process dies. That is reported as a `shadow-crash` mismatch
 * naming the statement that was running, and the application carries on.
 *
 * ## Protocol
 *
 * One child per database (graph-engine-shadow-host.ts), `fork`ed with
 * 'advanced' serialization so values cross with their exact types. Every
 * request carries an id and is answered once. Results come back fully read —
 * dual mode compares complete results anyway.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppCoreLogger } from './db-module.js';
import type {
  GraphConnection,
  GraphDatabase,
  GraphEngineBinding,
  GraphEngineName,
  GraphPreparedStatement,
  GraphQueryResult,
  GraphRow,
} from './graph-engine.js';

/** The shadow process is gone; every statement sent to it fails with this. */
export class ShadowProcessExitedError extends Error {
  static readonly CODE = 'RIAGRAPH_SHADOW_EXITED';
  readonly code = ShadowProcessExitedError.CODE;
  constructor(readonly exitCode: number | null, readonly signal: NodeJS.Signals | null, readonly inFlight: number, label = 'RiaGraph') {
    super(
      `${label} shadow process exited (${signal ? `signal ${signal}` : `code ${exitCode}`})` +
      (inFlight > 0 ? ` while executing ${inFlight} request(s)` : ''),
    );
    this.name = 'ShadowProcessExitedError';
    Object.setPrototypeOf(this, ShadowProcessExitedError.prototype);
  }
  static is(err: unknown): err is ShadowProcessExitedError {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ShadowProcessExitedError.CODE;
  }
}

/**
 * The shadow database was closed by dual mode itself (the application closed
 * the database). Not a RiaGraph failure: a statement that still arrives is
 * refused just as ladybug refuses one on its closed handle.
 */
export class ShadowDatabaseClosedError extends Error {
  static readonly CODE = 'RIAGRAPH_SHADOW_CLOSED';
  readonly code = ShadowDatabaseClosedError.CODE;
  constructor(label = 'RiaGraph') {
    super(`${label} shadow database is closed`);
    this.name = 'ShadowDatabaseClosedError';
    Object.setPrototypeOf(this, ShadowDatabaseClosedError.prototype);
  }
  static is(err: unknown): err is ShadowDatabaseClosedError {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ShadowDatabaseClosedError.CODE;
  }
}

/** Compiled host next to this module, or — under vitest — its TypeScript source, which Node runs directly. */
function hostScript(): { script: string; execArgv: string[] } {
  const packaged = packagedAssetPath('node_modules/@riacore/app-core/dist/db/graph-engine-shadow-host.js');
  if (packaged) return { script: packaged, execArgv: [] };
  const compiled = path.join(__dirname, 'graph-engine-shadow-host.js');
  if (fs.existsSync(compiled)) return { script: compiled, execArgv: [] };
  return { script: path.join(__dirname, 'graph-engine-shadow-host.ts'), execArgv: ['--disable-warning=ExperimentalWarning'] };
}

interface Reply { id: number; ok: boolean; value?: unknown; error?: string }

/** Request/response over one child's IPC channel. */
class ShadowChannel {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  private readonly ready: Promise<void>;
  private nextId = 1;
  private exited: ShadowProcessExitedError | ShadowDatabaseClosedError | null = null;
  private disposed = false;

  constructor(modulePath: string, private readonly label: string, logger?: AppCoreLogger) {
    const { script, execArgv } = hostScript();
    this.child = fork(script, [modulePath], {
      serialization: 'advanced',
      // stderr stays visible: an engine abort prints its reason there.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      execArgv,
      // Electron hosts the worker as Node when asked to; plain Node ignores it.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let markReady!: () => void;
    let failReady!: (err: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    this.ready.catch(() => { /* surfaced through request() */ });

    this.child.on('message', (reply: Reply) => {
      if (reply.id === 0) { markReady(); return; }
      const waiter = this.pending.get(reply.id);
      if (!waiter) return;
      this.pending.delete(reply.id);
      this.updateRef();
      if (reply.ok) waiter.resolve(reply.value);
      else waiter.reject(new Error(reply.error));
    });
    const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.exited) return;
      // Exiting after dispose() is the host doing what it was told.
      this.exited = this.disposed ? new ShadowDatabaseClosedError(this.label) : new ShadowProcessExitedError(code, signal, this.pending.size, this.label);
      failReady(this.exited);
      if (!this.disposed) {
        logger?.error?.(`${this.label} shadow process exited unexpectedly`, { exitCode: code, signal, inFlight: this.pending.size });
      }
      for (const waiter of this.pending.values()) waiter.reject(this.exited);
      this.pending.clear();
    };
    this.child.on('exit', onGone);
    this.child.on('error', (err) => {
      logger?.error?.(`${this.label} shadow process failed`, { error: err.message });
      onGone(null, null);
    });
    this.updateRef();
  }

  /**
   * Keep the event loop alive only while requests are outstanding, so a shadow
   * process never holds the application open on its own.
   */
  private updateRef(): void {
    const channel = this.child.channel as { ref?(): void; unref?(): void } | null | undefined;
    if (this.pending.size > 0) { this.child.ref(); channel?.ref?.(); } else { this.child.unref(); channel?.unref?.(); }
  }

  async request<T>(message: Record<string, unknown>): Promise<T> {
    if (this.disposed) throw new ShadowDatabaseClosedError(this.label);
    if (this.exited) throw this.exited;
    const id = this.nextId++;
    // Return the pending result immediately: if the child exits before ready,
    // both startup and the pending request fail. They must settle the same
    // caller-visible promise, rather than leave an unreachable rejected result.
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.updateRef();
      void this.ready.then(() => {
        if (this.disposed) throw new ShadowDatabaseClosedError(this.label);
        if (this.exited) throw this.exited;
        this.child.send({ ...message, id });
      }).catch((err: unknown) => {
        this.pending.delete(id);
        this.updateRef();
        reject(this.exited ?? (err instanceof Error ? err : new Error(String(err))));
      });
    });
  }

  /**
   * Stop the process at once (it stopped answering). Outstanding and later
   * requests fail with ShadowDatabaseClosedError: dual mode did this, the
   * engine did not crash.
   */
  kill(): void {
    if (this.exited) return;
    this.disposed = true;
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Let the host close what is left and exit; kill it if it does not. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.exited) return;
    try { this.child.disconnect(); } catch { /* already gone */ }
    const killer = setTimeout(() => { if (!this.exited) this.child.kill('SIGKILL'); }, 30_000);
    killer.unref();
  }
}

interface Drained { multi: boolean; rows: GraphRow[][] }

function asResults(drained: Drained): GraphQueryResult | GraphQueryResult[] {
  const results = drained.rows.map((rows): GraphQueryResult => ({
    getAll: async () => rows,
    close: () => {},
  }));
  return drained.multi ? results : results[0];
}

/**
 * A binding whose Database spawns a RiaGraph child process and whose
 * Connection / PreparedStatement / QueryResult objects stand in for the ones
 * living there.
 */
/** What a shadow process needs to know about the engine it hosts. */
export interface ShadowEngineModule {
  /** Package directory the host loads the binding from. */
  modulePath: string;
  version: string;
  /** Which engine it is; RiaGraph by default. */
  engine?: GraphEngineName;
}

export function createShadowProcessBinding(riagraph: ShadowEngineModule, logger?: AppCoreLogger): GraphEngineBinding {
  const engine = riagraph.engine ?? 'riagraph';
  const label = engine === 'ladybug' ? 'ladybug' : 'RiaGraph';
  let nextHandle = 0;

  class ShadowDatabase implements GraphDatabase {
    readonly channel: ShadowChannel;
    readonly handle = (nextHandle += 1);
    readonly opened: Promise<void>;
    constructor(databasePath: string, ...args: unknown[]) {
      this.channel = new ShadowChannel(riagraph.modulePath, label, logger);
      // Like the native binding, opening is lazy from the caller's view: an
      // open failure surfaces at the first statement.
      this.opened = this.channel.request<void>({ op: 'openDb', db: this.handle, path: databasePath, args });
      this.opened.catch(() => { /* surfaced by the first statement */ });
    }
    /** Connections opened on this database and not closed yet. */
    openConnections = 0;
    private closed = false;
    /** Dual mode gave up waiting for this engine: stop its process. */
    abort(): void {
      this.closed = true;
      this.channel.kill();
    }
    async close(): Promise<void> {
      try {
        await this.opened.catch(() => {});
        await this.channel.request({ op: 'closeDb', db: this.handle });
      } finally {
        this.closed = true;
        this.releaseIfUnused();
      }
    }
    /**
     * The process lives as long as anything can still reach the engine: a
     * native connection stays usable after its database is closed (ladybug
     * keeps answering on it), so RiaGraph must get the same chance.
     */
    releaseIfUnused(): void {
      if (this.closed && this.openConnections === 0) this.channel.dispose();
    }
  }

  class ShadowPreparedStatement implements GraphPreparedStatement {
    constructor(readonly handle: number) {}
    isSuccess(): boolean { return true; }
    getErrorMessage(): string { return ''; }
  }

  class ShadowConnection implements GraphConnection {
    private readonly db: ShadowDatabase;
    private readonly handle = (nextHandle += 1);
    private readonly connected: Promise<void>;
    private closed = false;
    constructor(database: GraphDatabase) {
      this.db = database as ShadowDatabase;
      this.db.openConnections += 1;
      this.connected = this.db.opened.then(() => this.db.channel.request<void>({ op: 'connect', conn: this.handle, db: this.db.handle }));
      this.connected.catch(() => { /* surfaced by the first statement */ });
    }
    async query(statement: string): Promise<GraphQueryResult | GraphQueryResult[]> {
      await this.connected;
      return asResults(await this.db.channel.request<Drained>({ op: 'query', conn: this.handle, statement }));
    }
    async prepare(statement: string): Promise<GraphPreparedStatement> {
      await this.connected;
      const ps = new ShadowPreparedStatement((nextHandle += 1));
      await this.db.channel.request({ op: 'prepare', conn: this.handle, ps: ps.handle, statement });
      return ps;
    }
    async execute(preparedStatement: GraphPreparedStatement, params?: Record<string, unknown>): Promise<GraphQueryResult | GraphQueryResult[]> {
      await this.connected;
      const ps = preparedStatement as ShadowPreparedStatement;
      return asResults(await this.db.channel.request<Drained>({ op: 'execute', conn: this.handle, ps: ps.handle, params }));
    }
    async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      try {
        await this.connected.catch(() => {});
        await this.db.channel.request({ op: 'closeConn', conn: this.handle });
      } finally {
        this.db.openConnections -= 1;
        this.db.releaseIfUnused();
      }
    }
  }

  return {
    name: engine,
    version: riagraph.version,
    Database: ShadowDatabase,
    Connection: ShadowConnection,
  };
}
