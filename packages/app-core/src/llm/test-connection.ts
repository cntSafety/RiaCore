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
 * Lightweight connectivity check for the configured LLM provider.
 *
 * Sends a minimal prompt to the model and returns whether the call
 * succeeded. Used by `llm.testConnection` in the main process.
 *
 * Lives in `app-core` so `desktop-host` does not need a direct
 * dependency on the `ai` package.
 */

import type { AnyProviderCredentials, LlmSettings, LlmTestConnectionResult } from '@riacore/app-contracts';
import { createLanguageModel } from './provider-factory.js';

/**
 * Send a minimal prompt to the configured model to verify credentials
 * and network connectivity. Uses maxOutputTokens=4 to minimise cost.
 */
export async function testProviderConnection(
  settings: LlmSettings,
  credentials: AnyProviderCredentials,
): Promise<LlmTestConnectionResult> {
  try {
    // Lazy-load the AI SDK so it is only pulled in when a connection test
    // is actually run, not at module/worker startup.
    const { generateText } = await import('ai');
    const model = await createLanguageModel(settings, credentials);
    await generateText({
      model,
      prompt: 'Reply with exactly: ok',
      maxOutputTokens: 4,
    });
    return {
      ok: true,
      model_id: settings.model_id,
      region: settings.region ?? '',
    };
  } catch (err) {
    return {
      ok: false,
      model_id: settings.model_id,
      region: settings.region ?? '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @deprecated Use {@link testProviderConnection} instead.
 */
export { testProviderConnection as testBedrockConnection };
