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
import type { GraphNode, GraphEdge } from '@riacore/app-contracts';

// ── Concept Color Generator ──────────────────────────────────────────

/**
 * A curated palette of visually distinct, accessible colors for concept-based
 * node coloring. Concepts are assigned colors by hashing the concept name to
 * an index in this palette, ensuring deterministic and consistent coloring.
 */
const CONCEPT_PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#84cc16', // lime
];

/** Simple string hash → palette index. Deterministic for the same concept name. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Explicit color overrides for concepts that collide via the hash or need
 * a semantically meaningful color (e.g. malfunction = red, safety-related = amber).
 */
const CONCEPT_COLOR_OVERRIDES: Record<string, string> = {
  malfunction:            '#ef4444', // red   — safety hazard
  failure_mode:           '#f97316', // orange
  application_swc:        '#22c55e', // green
  p_port:                 '#06b6d4', // cyan
  r_port:                 '#eab308', // yellow
  assembly_connector:     '#14b8a6', // teal
  swc_internal_behavior:  '#3b82f6', // blue
  port_interface:         '#8b5cf6', // violet
  data_element:           '#6366f1', // indigo
};

/** Returns a deterministic color for a given concept name. */
export function conceptColor(concept: string): string {
  if (concept in CONCEPT_COLOR_OVERRIDES) return CONCEPT_COLOR_OVERRIDES[concept];
  return CONCEPT_PALETTE[hashString(concept) % CONCEPT_PALETTE.length];
}

// ── Node Style Registry ──────────────────────────────────────────────

export const FALLBACK_NODE_STYLE = { color: '#6b7280', size: 18, layer: 'fallback' } as const;

export const NODE_STYLE_REGISTRY: Record<string, { color: string; size: number; layer: string }> = {
  // Meta layer — larger to signal hierarchy / structural importance
  RIA_META_Metamodel:                    { color: '#f59e0b', size: 32, layer: 'meta' },
  RIA_META_Concept:                      { color: '#d97706', size: 28, layer: 'meta' },
  RIA_META_Relationship:                 { color: '#b45309', size: 28, layer: 'meta' },
  RIA_META_NodeAttribute:                { color: '#f97316', size: 20, layer: 'meta' },
  RIA_META_EdgeAttribute:                { color: '#ea580c', size: 20, layer: 'meta' },
  // Universe layer — data instances, uniform medium size
  RIA_UNIV_Namespace:                    { color: '#3b82f6', size: 26, layer: 'universe' },
  RIA_UNIV_ConceptInstance:              { color: '#0ea5e9', size: 18, layer: 'universe' },
  RIA_UNIV_RelationshipInstance:         { color: '#06b6d4', size: 18, layer: 'universe' },
  RIA_UNIV_CategoryLink:                 { color: '#14b8a6', size: 18, layer: 'universe' },
  RIA_UNIV_RelCategoryLink:              { color: '#0d9488', size: 18, layer: 'universe' },
  // Source layer — provenance nodes, small
  RIA_SRC_Source:                        { color: '#6b7280', size: 16, layer: 'source' },
  RIA_SRC_ImportRun:                     { color: '#9ca3af', size: 16, layer: 'source' },
  // Cross-namespace — slightly larger to stand out as structural
  RIA_UNIV_NamespaceRelation:            { color: '#8b5cf6', size: 22, layer: 'cross_namespace' },
  RIA_UNIV_CrossNSRelationshipInstance:  { color: '#7c3aed', size: 22, layer: 'cross_namespace' },
};

// ── Edge Style Registry ──────────────────────────────────────────────

export const FALLBACK_EDGE_STYLE = { color: '#9ca3af', lineStyle: 'solid' as const };

export const EDGE_STYLE_REGISTRY: Record<string, { color: string; lineStyle: 'solid' | 'dashed' }> = {
  RIA_META:                       { color: '#f59e0b', lineStyle: 'solid' },
  RIA_UNIV_INSTANCE_REL:          { color: '#3b82f6', lineStyle: 'solid' },
  RIA_UNIV_CROSSNS_INSTANCE_REL:  { color: '#8b5cf6', lineStyle: 'dashed' },
  RIA_SRC:                        { color: '#6b7280', lineStyle: 'solid' },
};


/**
 * Returns the edge style for a given edge type, using `startsWith` group matching.
 * Falls back to FALLBACK_EDGE_STYLE for unknown types.
 */
