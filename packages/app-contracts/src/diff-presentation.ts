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
 * Shared presentation vocabulary and text diffing for diff / merge output.
 *
 * Lives in app-contracts, not in the renderer, for the same reason as
 * `shouldBroadcast` in cache-invalidation.ts: two consumers must not drift.
 * The on-screen review (renderer), the archived HTML report (app-core), and the
 * CLI all have to describe the same change set in the same words — a report that
 * labels a concept differently from the screen it was exported from is worse
 * than no report.
 *
 * Everything here is pure data and pure functions: no React, no Node, no DOM.
 */

import type { DiffResultSection } from './diff-types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Section vocabulary
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Domain terms for change-set sections.
 *
 * The review screen describes what changed in the user's model, not what changed
 * in the graph that stores it. "Nodes" and "Edges" are storage words.
 *
 * Cross-namespace sections stay deliberately broader than the intra-namespace
 * ones: that set spans allocation (`occurs_at`), traceability
 * (`has_direct_requirements`), and annotation (`has_tag`, `has_notes`), so any
 * single domain noun would misdescribe most of its contents.
 */
export const SECTION_CHIP_LABELS: Record<DiffResultSection, string> = {
  addedNodes:           'Added Elements',
  modifiedNodes:        'Changed Elements',
  deletedNodes:         'Removed Elements',
  addedEdges:           'Added Relationships',
  modifiedEdges:        'Changed Relationships',
  deletedEdges:         'Removed Relationships',
  addedCrossNsEdges:    'Added External Links',
  modifiedCrossNsEdges: 'Changed External Links',
  deletedCrossNsEdges:  'Removed External Links',
  skippedNodes:         'Skipped Elements',
};

export const SECTION_HEADING_LABELS: Record<DiffResultSection, string> = {
  addedNodes:           'Added Elements',
  modifiedNodes:        'Changed Elements',
  deletedNodes:         'Removed Elements',
  addedEdges:           'Added Relationships',
  modifiedEdges:        'Changed Relationships',
  deletedEdges:         'Removed Relationships',
  addedCrossNsEdges:    'Added Links to Other Namespaces',
  modifiedCrossNsEdges: 'Changed Links to Other Namespaces',
  deletedCrossNsEdges:  'Removed Links to Other Namespaces',
  skippedNodes:         'Skipped Elements',
};

/** Chip label for a section, falling back to the raw key for an unknown section. */
export function labelSectionChip(section: DiffResultSection | string): string {
  return SECTION_CHIP_LABELS[section as DiffResultSection] ?? section;
}

/** Heading label for a section, falling back to the raw key for an unknown section. */
export function labelSectionHeading(section: DiffResultSection | string): string {
  return SECTION_HEADING_LABELS[section as DiffResultSection] ?? section;
}

// ═══════════════════════════════════════════════════════════════════════════
// Safety metamodel vocabulary
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Metamodels that share the safety base vocabulary.
 *
 * `SECURITY_ANALYSIS` is deliberately absent: it defines its own concepts
 * (`threat_scenario`, `damage_scenario`, `attack_propagates_to`) and needs its
 * own table rather than a misleading reuse of these labels.
 */
const SAFETY_FAMILY_METAMODELS: ReadonlySet<string> = new Set([
  'SAFETY_ANALYSIS',
  'SYSTEM_SAFETY_ANALYSIS',
  'SOTIF_ANALYSIS',
  'MONITORING_ANALYSIS',
]);

/** True when the safety vocabulary applies to the given metamodel. */
export function isSafetyFamilyMetamodel(metamodel: string): boolean {
  return SAFETY_FAMILY_METAMODELS.has(metamodel);
}

/**
 * Concept type → display label.
 *
 * Keyed lowercase because that is what `NodeSnapshot.conceptType` actually
 * carries — the LinkML class names and the runtime `SAFETY_CONCEPTS` allow-list
 * are both lowercase snake_case. The uppercase aliases below them are retained
 * for callers that pass a legacy identifier form; without them a lookup for
 * `malfunction` fell through to the identity fallback and no label was applied.
 */
