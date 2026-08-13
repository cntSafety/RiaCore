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
 * Client-side debug logger for the Safety Analysis tree.
 *
 * Debug output is gated behind the `debug` flag in config.json
 * (read via `app.getConfig` IPC channel). When disabled, all calls
 * are no-ops with zero overhead.
 *
 * The flag is fetched once at first use and cached for the session.
 * A manual override is still available via the browser console:
 *   window.__SAFETY_TREE_DEBUG = true
 */
import { api } from '../../../../../api/riacore';

const PREFIX = '[SafetyTree]';

/** Keep the manual override for quick DevTools toggling. */
declare global {
  interface Window {
    __SAFETY_TREE_DEBUG?: boolean;
  }
}

let configDebug: boolean | null = null;

/** Fetch the debug flag once from config.json via IPC. */
function initDebugFlag(): void {
  if (configDebug !== null) return;
  // Default to false until the async call resolves
  configDebug = false;
  try {
    api.app.getConfig()
      .then((cfg) => { configDebug = cfg.debug; })
      .catch(() => { configDebug = false; });
  } catch {
    // In non-browser environments (e.g. test/node), window.riacore is absent — stay false
    configDebug = false;
  }
}

function isEnabled(): boolean {
  // Manual override always wins
  if (typeof window !== 'undefined' && window.__SAFETY_TREE_DEBUG === true) return true;
  // Kick off the config fetch if not done yet
  if (configDebug === null) initDebugFlag();
  return configDebug === true;
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Start a timing span. Returns a `stop()` function that logs elapsed ms. */
function startTimer(label: string): () => number {
  const t0 = performance.now();
  if (isEnabled()) {
    // eslint-disable-next-line no-console
    console.debug(`${PREFIX} ${timestamp()} ⏱ START ${label}`);
  }
  return () => {
    const elapsed = Math.round((performance.now() - t0) * 100) / 100;
    if (isEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(`${PREFIX} ${timestamp()} ⏱ END   ${label} — ${elapsed} ms`);
    }
    return elapsed;
  };
}

function info(msg: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(`${PREFIX} ${timestamp()} ℹ ${msg}`, data ?? '');
}

function debug(msg: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`${PREFIX} ${timestamp()} 🔍 ${msg}`, data ?? '');
}

function warn(msg: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  // eslint-disable-next-line no-console
  console.warn(`${PREFIX} ${timestamp()} ⚠ ${msg}`, data ?? '');
}

function error(msg: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  // eslint-disable-next-line no-console
  console.error(`${PREFIX} ${timestamp()} ❌ ${msg}`, data ?? '');
}

export const treeDebug = {
  isEnabled,
  enable: () => { window.__SAFETY_TREE_DEBUG = true; },
  disable: () => { window.__SAFETY_TREE_DEBUG = false; },
  startTimer,
  info,
  debug,
  warn,
  error,
};
