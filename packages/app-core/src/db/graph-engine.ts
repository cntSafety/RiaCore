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
 * Graph-engine selection.
 *
 * RiaCore runs on one of two graph engines with the same Node.js API:
 *
 *  - `ladybug`  — `@ladybugdb/core`, the fallback a workspace can be switched
 *                 to if RiaGraph causes problems.
 *  - `riagraph` — RiaGraph, the fork that replaces it and the default;
 *                 shipped with the desktop packages (the build pinned in
 *                 apps/desktop-host/riagraph.lock.json). In development: the
 *                 fetched or locally built binding (see resolveRiaGraph).
 *
 * and any list of them. The first engine is the master: its results (and
 * errors) are what the application sees, so behaviour is exactly that of the
 * master alone. The others run as shadows, their results are compared with
 * the master's and every mismatch is recorded (see graph-engine-dual.ts and
 * graph-engine-select.ts). ladybug and RiaGraph can shadow each other, which is
 * how a workspace moves from one to the other with the old engine checking the
 * new one.
 *
 * The engines are chosen per workspace by `<workspace>/graph-engine.json`. A test
 * campaign can force one configuration onto every workspace — including the
 * throwaway ones tests create — by pointing `RIACORE_GRAPH_ENGINE_CONFIG` at a
 * config file. Without either, the engine is the default, RiaGraph;
 * `{ "engines": ["ladybug"] }` switches a workspace to the ladybug fallback.
 *
 * A process loads at most one of the two native engines (see lbug()): opening
 * a workspace on the other one raises GraphEngineProcessSwitchError before
 * anything is touched, and the desktop worker restarts to open it.
 *
 * Each engine has its own database file, so they can never open (and,
 * in RiaGraph's case, irreversibly upgrade) each other's files:
 *
 *   <workspace>/db             ladybug     (+ db.wal)
 *   <workspace>/db.riag        RiaGraph    (+ db.riag.wal)  — the default
 *   <workspace>/db.dual/       ladybug + RiaGraph bookkeeping: sync marker, statement journal
 *   <workspace>/db.dual.<e>/   statement journal of the pair of the master and shadow <e>
 *
 * Callers keep passing the *logical* path `<workspace>/db`; the mapping to the
 * physical files happens here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type lbugModule from '@ladybugdb/core';
import { z } from 'zod';

export type GraphEngineName = 'ladybug' | 'riagraph';
/** `dual` stands for a list of both engines: the first is the master, the others shadow it. */
export type GraphEngineMode = GraphEngineName | 'dual';

// ── Engine-neutral view of the binding API ───────────────────────────────────
// Both bindings expose the same classes (RiaGraph renamed only identifiers),
// so these describe the subset RiaCore uses, structurally.

export type GraphRow = Record<string, unknown>;

export interface GraphQueryResult {
  getAll(): Promise<GraphRow[]>;
  close(): void | Promise<void>;
}

export interface GraphPreparedStatement {
  isSuccess(): boolean;
  getErrorMessage(): string;
}

export interface GraphConnection {
  query(statement: string): Promise<GraphQueryResult | GraphQueryResult[]>;
  prepare(statement: string): Promise<GraphPreparedStatement>;
  execute(
    preparedStatement: GraphPreparedStatement,
    params?: Record<string, unknown>,
  ): Promise<GraphQueryResult | GraphQueryResult[]>;
  close(): Promise<void>;
}

export interface GraphDatabase {
  close(): Promise<void>;
  /**
   * Optional step the opener runs right after constructing the database and
   * before the schema is initialised: a multi-engine database uses it to bring
   * a shadow engine that cannot read the master's file to the master's data.
   */
  afterOpen?(): Promise<void>;
}

export interface GraphEngineBinding {
  readonly name: GraphEngineMode;
  readonly version: string;
  readonly Database: new (databasePath: string, bufferManagerSize?: number) => GraphDatabase;
  readonly Connection: new (database: GraphDatabase) => GraphConnection;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Per-workspace config file name, next to the `db` file. */
export const GRAPH_ENGINE_CONFIG_FILE = 'graph-engine.json';
/** Path of a config file that overrides every workspace's own (test campaigns). */
export const GRAPH_ENGINE_CONFIG_ENV = 'RIACORE_GRAPH_ENGINE_CONFIG';

/** Engine of a workspace whose configuration names none. ladybug remains available as the fallback. */
export const BUILT_IN_DEFAULT_GRAPH_ENGINE = 'riagraph' as const;
/**
 * Overrides the built-in default for a process (`ladybug` or `riagraph`), e.g. to
 * run a test campaign on the fallback engine. Not a user setting: a user
 * switches a workspace with its `graph-engine.json`, which always wins.
 */
export const DEFAULT_GRAPH_ENGINE_ENV = 'RIACORE_DEFAULT_GRAPH_ENGINE';

export function defaultGraphEngine(): 'ladybug' | 'riagraph' {
  const value = process.env[DEFAULT_GRAPH_ENGINE_ENV];
  if (!value) return BUILT_IN_DEFAULT_GRAPH_ENGINE;
  if (value === 'ladybug' || value === 'riagraph') return value;
  throw new Error(`${DEFAULT_GRAPH_ENGINE_ENV} is '${value}'; expected 'ladybug' or 'riagraph'`);
}

/** The default engine for file helpers, which must not throw on a bad override. */
function defaultEngineForFiles(): GraphEngineName {
  try {
    return defaultGraphEngine();
  } catch {
    return BUILT_IN_DEFAULT_GRAPH_ENGINE;
  }
}

/** Path of the RiaGraph Node.js package directory, when not configured in the file. */
export const RIAGRAPH_MODULE_ENV = 'RIACORE_RIAGRAPH_MODULE';

/**
 * Keys whose values the engine generates from its own storage layout rather
 * than from data: the internal `{offset, table}` ids on node and rel values.
 * Two correct engines are free to disagree on them.
 */
export const DEFAULT_ENGINE_GENERATED_KEYS = ['_id', '_src', '_dst'];

const RiaGraphOptionsShape = {
  /** Directory of the RiaGraph Node.js package (relative to this file). */
  modulePath: z.string().optional(),
};

const RiaGraphOptionsSchema = z.object(RiaGraphOptionsShape).strict();

/** One entry of `engines`: an engine name, or an object carrying that engine's settings. */
const EngineEntrySchema = z.union([
  z.enum(['ladybug', 'riagraph']),
  z.object({ engine: z.literal('ladybug') }).strict(),
  z.object({ engine: z.literal('riagraph'), ...RiaGraphOptionsShape }).strict(),
]);

export type ResolvedEngineEntry =
  | { engine: 'ladybug' }
  | ({ engine: 'riagraph' } & z.infer<typeof RiaGraphOptionsSchema>);

/**
 * Checks on an ordered engine list. The first engine is the master (the
 * application sees its results and its file drives the workspace lifecycle);
 * the rest shadow it. Throws a message naming the rule that is broken.
 */
export function validateEngineList(engines: readonly GraphEngineName[]): void {
  const seen = new Set<GraphEngineName>();
  for (const engine of engines) {
    if (seen.has(engine)) throw new Error(`engine '${engine}' is listed twice`);
    seen.add(engine);
  }
}

/** Mismatch records written per session by default; later mismatches are only counted. */
export const DEFAULT_MAX_MISMATCH_RECORDS = 100;
/** How long a shadow may take beyond the master's answer before it is given up, by default. */
export const DEFAULT_SHADOW_TIMEOUT_MS = 120_000;

const DualOptionsSchema = z.object({
  /** Where mismatch records and reproduction bundles go (relative to this file). Default: <workspace>/logs/graph-engine-mismatches */
  mismatchLogDir: z.string().optional(),
  /** `log` records and continues; `throw` additionally fails the statement with GraphEngineMismatchError. */
  onMismatch: z.enum(['log', 'throw']).default('log'),
  /**
   * Keep the statement journal (and the seed copy) that makes mismatches
   * replayable. Off by default: it grows with every statement. Test campaigns
   * turn it on.
   */
  journal: z.boolean().default(false),
  /** Mismatch records written per session; later ones are counted only. 0: no limit. */
  maxMismatchRecords: z.number().int().min(0).default(DEFAULT_MAX_MISMATCH_RECORDS),
  /**
   * Milliseconds a shadow may still take once the master has answered. A
   * shadow that takes longer is stopped and left out for the rest of the
   * session, so it can never hold the application up. 0: wait indefinitely.
   */
  shadowTimeoutMs: z.number().int().min(0).default(DEFAULT_SHADOW_TIMEOUT_MS),
  /** Result keys excluded from comparison because the engine generates them. */
  engineGeneratedKeys: z.array(z.string()).default(DEFAULT_ENGINE_GENERATED_KEYS),
}).strict();

const RawGraphEngineConfigSchema = z.object({
  /** Single engine, or `dual` for ladybug (master) + RiaGraph. Superseded by `engines`. */
  engine: z.enum(['ladybug', 'riagraph', 'dual']).optional(),
  /**
   * Ordered list of engines, one or two. The first is the master, the other
   * shadows it and is compared against it. Replaces `engine` and the
   * `riagraph` settings block (put the settings in the entries).
   */
  engines: z.array(EngineEntrySchema).min(1).max(2).optional(),
  riagraph: RiaGraphOptionsSchema.optional(),
  dual: DualOptionsSchema.prefault({}),
}).strict();

/**
 * The configuration as the rest of app-core reads it. `engines` is the
 * normalised ordered list however the file spelled it; `engine` is the mode it
 * adds up to (a single engine, or `dual` for a pair); `riagraph` holds the
 * settings of that engine when it is listed.
 */
export interface GraphEngineConfig {
  engine: GraphEngineMode;
  engines: ResolvedEngineEntry[];
  riagraph: z.infer<typeof RiaGraphOptionsSchema>;
  dual: z.infer<typeof DualOptionsSchema>;
}

const GraphEngineConfigSchema = RawGraphEngineConfigSchema.transform((raw, ctx): GraphEngineConfig => {
  const fail = (message: string): never => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  let entries: ResolvedEngineEntry[];
  if (raw.engines) {
    if (raw.engine !== undefined || raw.riagraph) {
      return fail('"engines" replaces "engine" and "riagraph": give the engine settings inside the entries');
    }
    entries = raw.engines.map((e): ResolvedEngineEntry => (typeof e === 'string' ? { engine: e } : e));
  } else {
    const engine = raw.engine ?? defaultGraphEngine();
    const named = engine === 'dual' ? ['ladybug', 'riagraph'] as const : [engine] as const;
    if (raw.riagraph && !named.includes('riagraph' as never)) return fail('"riagraph" settings given but RiaGraph is not an engine of this configuration');
    entries = named.map((name): ResolvedEngineEntry => {
      if (name === 'riagraph') return { engine: name, ...(raw.riagraph ?? {}) };
      return { engine: name };
    });
  }
  try {
    validateEngineList(entries.map((e) => e.engine));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const riagraph = entries.find((e) => e.engine === 'riagraph');
  const { engine: _r, ...riagraphOptions } = riagraph ?? { engine: 'riagraph' };
  return {
    engine: entries.length > 1 ? 'dual' : entries[0].engine,
    engines: entries,
    riagraph: riagraphOptions,
    dual: raw.dual,
  };
});

export interface ResolvedGraphEngineConfig {
  config: GraphEngineConfig;
  /** File the config came from, or null for the built-in default engine. */
  source: string | null;
  /** Directory relative paths in the config resolve against. */
  baseDir: string;
}


function readConfigFile(file: string): GraphEngineConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid graph engine config '${file}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = GraphEngineConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid graph engine config '${file}': ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Engine configuration for the workspace that owns `logicalDbPath`
 * (`<workspace>/db`). Precedence: `RIACORE_GRAPH_ENGINE_CONFIG`, then
 * `<workspace>/graph-engine.json`, then the default engine (RiaGraph unless the
 * process overrides it, see `DEFAULT_GRAPH_ENGINE_ENV`).
 */
export function resolveGraphEngineConfig(logicalDbPath: string): ResolvedGraphEngineConfig {
  const workspaceDir = path.dirname(logicalDbPath);
  const override = process.env[GRAPH_ENGINE_CONFIG_ENV];
  if (override) {
    const file = path.resolve(override);
    if (!fs.existsSync(file)) {
      throw new Error(`${GRAPH_ENGINE_CONFIG_ENV} points at '${file}', which does not exist`);
    }
    return { config: readConfigFile(file), source: file, baseDir: path.dirname(file) };
  }
  const file = path.join(workspaceDir, GRAPH_ENGINE_CONFIG_FILE);
  if (fs.existsSync(file)) {
    return { config: readConfigFile(file), source: file, baseDir: workspaceDir };
  }
  return { config: GraphEngineConfigSchema.parse({}), source: null, baseDir: workspaceDir };
}

// ── Database files ───────────────────────────────────────────────────────────

/** Physical database path of `engine` for the logical path `<workspace>/db`. */
export function engineDbPath(logicalDbPath: string, engine: GraphEngineName): string {
  switch (engine) {
    case 'ladybug': return logicalDbPath;
    case 'riagraph': return `${logicalDbPath}.riag`;
  }
}

/**
 * Bookkeeping directory (sync marker, journal, seed snapshot) of the pair that
 * the shadow engine `shadow` forms with its master. RiaGraph keeps the name
 * the ladybug + RiaGraph pair always had.
 */
export function dualStateDir(logicalDbPath: string, shadow: GraphEngineName = 'riagraph'): string {
  return shadow === 'riagraph' ? `${logicalDbPath}.dual` : `${logicalDbPath}.dual.${shadow}`;
}

/**
 * The configured engines, master first, or null when the config file is
 * invalid. File helpers use this so that a broken config never makes them
 * guess at (or delete) the wrong engine's files; opening the database reports
 * the config error itself.
 */
function configuredEnginesOrNull(logicalDbPath: string): GraphEngineName[] | null {
  try {
    return resolveGraphEngineConfig(logicalDbPath).config.engines.map((e) => e.engine);
  } catch {
    return null;
  }
}

/**
 * Physical path of the primary database — the file whose existence drives the
 * workspace lifecycle. With a ladybug master this is the logical path itself.
 */
export function primaryDbPath(logicalDbPath: string): string {
  return engineDbPath(logicalDbPath, (configuredEnginesOrNull(logicalDbPath) ?? [defaultEngineForFiles()])[0]);
}

/**
 * Whether the workspace has a database for its configured master engine.
 * Shadows never make a database "missing": a stale one is rebuilt from the
 * master on open (see prepareDualFiles).
 */
export function graphDbExists(logicalDbPath: string): boolean {
  return fs.existsSync(primaryDbPath(logicalDbPath));
}

/**
 * Whether the master's database file was last kept as the shadow of another
 * master, in a session that crashed, diverged from that master or never got
 * seeded (the pair's sync marker, graph-engine-dual.ts). Its data may differ
 * from what the workspace holds, so the lifecycle rebuilds it from ria-data
 * rather than open it as the workspace's database.
 */
export function graphDbUntrusted(logicalDbPath: string): boolean {
  const master = (configuredEnginesOrNull(logicalDbPath) ?? [defaultEngineForFiles()])[0];
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dualStateDir(logicalDbPath, master), 'state.json'), 'utf-8')) as {
      open?: boolean; diverged?: boolean; pendingSeed?: boolean;
    };
    return !!(marker.open || marker.diverged || marker.pendingSeed);
  } catch {
    return false;
  }
}