export const conceptTypeLabels: Record<string, string> = {
  // Canonical (matches NodeSnapshot.conceptType)
  malfunction:              'Malfunction',
  risk_rating:              'Risk Rating',
  requirement:              'Safety Requirement',
  safety_task:              'Safety Task',
  safety_note:              'Safety Note',
  tag:                      'Tag',
  review_item:              'Review Item',
  functional_insufficiency: 'Functional Insufficiency',
  triggering_condition:     'Triggering Condition',

  // Legacy uppercase aliases
  MALFUNCTION:  'Malfunction',
  RISKRATING:   'Risk Rating',
  SAFETYREQ:    'Safety Requirement',
  SAFETYTASK:   'Safety Task',
  SAFETYNOTE:   'Safety Note',
  TAG:          'Tag',
  REVIEWITEM:   'Review Item',
};

export const attributeKeyLabels: Record<string, string> = {
  has_name:                'Name',
  malfunction_asil:        'ASIL',
  malfunction_description: 'Description',
  has_severity:            'Severity',
  has_occurrence_level:    'Occurrence',
  has_detection_level:     'Detection',
  risk_priority_number:    'RPN',
  risk_rating_note:        'Rating Note',
  task_status:             'Task Status',
  task_type:               'Task Type',
  task_responsible:        'Responsible',
  task_description:        'Task Description',
  task_reference:          'Reference',
  req_id:                  'Requirement ID',
  req_name:                'Requirement Name',
  req_asil:                'Req. ASIL',
  req_text:                'Requirement Text',
  review_status:           'Review Status',
  reviewer_verdict:        'Verdict',
  reviewer_comment:        'Reviewer Comment',
  author_status:           'Author Status',
  author_comment:          'Author Comment',
  tag_color:               'Tag Color',
  tag_description:         'Tag Description',
  note_text:               'Note',
  fi_description:          'Insufficiency Description',
  fi_source:               'Insufficiency Source',
  tc_description:          'Condition Description',
  tc_source:               'Condition Source',
};

export const relationshipTypeLabels: Record<string, string> = {
  has_safety_tasks:               'Linked Safety Task',
  has_safety_requirements:        'Linked Requirement',
  has_direct_requirements:        'Direct Requirement Link',
  propagates_to:                  'Propagates To',
  has_notes:                      'Note Attached',
  has_tag:                        'Tag Attached / Removed',
  has_review:                     'Review Item',
  occurs_at:                      'Occurs At',
  has_risk_rating:                'Risk Rating',
  has_functional_insufficiencies: 'Functional Insufficiency',
  has_triggering_conditions:      'Triggering Condition',
};

/** Translate a concept type identifier, falling back to the raw string. */
export function labelConceptType(raw: string, metamodel: string): string {
  if (!isSafetyFamilyMetamodel(metamodel)) return raw;
  return Object.prototype.hasOwnProperty.call(conceptTypeLabels, raw)
    ? conceptTypeLabels[raw]
    : raw;
}

/** Translate an attribute key, falling back to the raw string. */
export function labelAttributeKey(raw: string, metamodel: string): string {
  if (!isSafetyFamilyMetamodel(metamodel)) return raw;
  return Object.prototype.hasOwnProperty.call(attributeKeyLabels, raw)
    ? attributeKeyLabels[raw]
    : raw;
}

/** Translate a relationship type identifier, falling back to the raw string. */
export function labelRelationshipType(raw: string, metamodel: string): string {
  if (!isSafetyFamilyMetamodel(metamodel)) return raw;
  return Object.prototype.hasOwnProperty.call(relationshipTypeLabels, raw)
    ? relationshipTypeLabels[raw]
    : raw;
}

// ═══════════════════════════════════════════════════════════════════════════
// Word-level text diff
// ═══════════════════════════════════════════════════════════════════════════

