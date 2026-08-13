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
 * FM_List loader for the `sw_arxml` Review_Profile.
 *
 * The FM_List is the bundled failure-mode reference list at
 * `<profileRoot>/safety-core/safety-meta/FM_List.json`. It is read in
 * the worker process only (Requirement 14.2) and embedded into the
 * User_Prompt as the "Failure Mode Reference List" section for every
 * `sw_arxml` Review_Run.
 *
 * Caching strategy (Requirement 14.1, 14.3, 14.5):
 *
 * - Module-level lazy singleton — first successful load populates the
 *   cache; subsequent calls return the cached value without touching the
 *   filesystem again.
 * - On read or parse failure the cache stays `null`, so a subsequent
 *   "Start review" click retries the load. The handler does NOT
 *   auto-retry (Requirement 14.5).
 *
 * Errors surface as {@link FmListLoadError} carrying a `kind` of
 * `'read'` or `'parse'` plus the underlying cause, so the
 * `llm.startReview` handler can classify them as `LlmErrorCode = 'unknown'`
 * and emit a single `error` Stream_Event without issuing a network
 * request (Requirement 14.4).
 *
 * The `system_sysml` Review_Profile does not call this loader; a
 * missing or unparseable FM_List file therefore cannot prevent a
 * `system_sysml` Review_Run (Requirement 14.6).
 *
 * @see Requirement 14.1, 14.2, 14.3, 14.4, 14.5
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Relative path of the bundled FM_List JSON within `profileRoot`. */
export const FM_LIST_RELATIVE_PATH = 'safety-core/safety-meta/FM_List.json';

/**
 * Module-level lazy cache of the parsed FM_List JSON value.
 *
 * `null` means "not yet loaded" or "previous load failed". After a
 * successful load the parsed value is stored here and returned from
 * every subsequent {@link loadFmListOnce} call.
 *
 * Module-private. Tests that need to reset the cache between cases
 * should use {@link __resetFmListCacheForTesting}.
 */
let cached: unknown | null = null;

/**
 * Read and parse the FM_List once, returning the cached value on every
 * subsequent call.
 *
 * Resolution:
 *
 * 1. If the cache is populated, return it without I/O.
 * 2. Otherwise read `<profileRoot>/safety-core/safety-meta/FM_List.json`
 *    via `fs.readFile(..., 'utf-8')`. A read failure throws
 *    {@link FmListLoadError} with `kind = 'read'`.
 * 3. Parse the file with `JSON.parse`. A parse failure throws
 *    {@link FmListLoadError} with `kind = 'parse'`.
 * 4. Store the parsed value in the cache and return it.
 *
 * On any failure the cache stays `null`, so the next caller may retry
 * (Requirement 14.5).
 *
 * @param profileRoot Absolute path to the bundled `packages/profiles`
 *                    directory (resolved by walking up from `__dirname`
 *                    at worker startup).
 * @throws {FmListLoadError} on read or parse failure.
 */
export async function loadFmListOnce(profileRoot: string): Promise<unknown> {
  if (cached !== null) return cached;

  const filePath = path.join(profileRoot, FM_LIST_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new FmListLoadError('read', err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FmListLoadError('parse', err);
  }

  cached = parsed;
  return parsed;
}

/**
 * Error thrown by {@link loadFmListOnce} when the FM_List file cannot
 * be read or parsed.
 *
 * `kind` distinguishes filesystem failures from JSON-syntax failures so
 * the calling handler can produce a human-readable message identifying
 * which step failed (Requirement 14.4). `cause` carries the underlying
 * error for diagnostic logging.
 */
export class FmListLoadError extends Error {
  /** What stage of loading failed: filesystem read or JSON parse. */
  public readonly kind: 'read' | 'parse';
  /** The underlying error (typically a {@link NodeJS.ErrnoException} or a `SyntaxError`). */
  public readonly cause: unknown;

  constructor(kind: 'read' | 'parse', cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to ${kind} FM_List: ${causeMessage}`);
    this.name = 'FmListLoadError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Clear the module-level cache. Intended for unit and property tests
 * that need to drive the loader through multiple load attempts in a
 * single test process. Production code MUST NOT call this.
 */
export function __resetFmListCacheForTesting(): void {
  cached = null;
}
