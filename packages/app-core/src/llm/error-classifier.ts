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
 * Pure error classification and credential redaction helpers (worker side).
 *
 * `classifyError` maps an arbitrary thrown value to a stable
 * {@link LlmErrorCode}. `redactCredentials` strips AWS credential
 * fingerprints (and optionally known live credential values) from a
 * string before it is allowed to cross the IPC boundary.
 *
 * Pure: no I/O, no logging, no globals.
 *
 * @see Requirement 10.3, 10.4, 10.5, 10.6, 10.7, 10.9, 10.11
 */

import type { BedrockCredentials, LlmErrorCode } from '@riacore/app-contracts';

// ── classifyError ───────────────────────────────────────────────────────────

const AUTH_REJECTED_CLASSES = new Set<string>([
  // AWS Bedrock SDK error names
  'AccessDeniedException',
  'UnauthorizedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  // Vercel AI SDK wraps provider auth errors under these names
  'AI_AuthenticationError',
  'AuthenticationError',
]);

const MODEL_UNAVAILABLE_CLASSES = new Set<string>([
  // AWS Bedrock SDK error names
  'ResourceNotFoundException',
  'ValidationException',
  'ModelNotReadyException',
  // Vercel AI SDK
  'AI_InvalidModelError',
  'AI_UnsupportedFunctionalityError',
]);

const RATE_LIMIT_CLASSES = new Set<string>([
  // AWS Bedrock SDK error names
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
  // Vercel AI SDK
  'AI_RateLimitError',
  'RateLimitError',
]);

const NETWORK_CODES = new Set<string>(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT']);

/**
 * Classify an arbitrary thrown value into a stable {@link LlmErrorCode}.
 *
 * Resolution order (Requirement 10.11 — same input always yields the same
 * code):
 *
 * 1. `AbortError` → `'cancelled'`
 * 2. AWS SDK exception class name (`err.name` or `err.constructor.name`)
 *    matching one of the documented sets:
 *    - auth: `AccessDeniedException`, `UnauthorizedException`,
 *      `UnrecognizedClientException`, `InvalidSignatureException`
 *    - model: `ResourceNotFoundException`, `ValidationException`,
 *      `ModelNotReadyException`
 *    - rate limit: `ThrottlingException`, `TooManyRequestsException`,
 *      `ServiceQuotaExceededException`
 * 3. Node.js network error code (`err.code` or `err.cause.code`) one of
 *    `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT` → `'network'`
 * 4. `TypeError` (the shape `globalThis.fetch` raises on network failure)
 *    → `'network'`
 * 5. Anything else → `'unknown'`
 *
 * Total and deterministic.
 */
export function classifyError(err: unknown): LlmErrorCode {
  const name = getErrorName(err);

  if (name === 'AbortError') return 'cancelled';

  // Vercel AI SDK abort surfaces as AI_InvalidPromptError with cause AbortError,
  // or directly as an error whose message contains 'aborted'.
  if (name === 'AI_InvalidPromptError' || name === 'AI_LoadAPIKeyError') {
    return 'no_credentials';
  }

  if (name !== undefined) {
    if (AUTH_REJECTED_CLASSES.has(name)) return 'auth_rejected';
    if (MODEL_UNAVAILABLE_CLASSES.has(name)) return 'model_unavailable';
    if (RATE_LIMIT_CLASSES.has(name)) return 'rate_limit';
  }

  // Vercel AI SDK wraps HTTP errors as AI_APICallError; check the status code.
  const status = getHttpStatus(err);
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth_rejected';
    if (status === 404) return 'model_unavailable';
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'network';
  }

  const code = getErrorCode(err);
  if (code !== undefined && NETWORK_CODES.has(code)) return 'network';

  if (name === 'TypeError') return 'network';
  // Vercel AI SDK network-level wrapper
  if (name === 'AI_APICallError') return 'network';

  return 'unknown';
}

function getErrorName(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { name?: unknown; constructor?: { name?: unknown } };
  if (typeof e.name === 'string' && e.name.length > 0) return e.name;
  if (e.constructor && typeof e.constructor.name === 'string' && e.constructor.name.length > 0) {
    return e.constructor.name;
  }
  return undefined;
}

function getErrorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (e.cause !== null && typeof e.cause === 'object') {
    const cause = e.cause as { code?: unknown };
    if (typeof cause.code === 'string') return cause.code;
  }
  return undefined;
}

/**
 * Extract an HTTP status code from a Vercel AI SDK `AI_APICallError` or
 * any error that carries a `statusCode` / `status` field.
 */
function getHttpStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

// ── redactCredentials ───────────────────────────────────────────────────────

/** AWS Access Key IDs are exactly `AKIA` + 16 uppercase alphanumerics. */
const ACCESS_KEY_ID_PATTERN = /AKIA[0-9A-Z]{16}/g;

/**
 * 40-character base64url-ish run, the canonical shape of an AWS Secret
 * Access Key. Anchored with non-alphanumeric / non-`/+=` boundaries so
 * we don't chop a substring out of a longer token.
 */
const SECRET_KEY_CANDIDATE_PATTERN = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;

/**
 * Strip AWS credential fingerprints from `s`.
 *
 * Removes:
 *
 * - `AKIA[0-9A-Z]{16}` Access Key ID literals
 * - 40-character secret-access-key candidates (`[A-Za-z0-9/+=]{40}` bounded
 *   by non-alphanumeric / non-`/+=` characters)
 * - Optional `live` credential values (access key id, secret access key,
 *   session token) — when provided, every literal occurrence of those
 *   strings is replaced before the pattern-based scrub runs, so even
 *   secret values that don't match the canonical pattern are removed.
 *
 * Pure and total. Returns the original input untouched when no
 * substring matches.
 *
 * @param s     The candidate string (typically an SDK error message).
 * @param live  Optional in-memory credentials whose literal values must
 *              be scrubbed out, even if they don't match the canonical
 *              pattern (Requirement 10.9).
 */
export function redactCredentials(s: string, live?: BedrockCredentials): string {
  if (typeof s !== 'string' || s.length === 0) return s;

  let out = s;

  if (live) {
    // Scrub the longest values first so a session token that contains
    // an access key id substring is replaced as a unit.
    const literals = [live.session_token, live.secret_access_key, live.access_key_id]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .sort((a, b) => b.length - a.length);

    // Literal replacement: replace each secret with an empty string so that
    // even single-character secrets are fully removed without risk of
    // re-introduction via the replacement text itself.
    for (const literal of literals) {
      out = replaceAllLiteral(out, literal, '');
    }
  }

  // Pattern-based scrub runs after literals so the canonical AWS shapes
  // that survive the literal pass (or appear without being in `live`) are
  // also removed.
  out = out.replace(ACCESS_KEY_ID_PATTERN, '[REDACTED]');
  out = out.replace(SECRET_KEY_CANDIDATE_PATTERN, '[REDACTED]');

  return out;
}

/**
 * Replace every literal occurrence of `needle` in `haystack` with
 * `replacement`. `String.prototype.split(needle).join(replacement)`
 * avoids regex special-character escaping.
 */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  return haystack.split(needle).join(replacement);
}
