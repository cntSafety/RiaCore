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
  /**
   * Consecutive crashes in the current crash loop. Reset only after the worker
   * has stayed up for `stableUptime` (see `stableResetTimer`), never on the
   * mere fact of a successful respawn — a crash loop *is* a sequence of
   * successful respawns, so resetting on `ready` would keep this pinned at 1
   * and make the `maxRetries` cap below unreachable.
   */
  private crashCount = 0;
  /**
   * Pending "the worker has been healthy long enough, forget the crash streak"
   * timer. Cleared whenever the worker exits, so a crash that lands inside the
   * window counts towards the streak.
   */
  private stableResetTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxRetries: number;
  private readonly stableUptime: number;
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
  private shutdownPromise: Promise<void> | null = null;
  private isRestarting = false;
  private permanentlyFailed = false;
  /** A worker replacement for a graph engine switch, while it runs. */
  private plannedRestart: Promise<void> | null = null;
  /** Workers stopped on purpose: their exit is not a crash. */
  private readonly plannedExits = new WeakSet<ChildProcess>();
  /** Waiting for the requests in flight to finish (whenIdle). */
  private idleWaiters: Array<() => void> = [];
  /** How long requests in flight may still take before a planned restart. */
  private readonly engineSwitchDrainTimeout: number;
  private readonly logger = getAppLogger();
  private loadProgressListeners: Array<(event: LoadProgressPushEvent) => void> = [];
  private llmStreamListeners: Array<(event: LlmStreamEvent) => void> = [];

  private readonly appVersion: string;

  constructor(opts?: { maxRetries?: number; shutdownTimeout?: number; startupTimeout?: number; stableUptime?: number; appVersion?: string; engineSwitchDrainTimeout?: number }) {
    this.maxRetries = opts?.maxRetries ?? 3;
    this.engineSwitchDrainTimeout = opts?.engineSwitchDrainTimeout ?? 30_000;
    // How long the worker must stay up before its crash streak is forgiven.
    // Long enough that a tight crash loop (respawn takes ~1-2 s) accumulates
    // towards maxRetries, short enough that two unrelated crashes an hour apart
    // are not treated as a loop.
    this.stableUptime = opts?.stableUptime ?? 60_000;
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
    if (this.isShuttingDown) throw new Error('Worker is shutting down');
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
          // Set before the child's eager imports resolve profiles/importer assets.
          RIACORE_APP_ROOT: app.isPackaged ? path.resolve(__dirname, '..') : undefined,
          ...(getPackagedGitBinaryPath() ? { RIACORE_GIT_BINARY_PATH: getPackagedGitBinaryPath() } : {}),
          ...(this.packagedRiaGraphModule() ? { RIACORE_RIAGRAPH_MODULE: this.packagedRiaGraphModule()! } : {}),
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
        child.off('error', onError);
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
          this.armStableReset();
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

      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // Keep the child tracked: the caller's failure cleanup must still be
        // able to stop it if initialization hung or a termination failed.
        try { child.kill('SIGKILL'); }
        catch (error) { this.logger.warn('Could not terminate the timed-out worker', { error: String(error) }); }
        this.logger.error('Worker process startup timed out', { startupTimeout: this.startupTimeout });
        reject(new Error(
          `Worker process did not become ready within ${this.startupTimeout / 1000} seconds`
        ));
      }, this.startupTimeout);

      child.on('message', onMessage);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  /**
   * Start the clock on forgiving the current crash streak. Survive
   * `stableUptime` and the worker is considered recovered rather than looping.
   *
   * `unref()` so a pending forgiveness timer never holds the process alive.
   */
  private armStableReset(): void {
    this.clearStableReset();
    const timer = setTimeout(() => {
      if (this.crashCount > 0) {
        this.logger.info('Worker process stable; clearing crash streak', {
          clearedCrashCount: this.crashCount,
          stableUptime: this.stableUptime,
        });
      }
      this.crashCount = 0;
      this.stableResetTimer = null;
    }, this.stableUptime);
    timer.unref?.();
    this.stableResetTimer = timer;
  }

  private clearStableReset(): void {
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer);
      this.stableResetTimer = null;
    }
  }

  /**
   * The RiaGraph binding a package ships (resources/vendor/riagraph-core/<platform>),
   * for the worker to use whenever a workspace selects RiaGraph. A
   * RIACORE_RIAGRAPH_MODULE the user set is left as it is.
   */
  private packagedRiaGraphModule(): string | null {
    if (!app.isPackaged || process.env.RIACORE_RIAGRAPH_MODULE) return null;
    const dir = path.join(process.resourcesPath, 'vendor', 'riagraph-core', `${process.platform}-${process.arch}`);
    return fs.existsSync(path.join(dir, 'index.js')) ? dir : null;
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
      } else if (data.restartWorker && pending.retries < 1) {
        // The request changed nothing and needs a fresh worker (a workspace on
        // the other graph engine): repeat it once the worker is replaced.
        this.queue.push({
          channel: pending.channel,
          payload: pending.payload,
          resolve: pending.resolve,
          reject: pending.reject,
          retries: pending.retries + 1,
        });
        this.restartForEngineSwitch(child, data.error);
      } else {
        pending.reject(new Error(data.error));
      }
      if (this.pending.size === 0) this.notifyIdle();
    });
  }

  private notifyIdle(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** Resolves once no request is in flight, or after `timeoutMs`. */
  private whenIdle(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Replace the worker on purpose: a workspace runs on the other native graph
   * engine than the one the worker has loaded, and ladybug and RiaGraph never
   * share a process. New requests queue meanwhile; requests in flight get
   * `engineSwitchDrainTimeout` to finish; the worker then shuts down as it
   * does when the app quits (Auto-Save flushed, workspace closed), and the
   * queue — the request that asked for this first — goes to its successor.
   * Not a crash: the crash streak is untouched.
   */
  private restartForEngineSwitch(child: ChildProcess, reason: string): void {
    if (this.isShuttingDown || this.plannedRestart || this.child !== child) return;
    this.isRestarting = true;
    this.plannedExits.add(child);
    this.logger.info('Restarting the worker process to switch the graph engine', { reason });
    this.plannedRestart = (async () => {
      await this.whenIdle(this.engineSwitchDrainTimeout);
      await this.terminateChild(child);
      this.clearStableReset();
      if (this.child === child) this.child = null;
      // Whatever did not finish in time went down with the old worker.
      this.settlePendingAfterExit('engine-switch');
      if (this.isShuttingDown) return;
      await this.start();
      if (this.isShuttingDown) {
        if (this.child) await this.terminateChild(this.child);
        return;
      }
      this.isRestarting = false;
      this.logger.info('Worker process restarted for the graph engine switch');
      this.drainQueue();
    })()
      .catch((error: unknown) => {
        this.isRestarting = false;
        if (this.isShuttingDown) return;
        this.permanentlyFailed = true;
        this.logger.fatal('Worker process failed to restart for a graph engine switch', {
          error: error instanceof Error ? error.message : String(error),
        });
        dialog.showErrorBox(
          'Worker Process Error',
          'The background service failed to restart. The application cannot process requests.',
        );
        this.rejectQueue();
      })
      .finally(() => {
        this.plannedRestart = null;
      });
  }

  /**
   * After the worker went away with requests outstanding: queue the ones that
   * may be repeated for the next worker, reject the rest.
   */
  private settlePendingAfterExit(cause: 'crash' | 'engine-switch'): void {
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

      pending.reject(cause === 'crash'
        ? this.createCrashError(pending)
        : new Error('The background worker was restarted to switch the graph engine before this request finished'));
    }
    this.notifyIdle();
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
      // Whatever uptime this instance accumulated no longer counts — it just
      // died. Cancelling here is what makes crashes inside the stability window
      // accumulate into a streak.
      this.clearStableReset();

      // Shutting down, or replaced on purpose (restartForEngineSwitch).
      if (this.isShuttingDown || this.plannedExits.has(child)) return;

      this.logger.error('Worker process exited unexpectedly', {
        code,
        signal: signal ?? 'none',
      });

      this.settlePendingAfterExit('crash');

      this.child = null;
      this.crashCount++;

      if (this.crashCount <= this.maxRetries) {
        this.isRestarting = true;
        this.logger.warn('Restarting worker process after crash', {
          crashCount: this.crashCount,
          maxRetries: this.maxRetries,
        });
        this.start()
          .then(() => {
            this.isRestarting = false;
            this.logger.info('Worker process restarted successfully');
            this.drainQueue();
          })
          .catch(() => {
            this.isRestarting = false;
            if (this.isShuttingDown) return;
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
    if (this.isShuttingDown) {
      reject(new Error('Worker is shutting down'));
      return;
    }
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

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShuttingDown = true;
    this.clearStableReset();
    for (const pending of this.pending.values()) pending.reject(new Error('Worker is shutting down'));
    this.pending.clear();
    this.rejectQueue();
    // Between the two workers of a planned restart: it stops the new one itself.
    if (!this.child) return this.plannedRestart ?? Promise.resolve();

    const child = this.child;
    this.logger.info('Sending shutdown signal to worker process');
    this.shutdownPromise = this.terminateChild(child).then(() => {
      if (this.child === child) this.child = null;
      this.logger.info('Worker process exited during shutdown');
    });
    return this.shutdownPromise;
  }

  /**
   * Ask `child` to shut down (it flushes Auto-Save and closes the workspace),
   * kill it if it does not exit within `shutdownTimeout`, and fail if even
   * that never produces an exit.
   */
  private terminateChild(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let killing = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const forceKill = () => {
        if (settled || killing) return;
        killing = true;
        clearTimeout(timer);
        this.logger.warn('Worker did not shut down gracefully; forcing termination');
        // Bound the wait even when kill fails or the OS never emits exit.
        killTimer = setTimeout(() => finish(new Error('Unable to stop the background worker')), 1000);
        try {
          child.kill('SIGKILL');
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      // Subscribe before sending: a fast exit (or a synchronous IPC error)
      // must not leave the promise waiting for an event that already happened.
      child.on('exit', onExit);
      if (child.exitCode != null || child.signalCode != null) {
        finish();
        return;
      }
      timer = setTimeout(forceKill, this.shutdownTimeout);
      if (child.connected === false) {
        forceKill();
        return;
      }
      try {
        child.send({ type: 'shutdown' }, (error: Error | null) => {
          if (error) forceKill();
        });
      } catch {
        forceKill();
      }
    });
  }
}
