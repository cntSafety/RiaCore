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
import type { ReviewExportData, SafetyDetailExportData } from '@riacore/app-contracts';

const flatten = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Keep the same authored fields in the Excel cells and RST directive bodies. */
export function formatSotifDetails(details: SafetyDetailExportData[] = []): string {
  return details.map(detail => [
    `Name: ${flatten(detail.name)}`,
    `Description: ${flatten(detail.description)}`,
    `Source: ${flatten(detail.source)}`,
  ].join('\n')).join('\n\n');
}

// ── Review workflow labels ───────────────────────────────────────────────────
//
// The report should read the way the review UI reads, not the way the database
// stores it. The authoritative label set lives in the safety profile
// (`packages/profiles/_base/safety-analysis-base.linkml.yaml`, surfaced to the UI
// via `useSafetyProfileMetadata`); these maps mirror it for the export path so
// the generator stays pure and free of profile lookups.
//
// Unrecognized values pass through unchanged rather than being dropped — a
// profile can add a verdict without silently losing it from the report.

const VERDICT_LABELS: Record<string, string> = {
  OK: 'OK',
  NOK: 'Not OK',
  OK_with_comment: 'Note',
};

const AUTHOR_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_analysis: 'In Analysis',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

export function verdictLabel(raw: string | undefined): string {
  const value = flatten(raw);
  return value ? (VERDICT_LABELS[value] ?? value) : '';
}

export function authorStatusLabel(raw: string | undefined): string {
  const value = flatten(raw);
  return value ? (AUTHOR_STATUS_LABELS[value] ?? value) : '';
}

/**
 * Flat `Label: value` rendering of review items, for Excel cells where a single
 * string is all a cell can hold.
 *
 * Empty fields are omitted entirely instead of emitting a bare label, and the
 * legacy `review_status` field is not rendered at all — it is hardcoded to
 * `open` at creation and carries no information (see the `review_status` slot
 * description in the safety profile).
 */
export function formatReviewsPlain(reviews: ReviewExportData[] = []): string {
  return reviews.map(review => {
    const fields: string[] = [];
    const push = (label: string, value: string) => {
      if (value) fields.push(`${label}: ${value}`);
    };

    push('Title', flatten(review.name));
    push('Verdict', verdictLabel(review.verdict));
    push('Comment', flatten(review.reviewerComment));
    push('Author Status', authorStatusLabel(review.authorStatus));
    push('Resolution', flatten(review.authorComment));

    return fields.join('\n');
  }).filter(block => block.length > 0).join('\n\n');
}

// ── RST review thread rendering ──────────────────────────────────────────────

/**
 * Normalize authored text for use inside an RST line block: every source line
 * becomes its own `| ` line so the break survives, and blank lines collapse.
 *
 * Note: authored text is emitted verbatim, with no RST escaping. That matches
 * how this generator already handles descriptions, requirement text and note
 * bodies — inline markup characters in authored content are passed through.
 */
function lineBlockLines(value: string, indent: string): string[] {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => `${indent}| ${line}`);
}

/** A verdict / status token, rendered as an inline literal so themes can chip it. */
function token(label: string): string {
  return label ? ` \`\`${label}\`\`` : '';
}

/**
 * Render review items as a reviewer/author thread.
 *
 * Emitted as a sibling `container` block rather than inside the malfunction
 * directive body: nesting it in the body collapses the fields into a single
 * paragraph, and a sibling container can be styled as a footer pane of the need
 * card (see the `mf-reviews` rules in the consuming project's CSS).
 *
 * Deliberately carries no heading and no review title — the thread is a
 * secondary element attached to the malfunction, not a titled section.
 *
 * Returns '' when there is nothing to render, so callers can skip the block.
 */
export function renderReviewsRst(
  reviews: ReviewExportData[] = [],
  containerClass = 'mf-reviews',
): string {
  const blocks: string[][] = [];

  for (const review of reviews) {
    const verdict = verdictLabel(review.verdict);
    const comment = flatten(review.reviewerComment);
    const status = authorStatusLabel(review.authorStatus);
    const resolution = flatten(review.authorComment);

    // A review with no reviewer content and no author response has nothing to
    // show; rendering it would emit an empty bordered pane.
    if (!verdict && !comment && !status && !resolution) continue;

    const block: string[] = ['   .. container:: mf-review', ''];
    block.push(`      | **Reviewer**${token(verdict)}`);
    if (comment) block.push(...lineBlockLines(comment, '      '));

    if (status || resolution) {
      block.push('', '      .. container:: mf-review-answer', '');
      block.push(`         | **Author**${token(status)}`);
      if (resolution) block.push(...lineBlockLines(resolution, '         '));
    }

    blocks.push(block);
  }

  if (blocks.length === 0) return '';

  const lines: string[] = [`.. container:: ${containerClass}`, ''];
  blocks.forEach((block, index) => {
    if (index > 0) lines.push('');
    lines.push(...block);
  });

  return lines.join('\n');
}