/**
 * Every file and directory the configured engines keep for `logicalDbPath`:
 * each engine's database and WAL, plus the bookkeeping directory
 * of every shadow pair — and the master's own, left from a time it was a
 * shadow, which describes a file that is being replaced.
 */
export function graphDbFiles(logicalDbPath: string): string[] {
  const engines = configuredEnginesOrNull(logicalDbPath);
  if (!engines) return [];
  const files: string[] = [];
  for (const engine of engines) {
    const dbFile = engineDbPath(logicalDbPath, engine);
    files.push(dbFile, `${dbFile}.wal`);
  }
  for (const engine of engines) files.push(dualStateDir(logicalDbPath, engine));
  return files;
}

/** Delete the database files of the configured engines (`rm -rf`, missing files ignored). */
export async function removeGraphDbFiles(logicalDbPath: string): Promise<void> {
  for (const file of graphDbFiles(logicalDbPath)) {
    await fs.promises.rm(file, { recursive: true, force: true });
  }
}

/**
 * Entries a workspace's .gitignore needs beyond the ladybug ones (`db`,
 * `db.wal`): the files of every other engine and of every shadow pair,
 * whatever is configured now, so switching engines never leaves a database
 * to be committed.
 */
export function extraGitignoreEntries(_workspaceDir?: string): string[] {
  return ['db.riag', 'db.riag.wal', 'db.dual/', 'db.dual.*/'];
}

