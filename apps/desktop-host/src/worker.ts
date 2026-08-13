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
 * Child process worker entry point.
 *
 * Spawned via Node.js `child_process.fork()` from the Electron main process.
 * Runs in a standard Node.js runtime so that the native DB bindings load
 * without ABI conflicts (Electron's modified ABI causes segfaults).
 */
import * as path from 'node:path';
import { createDbModule, createWorkspaceService, createPersistorService, createImporterOrchestrationService, createImporterRegistry, createProvisioningService, createProfileRegistry, createNamespaceService, createInstanceService, createSafetyCommands, createConnectionService, createImportLogger, createCommandDispatcher, createLoadGate } from '@riacore/app-core';
import type { IDbModule, IWorkspaceService, IImporterOrchestrationService, IImporterRegistry, IProvisioningService, IProfileRegistry, INamespaceService, IInstanceService, ISafetyCommands, ICommandDispatcher, ServiceDependencies, LoadGate } from '@riacore/app-core';
import { createGitService } from '@riacore/git-service';
import type { IGitService } from '@riacore/git-service';
import type {
  IpcChannelMap,
  MainMessage,
  WorkerMessage,
  WorkerResponse,
  WorkerErrorResponse,
  WorkerLog,
  WorkerLoadProgress,
  WorkerLlmStream,
  LlmStreamEvent,
} from '@riacore/app-contracts';
import type { LoadProgressPushEvent } from '@riacore/app-contracts';

let dbModule: IDbModule;
let workspaceService: IWorkspaceService;
let orchestration: IImporterOrchestrationService;
let registry: IImporterRegistry;
let provisioningService: IProvisioningService;
let profileRegistry: IProfileRegistry;
let namespaceService: INamespaceService;
let instanceService: IInstanceService;
let safetyCommands: ISafetyCommands;
let gitService: IGitService;
let dispatcher: ICommandDispatcher;
let deps: ServiceDependencies;
let gate: LoadGate;

function sendLog(level: WorkerLog['level'], message: string, context?: Record<string, unknown>): void {
  const logMessage: WorkerLog = { type: 'log', level, message, context };
  process.send?.(logMessage);
}

async function initialize(): Promise<void> {
  const logger = {
    debug: (message: string, context?: Record<string, unknown>) => sendLog('debug', message, context),
    info: (message: string, context?: Record<string, unknown>) => sendLog('info', message, context),
    warn: (message: string, context?: Record<string, unknown>) => sendLog('warn', message, context),
    error: (message: string, context?: Record<string, unknown>) => sendLog('error', message, context),
    close: () => { /* app-level logger — no file stream to close */ },
  };

  sendLog('info', 'Worker initialization started', { pid: process.pid });
  dbModule = createDbModule(logger);
  workspaceService = createWorkspaceService(
    dbModule,
    (workingDir) => createPersistorService(dbModule, createImportLogger(path.join(workingDir, 'logs'))),
    (event: LoadProgressPushEvent) => {
      const msg: WorkerLoadProgress = { type: 'loadProgress', event };
      process.send?.(msg);
    },
    logger,
  );
  orchestration = createImporterOrchestrationService(dbModule);
  registry = createImporterRegistry();
  provisioningService = createProvisioningService(registry, dbModule);
  profileRegistry = createProfileRegistry();
  namespaceService = createNamespaceService(profileRegistry, dbModule, logger);
  instanceService = createInstanceService(dbModule);
  safetyCommands = createSafetyCommands(instanceService, dbModule);
  gitService = createGitService();
  sendLog('info', 'Worker initialization completed', { pid: process.pid });

  // Construct unified ServiceDependencies for the CommandDispatcher
  const connectionService = createConnectionService(dbModule, logger);
  deps = {
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
    createLogger: (workingDir: string) => createImportLogger(path.join(workingDir, 'logs')),
    llmStreamSink: {
      send(_channel: string, payload: unknown): void {
        const msg: WorkerLlmStream = { type: 'llmStream', event: payload as LlmStreamEvent };
        process.send?.(msg);
      },
      isDestroyed(): boolean {
        // The worker process is never "destroyed" while running; the main
        // process handles window lifecycle.
        return false;
      },
    },
  };

  // Create the consolidated CommandDispatcher
  dispatcher = createCommandDispatcher();

  // Route all requests through the shared load gate, which defers non-exempt
  // channels while a ria-data load is in flight (Requirements 6.1, 6.6, 6.7).
  gate = createLoadGate(dispatcher, workspaceService);
}

function send(msg: WorkerMessage): void {
  process.send!(msg);
}

// Requests are routed through the shared load gate (see initialize()). The gate
// runs read-only exempt channels immediately, defers non-exempt channels on
// `whenLoadSettled()` while a ria-data load is in flight, drains them FIFO, and
// swallows DbGenerationChangedError as `{ superseded: true }`.
function handleMessage(data: MainMessage): void {
  if (data.type === 'shutdown') {
    sendLog('info', 'Worker shutdown requested');
    workspaceService.close().then(() => {
      sendLog('info', 'Worker shutdown completed');
      process.exit(0);
    });
    return;
  }

  if (data.type === 'request') {
    const { id, channel, payload } = data;
    gate.dispatch(channel as keyof IpcChannelMap, payload as never, deps)
      .then((result) => {
        const response: WorkerResponse = { type: 'response', id, ok: true, data: result };
        send(response);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        const response: WorkerErrorResponse = { type: 'response', id, ok: false, error: message };
        send(response);
      });
  }
}

async function main(): Promise<void> {
  try {
    await initialize();

    process.on('message', handleMessage);

    sendLog('info', 'Worker ready message sent');
    send({ type: 'ready' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog('fatal', 'Worker initialization failed', {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    send({ type: 'error', error: message });
    process.exit(1);
  }
}

main();
