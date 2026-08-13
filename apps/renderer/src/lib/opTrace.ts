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
 * Reusable operation tracing for the renderer.
 *
 * Goal: produce a readable, correlated trail in the **host lifecycle log on
 * disk** for a single user-driven operation, broken into the phases that matter
 * when diagnosing UI/state bugs:
 *
 *   start    → the user action            ("Malfunction delete requested")
 *   backend  → the backend result          ("DB updated — malfunction deleted")
 *   frontend → the client-side state change ("Tree refresh requested")
 *   end      → outcome + total duration
 *   error    → failure with message + stack
 *
 * Entries are forwarded via `app.logRendererEvent`. `renderer.info` /
 * `renderer.debug` entries are written to the lifecycle log regardless of the
 * `debug` config flag, so a user only has to send their log file after a
 * failure — nothing to enable up front.
 *
 * Every line for one operation shares the same `opId` (and repeats the base
 * context such as `nodeId` / `namespace`), so the full story can be recovered
 * with a single grep on the opId even when other events are interleaved.
 *
 * This module is domain-agnostic — use it for any traceable operation, not just
 * safety mutations. All functions are fire-and-forget and never throw.
 */
import { api } from '../api/riacore';

export type OpLevel = 'info' | 'warn' | 'error' | 'debug';

type LogContext = Record<string, unknown>;

let opCounter = 0;

function nextOpId(name: string): string {
  opCounter = (opCounter + 1) % 1_000_000;
  return `${name}@${Date.now().toString(36)}-${opCounter.toString(36)}`;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Low-level forwarder. Maps the diagnostic level onto a valid
 * `RendererLogEntry` level/type pair and never throws.
 */
function forward(level: OpLevel, message: string, context?: LogContext): void {
  try {
    void api.app
      .logRendererEvent({
        level,
        type:
          level === 'info' ? 'renderer.info'
          : level === 'error' ? 'mutation.error'
          : 'renderer.debug',
        message,
        component: 'OpTrace',
        context,
      })
      .catch(() => {
        /* forwarding failures must never disrupt the UI */
      });
  } catch {
    /* api/window.riacore unavailable (e.g. unit tests) — swallow */
  }
}

/**
 * Emit a single, standalone operation event (no trace object). Use this for
 * events that are not bracketed by a start/end, e.g. a tree-sync reaction that
 * happens asynchronously in response to a cache invalidation.
 */
export function logOpEvent(
  op: string,
  phase: string,
  message: string,
  context?: LogContext,
  level: OpLevel = 'info',
): void {
  forward(level, `[${op}] ${phase}: ${message}`, { op, phase, ...context });
}

export interface OpTrace {
  /** Correlation id shared by every entry of this operation. */
  readonly id: string;
  /** Operation name, e.g. "malfunction.delete". */
  readonly name: string;
  /** Generic intermediate step in a custom phase. */
  step(phase: string, message: string, context?: LogContext): void;
  /** Backend-phase step, e.g. "DB updated". */
  backend(message: string, context?: LogContext): void;
  /** Frontend-phase step, e.g. "Tree refresh requested". */
  frontend(message: string, context?: LogContext): void;
  /** Finish successfully; logs total elapsed time. */
  end(message?: string, context?: LogContext): void;
  /** Finish with a failure; logs the error message, stack and elapsed time. */
  fail(error: unknown, context?: LogContext): void;
}

/**
 * Begin tracing an operation. Immediately emits a `start` entry.
 *
 * @param name       stable operation identifier, e.g. "malfunction.delete"
 * @param message    human-readable description of the user action
 * @param baseContext context repeated on every entry (e.g. { nodeId, namespace })
 */
export function beginOpTrace(
  name: string,
  message: string,
  baseContext?: LogContext,
): OpTrace {
  const id = nextOpId(name);
  const startedAt = now();
  let seq = 0;

  const elapsedMs = (): number => Math.round((now() - startedAt) * 10) / 10;

  const emit = (level: OpLevel, phase: string, msg: string, ctx?: LogContext): void => {
    seq += 1;
    forward(level, `[${name}] ${phase}: ${msg}`, {
      opId: id,
      op: name,
      phase,
      seq,
      elapsedMs: elapsedMs(),
      ...baseContext,
      ...ctx,
    });
  };

  emit('info', 'start', message);

  return {
    id,
    name,
    step: (phase, msg, ctx) => emit('info', phase, msg, ctx),
    backend: (msg, ctx) => emit('info', 'backend', msg, ctx),
    frontend: (msg, ctx) => emit('info', 'frontend', msg, ctx),
    end: (msg, ctx) => emit('info', 'end', msg ?? 'completed', ctx),
    fail: (error, ctx) => {
      const err = error as { message?: string; stack?: string } | undefined;
      emit('error', 'error', err?.message ?? String(error), {
        ...ctx,
        stack: err?.stack,
      });
    },
  };
}