/**
 * How to probe the primary database's WAL out of process (wal-recovery.ts):
 * its physical path, and the extra probe-child arguments selecting the engine.
 * For ladybug (and multi-engine runs with a ladybug master) there are none, so
 * the probe runs exactly as it always did.
 */
export function walProbeTarget(logicalDbPath: string): { dbPath: string; args: string[] } {
  let resolved: ResolvedGraphEngineConfig;
  try {
    resolved = resolveGraphEngineConfig(logicalDbPath);
  } catch {
    return { dbPath: logicalDbPath, args: [] };
  }
  const master = resolved.config.engines[0].engine;
  if (master === 'ladybug') return { dbPath: logicalDbPath, args: [] };
  try {
    return { dbPath: engineDbPath(logicalDbPath, 'riagraph'), args: ['riagraph', resolveRiaGraph(resolved).modulePath] };
  } catch {
    // No binding: the open itself will report that.
    return { dbPath: engineDbPath(logicalDbPath, 'riagraph'), args: ['riagraph', ''] };
  }
}

// ── Statement classification ─────────────────────────────────────────────────

/** Heuristic used for locking: anything that may mutate the database or its state. */
export function isWriteStatement(statement: string): boolean {
  return /\b(CREATE|MERGE|DELETE|SET|DROP|ALTER|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|DETACH)\b/i.test(statement);
}

