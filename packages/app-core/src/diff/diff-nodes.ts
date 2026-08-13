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
 * Node-level diff computation.
 *
 * Compares two sets of concept instances and produces node-level diff items
 * (added, deleted, modified). Handles stable ID resolution, duplicate stable IDs,
 * concept type changes, and attribute-level property diffs.
 *
 * Performance: O(n) in the number of concept instances. Map construction from
 * arrays is efficient in V8. For namespaces with > 50,000 nodes the diff will
 * succeed but a largeDatasetWarning is propagated via the summary.
 */

import type { NodeSnapshot, NodeModification, PropertyChange, SkippedNode } from '@riacore/app-contracts';
import { resolveStableIdFromMeta } from '../persistor/stable-id.js';
import { serializeRecord } from '../persistor/serializer.js';
import type { SerializedNamespace } from './diff-types.js';

// ── Public API ─────────────────────────────────────────────────────────────────

export interface NodeDiffResult {
  addedNodes: NodeSnapshot[];
  deletedNodes: NodeSnapshot[];
  modifiedNodes: NodeModification[];
  skippedNodes: SkippedNode[];
}

export function diffNodes(
  left: SerializedNamespace,
  right: SerializedNamespace,
): NodeDiffResult {
  const leftMap = buildNodeMap(left);
  const rightMap = buildNodeMap(right);

  const addedNodes: NodeSnapshot[] = [];
  const deletedNodes: NodeSnapshot[] = [];
  const modifiedNodes: NodeModification[] = [];

  // Added: in right but not in left
  for (const [stableId, rSnap] of rightMap.byId) {
    if (!leftMap.byId.has(stableId)) {
      addedNodes.push(rSnap);
    }
  }

  // Deleted: in left but not in right
  for (const [stableId, lSnap] of leftMap.byId) {
    if (!rightMap.byId.has(stableId)) {
      deletedNodes.push(lSnap);
    }
  }

  // Modified: in both — compare attributes (and concept type)
  for (const [stableId, lSnap] of leftMap.byId) {
    const rSnap = rightMap.byId.get(stableId);
    if (!rSnap) continue; // handled in deleted above

    const propertyChanges = computePropertyChanges(lSnap.attributes, rSnap.attributes);

    // Treat concept type change as a synthetic property change on _conceptType
    if (lSnap.conceptType !== rSnap.conceptType) {
      propertyChanges.unshift({
        attribute: '_conceptType',
        changeKind: 'modified',
        leftValue: lSnap.conceptType,
        rightValue: rSnap.conceptType,
      });
    }

    if (propertyChanges.length > 0) {
      modifiedNodes.push({
        stableId,
        conceptType: rSnap.conceptType, // use right (more recent) type
        propertyChanges,
        leftSnapshot: lSnap,
        rightSnapshot: rSnap,
      });
    }
  }

  // Merge skipped nodes from both sides (deduped by stable ID)
  const skippedNodes: SkippedNode[] = [
    ...leftMap.skipped,
    ...rightMap.skipped.filter(
      s => !leftMap.skipped.some(ls => attrsMatch(ls.attributes, s.attributes))
    ),
  ];

  return { addedNodes, deletedNodes, modifiedNodes, skippedNodes };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface NodeMapResult {
  byId: Map<string, NodeSnapshot>;
  skipped: SkippedNode[];
}

function buildNodeMap(ns: SerializedNamespace): NodeMapResult {
  const byId = new Map<string, NodeSnapshot>();
  const duplicates = new Set<string>();
  const skipped: SkippedNode[] = [];

  for (const ci of ns.conceptInstances) {
    const conceptType = String(ci.concept ?? '');
    const rawAttrs = ci.attributes;
    const attributes = parseAttributes(rawAttrs);

    let stableId = '';
    try {
      stableId = resolveStableIdFromMeta(
        typeof rawAttrs === 'string' ? rawAttrs : JSON.stringify(attributes),
        conceptType,
        ns.nodeKeyAttrs,
      );
    } catch (err) {
      skipped.push({
        conceptType,
        namespace: ns.namespace,
        attributes,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (stableId === '') {
      skipped.push({
        conceptType,
        namespace: ns.namespace,
        attributes,
        reason: 'Empty stable identifier value',
      });
      continue;
    }

    if (duplicates.has(stableId)) continue;

    if (byId.has(stableId)) {
      // Duplicate stable ID — exclude both, warn
      byId.delete(stableId);
      duplicates.add(stableId);
      skipped.push({
        conceptType,
        namespace: ns.namespace,
        attributes,
        reason: `Duplicate stable identifier '${stableId}' — excluded from diff`,
      });
      continue;
    }

    byId.set(stableId, {
      stableId,
      conceptType,
      namespace: ns.namespace,
      attributes,
    });
  }

  return { byId, skipped };
}

function parseAttributes(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Compare two attribute objects and return a list of PropertyChange entries.
 *
 * Uses serializeRecord() (canonical key-sorted JSON) for equality comparison
 * to avoid non-determinism from key ordering — consistent with the persistor's
 * hash computation.
 */
export function computePropertyChanges(
  leftAttrs: Record<string, unknown>,
  rightAttrs: Record<string, unknown>,
): PropertyChange[] {
  const changes: PropertyChange[] = [];
  const allKeys = new Set([...Object.keys(leftAttrs), ...Object.keys(rightAttrs)]);

  for (const key of Array.from(allKeys).sort()) {
    const hasLeft = Object.prototype.hasOwnProperty.call(leftAttrs, key);
    const hasRight = Object.prototype.hasOwnProperty.call(rightAttrs, key);

    if (!hasLeft) {
      changes.push({ attribute: key, changeKind: 'added', leftValue: undefined, rightValue: rightAttrs[key] });
      continue;
    }
    if (!hasRight) {
      changes.push({ attribute: key, changeKind: 'deleted', leftValue: leftAttrs[key], rightValue: undefined });
      continue;
    }

    // Both present — compare using canonical serialization
    const lSer = canonicalize(leftAttrs[key]);
    const rSer = canonicalize(rightAttrs[key]);
    if (lSer !== rSer) {
      changes.push({ attribute: key, changeKind: 'modified', leftValue: leftAttrs[key], rightValue: rightAttrs[key] });
    }
  }

  return changes;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    return serializeRecord(value as Record<string, unknown>, [], []);
  }
  return String(value);
}

function attrsMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalize(a) === canonicalize(b);
}
