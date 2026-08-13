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
 * Auto_Save_Coordinator core (canvas-layout-auto-save).
 *
 * A PURE, injectable state machine that drives the Overview_Canvas Auto_Save.
 * Its clock, save function, phase provider, DB reader, and status sink are all
 * injected parameters, so it can be driven by a virtual clock and a controllable
 * save function in property tests (Properties 1–11) and wired to the real React
 * hook (`useCanvasAutoSave`, task 8.2) in production. This module contains NO
 * React and NO real timers or `Date.now()` — everything goes through the
 * injected `clock`.
 *
 * Responsibilities:
 *  - Debounce qualifying mutations (1000 ms, restarted per mutation).      (Req 3.1, 3.2)
 *  - Bound deferral by a 10000 ms Maximum_Deferral_Cap from burst start.   (Req 3.4)
 *  - Coalesce a burst into a single pending flag / single Save_Operation.  (Req 1.3, 3.3, 4.2)
 *  - Serialize saves (never two in flight at once).                        (Req 4.1)
 *  - Clear the pending flag before a follow-up reads the DB.               (Req 4.3)
 *  - Retain pending work on failure; bounded 3 consecutive retries (5000 ms).(Req 8.1–8.5, 1.5)
 *  - Bounded (3) post-save divergence follow-ups.                          (Req 1.6)
 *  - Flush pending work against the producing workspace, bounded 5000 ms.  (Req 7)
 *  - Derive Save_Status from state and write it to the injected sink.      (Req 9)
 *  - Phase-gate: `scheduleSave()` is a no-op unless phase === 'db_open'.   (Req 1.2, 2.4)
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 2.1, 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5,
 *               4.1, 4.2, 4.3, 4.4, 4.5, 7.1, 8.1, 8.2, 8.3, 8.4, 8.5,
 *               9.1, 9.2, 9.3, 9.4, 9.6
 */
import type { WorkspacePhase } from '../hooks/useWorkspaceState';
import type { SaveStatus } from '../store/autoSaveStatusStore';

/** The Workspace_Phase discriminant the coordinator reasons about. */
export type CoordinatorPhase = WorkspacePhase['phase'];

/**
 * Scope of a scheduled Save_Operation, forming a small join-semilattice:
 *
 *   'universe'  ⊑  'full'
 *
 * - `'universe'` — only the universe-layer files (canvas layout + namespace
 *   connections). Cheap; the vast majority of qualifying mutations (drag,
 *   connect, disconnect) use it.
 * - `'full'` — a full workspace store. Required by any mutation that changes
 *   *which* namespaces exist (namespace/import-source delete), because only a
 *   full store prunes a deleted namespace's on-disk files and its manifest
 *   hash. A universe-scoped store cannot persist a deletion.
 *
 * When mutations of mixed scope coalesce into a single burst, the coordinator
 * saves at the JOIN (`joinScope`) of all requested scopes, so a burst never
 * persists a scope too narrow to capture its widest change.
 */
export type SaveScope = 'universe' | 'full';

/** Bottom of the scope lattice — the default/most-frequent scope. */
const SCOPE_BOTTOM: SaveScope = 'universe';

/** Least upper bound of two scopes: `'full'` dominates `'universe'`. */
export function joinScope(a: SaveScope, b: SaveScope): SaveScope {
  return a === 'full' || b === 'full' ? 'full' : 'universe';
}

/** Opaque timer handle returned by the injected clock. */
export type TimerHandle = unknown;

/**
 * Injected clock. In production this wraps `Date.now` and `window.setTimeout`;
 * in tests it is a deterministic virtual clock.
 */
