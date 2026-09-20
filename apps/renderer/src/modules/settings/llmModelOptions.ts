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
import type { LlmProvider } from '@riacore/app-contracts';

// Suggestions, not a whitelist. Keep existing/custom saved IDs intact.
// Verified 2026-09-20 against the providers' catalogs:
// https://developers.openai.com/api/docs/models/all
// https://platform.claude.com/docs/en/models/overview
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html
export const MODEL_OPTIONS: Record<LlmProvider, { value: string }[]> = {
  bedrock: [
    { value: 'eu.anthropic.claude-sonnet-5' },
    { value: 'us.anthropic.claude-sonnet-5' },
    { value: 'eu.anthropic.claude-sonnet-4-6' },
    { value: 'eu.anthropic.claude-opus-4-7' },
    { value: 'eu.amazon.nova-2-lite-v1:0' },
    { value: 'us.amazon.nova-2-lite-v1:0' },
  ],
  anthropic: [
    { value: 'claude-sonnet-5' },
    { value: 'claude-opus-5' },
    { value: 'claude-fable-5-1' },
    { value: 'claude-haiku-4-5-20251001' },
  ],
  openai: [
    { value: 'gpt-6-astra' },
    { value: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna' },
  ],
  'google-vertex': [
    { value: 'gemini-3.8-flash' },
    { value: 'gemini-3.5-flash' },
    { value: 'gemini-3.5-flash-lite' },
    { value: 'gemini-3.1-flash-lite' },
    { value: 'gemini-2.5-pro' },
  ],
  // Ollama's dropdown is populated from the local server. This is only the
  // initial value used while switching providers, before discovery completes.
  ollama: [{ value: 'gemma3:4b-it-qat' }],
};
