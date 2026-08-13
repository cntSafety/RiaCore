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
 * Internal types for the diff module — not exported outside app-core.
 *
 * The diff algorithm is a pure function over two SerializedNamespace values.
 * This design makes the algorithm testable with no database involved.
 */

import type { NodeKeyAttrMap, EdgeKeyAttrMap } from '../persistor/persistor-types.js';

export type { NodeKeyAttrMap, EdgeKeyAttrMap };

/**
 * In-memory representation of a namespace for diff purposes.
 * Uses the same structures the persistor serializes to disk (stable IDs, no
 * ephemeral node_id/edge_id values).
 */
export interface SerializedNamespace {
  namespace: string;
  metamodel: string;
  /** Rows from RIA_UNIV_ConceptInstance — node_id replaced with stable IDs already resolved */
  conceptInstances: Record<string, unknown>[];
  /** Rows from RIA_UNIV_RelationshipInstance — source/target expressed via stable IDs */
  relationshipInstances: Record<string, unknown>[];
  /** Rows from RIA_UNIV_CrossNSRelationshipInstance where source_namespace = this namespace */
  crossNsEdgesAsSource: Record<string, unknown>[];
  /** Identity/key attributes per concept type */
  nodeKeyAttrs: NodeKeyAttrMap;
  /** Key attributes per relationship type */
  edgeKeyAttrs: EdgeKeyAttrMap;
}

/** Canonical edge key for intra-namespace edges */
export function makeEdgeKey(
  sourceStableId: string,
  targetStableId: string,
  relationshipType: string,
): string {
  return `${sourceStableId}::${targetStableId}::${relationshipType}`;
}

/** Canonical edge key for cross-namespace edges */
export function makeCrossNsEdgeKey(
  sourceStableId: string,
  relationshipType: string,
  targetNamespace: string,
  targetStableId: string,
): string {
  return `${sourceStableId}::${relationshipType}::${targetNamespace}::${targetStableId}`;
}
