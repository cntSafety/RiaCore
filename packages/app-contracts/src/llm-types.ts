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
 * Shared type definitions for the LLM component review feature.
 *
 * These types cross the IPC boundary between the worker (Electron main /
 * utility process) and the renderer (React UI). The single exception is
 * `BedrockCredentials`, which is a worker-only marker type — plaintext
 * credentials NEVER cross IPC. See Requirement 12 for the full rationale.
 */

// ── Provider / profile ──────────────────────────────────────────────────────

/**
 * Active LLM provider.
 *
 * - `bedrock`        — AWS Bedrock (Converse API, IAM credentials)
 * - `anthropic`      — Anthropic direct (API key)
 * - `openai`         — OpenAI direct (API key)
 * - `google-vertex`  — Google Vertex AI (service-account JSON)
 * - `ollama`         — Local Ollama server (no credentials, OpenAI-compatible)
 *
 * The literal `'local'` is reserved and rejected at save time.
 */
export type LlmProvider = 'bedrock' | 'anthropic' | 'openai' | 'google-vertex' | 'ollama';

/**
 * Review profile resolved from the Selected_Element's namespace metamodel.
 *
 * - `sw_arxml`     ← `SW_ARXML` namespaces (AUTOSAR software components)
 * - `system_sysml` ← `SysMLv2` namespaces (SysML v2 system elements)
 *
 * See Requirement 13 for the resolution rule.
 */
export type LlmReviewProfile = 'sw_arxml' | 'system_sysml';

// ── Settings ────────────────────────────────────────────────────────────────

/** Non-secret AWS Bedrock configuration values. */
export interface BedrockSettings {
  /** AWS region, e.g. `'eu-west-1'`. */
  region: string;
  /** Bedrock model id, e.g. `'eu.anthropic.claude-sonnet-4-6'`. */
  model_id: string;
}

/**
 * The settings shape that crosses the IPC boundary.
 *
 * NEVER contains plaintext credentials — see Requirement 12.4 and
 * Requirement 1.6. The boolean `has_credentials` indicates whether an
 * Encrypted_Credential_Blob currently exists on disk for the active provider.
 *
 * `region` is only meaningful for `bedrock` and `google-vertex`.
 * `base_url` is only meaningful for `openai` (custom endpoint / Azure).
 */
export interface LlmSettings {
  provider: LlmProvider;
  /** AWS region (bedrock) or GCP location (google-vertex). */
  region?: string;
  model_id: string;
  /** Optional custom base URL for OpenAI-compatible endpoints. */
  base_url?: string;
  /** Google Cloud project ID (google-vertex only). */
  project?: string;
  has_credentials: boolean;
  /**
   * Optional cap on output tokens. When set, the review response is limited
   * to this many tokens. Useful for local models (Ollama) where generation
   * speed is the bottleneck. Undefined = no limit.
   */
  max_output_tokens?: number;
  /**
   * Ollama context window size (num_ctx). Defaults to 32768.
   * Ollama's built-in default is only 4096 which truncates long safety-bundle
   * prompts. Injected into every Ollama request via a custom fetch wrapper.
   */
  ollama_num_ctx?: number;
}

/**
 * Renderer → worker payload for `llm.saveSettings`.
 *
 * Credential fields are provider-specific. Empty string means "keep stored value".
 *
 * Bedrock:       access_key_id + secret_access_key + session_token (optional)
 * Anthropic:     api_key
 * OpenAI:        api_key + base_url (optional)
 * Google Vertex: service_account_json (full JSON string)
 */