// ── One native engine per process ────────────────────────────────────────────

/** The engines that run inside the application's process when they are the master. */
export type InProcessGraphEngine = 'ladybug' | 'riagraph';

let inProcessEngine: InProcessGraphEngine | null = null;
let inProcessGuard = true;

/**
 * The workspace needs the other native engine than the one this process has
 * already loaded. ladybug and RiaGraph never share a process (see lbug()), so
 * the process has to be replaced: the desktop worker restarts and repeats the
 * request; other hosts (CLI, web dev server) report it.
 */
export class GraphEngineProcessSwitchError extends Error {
  static readonly CODE = 'GRAPH_ENGINE_PROCESS_SWITCH';
  readonly code = GraphEngineProcessSwitchError.CODE;
  /** The process has to be restarted to open the database; nothing was changed. */
  readonly restartRequired = true;
  constructor(readonly loaded: InProcessGraphEngine, readonly required: InProcessGraphEngine, readonly dbPath?: string) {
    super(
      `This process has the ${loaded} graph engine loaded, but ${dbPath ? `'${dbPath}'` : 'the database'} is configured for ${required}. ` +
      'The two engines cannot be loaded into one process; restart RiaCore (or the command) to open it.',
    );
    this.name = 'GraphEngineProcessSwitchError';
    Object.setPrototypeOf(this, GraphEngineProcessSwitchError.prototype);
  }
  static is(err: unknown): err is GraphEngineProcessSwitchError {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === GraphEngineProcessSwitchError.CODE;
  }
}