export interface CoordinatorClock {
  now(): number;
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Timing/limit constants (exported for tests). */
export const DEBOUNCE_MS = 1000;
export const MAX_DEFERRAL_MS = 10000;
export const RETRY_DELAY_MS = 5000;
export const MAX_RETRIES = 3;
export const MAX_DIVERGENCE_FOLLOWUPS = 3;
export const FLUSH_DEADLINE_MS = 5000;
/** Follow-up delay after an in-flight save completes (must be < 100 ms — Req 4.3, 4.5). */
export const FOLLOWUP_DELAY_MS = 0;

/**
 * Dependencies injected into the coordinator. `TSnapshot` is an opaque,
 * comparable representation of persisted/DB content used only for the post-save
 * divergence check (Req 1.6); the coordinator never interprets it beyond
 * equality.
 */
export interface CoordinatorDeps<TSnapshot = unknown> {
  /** Virtual/real clock. */
  clock: CoordinatorClock;
  /** Current Workspace_Phase. `scheduleSave()` no-ops unless this is 'db_open'. */
  getPhase: () => CoordinatorPhase;
  /** Working directory of the current workspace (captured as `pendingWorkingDir`). */
  getWorkingDir: () => string | null;
  /**
   * Execute one Save_Operation at the given `scope`: read the DB at execution
   * time, persist the requested layer(s), and resolve with a snapshot of what
   * was persisted (Req 4.4). Rejects if the save fails.
   */
  save: (workingDir: string, scope: SaveScope) => Promise<TSnapshot>;
  /** Read the current DB snapshot, for the post-save divergence check (Req 1.6). */
  readDb: (workingDir: string) => TSnapshot;
  /** Sink for the derived Save_Status (writes into `useAutoSaveStatusStore`). */
  setStatus: (status: SaveStatus, error?: string | null) => void;
  /** Equality for the divergence check. Defaults to structural (JSON) equality. */
  snapshotsEqual?: (persisted: TSnapshot, current: TSnapshot) => boolean;
}

/** Public API of the coordinator core. */
export interface CanvasAutoSaveCoordinator {
  /**
   * Notify that a qualifying mutation completed successfully. Schedules a
   * debounced, coalesced Save_Operation at `scope` (default `'universe'`). The
   * pending scope escalates to the join of all scopes requested in the burst.
   * No-op unless phase === 'db_open'. (Req 1.1–1.3, 2.1–2.4, 3.1–3.2)
   */
  scheduleSave: (scope?: SaveScope) => void;
  /**
   * Cancel the debounce and run any pending/in-flight save to completion,
   * bounded by a 5000 ms deadline, against the workspace that produced the
   * pending mutations. (Req 7)
   */
  flushSave: () => Promise<void>;
  /** Introspection for tests. */
  getState: () => CoordinatorStateSnapshot;
  /** Cancel all outstanding timers (used on teardown). */
  dispose: () => void;
}

/** A read-only view of the coordinator's internal state (for tests). */
export interface CoordinatorStateSnapshot {
  pending: boolean;
  /** Join of all scopes requested for the current pending work. */
  pendingScope: SaveScope;
  inFlight: boolean;
  retryCount: number;
  divergenceCount: number;
  burstStartAt: number | null;
  pendingWorkingDir: string | null;
  failed: boolean;
  everSaved: boolean;
  status: SaveStatus;
}

/**
 * Create an Auto_Save_Coordinator. All state is closed over in this factory so
 * multiple independent coordinators can coexist (e.g. across tests).
 */
export function createCanvasAutoSaveCoordinator<TSnapshot = unknown>(
  deps: CoordinatorDeps<TSnapshot>,
): CanvasAutoSaveCoordinator {
  const { clock, getPhase, getWorkingDir, save, readDb, setStatus } = deps;
  const snapshotsEqual =
    deps.snapshotsEqual ??
    ((a: TSnapshot, b: TSnapshot) => JSON.stringify(a) === JSON.stringify(b));

  // ── State (mirrors the design's ref table) ────────────────────────────────
  let debounceTimer: TimerHandle | null = null; // 1000 ms quiet-period timer   (3.1, 3.2)
  let maxDeferralTimer: TimerHandle | null = null; // fires at burstStartAt+10 s (3.4)
  let retryTimer: TimerHandle | null = null; // 5000 ms retry delay             (8.3)
  let burstStartAt: number | null = null; // first mutation of current burst    (3.4)
  let pending = false; // single boolean: work awaits a save                    (3.2, 4.2)
  let pendingScope: SaveScope = SCOPE_BOTTOM; // join of requested scopes for the pending work
  let inFlight = false; // a Save_Operation is executing                        (4.1)
  let retryCount = 0; // consecutive failed attempts (0–3)                      (8.3, 8.5)
  let divergenceCount = 0; // post-save divergence follow-ups (0–3)             (1.6)
  let pendingWorkingDir: string | null = null; // workspace that produced work  (7.1)
  let failed = false; // last Save_Operation failed (until next save begins)    (9.4)
  let everSaved = false; // distinguishes 'saved' from 'idle'                   (9.5)
  let lastErrorMsg: string | null = null;
  let inFlightPromise: Promise<void> | null = null;

  // ── Save_Status derivation (Property 10 — a pure function of state) ────────
  function deriveStatus(): SaveStatus {
    if (inFlight) return 'saving'; // Req 9.2 — saving even if a mutation is pending
    if (failed) return 'failed'; // Req 9.4 — retained until next save begins
    if (pending) return 'pending'; // Req 9.1, 9.6
    if (everSaved) return 'saved'; // Req 9.3
    return 'idle'; // Req 9.5
  }

  function syncStatus(): void {
    const s = deriveStatus();
    setStatus(s, s === 'failed' ? lastErrorMsg : null);
  }

  // ── Timer helpers ─────────────────────────────────────────────────────────
  function clearBurstTimers(): void {
    if (debounceTimer !== null) {
      clock.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxDeferralTimer !== null) {
      clock.clearTimeout(maxDeferralTimer);
      maxDeferralTimer = null;
    }
    burstStartAt = null;
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  // ── Scheduling ──────────────────────────────────────────────────────────
  function scheduleSave(scope: SaveScope = SCOPE_BOTTOM): void {
    // Phase gate — no save is ever scheduled outside db_open (Req 1.2, 2.4).
    if (getPhase() !== 'db_open') return;

    pendingWorkingDir = getWorkingDir(); // Req 7.1 — remember the producing workspace
    pending = true; // Req 3.1, 4.2 — single pending flag
    pendingScope = joinScope(pendingScope, scope); // escalate to the widest requested scope
    failed = false; // failed → pending on a new qualifying mutation (Req 8.5)
    lastErrorMsg = null;
    retryCount = 0; // a new mutation restarts the retry budget (Req 8.5)
    divergenceCount = 0; // a new position change resets the divergence budget (Req 1.6)
    clearRetryTimer(); // the debounce, not a stale retry, drives the next save

    const nowT = clock.now();
    if (burstStartAt === null) {
      // Start a new burst and arm the Maximum_Deferral_Cap (Req 3.4).
      burstStartAt = nowT;
      maxDeferralTimer = clock.setTimeout(() => {
        maxDeferralTimer = null;
        maybeStartSave(); // force a save without waiting for further debounce
      }, MAX_DEFERRAL_MS);
    }

    // Restart the 1000 ms debounce from the most recent mutation (Req 3.2).
    if (debounceTimer !== null) clock.clearTimeout(debounceTimer);
    debounceTimer = clock.setTimeout(() => {
      debounceTimer = null;
      maybeStartSave(); // Req 3.3 — run once the quiet period elapses
    }, DEBOUNCE_MS);

    syncStatus(); // 'pending' (or 'saving' if a save is already in flight — Req 9.2)
  }

  /**
   * Start a Save_Operation iff there is pending work and none is in flight.
   * Serializes saves (Req 4.1) and defers to the completion-time follow-up when
   * a save is already running (Req 3.5).
   */
  function maybeStartSave(): void {
    if (inFlight) return; // Req 4.1 — never two in flight; follow-up runs on completion
    if (!pending) return;
    void executeSave();
  }

  function scheduleFollowUp(): void {
    // Start the coalesced follow-up within 100 ms of completion (Req 4.3, 4.5).
    clock.setTimeout(() => {
      maybeStartSave();
    }, FOLLOWUP_DELAY_MS);
  }

  function scheduleRetry(): void {
    clearRetryTimer();
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      maybeStartSave();
    }, RETRY_DELAY_MS);
  }

