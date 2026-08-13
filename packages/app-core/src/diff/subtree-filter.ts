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
 * Sub-tree filter — restrict a SerializedNamespace to a hierarchically
 * bounded sub-graph rooted at a specific stable ID.
 *
 * Used for partial diff: instead of diffing an entire namespace, the user
 * selects two root nodes (one per namespace) and the diff is restricted to
 * each root's sub-tree.
 */

import { resolveStableIdFromMeta } from '../persistor/stable-id.js';
import type { SerializedNamespace } from './diff-types.js';

/**
 * Return a new SerializedNamespace containing only the concept instances and
 * relationship instances reachable from `rootStableId` via the specified
 * containment relationship types.
 *
 * Edges whose source is inside the sub-tree but whose target is outside it are
 * kept as boundary edges (included in crossNsEdgesAsSource of the result even
 * if they are technically intra-namespace). This preserves edge visibility at
 * the diff boundary without pulling the external targets into the scope.
 *
 * If `containmentRelationshipTypes` is empty, ALL relationship types are used
 * as containment (safe default for unstructured sub-graphs).
 */
export function filterToSubtree(
  ns: SerializedNamespace,
  rootStableId: string,
  containmentRelationshipTypes: string[],
): SerializedNamespace {
  const useAllRels = containmentRelationshipTypes.length === 0;

  // ── Build stable ID → concept instance map ───────────────────────────────
  const instanceByStableId = new Map<string, Record<string, unknown>>();
  for (const ci of ns.conceptInstances) {
    let stableId = '';
    try {
      stableId = resolveStableIdFromMeta(
        typeof ci.attributes === 'string' ? ci.attributes : JSON.stringify(ci.attributes ?? {}),
        String(ci.concept ?? ''),
        ns.nodeKeyAttrs,
      );
    } catch {
      continue;
    }
    if (stableId) instanceByStableId.set(stableId, ci);
  }

  if (!instanceByStableId.has(rootStableId)) {
    throw new Error(
      `Sub-tree root '${rootStableId}' not found in namespace '${ns.namespace}'. ` +
      `Verify the stable ID and that it belongs to this namespace.`,
    );
  }

  // ── BFS / DFS over containment edges ─────────────────────────────────────
  const visited = new Set<string>([rootStableId]);
  const queue: string[] = [rootStableId];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const ri of ns.relationshipInstances) {
      const relType = String(ri.relationship ?? '');
      const src = String(ri.source_stable_id ?? '');
      const tgt = String(ri.target_stable_id ?? '');

      if (src !== current) continue;
      if (!useAllRels && !containmentRelationshipTypes.includes(relType)) continue;
      if (visited.has(tgt)) continue;
      if (!instanceByStableId.has(tgt)) continue; // target outside namespace

      visited.add(tgt);
      queue.push(tgt);
    }
  }

  // ── Filter concept instances ──────────────────────────────────────────────
  const filteredConcepts = ns.conceptInstances.filter(ci => {
    let stableId = '';
    try {
      stableId = resolveStableIdFromMeta(
        typeof ci.attributes === 'string' ? ci.attributes : JSON.stringify(ci.attributes ?? {}),
        String(ci.concept ?? ''),
        ns.nodeKeyAttrs,
      );
    } catch { return false; }
    return stableId !== '' && visited.has(stableId);
  });

  // ── Classify relationship instances ──────────────────────────────────────
  const filteredRels: Record<string, unknown>[] = [];
  const boundaryEdges: Record<string, unknown>[] = [];

  for (const ri of ns.relationshipInstances) {
    const src = String(ri.source_stable_id ?? '');
    const tgt = String(ri.target_stable_id ?? '');

    if (!visited.has(src)) continue; // source not in sub-tree: skip entirely

    if (visited.has(tgt)) {
      filteredRels.push(ri); // internal edge: both endpoints in sub-tree
    } else {
      // Boundary edge: source inside, target outside — treat as cross-NS-like boundary
      boundaryEdges.push({
        ...ri,
        source_namespace: ns.namespace,
        target_namespace: ns.namespace, // still intra-NS but out of scope
        is_boundary_edge: true,
      });
    }
  }

  // ── Include existing cross-namespace edges whose source is in sub-tree ─────
  const filteredCrossNs = ns.crossNsEdgesAsSource.filter(x => {
    const src = String(x.source_stable_id ?? '');
    return visited.has(src);
  });

  return {
    ...ns,
    conceptInstances: filteredConcepts,
    relationshipInstances: filteredRels,
    crossNsEdgesAsSource: [...filteredCrossNs, ...boundaryEdges],
  };
}