export function getEdgeStyle(edgeType: string): { color: string; lineStyle: 'solid' | 'dashed' } {
  if (edgeType in EDGE_STYLE_REGISTRY) return EDGE_STYLE_REGISTRY[edgeType];
  for (const key of Object.keys(EDGE_STYLE_REGISTRY)) {
    if (edgeType.startsWith(key)) return EDGE_STYLE_REGISTRY[key];
  }
  return FALLBACK_EDGE_STYLE;
}

// ── Display Label ────────────────────────────────────────────────────

/** Extracts short_name or has_name from a ConceptInstance's attributes JSON blob. */
function extractNameFromAttrs(attributes: unknown): string | null {
  if (typeof attributes !== 'string' || attributes.length === 0) return null;
  try {
    const attrs = JSON.parse(attributes) as Record<string, unknown>;
    return (
      (typeof attrs.short_name === 'string' && attrs.short_name.length > 0 ? attrs.short_name : null) ??
      (typeof attrs.has_name   === 'string' && attrs.has_name.length   > 0 ? attrs.has_name   : null)
    );
  } catch {
    return null;
  }
}

const NAME_MAX = 25;
function truncateName(s: string): string {
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX) + '…' : s;
}

/**
 * Derives the Cytoscape display label for a node.
 *
 * RIA_UNIV_ConceptInstance → two lines: concept on line 1, name on line 2
 *   (name = short_name or has_name from attributes JSON, truncated to 25 chars)
 *   If no name is available, just the concept is shown.
 *
 * All other node types → single line: name / node_id / id / first string prop
 */
export function deriveDisplayLabel(node: GraphNode): string {
  const props = node.properties;

  if (node.label === 'RIA_UNIV_ConceptInstance') {
    const concept = typeof props.concept === 'string' && props.concept.length > 0
      ? props.concept
      : node.id;
    const name = extractNameFromAttrs(props.attributes);
    return name ? `${concept}\n${truncateName(name)}` : concept;
  }

  // All other node types — single label
  let raw: string | undefined;
  if (typeof props.name === 'string' && props.name.length > 0) {
    raw = props.name;
  } else if (props.node_id !== undefined && props.node_id !== null && String(props.node_id).length > 0) {
    raw = String(props.node_id);
  } else if (typeof props.id === 'string' && props.id.length > 0) {
    raw = props.id;
  } else {
    for (const v of Object.values(props)) {
      if (typeof v === 'string' && v.length > 0) { raw = v; break; }
    }
  }
  return raw ?? node.id;
}

// ── Graph Merge Utilities ────────────────────────────────────────────

/**
 * Merges expansion results into existing graph elements.
 * Deduplicates by id — preserves all existing elements and adds new ones.
 */
export function mergeGraphElements(
  existing: { nodes: GraphNode[]; edges: GraphEdge[] },
  result: { nodes: GraphNode[]; edges: GraphEdge[] },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeIds = new Set(existing.nodes.map((n) => n.id));
  const edgeIds = new Set(existing.edges.map((e) => e.id));

  const newNodes = result.nodes.filter((n) => !nodeIds.has(n.id));
  const newEdges = result.edges.filter((e) => !edgeIds.has(e.id));

  return {
    nodes: [...existing.nodes, ...newNodes],
    edges: [...existing.edges, ...newEdges],
  };
}

/**
 * Merges refresh results into existing graph elements.
 * Updates properties on existing elements with fresh data from result.
 * Adds new elements from result. Never removes existing elements.
 */
export function mergeRefreshResult(
  existing: { nodes: GraphNode[]; edges: GraphEdge[] },
  result: { nodes: GraphNode[]; edges: GraphEdge[] },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map(existing.nodes.map((n) => [n.id, n]));
  const edgeMap = new Map(existing.edges.map((e) => [e.id, e]));

  for (const node of result.nodes) {
    if (nodeMap.has(node.id)) {
      nodeMap.set(node.id, { ...nodeMap.get(node.id)!, properties: node.properties });
    } else {
      nodeMap.set(node.id, node);
    }
  }

  for (const edge of result.edges) {
    if (edgeMap.has(edge.id)) {
      edgeMap.set(edge.id, { ...edgeMap.get(edge.id)!, properties: edge.properties });
    } else {
      edgeMap.set(edge.id, edge);
    }
  }

  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}