  /** Perform exactly one Save_Operation and handle its outcome. */
  function executeSave(): Promise<void> {
    // Any pending debounce/deferral is subsumed by this save.
    clearBurstTimers();
    clearRetryTimer();

    const wd = pendingWorkingDir ?? getWorkingDir();
    if (!wd) {
      // Nowhere to save to — drop the obligation and reflect state.
      pending = false;
      pendingScope = SCOPE_BOTTOM;
      syncStatus();
      return Promise.resolve();
    }

    // Capture the scope this operation will persist, then reset the pending
    // scope to the lattice bottom so any scope requested WHILE the save is in
    // flight accumulates independently (and a mid-save divergence follow-up
    // stays 'universe' unless escalated).
    const scopeToSave = pendingScope;
    pendingScope = SCOPE_BOTTOM;
    pending = false; // Req 4.3 — cleared BEFORE the save reads DB content
    failed = false;
    lastErrorMsg = null;
    inFlight = true;
    syncStatus(); // 'saving' (Req 9.2)

    const promise = (async () => {
      try {
        const persisted = await save(wd, scopeToSave); // reads DB at execution time (Req 4.4)
        inFlight = false;
        retryCount = 0; // success resets the retry counter (Req 8.4)
        everSaved = true;

        // Post-save divergence follow-up, bounded to 3 (Req 1.6).
        let diverged = false;
        try {
          diverged = !snapshotsEqual(persisted, readDb(wd));
        } catch {
          diverged = false; // a read failure is not treated as divergence
        }
        if (diverged && divergenceCount < MAX_DIVERGENCE_FOLLOWUPS) {
          divergenceCount++;
          pending = true;
        }

        if (pending) {
          // Mutations arrived during the save and/or disk diverged from DB.
          syncStatus(); // 'pending' (Req 9.6)
          scheduleFollowUp(); // Req 4.3 — follow-up within 100 ms
        } else {
          divergenceCount = 0;
          syncStatus(); // 'saved' (Req 9.3)
        }
      } catch (err) {
        inFlight = false;
        // Did a qualifying mutation arrive while this save was in flight?
        const hadPendingDuringSave = pending;
        lastErrorMsg = err instanceof Error ? err.message : String(err);
        failed = true; // Req 8.1, 9.4
        pending = true; // retain the pending obligation (Req 8.2)
        // Retain the failed scope so the retry re-attempts at (at least) the
        // same scope — a failed 'full' delete must not downgrade to 'universe'.
        pendingScope = joinScope(pendingScope, scopeToSave);
        syncStatus(); // 'failed'

        if (hadPendingDuringSave) {
          // New work is pending → start the follow-up within 100 ms (Req 4.5),
          // rather than waiting out the retry backoff.
          scheduleFollowUp();
        } else if (retryCount < MAX_RETRIES) {
          // Schedule a bounded retry after 5000 ms (Req 8.3).
          retryCount++;
          scheduleRetry();
        }
        // else: retryCount === MAX_RETRIES → stop retrying, stay 'failed' until
        // the next qualifying mutation (Req 8.5).
      } finally {
        inFlightPromise = null;
      }
    })();

    inFlightPromise = promise;
    return promise;
  }