/** The native engine this process has loaded, if any. */
export function inProcessGraphEngine(): InProcessGraphEngine | null {
  return inProcessEngine;
}

function claimInProcessEngine(engine: InProcessGraphEngine, dbPath?: string): void {
  if (inProcessGuard && inProcessEngine && inProcessEngine !== engine) {
    throw new GraphEngineProcessSwitchError(inProcessEngine, engine, dbPath);
  }
  inProcessEngine ??= engine;
}

/**
 * The native engine opening `logicalDbPath` loads into this process: its
 * master's (shadows run in processes of their own). Null when the config is
 * invalid; opening reports that.
 */
export function requiredInProcessEngine(logicalDbPath: string): InProcessGraphEngine | null {
  const master = configuredEnginesOrNull(logicalDbPath)?.[0];
  return master ?? null;
}

/**
 * Throws GraphEngineProcessSwitchError when `logicalDbPath` cannot be opened
 * in this process, before anything is closed, deleted or loaded.
 */
export function assertGraphEngineUsableInProcess(logicalDbPath: string): void {
  const required = requiredInProcessEngine(logicalDbPath);
  if (inProcessGuard && required && inProcessEngine && inProcessEngine !== required) {
    throw new GraphEngineProcessSwitchError(inProcessEngine, required, logicalDbPath);
  }
}

