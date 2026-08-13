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
import type {
  CacheInvalidationMessage,
  CacheInvalidationOutbound,
  LlmStreamEvent,
  LoadProgressPushEvent,
  RendererLogEntry,
} from '@riacore/app-contracts';

type RiaCoreBridge = Window['riacore'];
type PayloadBuilder = (args: unknown[]) => unknown;

const CHANNEL_OVERRIDES: Record<string, string> = {
  'contextMenu.show': 'context-menu.show',
  'namespaces.getSyncStatus': 'namespace.getSyncStatus',
  'namespaces.applyUnionMergeFromFiles': 'namespace.applyUnionMergeFromFiles',
  'namespaces.applyUnionMergeFromBranch': 'namespace.applyUnionMergeFromBranch',
  'namespaces.supervisedMergeFromBranchPrepare': 'namespace.supervisedMergeFromBranchPrepare',
  'namespaces.supervisedMergeCleanup': 'namespace.supervisedMergeCleanup',
  'namespaceConnections.getGraph': 'namespaceConnections:getGraph',
  'namespaceConnections.connect': 'namespaceConnections:connect',
  'namespaceConnections.disconnect': 'namespaceConnections:disconnect',
  'namespaceConnections.countDependents': 'namespaceConnections:countDependents',
  'canvasLayout.getLayout': 'canvasLayout:getLayout',
  'canvasLayout.setRecords': 'canvasLayout:setRecords',
};

const PAYLOAD_BUILDERS: Record<string, PayloadBuilder> = {
  'workspace.probe': ([workingDir]) => ({ workingDir }),
  'imports.getStatus': ([runId]) => ({ runId }),
  'imports.getConfig': ([sourceId]) => ({ sourceId }),
  'imports.getArxmlTree': ([sourceId]) => ({ sourceId }),
  'imports.getImpactReport': ([runId]) => ({ runId }),
  'imports.deleteSource': ([sourceId]) => ({ sourceId }),
  'namespaces.previewDeleteImpact': ([namespace]) => ({ namespace }),
  'namespaces.delete': ([namespace]) => ({ namespace }),
  'canvasLayout.setRecords': ([records]) => ({ records }),
};

const RECENT_KEY = 'riacore.webDev.recentWorkspaces';
const LAST_PATH_KEY = 'riacore.webDev.lastPath';

interface InvokeResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function defaultPayload(args: unknown[]): unknown {
  if (args.length === 0) return undefined;
  return args[0];
}

function getDevConfig() {
  const baseUrl = import.meta.env.VITE_RIACORE_WEB_DEV_URL || 'http://127.0.0.1:5184';
  const token = import.meta.env.VITE_RIACORE_WEB_DEV_TOKEN || '';
  if (!token) {
    throw new Error('Browser dev backend token is not configured. Start with pnpm dev:web.');
  }
  return { baseUrl, token };
}

