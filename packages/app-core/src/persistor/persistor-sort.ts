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
 * Persistor sort functions for deterministic, diff-friendly JSON output.
 */

import type { NodeKeyAttrMap, EdgeKeyAttrMap } from './persistor-types.js';
import { parseAttrs } from './persistor-helpers.js';

/**
 * Sort cross-namespace relationship instances by a stable composite key
 * derived from row content rather than ephemeral DB-assigned edge_id.
 *
 * Sort order: source_namespace → target_namespace → src external_id
 *           → dst external_id → relationship → metamodel
 *
 * Sorting by source/target external_id BEFORE relationship ensures that all
 * edges from the same source node stay grouped together regardless of
 * relationship type. This prevents `has_direct_requirements` / `occurs_at`
 * reordering within a malfunction's block on every store cycle.
 */
export function sortCrossNsRelationshipInstances(
  instances: Record<string, unknown>[],
): Record<string, unknown>[] {
  return [...instances].sort((a, b) => {
    // 1. Group by namespace pair
    const aSrcNs = String(a.source_namespace ?? '');
    const bSrcNs = String(b.source_namespace ?? '');
    if (aSrcNs < bSrcNs) return -1;
    if (aSrcNs > bSrcNs) return 1;

    const aTgtNs = String(a.target_namespace ?? '');
    const bTgtNs = String(b.target_namespace ?? '');
    if (aTgtNs < bTgtNs) return -1;
    if (aTgtNs > bTgtNs) return 1;

    // 2. Group by source external_id (keeps all edges from same source together)
    const aAttrs = parseAttrs(a);
    const bAttrs = parseAttrs(b);

    const aSrcExt = String(aAttrs.source_external_id ?? '');
    const bSrcExt = String(bAttrs.source_external_id ?? '');
    if (aSrcExt < bSrcExt) return -1;
    if (aSrcExt > bSrcExt) return 1;

    // 3. Then by target external_id (stable ordering within a source block)
    const aTgtExt = String(aAttrs.target_external_id ?? '');
    const bTgtExt = String(bAttrs.target_external_id ?? '');
    if (aTgtExt < bTgtExt) return -1;
    if (aTgtExt > bTgtExt) return 1;

    // 4. Finally by relationship and metamodel (last resort tie-break)
    const aRel = String(a.relationship ?? '');
    const bRel = String(b.relationship ?? '');
    if (aRel < bRel) return -1;
    if (aRel > bRel) return 1;

    const aMm = String(a.metamodel ?? '');
    const bMm = String(b.metamodel ?? '');
    if (aMm < bMm) return -1;
    if (aMm > bMm) return 1;

    return 0;
  });
}

/**
 * Sort cross-namespace instance rel edges (the graph edge table
 * RIA_UNIV_CROSSNS_INSTANCE_REL) by a stable composite key.
 *
 * Sort order: source_namespace → target_namespace → src_attributes (as string)
 *           → dst_attributes (as string) → relationship → rel_metamodel
 *
 * Sorting by src_attributes + dst_attributes BEFORE relationship ensures that
 * all edges from the same source concept instance stay grouped together
 * regardless of relationship type. This prevents reordering of
 * `has_direct_requirements` / `occurs_at` entries within a malfunction's block.
 */
export function sortCrossNsInstanceRelEdges(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    // 1. Group by namespace pair
    const aSrcNs = String(a.source_namespace ?? '');
    const bSrcNs = String(b.source_namespace ?? '');
    if (aSrcNs < bSrcNs) return -1;
    if (aSrcNs > bSrcNs) return 1;

    const aTgtNs = String(a.target_namespace ?? '');
    const bTgtNs = String(b.target_namespace ?? '');
    if (aTgtNs < bTgtNs) return -1;
    if (aTgtNs > bTgtNs) return 1;

    // 2. Group by source (src_attributes as canonical string)
    const aSrcAttr = canonicalAttrString(a.src_attributes);
    const bSrcAttr = canonicalAttrString(b.src_attributes);
    if (aSrcAttr < bSrcAttr) return -1;
    if (aSrcAttr > bSrcAttr) return 1;

    // 3. Then by destination (dst_attributes as canonical string)
    const aDstAttr = canonicalAttrString(a.dst_attributes);
    const bDstAttr = canonicalAttrString(b.dst_attributes);
    if (aDstAttr < bDstAttr) return -1;
    if (aDstAttr > bDstAttr) return 1;

    // 4. Finally by relationship and metamodel (last resort tie-break)
    const aRel = String(a.relationship ?? '');
    const bRel = String(b.relationship ?? '');
    if (aRel < bRel) return -1;
    if (aRel > bRel) return 1;

    const aMm = String(a.rel_metamodel ?? '');
    const bMm = String(b.rel_metamodel ?? '');
    if (aMm < bMm) return -1;
    if (aMm > bMm) return 1;

    return 0;
  });
}

