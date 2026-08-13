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
import { app, dialog } from 'electron';
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';

type AppLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
type AppLogMode = 'portable' | 'appdata' | 'console-only';

const APP_LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const APP_LOG_MAX_FILES = 10;
const APP_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface AppLogState {
  mode: AppLogMode;
  logFile: string | null;
  logDir: string | null;
  portableLogDir: string | null;
  warningShown: boolean;
  fileSequence: number;
}

interface AppLogger {
  readonly logFile: string | null;
  readonly logDir: string | null;
  readonly mode: AppLogMode;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  fatal(message: string, context?: Record<string, unknown>): void;
}

let logger: AppLogger | null = null;
let state: AppLogState | null = null;

function sanitizePortableName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'RiaCore';
  }

  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function resolvePortableLogsDirectory(): string | null {
  const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!portableExecutableDir) {
    return null;
  }

  const portableAppName = process.env.PORTABLE_EXECUTABLE_APP_FILENAME ?? sanitizePortableName(app.getName());
  return path.join(portableExecutableDir, `${portableAppName}Data`, 'logs');
}

function getAppDataLogsDirectory(): string {
  app.setAppLogsPath();
  const logDir = app.getPath('logs');
  return logDir;
}

function buildLogFilePath(logDir: string, fileSequence: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = fileSequence > 0 ? `-r${fileSequence}` : '';
  return path.join(logDir, `desktop-host-${timestamp}-p${process.pid}${suffix}.log`);
}

function prepareLogTarget(logDir: string, fileSequence: number): { logDir: string; logFile: string } {
  mkdirSync(logDir, { recursive: true });
  const logFile = buildLogFilePath(logDir, fileSequence);
  appendFileSync(logFile, '', { encoding: 'utf-8', flag: 'a' });
  return { logDir, logFile };
}

