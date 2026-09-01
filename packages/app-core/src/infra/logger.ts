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

export function createImportLogger(logDir: string): ImportLogger {
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
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else if (level === 'INFO') console.log(line);
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

export function createDiffMergeLogger(logDir: string): ImportLogger {
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
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else if (level === 'INFO') console.log(line);
    // DEBUG: file only — no stdout
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

export function createPersistorLoadLogger(logDir: string): PersistorLoadLogger {
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
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else if (level === 'INFO') console.log(line);
    // DEBUG: file only — no stdout
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
