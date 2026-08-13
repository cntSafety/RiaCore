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
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  LlmErrorCode,
  LlmReviewMetadata,
  LlmReviewProfile,
  LlmStreamEvent,
} from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Lifecycle status of a Review_Run, owned in React reducer state.
 *
 * - `idle`       — no run has been started (the initial state).
 * - `starting`   — `api.llm.startReview` was invoked; the worker has not yet
 *                  pushed the `start` Stream_Event.
 * - `streaming`  — the `start` event arrived; `text` deltas are accumulating.
 * - `done`       — the `done` Stream_Event arrived. Terminal.
 * - `error`      — an `error` Stream_Event arrived (non-cancellation). Terminal.
 * - `cancelled`  — an `error` Stream_Event with `code === 'cancelled'` arrived,
 *                  or `start()` itself rejected with an abort. Terminal.
 */
export type LlmReviewStatus =
  | 'idle'
  | 'starting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'cancelled';

/** Public surface of {@link useLlmReview}. */
export interface UseLlmReviewResult {
  status: LlmReviewStatus;
  /** In-order concatenation of every `text` Stream_Event delta. */
  text: string;
  /**
   * Populated from the `start` event (`model_id`, `region`, `review_profile`)
   * and updated from the `usage` event (`input_tokens`, `output_tokens`) and
   * `done` event (`ended_at`).
   */
  metadata: LlmReviewMetadata | null;
  errorCode: LlmErrorCode | null;
  errorMessage: string | null;
  /** Worker-assigned UUID identifying the current Review_Run, or `null`. */
  runId: string | null;
  /**
   * ISO-8601 timestamp of the first text delta received.
   * Used to compute Time-To-First-Token (TTFT) = first_token_at - started_at.
   */
  firstTokenAt: string | null;
  /** Begin a Review_Run for the configured `{ nodeId, namespace }`. */
  start: () => Promise<void>;
  /** Cancel the in-flight Review_Run. No-op when no run is in flight. */
  cancel: () => Promise<void>;
}

interface LlmReviewState {
  status: LlmReviewStatus;
  text: string;
  metadata: LlmReviewMetadata | null;
  errorCode: LlmErrorCode | null;
  errorMessage: string | null;
  runId: string | null;
  firstTokenAt: string | null;
}

const initialState: LlmReviewState = {
  status: 'idle',
  text: '',
  metadata: null,
  errorCode: null,
  errorMessage: null,
  runId: null,
  firstTokenAt: null,
};

type Action =
  | { type: 'RESET' }
  | { type: 'STARTING'; runId: string; startedAt: string }
  | {
      type: 'STREAM_START';
      runId: string;
      model_id: string;
      region: string;
      review_profile: LlmReviewProfile;
    }
  | { type: 'STREAM_TEXT'; delta: string }
  | { type: 'STREAM_USAGE'; input_tokens: number; output_tokens: number }
  | { type: 'STREAM_DONE'; endedAt: string }
  | {
      type: 'STREAM_ERROR';
      code: LlmErrorCode;
      message: string;
      endedAt: string;
    };

function reducer(state: LlmReviewState, action: Action): LlmReviewState {
  switch (action.type) {
    case 'RESET':
      return initialState;

    case 'STARTING':
      // A new run is beginning; clear any prior terminal state but keep the
      // started_at timestamp recorded by the renderer.
      return {
        ...initialState,
        status: 'starting',
        runId: action.runId,
        firstTokenAt: null,
        // metadata is filled in fully on STREAM_START; we pre-populate
        // started_at here so the renderer-side timestamp is preserved.
        metadata: {
          model_id: '',
          region: '',
          review_profile: 'sw_arxml',
          input_tokens: null,
          output_tokens: null,
          started_at: action.startedAt,
          ended_at: null,
        },
      };

    case 'STREAM_START':
      return {
        ...state,
        status: 'streaming',
        metadata: {
          model_id: action.model_id,
          region: action.region,
          review_profile: action.review_profile,
          input_tokens: null,
          output_tokens: null,
          started_at: state.metadata?.started_at ?? new Date().toISOString(),
          ended_at: null,
        },
      };

    case 'STREAM_TEXT':
      return {
        ...state,
        text: state.text + action.delta,
        // Record the timestamp of the very first text delta for TTFT.
        firstTokenAt: state.firstTokenAt ?? new Date().toISOString(),
      };

    case 'STREAM_USAGE':
      return {
        ...state,
        metadata: state.metadata
          ? {
              ...state.metadata,
              input_tokens: action.input_tokens,
              output_tokens: action.output_tokens,
            }
          : state.metadata,
      };

    case 'STREAM_DONE':
      return {
        ...state,
        status: 'done',
        metadata: state.metadata
          ? { ...state.metadata, ended_at: action.endedAt }
          : state.metadata,
      };

    case 'STREAM_ERROR':
      return {
        ...state,
        status: action.code === 'cancelled' ? 'cancelled' : 'error',
        errorCode: action.code,
        errorMessage: action.message,
        metadata: state.metadata
          ? { ...state.metadata, ended_at: action.endedAt }
          : state.metadata,
      };

    default:
      return state;
  }
}

