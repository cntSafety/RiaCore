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
 * Persisted startup-theme snapshot.
 *
 * Inspired by VS Code's `IPartsSplash`: we persist the colors the renderer
 * actually used on its previous launch so we can inject them before the
 * renderer mounts on the next launch. This eliminates the white flash on
 * dark-mode systems by ensuring the very first frame Chromium pushes to
 * the OS compositor is already painted with the correct theme.
 *
 * The persisted file lives under `userData/startup-theme.json`. Failures
 * to read or write are non-fatal — the worst case is a single launch where
 * we fall back to the system color-scheme preference.
 */

import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

interface DebugLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

let debugLogger: DebugLogger | null = null;

/**
 * Wire up an external logger so `loadStartupTheme` / `saveStartupTheme` can
 * surface their decisions through the standard app log file. Optional — when
 * unset, the helpers log only failures via `console.warn`.
 */
export function setStartupThemeLogger(logger: DebugLogger): void {
  debugLogger = logger;
}

function logDebug(message: string, context?: Record<string, unknown>): void {
  debugLogger?.debug(message, context);
}

function logWarn(message: string, context?: Record<string, unknown>): void {
  if (debugLogger) {
    debugLogger.warn(message, context);
  } else {
    console.warn(message, context);
  }
}

export interface StartupTheme {
  /** ISO datetime when this snapshot was saved. */
  savedAt: string;
  /** Whether this snapshot was saved while the renderer was in dark mode. */
  isDark: boolean;
  /** Body background as `#RRGGBB`. Used for `BrowserWindow.backgroundColor`. */
  backgroundColor: string;
  /** Body foreground (text color) as `#RRGGBB`. */
  foregroundColor: string;
}

const DEFAULT_DARK: StartupTheme = {
  savedAt: '1970-01-01T00:00:00.000Z',
  isDark: true,
  backgroundColor: '#141414',
  foregroundColor: '#e6e6e6',
};

const DEFAULT_LIGHT: StartupTheme = {
  savedAt: '1970-01-01T00:00:00.000Z',
  isDark: false,
  backgroundColor: '#ffffff',
  foregroundColor: '#1f1f1f',
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

function getThemePath(): string {
  return path.join(app.getPath('userData'), 'startup-theme.json');
}

/**
 * Load the persisted startup theme. Returns the OS-preference default if
 * the file is missing, malformed, or its `isDark` value disagrees with the
 * current OS color-scheme preference.
 *
 * The OS-preference check is what guarantees correctness when the user
 * toggles Windows dark/light between sessions: if the persisted snapshot is
 * dark but the OS is now light, we fall back to the light default rather
 * than splashing dark and then flipping to light when antd's
 * `prefers-color-scheme` query resolves.
 *
 * Must be called after `app.whenReady()` — `app.getPath('userData')` is
 * not available before that.
 */
export function loadStartupTheme(systemPrefersDark: boolean): StartupTheme {
  const fallback = systemPrefersDark ? DEFAULT_DARK : DEFAULT_LIGHT;
  const filePath = getThemePath();

  logDebug('[startup-theme] load: resolved path', {
    filePath,
    systemPrefersDark,
  });

  if (!existsSync(filePath)) {
    logDebug('[startup-theme] load: no snapshot, using OS-preference fallback', {
      fallbackIsDark: fallback.isDark,
    });
    return fallback;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    logWarn('[startup-theme] load: read failed, using fallback', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }

  let parsed: Partial<StartupTheme>;
  try {
    parsed = JSON.parse(raw) as Partial<StartupTheme>;
  } catch (err) {
    logWarn('[startup-theme] load: JSON parse failed, using fallback', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }

  if (
    typeof parsed.isDark !== 'boolean' ||
    !isHexColor(parsed.backgroundColor) ||
    !isHexColor(parsed.foregroundColor)
  ) {
    logWarn('[startup-theme] load: snapshot validation failed, using fallback', {
      filePath,
    });
    return fallback;
  }

  // Discard the snapshot if the OS theme preference has flipped since the
  // last save. The renderer is driven by `prefers-color-scheme`, so on the
  // next paint it will pick the OS preference; using a stale snapshot of
  // the opposite mode would produce a flash in the other direction.
  if (parsed.isDark !== systemPrefersDark) {
    logDebug('[startup-theme] load: OS preference flipped since last save, using fallback', {
      snapshotIsDark: parsed.isDark,
      systemPrefersDark,
    });
    return fallback;
  }

  return {
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : fallback.savedAt,
    isDark: parsed.isDark,
    backgroundColor: parsed.backgroundColor,
    foregroundColor: parsed.foregroundColor,
  };
}

/**
 * Persist the startup theme atomically (write-then-rename).
 * Failures are logged via the configured debug logger (or console.warn).
 */
export function saveStartupTheme(theme: StartupTheme): void {
  const filePath = getThemePath();
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(theme, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
    logDebug('[startup-theme] save: succeeded', {
      filePath,
      isDark: theme.isDark,
      backgroundColor: theme.backgroundColor,
    });
  } catch (err) {
    logWarn('[startup-theme] save: failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the inline CSS that `webContents.insertCSS()` injects on
 * `did-start-loading`. Applied before the renderer's own stylesheets, this
 * ensures Chromium's first paint is already themed.
 */
export function buildSplashCss(theme: StartupTheme): string {
  return [
    'html, body, #root {',
    `  background-color: ${theme.backgroundColor} !important;`,
    `  color: ${theme.foregroundColor} !important;`,
    '}',
  ].join('\n');
}
