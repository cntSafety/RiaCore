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
import type { PropagationMalfunctionData, ScopedStructuralNode } from '@riacore/app-contracts';
import type { CopiedMalfunctionData } from '../../../../../store/workspaceStore';

/**
 * Renderer-internal row model derived from PropagationMalfunctionData.
 * Produced by toRows() from internalNodes only (boundary nodes are excluded from table rows).
 */
export interface MalfunctionRow {
  fmNodeId: number;
  namespace: string;
  name: string;
  description: string;
  asil: string;
  owner: {
    nodeId: number;
    namespace: string;
    concept: string;
    name: string;
  } | null;
  /**
   * When owner is a port (direct child of scope root), the display name of the parent component.
   * Used to show "ComponentName / PortName" in the Element_Name column.
   * Null when the owner is the component itself (not a port child).
   */
  componentName: string | null;
  /**
   * True when this row represents a structural node (port/component) that exists
   * in scope but currently has no malfunction attached to it.
   */
  isEmptyPort: boolean;
}

/**
 * Maps internal malfunction nodes + structural nodes to MalfunctionRow[].
 *
 * - One row per malfunction in `nodes` (existing behaviour).
 * - One empty row per structural node that has no malfunction attached,
 *   so the table can show all ports even when they have no malfunctions.
 *
 * Boundary nodes must be excluded by the caller before passing `nodes`.
 */
export function toRows(
  nodes: PropagationMalfunctionData[],
  structuralNodes: ScopedStructuralNode[] = [],
): MalfunctionRow[] {
  // Build a set of structural node_ids that already have at least one malfunction attached.
  const coveredStructuralIds = new Set<number>(
    nodes
      .map(n => n.occursAtTarget?.node_id)
      .filter((id): id is number => id !== undefined),
  );

  // Rows for existing malfunctions
  const malfunctionRows: MalfunctionRow[] = nodes.map((node) => {
    const attrs = node.attributes as {
      has_name?: string;
      malfunction_description?: string;
      malfunction_asil?: string;
    };

    const owner = node.occursAtTarget
      ? {
          nodeId: node.occursAtTarget.node_id,
          namespace: node.occursAtTarget.namespace,
          concept: node.occursAtTarget.concept,
          name: node.occursAtTarget.name ?? '',
        }
      : null;

    // Resolve componentName: look up the owner in structuralNodes to find its parentName.
    let componentName: string | null = null;
    if (owner !== null) {
      const structural = structuralNodes.find(s => s.node_id === owner.nodeId);
      componentName = structural?.parentName ?? null;
    }

    return {
      fmNodeId: node.node_id,
      namespace: node.namespace,
      name: attrs.has_name ?? '',
      description: attrs.malfunction_description ?? '',
      asil: attrs.malfunction_asil ?? '',
      owner,
      componentName,
      isEmptyPort: false,
    };
  });

  // Empty rows for structural child nodes (ports) with no malfunction attached.
  // Only child nodes (parentNodeId !== null) get empty rows — not the scope root itself.
  const emptyRows: MalfunctionRow[] = structuralNodes
    .filter(s => s.parentNodeId !== null && !coveredStructuralIds.has(s.node_id))
    .map(s => ({
      // Use a negative sentinel so it's unique but won't clash with real fmNodeIds.
      fmNodeId: -s.node_id,
      namespace: '',
      name: '',
      description: '',
      asil: '',
      owner: {
        nodeId: s.node_id,
        namespace: s.namespace,
        concept: s.concept,
        name: s.name,
      },
      componentName: s.parentName,
      isEmptyPort: true,
    }));

  // Sort order mirrors the namespace tree. The tree sorts a node's structural
  // children (ports / sub-components) alphabetically by name, then appends that
  // node's own cross-namespace malfunction references after them. So in this
  // flat table:
  //   - Rows whose owner is a CHILD of the scope (ports / sub-components, with or
  //     without a malfunction attached) interleave alphabetically by owner name —
  //     matching the tree's structural-child ordering.
  //   - Malfunctions attached to the scope root itself sort last (the tree shows
  //     them as references after the child nodes).
  //   - Within the same owner, rows keep their original backend order (stable
  //     sort), matching the unsorted reference order in the tree.
  //
  // owner === scope root ⇔ componentName === null (the root has no parentName);
  // this also covers a malfunction with no occurs_at target.
  function rowSortKey(r: MalfunctionRow): [number, string] {
    if (r.componentName === null) {
      // Scope-root-level malfunction (or no owner) → after all child rows.
      return [1, ''];
    }
    // Child owner (port / sub-component): alphabetical by owner name.
    return [0, r.owner?.name ?? ''];
  }

  const allRows = [...malfunctionRows, ...emptyRows];
  allRows.sort((a, b) => {
    const [ag, an] = rowSortKey(a);
    const [bg, bn] = rowSortKey(b);
    if (ag !== bg) return ag - bg;
    return an.localeCompare(bn);
  });

  return allRows;
}

/**
 * Returns true when the shared clipboard holds a malfunction that can be pasted.
 * Satisfies Requirement 7.5: paste is enabled if and only if the clipboard is non-null.
 */
export function pasteEnabled(copiedMalfunction: CopiedMalfunctionData | null): boolean {
  return copiedMalfunction !== null;
}