export interface LlmSaveSettingsInput {
  provider: LlmProvider | 'local';
  model_id: string;
  /** AWS region (bedrock) or GCP location (google-vertex). */
  region?: string;
  /** Google Cloud project ID (google-vertex only). */
  project?: string;
  /** Custom base URL for OpenAI-compatible endpoints. */
  base_url?: string;
  // ── Bedrock credentials ──────────────────────────────────────────────────
  /** Empty string ⇒ keep stored Access Key ID. */
  access_key_id?: string;
  /** Empty string ⇒ keep stored Secret Access Key. */
  secret_access_key?: string;
  /** Empty/undefined ⇒ keep stored Session Token. */
  session_token?: string;
  // ── Anthropic / OpenAI credentials ──────────────────────────────────────
  /** Empty string ⇒ keep stored API key. */
  api_key?: string;
  // ── Google Vertex credentials ────────────────────────────────────────────
  /** Full service-account JSON string. Empty ⇒ keep stored value. */
  service_account_json?: string;
  /**
   * Optional cap on output tokens. Undefined = no limit.
   * Useful for local models (Ollama) where generation speed is the bottleneck.
   */
  max_output_tokens?: number;
  /**
   * Ollama context window size (num_ctx). Defaults to 32768.
   * Ollama's built-in default is only 4096 which truncates long safety-bundle
   * prompts. This value is injected into every request via a custom fetch wrapper.
   */
  ollama_num_ctx?: number;
}

/**
 * Worker-only marker type. The plaintext form of Bedrock_Credentials.
 *
 * This type NEVER crosses the IPC boundary — Requirement 2.7,
 * Requirement 1.6, Requirement 10.9. It exists in `app-contracts` solely
 * so the worker-side store and credential helpers can refer to a single
 * shared shape.
 */
export interface BedrockCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

/** Worker-only. Anthropic direct API credentials. Never crosses IPC. */
export interface AnthropicCredentials {
  api_key: string;
}

/** Worker-only. OpenAI API credentials. Never crosses IPC. */
export interface OpenAiCredentials {
  api_key: string;
}

/** Worker-only. Google Vertex service-account credentials. Never crosses IPC. */
export interface GoogleVertexCredentials {
  service_account_json: string;
}

/** Union of all provider credential shapes. */
export type AnyProviderCredentials =
  | BedrockCredentials
  | AnthropicCredentials
  | OpenAiCredentials
  | GoogleVertexCredentials;

// ── Review run inputs / outputs ─────────────────────────────────────────────

/** Renderer → worker payload for `llm.startReview`. */
export interface LlmStartReviewInput {
  /** `node_id` of the Selected_Element (Eligible_Element_Node). */
  nodeId: number;
  /** Namespace of the Selected_Element. */
  namespace: string;
  /** Client-generated correlation id (e.g. `crypto.randomUUID()`). */
  nonce: string;
  /**
   * Metamodel of the *active authored safety analysis* the review is launched
   * from (e.g. `SAFETY_ANALYSIS`, `SYSTEM_SAFETY_ANALYSIS`, `MONITORING_ANALYSIS`).
   *
   * Distinct from the reviewed element's own namespace metamodel: the element
   * (an SW_ARXML SWC or SysMLv2 part) selects the *structural* Review_Profile,
   * while this field selects the *review checklist* injected into the system
   * prompt — the same per-profile `profile_review.instructions` the "Review
   * Instructions" button renders. Optional; when absent or when the metamodel
   * declares no checklist, the review falls back to the base profile prompt.
   */
  reviewMetamodel?: string;
}

/** Synchronous response from `llm.startReview`. */
export interface LlmStartReviewResult {
  /** Worker-assigned UUID identifying the Review_Run. */
  runId: string;
}

/** Renderer → worker payload for `llm.cancelReview`. */
export interface LlmCancelReviewInput {
  runId: string;
}

/** Result of `llm.testConnection` — a lightweight connectivity check. */
export interface LlmTestConnectionResult {
  /** Whether the connection succeeded. */
  ok: boolean;
  /** Model ID that was tested. */
  model_id: string;
  /** Region that was tested. */
  region: string;
  /** Human-readable error message when `ok === false`. */
  error?: string;
}

/** Renderer → worker payload for `llm.dryRun`. Same shape as startReview. */
export interface LlmDryRunInput {
  nodeId: number;
  namespace: string;
  /**
   * Active authored safety-analysis metamodel whose review checklist is
   * injected into the system prompt. See {@link LlmStartReviewInput.reviewMetamodel}.
   */
  reviewMetamodel?: string;
}

/** Result of `llm.dryRun` — the assembled prompts without calling Bedrock. */
export interface LlmDryRunResult {
  /** Resolved review profile. */
  profile: LlmReviewProfile;
  /** Number of context elements collected. */
  contextElementCount: number;
  /** The system prompt that would be sent. */
  systemPrompt: string;
  /** The user prompt that would be sent. */
  userPrompt: string;
  /** Model and region that would be used. */
  model_id: string;
  region: string;
  /** Error message if dry run failed partway through. */
  error?: string;
}

