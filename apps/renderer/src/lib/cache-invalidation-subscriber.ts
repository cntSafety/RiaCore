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
 * Cache_Invalidation_Subscriber — renderer-side bootstrap module.
 *
 * Wires the TanStack QueryCache to the Invalidation_Bus:
 * - Outbound: subscribes to QueryCache events, coalesces Local_Origin_Invalidations,
 *   and sends them to the main process via `api.cache.invalidate`.
 * - Inbound: listens for `cache.invalidate` messages from the main process,
 *   deduplicates on (originWindowId, sequenceId), and calls
 *   `queryClient.invalidateQueries` with a per-key Reentrancy_Guard to prevent
 *   echo loops.
 *
 * Must be installed synchronously after `new QueryClient(...)` and before
 * `createRoot(...).render(...)` in every renderer root.
 *
 * Requirements: 15.7, 15.8, 15.9, 15.12, 15.13, 15.16, 16.1, 16.2, 16.7
 */

import type { QueryClient } from '@tanstack/react-query';
import type { QueryKey, CacheInvalidationOutbound, CacheInvalidationMessage } from '@riacore/app-contracts';
import { api } from '../api/riacore';

// ---------------------------------------------------------------------------
// Inline broadcast policy (mirrors packages/app-contracts/src/cache-invalidation.ts)
// Inlined here to avoid Vite CJS/ESM interop issues with the workspace package.
// The policy is intentionally identical — any change must be made in both places.
// ---------------------------------------------------------------------------

function shouldBroadcast(queryKey: QueryKey): boolean {
  if (queryKey.length === 0) return false;
  const root = queryKey[0];
  if (typeof root !== 'string') return false;
  // denylist is empty by default — no keys are denied
  // allowlist is ['*'] — all string-rooted keys broadcast
  return true;
}

// ---------------------------------------------------------------------------
// Constants (exported so they can be tuned in a single PR)
// ---------------------------------------------------------------------------

/** Default coalescing window in milliseconds. Requirements: 15.12 */
export const COALESCING_WINDOW_MS = 50;

/** Hard cap on coalescing window in milliseconds. Requirements: 15.12 */
export const COALESCING_WINDOW_HARD_CAP_MS = 200;

/** Maximum number of distinct messages per Coalescing_Window. Requirements: 15.13 */
export const SOFT_CAP_PER_WINDOW = 50;

/** LRU dedup set capacity. */
const DEDUP_SET_CAPACITY = 1024;

// ---------------------------------------------------------------------------
// LRU set (bounded, insertion-order eviction)
// ---------------------------------------------------------------------------

