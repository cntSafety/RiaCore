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
 * Presentation rules for a MergeResult.
 *
 * THE BUG THIS ENCODES
 *
 * The supervised merge-from-branch done panel used to hard-code an
 * unconditional green "Merge Applied" and print four of the seven counters,
 * reading neither `mergeApplied` nor `warnings`. Two failures followed:
 *
 *  - A change the merge service *refused* to apply — most commonly a
 *    cross-namespace relationship whose target element has not been imported
 *    yet — was reported as a success with "edges added: 0", and the warning
 *    explaining why never reached the user.
 *  - A merge that only removed relationships reported all-zero counters,
 *    because `edgesDeleted` was not among the four that were displayed.
 *
 * Extracted from the component so the rules are assertable directly, without
 * driving the whole modal flow to reach the done phase. 
 */

import type { MergeResult } from '@riacore/app-contracts';

/** Every numeric field of MergeResult that the panel accounts for. */
export type MergeResultCounterField =
  | 'nodesAdded'
  | 'nodesModified'
  | 'nodesDeleted'
  | 'edgesAdded'
  | 'edgesModified'
  | 'edgesDeleted'
  | 'skipped';

export interface MergeResultCounter {
  field: MergeResultCounterField;
  label: string;
  value: number;
  /**
   * False for counters that are noise at zero (`skipped` only reflects the
   * user's own cherry-picking). The panel hides these when the value is 0;
   * every other counter is always shown, including at 0, so "nothing was
   * applied" stays legible rather than looking like a missing field.
   */
  alwaysShow: boolean;
}

export interface MergeResultPresentation {
  /** 'success' only when the service both committed and reported no warnings. */
  status: 'success' | 'warning';
  heading: string;
  counters: MergeResultCounter[];
  /** Passed through verbatim — never summarised away, never truncated. */
  warnings: string[];
}

export function describeMergeResult(result: MergeResult): MergeResultPresentation {
  // Both signals are consulted rather than just `mergeApplied`: a partially
  // applied merge should never render as an unqualified success, whichever of
  // the two the service uses to say so.
  const clean = result.mergeApplied && result.warnings.length === 0;

  return {
    status: clean ? 'success' : 'warning',
    heading: clean ? 'Merge Applied' : 'Merge Applied With Warnings',
    counters: [
      { field: 'nodesAdded', label: 'Nodes added', value: result.nodesAdded, alwaysShow: true },
      { field: 'nodesModified', label: 'modified', value: result.nodesModified, alwaysShow: true },
      { field: 'nodesDeleted', label: 'deleted', value: result.nodesDeleted, alwaysShow: true },
      { field: 'edgesAdded', label: 'Relationships added', value: result.edgesAdded, alwaysShow: true },
      { field: 'edgesModified', label: 'modified', value: result.edgesModified, alwaysShow: true },
      { field: 'edgesDeleted', label: 'removed', value: result.edgesDeleted, alwaysShow: true },
      { field: 'skipped', label: 'Skipped (not selected)', value: result.skipped, alwaysShow: false },
    ],
    warnings: [...result.warnings],
  };
}

/** Counters the panel actually renders for a given result. */
export function visibleCounters(presentation: MergeResultPresentation): MergeResultCounter[] {
  return presentation.counters.filter(c => c.alwaysShow || c.value > 0);
}

/**
 * Headline for the warnings block, e.g. "2 changes could not be applied".
 * Returns null when there is nothing to report.
 */
export function warningsHeading(presentation: MergeResultPresentation): string | null {
  const n = presentation.warnings.length;
  if (n === 0) return null;
  return n === 1 ? '1 change could not be applied' : `${n} changes could not be applied`;
}