function pruneAppLogDirectory(logDir: string, preserveLogFile: string): void {
  try {
    const now = Date.now();
    const candidates = readdirSync(logDir)
      .filter((entry) => entry.endsWith('.log'))
      .map((entry) => {
        const filePath = path.join(logDir, entry);
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

      if (now - candidate.stat.mtimeMs > APP_LOG_MAX_AGE_MS) {
        rmSync(candidate.filePath, { force: true });
      }
    }

    const remaining = readdirSync(logDir)
      .filter((entry) => entry.endsWith('.log'))
      .map((entry) => {
        const filePath = path.join(logDir, entry);
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

      if (kept < APP_LOG_MAX_FILES - 1) {
        kept += 1;
        continue;
      }

      rmSync(candidate.filePath, { force: true });
    }
  } catch (error) {
    console.warn(`[DesktopHost] Failed to prune lifecycle log directory ${JSON.stringify(logDir)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showLogWarningOnce(message: string): void {
  if (!state || state.warningShown || !app.isReady()) {
    return;
  }

  state.warningShown = true;
  dialog.showErrorBox('RiaCore Logging Warning', message);
}

function createInitialState(): AppLogState {
  const portableLogDir = resolvePortableLogsDirectory();
  const failures: Array<{ label: string; dir: string; error: string }> = [];

  if (portableLogDir) {
    try {
      const target = prepareLogTarget(portableLogDir, 0);
      pruneAppLogDirectory(target.logDir, target.logFile);
      return {
        mode: 'portable',
        logDir: target.logDir,
        logFile: target.logFile,
        portableLogDir,
        warningShown: false,
        fileSequence: 0,
      };
    } catch (error) {
      failures.push({
        label: 'portable',
        dir: portableLogDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const appDataLogDir = getAppDataLogsDirectory();
  try {
    const target = prepareLogTarget(appDataLogDir, 0);
    pruneAppLogDirectory(target.logDir, target.logFile);
    const nextState: AppLogState = {
      mode: 'appdata',
      logDir: target.logDir,
      logFile: target.logFile,
      portableLogDir,
      warningShown: false,
      fileSequence: 0,
    };
    state = nextState;

    if (failures.length > 0) {
      const failure = failures[0];
      const line = `[${new Date().toISOString()}] [WARN ] [DesktopHost] Portable lifecycle log directory unavailable; falling back to AppData logs  portableLogDir=${JSON.stringify(failure.dir)} error=${JSON.stringify(failure.error)} fallbackLogDir=${JSON.stringify(target.logDir)}`;
      appendFileSync(target.logFile, line + '\n', { encoding: 'utf-8' });
      console.warn(line);
    }

    return nextState;
  } catch (error) {
    failures.push({
      label: 'appdata',
      dir: appDataLogDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const warningMessage = [
    'RiaCore could not write lifecycle logs to disk.',
    'Diagnostics will be limited to this session and only available via console output.',
    '',
    'Attempted locations:',
    ...failures.map((failure) => `- ${failure.label}: ${failure.dir} (${failure.error})`),
  ].join('\n');

  console.error(warningMessage);

  return {
    mode: 'console-only',
    logDir: null,
    logFile: null,
    portableLogDir,
    warningShown: false,
    fileSequence: 0,
  };
}

function rotateLifecycleLogIfNeeded(): void {
  if (!state?.logFile || !state.logDir) {
    return;
  }

  try {
    const currentSize = statSync(state.logFile).size;
    if (currentSize < APP_LOG_MAX_SIZE_BYTES) {
      return;
    }

    state.fileSequence += 1;
    const nextTarget = prepareLogTarget(state.logDir, state.fileSequence);
    state.logFile = nextTarget.logFile;
    pruneAppLogDirectory(nextTarget.logDir, nextTarget.logFile);
  } catch (error) {
    console.warn(`[DesktopHost] Failed to rotate lifecycle log file ${JSON.stringify(state.logFile)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) {
    return '';
  }

  return '  ' + Object.entries(context)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
}

function writeLine(logFile: string, level: AppLogLevel, message: string, context?: Record<string, unknown>): void {
  rotateLifecycleLogIfNeeded();
  const targetLogFile = state?.logFile ?? logFile;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.padEnd(5)}] [DesktopHost] ${message}${formatContext(context)}`;

  try {
    appendFileSync(targetLogFile, line + '\n', { encoding: 'utf-8' });
  } catch (error) {
    if (state) {
      state.mode = 'console-only';
      state.logDir = null;
      state.logFile = null;
    }

    const writeError = error instanceof Error ? error.message : String(error);
    console.error(`[${timestamp}] [ERROR] [DesktopHost] Failed to write lifecycle log file  attemptedLogFile=${JSON.stringify(targetLogFile)} error=${JSON.stringify(writeError)}`);
    showLogWarningOnce(
      [
        'RiaCore could not continue writing lifecycle logs to disk.',
        'Diagnostics will be limited to this session and only available via console output.',
        '',
        `Last attempted log file: ${targetLogFile}`,
        `Error: ${writeError}`,
      ].join('\n'),
    );
  }

  if (level === 'ERROR' || level === 'FATAL') {
    console.error(line);
    return;
  }

  if (level === 'WARN') {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function getAppLogger(): AppLogger {
  if (logger) {
    return logger;
  }

  state ??= createInitialState();

  logger = {
    get logFile() {
      return state?.logFile ?? null;
    },
    get logDir() {
      return state?.logDir ?? null;
    },
    get mode() {
      return state?.mode ?? 'console-only';
    },
    debug: (message, context) => {
      if (state?.logFile) {
        writeLine(state.logFile, 'DEBUG', message, context);
        return;
      }
      console.log(`[${new Date().toISOString()}] [DEBUG] [DesktopHost] ${message}${formatContext(context)}`);
    },
    info: (message, context) => {
      if (state?.logFile) {
        writeLine(state.logFile, 'INFO', message, context);
        return;
      }
      console.log(`[${new Date().toISOString()}] [INFO ] [DesktopHost] ${message}${formatContext(context)}`);
    },
    warn: (message, context) => {
      if (state?.logFile) {
        writeLine(state.logFile, 'WARN', message, context);
        return;
      }
      console.warn(`[${new Date().toISOString()}] [WARN ] [DesktopHost] ${message}${formatContext(context)}`);
    },
    error: (message, context) => {
      if (state?.logFile) {
        writeLine(state.logFile, 'ERROR', message, context);
        return;
      }
      console.error(`[${new Date().toISOString()}] [ERROR] [DesktopHost] ${message}${formatContext(context)}`);
    },
    fatal: (message, context) => {
      if (state?.logFile) {
        writeLine(state.logFile, 'FATAL', message, context);
        return;
      }
      console.error(`[${new Date().toISOString()}] [FATAL] [DesktopHost] ${message}${formatContext(context)}`);
    },
  };

  if (state.mode === 'console-only') {
    showLogWarningOnce(
      [
        'RiaCore could not write lifecycle logs to disk.',
        'Diagnostics will be limited to this session and only available via console output.',
      ].join('\n'),
    );
  }

  logger.info('Desktop host logger started', {
    logFile: state.logFile,
    logDir: state.logDir,
    mode: state.mode,
    portableLogDir: state.portableLogDir,
  });
  return logger;
}

export function ensureAppLogsDirectory(): string {
  const logDir = getAppLogger().logDir;
  if (!logDir) {
    throw new Error('App lifecycle logs are running in console-only mode because no writable log directory is available.');
  }

  return logDir;
}