async function invokeWeb(channel: string, payload?: unknown): Promise<unknown> {
  const { baseUrl, token } = getDevConfig();
  const res = await fetch(`${baseUrl}/api/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-riacore-dev-token': token,
    },
    credentials: 'omit',
    body: JSON.stringify({ channel, payload }),
  });

  let body: InvokeResponse | null = null;
  try {
    body = await res.json() as InvokeResponse;
  } catch {
    // Keep the clearer HTTP status error below.
  }

  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `RiaCore browser dev request failed (${res.status})`);
  }
  return body.data;
}

function createInvoker(category: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return (...args: unknown[]) => {
        const bridgeKey = `${category}.${prop}`;
        const channel = CHANNEL_OVERRIDES[bridgeKey] ?? bridgeKey;
        const payload = (PAYLOAD_BUILDERS[bridgeKey] ?? defaultPayload)(args);
        return invokeWeb(channel, payload);
      };
    },
  }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

function createSection<T extends object>(
  category: string,
  overrides: Partial<Record<keyof T, unknown>>,
): T {
  const invoker = createInvoker(category);
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof T];
      }
      if (typeof prop !== 'string') return undefined;
      return invoker[prop];
    },
  }) as T;
}

let eventSource: EventSource | null = null;

function subscribeSse<T>(eventName: string, handler: (event: T) => void): () => void {
  const { baseUrl, token } = getDevConfig();
  if (!eventSource) {
    const url = new URL('/api/events', baseUrl);
    url.searchParams.set('token', token);
    eventSource = new EventSource(url.toString());
    eventSource.onerror = () => {
      console.warn('[RiaCore] Browser dev event stream disconnected');
    };
  }

  const listener = (event: MessageEvent<string>) => {
    handler(JSON.parse(event.data) as T);
  };
  eventSource.addEventListener(eventName, listener as EventListener);
  return () => eventSource?.removeEventListener(eventName, listener as EventListener);
}

function getRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) as string[] : [];
  } catch {
    return [];
  }
}

function addRecent(workingDir: string): string[] {
  const next = [workingDir, ...getRecent().filter((item) => item !== workingDir)].slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

const cacheListeners = new Set<(msg: CacheInvalidationMessage) => void>();
const fileActionListeners = new Set<(action: string) => void>();

function noopUnsubscribe(): () => void {
  return () => undefined;
}

function getLastPath(): string {
  try {
    return localStorage.getItem(LAST_PATH_KEY) || '/Users/sam/sandbox/RiaTestMe-codex-run';
  } catch {
    return '/Users/sam/sandbox/RiaTestMe-codex-run';
  }
}

function rememberPath(filePath: string): void {
  try {
    localStorage.setItem(LAST_PATH_KEY, filePath);
  } catch {
    // Best-effort browser-dev convenience only.
  }
}

function promptForPath(title: string, defaultPath = getLastPath()): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,.35)',
    ].join(';');

    const panel = document.createElement('form');
    panel.style.cssText = [
      'width:min(680px,calc(100vw - 32px))',
      'border:1px solid rgba(0,0,0,.18)',
      'border-radius:8px',
      'background:#fff',
      'box-shadow:0 14px 44px rgba(0,0,0,.24)',
      'padding:16px',
      'font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'color:#1f1f1f',
    ].join(';');

    const label = document.createElement('label');
    label.textContent = title;
    label.style.cssText = 'display:block;font-weight:600;margin-bottom:8px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultPath;
    input.style.cssText = [
      'box-sizing:border-box',
      'width:100%',
      'border:1px solid #bfbfbf',
      'border-radius:4px',
      'padding:8px 10px',
      'font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';

    const makeButton = (text: string, submit: boolean) => {
      const button = document.createElement('button');
      button.type = submit ? 'submit' : 'button';
      button.textContent = text;
      button.style.cssText = [
        'border:1px solid #bfbfbf',
        'border-radius:4px',
        'background:#f7f7f7',
        'color:#1f1f1f',
        'padding:5px 12px',
        'font:inherit',
        'cursor:pointer',
      ].join(';');
      return button;
    };

    const cancel = makeButton('Cancel', false);
    const ok = makeButton('Use Path', true);
    ok.style.background = '#1677ff';
    ok.style.borderColor = '#1677ff';
    ok.style.color = '#fff';

    const cleanup = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      const trimmed = input.value.trim();
      if (!trimmed) {
        cleanup(null);
        return;
      }
      rememberPath(trimmed);
      cleanup(trimmed);
    });

    actions.append(cancel, ok);
    panel.append(label, input, actions);
    overlay.append(panel);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

function emitFileAction(action: string): void {
  for (const listener of fileActionListeners) {
    listener(action);
  }
}

function ensureWebDevToolbar(): void {
  if (document.getElementById('riacore-web-dev-toolbar')) return;

  const toolbar = document.createElement('div');
  toolbar.id = 'riacore-web-dev-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.style.cssText = [
    'position:fixed',
    'top:8px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'display:flex',
    'gap:6px',
    'align-items:center',
    'padding:6px',
    'border:1px solid rgba(0,0,0,.18)',
    'border-radius:6px',
    'background:rgba(255,255,255,.96)',
    'box-shadow:0 4px 14px rgba(0,0,0,.16)',
    'font:12px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = 'Web Dev';
  label.style.cssText = 'font-weight:600;color:#555;padding:0 4px;';
  toolbar.append(label);

  const makeButton = (text: string, action: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.style.cssText = [
      'border:1px solid #c8c8c8',
      'border-radius:4px',
      'background:#f7f7f7',
      'color:#1f1f1f',
      'padding:3px 8px',
      'font:inherit',
      'cursor:pointer',
    ].join(';');
    button.addEventListener('click', () => emitFileAction(action));
    return button;
  };

  toolbar.append(
    makeButton('Open Workspace', 'open-workspace'),
    makeButton('Create Workspace', 'create-workspace'),
    makeButton('Close Workspace', 'close-workspace'),
    makeButton('Save', 'save'),
  );

  document.body.append(toolbar);
}

function createBrowserBridge(): RiaCoreBridge {
  return {
    app: createSection<RiaCoreBridge['app']>('app', {
      logRendererEvent: (entry: RendererLogEntry) => invokeWeb('app.logRendererEvent', entry) as Promise<void>,
    }),
    workspace: createSection<RiaCoreBridge['workspace']>('workspace', {
      getRecent: async () => getRecent(),
      addRecent: async (workingDir: string) => addRecent(workingDir),
    }),
    db: createInvoker('db') as RiaCoreBridge['db'],
    imports: createInvoker('imports') as RiaCoreBridge['imports'],
    persistor: createSection<RiaCoreBridge['persistor']>('persistor', {
      onLoadProgress: (handler: (event: LoadProgressPushEvent) => void) =>
        subscribeSse('persistor.loadProgress', handler),
    }),
    dialog: {
      openDirectory: async (options?: { title?: string; defaultPath?: string; relativeTo?: string }) =>
        promptForPath(options?.title ?? 'RiaCore web dev: enter an absolute directory path'),
      saveFile: async (options) => {
        const defaultName = options.defaultPath ?? 'export';
        const defaultPath = defaultName.startsWith('/')
          ? defaultName
          : `${getLastPath().replace(/\/$/, '')}/${defaultName}`;
        return promptForPath(options.title ?? 'RiaCore web dev: enter an output file path', defaultPath);
      },
    },
    shell: {
      openPath: async (filePath: string) => {
        console.info('[RiaCore] shell.openPath is disabled in browser dev mode', filePath);
      },
    },
    contextMenu: {
      show: async () => null,
    },
    importers: createInvoker('importers') as RiaCoreBridge['importers'],
    profiles: createInvoker('profiles') as RiaCoreBridge['profiles'],
    metamodel: createInvoker('metamodel') as RiaCoreBridge['metamodel'],
    namespaceConnections: createInvoker('namespaceConnections') as RiaCoreBridge['namespaceConnections'],
    canvasLayout: createInvoker('canvasLayout') as RiaCoreBridge['canvasLayout'],
    namespaces: createInvoker('namespaces') as RiaCoreBridge['namespaces'],
    safety: createInvoker('safety') as RiaCoreBridge['safety'],
    checks: createInvoker('checks') as RiaCoreBridge['checks'],
    arxml: createInvoker('arxml') as RiaCoreBridge['arxml'],
    graph: createInvoker('graph') as RiaCoreBridge['graph'],
    menu: {
      setPropagationState: () => undefined,
      onStartPropagation: noopUnsubscribe,
      onEndPropagation: noopUnsubscribe,
      onCancelPropagation: noopUnsubscribe,
      onFileAction: (handler: (action: string) => void) => {
        fileActionListeners.add(handler);
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', ensureWebDevToolbar, { once: true });
        } else {
          ensureWebDevToolbar();
        }
        return () => fileActionListeners.delete(handler);
      },
      onGitAction: noopUnsubscribe,
      onReportAction: noopUnsubscribe,
      setSafetyNamespaceState: () => undefined,
      setMalfunctionClipboardState: () => undefined,
      onCopyMalfunction: noopUnsubscribe,
      onPasteMalfunction: noopUnsubscribe,
      setShowInTreeState: () => undefined,
      setAddMalfunctionState: () => undefined,
      onAddMalfunction: noopUnsubscribe,
      setDeleteMalfunctionState: () => undefined,
      onDeleteMalfunction: noopUnsubscribe,
      onShowInTree: noopUnsubscribe,
      onShowReferenceInTree: noopUnsubscribe,
      onHelpAction: noopUnsubscribe,
      onImportAll: noopUnsubscribe,
    },
    window: {
      openGraphCore: async () => {
        window.open(`${window.location.origin}${window.location.pathname}?view=graph-core`, '_blank');
      },
      showInTree: async () => undefined,
      onShowInTreeRequest: noopUnsubscribe,
      spawnReady: () => undefined,
      paintReady: () => undefined,
      persistTheme: () => undefined,
    },
    cache: {
      invalidate: (payload: CacheInvalidationOutbound) => {
        const message = {
          originWindowId: -1,
          ...payload,
        } satisfies CacheInvalidationMessage;
        for (const listener of cacheListeners) listener(message);
      },
      onCacheInvalidate: (handler: (msg: CacheInvalidationMessage) => void) => {
        cacheListeners.add(handler);
        return () => cacheListeners.delete(handler);
      },
    },
    diff: createInvoker('diff') as RiaCoreBridge['diff'],
    git: createInvoker('git') as RiaCoreBridge['git'],
    llm: createSection<RiaCoreBridge['llm']>('llm', {
      onStream: (handler: (event: LlmStreamEvent) => void) =>
        subscribeSse('llm.stream', handler),
    }),
  };
}

export function installBrowserRiaCoreBridge(): void {
  if (typeof window === 'undefined') return;
  const isBrowserDev = !!import.meta.env.VITE_RIACORE_WEB_DEV_TOKEN;
  const hasUsableBridge = typeof window.riacore?.workspace?.open === 'function';
  if (window.riacore && hasUsableBridge && !isBrowserDev) return;
  window.riacore = createBrowserBridge();
}
