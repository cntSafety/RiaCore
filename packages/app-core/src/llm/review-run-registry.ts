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
 * In-memory registry of in-flight LLM Review_Runs.
 *
 * Each `llm.startReview` call registers an entry keyed by the run's unique
 * `runId`. The entry carries the {@link AbortController} that drives the
 * AWS Bedrock async iterator, a {@link WebContentsLike} sink for pushing
 * `llm.stream` events back to the renderer, and the resolved
 * {@link LlmReviewProfile} for diagnostic and bookkeeping purposes.
 *
 * `cancelReview` looks the entry up and aborts the controller; the handler
 * downstream of the SDK is expected to translate the resulting `AbortError`
 * into a single `error` Stream_Event with code `'cancelled'` and to remove
 * the entry from the registry on completion.
 *
 * The registry is intentionally a thin wrapper around `Map` — the worker
 * handler owns the lifecycle, and the registry only enforces the
 * idempotence contract documented on {@link ReviewRunRegistry.cancel}.
 *
 * `app-core` is shared between the Electron host (`apps/desktop-host`) and
 * the headless CLI (`apps/cli`), so this module declares a structural
 * {@link WebContentsLike} interface rather than importing Electron's
 * `WebContents` type. The structural shape matches the subset of
 * `Electron.WebContents` that the LLM streaming pump uses and lets the CLI
 * substitute its own sink without pulling Electron into non-host code.
 *
 * @see Requirements 9.3, 9.5, 9.6
 */

import type { LlmReviewProfile } from '@riacore/app-contracts';

/**
 * Structural subset of `Electron.WebContents` that the LLM streaming pump
 * uses to push `llm.stream` events back to the renderer.
 *
 * Kept minimal so callers (Electron host, CLI bridge, tests) can supply
 * any object that satisfies this shape without depending on Electron.
 */
export interface WebContentsLike {
  /** Send an event payload over the named one-way channel. */
  send(channel: string, payload: unknown): void;
  /** Returns `true` once the underlying renderer/window has been destroyed. */
  isDestroyed(): boolean;
}

/**
 * Per-run state held by the registry.
 */
export interface ReviewRunEntry {
  /** Aborts the in-flight Bedrock async iterator when triggered. */
  abort: AbortController;
  /** Sink for `llm.stream` events scoped to this run. */
  webContents: WebContentsLike;
  /** Resolved Review_Profile, retained for diagnostics. */
  profile: LlmReviewProfile;
}

/**
 * Registry of in-flight Review_Runs.
 *
 * The class itself is non-generic and pure aside from the internal `Map`;
 * it performs no I/O and no logging.
 */
export class ReviewRunRegistry {
  private readonly runs = new Map<string, ReviewRunEntry>();

  /**
   * Register a new in-flight run.
   *
   * Replaces any existing entry under the same `runId`. The handler is
   * expected to mint a fresh UUID per `llm.startReview`, so collisions are
   * not anticipated in normal operation; this overwrite-semantics is
   * intentional and documented for completeness.
   */
  register(runId: string, entry: ReviewRunEntry): void {
    this.runs.set(runId, entry);
  }

  /**
   * Look up an entry by `runId`. Returns `undefined` if no run is registered
   * (either because it was never started or because it has already finished
   * or been cancelled).
   */
  get(runId: string): ReviewRunEntry | undefined {
    return this.runs.get(runId);
  }

  /**
   * Remove an entry from the registry.
   *
   * Returns `true` if an entry existed and was removed, `false` otherwise.
   * Removal does not abort the underlying controller — call {@link cancel}
   * for that.
   */
  delete(runId: string): boolean {
    return this.runs.delete(runId);
  }

  /**
   * Cancel an in-flight run.
   *
   * Idempotent: looks up the entry, aborts its controller if present, and
   * deletes the entry. Calling `cancel` for an unknown `runId`, or calling
   * it multiple times for the same `runId`, is a no-op and never throws —
   * Requirements 9.5, 9.6.
   */
  cancel(runId: string): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      // Unknown run id — no-op per Requirement 9.6.
      return;
    }
    entry.abort.abort();
    this.runs.delete(runId);
  }
}
