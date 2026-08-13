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
import type { ConceptBatch, RelationshipBatch, ImportDiagnostic } from '@riacore/app-contracts';
import type { ParsedNeedsModel } from './sn-parser.js';
import { parseLinkToken } from './sn-parser.js';

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function stablePathOf(id: string): string {
  return `/need/${id}`;
}

function docNameOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || '_uncategorized';
}

function docStablePathOf(docname: string): string {
  return `/doc/${docname}`;
}

export function mapModelToConceptBatches(model: ParsedNeedsModel): ConceptBatch[] {
  const byConcept = new Map<string, ConceptBatch['items']>();
  const documents = new Map<string, ConceptBatch['items'][number]>();

  for (const need of model.needs) {
    const concept = `need_${normalizeName(need.type)}`;
    const list = byConcept.get(concept) ?? [];
    const attrs = { ...need.attributes, stable_path: stablePathOf(need.id), id: need.id, type: need.type };
    list.push({ stablePath: stablePathOf(need.id), attributes: attrs });
    byConcept.set(concept, list);

    const docname = docNameOf(need.attributes.docname);
    if (!documents.has(docname)) {
      documents.set(docname, {
        stablePath: docStablePathOf(docname),
        attributes: {
          id: docname,
          title: docname,
          docname,
          stable_path: docStablePathOf(docname),
        },
      });
    }
  }

  if (documents.size > 0) {
    byConcept.set('need_document', [...documents.values()]);
  }

  return [...byConcept.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([concept, items]) => ({ concept, items }));
}

export function mapModelToRelationshipBatches(
  model: ParsedNeedsModel,
): { batches: RelationshipBatch[]; diagnostics: ImportDiagnostic[]; skippedElements: Map<string, number> } {
  const existingIds = new Set(model.needs.map((n) => n.id));
  const byRelationship = new Map<string, RelationshipBatch['items']>();
  const diagnostics: ImportDiagnostic[] = [];
  const skippedElements = new Map<string, number>();
  const dedupe = new Set<string>();

  for (const need of model.needs) {
    const docname = docNameOf(need.attributes.docname);
    const containmentList = byRelationship.get('contains_need') ?? [];
    const sourceStablePath = docStablePathOf(docname);
    const targetStablePath = stablePathOf(need.id);
    const containmentKey = `contains_need|${sourceStablePath}|${targetStablePath}`;
    if (!dedupe.has(containmentKey)) {
      dedupe.add(containmentKey);
      containmentList.push({
        sourceStablePath,
        targetStablePath,
        attributes: { docname },
      });
      byRelationship.set('contains_need', containmentList);
    }

    for (const linkField of model.linkFieldNames) {
      const raw = need.attributes[linkField];
      if (!Array.isArray(raw)) continue;

      const relName = normalizeName(linkField);
      const list = byRelationship.get(relName) ?? [];

      for (const token of raw) {
        const tokenStr = String(token);
        const parsed = parseLinkToken(tokenStr);
        if (!parsed.targetId) continue;

        if (!existingIds.has(parsed.targetId)) {
          const key = `missing_target:${relName}`;
          skippedElements.set(key, (skippedElements.get(key) ?? 0) + 1);
          diagnostics.push({
            level: 'warning',
            message: `Missing target '${parsed.targetId}' for ${relName} from ${need.id}`,
          });
          continue;
        }

        const sourceStablePath = stablePathOf(need.id);
        const targetStablePath = stablePathOf(parsed.targetId);
        const dedupeKey = `${relName}|${sourceStablePath}|${targetStablePath}|${parsed.condition ?? ''}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);

        list.push({
          sourceStablePath,
          targetStablePath,
          attributes: {
            link_field: linkField,
            raw_token: tokenStr,
            ...(parsed.condition ? { link_condition: parsed.condition } : {}),
          },
        });
      }

      byRelationship.set(relName, list);
    }
  }

  const batches: RelationshipBatch[] = [...byRelationship.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([relationship, items]) => ({ relationship, items }));

  return { batches, diagnostics, skippedElements };
}
