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
 * Shared cache-invalidation types and broadcast policy.
 *
 * Imported by both the renderer-side Cache_Invalidation_Subscriber and the
 * main-process Invalidation_Bus so that the allowlist/denylist filter cannot
 * drift between the two sides.
 *
 * Requirements: 15.1, 15.4, 15.11
 */

export type QueryKeyElement = string | number | null;
export type QueryKey = ReadonlyArray<QueryKeyElement>;

/**
 * Payload sent from a renderer to the main process via `cache.invalidate`.
 * Does NOT include `originWindowId` — that is injected server-side from
 * `event.sender.id` so renderers cannot spoof it.
 */
export interface CacheInvalidationOutbound {
  queryKey: QueryKey;
  exact?: boolean;
  reason?: string;
  sequenceId: number;
}

/**
 * Full message carried by the Invalidation_Bus (main → renderer).
 * Extends the outbound payload with the server-injected `originWindowId`.
 * `originWindowId = -1` is the sentinel for worker-injected messages.
 */
export interface CacheInvalidationMessage extends CacheInvalidationOutbound {
  /** BrowserWindow.webContents.id of the originating renderer, or -1 for worker-injected. */
  originWindowId: number;
}

/**
 * Broadcast policy controlling which query keys participate in cross-window
 * invalidation. The initial policy broadcasts every string-rooted key.
 * Add entries to `denylist` to opt out specific key prefixes without code
 * changes elsewhere.
 */
export const broadcastPolicy = {
  allowlist: ['*'] as readonly string[],
  denylist: [] as readonly string[],
} as const;

export type BroadcastPolicy = typeof broadcastPolicy;

/**
 * Returns true if the given query key should be broadcast across windows.
 *
 * Rules (applied in order):
 * 1. Empty keys are never broadcast.
 * 2. Only string-rooted keys are broadcast (first element must be a string).
 * 3. Denylist is checked before allowlist — a denylist match suppresses broadcast.
 * 4. `'*'` in the allowlist means "all string-rooted keys not on the denylist".
 *
 * Requirements: 15.4, 15.11
 */
export function shouldBroadcast(queryKey: QueryKey): boolean {
  if (queryKey.length === 0) return false;
  const root = queryKey[0];
  if (typeof root !== 'string') return false;

  // Denylist checked first
  if (broadcastPolicy.denylist.some((p) => root === p || root.startsWith(p))) return false;

  // Allowlist: '*' means all string-rooted keys
  if (broadcastPolicy.allowlist.includes('*')) return true;

  return broadcastPolicy.allowlist.some((p) => root === p || root.startsWith(p));
}
