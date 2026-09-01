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
 * Browser-accessible development transport for RiaCore.
 *
 * This file is deliberately not used by the packaged Electron app. It starts
 * only when RIACORE_WEB_DEV=1 is set by the dev launcher, binds to loopback,
 * and requires a per-run bearer token for every API/SSE request.
 */
import * as http from 'node:http';
import * as path from 'node:path';
import { URL } from 'node:url';
import {
  createCommandDispatcher,
  createConnectionService,
  createDbModule,
  createImportLogger,
  createImporterOrchestrationService,
  createImporterRegistry,
  createInstanceService,
  createLoadGate,
  createMappingRegistry,
  createNamespaceService,
  createPersistorService,
  createProfileRegistry,
  createProvisioningService,
  createSafetyCommands,
  createViewService,
  createWorkspaceService,
  registerBuiltInMappings,
} from '@riacore/app-core';
import type { IpcChannelMap, LlmStreamEvent, LoadProgressPushEvent, RendererLogEntry } from '@riacore/app-contracts';
import type { ServiceDependencies } from '@riacore/app-core';
import { createGitService } from '@riacore/git-service';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

interface ApiRequest {
  channel?: unknown;
  payload?: unknown;
}

interface EventClient {
  id: number;
  res: http.ServerResponse;
}

function requireDevMode(): void {
  if (process.env.RIACORE_WEB_DEV !== '1') {
    throw new Error('Refusing to start web dev server without RIACORE_WEB_DEV=1');
  }
  if (!process.env.RIACORE_WEB_DEV_TOKEN || process.env.RIACORE_WEB_DEV_TOKEN.length < 24) {
    throw new Error('Refusing to start web dev server without a strong RIACORE_WEB_DEV_TOKEN');
  }
}

function getConfig() {
  const host = process.env.RIACORE_WEB_DEV_HOST ?? '127.0.0.1';
  const port = Number(process.env.RIACORE_WEB_DEV_PORT ?? '5184');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to bind web dev server to non-loopback host '${host}'`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid RIACORE_WEB_DEV_PORT '${process.env.RIACORE_WEB_DEV_PORT}'`);
  }
  const origins = (process.env.RIACORE_WEB_DEV_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5183,http://localhost:5183')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    host,
    port,
    token: process.env.RIACORE_WEB_DEV_TOKEN as string,
    allowedOrigins: new Set(origins),
  };
}

function createRuntime(eventSink: (type: string, payload: unknown) => void) {
  const logger = {
    debug: (message: string, context?: Record<string, unknown>) => console.debug(`[web-dev] ${message}`, context ?? ''),
    info: (message: string, context?: Record<string, unknown>) => console.info(`[web-dev] ${message}`, context ?? ''),
    warn: (message: string, context?: Record<string, unknown>) => console.warn(`[web-dev] ${message}`, context ?? ''),
    error: (message: string, context?: Record<string, unknown>) => console.error(`[web-dev] ${message}`, context ?? ''),
    close: () => { /* app-level logger — no file stream to close */ },
  };

  const dbModule = createDbModule(logger);
  const workspaceService = createWorkspaceService(
    dbModule,
    (workingDir) => createPersistorService(dbModule, createImportLogger(path.join(workingDir, 'logs'))),
    (event: LoadProgressPushEvent) => eventSink('persistor.loadProgress', event),
    logger,
  );
  const orchestration = createImporterOrchestrationService(dbModule);
  const registry = createImporterRegistry();
  const provisioningService = createProvisioningService(registry, dbModule);
  const profileRegistry = createProfileRegistry();
  const namespaceService = createNamespaceService(profileRegistry, dbModule, logger);
  const instanceService = createInstanceService(dbModule);
  const safetyCommands = createSafetyCommands(instanceService, dbModule);
  const connectionService = createConnectionService(dbModule, logger);
  const gitService = createGitService();
  const mappingRegistry = createMappingRegistry();
  registerBuiltInMappings(mappingRegistry);
  const viewService = createViewService(mappingRegistry, dbModule, logger);
  const dispatcher = createCommandDispatcher();

  const deps: ServiceDependencies = {
    dbModule,
    workspaceService,
    orchestration,
    registry,
    provisioningService,
    profileRegistry,
    namespaceService,
    connectionService,
    instanceService,
    safetyCommands,
    persistorService: undefined,
    gitService,
    mappingRegistry,
    viewService,
    createLogger: (workingDir: string) => createImportLogger(path.join(workingDir, 'logs')),
    llmStreamSink: {
      send(_channel: string, payload: unknown): void {
        eventSink('llm.stream', payload as LlmStreamEvent);
      },
      isDestroyed(): boolean {
        return false;
      },
    },
  };

  return { dispatcher, deps, workspaceService };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    ...(origin ? {
      'access-control-allow-origin': origin,
      'vary': 'Origin',
    } : {}),
  });
  res.end(encoded);
}