// ── Stream events (one-way `webContents.send('llm.stream', …)`) ─────────────

/** Discriminator for the {@link LlmStreamEvent} union. */
export type LlmStreamEventType = 'start' | 'text' | 'usage' | 'done' | 'error';

/** Classification of a Review_Run failure (Requirement 10). */
export type LlmErrorCode =
  | 'no_credentials'
  | 'decrypt_failed'
  | 'network'
  | 'model_unavailable'
  | 'rate_limit'
  | 'auth_rejected'
  | 'cancelled'
  | 'unknown';

/** Common base for every stream event — all events carry their `runId`. */
interface LlmStreamEventBase {
  runId: string;
}

/** First event of a Review_Run, pushed as soon as the SDK call begins. */
export interface LlmStreamStartEvent extends LlmStreamEventBase {
  type: 'start';
  model_id: string;
  region: string;
  review_profile: LlmReviewProfile;
}

/** Carries one streamed text delta from the LLM response. */
export interface LlmStreamTextEvent extends LlmStreamEventBase {
  type: 'text';
  delta: string;
}

/** Final-usage metadata pushed once the SDK reports token counts. */
export interface LlmStreamUsageEvent extends LlmStreamEventBase {
  type: 'usage';
  input_tokens: number;
  output_tokens: number;
}

/** Successful end-of-stream marker. */
export interface LlmStreamDoneEvent extends LlmStreamEventBase {
  type: 'done';
}

/** Terminal failure marker; carries a redacted, classified error. */
export interface LlmStreamErrorEvent extends LlmStreamEventBase {
  type: 'error';
  code: LlmErrorCode;
  message: string;
}

/**
 * The full set of events the renderer will observe over `llm.stream`
 * for a given Review_Run.
 */
export type LlmStreamEvent =
  | LlmStreamStartEvent
  | LlmStreamTextEvent
  | LlmStreamUsageEvent
  | LlmStreamDoneEvent
  | LlmStreamErrorEvent;

// ── Result / metadata ───────────────────────────────────────────────────────

/**
 * Review_Run metadata shown in the LLM_Review_Modal.
 *
 * Token counts start as `null` and are populated when the `usage` event
 * arrives. `ended_at` is set when the `done` (or terminal `error`) event
 * arrives.
 */
export interface LlmReviewMetadata {
  model_id: string;
  region: string;
  review_profile: LlmReviewProfile;
  input_tokens: number | null;
  output_tokens: number | null;
  /** ISO-8601 timestamp recorded by the renderer when the run started. */
  started_at: string;
  /** ISO-8601 timestamp recorded by the renderer when the run finished. */
  ended_at: string | null;
}

/** The final accumulated result of a Review_Run as displayed in the modal. */
export interface LlmReviewResult {
  runId: string;
  /** Full concatenated body assembled from every `text` event. */
  text: string;
  metadata: LlmReviewMetadata;
}

// ── Element_Safety_Bundle ───────────────────────────────────────────────────

/**
 * Cross-namespace reference to a safety element.
 *
 * The bundle uses `{ name, uuid }` for cross-namespace references — never
 * the ephemeral numeric `node_id` (Requirement 6.5).
 */
export interface SafetyElementRef {
  name: string;
  uuid: string;
}

/** A malfunction occurring at an element or one of its ports. */
export interface BundleMalfunction {
  name: string;
  uuid: string;
  /** ASIL rating, e.g. `'A' | 'B' | 'C' | 'D' | 'QM'`. */
  asil: string;
  description: string;
  propagations: {
    to: SafetyElementRef[];
    from: SafetyElementRef[];
  };
  linked_safety_notes: SafetyElementRef[];
  linked_safety_requirements: SafetyElementRef[];
  linked_safety_tasks: SafetyElementRef[];
  /** Risk rating attached to this malfunction, or `null` when none exists. */
  risk_rating: {
    severity?: string;
    exposure?: string;
    controllability?: string;
    asil?: string;
    rationale?: string;
  } | null;
}