  // ── Flush (Req 7) ─────────────────────────────────────────────────────────
  function delay(ms: number): Promise<'timeout'> {
    return new Promise((resolve) => {
      clock.setTimeout(() => resolve('timeout'), ms);
    });
  }

  async function flushSave(): Promise<void> {
    // Cancel any outstanding debounce / deferral / retry (Req 7.1–7.3).
    clearBurstTimers();
    clearRetryTimer();

    if (!inFlight && !pending) return; // nothing to flush

    const work = (async () => {
      // Wait for an in-flight save first (never start a concurrent one).
      if (inFlightPromise) await inFlightPromise.catch(() => {});
      // Then run exactly one save for any pending work against the producing
      // workspace (pendingWorkingDir was captured at schedule time — Req 7.1).
      if (pending && !inFlight) await executeSave();
    })();

    // Bound the flush by a 5000 ms deadline so the triggering transition is
    // never blocked indefinitely (Req 7.4).
    const outcome = await Promise.race([
      work.then(() => 'done' as const),
      delay(FLUSH_DEADLINE_MS),
    ]);

    if (outcome === 'timeout') {
      // Deadline reached: retain pending changes and mark failed (Req 7.5). A
      // save may still be in flight (it will finish or fail later and re-derive
      // the status), but the flush itself did not complete in time, so surface
      // `failed` directly rather than via `deriveStatus` (which would otherwise
      // report `saving` while that abandoned save keeps running).
      failed = true;
      lastErrorMsg = 'Auto-save flush did not complete within 5000 ms';
      setStatus('failed', lastErrorMsg);
    }
    // On 'done', executeSave already derived the correct Save_Status
    // (saved / pending / failed).
  }

  function getState(): CoordinatorStateSnapshot {
    return {
      pending,
      pendingScope,
      inFlight,
      retryCount,
      divergenceCount,
      burstStartAt,
      pendingWorkingDir,
      failed,
      everSaved,
      status: deriveStatus(),
    };
  }

  function dispose(): void {
    clearBurstTimers();
    clearRetryTimer();
  }

  return { scheduleSave, flushSave, getState, dispose };
}