function sendError(res: http.ServerResponse, status: number, message: string, origin?: string): void {
  sendJson(res, status, { ok: false, error: message }, origin);
}

function readJsonBody(req: http.IncomingMessage): Promise<ApiRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) as ApiRequest : {});
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req: http.IncomingMessage, token: string, url: URL): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  if (req.headers['x-riacore-dev-token'] === token) return true;
  return url.searchParams.get('token') === token;
}

function corsOrigin(req: http.IncomingMessage, allowedOrigins: Set<string>): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.has(origin)) {
    return origin;
  }
  return undefined;
}

async function main(): Promise<void> {
  requireDevMode();
  const config = getConfig();
  const eventClients = new Map<number, EventClient>();
  let nextClientId = 1;

  const emitEvent = (type: string, payload: unknown) => {
    const data = JSON.stringify(payload);
    for (const client of eventClients.values()) {
      client.res.write(`event: ${type}\n`);
      client.res.write(`data: ${data}\n\n`);
    }
  };

  const runtime = createRuntime(emitEvent);
  const gate = createLoadGate(runtime.dispatcher, runtime.workspaceService);
  const allowedChannels = new Set(runtime.dispatcher.listChannels());

  const pseudoHandlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>([
    ['app.getConfig', () => ({ debug: true })],
    ['app.logRendererEvent', (payload) => {
      const entry = payload as RendererLogEntry;
      console[entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info'](
        `[renderer:${entry.type}] ${entry.message}`,
        entry.context ?? '',
      );
    }],
    ['app.openLogsDirectory', () => process.cwd()],
    ['workspace.openLogsDirectory', (payload) => {
      const workingDir = typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload !== null && 'workingDir' in payload
          ? String((payload as { workingDir?: unknown }).workingDir ?? '')
          : '';
      return workingDir ? path.join(workingDir, 'logs') : '';
    }],
  ]);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
    const origin = corsOrigin(req, config.allowedOrigins);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(origin ? {
          'access-control-allow-origin': origin,
          'vary': 'Origin',
        } : {}),
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-riacore-dev-token',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    if (!isAuthorized(req, config.token, reqUrl)) {
      sendError(res, 401, 'Unauthorized web dev request', origin);
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/events') {
      if (!origin) {
        sendError(res, 403, 'Origin is not allowed', origin);
        return;
      }
      const id = nextClientId++;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': origin,
        vary: 'Origin',
      });
      res.write(': connected\n\n');
      eventClients.set(id, { id, res });
      req.on('close', () => eventClients.delete(id));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/invoke') {
      if (!origin) {
        sendError(res, 403, 'Origin is not allowed', origin);
        return;
      }

      try {
        const body = await readJsonBody(req);
        if (typeof body.channel !== 'string') {
          sendError(res, 400, 'Missing channel', origin);
          return;
        }

        if (pseudoHandlers.has(body.channel)) {
          const data = await pseudoHandlers.get(body.channel)!(body.payload);
          sendJson(res, 200, { ok: true, data }, origin);
          return;
        }

        if (!allowedChannels.has(body.channel)) {
          sendError(res, 404, `Channel is not available in browser dev mode: ${body.channel}`, origin);
          return;
        }

        const data = await gate.dispatch(
          body.channel as keyof IpcChannelMap,
          body.payload as IpcChannelMap[keyof IpcChannelMap]['input'],
          runtime.deps,
        );
        sendJson(res, 200, { ok: true, data }, origin);
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : String(error), origin);
      }
      return;
    }

    sendError(res, 404, 'Not found', origin);
  });

  const shutdown = async () => {
    console.info('[web-dev] Shutting down');
    server.close();
    for (const client of eventClients.values()) {
      client.res.end();
    }
    await runtime.workspaceService.close().catch((error) => {
      console.warn('[web-dev] Workspace close failed', error);
    });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  server.listen(config.port, config.host, () => {
    console.info(`[web-dev] RiaCore browser dev backend listening on http://${config.host}:${config.port}`);
    console.info(`[web-dev] Allowed origins: ${Array.from(config.allowedOrigins).join(', ')}`);
  });
}

main().catch((error) => {
  console.error('[web-dev] Failed to start', error);
  process.exit(1);
});