export type SegmentKind = 'same' | 'added' | 'removed';

export interface Segment {
  text: string;
  kind: SegmentKind;
}

export interface WordDiff {
  /** Segments for the left value: `same` and `removed` only. */
  left: Segment[];
  /** Segments for the right value: `same` and `added` only. */
  right: Segment[];
  /** False when the two inputs are identical token-for-token. */
  changed: boolean;
  /**
   * True when every added and removed segment consists purely of whitespace.
   *
   * Such a change is real — the stored value differs — but invisible in prose:
   * a trailing newline, a doubled space, or a non-breaking space swapped for a
   * plain one. Without this flag a row reads as a false positive: marked
   * `modified`, yet both sides look identical.
   */
  whitespaceOnly: boolean;
}

/**
 * Upper bound on the LCS table, in cells.
 *
 * The algorithm is O(n·m), and attribute values are not always prose — a
 * `service_account_json` or a pasted specification can run to thousands of
 * tokens, where an unbounded table would stall the caller. 250k cells is a
 * ~500×500-token diff, far beyond any human-readable paragraph, and costs 1 MB.
 * Past it, `diffWords` declines the work and the caller renders plain text:
 * degraded readability beats a frozen UI or a hung export.
 */
export const MAX_LCS_CELLS = 250_000;

/**
 * Split into words and whitespace runs, keeping both so that concatenating the
 * tokens reproduces the input exactly. Keeping whitespace as its own token also
 * keeps highlight runs tight: only the changed word is marked, not the spaces
 * around it.
 */
function tokenize(value: string): string[] {
  return value.split(/(\s+)/).filter((token) => token.length > 0);
}

/** Coalesce neighbouring segments of the same kind to keep output small. */
function coalesce(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.kind === segment.kind) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

/** Classic LCS backtrack over two token arrays. */
function lcsDiff(a: string[], b: string[]): { left: Segment[]; right: Segment[] } {
  const n = a.length;
  const m = b.length;
  const width = m + 1;

  // dp[i][j] = length of the LCS of a[i..] and b[j..]
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const left: Segment[] = [];
  const right: Segment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push({ text: a[i], kind: 'same' });
      right.push({ text: b[j], kind: 'same' });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      left.push({ text: a[i], kind: 'removed' });
      i += 1;
    } else {
      right.push({ text: b[j], kind: 'added' });
      j += 1;
    }
  }
  while (i < n) {
    left.push({ text: a[i], kind: 'removed' });
    i += 1;
  }
  while (j < m) {
    right.push({ text: b[j], kind: 'added' });
    j += 1;
  }

  return { left, right };
}

/**
 * Diff two strings at word granularity.
 *
 * Returns `null` when the pair is too large to diff within `MAX_LCS_CELLS` —
 * the caller must fall back to rendering the values unhighlighted.
 *
 * Identical leading and trailing tokens are peeled off before the LCS runs. That
 * is not only a speed-up: the common real case is an edit inside otherwise
 * untouched prose, so peeling usually shrinks the table to a fraction of its
 * nominal size and keeps the pair under the cell budget.
 */
