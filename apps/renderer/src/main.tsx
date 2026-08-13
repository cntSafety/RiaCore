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
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (offline-friendly, no Google Fonts CDN).
// Each import emits a woff2 file into the renderer bundle via Vite.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './global.css';
import App from './App';
import { api } from './api/riacore';
import { GRAPH_CORE_VIEW_FLAG } from './modules/graph-core-window/viewFlag';
import GraphCoreApp from './modules/graph-core-window/GraphCoreApp';
import { SAFETY_ANALYSIS_SPAWN_VIEW_FLAG } from './modules/safety-analysis-spawn/viewFlag';
import SafetyAnalysisSpawnApp from './modules/safety-analysis-spawn/SafetyAnalysisSpawnApp';
import { appQueryClient } from './appQueryClient';
import { graphCoreQueryClient } from './modules/graph-core-window/graphCoreQueryClient';
import { spawnQueryClient } from './modules/safety-analysis-spawn/spawnQueryClient';
import { installCacheInvalidationSubscriber } from './lib/cache-invalidation-subscriber';

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  return { message: String(error) };
}

function reportRendererEvent(entry: {
  level: 'error' | 'warn' | 'info';
  type: 'window.error' | 'unhandledrejection' | 'mutation.error' | 'renderer.info';
  message: string;
  stack?: string;
  component?: string;
  context?: Record<string, unknown>;
}): void {
  void api.app.logRendererEvent(entry).catch((error) => {
    const fallback = serializeError(error);
    console.error('[Renderer] Failed to forward renderer log event', {
      originalEntry: entry,
      error: fallback.message,
      stack: fallback.stack,
    });
  });
}

window.addEventListener('error', (event) => {
  reportRendererEvent({
    level: 'error',
    type: 'window.error',
    message: event.message || 'Unhandled renderer error',
    stack: event.error instanceof Error ? event.error.stack : undefined,
    context: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const details = serializeError(event.reason);
  reportRendererEvent({
    level: 'error',
    type: 'unhandledrejection',
    message: details.message,
    stack: details.stack,
  });
});

const view = new URLSearchParams(window.location.search).get('view');
const Root =
  view === GRAPH_CORE_VIEW_FLAG ? GraphCoreApp :
  view === SAFETY_ANALYSIS_SPAWN_VIEW_FLAG ? SafetyAnalysisSpawnApp :
  App;

// Determine which QueryClient to use for this renderer root.
// The subscriber must be installed synchronously before createRoot().render()
// so that mutations completing before the first render are captured.
// Requirements: 15.9
const activeQueryClient =
  view === GRAPH_CORE_VIEW_FLAG ? graphCoreQueryClient :
  view === SAFETY_ANALYSIS_SPAWN_VIEW_FLAG ? spawnQueryClient :
  appQueryClient;

const disposeSubscriber = installCacheInvalidationSubscriber(activeQueryClient);
window.addEventListener('beforeunload', () => disposeSubscriber());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

// After React commits its first frame, signal the main process so it can ramp
// the window opacity from 0 to 1. The window was created with `opacity: 0` to
// avoid the Win11 window-open animation, so this signal is what actually
// reveals the UI. Two nested rAFs ensure the browser has actually painted
// before we signal.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    try {
      window.riacore.window.paintReady();
    } catch {
      // riacore preload may not be available in some test contexts; ignore.
    }
  });
});