interface UseLlmReviewArgs {
  nodeId: number;
  namespace: string;
  /**
   * Active authored safety-analysis metamodel the review is launched from.
   * Forwarded to `llm.startReview` to select the injected review checklist.
   */
  reviewMetamodel?: string;
}

/**
 * Drives a single LLM safety Review_Run for one Eligible_Element_Node.
 *
 * The hook owns a reducer-backed state machine, subscribes to
 * `api.llm.onStream` for the lifetime of the consumer component, and filters
 * incoming Stream_Events by the `runId` returned from `api.llm.startReview`.
 *
 * Per the design contract:
 * - Never invalidates a TanStack Query cache key (Requirement 8.12).
 * - Never calls `useWorkspaceStore.getState().resetWorkspaceState()` —
 *   Review_Runs do not reassign node IDs.
 *
 * @see Requirements 4.6, 4.7, 4.8, 8.1, 8.9, 8.10, 8.12, 9.2, 9.4, 10.8, 11.8
 */
export function useLlmReview({ nodeId, namespace, reviewMetamodel }: UseLlmReviewArgs): UseLlmReviewResult {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Always read the latest `runId` inside the stream handler so it can filter
  // by the active run without re-subscribing on every state change.
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = state.runId;

  // The unsubscribe callback returned by `api.llm.onStream`.
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handler = (evt: LlmStreamEvent): void => {
      // Ignore events for any run other than the active one.
      if (evt.runId !== runIdRef.current) return;

      switch (evt.type) {
        case 'start':
          dispatch({
            type: 'STREAM_START',
            runId: evt.runId,
            model_id: evt.model_id,
            region: evt.region,
            review_profile: evt.review_profile,
          });
          return;

        case 'text':
          dispatch({ type: 'STREAM_TEXT', delta: evt.delta });
          return;

        case 'usage':
          dispatch({
            type: 'STREAM_USAGE',
            input_tokens: evt.input_tokens,
            output_tokens: evt.output_tokens,
          });
          return;

        case 'done':
          dispatch({ type: 'STREAM_DONE', endedAt: new Date().toISOString() });
          return;

        case 'error':
          dispatch({
            type: 'STREAM_ERROR',
            code: evt.code,
            message: evt.message,
            endedAt: new Date().toISOString(),
          });
          return;
      }
    };

    unsubscribeRef.current = api.llm.onStream(handler);
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  const start = useCallback(async (): Promise<void> => {
    const nonce = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    try {
      const { runId } = await api.llm.startReview({ nodeId, namespace, nonce, reviewMetamodel });
      // Update the ref synchronously so any Stream_Event arriving between
      // this point and the next render is correctly attributed to the
      // active run. The reducer state is updated via dispatch.
      runIdRef.current = runId;
      dispatch({ type: 'STARTING', runId, startedAt });
    } catch (err) {
      dispatch({
        type: 'STREAM_ERROR',
        code: 'unknown',
        message: err instanceof Error ? err.message : String(err),
        endedAt: new Date().toISOString(),
      });
    }
  }, [nodeId, namespace, reviewMetamodel]);

  const cancel = useCallback(async (): Promise<void> => {
    const runId = runIdRef.current;
    if (!runId) return;
    await api.llm.cancelReview({ runId });
  }, []);

  return {
    status: state.status,
    text: state.text,
    metadata: state.metadata,
    errorCode: state.errorCode,
    errorMessage: state.errorMessage,
    runId: state.runId,
    firstTokenAt: state.firstTokenAt,
    start,
    cancel,
  };
}