export function diffWords(left: string, right: string): WordDiff | null {
  const a = tokenize(left);
  const b = tokenize(right);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);

  if ((aMid.length + 1) * (bMid.length + 1) > MAX_LCS_CELLS) return null;

  const mid = lcsDiff(aMid, bMid);

  // The peeled head and tail are identical on both sides, so either array works.
  const headSegments: Segment[] = a.slice(0, head).map((text) => ({ text, kind: 'same' }));
  const tailSegments: Segment[] = a
    .slice(a.length - tail)
    .map((text) => ({ text, kind: 'same' }));

  const leftSegments = coalesce([...headSegments, ...mid.left, ...tailSegments]);
  const rightSegments = coalesce([...headSegments, ...mid.right, ...tailSegments]);

  const changedSegments = [
    ...leftSegments.filter((s) => s.kind === 'removed'),
    ...rightSegments.filter((s) => s.kind === 'added'),
  ];

  return {
    left: leftSegments,
    right: rightSegments,
    changed: changedSegments.length > 0,
    whitespaceOnly:
      changedSegments.length > 0 && changedSegments.every((s) => /^\s+$/.test(s.text)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering changed text: when to make whitespace visible
// ═══════════════════════════════════════════════════════════════════════════

/** A run of characters within a changed segment, ready to render. */
export interface ChangedTextPart {
  text: string;
  /** True when this run is whitespace that should be drawn as a visible glyph. */
  mark: boolean;
  /** Glyph to draw instead of `text` when `mark` is true. */
  glyph?: string;
  /** Codepoint name for whitespace with no dedicated glyph, e.g. `U+00A0`. */
  label?: string;
}

const WHITESPACE_GLYPHS: Record<string, string> = {
  ' ': '·',
  '\t': '⇥',
  '\n': '↵',
  '\r': '␍',
};

/**
 * Split a changed segment into runs, deciding which whitespace to make visible.
 *
 * Marking *all* whitespace turns ordinary prose edits into dot soup
 * (`Create·tickets·checklist`), so a glyph is drawn only where it carries
 * information:
 *
 *  - tabs, carriage returns, and whitespace with no dedicated glyph are always
 *    marked — they are invisible and easily confused with a plain space
 *    (`U+00A0` being the classic offender);
 *  - newlines are always marked, since a line break inside a highlighted run is
 *    otherwise indistinguishable from soft wrapping;
 *  - a run of two or more spaces is marked, because the count is meaningful and
 *    unreadable otherwise;
 *  - a single space is marked only when the whole change is whitespace — the
 *    case where nothing else would be visible at all.
 *
 * Shared so the on-screen review and the exported report mark the same things.
 */
export function splitChangedTextForDisplay(
  text: string,
  whitespaceOnlyChange: boolean,
): ChangedTextPart[] {
  const parts: ChangedTextPart[] = [];
  let index = 0;

  const pushPlain = (value: string) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && !last.mark) last.text += value;
    else parts.push({ text: value, mark: false });
  };

  while (index < text.length) {
    const char = text[index];

    if (!/\s/.test(char)) {
      pushPlain(char);
      index += 1;
      continue;
    }

    // Measure the run of this exact whitespace character.
    let runEnd = index;
    while (runEnd < text.length && text[runEnd] === char) runEnd += 1;
    const runLength = runEnd - index;

    const isPlainSpace = char === ' ';
    const mark = !isPlainSpace || runLength > 1 || whitespaceOnlyChange;

    if (!mark) {
      pushPlain(text.slice(index, runEnd));
    } else {
      const glyph = WHITESPACE_GLYPHS[char];
      for (let i = 0; i < runLength; i += 1) {
        parts.push(glyph
          ? { text: char, mark: true, glyph }
          : {
              text: char,
              mark: true,
              glyph: '␣',
              label: `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
            });
      }
    }

    index = runEnd;
  }

  return parts;
}

/**
 * Diff a pair of property values if — and only if — highlighting is meaningful.
 *
 * Returns `null` for anything that is not a modification between two strings:
 * an added or deleted attribute has only one side to show, and word-diffing
 * `4` against `5`, or two JSON blobs, produces noise rather than insight.
 */
export function diffPropertyValues(
  changeKind: 'added' | 'deleted' | 'modified',
  leftValue: unknown,
  rightValue: unknown,
): WordDiff | null {
  if (changeKind !== 'modified') return null;
  if (typeof leftValue !== 'string' || typeof rightValue !== 'string') return null;
  const result = diffWords(leftValue, rightValue);
  // Whitespace is tokenized like any other content, so a whitespace-only edit is
  // still reported and still highlighted — the value really did change, and a
  // marked space says so more honestly than showing nothing. `changed` therefore
  // only filters byte-identical values, which a 'modified' change should not
  // contain in the first place.
  return result && result.changed ? result : null;
}
