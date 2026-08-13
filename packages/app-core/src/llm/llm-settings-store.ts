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
 * Persistent store for {@link LlmSettings} and per-provider encrypted
 * credential blobs.
 *
 * On-disk layout under the host-supplied `userDataDir`:
 *
 * - `llm-settings.json`              — plaintext UTF-8 JSON; non-secret fields only.
 * - `llm-credentials-bedrock.bin`    — encrypted Bedrock IAM credentials.
 * - `llm-credentials-anthropic.bin`  — encrypted Anthropic API key.
 * - `llm-credentials-openai.bin`     — encrypted OpenAI API key.
 * - `llm-credentials-vertex.bin`     — encrypted Google Vertex service-account JSON.
 *
 * One blob per provider so switching providers does not wipe the other
 * provider's stored credentials. All files live OUTSIDE any workspace
 * directory so credentials are never committed to git.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  AnyProviderCredentials,
  BedrockCredentials,
  AnthropicCredentials,
  OpenAiCredentials,
  GoogleVertexCredentials,
  LlmProvider,
  LlmSaveSettingsInput,
  LlmSettings,
} from '@riacore/app-contracts';

// ── Constants ───────────────────────────────────────────────────────────────

export const LLM_SETTINGS_FILENAME = 'llm-settings.json';

/** @deprecated Kept for backward-compat exports only. Use CREDENTIAL_FILENAMES. */
export const LLM_CREDENTIALS_FILENAME = 'llm-credentials-bedrock.bin';

const CREDENTIAL_FILENAMES: Record<LlmProvider, string> = {
  bedrock:         'llm-credentials-bedrock.bin',
  anthropic:       'llm-credentials-anthropic.bin',
  openai:          'llm-credentials-openai.bin',
  'google-vertex': 'llm-credentials-vertex.bin',
  ollama:          'llm-credentials-ollama.bin', // unused — Ollama has no secrets
};

/** @deprecated Legacy single-blob filename — migrated on first load. */
const LEGACY_CREDENTIALS_FILENAME = 'llm-credentials.bin';

export const DEFAULT_LLM_SETTINGS: LlmSettings = Object.freeze({
  provider: 'bedrock' as LlmProvider,
  region: 'eu-west-1',
  model_id: 'eu.anthropic.claude-sonnet-4-6',
  has_credentials: false,
});

// ── Test seam ───────────────────────────────────────────────────────────────

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface LlmSettingsStoreOptions {
  safeStorage: SafeStorageLike;
  userDataDir: () => string;
}

// ── Internal persisted shape ─────────────────────────────────────────────────

