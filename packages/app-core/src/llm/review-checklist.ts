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
 * Renders a profile's authored review checklist
 * ({@link ProfileReviewInstructions}) into a deterministic Markdown block for
 * injection into the LLM review System_Prompt.
 *
 * This is the bridge that makes the AI pre-review use the *same* per-metamodel
 * checklist the human "Review Instructions" button shows — one source of
 * truth, authored in each profile's LinkML overlay under
 * `annotations.profile_review.instructions`.
 *
 * The renderer is a pure, total function: it iterates sections, bullets, and
 * catalog items strictly in authored (array) order, so two calls with a
 * structurally-equal `instructions` value produce byte-identical output. This
 * keeps System_Prompt determinism structural — see `buildSystemPrompt`.
 */

import type {
  ProfileReviewInstructions,
  ProfileReviewCatalog,
} from '@riacore/app-contracts';

const HEADING = '## Metamodel-Specific Review Checklist';

function renderCatalog(catalog: ProfileReviewCatalog): string[] {
  const lines: string[] = [`**${catalog.title}:**`];
  for (const item of catalog.items) {
    const measures = item.measures ? ` (Measures: ${item.measures})` : '';
    lines.push(`- **${item.name}** — ${item.description}${measures}`);
  }
  return lines;
}

/**
 * Render the checklist as an ordered set of Markdown blocks separated by a
 * blank line, headed by {@link HEADING}. Returns the empty string when the
 * checklist has no sections (nothing to inject).
 */
export function renderReviewChecklistSection(
  instructions: ProfileReviewInstructions,
): string {
  if (instructions.sections.length === 0) return '';

  const blocks: string[] = [];
  blocks.push(HEADING);
  blocks.push(
    `The following checklist ("${instructions.title}") is authored for this specific safety-analysis type ` +
      `and defines what to focus on when reviewing this element. Treat it as the authoritative review ` +
      `criteria for this run; where it adds detail beyond the general guidance above, follow the checklist. ` +
      `Ground every finding in the supplied data only.`,
  );

  for (const section of instructions.sections) {
    blocks.push(`### ${section.title}`);
    for (const paragraph of section.paragraphs) blocks.push(paragraph);
    if (section.bullets && section.bullets.length > 0) {
      blocks.push(section.bullets.map((bullet) => `- ${bullet}`).join('\n'));
    }
    if (section.catalogs) {
      for (const catalogId of section.catalogs) {
        const catalog = instructions.catalogs.find((entry) => entry.id === catalogId);
        if (catalog) blocks.push(renderCatalog(catalog).join('\n'));
      }
    }
    if (section.note) blocks.push(`_${section.note}_`);
  }

  return blocks.join('\n\n');
}
