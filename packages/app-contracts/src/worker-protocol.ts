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
import type { WorkerIpcChannel } from './ipc.js';
import type { LoadProgressPushEvent } from './persistor-types.js';
import type { LlmStreamEvent } from './llm-types.js';

/** Request the utility process to handle an IPC channel call */
export interface WorkerRequest {
  type: 'request';
  id: string;
  channel: WorkerIpcChannel;
  payload: unknown;
}

/** Request graceful shutdown */
export interface WorkerShutdown {
  type: 'shutdown';
}

/** Messages from Main Process → Utility Process */
export type MainMessage = WorkerRequest | WorkerShutdown;

/** Utility process has initialized services and is ready */
export interface WorkerReady {
  type: 'ready';
}

/** Structured worker log event forwarded to the main process logger */
export interface WorkerLog {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  context?: Record<string, unknown>;
}

/** Successful response to a request */
export interface WorkerResponse {
  type: 'response';
  id: string;
  ok: true;
  data: unknown;
}

/** Error response to a request */
export interface WorkerErrorResponse {
  type: 'response';
  id: string;
  ok: false;
  error: string;
}

/** Fatal initialization error */
export interface WorkerError {
  type: 'error';
  error: string;
}

/** Load progress push event forwarded from the worker to the main process */
export interface WorkerLoadProgress {
  type: 'loadProgress';
  event: LoadProgressPushEvent;
}

/** LLM stream event forwarded from the worker to the main process for relay to renderer windows */
export interface WorkerLlmStream {
  type: 'llmStream';
  event: LlmStreamEvent;
}

/** Messages from Utility Process → Main Process */
export type WorkerMessage = WorkerReady | WorkerResponse | WorkerErrorResponse | WorkerError | WorkerLog | WorkerLoadProgress | WorkerLlmStream;