/**
 * Turn the one-engine-per-process guard off (or back on, forgetting what was
 * loaded). Not for the application: tests whose stand-in for RiaGraph wraps
 * ladybug, so that mixing the two is harmless there.
 */
export function setInProcessEngineGuard(enabled: boolean): void {
  inProcessGuard = enabled;
  if (enabled) inProcessEngine = null;
}

// ── Bindings ─────────────────────────────────────────────────────────────────

type LbugModule = typeof lbugModule;
let lbugLoaded: LbugModule | null = null;

/**
 * `@ladybugdb/core`, loaded on first use rather than at import. On Linux the
 * binding dlopens its native library RTLD_GLOBAL, which puts every symbol it
 * exports — the embedded ANTLR runtime among them — into the process-wide
 * scope. RiaGraph exports the same names and would bind to ladybug's copies,
 * so a process running RiaGraph must never have loaded ladybug: riagraph mode
 * never touches this, and dual mode runs RiaGraph in its own process.
 */
function lbug(): LbugModule {
  claimInProcessEngine('ladybug');
  if (!lbugLoaded) {
    const mod = createRequire(path.join(__dirname, 'graph-engine.js'))('@ladybugdb/core') as LbugModule & { default?: LbugModule };
    lbugLoaded = mod.default ?? mod;
  }
  return lbugLoaded;
}

export const ladybugBinding: GraphEngineBinding = {
  name: 'ladybug',
  get version() { return String(lbug().VERSION); },
  get Database() { return lbug().Database as unknown as GraphEngineBinding['Database']; },
  get Connection() { return lbug().Connection as unknown as GraphEngineBinding['Connection']; },
};

export interface RiaGraphBuildInfo {
  commit?: string;
  version?: string;
  builtAt?: string;
  [key: string]: unknown;
}

export interface LoadedRiaGraph {
  binding: GraphEngineBinding;
  modulePath: string;
  buildInfo: RiaGraphBuildInfo | null;
}

const riagraphCache = new Map<string, LoadedRiaGraph>();

