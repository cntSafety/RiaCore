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
/** Longest annotation preview used as a label before it is elided. */
const ANNOTATION_PREVIEW_LENGTH = 60;

/**
 * Extract a human-readable node name from concept-instance attributes.
 *
 * For requirements prefer `req_name` over technical IDs.
 * For safety notes return a short preview from `note_text`.
 * For SysML annotations return a short preview from `body`.
 */
export function extractNodeName(attrs: Record<string, unknown>, concept?: string): string {
  const normalizedConcept = (concept ?? '').toLowerCase();

  if (normalizedConcept === 'requirement' || normalizedConcept === 'safety_requirement') {
    const reqName = attrs.req_name;
    if (typeof reqName === 'string' && reqName.trim().length > 0) {
      return reqName;
    }
  }

  if (normalizedConcept === 'safety_note') {
    const noteText = attrs.note_text;
    if (typeof noteText === 'string' && noteText.trim().length > 0) {
      return noteText.trim().slice(0, 10);
    }
  }

  // SysML `doc` / `comment` annotations are written without a name in nearly
  // every model, so their `name` is one the importer supplied for identity —
  // `$doc`, or the JSON importer's id-suffixed stable path. Neither says
  // anything, and there is no shortage of them in one tree, so the text itself
  // is the only label that distinguishes one from the next. A `$` prefix is the
  // textual importer's marker for a supplied name and cannot occur in a SysML
  // identifier, so an author-declared `doc Rationale` still wins.
  if (normalizedConcept === 'documentation' || normalizedConcept === 'comment') {
    const declared = [attrs.name, attrs.declared_name].find(
      (value): value is string =>
        typeof value === 'string' && value.length > 0 && !value.startsWith('$'),
    );
    if (declared) return declared;

    const body = attrs.body;
    if (typeof body === 'string' && body.trim().length > 0) {
      const preview = body.replace(/\s+/g, ' ').trim();
      if (preview.length <= ANNOTATION_PREVIEW_LENGTH) return preview;

      // Elide on a word boundary when there is one late enough to still leave a
      // readable label; a cut mid-word reads like a corrupted name.
      const clipped = preview.slice(0, ANNOTATION_PREVIEW_LENGTH);
      const lastSpace = clipped.lastIndexOf(' ');
      const stem = lastSpace > ANNOTATION_PREVIEW_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
      return `${stem.trimEnd()}…`;
    }
  }

  const candidates = [
    attrs.title, attrs.req_name, attrs.id, attrs.name, attrs.declared_name,
    attrs.short_name, attrs.has_name, attrs.shortName,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.length > 0);
  if (found) return String(found);

  // Fall back to stable_path but strip the /{concept}/ prefix and @uuid suffix for readability
  const stablePath = typeof attrs.stable_path === 'string' ? attrs.stable_path : '';
  const stem = stablePath.replace(/^\/[^/]+\//, '').replace(/@[^@]+$/, '');
  return stem || stablePath || '';
}
