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
 * Edge-level diff computation.
 *
 * Compares intra-namespace and cross-namespace edges between two serialized
 * namespaces. Edge identity is based on stable ID triples, not ephemeral IDs.
 */

import type {
  EdgeSnapshot,
  EdgeModification,
  CrossNsEdgeSnapshot,
  CrossNsEdgeModification,
} from '@riacore/app-contracts';
import { computePropertyChanges } from './diff-nodes.js';
import { makeEdgeKey, makeCrossNsEdgeKey } from './diff-types.js';
import type { SerializedNamespace } from './diff-types.js';

// ── Public API ─────────────────────────────────────────────────────────────────

export interface EdgeDiffResult {
  addedEdges: EdgeSnapshot[];
  deletedEdges: EdgeSnapshot[];
  modifiedEdges: EdgeModification[];
  addedCrossNsEdges: CrossNsEdgeSnapshot[];
  deletedCrossNsEdges: CrossNsEdgeSnapshot[];
  modifiedCrossNsEdges: CrossNsEdgeModification[];
  /** Edge keys skipped because source node had no stable ID */
  skippedEdgeKeys: string[];
}

export function diffEdges(
  left: SerializedNamespace,
  right: SerializedNamespace,
  includeCrossNamespaceEdges = true,
): EdgeDiffResult {
  const leftEdges = buildEdgeMap(left);
  const rightEdges = buildEdgeMap(right);

  const addedEdges: EdgeSnapshot[] = [];
  const deletedEdges: EdgeSnapshot[] = [];
  const modifiedEdges: EdgeModification[] = [];

  // Added intra-namespace edges
  for (const [key, rSnap] of rightEdges.byKey) {
    if (!leftEdges.byKey.has(key)) addedEdges.push(rSnap);
  }

  // Deleted intra-namespace edges
  for (const [key, lSnap] of leftEdges.byKey) {
    if (!rightEdges.byKey.has(key)) deletedEdges.push(lSnap);
  }

  // Modified intra-namespace edges
  for (const [key, lSnap] of leftEdges.byKey) {
    const rSnap = rightEdges.byKey.get(key);
    if (!rSnap) continue;
    const propertyChanges = computePropertyChanges(lSnap.attributes, rSnap.attributes);
    if (propertyChanges.length > 0) {
      modifiedEdges.push({
        sourceStableId: lSnap.sourceStableId,
        targetStableId: lSnap.targetStableId,
        relationshipType: lSnap.relationshipType,
        namespace: lSnap.namespace,
        propertyChanges,
        leftSnapshot: lSnap,
        rightSnapshot: rSnap,
      });
    }
  }

  // Cross-namespace edges. Supervised importer updates compare an original
  // namespace with a freshly imported temporary namespace. The temporary side
  // intentionally contains no authored annotations, so comparing CrossNS data
  // in that workflow would turn every annotation into a false deletion.
  if (!includeCrossNamespaceEdges) {
    return {
      addedEdges,
      deletedEdges,
      modifiedEdges,
      addedCrossNsEdges: [],
      deletedCrossNsEdges: [],
      modifiedCrossNsEdges: [],
      skippedEdgeKeys: [...leftEdges.skippedKeys, ...rightEdges.skippedKeys],
    };
  }

  // Cross-namespace edges
  const leftCross = buildCrossNsEdgeMap(left);
  const rightCross = buildCrossNsEdgeMap(right);

  const addedCrossNsEdges: CrossNsEdgeSnapshot[] = [];
  const deletedCrossNsEdges: CrossNsEdgeSnapshot[] = [];
  const modifiedCrossNsEdges: CrossNsEdgeModification[] = [];

  for (const [key, rSnap] of rightCross.byKey) {
    if (!leftCross.byKey.has(key)) addedCrossNsEdges.push(rSnap);
  }
  for (const [key, lSnap] of leftCross.byKey) {
    if (!rightCross.byKey.has(key)) deletedCrossNsEdges.push(lSnap);
  }
  for (const [key, lSnap] of leftCross.byKey) {
    const rSnap = rightCross.byKey.get(key);
    if (!rSnap) continue;
    const propertyChanges = computePropertyChanges(lSnap.attributes, rSnap.attributes);
    if (propertyChanges.length > 0) {
      modifiedCrossNsEdges.push({
        sourceStableId: lSnap.sourceStableId,
        sourceNamespace: lSnap.sourceNamespace,
        targetStableId: lSnap.targetStableId,
        targetNamespace: lSnap.targetNamespace,
        relationshipType: lSnap.relationshipType,
        propertyChanges,
        leftSnapshot: lSnap,
        rightSnapshot: rSnap,
      });
    }
  }

  const skippedEdgeKeys = [...leftEdges.skippedKeys, ...rightEdges.skippedKeys];

  return {
    addedEdges,
    deletedEdges,
    modifiedEdges,
    addedCrossNsEdges,
    deletedCrossNsEdges,
    modifiedCrossNsEdges,
    skippedEdgeKeys,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface EdgeMapResult {
  byKey: Map<string, EdgeSnapshot>;
  skippedKeys: string[];
}

function buildEdgeMap(ns: SerializedNamespace): EdgeMapResult {
  const byKey = new Map<string, EdgeSnapshot>();
  const skippedKeys: string[] = [];
  const duplicateKeys = new Set<string>();

  for (const ri of ns.relationshipInstances) {
    const sourceStableId = String(ri.source_stable_id ?? '');
    const targetStableId = String(ri.target_stable_id ?? '');
    const relationshipType = String(ri.relationship ?? '');

    if (!sourceStableId || !targetStableId) {
      skippedKeys.push(`?::${targetStableId}::${relationshipType}`);
      continue;
    }

    const key = makeEdgeKey(sourceStableId, targetStableId, relationshipType);

    if (duplicateKeys.has(key)) continue;
    if (byKey.has(key)) {
      byKey.delete(key);
      duplicateKeys.add(key);
      skippedKeys.push(key);
      continue;
    }

    const attributes = parseAttributes(ri.attributes);
    byKey.set(key, {
      sourceStableId,
      targetStableId,
      relationshipType,
      namespace: ns.namespace,
      attributes,
    });
  }

  return { byKey, skippedKeys };
}

interface CrossNsEdgeMapResult {
  byKey: Map<string, CrossNsEdgeSnapshot>;
  skippedKeys: string[];
}

function buildCrossNsEdgeMap(ns: SerializedNamespace): CrossNsEdgeMapResult {
  const byKey = new Map<string, CrossNsEdgeSnapshot>();
  const skippedKeys: string[] = [];
  const duplicateKeys = new Set<string>();

  for (const x of ns.crossNsEdgesAsSource) {
    const sourceStableId = String(x.source_stable_id ?? '');
    const targetStableId = String(x.target_stable_id ?? '');
    const relationshipType = String(x.relationship ?? '');
    const targetNamespace = String(x.target_namespace ?? '');

    if (!sourceStableId) {
      skippedKeys.push(`?::${relationshipType}::${targetNamespace}::${targetStableId}`);
      continue;
    }

    const key = makeCrossNsEdgeKey(sourceStableId, relationshipType, targetNamespace, targetStableId);

    if (duplicateKeys.has(key)) continue;
    if (byKey.has(key)) {
      byKey.delete(key);
      duplicateKeys.add(key);
      skippedKeys.push(key);
      continue;
    }

    const attributes = parseAttributes(x.attributes);
    byKey.set(key, {
      sourceStableId,
      sourceNamespace: ns.namespace,
      targetStableId,
      targetNamespace,
      relationshipType,
      attributes,
    });
  }

  return { byKey, skippedKeys };
}

function parseAttributes(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>; }
  catch { return {}; }
}
