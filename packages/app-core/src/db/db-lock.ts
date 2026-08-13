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
 * Db_Lock — a FIFO readers/writer lock that serialises access to the single
 * native database handle owned by Db_Module.
 *
 * ## Why this exists
 *
 * The worker dispatches every IPC request immediately (`worker.ts` →
 * `handleMessage` is fire-and-forget), so any two channels interleave at every
 * `await`. The `@ladybugdb/core` handle does not tolerate arbitrary overlap:
 * a `CHECKPOINT` (which commits implicitly and reclaims WAL pages) running
 * concurrently with reads on a second connection can fault the process with a
 * Windows access violation (`0xC0000005`, worker exit code 3221225477).
 *
 * The observed crash: a canvas auto-save (`persistor.store`, scope=universe)
 * issued its read queries in the middle of an import's `replaceNamespace()`
 * delete/checkpoint loop. The single-flight import guard did not help — it only
 * blocks a second *import*, not any other DB-touching channel.
 *
 * ## Policy
 *
 * - reads run concurrently with other reads
 * - a write (any mutating statement, including `CHECKPOINT`) is exclusive
 * - a transaction holds the write lock from `BEGIN` until `commit`/`rollback`
 *
 * ## Fairness
 *
 * Waiters are granted strictly in arrival order: a queued write blocks later
 * reads from overtaking it. Without that, a steady stream of renderer reads
 * (status polling, tree queries) could starve an import's checkpoint
 * indefinitely.
 *
 * ## Teardown
 *
 * `close()` frees the native handle, so it must hold the lock exclusively while
 * doing so — "wait until other work looks finished, then free" is not enough,
 * because a waiter can be granted in the gap. `tryAcquireWrite` exists for that
 * caller: being a plain write waiter it waits for *every* holder — reads, writes
 * and open transactions alike — and it cannot be overtaken by later reads, so a
 * steady stream of renderer polling cannot starve it. It gives up after a budget
 * rather than blocking forever.
 *
 * When the budget expires the caller must **not** free the handle: something is
 * still executing against it, and freeing it under a live statement is exactly
 * the access violation described above. Db_Module defers the free instead, and
 * `whenStaleHoldersReleased` tells it when the handle became safe to release.
 *
 * ## Deadlock safety
 *
 * Statements issued *inside* a transaction go through `DbTransaction.runQuery`,
 * which reuses the holder's own connection and never re-acquires the lock, so
 * the write lock is not re-entrant and does not need to be. The invariant to
 * preserve when editing Db_Module: **no code path may acquire the lock while
 * already holding it.**
 */

export type LockRelease = () => void;

type WaiterKind = 'read' | 'write';

interface Waiter {
  kind: WaiterKind;
  /** Diagnostics only — surfaces as `stats().activeTransaction`. */
  isTransaction: boolean;
  /** Resolves with the epoch the waiter was granted in. */
  grant: (epoch: number) => void;
}

export interface DbLockStats {
  activeReaders: number;
  activeWriter: boolean;
  /** True when the current write holder is an open transaction. */
  activeTransaction: boolean;
  queued: number;
  /** Holders discarded by `reset()` that have not released yet. */
  staleHolders: number;
}

export interface DbLock {
  /** Run `fn` under a shared (read) lock. */
  read<T>(fn: () => Promise<T>): Promise<T>;
  /** Run `fn` under an exclusive (write) lock. */
  write<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Acquire the exclusive lock and hand back its release function, for holders
   * whose critical section spans several calls (a transaction). The returned
   * release is idempotent — calling it twice (e.g. a `rollback` after a failed
   * `commit`) releases once.
   *
   * `isTransaction` is recorded for diagnostics (`stats().activeTransaction`);
   * it does not change how the lock is granted or released.
   */
  acquireWrite(options?: { isTransaction?: boolean }): Promise<LockRelease>;
  /**
   * Acquire the exclusive lock within `timeoutMs`, for a caller that has
   * something safer to do than wait forever (teardown). Resolves with the
   * release function on success, or `null` on timeout — in which case the
   * request is withdrawn from the queue and the lock is NOT held.
   *
   * A `null` result means some holder is still live. See "Teardown" above:
   * the caller must not free the native handle on that path.
   */
  tryAcquireWrite(timeoutMs: number): Promise<LockRelease | null>;
  /**
   * Drop all holder bookkeeping and re-dispatch the queue. Called by `close()`
   * once the native handle is gone (or has been abandoned), so lock state never
   * survives a generation boundary: without it, a transaction left open across a
   * close would block the next `open()` forever.
   *
   * Releases issued by holders from before the reset are ignored (each holder's
   * release is scoped to the epoch it was granted in), so a straggler cannot
   * clobber the state of a holder granted after the reset.
   */
  reset(): void;
  /**
   * Resolve once every holder discarded by a `reset()` has released — i.e. once
   * nothing from before the reset can still be executing. Db_Module uses this to
   * finish closing a native handle it could not free at close() time.
   *
   * Resolves immediately when there are no such holders. Never resolves if a
   * holder truly leaked (never releases), so callers should bound their wait.
   */
  whenStaleHoldersReleased(): Promise<void>;
  stats(): DbLockStats;
}

