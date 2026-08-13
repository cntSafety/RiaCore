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
 * DiffGraphView — Cytoscape.js visualization of diff results.
 *
 * Fetches the full NamespaceDiffResult, renders up to MAX_GRAPH_ELEMENTS
 * changed elements. Color coding:
 *   green  = added
 *   red    = deleted
 *   orange = modified
 *   grey   = unchanged context node (referenced by a changed edge but itself unchanged)
 *
 * Falls back gracefully if the full result hasn't been fetched yet.
 *
 * --- Crash fixes ---
 *
 * 1. DANGLING EDGE ENDPOINTS (primary crash):
 *    The `cose` layout iterates every edge to compute spring forces between its
 *    source and target nodes. Previously, only *changed* nodes were added to the
 *    graph, but edges can connect *unchanged* nodes that appear in none of the
 *    three change arrays. Cytoscape dereferences `undefined` for missing endpoints
 *    and throws a TypeError inside `useEffect`, crashing the component tree.
 *    Fix: `buildCytoscapeElements` now tracks added node IDs in a Set and calls
 *    `ensureNode()` for every edge endpoint. Missing endpoints are inserted as
 *    semi-transparent "context" nodes (grey, dashed border) so the graph is always
 *    topologically self-consistent.
 *
 * 2. ZERO-SIZE CONTAINER (secondary crash / blank graph):
 *    Ant Design <Tabs> renders all pane children up-front (hidden, not destroyed).
 *    When the diff result arrives the `useEffect` may fire while the graph panel
 *    is invisible (zero pixel dimensions). Cytoscape's `cose` layout divides by
 *    the container's bounding-box width/height; a zero-size container produces
 *    NaN-infected coordinates that corrupt the layout state.
 *    Fix: cytoscape is only instantiated once the container has non-zero dimensions
 *    (checked synchronously, then deferred via ResizeObserver). When the user
 *    switches to the graph tab the observer fires, calls cy.resize()+cy.fit(), and
 *    — if the instance wasn't created yet — initialises it at that point.
 */

import { useEffect, useRef } from 'react';
import { Alert, Spin, Typography, theme } from 'antd';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import type { NamespaceDiffResult } from '@riacore/app-contracts';
import { useDiffResult } from '../../hooks/useDiffMutations';

const { useToken } = theme;
const { Text } = Typography;

const MAX_GRAPH_ELEMENTS = 500;

const CHANGE_COLORS = {
  added:    '#52c41a',
  deleted:  '#ff4d4f',
  modified: '#fa8c16',
  context:  '#8c8c8c',  // unchanged node referenced by a changed edge
};

interface Props {
  diffId: string;
}

interface BuildResult {
  elements: ElementDefinition[];
  capped: boolean;
  total: number;
  hasContextNodes: boolean;
}

