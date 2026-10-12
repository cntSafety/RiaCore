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
 * logger.ts — Structured import logger
 *
 * Writes structured log lines to both stdout and a timestamped file
 * under a configurable log directory. Adapted from backend/src/logger.ts.
 *
 * Usage:
 *   import { createImportLogger } from './infra/logger.js';
 *   const logger = createImportLogger('/path/to/logs');
 *   logger.info('Import started', { namespace: 'MyNS', config: 'config.yaml' });
 */

import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WriteStream } from 'node:fs';

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

// ── Log sinks ─────────────────────────────────────────────────────────────────
//
// Every logger here writes each line twice: to its log file, and to a sink. The
// sink is a constructor parameter rather than a hard-coded `console.*` call,
// because where log lines belong is the host's decision, not this library's:
//
//   - Electron main / worker  → the console (`consoleLogSink`, the default)
//   - CLI                     → stderr, so stdout stays pure JSON (`stderrLogSink`)
//   - CLI under --quiet       → nowhere (`silentLogSink`); the file still gets it
//
// Passing the sink in keeps that choice explicit and per-logger. An earlier
// attempt used a module-global `setLoggerConsoleSink`, which worked but made the
// destination invisible at the call site and process-wide by nature.

export type LogSink = (level: Level, line: string) => void;

/** Default: mirror lines to the console, by level. DEBUG is file-only. */
export const consoleLogSink: LogSink = (level, line) => {
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else if (level === 'INFO') console.log(line);
};

/**
 * Send every level to stderr, leaving stdout free for machine-readable output.
 *
 * DEBUG is included: a host that asks for stderr wants the detail, and unlike
 * the console sink there is no stdout to protect.
 */
export const stderrLogSink: LogSink = (_level, line) => {
  process.stderr.write(line + '\n');
};

/** Discard console output entirely; the log file is unaffected. */
export const silentLogSink: LogSink = () => { /* file only */ };