/**
 * Produce a canonical string representation of an attributes value for sorting.
 * Handles both pre-parsed objects and JSON strings. Keys are sorted to ensure
 * the same logical content always produces the same string.
 */
function canonicalAttrString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        const sorted = Object.keys(parsed).sort().reduce((acc, k) => {
          acc[k] = parsed[k];
          return acc;
        }, {} as Record<string, unknown>);
        return JSON.stringify(sorted);
      }
    } catch { /* not JSON, use as-is */ }
    return value;
  }
  if (typeof value === 'object') {
    const sorted = Object.keys(value as Record<string, unknown>).sort().reduce((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k];
      return acc;
    }, {} as Record<string, unknown>);
    return JSON.stringify(sorted);
  }
  return String(value);
}

/**
 * Sort concept instances by attribute-driven compound key.
 * Key/identity attrs first (alphabetically by attr name), then remaining attrs.
 * Raises an error if no key attrs are declared for the concept type.
 */
export function sortConceptInstances(
  instances: Record<string, unknown>[],
  conceptType: string,
  nodeKeyAttrs: NodeKeyAttrMap,
): Record<string, unknown>[] {
  const keyAttrs = nodeKeyAttrs.get(conceptType);
  if (!keyAttrs || keyAttrs.length === 0) {
    throw new Error(
      `Concept type "${conceptType}" has no is_key or is_identity attributes declared. ` +
      `Every importer must declare at least one key attribute per concept type.`
    );
  }

  return [...instances].sort((a, b) => {
    const aAttrs = parseAttrs(a);
    const bAttrs = parseAttrs(b);

    const allAttrNames = [...new Set([...Object.keys(aAttrs), ...Object.keys(bAttrs)])].sort();
    const nonKeyAttrs = allAttrNames.filter(n => !keyAttrs.includes(n));

    for (const attrName of [...keyAttrs, ...nonKeyAttrs]) {
      const aVal = String(aAttrs[attrName] ?? '');
      const bVal = String(bAttrs[attrName] ?? '');
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
    }
    return 0;
  });
}

/**
 * Sort relationship instances by source_stable_id + target_stable_id + is_key edge attrs.
 */
export function sortRelationshipInstances(
  instances: Record<string, unknown>[],
  relType: string,
  edgeKeyAttrs: EdgeKeyAttrMap,
): Record<string, unknown>[] {
  const keyAttrs = edgeKeyAttrs.get(relType) ?? [];

  return [...instances].sort((a, b) => {
    const aSrc = String(a.source_stable_id ?? '');
    const bSrc = String(b.source_stable_id ?? '');
    if (aSrc < bSrc) return -1;
    if (aSrc > bSrc) return 1;

    const aTgt = String(a.target_stable_id ?? '');
    const bTgt = String(b.target_stable_id ?? '');
    if (aTgt < bTgt) return -1;
    if (aTgt > bTgt) return 1;

    if (keyAttrs.length > 0) {
      const aAttrs = parseAttrs(a);
      const bAttrs = parseAttrs(b);
      for (const attrName of keyAttrs) {
        const aVal = String(aAttrs[attrName] ?? '');
        const bVal = String(bAttrs[attrName] ?? '');
        if (aVal < bVal) return -1;
        if (aVal > bVal) return 1;
      }
    }
    return 0;
  });
}