export function buildCytoscapeElements(result: NamespaceDiffResult): BuildResult {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];
  let total = 0;
  let capped = false;
  let hasContextNodes = false;

  /**
   * Resolve a human-readable display label from a node's attributes.
   * Tries well-known name attributes in priority order, then falls back
   * to a truncated stableId. Prepends a short concept type tag for context.
   */
  const resolveDisplayLabel = (
    stableId: string,
    conceptType: string,
    attributes: Record<string, unknown>,
  ): string => {
    // Priority list of name-bearing attributes across metamodels
    const nameValue =
      attributes['has_name'] ??
      attributes['short_name'] ??
      attributes['req_name'] ??
      attributes['name'] ??
      attributes['title'] ??
      attributes['note_text'] ??
      attributes['tag_name'];
    let name = typeof nameValue === 'string' && nameValue.trim()
      ? nameValue.trim()
      : null;

    // If the name is generic (matches concept type label), enrich with a secondary attribute
    if (name) {
      const genericNames = new Set([conceptType, conceptType.replace(/_/g, ' ')]);
      if (genericNames.has(name.toLowerCase()) || name.toLowerCase() === conceptType.replace(/_/g, ' ')) {
        const secondary =
          attributes['risk_rating_note'] ??
          attributes['description'] ??
          attributes['task_description'] ??
          attributes['malfunction_description'] ??
          attributes['req_text'] ??
          attributes['reviewer_comment'];
        if (typeof secondary === 'string' && secondary.trim()) {
          const trimmed = secondary.trim();
          const truncated = trimmed.length > 23 ? trimmed.slice(0, 23) + '…' : trimmed;
          name = `${name} (${truncated})`;
        }
      }
    }

    // Short concept tag (e.g. "malfunction" → "malfunction", "application_swc" → "application_swc")
    const tag = conceptType || '';

    if (name) {
      return tag ? `[${tag}]\n${name}` : name;
    }
    // Fallback: truncated stableId
    const shortId = stableId.length > 12 ? stableId.slice(0, 8) + '…' : stableId;
    return tag ? `[${tag}]\n${shortId}` : shortId;
  };

  /** Add a node, ignoring duplicates. Returns false if the budget is exhausted. */
  const addNode = (id: string, label: string, color: string, isContext = false): boolean => {
    if (!id || nodeIds.has(id)) return true;          // already present (or invalid)
    if (total >= MAX_GRAPH_ELEMENTS) { capped = true; return false; }
    nodeIds.add(id);
    nodes.push({ data: { id, label, color, isContext } });
    if (isContext) hasContextNodes = true;
    total++;
    return true;
  };

  /**
   * Guarantee the node exists in the graph.
   * If it is not yet present (i.e. it is an unchanged node referenced by an edge)
   * it is added as a grey "context" node.
   * Returns false if the budget prevents adding it.
   */
  const ensureNode = (id: string): boolean => {
    if (!id) return false;
    if (nodeIds.has(id)) return true;
    // Context nodes have no snapshot — use truncated ID as label
    const shortId = id.length > 12 ? id.slice(0, 8) + '…' : id;
    return addNode(id, shortId, CHANGE_COLORS.context, true);
  };

  /** Add an edge, deduplicating by (source, target, label). */
  const addEdge = (source: string, target: string, label: string, color: string): void => {
    if (!source || !target) return;
    const id = `e_${source}_${target}_${label}`;
    if (edgeIds.has(id)) return;
    if (total >= MAX_GRAPH_ELEMENTS) { capped = true; return; }
    // Ensure both endpoints are present — if either can't fit, skip the edge too.
    if (!ensureNode(source) || !ensureNode(target)) return;
    edgeIds.add(id);
    edges.push({ data: { id, source, target, label, color } });
    total++;
  };

  // Changed nodes — use display labels from attributes
  for (const n of result.addedNodes)    addNode(n.stableId, resolveDisplayLabel(n.stableId, n.conceptType, n.attributes), CHANGE_COLORS.added);
  for (const n of result.deletedNodes)  addNode(n.stableId, resolveDisplayLabel(n.stableId, n.conceptType, n.attributes), CHANGE_COLORS.deleted);
  for (const n of result.modifiedNodes) {
    const snapshot = n.rightSnapshot ?? n.leftSnapshot;
    addNode(n.stableId, resolveDisplayLabel(n.stableId, n.conceptType, snapshot.attributes), CHANGE_COLORS.modified);
  }

  // Intra-namespace edges — context nodes are auto-inserted for dangling endpoints
  for (const e of result.addedEdges)    addEdge(e.sourceStableId, e.targetStableId, e.relationshipType, CHANGE_COLORS.added);
  for (const e of result.deletedEdges)  addEdge(e.sourceStableId, e.targetStableId, e.relationshipType, CHANGE_COLORS.deleted);
  for (const e of result.modifiedEdges) addEdge(e.sourceStableId, e.targetStableId, e.relationshipType, CHANGE_COLORS.modified);

  // Cross-namespace edges — qualify node IDs with namespace to avoid collisions
  const qualifyNodeId = (ns: string, id: string): string => `${ns}:${id}`;
  
  for (const e of result.addedCrossNsEdges) {
    const sourceId = qualifyNodeId(e.sourceNamespace, e.sourceStableId);
    const targetId = qualifyNodeId(e.targetNamespace, e.targetStableId);
    addEdge(sourceId, targetId, e.relationshipType, CHANGE_COLORS.added);
  }
  for (const e of result.deletedCrossNsEdges) {
    const sourceId = qualifyNodeId(e.sourceNamespace, e.sourceStableId);
    const targetId = qualifyNodeId(e.targetNamespace, e.targetStableId);
    addEdge(sourceId, targetId, e.relationshipType, CHANGE_COLORS.deleted);
  }
  for (const e of result.modifiedCrossNsEdges) {
    const sourceId = qualifyNodeId(e.sourceNamespace, e.sourceStableId);
    const targetId = qualifyNodeId(e.targetNamespace, e.targetStableId);
    addEdge(sourceId, targetId, e.relationshipType, CHANGE_COLORS.modified);
  }

  return { elements: [...nodes, ...edges], capped, total, hasContextNodes };
}