/** A directly propagated malfunction plus the element it occurs at. */
export interface BundleDirectPropagationMalfunction {
  /** Direction of the direct relation relative to the element-scope malfunction. */
  direction: 'outgoing' | 'incoming';
  /** The malfunction in the selected element scope that the direct edge touches. */
  scope_malfunction: SafetyElementRef;
  /** The neighboring malfunction reached through the direct edge. */
  malfunction: BundleMalfunction;
  /** The structural/model element the neighboring malfunction is attached to. */
  attached_to: (SafetyElementRef & {
    node_id: number;
    namespace: string;
    concept: string;
  }) | null;
}

/** A compact structural child entry for model-element review context. */
export interface BundleOwnedElementStructure {
  node_id: number;
  namespace: string;
  concept: string;
  name: string;
  stable_path: string;
  /** Malfunctions attached directly to this structural element. */
  malfunctions: (SafetyElementRef & {
    asil: string;
    description: string;
  })[];
  owned_elements: BundleOwnedElementStructure[];
}

/** A port on an SWC component (sw_arxml profile only). */
export interface BundlePort {
  port_type: 'p_port' | 'r_port' | 'pr_port';
  name: string;
  malfunctions: BundleMalfunction[];
}

/**
 * The safety analysis bundle for a single Eligible_Element_Node — the
 * Selected_Element or one of its Context_Elements.
 *
 * The `ports` field is present (or an empty array) only for the
 * `sw_arxml` profile; SysML element nodes have no AUTOSAR ports
 * (Requirement 6.4).
 */
export interface ElementSafetyBundle {
  /** Local node id; only used for run-internal references. */
  node_id: number;
  namespace: string;
  /** SWC concept (sw_arxml) or SysML concept (system_sysml). */
  concept: string;
  name: string;
  stable_path: string;
  uuid: string;
  /** Present iff Review_Profile is `sw_arxml`. */
  ports?: BundlePort[];
  /** Malfunctions attached directly to the element (not via a port). */
  malfunctions: BundleMalfunction[];
  /** Direct incoming and outgoing propagates_to neighbors of the element-scope malfunctions. */
  direct_propagation_malfunctions?: BundleDirectPropagationMalfunction[];
  /** Bounded selected-element owned-element tree for model-element review context. */
  owned_element_structure?: BundleOwnedElementStructure[];
  safety_notes: SafetyElementRef[];
  safety_requirements: SafetyElementRef[];
  /** Reserved for future use; always `[]` in v1. */
  risk_ratings: SafetyElementRef[];
}

/**
 * @deprecated Renamed to {@link ElementSafetyBundle}. Kept for one
 * release for callers outside this feature (Requirement 12.7).
 */
export type ComponentSafetyBundle = ElementSafetyBundle;

// ── Concept sets (gating constants) ─────────────────────────────────────────

/**
 * SWC component concepts eligible for the `sw_arxml` Review_Profile.
 * Used by the renderer to gate the right-click menu and by the worker to
 * validate the Selected_Element / Context_Element concept (Requirement 4.2,
 * Requirement 5.1).
 */
export const SWC_COMPONENT_CONCEPTS = [
  'application_swc',
  'composition_swc',
  'service_swc',
  'ecu_abstraction_swc',
  'cdd_swc',
  'sensor_actuator_swc',
  'nv_block_swc',
  'parameter_swc',
  'service_proxy_swc',
] as const;

/**
 * SysML element concepts eligible for the `system_sysml` Review_Profile.
 * Used by the renderer to gate the right-click menu and by the worker as
 * the `$sysmlElementConcepts` Cypher parameter (Requirement 4.3,
 * Requirement 5.2).
 */
export const SYSML_ELEMENT_CONCEPTS = [
  'part_definition',
  'part_usage',
  'action_definition',
  'action_usage',
  'state_definition',
  'state_usage',
  'requirement_definition',
  'requirement_usage',
  'item_definition',
  'item_usage',
] as const;

/** Literal union of every member of {@link SWC_COMPONENT_CONCEPTS}. */
export type SwcComponentConcept = (typeof SWC_COMPONENT_CONCEPTS)[number];

/** Literal union of every member of {@link SYSML_ELEMENT_CONCEPTS}. */
export type SysmlElementConcept = (typeof SYSML_ELEMENT_CONCEPTS)[number];
