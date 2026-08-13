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
 * IPC channel handlers for the LLM component review feature.
 *
 * Registers four channels:
 *
 * - `llm.getSettings`  — read persisted LLM settings (never credentials)
 * - `llm.saveSettings` — persist settings + encrypted credentials
 * - `llm.startReview`  — orchestrate a Review_Run (fire-and-forget stream)
 * - `llm.cancelReview` — abort an in-flight run (idempotent)
 *
 * The handler composes the pure helpers from `packages/app-core/src/llm/`
 * and the injected service dependencies to implement the full Review_Run
 * lifecycle without mutating the safety database or persistor
 * (Requirement 8.11).
 *
 * @see Requirements 1.2, 1.3, 1.6, 2.1, 4.6, 8.1–8.8, 8.11, 9.1–9.6,
 *      10.1–10.11, 11.1–11.4, 11.11, 13.1, 13.3, 14.1, 14.3, 14.4, 14.6
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  LlmReviewProfile,
  MetamodelProfileMetadata,
  ProfileReviewInstructions,
} from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';

import { resolveReviewProfile } from '../../llm/profile.js';
import { classifyError, redactCredentials } from '../../llm/error-classifier.js';
import {
  collectContextElements_swArxml,
  collectContextElements_sysml,
} from '../../llm/context-collectors.js';
import { buildElementSafetyBundle } from '../../llm/element-bundle.js';
import { loadFmListOnce } from '../../llm/fm-list.js';
import { buildSystemPrompt } from '../../llm/system-prompts.js';
import { buildUserPrompt } from '../../llm/prompt-assembly.js';
import { pushStreamEvent, consumePumpedStream } from '../../llm/llm-stream.js';
import { createLanguageModel } from '../../llm/provider-factory.js';
import { ReviewRunRegistry } from '../../llm/review-run-registry.js';

/**
 * Register all four `llm.*` channels on the provided registry.
 *
 * The handler uses a module-scoped {@link ReviewRunRegistry} so that
 * `llm.cancelReview` can reach in-flight runs registered by earlier
 * `llm.startReview` invocations on the same dispatcher. Tests may
 * override via `deps.reviewRunRegistry`.
 */