const WORKSPACE_LOG_MAX_FILES = 30;
const WORKSPACE_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function pruneWorkspaceLogDirectory(logDir: string, preserveLogFile: string): void {
  try {
    const now = Date.now();
    const candidates = readdirSync(logDir)
      .filter((entry) => entry.endsWith('.log'))
      .map((entry) => {
        const filePath = resolve(logDir, entry);
        return {
          filePath,
          stat: statSync(filePath),
        };
      })
      .filter(({ stat }) => stat.isFile());

    for (const candidate of candidates) {
      if (candidate.filePath === preserveLogFile) {
        continue;
      }

      if (now - candidate.stat.mtimeMs > WORKSPACE_LOG_MAX_AGE_MS) {
        rmSync(candidate.filePath, { force: true });
      }
    }

    const remaining = readdirSync(logDir)
      .filter((entry) => entry.endsWith('.log'))
      .map((entry) => {
        const filePath = resolve(logDir, entry);
        return {
          filePath,
          stat: statSync(filePath),
        };
      })
      .filter(({ stat }) => stat.isFile())
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

    let kept = 0;
    for (const candidate of remaining) {
      if (candidate.filePath === preserveLogFile) {
        kept += 1;
        continue;
      }

      if (kept < WORKSPACE_LOG_MAX_FILES - 1) {
        kept += 1;
        continue;
      }

      rmSync(candidate.filePath, { force: true });
    }
  } catch (error) {
    console.warn(
      `[WorkspaceLogs] Failed to prune log directory ${JSON.stringify(logDir)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ImportLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  /** Flush and close the underlying log file stream. Safe to call multiple times. */
  close(): void;
}

export function createImportLogger(logDir: string, sink: LogSink = consoleLogSink): ImportLogger {
  mkdirSync(logDir, { recursive: true });

  // This factory serves imports, persistence, merges, and other workspace
  // operations. Append all operations for a UTC day to one accurately named
  // file instead of creating a misleading import file for every operation.
  const date = new Date().toISOString().slice(0, 10);
  const logPath = resolve(logDir, `workspace-${date}.log`);
  const stream: WriteStream = createWriteStream(logPath, { encoding: 'utf-8', flags: 'a' });
  let streamHealthy = true;
  stream.on('error', (error) => {
    streamHealthy = false;
    console.warn(
      `[WorkspaceLogger] Failed to write to ${JSON.stringify(logPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  pruneWorkspaceLogDirectory(logDir, logPath);

  function write(level: Level, msg: string, ctx?: Record<string, unknown>): void {
    // The daily workspace log is an operational incident log, not a trace.
    // Domain-specific diagnostic loggers retain DEBUG when detailed tracing is
    // explicitly needed, but routine workspace operations start at INFO.
    if (level === 'DEBUG') return;

    const timestamp = new Date().toISOString();
    const ctxStr = ctx && Object.keys(ctx).length > 0
      ? '  ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    const line = `[${timestamp}] [${level.padEnd(5)}] [Workspace] ${msg}${ctxStr}`;
    if (streamHealthy) {
      try {
        stream.write(line + '\n');
      } catch {
        streamHealthy = false;
      }
    }
    sink(level, line);
  }

  write('INFO', 'Workspace operation logger started', { logFile: logPath });

  return {
    info:  (msg, ctx) => write('INFO',  msg, ctx),
    warn:  (msg, ctx) => write('WARN',  msg, ctx),
    error: (msg, ctx) => write('ERROR', msg, ctx),
    debug: (msg, ctx) => write('DEBUG', msg, ctx),
    close: () => { if (streamHealthy) { streamHealthy = false; stream.end(); } },
  };
}

export function createDiffMergeLogger(logDir: string, sink: LogSink = consoleLogSink): ImportLogger {
  mkdirSync(logDir, { recursive: true });

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const logPath = resolve(logDir, `diff-merge-${ts}.log`);
  const stream: WriteStream = createWriteStream(logPath, { encoding: 'utf-8', flags: 'a' });
  let streamHealthy = true;
  stream.on('error', (error) => {
    streamHealthy = false;
    console.warn(
      `[DiffMergeLogger] Failed to write to ${JSON.stringify(logPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  pruneWorkspaceLogDirectory(logDir, logPath);

  function write(level: Level, msg: string, ctx?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const ctxStr = ctx && Object.keys(ctx).length > 0
      ? '  ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    const line = `[${timestamp}] [${level.padEnd(5)}] [DiffMerge] ${msg}${ctxStr}`;
    if (streamHealthy) {
      try {
        stream.write(line + '\n');
      } catch {
        streamHealthy = false;
      }
    }
    sink(level, line);
  }

  write('INFO', 'Diff/merge logger started', { logFile: logPath });

  return {
    info:  (msg, ctx) => write('INFO',  msg, ctx),
    warn:  (msg, ctx) => write('WARN',  msg, ctx),
    error: (msg, ctx) => write('ERROR', msg, ctx),
    debug: (msg, ctx) => write('DEBUG', msg, ctx),
    close: () => { if (streamHealthy) { streamHealthy = false; stream.end(); } },
  };
}

export interface PersistorLoadLogger extends ImportLogger {
  /** Absolute path of the log file being written. */
  readonly logFile: string;
}

export function createPersistorLoadLogger(logDir: string, sink: LogSink = consoleLogSink): PersistorLoadLogger {
  mkdirSync(logDir, { recursive: true });

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const logFile = resolve(logDir, `persistor-load-${ts}.log`);
  const stream: WriteStream = createWriteStream(logFile, { encoding: 'utf-8', flags: 'a' });
  let streamHealthy = true;
  stream.on('error', (error) => {
    streamHealthy = false;
    console.warn(
      `[PersistorLogger] Failed to write to ${JSON.stringify(logFile)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  pruneWorkspaceLogDirectory(logDir, logFile);

  function write(level: Level, msg: string, ctx?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const ctxStr = ctx && Object.keys(ctx).length > 0
      ? '  ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    const line = `[${timestamp}] [${level.padEnd(5)}] [Persistor] ${msg}${ctxStr}`;
    if (streamHealthy) {
      try {
        stream.write(line + '\n');
      } catch {
        streamHealthy = false;
      }
    }
    sink(level, line);
  }

  write('INFO', 'Persistor load logger started', { logFile });

  return {
    logFile,
    info:  (msg, ctx) => write('INFO',  msg, ctx),
    warn:  (msg, ctx) => write('WARN',  msg, ctx),
    error: (msg, ctx) => write('ERROR', msg, ctx),
    debug: (msg, ctx) => write('DEBUG', msg, ctx),
    close: () => { if (streamHealthy) { streamHealthy = false; stream.end(); } },
  };
}

// ── Logger factory ────────────────────────────────────────────────────────────

/**
 * The set of loggers a host supplies to app-core.
 *
 * WHY THIS IS AN INTERFACE ON ServiceDependencies
 *
 * Dispatch handlers and services need loggers, but they must not choose where
 * the lines go — that depends on the host. Before this existed, the only seam
 * was a single optional `deps.createLogger` covering the workspace logger, so:
 *
 *   - `createDiffMergeLogger` had no seam at all and was constructed directly in
 *     five handlers, writing to stdout no matter what the host wanted;
 *   - every call site that did use the seam carried a fallback
 *     (`deps.createLogger ? … : createImportLogger(…)`), and the fallback is
 *     what defeated injection — `orchestration-service.ts` and two sites in
 *     `import-channels.ts` skipped the seam entirely and nothing caught it;
 *   - `persistor-channels.ts` returned a *different kind* of logger depending on
 *     whether the host had injected one: `deps.createLogger(dir)` gave the
 *     workspace logger while the fallback gave the persistor-load logger, so
 *     which file a load was traced into depended on the host.
 *
 * Hence three named methods and a required field on ServiceDependencies: asking
 * for the wrong logger, or forgetting to route one, is now a type error.
 *
 * Methods take `workingDir`, not a log directory — appending `logs` is this
 * factory's job. Previously the injected form took `workingDir` while every
 * fallback wrote `path.join(workingDir, 'logs')` at the call site, which meant
 * two conventions for one concept and an easy mistake to make.
 */
export interface LoggerFactory {
  /** General workspace operations: imports, namespace edits, save/export. */
  workspace(workingDir: string): ImportLogger;
  /** Diff and merge operations; own timestamped file. */
  diffMerge(workingDir: string): ImportLogger;
  /** Detailed persistor load tracing; own timestamped file. */
  persistorLoad(workingDir: string): PersistorLoadLogger;
}

/**
 * The standard file-backed factory.
 *
 * @param sink where to mirror lines besides the log file. Defaults to the
 *   console, which is what Electron main, the worker, and tests want. The CLI
 *   passes `stderrLogSink` (or `silentLogSink` under `--quiet`) so that stdout
 *   carries only the command's JSON result.
 */
export function createFileLoggerFactory(sink: LogSink = consoleLogSink): LoggerFactory {
  const logDir = (workingDir: string): string => resolve(workingDir, 'logs');
  return {
    workspace: (workingDir) => createImportLogger(logDir(workingDir), sink),
    diffMerge: (workingDir) => createDiffMergeLogger(logDir(workingDir), sink),
    persistorLoad: (workingDir) => createPersistorLoadLogger(logDir(workingDir), sink),
  };
}

/**
 * A factory whose loggers discard everything — no file, no console.
 *
 * For tests and any host that genuinely wants logging off. Prefer this over
 * `createFileLoggerFactory(silentLogSink)` when you do not want log files
 * created as a side effect of constructing dependencies.
 */
export function createNullLoggerFactory(): LoggerFactory {
  const noop: ImportLogger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {},
  };
  return {
    workspace: () => noop,
    diffMerge: () => noop,
    persistorLoad: () => ({ ...noop, logFile: '' }),
  };
}