interface PersistedLlmSettings {
  provider: LlmProvider;
  model_id: string;
  region?: string;
  project?: string;
  base_url?: string;
  max_output_tokens?: number;
  ollama_num_ctx?: number;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class LlmSettingsStore {
  private readonly safeStorage: SafeStorageLike;
  private readonly userDataDir: () => string;

  constructor(opts: LlmSettingsStoreOptions) {
    this.safeStorage = opts.safeStorage;
    this.userDataDir = opts.userDataDir;
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  private settingsPath(): string {
    return path.join(this.userDataDir(), LLM_SETTINGS_FILENAME);
  }

  private credentialsPath(provider: LlmProvider): string {
    return path.join(this.userDataDir(), CREDENTIAL_FILENAMES[provider]);
  }

  private legacyCredentialsPath(): string {
    return path.join(this.userDataDir(), LEGACY_CREDENTIALS_FILENAME);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Read the persisted settings. Returns defaults when no file exists.
   * `has_credentials` reflects whether a blob exists for the active provider.
   * Migrates the legacy single-blob file to the per-provider layout on first load.
   */
  async load(): Promise<{ settings: LlmSettings; encryptedBlob: Buffer | null }> {
    await this.migrateLegacyBlob();

    const persisted = await this.readPersistedSettings();
    const provider: LlmProvider = persisted?.provider ?? 'bedrock';
    const encryptedBlob = await this.readEncryptedBlob(provider);

    const settings: LlmSettings = {
      provider,
      model_id: persisted?.model_id ?? DEFAULT_LLM_SETTINGS.model_id,
      region: persisted?.region ?? (provider === 'bedrock' ? 'eu-west-1' : undefined),
      project: persisted?.project,
      base_url: persisted?.base_url ?? (provider === 'ollama' ? 'http://localhost:11434/v1' : undefined),
      max_output_tokens: persisted?.max_output_tokens,
      ollama_num_ctx: persisted?.ollama_num_ctx,
      // Ollama needs no credentials — treat it as always ready.
      has_credentials: provider === 'ollama' ? true : encryptedBlob !== null,
    };

    return { settings, encryptedBlob };
  }

  /**
   * Decrypt and return the stored credentials for the active provider.
   * Throws when no blob exists or decryption fails.
   */
  async loadCredentials(): Promise<AnyProviderCredentials> {
    const { settings } = await this.load();
    const blob = await this.readEncryptedBlob(settings.provider);
    if (blob === null) throw new Error('No stored LLM credentials.');
    return this.decryptCredentials(blob);
  }

  /**
   * Persist settings and (if credentials are supplied) the encrypted blob
   * for the active provider. Credentials for other providers are untouched.
   */
  async save(input: LlmSaveSettingsInput): Promise<void> {
    if (input.provider === 'local') {
      throw new Error('Local LLM provider is not yet implemented.');
    }

    // Ollama and other local providers have no secrets to encrypt.
    // Skip the safeStorage check and credential blob entirely.
    const needsCredentials = input.provider !== 'ollama';

    if (needsCredentials && !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('This operating system does not provide a secure credential store.');
    }

    // Persist non-secret settings.
    const persisted: PersistedLlmSettings = {
      provider: input.provider,
      model_id: input.model_id,
      ...(input.region ? { region: input.region } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.base_url ? { base_url: input.base_url } : {}),
      ...(input.max_output_tokens ? { max_output_tokens: input.max_output_tokens } : {}),
      ...(input.ollama_num_ctx ? { ollama_num_ctx: input.ollama_num_ctx } : {}),
    };
    await this.writeSettingsFile(persisted);

    // Persist credentials for the active provider (skipped for Ollama).
    if (needsCredentials) {
      const newBlob = await this.resolveCredentialBlob(input);
      if (newBlob !== null) {
        await this.writeCredentialsBlob(input.provider, newBlob);
      }
    }
  }

  // ── Credential resolution ─────────────────────────────────────────────────

  private async resolveCredentialBlob(
    input: LlmSaveSettingsInput,
  ): Promise<Buffer | null> {
    const provider = input.provider as LlmProvider;

    switch (provider) {
      case 'bedrock':
        return this.resolveBedrockBlob(input);

      case 'anthropic':
      case 'openai': {
        const apiKey = (input.api_key ?? '').trim();
        if (apiKey === '') return null; // keep existing blob
        const creds: AnthropicCredentials | OpenAiCredentials = { api_key: apiKey };
        return this.safeStorage.encryptString(JSON.stringify(creds));
      }

      case 'google-vertex': {
        const json = (input.service_account_json ?? '').trim();
        if (json === '') return null;
        const creds: GoogleVertexCredentials = { service_account_json: json };
        return this.safeStorage.encryptString(JSON.stringify(creds));
      }

      case 'ollama':
        // No credentials to store for local providers.
        return null;
    }
  }

  private async resolveBedrockBlob(input: LlmSaveSettingsInput): Promise<Buffer | null> {
    const submittedSecret = input.secret_access_key ?? '';
    const submittedSession = input.session_token;
    const submittedKeyId = input.access_key_id ?? '';

    if (submittedSecret !== '') {
      const priorCreds = await this.loadBedrockCredentialsSafe();
      const next: BedrockCredentials = {
        access_key_id: submittedKeyId,
        secret_access_key: submittedSecret,
      };
      if (submittedSession && submittedSession !== '') {
        next.session_token = submittedSession;
      } else if (priorCreds?.session_token) {
        next.session_token = priorCreds.session_token;
      }
      return this.safeStorage.encryptString(JSON.stringify(next));
    }

    // Empty secret — partial update.
    const priorCreds = await this.loadBedrockCredentialsSafe();
    if (priorCreds === null) return null;

    if (submittedKeyId !== '' && submittedKeyId !== priorCreds.access_key_id) {
      throw new Error('Access Key ID changed; please also re-enter the Secret Access Key.');
    }

    const next: BedrockCredentials = {
      access_key_id: priorCreds.access_key_id,
      secret_access_key: priorCreds.secret_access_key,
    };
    if (submittedSession && submittedSession !== '') {
      next.session_token = submittedSession;
    } else if (priorCreds.session_token) {
      next.session_token = priorCreds.session_token;
    }
    return this.safeStorage.encryptString(JSON.stringify(next));
  }

  private async loadBedrockCredentialsSafe(): Promise<BedrockCredentials | null> {
    const blob = await this.readEncryptedBlob('bedrock');
    if (blob === null) return null;
    try {
      const creds = this.decryptCredentials(blob);
      if (isBedrockCredentials(creds)) return creds;
    } catch { /* ignore */ }
    return null;
  }

  // ── Legacy migration ──────────────────────────────────────────────────────

  private async migrateLegacyBlob(): Promise<void> {
    const legacyPath = this.legacyCredentialsPath();
    const newPath = this.credentialsPath('bedrock');
    try {
      const legacyBlob = await fs.readFile(legacyPath);
      try { await fs.access(newPath); return; } catch { /* new file absent — proceed */ }
      await fs.mkdir(this.userDataDir(), { recursive: true });
      await fs.writeFile(newPath, legacyBlob);
      await fs.unlink(legacyPath);
    } catch { /* legacy file absent — nothing to migrate */ }
  }

  // ── File helpers ──────────────────────────────────────────────────────────

  private async readPersistedSettings(): Promise<PersistedLlmSettings | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.settingsPath(), 'utf-8');
    } catch (err) {
      if (isFileNotFoundError(err)) return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedLlmSettings(parsed)) {
      throw new Error('Stored LLM settings file is malformed.');
    }
    return parsed;
  }