export function DiffGraphView({ diffId }: Props) {
  const { token } = useToken();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const { data: result, isLoading, isError } = useDiffResult(diffId);

  useEffect(() => {
    if (!containerRef.current || !result) return;

    const container = containerRef.current;
    const { elements } = buildCytoscapeElements(result);

    // Destroy any previous instance (result changed or theme changed)
    cyRef.current?.destroy();
    cyRef.current = null;

    const cytoscapeStyle: cytoscape.StylesheetStyle[] = [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          'label': 'data(label)',
          'font-size': '9px',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'width': 20,
          'height': 20,
          'color': token.colorText,
          'text-max-width': '120px',
          'text-wrap': 'wrap',
        },
      },
      {
        // Context (unchanged) nodes: dashed border, reduced opacity
        selector: 'node[?isContext]',
        style: {
          'border-width': 1,
          'border-color': CHANGE_COLORS.context,
          'border-style': 'dashed',
          'opacity': 0.6,
        },
      },
      {
        selector: 'edge',
        style: {
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'width': 1.5,
          'label': 'data(label)',
          'font-size': '8px',
          'color': token.colorTextSecondary,
        },
      },
    ];

    /**
     * Initialise Cytoscape once — guarded against double-init.
     * Must only be called when the container has non-zero dimensions;
     * calling with a 0×0 container makes the `cose` layout divide by zero,
     * producing NaN-infected coordinates that leave the canvas permanently blank.
     */
    const initCytoscape = (c: HTMLDivElement): void => {
      if (cyRef.current) return; // already initialised
      try {
        cyRef.current = cytoscape({
          container: c,
          elements,
          style: cytoscapeStyle,
          layout: { name: 'cose', animate: false } as cytoscape.LayoutOptions,
        });
        // Centre all elements in the viewport after layout
        cyRef.current.fit(undefined, 24);
      } catch (err) {
        console.error('[DiffGraphView] cytoscape initialisation failed:', err);
      }
    };

    /**
     * Defer by one animation frame so the browser has committed the layout
     * (getBoundingClientRect returns real pixel dimensions) before Cytoscape
     * measures the container for its viewport.
     *
     * If the container is still 0×0 after the rAF (e.g. because Ant Design's
     * .ant-tabs-tabpane has not yet received its height from the CSS cascade),
     * we skip initialisation here and let the ResizeObserver handle it once
     * the container is actually visible and sized.
     */
    let rafId: number;
    rafId = requestAnimationFrame(() => {
      if (!containerRef.current) return; // unmounted before rAF fired
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width > 0 && height > 0) {
        initCytoscape(containerRef.current);
      }
      // else: container is still 0-size; ResizeObserver will trigger init
    });

    /**
     * ResizeObserver handles two cases:
     *   a) Lazy init: container was 0-size when rAF fired; init as soon as it
     *      becomes non-zero (e.g. user switches to the graph tab and Ant Design
     *      finishes applying the tab-pane height).
     *   b) Viewport sync: user resizes the window or drags a split pane after
     *      Cytoscape was already initialised.
     */
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !containerRef.current) return;
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return; // still not visible
      if (cyRef.current) {
        // Already initialised — sync viewport to new dimensions
        cyRef.current.resize();
        cyRef.current.fit(undefined, 24);
      } else {
        // Lazy init: container was 0-size when the component first mounted
        initCytoscape(containerRef.current);
      }
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [result, token.colorText, token.colorTextSecondary]);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
        <Spin />
      </div>
    );
  }

  if (isError || !result) {
    return (
      <Alert
        type="error"
        message="Failed to load diff result for graph view."
        style={{ margin: 16 }}
      />
    );
  }

  const { capped, total, hasContextNodes } = buildCytoscapeElements(result);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {capped && (
        <Alert
          type="warning"
          banner
          showIcon
          message={`Graph capped at ${MAX_GRAPH_ELEMENTS} elements (${total - MAX_GRAPH_ELEMENTS}+ more exist). Use the List view for full results.`}
          style={{ flexShrink: 0, fontSize: 12, padding: '2px 8px' }}
        />
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, padding: '4px 12px', flexShrink: 0, fontSize: 11 }}>
        {(Object.entries(CHANGE_COLORS) as [string, string][])
          .filter(([kind]) => kind !== 'context' || hasContextNodes)
          .map(([kind, color]) => (
            <span key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
              <Text style={{ fontSize: 11, color: token.colorTextSecondary }}>
                {kind === 'context' ? 'unchanged (context)' : kind}
              </Text>
            </span>
          ))}
      </div>

      <div
        ref={containerRef}
        style={{
          flex: 1,
          background: token.colorBgLayout,
          minHeight: 0,
        }}
      />
    </div>
  );
}
