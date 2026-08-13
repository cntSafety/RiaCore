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
 * User_Prompt assembly for the LLM component review feature.
 *
 * Builds the dynamic `user`-role message sent to AWS Bedrock for one
 * Review_Run. The output is composed of an ordered set of Markdown
 * sections separated by a blank line:
 *
 * 1. `## Review Scope` — fenced JSON code block summarising the selected
 *    review element and which supplied malfunction sets are review targets.
 * 2. `## Selected Element Safety Data` — fenced JSON code block holding
 *    the Selected_Element's {@link ElementSafetyBundle}.
 * 3. `## Selected Review Element Structure` — fenced JSON code block holding
 *    `selectedBundle.owned_element_structure`. Emitted only when
 *    `profile === 'system_sysml'`.
 * 4. `## Context Elements Safety Data` — fenced JSON code block holding
 *    the array of Context_Element bundles, sorted ascending by
 *    `stable_path`. Emitted only for `profile === 'sw_arxml'` (the
 *    `system_sysml` context array is always empty; its structural context
 *    lives in the Selected Review Element Structure chapter).
 * 5. `## Failure Mode Reference List` — fenced JSON code block holding
 *    the FM_List content. Emitted only when `profile === 'sw_arxml'`
 *    (Requirements 7.4, 14.6).
 * 6. `CLOSING_INSTRUCTION_SW_ARXML` — closing instruction line. Emitted
 *    only for `sw_arxml`. For `system_sysml` the review instructions are
 *    carried entirely by the (checklist-augmented) System_Prompt, so the
 *    prompt ends after the Selected Review Element Structure chapter.
 *
 * Every JSON code block is produced through {@link stableStringify} so
 * that two successive calls with structurally-equal inputs yield
 * byte-identical strings, regardless of input object key insertion
 * order (Requirements 7.5, 7.6, 7.7).
 *
 * Pure module — no I/O, no logging, no global state.
 *
 * @see Requirement 7.4, 7.5, 7.6, 7.7
 */

import type {
  BundleOwnedElementStructure,
  ElementSafetyBundle,
  LlmReviewProfile,
} from '@riacore/app-contracts';

import { stableStringify } from './stable-stringify.js';
import { CLOSING_INSTRUCTION_SW_ARXML } from './system-prompts.js';

/**
 * Lexicographic comparator on UTF-16 code units. Matches the default
 * comparator used by `Array.prototype.sort` for strings, and matches
 * the key-ordering rule used inside {@link stableStringify}, so the
 * sort result is deterministic across runs and across platforms (no
 * dependency on the runtime locale).
 */
function compareStablePathAscending(a: ElementSafetyBundle, b: ElementSafetyBundle): number {
  if (a.stable_path < b.stable_path) return -1;
  if (a.stable_path > b.stable_path) return 1;
  return 0;
}

/**
 * Wrap a JSON-serialised value in a fenced ` ```json ` Markdown code
 * block. The serialisation is delegated to {@link stableStringify} for
 * byte-deterministic output.
 */
function jsonBlock(value: unknown): string {
  return '```json\n' + stableStringify(value) + '\n```';
}

function withoutOwnedElementStructure(bundle: ElementSafetyBundle): ElementSafetyBundle {
  const { owned_element_structure: _ownedElementStructure, ...safetyBundle } = bundle;
  return safetyBundle;
}

interface SelectedReviewElementStructureSection {
  selected_review_element: {
    node_id: number;
    namespace: string;
    concept: string;
    name: string;
    stable_path: string;
    uuid: string;
  };
  owned_elements: BundleOwnedElementStructure[];
}

interface ReviewScopeSection {
  review_profile: LlmReviewProfile;
  selected_review_element: {
    node_id: number;
    namespace: string;
    concept: string;
    name: string;
    stable_path: string;
    uuid: string;
  };
  review_targets: {
    selected_element_malfunctions: { name: string; uuid: string }[];
    direct_propagation_malfunctions: {
      direction: 'outgoing' | 'incoming';
      scope_malfunction: { name: string; uuid: string };
      neighboring_malfunction: { name: string; uuid: string };
      attached_to: {
        node_id: number;
        namespace: string;
        concept: string;
        name: string;
        uuid: string;
      } | null;
    }[];
  };
  context_policy: string;
}

