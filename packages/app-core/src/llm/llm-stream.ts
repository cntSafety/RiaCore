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
 * Provider-agnostic streaming pump for the LLM component review feature.
 *
 * Replaces the Bedrock-specific `bedrock-stream.ts` / `ConverseStreamCommand`
 * loop with the Vercel AI SDK's `streamText`, which works identically across
 * AWS Bedrock, Anthropic direct, OpenAI, and Google Vertex.
 *
 * Two public surfaces:
 *
 * - {@link pushStreamEvent} — the only place the worker writes to the
 *   one-way `llm.stream` push channel. Guards against sending to a
 *   destroyed {@link WebContentsLike} so a cancelled / closed renderer
 *   does not fault the worker.
 *
 * - {@link pumpLlmStream} — issues a single `streamText` call against the
 *   injected `LanguageModel`, iterates the text stream, and yields one
 *   {@link PumpedTextChunk} per delta. Resolves with `{ usage? }` after
 *   the stream ends; rejects with the raw SDK error otherwise so the
 *   caller can classify it via {@link classifyError}.
 *
 * - {@link consumePumpedStream} — thin wrapper that drives the generator
 *   to completion and returns `Promise<PumpBedrockStreamResult>`, matching
 *   the same contract the old `bedrock-stream.ts` exposed so `llm-channels.ts`
 *   needs only a one-line change.
 *
 * The `LanguageModel` instance is created by `createBedrockModel` (or a
 * future provider factory) and injected by the `llm.startReview` handler.
 * Tests substitute a fake `LanguageModel` that emits a deterministic stream.
 *
 * Pure module — no module-level singletons, no I/O outside the injected
 * model and the injected `webContents`.
 *
 * @see Requirements 8.4, 8.5, 8.6, 8.7, 8.8
 */

import type { LanguageModel } from 'ai';

import type { WebContentsLike } from './review-run-registry.js';

// ── pushStreamEvent ─────────────────────────────────────────────────────────

/**
 * One-way push channel name. Mirrors the value the renderer subscribes
 * to via `ipcRenderer.on('llm.stream', …)`.
 */
export const LLM_STREAM_CHANNEL = 'llm.stream';

/**
 * Inner shape of a stream event without the `runId` — the runtime tag
 * carried by every `LlmStreamEvent`. {@link pushStreamEvent} reattaches
 * `runId` so callers don't have to repeat it for every push.
 */
export interface StreamEventBody {
  type: 'start' | 'text' | 'usage' | 'done' | 'error';
  [key: string]: unknown;
}

/**
 * Push one stream event to the renderer over the `llm.stream` push channel.
 *
 * Skips the send entirely when the {@link WebContentsLike} reports it is
 * destroyed — this happens when the user has closed the modal / window
 * before the SDK has finished streaming.
 */
export function pushStreamEvent(
  webContents: WebContentsLike,
  runId: string,
  event: StreamEventBody,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send(LLM_STREAM_CHANNEL, { runId, ...event });
}

// ── pumpLlmStream ───────────────────────────────────────────────────────────

/** Yielded per text delta. */
export interface PumpedTextChunk {
  type: 'text';
  delta: string;
}

/** Final-usage metadata. */
export interface PumpedUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Resolved value of a successful pump. */
export interface PumpBedrockStreamResult {
  usage?: PumpedUsage;
}

/** Arguments accepted by {@link pumpLlmStream}. */
export interface PumpLlmStreamArgs {
  /** Provider-agnostic language model (Bedrock, Anthropic, OpenAI, Vertex…). */
  model: LanguageModel;
  /** System_Prompt text. */
  system: string;
  /** User_Prompt text. */
  user: string;
  /** Cancellation signal. Aborting surfaces as an error on the stream. */
  abortSignal?: AbortSignal;
  /**
   * Optional cap on output tokens. Useful for local models where generation
   * speed is limited. Undefined = no limit (let the model decide when to stop).
   */
  maxOutputTokens?: number;
}

/**
 * Drive a single `streamText` call against the injected model and yield
 * one {@link PumpedTextChunk} per text delta.
 *
 * Resolves (generator return value) with `{ usage? }` once the stream
 * ends. Rejects with the raw SDK error in every failure case so the
 * caller can run it through {@link classifyError}.
 *
 * The Vercel AI SDK normalises the streaming protocol across all
 * providers — the same generator body works for Bedrock, Anthropic
 * direct, OpenAI, and Google Vertex.
 */
export async function* pumpLlmStream(
  args: PumpLlmStreamArgs,
): AsyncGenerator<PumpedTextChunk, PumpBedrockStreamResult, void> {
  const { model, system, user, abortSignal } = args;

  // Lazy-load the AI SDK so the worker never pays its (large) module-load cost
  // unless an LLM review actually runs.
  const { streamText } = await import('ai');

  const result = streamText({
    model,
    system,
    messages: [{ role: 'user', content: user }],
    abortSignal,
    // Cap output to keep responses concise on local models.
    // Cloud providers (Bedrock, Anthropic, OpenAI) have no practical limit
    // so this only meaningfully affects local Ollama runs.
    maxOutputTokens: args.maxOutputTokens,
  });

  // Iterate the text stream — each chunk is a plain string delta.
  for await (const delta of result.textStream) {
    if (typeof delta === 'string' && delta.length > 0) {
      yield { type: 'text', delta };
    }
  }

  // Await the final usage metadata after the stream is exhausted.
  let usage: PumpedUsage | undefined;
  try {
    const sdkUsage = await result.usage;
    if (sdkUsage) {
      usage = {
        input_tokens: sdkUsage.inputTokens ?? 0,
        output_tokens: sdkUsage.outputTokens ?? 0,
      };
    }
  } catch {
    // Usage metadata is best-effort — a failure here must not abort the run.
  }

  return usage === undefined ? {} : { usage };
}

/**
 * Drive a {@link pumpLlmStream} generator to completion, invoking
 * `onText` per yielded chunk and resolving with the final usage payload.
 *
 * Drop-in replacement for the old `consumePumpedStream` from
 * `bedrock-stream.ts` — same signature, same contract.
 */
export async function consumePumpedStream(
  args: PumpLlmStreamArgs,
  onText: (chunk: PumpedTextChunk) => void,
): Promise<PumpBedrockStreamResult> {
  const iter = pumpLlmStream(args);
  while (true) {
    const next = await iter.next();
    if (next.done) return next.value;
    onText(next.value);
  }
}
