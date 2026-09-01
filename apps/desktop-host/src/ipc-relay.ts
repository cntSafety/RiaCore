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
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@riacore/app-contracts';
import type { LlmSaveSettingsInput, LlmTestConnectionResult, LlmStartReviewInput, CrossNsLinkSettings } from '@riacore/app-contracts';
import type { LlmSettingsStore } from '@riacore/app-core/dist/llm/llm-settings-store.js';
import { testProviderConnection } from '@riacore/app-core/dist/llm/test-connection.js';
import type { CrossNsLinkSettingsStore } from '@riacore/app-core/dist/settings/cross-ns-link-settings-store.js';
import type { UtilityProcessManager } from './utility-process-manager.js';
import { getAppLogger } from './app-logger.js';

/**
 * Registers `ipcMain.handle` for every channel in `IPC_CHANNELS`,
 * delegating each call to the utility process via the manager.
 *
 * `llm.getSettings`, `llm.saveSettings`, and `llm.testConnection` are
 * handled directly in the main process because they require
 * `Electron.safeStorage` for credential encryption/decryption — the
 * worker child process has no access to it.
 *
 * `crossNsLinkSettings.getSettings` / `crossNsLinkSettings.saveSettings` are
 * also handled here — not because of `safeStorage`, but because they need
 * `app.getPath('userData')`, which is equally main-process-only.
 *
 * This replaces the old `ipc-handlers.ts` which called app-core
 * services directly in the main process.
 *
 * Requirements: 4.4, 4.5, 11.2, 12.4
 */
export function registerIpcRelay(
  manager: UtilityProcessManager,
  settingsStore?: LlmSettingsStore,
  crossNsLinkSettingsStore?: CrossNsLinkSettingsStore,
): void {
  const logger = getAppLogger();

  /** Channels handled in the main process (require safeStorage or app.getPath). */
  const MAIN_PROCESS_CHANNELS = new Set([
    'llm.getSettings',
    'llm.saveSettings',
    'llm.testConnection',
    'llm.startReview',
    'llm.dryRun',
    'crossNsLinkSettings.getSettings',
    'crossNsLinkSettings.saveSettings',
  ]);

  for (const channel of IPC_CHANNELS) {
    if (
      (channel === 'crossNsLinkSettings.getSettings' || channel === 'crossNsLinkSettings.saveSettings')
      && crossNsLinkSettingsStore
    ) {
      const store = crossNsLinkSettingsStore;
      ipcMain.handle(channel, async (_event, payload) => {
        try {
          if (channel === 'crossNsLinkSettings.getSettings') {
            return await store.load();
          }
          await store.save(payload as CrossNsLinkSettings);
          return;
        } catch (error) {
          logger.error('IPC handler failed (main process)', {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });
    } else if (MAIN_PROCESS_CHANNELS.has(channel) && settingsStore) {
      ipcMain.handle(channel, async (_event, payload) => {
        try {
          if (channel === 'llm.getSettings') {
            const { settings } = await settingsStore.load();
            return settings;
          }
          if (channel === 'llm.saveSettings') {
            await settingsStore.save(payload as LlmSaveSettingsInput);
            return;
          }
          if (channel === 'llm.testConnection') {
            return await handleTestConnection(settingsStore);
          }
          if (channel === 'llm.startReview') {
            return await handleStartReview(
              payload as LlmStartReviewInput,
              settingsStore,
              manager,
            );
          }
          if (channel === 'llm.dryRun') {
            // Inject settings so the worker can display model/region
            const { settings } = await settingsStore.load();
            const augmented = { ...(payload as object), __injectedSettings: settings };
            return manager.send('llm.dryRun', augmented as any);
          }
        } catch (error) {
          logger.error('IPC handler failed (main process)', {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });
    } else {
      ipcMain.handle(channel, async (_event, payload) => {
        try {
          return await manager.send(channel, payload);
        } catch (error) {
          logger.error('IPC handler failed', {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });
    }
  }
}

/**
 * Sends a minimal request to the configured provider to verify credentials
 * and connectivity.
 */
async function handleTestConnection(
  settingsStore: LlmSettingsStore,
): Promise<LlmTestConnectionResult> {
  const { settings } = await settingsStore.load();

  // Ollama and other local providers need no credentials — test directly.
  if (settings.provider === 'ollama') {
    return testProviderConnection(settings, {} as any);
  }

  if (!settings.has_credentials) {
    return {
      ok: false,
      model_id: settings.model_id,
      region: settings.region ?? '',
      error: 'No credentials configured. Save your credentials first.',
    };
  }

  let creds: Awaited<ReturnType<typeof settingsStore.loadCredentials>>;
  try {
    creds = await settingsStore.loadCredentials();
  } catch {
    return {
      ok: false,
      model_id: settings.model_id,
      region: settings.region ?? '',
      error: 'Could not decrypt stored credentials. Re-enter them in Settings.',
    };
  }

  return testProviderConnection(settings, creds);
}

/**
 * Handles `llm.startReview` in the main process.
 *
 * The main process decrypts credentials (requires `safeStorage`) and then
 * forwards the request to the worker with the decrypted credentials
 * injected into the payload. The worker performs the DB-heavy work
 * (profile resolution, context collection, bundle assembly, prompt
 * building, Bedrock streaming) and pushes `WorkerLlmStream` messages
 * back to the main process, which relays them to all renderer windows
 * via `webContents.send('llm.stream', event)`.
 *
 * This approach keeps `safeStorage` in the main process while letting
 * the worker access the native DB bindings (which segfault under
 * Electron's modified ABI).
 *
 * Requirements: 8.1, 8.3, 11.2, 12.4
 */
async function handleStartReview(
  payload: LlmStartReviewInput,
  settingsStore: LlmSettingsStore,
  manager: UtilityProcessManager,
): Promise<unknown> {
  const logger = getAppLogger();

  // Load settings and check for credentials.
  const { settings, encryptedBlob } = await settingsStore.load();

  // Ollama needs no credentials — inject settings only and let the worker proceed.
  if (settings.provider === 'ollama') {
    const augmentedPayload = {
      ...payload,
      __injectedCredentials: {},
      __injectedSettings: settings,
    };
    return manager.send('llm.startReview', augmentedPayload as any);
  }

  if (!settings.has_credentials || !encryptedBlob) {
    // The worker handler will emit the appropriate 'no_credentials' error
    // stream event. Forward without credentials so the handler's own
    // error path fires.
    return manager.send('llm.startReview', payload);
  }

  // Decrypt credentials in the main process (has safeStorage access).
  let creds: Awaited<ReturnType<typeof settingsStore.loadCredentials>>;
  try {
    creds = await settingsStore.loadCredentials();
  } catch (err) {
    // Forward without credentials — the worker handler will emit
    // 'decrypt_failed' when it can't load credentials.
    logger.warn('Failed to decrypt LLM credentials in main process; forwarding to worker', {
      error: err instanceof Error ? err.message : String(err),
    });
    return manager.send('llm.startReview', payload);
  }

  // Forward to the worker with decrypted credentials and settings injected.
  // The worker's llm.startReview handler checks for __injectedCredentials
  // and __injectedSettings to skip its own loadCredentials() call.
  const augmentedPayload = {
    ...payload,
    __injectedCredentials: creds,
    __injectedSettings: settings,
  };

  return manager.send('llm.startReview', augmentedPayload as any);
}