export function registerLlmChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  const CATEGORY = 'llm';

  /**
   * Module-scoped registry shared between `startReview` and
   * `cancelReview`. Overridable via `deps.reviewRunRegistry` for tests.
   */
  const defaultRegistry = new ReviewRunRegistry();

  // ── llm.getSettings ─────────────────────────────────────────────────────────

  registry.register('llm.getSettings', async (_payload, deps, _ctx) => {
    if (!deps.llmSettingsStore) {
      throw new Error('LLM settings store not configured');
    }
    const { settings } = await deps.llmSettingsStore.load();
    return settings;
  }, { requiresWorkspace: false, category: CATEGORY });

  // ── llm.saveSettings ────────────────────────────────────────────────────────

  registry.register('llm.saveSettings', async (payload, deps, _ctx) => {
    if (!deps.llmSettingsStore) {
      throw new Error('LLM settings store not configured');
    }
    // Delegate entirely to the store; store-level errors propagate as
    // JS Error to the renderer (IPC contract: throw on failure).
    await deps.llmSettingsStore.save(payload);
  }, { requiresWorkspace: false, category: CATEGORY });

  // ── llm.startReview ─────────────────────────────────────────────────────────

  registry.register('llm.startReview', async (payload, deps, _ctx) => {
    const reviewRegistry = deps.reviewRunRegistry ?? defaultRegistry;
    const webContents = deps.llmStreamSink;

    if (!webContents) {
      throw new Error('LLM stream sink not configured');
    }

    const runId = randomUUID();
    const abort = new AbortController();

    // Register the run immediately so cancelReview can reach it.
    reviewRegistry.register(runId, { abort, webContents, profile: 'sw_arxml' });

    // Helper: emit a single error event, clean up, and return { runId }.
    const emitErrorAndReturn = (
      code: Parameters<typeof pushStreamEvent>[2]['type'] extends 'error' ? never : string,
      message: string,
    ) => {
      pushStreamEvent(webContents, runId, { type: 'error', code, message });
      reviewRegistry.delete(runId);
      return { runId };
    };

    // 1. Resolve the namespace's metamodel → Review_Profile
    let profile: LlmReviewProfile;
    try {
      const nsRows = await deps.dbModule.runQuery(
        `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
         OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
         RETURN coalesce(mm.name, ns.metamodel) AS metamodel`,
        { namespace: payload.namespace },
      );

      if (nsRows.length === 0) {
        return emitErrorAndReturn('unknown', `Namespace '${payload.namespace}' not found`);
      }

      const metamodel = String(nsRows[0]?.metamodel ?? '');
      const resolved = resolveReviewProfile(metamodel);
      if (resolved === null) {
        return emitErrorAndReturn(
          'unknown',
          `Metamodel '${metamodel}' is not supported for LLM review`,
        );
      }
      profile = resolved;
    } catch (err) {
      return emitErrorAndReturn(
        'unknown',
        `Failed to resolve review profile: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Update the registry entry with the resolved profile.
    reviewRegistry.register(runId, { abort, webContents, profile });

    // 2. Load settings and credentials.
    //
    // When the main process (Electron host) intercepts `llm.startReview`,
    // it decrypts credentials via `safeStorage` and injects them into the
    // payload as `__injectedCredentials` / `__injectedSettings`. This lets
    // the worker (which has no access to `safeStorage`) proceed without
    // needing its own `LlmSettingsStore` configured for decryption.
    //
    // When `deps.llmSettingsStore` IS available (CLI path, tests), the
    // handler uses it directly as before.
    const injectedCreds = (payload as any).__injectedCredentials;
    const injectedSettings = (payload as any).__injectedSettings;

    let settings: import('@riacore/app-contracts').LlmSettings;
    let creds: import('@riacore/app-contracts').AnyProviderCredentials;

    if (injectedCreds && injectedSettings) {
      // Main process already decrypted — use injected values directly.
      settings = injectedSettings;
      creds = injectedCreds;
    } else if (deps.llmSettingsStore) {
      // Fallback: use the settings store (CLI / test path).
      let encryptedBlob: Buffer | null;
      try {
        const loaded = await deps.llmSettingsStore.load();
        settings = loaded.settings;
        encryptedBlob = loaded.encryptedBlob;
      } catch (err) {
        return emitErrorAndReturn(
          'unknown',
          `Failed to load LLM settings: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!settings.has_credentials || !encryptedBlob) {
        return emitErrorAndReturn(
          'no_credentials',
          'No LLM credentials configured. Open Settings to add them.',
        );
      }

      // 3. Decrypt credentials; classify decrypt errors
      try {
        creds = await deps.llmSettingsStore.loadCredentials();
      } catch {
        return emitErrorAndReturn(
          'decrypt_failed',
          'Stored LLM credentials could not be decrypted. Re-enter them in Settings.',
        );
      }
    } else {
      return emitErrorAndReturn('no_credentials', 'No LLM credentials configured. Open Settings to add them.');
    }

    // 4. Collect context elements
    let contextRefs: Awaited<ReturnType<typeof collectContextElements_swArxml>>;
    try {
      console.log(`[LLM] startReview: collecting context elements for profile=${profile}, nodeId=${payload.nodeId}, namespace=${payload.namespace}`);
      contextRefs = profile === 'sw_arxml'
        ? await collectContextElements_swArxml(payload.nodeId, payload.namespace, deps)
        : await collectContextElements_sysml(payload.nodeId, payload.namespace, deps);
      console.log(`[LLM] startReview: collected ${contextRefs.length} context elements`);
    } catch (err) {
      console.error(`[LLM] startReview: context collection FAILED:`, err instanceof Error ? err.message : String(err));
      return emitErrorAndReturn(
        'unknown',
        `Failed to collect context elements: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 5. Build bundles
    if (!deps.instanceService) {
      return emitErrorAndReturn('unknown', 'Instance service not configured');
    }
    if (!deps.safetyCommands) {
      return emitErrorAndReturn('unknown', 'Safety commands not configured');
    }

    const bundleDeps = {
      dbModule: deps.dbModule,
      instanceService: deps.instanceService,
      safetyCommands: deps.safetyCommands,
    };

    let selectedBundle: Awaited<ReturnType<typeof buildElementSafetyBundle>>;
    let contextBundles: Awaited<ReturnType<typeof buildElementSafetyBundle>>[];
    try {
      // Build the selected element's ref from the payload.
      // The bundle assembler will fetch the full instance data internally.
      const selectedRef = {
        nodeId: payload.nodeId,
        namespace: payload.namespace,
        concept: '', // Will be resolved by the bundle assembler via getInstance
        name: '',
        stablePath: '',
      };
      selectedBundle = await buildElementSafetyBundle(selectedRef, profile, bundleDeps);
      contextBundles = await Promise.all(
        contextRefs.map((ref) => buildElementSafetyBundle(ref, profile, bundleDeps)),
      );
    } catch (err) {
      return emitErrorAndReturn(
        'unknown',
        `Failed to assemble safety bundles: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 6. Load FM_List (sw_arxml only)
    let fmList: unknown | null = null;
    if (profile === 'sw_arxml') {
      try {
        const profileRoot = deps.profileRoot ?? resolveDefaultProfileRoot();
        fmList = await loadFmListOnce(profileRoot);
      } catch (err) {
        return emitErrorAndReturn(
          'unknown',
          `Failed to load FM_List: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 7. Build prompts. The checklist is resolved from the *active safety
    //    analysis metamodel* the review was launched from (payload.reviewMetamodel),
    //    not from the reviewed element's own metamodel — the element selects the
    //    structural profile, the active analysis selects the review checklist.
    const checklist = await loadReviewChecklist(deps, payload.reviewMetamodel);
    const system = buildSystemPrompt(profile, checklist);
    const user = buildUserPrompt(profile, selectedBundle, contextBundles, fmList);

    // 8. Create the language model via the provider factory.
    //    `deps.llmModel` is an optional test seam — tests inject a fake
    //    LanguageModel directly so they don't need real AWS credentials.
    const model = deps.llmModel ?? await createLanguageModel(settings, creds);

    // 9. Push 'start' event immediately
    pushStreamEvent(webContents, runId, {
      type: 'start',
      model_id: settings.model_id,
      region: settings.region,
      review_profile: profile,
    });

    // 10. Fire-and-forget the streaming pump
    void consumePumpedStream(
      {
        model,
        system,
        user,
        abortSignal: abort.signal,
        maxOutputTokens: (settings as import('@riacore/app-contracts').LlmSettings).max_output_tokens,
      },
      (chunk) => {
        pushStreamEvent(webContents, runId, { type: 'text', delta: chunk.delta });
      },
    )
      .then(({ usage }) => {
        if (usage) {
          pushStreamEvent(webContents, runId, {
            type: 'usage',
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
          });
        }
        pushStreamEvent(webContents, runId, { type: 'done' });
      })
      .catch((err: unknown) => {
        const code = classifyError(err);
        const rawMessage = err instanceof Error ? (err.message ?? '') : String(err);
        const message = redactCredentials(rawMessage, creds as import('@riacore/app-contracts').BedrockCredentials | undefined);
        pushStreamEvent(webContents, runId, { type: 'error', code, message });
      })
      .finally(() => {
        reviewRegistry.delete(runId);
      });

    // Return synchronously after the SDK call begins (Requirement 8.3).
    return { runId };
  }, { requiresWorkspace: true, category: CATEGORY });

  // ── llm.cancelReview ────────────────────────────────────────────────────────

  registry.register('llm.cancelReview', async (payload, deps, _ctx) => {
    const reviewRegistry = deps.reviewRunRegistry ?? defaultRegistry;
    // Idempotent: no-op if runId is unknown, never throws (Requirement 9.5, 9.6).
    reviewRegistry.cancel(payload.runId);
  }, { requiresWorkspace: false, category: CATEGORY });

  // ── llm.testConnection ──────────────────────────────────────────────────────
  // Handled in the main process (ipc-relay.ts) because it needs safeStorage
  // for credential decryption. This registration is a no-op fallback for the
  // worker dispatcher (CLI path).
  registry.register('llm.testConnection', async (_payload, _deps, _ctx) => {
    throw new Error('llm.testConnection must be handled in the main process');
  }, { requiresWorkspace: false, category: CATEGORY });

  // ── llm.dryRun ────────────────────────────────────────────────────────────
  // Performs all steps of startReview (profile resolution, context collection,
  // bundle assembly, prompt building) but stops before calling Bedrock.
  // Returns the assembled prompts for inspection.
  registry.register('llm.dryRun', async (payload, deps, _ctx) => {
    // 1. Resolve profile
    const nsRows = await deps.dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
       OPTIONAL MATCH (ns)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
       RETURN coalesce(mm.name, ns.metamodel) AS metamodel`,
      { namespace: payload.namespace },
    );

    if (nsRows.length === 0) {
      return { profile: 'sw_arxml' as const, contextElementCount: 0, systemPrompt: '', userPrompt: '', model_id: '', region: '', error: `Namespace '${payload.namespace}' not found` };
    }

    const metamodel = String(nsRows[0]?.metamodel ?? '');
    const profile = resolveReviewProfile(metamodel);
    if (profile === null) {
      return { profile: 'sw_arxml' as const, contextElementCount: 0, systemPrompt: '', userPrompt: '', model_id: '', region: '', error: `Metamodel '${metamodel}' is not supported for LLM review` };
    }

    // 2. Load settings (for model_id / region display)
    const injectedSettings = (payload as any).__injectedSettings;
    const settings = injectedSettings ?? (deps.llmSettingsStore ? (await deps.llmSettingsStore.load()).settings : { region: 'unknown', model_id: 'unknown' });

    // 3. Collect context elements
    let contextRefs: Awaited<ReturnType<typeof collectContextElements_swArxml>>;
    try {
      console.log(`[LLM DryRun] Collecting context elements for profile=${profile}, nodeId=${payload.nodeId}`);
      contextRefs = profile === 'sw_arxml'
        ? await collectContextElements_swArxml(payload.nodeId, payload.namespace, deps)
        : await collectContextElements_sysml(payload.nodeId, payload.namespace, deps);
      console.log(`[LLM DryRun] Collected ${contextRefs.length} context elements`);
    } catch (err) {
      return { profile, contextElementCount: 0, systemPrompt: '', userPrompt: '', model_id: settings.model_id, region: settings.region, error: `Failed to collect context elements: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 4. Build bundles
    if (!deps.instanceService || !deps.safetyCommands) {
      return { profile, contextElementCount: contextRefs.length, systemPrompt: '', userPrompt: '', model_id: settings.model_id, region: settings.region, error: 'Instance service or safety commands not configured' };
    }

    const bundleDeps = { dbModule: deps.dbModule, instanceService: deps.instanceService, safetyCommands: deps.safetyCommands };
    let selectedBundle: Awaited<ReturnType<typeof buildElementSafetyBundle>>;
    let contextBundles: Awaited<ReturnType<typeof buildElementSafetyBundle>>[];
    try {
      const selectedRef = { nodeId: payload.nodeId, namespace: payload.namespace, concept: '', name: '', stablePath: '' };
      selectedBundle = await buildElementSafetyBundle(selectedRef, profile, bundleDeps);
      contextBundles = await Promise.all(
        contextRefs.map((ref) => buildElementSafetyBundle(ref, profile, bundleDeps)),
      );
    } catch (err) {
      return { profile, contextElementCount: contextRefs.length, systemPrompt: '', userPrompt: '', model_id: settings.model_id, region: settings.region, error: `Failed to assemble safety bundles: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 5. Load FM_List (sw_arxml only)
    let fmList: unknown | null = null;
    if (profile === 'sw_arxml') {
      try {
        const profileRoot = deps.profileRoot ?? resolveDefaultProfileRoot();
        fmList = await loadFmListOnce(profileRoot);
      } catch (err) {
        return { profile, contextElementCount: contextRefs.length, systemPrompt: '', userPrompt: '', model_id: settings.model_id, region: settings.region, error: `Failed to load FM_List: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // 6. Build prompts (checklist resolved from the active safety-analysis metamodel).
    const checklist = await loadReviewChecklist(deps, payload.reviewMetamodel);
    const systemPrompt = buildSystemPrompt(profile, checklist);
    const userPrompt = buildUserPrompt(profile, selectedBundle, contextBundles, fmList);

    return {
      profile,
      contextElementCount: contextRefs.length,
      systemPrompt,
      userPrompt,
      model_id: settings.model_id,
      region: settings.region,
    };
  }, { requiresWorkspace: true, category: CATEGORY });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load the authored review checklist for a safety-analysis metamodel.
 *
 * Reads the immutable `profile_metadata` snapshot persisted on
 * `RIA_META_Metamodel` at profile registration and returns its
 * `review.instructions` — the exact same checklist the renderer's "Review
 * Instructions" button renders via `metamodel.getProfileMetadata`.
 *
 * Resilient by design: a missing `reviewMetamodel`, an unregistered metamodel,
 * a metamodel without a checklist, or a malformed snapshot all resolve to
 * `null`, in which case the review falls back to the base profile prompt. A
 * checklist must never break an otherwise-valid Review_Run.
 */
async function loadReviewChecklist(
  deps: { dbModule: { runQuery: (q: string, p: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> } },
  reviewMetamodel: string | undefined,
): Promise<ProfileReviewInstructions | null> {
  if (!reviewMetamodel) return null;
  try {
    const rows = await deps.dbModule.runQuery(
      `MATCH (m:RIA_META_Metamodel)
       WHERE m.name = $metamodel
       RETURN m.profile_metadata AS metadata`,
      { metamodel: reviewMetamodel },
    );
    const raw = rows[0]?.metadata;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const parsed = JSON.parse(raw) as Partial<MetamodelProfileMetadata>;
    return parsed.review?.instructions ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the default `profileRoot` by walking up from this module's
 * directory to find `packages/profiles`. This mirrors the resolution
 * strategy used by `profile-registry.ts`.
 *
 * In the compiled output this file lives at:
 *   `packages/app-core/dist/dispatch/handlers/llm-channels.js`
 * We need to reach:
 *   `packages/profiles/`
 *
 * The same candidate-list approach used by `profile-registry.ts` is
 * applied here so the resolution works in dev, CI, and packaged builds.
 */
function resolveDefaultProfileRoot(): string {
  const envRoot = process.env.RIACORE_PROFILES_ROOT;
  if (envRoot) return envRoot;

  // __dirname is dist/dispatch/handlers/ in the compiled output.
  // In packaged builds the layout is:
  //   app/node_modules/@riacore/app-core/dist/dispatch/handlers/   ← __dirname
  //   app/profiles/                                                 ← target (6 levels up)
  // In dev:
  //   packages/app-core/dist/dispatch/handlers/                    ← __dirname
  //   packages/profiles/                                            ← target (4 levels up)
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'profiles'),                       // 3 levels (fallback)
    path.resolve(__dirname, '..', '..', '..', '..', 'profiles'),                 // 4 levels — dev layout
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'profiles'),           // 5 levels (intermediate)
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'profiles'),     // 6 levels — packaged layout
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
