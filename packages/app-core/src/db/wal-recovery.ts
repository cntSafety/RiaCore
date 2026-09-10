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
 * Crash-safe probing of a database whose write-ahead log was left behind by an
 * unclean shutdown.
 *
 * ## Why this exists
 *
 * When the worker process is killed without a graceful `dbModule.close()` (dev
 * restart, task kill, power loss), the engine leaves a non-empty `<db>.wal`
 * next to the database file. The next `open()` replays it. Replay has three
 * possible outcomes, and only two of them are survivable in-process:
 *
 *  1. **Clean replay.** The WAL is applied, the data lands in the database.
 *     This is the common case and must not be sacrificed — the WAL holds
 *     committed work that is in no other place.
 *  2. **Throwable rejection.** The native layer raises a JS error, e.g.
 *     `Storage exception: Checksum verification failed, the WAL file is
 *     corrupted.` or `Runtime exception: Corrupted wal file. Read out invalid
 *     WAL record type.`. `dbModule.open()` catches it and reports
 *     `state: 'error'`, and the workspace lifecycle rebuilds from `ria-data`.
 *  3. **Process abort.** The native layer calls `abort()` / `__fastfail`
 *     instead of raising, killing the process outright (on Windows this
 *     surfaces as exit code `0xC0000409`). No `try`/`catch` can intercept it:
 *     the worker dies mid-open, every in-flight IPC request is lost, and the
 *     workspace is permanently unopenable even though the database file itself
 *     is intact and `ria-data/` holds a complete snapshot.
 *
 * Outcome 3 is what this module exists to contain. Because it cannot be caught,
 * the only way to survive it is to not be the process that triggers it: the
 * replay is attempted first in a short-lived child process. If the child dies,
 * the caller learns that the WAL is unreplayable *and is still alive* to act on
 * it — for the workspace lifecycle, that means rebuilding from `ria-data`.
 *
 * ## Cost
 *
 * Probing only runs when a non-empty WAL is actually present, which by
 * definition means the previous session did not shut down cleanly. A workspace
 * that was closed properly has no WAL and pays nothing.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WAL_PROBE_ERROR_PREFIX } from './wal-probe-protocol.js';

/** Hard cap on the probe child. A replay that hangs is as unusable as one that aborts. */
const PROBE_TIMEOUT_MS = 60_000;

export type WalProbeResult =
  /** The child opened the database and ran a query. Replay is safe in-process. */
  | { outcome: 'ok' }
  /**
   * The child reached the native layer and it raised a catchable error.
   * Opening in-process will fail the same way, but survivably — the caller can
   * let `dbModule.open()` report it as `state: 'error'`.
   */
  | { outcome: 'error'; message: string }
  /**
   * The child died without raising. Opening in-process would kill the caller.
   * The WAL must be discarded rather than replayed.
   */
  | { outcome: 'fatal'; code: number | null; signal: NodeJS.Signals | null }
  /** The probe could not be run at all. The caller has learned nothing. */
  | { outcome: 'unavailable'; reason: string };

/** Path of the write-ahead log belonging to `dbPath`. */
export function walPathFor(dbPath: string): string {
  return `${dbPath}.wal`;
}

/**
 * True when `dbPath` has a write-ahead log with bytes in it, i.e. the previous
 * session ended without checkpointing. An empty or absent WAL means there is
 * nothing to replay and nothing to probe.
 */
export function hasPendingWal(dbPath: string): boolean {
  try {
    const stat = fs.statSync(walPathFor(dbPath));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Locate the compiled probe child script.
 *
 * `__dirname` is `dist/db/` in the compiled output, where the child sits next
 * to this module. Under vitest `__dirname` is `src/db/` and no compiled child
 * exists, so this returns `null` and probing reports `unavailable` — tests that
 * exercise probe outcomes inject a stub instead.
 */
function resolveProbeChildScript(): string | null {
  const override = process.env.RIACORE_WAL_PROBE_SCRIPT;
  if (override && fs.existsSync(override)) return override;

  const candidate = path.join(__dirname, 'wal-probe-child.js');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Attempt to open `dbPath` — replaying its WAL — inside a throwaway child
 * process, and report how that went without ever risking the current process.
 *
 * Never rejects. Every failure mode is expressed as a `WalProbeResult` so the
 * caller can branch on it directly.
 */
export async function probeDbOpen(dbPath: string): Promise<WalProbeResult> {
  const script = resolveProbeChildScript();
  if (!script) {
    return { outcome: 'unavailable', reason: 'WAL probe child script not found next to the compiled db module' };
  }

  return new Promise<WalProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: WalProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // `process.execPath` is the Node runtime already hosting the worker, so the
    // child has the same ABI and resolves the same native binding.
    const child = spawn(process.execPath, [script, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      settle({ outcome: 'fatal', code: null, signal: null });
    }, PROBE_TIMEOUT_MS);

    child.on('error', (err) => {
      settle({ outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) });
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        settle({ outcome: 'ok' });
        return;
      }

      // Exit code 1 is the child's own "the native layer raised, and I caught
      // it" path. Anything else — an abort code, a signal, a null code — means
      // the child did not get to run its error handler.
      const marker = `${stdout}\n${stderr}`.split('\n').find((line) => line.startsWith(WAL_PROBE_ERROR_PREFIX));
      if (code === 1 && marker) {
        settle({ outcome: 'error', message: marker.slice(WAL_PROBE_ERROR_PREFIX.length).trim() });
        return;
      }

      settle({ outcome: 'fatal', code, signal });
    });
  });
}

/**
 * Decide, without ever risking the calling process, whether `dbPath` can be
 * opened in-process.
 *
 * Returns `null` when the caller should just go ahead and open — either there is
 * no WAL to replay, or the probe established that replaying it is survivable.
 * Returns a `fatal` result when opening in-process would abort the caller, which
 * is the caller's cue to discard the WAL and rebuild from another source.
 *
 * `error` and `unavailable` both fall through to "go ahead": an error will be
 * reported survivably by `dbModule.open()`, and an unavailable probe leaves the
 * caller no better informed than before, so it should behave as it always did.
 */
export async function detectUnreplayableWal(
  dbPath: string,
  logger?: { info?: (m: string, c?: Record<string, unknown>) => void; warn?: (m: string, c?: Record<string, unknown>) => void },
): Promise<Extract<WalProbeResult, { outcome: 'fatal' }> | null> {
  if (!hasPendingWal(dbPath)) return null;

  logger?.info?.('Pending write-ahead log found — probing replay in a child process before opening in-process', {
    dbPath,
    walPath: walPathFor(dbPath),
  });

  const probe = await probeDbOpen(dbPath);

  switch (probe.outcome) {
    case 'ok':
      logger?.info?.('WAL replay probe succeeded; opening in-process', { dbPath });
      return null;
    case 'error':
      logger?.warn?.('WAL replay probe reported a recoverable error; letting the in-process open surface it', {
        dbPath,
        error: probe.message,
      });
      return null;
    case 'unavailable':
      logger?.warn?.('WAL replay probe could not run; opening in-process without it', {
        dbPath,
        reason: probe.reason,
      });
      return null;
    case 'fatal':
      logger?.warn?.('WAL replay aborted the probe process — the write-ahead log cannot be replayed safely', {
        dbPath,
        walPath: walPathFor(dbPath),
        exitCode: probe.code,
        signal: probe.signal,
      });
      return probe;
  }
}
