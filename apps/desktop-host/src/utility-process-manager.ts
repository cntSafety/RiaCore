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
 * Manages the child process lifecycle.
 *
 * Spawns a worker via Node.js `child_process.fork()` so that it runs
 * in a standard Node.js runtime. This avoids the ABI mismatch that
 * causes native DB bindings to segfault under Electron's modified
 * Node.js runtime.
 *
 * Electron's `utilityProcess.fork()` does NOT solve this — it still
 * uses Electron's binary. We need a real `node` process.
 */
import { app, dialog } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getPackagedGitBinaryPath } from './git-binary-path.js';
import type {
  IpcChannelMap,
  WorkerIpcChannel,
  WorkerMessage,
  WorkerRequest,
} from '@riacore/app-contracts';
import type { LoadProgressPushEvent, LlmStreamEvent } from '@riacore/app-contracts';
import { getAppLogger } from './app-logger.js';

/** Tracks an in-flight request awaiting a response from the worker. */
export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  channel: string;
  payload: unknown;
  retries: number;
  timestamp: number;
}

interface QueuedRequest {
  channel: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  retries: number;
}

/**
 * Thin main-process wrapper around the child process.
 */
export class UtilityProcessManager {
  private child: ChildProcess | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private queue: QueuedRequest[] = [];
  private crashCount = 0;
  private readonly maxRetries: number;
  private readonly shutdownTimeout: number;
  /**
   * Maximum milliseconds to wait for the worker "ready" handshake.
   * In production the bundled Node sidecar starts in < 5 s.
   * In dev mode the system node must cold-load a large pnpm symlink tree
   * plus the native DB binary (Windows Defender can add 10–30 s on
   * first access), so we allow a much more generous window.
   */
  private readonly startupTimeout: number;
  private isShuttingDown = false;
  private isRestarting = false;
  private permanentlyFailed = false;
  private readonly logger = getAppLogger();
  private loadProgressListeners: Array<(event: LoadProgressPushEvent) => void> = [];
  private llmStreamListeners: Array<(event: LlmStreamEvent) => void> = [];

  private readonly appVersion: string;

  constructor(opts?: { maxRetries?: number; shutdownTimeout?: number; startupTimeout?: number; appVersion?: string }) {
    this.maxRetries = opts?.maxRetries ?? 3;
    this.shutdownTimeout = opts?.shutdownTimeout ?? 5_000;
    this.appVersion = opts?.appVersion ?? '0.0.0';
    // 60 s covers slow notebooks and first-launch antivirus scans in both dev
    // and production.  The timeout is only reached on a genuine hang — normal
    // starts complete in 1-5 s; a real crash surfaces as "exited during startup"
    // (different code path), not a timeout.
    this.startupTimeout = opts?.startupTimeout ?? 60_000;
  }

  // ---------------------------------------------------------------------------
  // start() — spawn child process and wait for the "ready" handshake
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const workerPath = path.join(__dirname, 'worker.js');
    const execPath = this.resolveNodeExecPath();
    this.logger.info('Spawning worker process', { workerPath, execPath });