export function createDbLock(): DbLock {
  let activeReaders = 0;
  let activeWriter = false;
  let writerIsTransaction = false;
  // Bumped by reset(); a release from an earlier epoch is ignored.
  let epoch = 0;
  const queue: Waiter[] = [];
  // Holders that were live when reset() discarded them. Counted so a caller can
  // tell when the resources those holders were using became safe to free.
  let staleHolders = 0;
  const staleWaiters: Array<() => void> = [];

  function noteStaleRelease(): void {
    if (staleHolders > 0) staleHolders -= 1;
    if (staleHolders > 0) return;
    while (staleWaiters.length > 0) {
      staleWaiters.shift()!();
    }
  }

  /**
   * Grant as many head-of-queue waiters as the current holders allow. Stops at
   * the first waiter that cannot be granted, which is what keeps the lock FIFO
   * (a blocked write is never overtaken by a later read).
   */
  function dispatch(): void {
    while (queue.length > 0) {
      const head = queue[0];
      if (head.kind === 'write') {
        if (activeWriter || activeReaders > 0) return;
        queue.shift();
        activeWriter = true;
        writerIsTransaction = head.isTransaction;
        head.grant(epoch);
        return;
      }
      if (activeWriter) return;
      queue.shift();
      activeReaders += 1;
      head.grant(epoch);
    }
  }

  function acquire(kind: WaiterKind, isTransaction = false): Promise<number> {
    return new Promise<number>((resolve) => {
      queue.push({ kind, isTransaction, grant: resolve });
      dispatch();
    });
  }

  function releaseRead(grantedEpoch: number): void {
    if (grantedEpoch !== epoch) { // superseded by reset()
      noteStaleRelease();
      return;
    }
    if (activeReaders > 0) activeReaders -= 1;
    dispatch();
  }

  function releaseWrite(grantedEpoch: number): void {
    if (grantedEpoch !== epoch) { // superseded by reset()
      noteStaleRelease();
      return;
    }
    activeWriter = false;
    writerIsTransaction = false;
    dispatch();
  }

  /** Idempotent, epoch-scoped release for a hand-held write lock. */
  function writeReleaseFor(grantedEpoch: number): LockRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseWrite(grantedEpoch);
    };
  }

  return {
    async read<T>(fn: () => Promise<T>): Promise<T> {
      const grantedEpoch = await acquire('read');
      try {
        return await fn();
      } finally {
        releaseRead(grantedEpoch);
      }
    },

    async write<T>(fn: () => Promise<T>): Promise<T> {
      const grantedEpoch = await acquire('write');
      try {
        return await fn();
      } finally {
        releaseWrite(grantedEpoch);
      }
    },

    async acquireWrite(options?: { isTransaction?: boolean }): Promise<LockRelease> {
      const grantedEpoch = await acquire('write', options?.isTransaction === true);
      return writeReleaseFor(grantedEpoch);
    },

    tryAcquireWrite(timeoutMs: number): Promise<LockRelease | null> {
      return new Promise<LockRelease | null>((resolve) => {
        let settled = false;

        // Created before the waiter is queued: dispatch() may grant it
        // synchronously, and grant() clears this timer.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const index = queue.indexOf(waiter);
          if (index >= 0) {
            queue.splice(index, 1);
            // Withdrawing a queued write can unblock reads held behind it.
            dispatch();
          }
          resolve(null);
        }, timeoutMs);

        const waiter: Waiter = {
          kind: 'write',
          isTransaction: false,
          grant: (grantedEpoch: number) => {
            if (settled) {
              // Timed out a tick before the grant landed. The caller has already
              // walked away, so hand the lock straight back rather than leaking it.
              releaseWrite(grantedEpoch);
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(writeReleaseFor(grantedEpoch));
          },
        };

        queue.push(waiter);
        dispatch();
      });
    },

    reset(): void {
      // Remember how many holders are being discarded, so
      // whenStaleHoldersReleased() can report when they are all done.
      staleHolders += activeReaders + (activeWriter ? 1 : 0);
      epoch += 1;
      activeReaders = 0;
      activeWriter = false;
      writerIsTransaction = false;
      dispatch();
    },

    whenStaleHoldersReleased(): Promise<void> {
      if (staleHolders === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        staleWaiters.push(resolve);
      });
    },

    stats(): DbLockStats {
      return {
        activeReaders,
        activeWriter,
        activeTransaction: activeWriter && writerIsTransaction,
        queued: queue.length,
        staleHolders,
      };
    },
  };
}