class LruSet {
  private readonly map = new Map<string, true>();
  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  add(key: string): void {
    if (this.map.has(key)) {
      // Refresh position
      this.map.delete(key);
      this.map.set(key, true);
      return;
    }
    if (this.map.size >= this.capacity) {
      // Evict oldest (first inserted)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, true);
  }
}

// ---------------------------------------------------------------------------
// Subscriber state
// ---------------------------------------------------------------------------

interface SubscriberState {
  outbound: {
    sequenceCounter: number;
    coalesceTimers: Map<string, ReturnType<typeof setTimeout>>;
    coalescePending: Map<string, CacheInvalidationOutbound>;
    softCapCount: number;
    softCapWindowStart: number;
  };
  inbound: {
    seenIds: LruSet;
    reentrancyGuard: Map<string, true>;
  };
}

function makeGuardKey(queryKey: QueryKey, exact: boolean): string {
  return `${exact ? 'E' : 'P'}:${JSON.stringify(queryKey)}`;
}

// ---------------------------------------------------------------------------
// Explicit cross-window broadcast (origin-independent)
// ---------------------------------------------------------------------------

/**
 * Reference to the active subscriber's coalesced-broadcast scheduler.
 * Set on install, cleared on dispose. Null when no subscriber is installed.
 */
let activeBroadcastScheduler: ((queryKey: QueryKey, exact: boolean) => void) | null = null;

/**
 * Request a cross-window cache invalidation for `queryKey` regardless of whether
 * a matching query exists in THIS window's cache.
 *
 * The automatic outbound path only broadcasts keys that produce a QueryCache
 * `invalidate` event — i.e. keys with a live query in this window. Aggregate or
 * view-specific keys (e.g. ['propagationGraph'], ['safety.propagations']) are
 * absent in a window that isn't currently showing that view, so a mutation
 * performed there would never tell other windows to refresh those views.
 *
 * Use this to explicitly fan out such keys. It routes through the same
 * coalescing + sequence pipeline as automatic broadcasts (so sequence ids stay
 * consistent and receiver dedup works). It does NOT invalidate locally — call
 * `queryClient.invalidateQueries` separately for the originating window.
 */
export function requestCrossWindowInvalidation(queryKey: QueryKey, exact = false): void {
  if (!activeBroadcastScheduler) return;
  if (!shouldBroadcast(queryKey)) return;
  activeBroadcastScheduler(queryKey, exact);
}

function makeCoalesceKey(queryKey: QueryKey, exact: boolean): string {
  return JSON.stringify(queryKey) + (exact ? '#exact' : '');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Install the Cache_Invalidation_Subscriber for the given QueryClient.
 * Returns a dispose function that unsubscribes both the QueryCache listener
 * and the inbound handler.
 *
 * Requirements: 15.9
 */
export function installCacheInvalidationSubscriber(queryClient: QueryClient): () => void {
  const state: SubscriberState = {
    outbound: {
      sequenceCounter: 0,
      coalesceTimers: new Map(),
      coalescePending: new Map(),
      softCapCount: 0,
      softCapWindowStart: Date.now(),
    },
    inbound: {
      seenIds: new LruSet(DEDUP_SET_CAPACITY),
      reentrancyGuard: new Map(),
    },
  };

  // -------------------------------------------------------------------------
  // Outbound path
  // -------------------------------------------------------------------------

  function handleLocalInvalidation(queryKey: QueryKey, exact: boolean): void {
    const guardKey = makeGuardKey(queryKey, exact);

    // Reentrancy_Guard: suppress re-broadcast of Remote_Origin_Invalidations.
    // Requirements: 16.1
    if (state.inbound.reentrancyGuard.has(guardKey)) return;

    // Policy filter. Requirements: 15.4
    if (!shouldBroadcast(queryKey)) return;

    scheduleCoalesced(queryKey, exact);
  }

  function scheduleCoalesced(queryKey: QueryKey, exact: boolean): void {
    const coalesceKey = makeCoalesceKey(queryKey, exact);
    const seq = ++state.outbound.sequenceCounter;

    // Always overwrite: latest invalidation subsumes earlier ones for the same key.
    state.outbound.coalescePending.set(coalesceKey, { queryKey, exact, sequenceId: seq });

    if (!state.outbound.coalesceTimers.has(coalesceKey)) {
      const timer = setTimeout(() => {
        const payload = state.outbound.coalescePending.get(coalesceKey);
        state.outbound.coalescePending.delete(coalesceKey);
        state.outbound.coalesceTimers.delete(coalesceKey);

        if (!payload) return;

        // Soft cap check. Requirements: 15.13
        const now = Date.now();
        if (now - state.outbound.softCapWindowStart > COALESCING_WINDOW_HARD_CAP_MS) {
          // Reset window
          state.outbound.softCapCount = 0;
          state.outbound.softCapWindowStart = now;
        }

        if (state.outbound.softCapCount >= SOFT_CAP_PER_WINDOW) {
          console.warn('[CacheInvalidationSubscriber] soft cap exceeded; dropping', {
            queryKey: JSON.stringify(queryKey),
          });
          return;
        }

        state.outbound.softCapCount++;

        try {
          api.cache.invalidate(payload);
        } catch (err) {
          console.warn('[CacheInvalidationSubscriber] cache.invalidate send failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, COALESCING_WINDOW_MS);

      state.outbound.coalesceTimers.set(coalesceKey, timer);
    }
  }

  // Expose the coalesced scheduler for origin-independent explicit broadcasts.
  // (requestCrossWindowInvalidation). Mirrors the automatic path so sequence
  // ids and coalescing stay consistent.
  activeBroadcastScheduler = scheduleCoalesced;

  // Subscribe to QueryCache events. Requirements: 15.7
  const unsubscribeQueryCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    if ((event.action as { type: string }).type !== 'invalidate') return;

    const queryKey = event.query.queryKey as QueryKey;
    handleLocalInvalidation(queryKey, /* exact */ false);
  });

  // -------------------------------------------------------------------------
  // Inbound path
  // -------------------------------------------------------------------------

  const unsubscribeInbound = api.cache.onCacheInvalidate((msg: CacheInvalidationMessage) => {
    const dedupKey = `${msg.originWindowId}:${msg.sequenceId}`;

    // Dedup on (originWindowId, sequenceId). Requirements: 15.16
    if (state.inbound.seenIds.has(dedupKey)) return;
    state.inbound.seenIds.add(dedupKey);

    // Defence-in-depth: re-apply policy on receive. Requirements: 15.11
    if (!shouldBroadcast(msg.queryKey)) return;

    const guardKey = makeGuardKey(msg.queryKey, msg.exact ?? false);

    // Set Reentrancy_Guard before calling invalidateQueries so the outbound
    // path does not re-broadcast this Remote_Origin_Invalidation.
    // Requirements: 16.1, 16.7
    state.inbound.reentrancyGuard.set(guardKey, true);
    try {
      void queryClient.invalidateQueries({
        queryKey: msg.queryKey as unknown[],
        exact: msg.exact ?? false,
      });
    } finally {
      // Clear synchronously after the synchronous portion of invalidateQueries.
      // TanStack's async refetches do not hold the guard. Requirements: 16.7
      state.inbound.reentrancyGuard.delete(guardKey);
    }
  });

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  return () => {
    unsubscribeQueryCache();
    unsubscribeInbound();

    // Clear the explicit-broadcast scheduler reference if it still points here.
    if (activeBroadcastScheduler === scheduleCoalesced) {
      activeBroadcastScheduler = null;
    }

    // Clear all pending coalesce timers
    for (const timer of state.outbound.coalesceTimers.values()) {
      clearTimeout(timer);
    }
    state.outbound.coalesceTimers.clear();
    state.outbound.coalescePending.clear();
  };
}