/** `vendor/riagraph-core/<platform>-<arch>` in the nearest ancestor that has one. */
function findVendoredRiaGraph(): string | null {
  const platformDir = `${process.platform}-${process.arch}`;
  let dir = __dirname;
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, 'vendor', 'riagraph-core', platformDir);
    if (fs.existsSync(path.join(candidate, 'index.js'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ResolvedRiaGraph {
  modulePath: string;
  version: string;
  buildInfo: RiaGraphBuildInfo | null;
}

// ── A binary given in `.riagraph/` ───────────────────────────────────────────
//
// `.riagraph/` at the repository root is where RiaGraph material is put by
// hand (the host-side clone `.riagraph/src` of scripts/riagraph/build-riagraph.sh
// lives there too). It is how a platform without a Docker build — Windows —
// gets its binding: drop in the `riagjs-win32-x64.node` that RiaGraph's CI
// builds (or a whole binding directory), and it is used in preference to the
// installed package.

/** Name of the directory a binding is given in, looked up in the ancestors of this file. */
export const RIAGRAPH_GIVEN_DIR = '.riagraph';

/** The binding's JavaScript wrapper: everything but the native binary. */
const RIAGRAPH_WRAPPER_FILES = ['index.js', 'index.mjs', 'riag_native.js', 'database.js', 'connection.js', 'prepared_statement.js', 'query_result.js', 'riag.d.ts', 'package.json'];

/** Whether the first bytes of `file` are those of a native module of `platform` (a Windows DLL is not loadable on Linux, and crashes if tried). */
function isNativeModuleOf(file: string, platform: NodeJS.Platform): boolean {
  let head: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  switch (platform) {
    case 'win32': return head[0] === 0x4d && head[1] === 0x5a; // "MZ"
    case 'darwin': return (head[0] === 0xcf && head[1] === 0xfa) || (head[0] === 0xca && head[1] === 0xfe); // Mach-O 64, universal
    default: return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46; // "\x7fELF"
  }
}

function findAncestorDir(startDir: string, relative: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Where the binding's JavaScript wrapper can be taken from: the installed package, else the RiaGraph checkout in `.riagraph/src`. */
function findWrapperSource(givenDir: string): string | null {
  try {
    const installed = path.dirname(createRequire(path.join(__dirname, 'graph-engine.js')).resolve('@riagraph/core'));
    if (fs.existsSync(path.join(installed, 'riag_native.js'))) return installed;
  } catch {
    // not installed
  }
  const checkout = path.join(givenDir, 'src', 'tools', 'nodejs_api', 'src_js');
  return fs.existsSync(path.join(checkout, 'riag_native.js')) ? checkout : null;
}

/**
 * Put a bare native binary together with the wrapper into a binding directory
 * (`<givenDir>/module/<platform>-<arch>`), where the wrapper finds it next to
 * itself. Idempotent: the binary is copied again only when it differs in size
 * or modification time (a loaded module cannot be overwritten on Windows, so a
 * running process must not rewrite it needlessly).
 */
function stageGivenBinary(givenDir: string, binary: string, wrapperDir: string, platformDir: string): string {
  const target = path.join(givenDir, 'module', platformDir);
  fs.mkdirSync(target, { recursive: true });
  const source = fs.statSync(binary);
  const stagedBinary = path.join(target, 'riagjs.node');
  const current = fs.existsSync(stagedBinary) ? fs.statSync(stagedBinary) : null;
  if (!current || current.size !== source.size || Math.floor(current.mtimeMs) !== Math.floor(source.mtimeMs)) {
    // Copy beside, then rename, so a process starting meanwhile never sees half a binary.
    const partial = `${stagedBinary}.${process.pid}.tmp`;
    fs.copyFileSync(binary, partial);
    fs.utimesSync(partial, source.atime, source.mtime);
    fs.renameSync(partial, stagedBinary);
  }
  for (const name of RIAGRAPH_WRAPPER_FILES) {
    const from = path.join(wrapperDir, name);
    const to = path.join(target, name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
    fs.copyFileSync(from, to);
  }
  const info = path.join(target, 'BUILD_INFO.json');
  const buildInfo = {
    engine: 'riagraph',
    source: binary,
    wrapper: wrapperDir,
    platform: platformDir,
    binarySize: source.size,
    binaryModified: source.mtime.toISOString(),
  };
  if (!fs.existsSync(info) || JSON.stringify(JSON.parse(fs.readFileSync(info, 'utf-8'))) !== JSON.stringify(buildInfo)) {
    fs.writeFileSync(info, `${JSON.stringify(buildInfo, null, 2)}\n`);
  }
  return target;
}

/**
 * The binding given in `.riagraph/` for this platform, or null (with what was
 * looked at appended to `tried`). A directory with `index.js` and `riagjs.node`
 * is used as it is; a bare `riagjs-<platform>-<arch>.node` is staged with the
 * wrapper first (see stageGivenBinary). A binary of another platform is ignored.
 */
export function findGivenRiaGraph(
  tried: string[] = [],
  startDir: string = __dirname,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const givenDir = findAncestorDir(startDir, RIAGRAPH_GIVEN_DIR);
  if (!givenDir || !fs.statSync(givenDir).isDirectory()) {
    tried.push(`${RIAGRAPH_GIVEN_DIR}/ (not found above ${startDir})`);
    return null;
  }
  const platformDir = `${platform}-${arch}`;
  const usable = (binary: string): boolean => {
    if (!fs.existsSync(binary)) return false;
    if (isNativeModuleOf(binary, platform)) return true;
    tried.push(`${binary} (not a ${platform} binary)`);
    return false;
  };

  // A complete binding directory.
  for (const dir of [path.join(givenDir, platformDir), givenDir, path.join(givenDir, 'src', 'tools', 'nodejs_api', 'build')]) {
    if (fs.existsSync(path.join(dir, 'index.js')) && usable(path.join(dir, 'riagjs.node'))) return dir;
  }
  // A bare binary, named as RiaGraph's CI names it or placed in the platform directory.
  for (const binary of [path.join(givenDir, `riagjs-${platformDir}.node`), path.join(givenDir, platformDir, 'riagjs.node')]) {
    if (!usable(binary)) continue;
    const wrapper = findWrapperSource(givenDir);
    if (!wrapper) {
      tried.push(`${binary} (found, but no JavaScript wrapper to go with it: install @riagraph/core or check out RiaGraph into ${RIAGRAPH_GIVEN_DIR}/src)`);
      continue;
    }
    return stageGivenBinary(givenDir, binary, wrapper, platformDir);
  }
  tried.push(`${givenDir} (no riagjs-${platformDir}.node or ${platformDir}/ binding)`);
  return null;
}

/**
 * Find the RiaGraph package without loading it. Resolution order:
 * `riagraph.modulePath` in the config, `RIACORE_RIAGRAPH_MODULE`, a binary
 * given in `.riagraph/` (the way to use RiaGraph on Windows, see
 * findGivenRiaGraph), an installed `@riagraph/core` package, then the build
 * staged by scripts/riagraph/build-riagraph.sh under vendor/riagraph-core.
 *
 * Dual mode needs only this: it runs RiaGraph in a child process, and loading
 * the native library next to ladybug's is exactly what it must avoid (both
 * embed the same C++ code base, and the process crashes at exit).
 */
export function resolveRiaGraph(resolved?: ResolvedGraphEngineConfig): ResolvedRiaGraph {
  const requireFromHere = createRequire(path.join(__dirname, 'graph-engine.js'));
  const tried: string[] = [];
  // Lazily, so that a binary is staged only when nothing before it in the order is usable.
  const sources: Array<() => string | null> = [];
  const configured = resolved?.config.riagraph.modulePath;
  if (configured) sources.push(() => path.resolve(resolved!.baseDir, configured));
  if (process.env[RIAGRAPH_MODULE_ENV]) sources.push(() => path.resolve(process.env[RIAGRAPH_MODULE_ENV]!));
  sources.push(() => findGivenRiaGraph(tried));
  sources.push(() => {
    try {
      return path.dirname(requireFromHere.resolve('@riagraph/core'));
    } catch {
      tried.push('@riagraph/core (not installed)');
      return null;
    }
  });
  sources.push(() => {
    const vendored = findVendoredRiaGraph();
    if (!vendored) tried.push(`vendor/riagraph-core/${process.platform}-${process.arch} (not found above ${__dirname})`);
    return vendored;
  });

  for (const source of sources) {
    const modulePath = source();
    if (!modulePath) continue;
    if (!fs.existsSync(path.join(modulePath, 'index.js'))) {
      tried.push(`${modulePath} (no index.js)`);
      continue;
    }
    const readJson = (file: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(fs.readFileSync(path.join(modulePath, file), 'utf-8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const buildInfo = readJson('BUILD_INFO.json') as RiaGraphBuildInfo | null;
    const version = String(buildInfo?.version ?? readJson('package.json')?.version ?? 'unknown');
    return { modulePath, version, buildInfo };
  }
  throw new Error(
    `The RiaGraph engine is configured but its Node.js binding was not found. Tried: ${tried.join('; ')}. ` +
    `On Linux build it with scripts/riagraph/build-riagraph.sh; on Windows put RiaGraph's riagjs-win32-x64.node into ` +
    `${RIAGRAPH_GIVEN_DIR}/ (or install @riagraph/core); or set riagraph.modulePath in ` +
    `${GRAPH_ENGINE_CONFIG_FILE} or ${RIAGRAPH_MODULE_ENV}.`,
  );
}

/** Resolve and load the RiaGraph binding into this process (riagraph mode). */
export function loadRiaGraph(resolved?: ResolvedGraphEngineConfig): LoadedRiaGraph {
  const found = resolveRiaGraph(resolved);
  claimInProcessEngine('riagraph');
  const cached = riagraphCache.get(found.modulePath);
  if (cached) return cached;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = createRequire(path.join(__dirname, 'graph-engine.js'))(found.modulePath) as {
    Database: GraphEngineBinding['Database'];
    Connection: GraphEngineBinding['Connection'];
    VERSION?: string;
  };
  const loaded: LoadedRiaGraph = {
    binding: {
      name: 'riagraph',
      version: String(mod.VERSION ?? found.version),
      Database: mod.Database,
      Connection: mod.Connection,
    },
    modulePath: found.modulePath,
    buildInfo: found.buildInfo,
  };
  riagraphCache.set(found.modulePath, loaded);
  return loaded;
}