    return new Promise<void>((resolve, reject) => {
      // child_process.fork() inside Electron uses Electron's binary by
      // default (process.execPath → electron.exe), which still has the
      // modified ABI. We must explicitly point at the system `node` so
      // the native DB bindings load without segfaulting.
      const child = fork(workerPath, [], {
        execPath,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          ...(getPackagedGitBinaryPath() ? { RIACORE_GIT_BINARY_PATH: getPackagedGitBinaryPath() } : {}),
          RIACORE_APP_VERSION: this.appVersion,
        },
      });
      this.child = child;

      // Pipe child stdout/stderr to main process for debugging
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(`[worker] ${chunk}`);
        this.logger.debug('Worker stdout', { chunk: chunk.toString().trimEnd() });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[worker] ${chunk}`);
        this.logger.warn('Worker stderr', { chunk: chunk.toString().trimEnd() });
      });

      let settled = false;

      const cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
        clearTimeout(timer);
      };

      const onMessage = (data: WorkerMessage) => {
        if (settled) return;
        if (data.type === 'log') {
          this.logWorkerEvent(data);
          return;
        }
        if (data.type === 'ready') {
          settled = true;
          cleanup();
          this.installMessageListener(child);
          this.installExitListener(child);
          this.crashCount = 0;
          this.logger.info('Worker process ready');
          resolve();
        } else if (data.type === 'error') {
          settled = true;
          cleanup();
          this.logger.error('Worker process reported startup error', { error: data.error });
          reject(new Error(data.error));
        }
      };

      const onExit = (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.child = null;
        this.logger.error('Worker process exited during startup', { code });
        reject(new Error(
          `Worker process exited during startup with code ${code}. ` +
          `This usually means a native module failed to load.`
        ));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        this.child = null;
        this.logger.error('Worker process startup timed out', { startupTimeout: this.startupTimeout });
        reject(new Error(
          `Worker process did not become ready within ${this.startupTimeout / 1000} seconds`
        ));
      }, this.startupTimeout);

      child.on('message', onMessage);
      child.on('exit', onExit);
    });
  }

  private resolveNodeExecPath(): string {
    if (!app.isPackaged) {
      return 'node';
    }

    const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
    const candidate = path.join(process.resourcesPath, 'node-sidecar', executableName);

    if (!fs.existsSync(candidate)) {
      throw new Error(
        `Bundled Node sidecar not found at '${candidate}'. ` +
        'Rebuild the desktop package so the platform-specific Node runtime is included.',
      );
    }

    return candidate;
  }

  /**
   * Persistent listener that routes incoming WorkerResponse /
   * WorkerErrorResponse messages to the matching pending promise.
   */
  private installMessageListener(child: ChildProcess): void {
    child.on('message', (data: WorkerMessage) => {
      if (data.type === 'log') {
        this.logWorkerEvent(data);
        return;
      }

      if (data.type === 'loadProgress') {
        for (const listener of this.loadProgressListeners) {
          listener(data.event);
        }
        return;
      }

      if (data.type === 'llmStream') {
        for (const listener of this.llmStreamListeners) {
          listener(data.event);
        }
        return;
      }

      if (data.type !== 'response') return;

      const pending = this.pending.get(data.id);
      if (!pending) return;

      this.pending.delete(data.id);

      if (data.ok) {
        pending.resolve(data.data);
      } else {
        pending.reject(new Error(data.error));
      }
    });
  }

  private logWorkerEvent(data: Extract<WorkerMessage, { type: 'log' }>): void {
    switch (data.level) {
      case 'debug':
        this.logger.debug(`Worker: ${data.message}`, data.context);
        return;
      case 'info':
        this.logger.info(`Worker: ${data.message}`, data.context);
        return;
      case 'warn':
        this.logger.warn(`Worker: ${data.message}`, data.context);
        return;
      case 'fatal':
        this.logger.fatal(`Worker: ${data.message}`, data.context);
        return;
      default:
        this.logger.error(`Worker: ${data.message}`, data.context);
    }
  }

  /**
   * Listens for the child process `exit` event. On unexpected exit
   * (not during shutdown), rejects all pending promises, logs the crash,
   * and either respawns or permanently fails.
   */
  private installExitListener(child: ChildProcess): void {
    child.on('exit', (code: number | null, signal: string | null) => {
      if (this.isShuttingDown) return;

      this.logger.error('Worker process exited unexpectedly', {
        code,
        signal: signal ?? 'none',
      });

      for (const [id, pending] of this.pending) {
        this.pending.delete(id);

        if (this.shouldRetryRequest(pending)) {
          this.queue.push({
            channel: pending.channel,
            payload: pending.payload,
            resolve: pending.resolve,
            reject: pending.reject,
            retries: pending.retries + 1,
          });
          continue;
        }

        pending.reject(this.createCrashError(pending));
      }

      this.child = null;
      this.crashCount++;

      if (this.crashCount <= this.maxRetries) {
        this.isRestarting = true;
        this.logger.warn('Restarting worker process after crash', { crashCount: this.crashCount });
        this.start()
          .then(() => {
            this.isRestarting = false;
            this.logger.info('Worker process restarted successfully');
            this.drainQueue();
          })
          .catch(() => {
            this.isRestarting = false;
            this.permanentlyFailed = true;
            this.logger.fatal('Worker process failed to restart');
            dialog.showErrorBox(
              'Worker Process Error',
              'The background service failed to restart. The application cannot process requests.',
            );
            this.rejectQueue();
          });
      } else {
        this.permanentlyFailed = true;
        this.logger.fatal('Worker process crashed repeatedly and exceeded retry limit', {
          crashCount: this.crashCount,
          maxRetries: this.maxRetries,
        });
        dialog.showErrorBox(
          'Worker Process Error',
          'The background service crashed repeatedly and could not be recovered. Please restart the application.',
        );
        this.rejectQueue();
      }
    });
  }

  private shouldRetryRequest(pending: PendingRequest): boolean {
    return pending.retries < 1 && [
      'workspace.open',
      'workspace.getStatus',
      'db.getStatus',
      'db.probe',
      'db.getStats',
      'imports.listSources',
    ].includes(pending.channel);
  }

  private createCrashError(pending: PendingRequest): Error {
    if (pending.channel === 'workspace.open') {
      const workingDir = typeof pending.payload === 'object' && pending.payload !== null && 'workingDir' in pending.payload
        ? String((pending.payload as { workingDir?: unknown }).workingDir ?? '')
        : '';

      return new Error(
        `Workspace open caused the background worker to restart${workingDir ? ` for '${workingDir}'` : ''}. ` +
        `The workspace DB may be incomplete or corrupted. Try reopening the folder or deleting its local 'db' folder so RiaCore can recreate it.`,
      );
    }

    return new Error('Worker process crashed');
  }

  private dispatchRequest<C extends WorkerIpcChannel>(
    channel: C,
    payload: IpcChannelMap[C]['input'],
    resolve: (value: IpcChannelMap[C]['output']) => void,
    reject: (reason: Error) => void,
    retries = 0,
  ): void {
    if (this.permanentlyFailed) {
      reject(new Error('Worker process is unavailable'));
      return;
    }

    if (this.isRestarting) {
      this.queue.push({
        channel: channel as string,
        payload,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries,
      });
      return;
    }

    if (!this.child) {
      reject(new Error('Worker process is not running'));
      return;
    }

    const id = crypto.randomUUID();

    const message: WorkerRequest = {
      type: 'request',
      id,
      channel,
      payload,
    };

    this.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      channel: channel as string,
      payload,
      retries,
      timestamp: Date.now(),
    });

    try {
      this.child.send(message);
    } catch (err) {
      this.pending.delete(id);
      this.logger.error('Failed to send IPC request to worker', {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private drainQueue(): void {
    const queued = this.queue.splice(0);
    for (const item of queued) {
      this.dispatchRequest(
        item.channel as WorkerIpcChannel,
        item.payload as IpcChannelMap[WorkerIpcChannel]['input'],
        item.resolve as (value: IpcChannelMap[WorkerIpcChannel]['output']) => void,
        item.reject,
        item.retries,
      );
    }
  }

  private rejectQueue(): void {
    const queued = this.queue.splice(0);
    const err = new Error('Worker process is unavailable');
    for (const item of queued) {
      item.reject(err);
    }
  }

  // ---------------------------------------------------------------------------
  // send() — forward a typed request to the child process
  // ---------------------------------------------------------------------------

  async send<C extends WorkerIpcChannel>(
    channel: C,
    payload: IpcChannelMap[C]['input'],
  ): Promise<IpcChannelMap[C]['output']> {
    return new Promise<IpcChannelMap[C]['output']>((resolve, reject) => {
      this.dispatchRequest(channel, payload, resolve, reject, 0);
    });
  }

  // ---------------------------------------------------------------------------
  // onLoadProgress() — subscribe to load progress push events from the worker
  // ---------------------------------------------------------------------------

  onLoadProgress(listener: (event: LoadProgressPushEvent) => void): void {
    this.loadProgressListeners.push(listener);
  }

  // ---------------------------------------------------------------------------
  // onLlmStream() — subscribe to LLM stream push events from the worker
  // ---------------------------------------------------------------------------

  onLlmStream(listener: (event: LlmStreamEvent) => void): void {
    this.llmStreamListeners.push(listener);
  }

  // ---------------------------------------------------------------------------
  // shutdown() — graceful shutdown with kill timeout
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (!this.child) return;

    this.isShuttingDown = true;
    this.logger.info('Sending shutdown signal to worker process');

    const child = this.child;

    child.send({ type: 'shutdown' });

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn('Worker process did not exit within shutdown timeout; forcing kill');
        child.kill();
      }, this.shutdownTimeout);

      child.on('exit', () => {
        clearTimeout(timer);
        this.child = null;
        this.logger.info('Worker process exited during shutdown');
        resolve();
      });
    });
  }
}
