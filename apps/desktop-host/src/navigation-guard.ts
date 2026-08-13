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
 * Navigation allowlist for every renderer in the app.
 *
 * Electron denies `window.open` by default but does NOT block same-window
 * navigation: a plain link click fires `will-navigate` and, with no handler
 * registered, proceeds. The window then loads a remote origin *with preload.js
 * still attached*, handing that origin the whole `window.riacore` bridge —
 * graph read/write, `git.*`, `persistor.store`, `llm.getSettings`,
 * `shell.openPath`.
 *
 * That is reachable without any renderer bug: an imported ARXML description can
 * carry a prompt injection, the LLM review emits a markdown link,
 * `react-markdown` renders it as an anchor, and the analyst clicks it.
 *
 * Only the dev-server origin and the packaged renderer directory may be loaded
 * in-app. Everything else is cancelled and, when it is an ordinary web link,
 * handed to the OS browser instead.
 *
 * RiaCoreSpec.md §Security Requirements #1, #2.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Schemes safe to hand to the OS default handler. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export interface NavigationScope {
  /** Absolute path of the directory holding the packaged renderer bundle. */
  rendererRoot: string;
  /** `VITE_DEV_SERVER_URL` when running against the Vite dev server. */
  devServerUrl?: string;
}

/**
 * True when `target` belongs to this application: the dev-server origin in
 * development, or a file inside the packaged renderer directory in production.
 *
 * Anything unparseable, any other scheme, and any `file:` URL that resolves
 * outside `rendererRoot` is external.
 */
export function isInternalUrl(target: string, scope: NavigationScope): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (scope.devServerUrl) {
    try {
      if (url.origin === new URL(scope.devServerUrl).origin) return true;
    } catch {
      /* malformed dev-server URL — fall through to the file check */
    }
  }

  if (url.protocol !== 'file:') return false;

  // Resolve before comparing so `renderer/../../../secret.html` cannot pass as
  // an in-app file.
  let filePath: string;
  try {
    filePath = path.resolve(fileURLToPath(url));
  } catch {
    return false;
  }

  const rel = path.relative(path.resolve(scope.rendererRoot), filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when `target` is an ordinary web link that may be handed to the OS
 * browser. Deliberately narrow: `shell.openExternal` will launch a registered
 * protocol handler for schemes like `ms-msdt:` or a UNC path, which turns
 * "open this link" into "run this program".
 */
export function isExternallyOpenable(target: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(target).protocol);
  } catch {
    return false;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

/** The subset of the Electron surface this module needs — kept small for tests. */
export interface NavigationGuardDeps {
  onWebContentsCreated: (handler: (contents: GuardedWebContents) => void) => void;
  openExternal: (url: string) => Promise<void>;
  logger: {
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
  };
  scope: NavigationScope;
}

export interface GuardedWebContents {
  on(event: 'will-navigate' | 'will-redirect', handler: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: 'will-attach-webview', handler: (event: { preventDefault(): void }) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
}

/**
 * Apply the allowlist to every `webContents` the app creates — main window,
 * Graph-Core window, Spawn window, and anything added later. Must be installed
 * before the first `BrowserWindow` is constructed.
 */
export function installNavigationGuard(deps: NavigationGuardDeps): void {
  const { scope, logger } = deps;

  const openExternally = (target: string): void => {
    if (!isExternallyOpenable(target)) {
      logger.warn('Refused to open link with a non-web scheme', { target });
      return;
    }
    deps.openExternal(target).catch((err: unknown) => {
      logger.warn('Failed to open link in the OS browser', {
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  deps.onWebContentsCreated((contents) => {
    const blockNavigation = (event: { preventDefault(): void }, target: string) => {
      if (isInternalUrl(target, scope)) return;
      event.preventDefault();
      logger.warn('Blocked in-app navigation to a non-application URL', { target });
      openExternally(target);
    };

    contents.on('will-navigate', blockNavigation);
    // A server-side redirect does not re-fire `will-navigate`, so an allowed URL
    // that 302s off-origin needs its own check.
    contents.on('will-redirect', blockNavigation);

    contents.setWindowOpenHandler(({ url }) => {
      if (isInternalUrl(url, scope)) return { action: 'allow' };
      logger.info('Routing window.open target to the OS browser', { url });
      openExternally(url);
      return { action: 'deny' };
    });

    // The app uses no <webview> tags; refuse them rather than letting one
    // inherit the preload script.
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      logger.warn('Blocked <webview> attachment');
    });
  });
}
