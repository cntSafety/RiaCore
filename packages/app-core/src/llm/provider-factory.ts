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
 * Provider factory for the LLM component review feature.
 *
 * Creates a Vercel AI SDK `LanguageModel` for the configured provider.
 * Supported providers:
 *   - `bedrock`        — AWS Bedrock via @ai-sdk/amazon-bedrock
 *   - `anthropic`      — Anthropic direct via @ai-sdk/anthropic
 *   - `openai`         — OpenAI direct via @ai-sdk/openai
 *   - `google-vertex`  — Google Vertex AI via @ai-sdk/google-vertex
 */

import type { LanguageModel } from 'ai';

import type {
  LlmSettings,
  AnyProviderCredentials,
  BedrockCredentials,
  AnthropicCredentials,
  OpenAiCredentials,
  GoogleVertexCredentials,
} from '@riacore/app-contracts';

/**
 * Create a Vercel AI SDK `LanguageModel` for the given provider settings
 * and decrypted credentials.
 *
 * The provider SDK packages (`@ai-sdk/*`, `ai`) are large and pull in
 * transitive dependencies (e.g. `google-auth-library`) that are expensive to
 * load — especially on first access where Windows Defender scans the tree.
 * They are imported **lazily** here, and only the single provider actually
 * selected is loaded, so the worker process startup never pays this cost
 * unless an LLM review is actually run.
 */
export async function createLanguageModel(
  settings: LlmSettings,
  credentials: AnyProviderCredentials,
): Promise<LanguageModel> {
  switch (settings.provider) {
    case 'bedrock': {
      const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
      const creds = credentials as BedrockCredentials;
      const bedrock = createAmazonBedrock({
        region: settings.region ?? 'eu-west-1',
        accessKeyId: creds.access_key_id,
        secretAccessKey: creds.secret_access_key,
        sessionToken: creds.session_token,
      });
      return bedrock(settings.model_id);
    }

    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const creds = credentials as AnthropicCredentials;
      const anthropic = createAnthropic({ apiKey: creds.api_key });
      return anthropic(settings.model_id);
    }

    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const creds = credentials as OpenAiCredentials;
      const openai = createOpenAI({
        apiKey: creds.api_key,
        ...(settings.base_url ? { baseURL: settings.base_url } : {}),
      });
      return openai(settings.model_id);
    }

    case 'google-vertex': {
      const { createVertex } = await import('@ai-sdk/google-vertex');
      const creds = credentials as GoogleVertexCredentials;
      let serviceAccount: Record<string, unknown>;
      try {
        serviceAccount = JSON.parse(creds.service_account_json) as Record<string, unknown>;
      } catch {
        throw new Error('Google Vertex service account JSON is not valid JSON.');
      }
      const vertex = createVertex({
        project: settings.project ?? (serviceAccount.project_id as string | undefined),
        location: settings.region ?? 'us-central1',
        googleAuthOptions: {
          credentials: serviceAccount as Record<string, unknown>,
        },
      });
      return vertex(settings.model_id);
    }

    case 'ollama': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      // Ollama (and LM Studio, llama.cpp, etc.) expose an OpenAI-compatible
      // endpoint. No API key is required — the base URL is the only config.
      // Default to the standard Ollama address if the user left it blank.
      const baseURL = settings.base_url?.trim() || 'http://localhost:11434/v1';
      // NOTE: Ollama's OpenAI-compatible endpoint does not support num_ctx
      // via request body fields. The correct way to set context length is:
      //   1. Use a custom model created with `ollama create` + Modelfile
      //      containing `PARAMETER num_ctx 32768` (recommended)
      //   2. Set OLLAMA_CONTEXT_LENGTH env var and restart Ollama
      // The settings dialog guides users to use the gemma3-riacore model
      // which has num_ctx=32768 baked in.
      const ollama = createOpenAI({
        apiKey: 'ollama', // required by the SDK but ignored by local servers
        baseURL,
      });
      return ollama(settings.model_id);
    }
  }
}

/**
 * @deprecated Use {@link createLanguageModel} instead.
 * Kept for backward compatibility with callers that pass BedrockCredentials directly.
 */
export function createBedrockModel(
  config: { region: string; model_id: string },
  credentials: BedrockCredentials,
): Promise<LanguageModel> {
  return createLanguageModel(
    {
      provider: 'bedrock',
      region: config.region,
      model_id: config.model_id,
      has_credentials: true,
    },
    credentials,
  );
}

// Re-export BedrockModelConfig shape for backward compat
export interface BedrockModelConfig {
  region: string;
  model_id: string;
}