  private async readEncryptedBlob(provider: LlmProvider): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.credentialsPath(provider));
    } catch (err) {
      if (isFileNotFoundError(err)) return null;
      throw err;
    }
  }

  private decryptCredentials(blob: Buffer): AnyProviderCredentials {
    const json = this.safeStorage.decryptString(blob);
    return JSON.parse(json) as AnyProviderCredentials;
  }

  private async writeSettingsFile(value: PersistedLlmSettings): Promise<void> {
    await fs.mkdir(this.userDataDir(), { recursive: true });
    await fs.writeFile(this.settingsPath(), JSON.stringify(value, null, 2), 'utf-8');
  }

  private async writeCredentialsBlob(provider: LlmProvider, blob: Buffer): Promise<void> {
    await fs.mkdir(this.userDataDir(), { recursive: true });
    await fs.writeFile(this.credentialsPath(provider), blob);
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

const VALID_PROVIDERS = new Set<string>(['bedrock', 'anthropic', 'openai', 'google-vertex', 'ollama']);

function isPersistedLlmSettings(value: unknown): value is PersistedLlmSettings {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.provider === 'string' &&
    VALID_PROVIDERS.has(v.provider) &&
    typeof v.model_id === 'string'
  );
}

function isBedrockCredentials(value: unknown): value is BedrockCredentials {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_key_id === 'string' && typeof v.secret_access_key === 'string';
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
