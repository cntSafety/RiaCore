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
import type { LlmSettings } from '@riacore/app-contracts';

// Standard USD / million text tokens, checked 2026-09-20. Exact IDs only:
// unrecognised models must never inherit another model's price.
// https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
// https://cloud.google.com/vertex-ai/generative-ai/pricing
const RATES: Record<string, Record<string, readonly [number, number]>> = {
  openai: {
    'gpt-6-astra': [10, 50],
    'gpt-5.6-sol': [4, 20],
    'gpt-5.6-terra': [2, 12],
    'gpt-5.6-luna': [0.2, 1.2],
  },
  anthropic: {
    'claude-sonnet-5': [2, 10],
    'claude-opus-5': [5, 25],
    'claude-fable-5-1': [10, 50],
    'claude-haiku-4-5-20251001': [1, 5],
    'claude-sonnet-4-6': [3, 15],
    'claude-sonnet-4-5': [3, 15],
    'claude-opus-4-5': [5, 25],
  },
  'google-vertex': {
    'gemini-3.5-flash': [1.5, 9],
    'gemini-3.5-flash-lite': [0.3, 2.5],
    'gemini-3.1-flash-lite': [0.25, 1.5],
    'gemini-2.5-pro': [1.25, 10],
  },
};

export const ASSUMED_OUTPUT_TOKENS = 2000;
export const PRICING_CHECKED_ON = '2026-09-20';

export function estimateReviewCost(
  settings: Pick<LlmSettings, 'provider' | 'base_url'> | undefined,
  modelId: string,
  inputChars: number,
  region: string,
  now = new Date(),
) {
  const inputTokens = Math.ceil(inputChars / 4);
  const provider = settings?.provider;
  // Do not apply first-party pricing to an OpenAI-compatible custom endpoint.
  const customEndpoint = provider === 'openai' && settings?.base_url?.trim()
    && !/^https:\/\/api\.openai\.com\/v1\/?$/.test(settings.base_url.trim());
  let rates = provider && !customEndpoint ? RATES[provider]?.[modelId] : undefined;
  if (provider === 'google-vertex' && modelId === 'gemini-3.8-flash') {
    // Published introductory rate ends on 2026-12-31.
    rates = now < new Date('2027-01-01T00:00:00Z') ? [0.75, 3.75] : [1.5, 7.5];
  }
  // Long-context prices are not covered by this small rate table.
  if (inputTokens > 200_000) rates = undefined;
  const regionalMultiplier = provider === 'google-vertex'
    && modelId.startsWith('gemini-3.') && region !== 'global' ? 1.1 : 1;
  const inputRate = rates ? rates[0] * regionalMultiplier : null;
  const outputRate = rates ? rates[1] * regionalMultiplier : null;
  return {
    inputTokens,
    inputRate,
    outputRate,
    cost: inputRate !== null && outputRate !== null
      ? (inputTokens * inputRate + ASSUMED_OUTPUT_TOKENS * outputRate) / 1_000_000
      : null,
  };
}
