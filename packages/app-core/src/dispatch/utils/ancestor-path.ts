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
import type { IDbModule } from '../../db/db-module.js';
import { e } from './cypher.js';

/**
 * Walk containment edges upward from a node to the root, returning an ordered
 * list of parent node_ids from root to the node's immediate parent.
 *
 * Returns `[]` for orphan nodes or when no containment relationships are
 * registered for the given metamodel.
 *
 * @param dbModule  - Database module for running Cypher queries
 * @param nodeId    - The starting node's `node_id`
 * @param metamodel - The metamodel name used to look up containment relationships
 */
export async function resolveAncestorPath(
  dbModule: IDbModule,
  nodeId: number,
  metamodel: string,
): Promise<number[]> {
  // Look up containment relationship names for this metamodel
  const relRows = await dbModule.runQuery(
    `MATCH (r:RIA_META_Relationship)
     WHERE r.metamodel = $metamodel AND r.is_containment = true
     RETURN r.name AS name`,
    { metamodel },
  );
  const containmentRels = relRows.map(r => String(r.name));
  if (containmentRels.length === 0) return [];

  const relFilter = containmentRels.map(r => `'${e(r)}'`).join(', ');
  const path: number[] = [];
  let currentId = nodeId;

  // Walk upward, max 50 levels to prevent infinite loops
  for (let depth = 0; depth < 50; depth++) {
    const parentRows = await dbModule.runQuery(
      `MATCH (parent:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(child:RIA_UNIV_ConceptInstance {node_id: $currentId})
       WHERE r.relationship IN [${relFilter}]
       RETURN parent.node_id AS parentId
       LIMIT 1`,
      { currentId },
    );
    if (parentRows.length === 0) break;
    const parentId = Number(parentRows[0]?.parentId);
    if (!Number.isFinite(parentId)) break;
    path.unshift(parentId);
    currentId = parentId;
  }

  return path;
}
