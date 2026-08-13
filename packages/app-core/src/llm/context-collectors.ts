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
 * Context_Element collection helpers for the LLM Review_Run feature.
 *
 * For each {@link LlmReviewProfile} the worker handler invokes one of the
 * exported collectors below to produce the deduplicated set of
 * {@link ContextElementRef} entries that surround the Selected_Element:
 *
 * - {@link collectContextElements_swArxml} — Partner_Components reached
 *   through `assembly_connector` or `delegation_connector` edges. Reuses
 *   the existing `arxml.getComponentPortConnectors` traversal via
 *   {@link getComponentPortConnectorsImpl} so that the same upstream
 *   query / dedup / merge logic powers both the diagram and the LLM
 *   bundle assembly (Requirement 5.1, Requirement 6.6).
 * - {@link collectContextElements_sysml} — no separate structural context;
 *   the general model-element profile stores the selected element's bounded
 *   owned-element snapshot in `element-bundle.ts`.
 *
 * Both collectors:
 *
 * - exclude the Selected_Element itself from the returned set;
 * - deduplicate by `node_id` so each Context_Element appears at most
 *   once regardless of how many connector paths reach it;
 * - return an empty array when no Context_Element exists
 *   (Requirement 5.3).
 *
 * The returned shape is camelCase {@link ContextElementRef}, an internal
 * worker-side reference type. Cross-IPC `ElementSafetyBundle` values use
 * the snake_case shape from `@riacore/app-contracts` and are produced
 * downstream by the bundle assembler.
 *
 * @see Requirement 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { getComponentPortConnectorsImpl } from '../dispatch/handlers/arxml-channels.js';

/**
 * Minimal structural slice of {@link ServiceDependencies} that the
 * collectors need.
 *
 * Keeping the constraint local lets these helpers be exercised by tests
 * with a hand-rolled fake `dbModule` without pulling the full
 * dispatcher dependency graph into the test harness.
 */
export interface ContextCollectorDeps {
  dbModule: {
    runQuery: (
      statement: string,
      params?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
  };
}

/**
 * Worker-internal reference to one Context_Element.
 *
 * The shape mirrors the metadata block of {@link ElementSafetyBundle}
 * but uses camelCase since it never crosses the IPC boundary — the
 * downstream bundle assembler is responsible for mapping these refs
 * into the snake_case bundle shape that the renderer consumes.
 */
export interface ContextElementRef {
  /** Local node id (stable for the duration of the run). */
  nodeId: number;
  /** Namespace the element lives in. */
  namespace: string;
  /** Concept literal — SWC concept (sw_arxml) or SysML concept (system_sysml). */
  concept: string;
  /** Human-readable short name (last segment of `stable_path`). */
  name: string;
  /** Full hierarchical path used for deterministic ordering downstream. */
  stablePath: string;
}

// Kept for tests and older imports. SysML review no longer traverses owned
// descendants; data collection is malfunction-scoped in element-bundle.ts.
export const SYSML_OWNS_ELEMENT_DESCENDANTS_QUERY = '';

// ── sw_arxml branch ──────────────────────────────────────────────────────────

/**
 * Collect Context_Elements for the `sw_arxml` profile.
 *
 * Returns the deduplicated set of Partner_Components connected to the
 * Selected_Element via `assembly_connector` or `delegation_connector`
 * edges, excluding the Selected_Element itself.
 *
 * Reuses {@link getComponentPortConnectorsImpl} so that port discovery,
 * malfunction enrichment, and connector deduplication follow the same
 * code path that powers the diagram view (Requirement 5.1, 6.6).
 *
 * Returns an empty array when no partners exist (Requirement 5.3).
 *
 * @see Requirement 5.1, 5.3, 5.4, 5.5
 */
export async function collectContextElements_swArxml(
  selectedNodeId: number,
  selectedNamespace: string,
  deps: ContextCollectorDeps,
): Promise<ContextElementRef[]> {
  let connectorResult;
  try {
    connectorResult = await getComponentPortConnectorsImpl(
      { nodeId: selectedNodeId },
      deps,
    );
  } catch {
    // Node not found or not an SWC type — no context elements.
    return [];
  }

  // Collect all partner owner node IDs from both port sides of every
  // connector, excluding the Selected_Element itself.
  const partners = new Map<number, ContextElementRef>();
  for (const connector of connectorResult.connectors) {
    for (const port of [connector.sourcePort, connector.targetPort]) {
      if (port.ownerNodeId === selectedNodeId) continue;
      if (partners.has(port.ownerNodeId)) continue;
      partners.set(port.ownerNodeId, {
        nodeId: port.ownerNodeId,
        namespace: port.ownerNamespace,
        concept: port.ownerConcept,
        name: port.ownerName,
        stablePath: port.ownerStablePath,
      });
    }
  }

  return [...partners.values()];
}

// ── system_sysml branch ──────────────────────────────────────────────────────

/**
 * The SysML/general review profile intentionally does not collect
 * separate structural context elements. `buildElementSafetyBundle`
 * assembles the selected element's safety bundle, direct propagation
 * neighbors, and bounded owned-element structure snapshot.
 *
 * @param selectedNodeId    `node_id` of the Selected_Element.
 * @param selectedNamespace Namespace of the Selected_Element. Currently
 *                          unused — the variable-length traversal is
 *                          keyed by `node_id` and follows
 *                          cross-namespace edges naturally — but
 *                          accepted for signature parity with
 *                          {@link collectContextElements_swArxml}.
 * @param deps              Service dependencies; only `dbModule.runQuery`
 *                          is consulted.
 *
 * @returns Always an empty array.
 *
 * @see Requirement 5.2, 5.4, 5.6
 */
export async function collectContextElements_sysml(
  selectedNodeId: number,
  selectedNamespace: string,
  deps: ContextCollectorDeps,
): Promise<ContextElementRef[]> {
  // Reserved for signature parity with collectContextElements_swArxml.
  void selectedNodeId;
  void selectedNamespace;
  void deps;
  return [];
}
