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
import { existsSync } from 'node:fs';
import { createDbModule, createWorkspaceService, createPersistorService, createImporterOrchestrationService, createImporterRegistry, createProvisioningService, createProfileRegistry, createNamespaceService, createInstanceService, createSafetyCommands, createConnectionService, createCommandDispatcher, createLoadGate, createMappingRegistry, registerBuiltInMappings, createViewService, createFileLoggerFactory, createAutoSaveCoordinator } from '@riacore/app-core';
import type { IDbModule, IWorkspaceService, IImporterOrchestrationService, IImporterRegistry, IProvisioningService, IProfileRegistry, INamespaceService, IInstanceService, ISafetyCommands, ICommandDispatcher, ServiceDependencies, LoadGate, IMappingRegistry, IViewService, IAutoSaveCoordinator } from '@riacore/app-core';
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
let mappingRegistry: IMappingRegistry;
let viewService: IViewService;
let dispatcher: ICommandDispatcher;
let deps: ServiceDependencies;
let gate: LoadGate;
let autoSave: IAutoSaveCoordinator;

function sendLog(level: WorkerLog['level'], message: string, context?: Record<string, unknown>): void {
  const logMessage: WorkerLog = { type: 'log', level, message, context };
  send(logMessage);
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
  // Default sink: the worker's stdout/stderr are piped to the main process and
  // surfaced in its log, so console output is wanted here.
  const loggers = createFileLoggerFactory();
  workspaceService = createWorkspaceService(
    dbModule,
    (workingDir) => createPersistorService(dbModule, loggers.workspace(workingDir)),
    (event: LoadProgressPushEvent) => {
      const msg: WorkerLoadProgress = { type: 'loadProgress', event };
      send(msg);
    },
    logger,
  );
  orchestration = createImporterOrchestrationService(dbModule, loggers);
  registry = createImporterRegistry();
  provisioningService = createProvisioningService(registry, dbModule);
  profileRegistry = createProfileRegistry();
  namespaceService = createNamespaceService(profileRegistry, dbModule, logger);
  instanceService = createInstanceService(dbModule);
  safetyCommands = createSafetyCommands(instanceService, dbModule);
  gitService = createGitService();
  mappingRegistry = createMappingRegistry();
  registerBuiltInMappings(mappingRegistry);
  viewService = createViewService(mappingRegistry, dbModule, logger);
  // Auto_Save: the dispatcher marks persisted content dirty after any channel
  // that declares `mutates`, and this coordinator does the coalesced store. It
  // replaces the per-call-site renderer trigger, so a mutation from any window —
  // or from a path that forgot to pass triggerAutoSave — still reaches ria-data/.
  autoSave = createAutoSaveCoordinator({
    dbModule,
    workspaceService,
    persistorFactory: (workingDir) => createPersistorService(dbModule, loggers.workspace(workingDir)),
    logger,
  });
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
    mappingRegistry,
    viewService,
    autoSave,
    loggers,
    llmStreamSink: {
      send(_channel: string, payload: unknown): void {
        const msg: WorkerLlmStream = { type: 'llmStream', event: payload as LlmStreamEvent };
        send(msg);
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
  // The parent can disappear during a crash or installer cleanup. A callback
  // consumes an IPC close race instead of raising another uncaught exception.
  if (process.connected) process.send?.(msg, () => {});
}

let shutdownPending = false;
function shutdownWorker(): void {
  if (shutdownPending) return;
  shutdownPending = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  void (async () => {
    try {
      await autoSave?.flush();
    } catch (err) {
      sendLog('warn', 'Auto-save flush on shutdown failed', { error: String(err) });
    }
    try {
      await workspaceService?.close();
    } catch (err) {
      sendLog('warn', 'Workspace close on shutdown failed', { error: String(err) });
    } finally {
      clearTimeout(deadline);
      sendLog('info', 'Worker shutdown completed');
      process.exit(0);
    }
  })();
}

// Requests are routed through the shared load gate (see initialize()). The gate
// runs read-only exempt channels immediately, defers non-exempt channels on
// `whenLoadSettled()` while a ria-data load is in flight, drains them FIFO, and
// swallows DbGenerationChangedError as `{ superseded: true }`.
function handleMessage(data: MainMessage): void {
  if (data.type === 'shutdown') {
    sendLog('info', 'Worker shutdown requested');
    // Flush any debounced Auto_Save before releasing the DB handle, otherwise a
    // mutation made within the debounce window of shutdown is lost. Never
    // rejects — a failed flush must not block shutdown.
    shutdownWorker();
    return;
  }

  if (data.type === 'request') {
    const { id, channel, payload } = data;
    gate.dispatch(channel as keyof IpcChannelMap, payload as never, deps)
      .then((result) => {
        const response: WorkerResponse = { type: 'response', id, ok: true, data: result };
        send(response);
      })
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const errorContext = {
          channel,
          error: message,
          errorType: err instanceof Error ? err.name : typeof err,
          stack: err instanceof Error ? err.stack : undefined,
        };
        sendLog('error', 'Worker request failed', errorContext);

        // Mirror request failures into the active workspace log. Many commands
        // (notably safety mutations) do not carry workingDir in their payload,
        // so fall back to the workspace service's current status.
        try {
          const payloadWorkingDir = payload && typeof payload === 'object'
            && typeof (payload as { workingDir?: unknown }).workingDir === 'string'
            ? (payload as { workingDir: string }).workingDir
            : undefined;
          const status = payloadWorkingDir ? null : await workspaceService.getStatus();
          const workingDir = payloadWorkingDir
            ?? (status?.state === 'open' ? status.info.workingDir : undefined);

          if (workingDir && existsSync(workingDir)) {
            const workspaceLogger = deps.loggers.workspace(workingDir);
            try {
              workspaceLogger.error('Request failed', errorContext);
            } finally {
              workspaceLogger.close();
            }
          }
        } catch (loggingError) {
          sendLog('warn', 'Failed to mirror request error to workspace log', {
            channel,
            error: loggingError instanceof Error ? loggingError.message : String(loggingError),
          });
        }

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

// A crashed or force-closed Electron parent cannot send a shutdown message.
// Release database/native handles rather than keeping an orphan node.exe alive.
process.once('disconnect', shutdownWorker);
void main();
