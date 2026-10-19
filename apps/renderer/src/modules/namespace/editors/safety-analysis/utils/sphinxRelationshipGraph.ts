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
import type { RelationshipData } from '@riacore/app-contracts';
import type { SelectedTreeElement } from '../types';
import { sortElementRelationships } from './elementRelationships';
import { computeElkLayout } from './elkLayout';

export const RELATIONSHIP_NODE_WIDTH = 300;
export const RELATIONSHIP_NODE_HEIGHT = 148;
export const RELATIONSHIP_FOCUS_ID = 'focus';

export type RelationshipRole = 'incoming' | 'focus' | 'outgoing';
export interface RelationshipGraphNode {
  id: string;
  element: RelationshipData['connectedNode'];
  role: RelationshipRole;
  bothDirections: boolean;
  height: number;
}
export interface RelationshipGraphEdge {
  id: string;
  source: string;
  target: string;
  /** Keep every database edge, including parallel edges, behind the displayed labels. */
  relationships: RelationshipData[];
  labels: string[];
  self: boolean;
}
export interface SphinxRelationshipGraph {
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
  gap: number;
}

export function isSphinxNeedConcept(concept: string): boolean {
  return concept.startsWith('need_') && concept !== 'need_document' && concept !== 'need_base';
}

export function usesSphinxRelationshipModel(metamodel: string | undefined, concept: string): boolean {
  return !!metamodel?.startsWith('SN_') && isSphinxNeedConcept(concept);
}

function labelsFor(rows: RelationshipData[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.relationship, (counts.get(row.relationship) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
}

/** A one-hop projection of Details, independent of CommonModel and propagation semantics. */
export function buildSphinxRelationshipGraph(selected: SelectedTreeElement, rows: readonly RelationshipData[]): SphinxRelationshipGraph {
  const nodes = new Map<string, RelationshipGraphNode>();
  nodes.set(RELATIONSHIP_FOCUS_ID, {
    id: RELATIONSHIP_FOCUS_ID,
    element: { node_id: selected.nodeId, namespace: selected.namespace, concept: selected.concept, name: selected.name || selected.concept },
    role: 'focus', bothDirections: false, height: RELATIONSHIP_NODE_HEIGHT,
  });
  const groups = new Map<string, RelationshipGraphEdge>();
  const seen = new Set<string>();
  for (const row of sortElementRelationships(rows)) {
    const self = row.connectedNode.node_id === selected.nodeId && row.connectedNode.namespace === selected.namespace;
    // A self-link is returned once per direction by the API; draw the stored edge once.
    const identity = JSON.stringify([row.type, row.edge_id, self ? 'self' : row.direction]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const partnerId = self ? RELATIONSHIP_FOCUS_ID : JSON.stringify([row.direction, row.connectedNode.namespace, row.connectedNode.node_id]);
    if (!self && !nodes.has(partnerId)) nodes.set(partnerId, {
      id: partnerId, element: row.connectedNode, role: row.direction, bothDirections: false, height: RELATIONSHIP_NODE_HEIGHT,
    });
    const id = `relationships:${partnerId}`;
    let edge = groups.get(id);
    if (!edge) {
      edge = { id, source: row.direction === 'incoming' ? partnerId : RELATIONSHIP_FOCUS_ID, target: row.direction === 'incoming' ? RELATIONSHIP_FOCUS_ID : partnerId, relationships: [], labels: [], self };
      groups.set(id, edge);
    }
    edge.relationships.push(row);
  }
  for (const node of nodes.values()) {
    if (node.role === 'focus') continue;
    const opposite = node.role === 'incoming' ? 'outgoing' : 'incoming';
    node.bothDirections = nodes.has(JSON.stringify([opposite, node.element.namespace, node.element.node_id]));
  }
  let gap = 220;
  for (const edge of groups.values()) {
    edge.labels = labelsFor(edge.relationships);
    gap = Math.max(gap, ...edge.labels.map(label => Math.min(440, label.length * 7 + 48)));
    // Reserve vertical room for stacked type labels when a partner has many link types.
    const partner = nodes.get(edge.source === RELATIONSHIP_FOCUS_ID ? edge.target : edge.source)!;
    partner.height = Math.max(partner.height, edge.labels.length * 20 + 40);
  }
  return { nodes: [...nodes.values()], edges: [...groups.values()], gap };
}

/** Local options only: the shared ELK defaults and the other canvases stay unchanged. */
export async function layoutSphinxRelationshipGraph(graph: SphinxRelationshipGraph) {
  const layout = await computeElkLayout({
    nodes: graph.nodes.map(node => ({
      id: node.id, width: RELATIONSHIP_NODE_WIDTH, height: node.height,
      layoutOptions: { 'org.eclipse.elk.partitioning.partition': String(node.role === 'incoming' ? 0 : node.role === 'focus' ? 1 : 2) },
    })),
    edges: graph.edges.filter(edge => !edge.self).map(({ id, source, target }) => ({ id, source, target })),
    layoutOptions: {
      'elk.direction': 'RIGHT',
      'org.eclipse.elk.partitioning.activate': 'true',
      'org.eclipse.elk.separateConnectedComponents': 'false',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(graph.gap),
      'elk.spacing.nodeNode': '56',
    },
  });
  const positions = new Map<string, { x: number; y: number }>();
  for (const role of ['incoming', 'focus', 'outgoing'] as const) {
    let bottom = -Infinity;
    const lane = graph.nodes.filter(node => node.role === role).sort((a, b) =>
      (layout.positions.get(a.id)?.y ?? 0) - (layout.positions.get(b.id)?.y ?? 0),
    );
    for (const node of lane) {
      // Fixed columns also protect the reading order if the shared engine falls back to its grid.
      const y = Math.max(layout.positions.get(node.id)?.y ?? 0, bottom);
      positions.set(node.id, { x: (role === 'incoming' ? -1 : role === 'outgoing' ? 1 : 0) * (RELATIONSHIP_NODE_WIDTH + graph.gap), y });
      bottom = y + node.height + 56;
    }
    if (lane.length) {
      // Retain ELK's ordering/spacing, centering each partner lane around the selected need.
      const top = positions.get(lane[0].id)!.y;
      const last = lane[lane.length - 1];
      const midpoint = (top + positions.get(last.id)!.y + last.height) / 2;
      const focusHeight = graph.nodes.find(node => node.role === 'focus')!.height;
      for (const node of lane) {
        const position = positions.get(node.id)!;
        position.y = role === 'focus' ? 0 : position.y + focusHeight / 2 - midpoint;
      }
    }
  }
  return { mode: layout.mode, positions };
}