function selectedReviewElementStructureSection(
  bundle: ElementSafetyBundle,
): SelectedReviewElementStructureSection {
  return {
    selected_review_element: {
      node_id: bundle.node_id,
      namespace: bundle.namespace,
      concept: bundle.concept,
      name: bundle.name,
      stable_path: bundle.stable_path,
      uuid: bundle.uuid,
    },
    owned_elements: bundle.owned_element_structure ?? [],
  };
}

function selectedReviewElementMetadata(bundle: ElementSafetyBundle): ReviewScopeSection['selected_review_element'] {
  return {
    node_id: bundle.node_id,
    namespace: bundle.namespace,
    concept: bundle.concept,
    name: bundle.name,
    stable_path: bundle.stable_path,
    uuid: bundle.uuid,
  };
}

function reviewScopeSection(
  profile: LlmReviewProfile,
  selectedBundle: ElementSafetyBundle,
): ReviewScopeSection {
  return {
    review_profile: profile,
    selected_review_element: selectedReviewElementMetadata(selectedBundle),
    review_targets: {
      selected_element_malfunctions: selectedBundle.malfunctions.map((malfunction) => ({
        name: malfunction.name,
        uuid: malfunction.uuid,
      })),
      direct_propagation_malfunctions: (selectedBundle.direct_propagation_malfunctions ?? []).map((entry) => ({
        direction: entry.direction,
        scope_malfunction: entry.scope_malfunction,
        neighboring_malfunction: {
          name: entry.malfunction.name,
          uuid: entry.malfunction.uuid,
        },
        attached_to: entry.attached_to,
      })),
    },
    context_policy: profile === 'system_sysml'
      ? 'Use Selected Review Element Structure as structural context. Review only selected_element_malfunctions and direct_propagation_malfunctions.'
      : 'Use Context Elements Safety Data and Failure Mode Reference List as supporting context for the selected AUTOSAR element review.',
  };
}

/**
 * Assemble the User_Prompt for a Review_Run.
 *
 * @param profile         Resolved Review_Profile for the run; selects the
 *                        FM_List section visibility and the closing
 *                        instruction line.
 * @param selectedBundle  Element_Safety_Bundle of the Selected_Element.
 * @param contextBundles  Element_Safety_Bundles of every Context_Element
 *                        (Partner_Components for `sw_arxml`; empty for
 *                        `system_sysml`, whose structural context lives on
 *                        `selectedBundle.owned_element_structure`).
 *                        May be empty.
 * @param fmList          Parsed FM_List content for the `sw_arxml`
 *                        profile, or `null` for `system_sysml` (the
 *                        argument is ignored when the profile is not
 *                        `sw_arxml`).
 *
 * @returns The assembled User_Prompt string.
 *
 * @see Requirement 7.4, 7.5, 7.6, 7.7
 */
export function buildUserPrompt(
  profile: LlmReviewProfile,
  selectedBundle: ElementSafetyBundle,
  contextBundles: ElementSafetyBundle[],
  fmList: unknown | null,
): string {
  // Copy before sorting so the caller's array is never mutated.
  const sortedContexts = [...contextBundles].sort(compareStablePathAscending);

  const sections: string[] = [];

  sections.push('## Review Scope\n' + jsonBlock(reviewScopeSection(profile, selectedBundle)));

  const selectedSafetyBundle = profile === 'system_sysml'
    ? withoutOwnedElementStructure(selectedBundle)
    : selectedBundle;
  sections.push('## Selected Element Safety Data\n' + jsonBlock(selectedSafetyBundle));

  if (profile === 'system_sysml') {
    sections.push(
      '## Selected Review Element Structure\n' +
      jsonBlock(selectedReviewElementStructureSection(selectedBundle)),
    );
  }

  if (profile === 'sw_arxml') {
    // Context Elements (Partner_Components) and the Failure Mode Reference
    // List are meaningful only for the AUTOSAR profile; the closing
    // instruction is sw_arxml-specific. For `system_sysml`, structural
    // context lives in the Selected Review Element Structure chapter, the
    // Context Elements array is always empty, and the review instructions
    // are carried by the (checklist-augmented) System_Prompt — so none of
    // these three trailing sections are emitted.
    sections.push('## Context Elements Safety Data\n' + jsonBlock(sortedContexts));
    sections.push('## Failure Mode Reference List\n' + jsonBlock(fmList));
    sections.push(CLOSING_INSTRUCTION_SW_ARXML);
  }

  return sections.join('\n\n');
}
