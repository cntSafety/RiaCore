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
import {
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import cytoscape, { type Core, type StylesheetStyle } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { GraphNode, GraphEdge } from '@riacore/app-contracts';
import {
  NODE_STYLE_REGISTRY,
  FALLBACK_NODE_STYLE,
  EDGE_STYLE_REGISTRY,
  FALLBACK_EDGE_STYLE,
  deriveDisplayLabel,
  conceptColor,
} from './graphStyles';
import { api } from '../../api/riacore';

// Register the fcose layout once at module load
cytoscape.use(fcose);

// fcose layout options tuned for the Graph-Core viewer
// 'proof' quality is required for nodeDimensionsIncludeLabels to take effect,
// which prevents node labels from overlapping after we made edge labels
// always visible. The extra runtime is acceptable for typical graph sizes.
const FCOSE_LAYOUT: cytoscape.LayoutOptions = {
  name: 'fcose',
  quality: 'proof',
  animate: false,
  // Account for label bounding boxes when computing positions — this is the
  // key setting that prevents the label overlap visible in dense sub-graphs.
  nodeDimensionsIncludeLabels: true,
  // Increased spacing to give labels room to breathe now that both node
  // labels and edge labels are always visible.
  nodeSeparation: 150,
  idealEdgeLength: 150,
  nodeRepulsion: 8000,
  // Gravity pulls disconnected components toward centre so they don't drift off-screen
  gravity: 0.25,
  gravityRange: 3.8,
  // Pack disconnected components tightly together
  packComponents: true,
  // Fit and centre after layout completes
  fit: true,
  padding: 30,
  randomize: true,
  numIter: 2500,
} as cytoscape.LayoutOptions;

// ── Props ────────────────────────────────────────────────────────────

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  expandedNodeIds: Set<string>;
  expandingNodeIds: Set<string>;
  onSelect: (element: GraphNode | GraphEdge | null) => void;
  onExpand: (nodeId: string, nodeLabel: string, properties: Record<string, unknown>) => void;
  /** Called when the user hides a node via the context menu. */
  onHideNode?: (nodeId: string) => void;
}

/** Imperative API exposed via ref so the parent can choose the update mode. */
export interface GraphCanvasHandle {
  /** Full replacement — remove all, add all, run cose layout. */
  setElements(nodes: GraphNode[], edges: GraphEdge[]): void;
  /** Expansion merge — add only new elements near the expanded node. */
  mergeExpansion(
    newNodes: GraphNode[],
    newEdges: GraphEdge[],
    expandedNodeId: string,
  ): void;
  /** Refresh merge — update existing data in-place, add new, preserve positions. */
  refreshElements(nodes: GraphNode[], edges: GraphEdge[]): void;
  /** Remove a node and its connected edges from the canvas. */
  removeNode(nodeId: string): void;
}

// ── Stylesheet builder ───────────────────────────────────────────────

function buildStylesheet(): StylesheetStyle[] {
  const styles: StylesheetStyle[] = [];

  // ── Base node style ──
  styles.push({
    selector: 'node',
    style: {
      'background-color': FALLBACK_NODE_STYLE.color,
      width: FALLBACK_NODE_STYLE.size,
      height: FALLBACK_NODE_STYLE.size,
      label: 'data(displayLabel)',
      'font-size': 10,
      'text-wrap': 'wrap',
      'text-max-width': '100px',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 4,
      color: '#e5e7eb',
      'text-outline-color': '#0f172a',
      'text-outline-width': 2,
      'text-background-color': '#0f172a',
      'text-background-opacity': 0.6,
      'text-background-padding': '2px',
      'text-background-shape': 'roundrectangle',
      'border-width': 0,
      'border-color': '#ffffff',
    } as cytoscape.Css.Node,
  });

  // ── Per-label node styles ──
  for (const [label, { color, size }] of Object.entries(NODE_STYLE_REGISTRY)) {
    styles.push({
      selector: `node[label = "${label}"]`,
      style: {
        'background-color': color,
        width: size,
        height: size,
      },
    });
  }

  // ── Expanded node indicator ──
  styles.push({
    selector: 'node.expanded',
    style: {
      'border-width': 3,
      'border-color': '#ffffff',
    },
  });

  // ── Expanding node (pulsing) ──
  styles.push({
    selector: 'node.expanding',
    style: {
      'border-width': 4,
      'border-color': '#60a5fa',
      'border-style': 'dashed',
    } as cytoscape.Css.Node,
  });

  // ── Base edge style — labels always visible so users see relation types ──
  styles.push({
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': FALLBACK_EDGE_STYLE.color,
      'target-arrow-color': FALLBACK_EDGE_STYLE.color,
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
      'line-style': 'solid',
      opacity: 0.7,
      label: 'data(relationshipLabel)',
      'font-size': 8,
      'text-rotation': 'autorotate',
      color: '#9ca3af',
      'text-outline-color': '#111827',
      'text-outline-width': 2,
      'text-background-color': '#111827',
      'text-background-opacity': 0.6,
      'text-background-padding': '2px',
    },
  });

  // ── Per-group edge styles ──
  for (const [group, { color, lineStyle }] of Object.entries(EDGE_STYLE_REGISTRY)) {
    styles.push({
      selector: `edge[type ^= "${group}"]`,
      style: {
        'line-color': color,
        'target-arrow-color': color,
        'line-style': lineStyle,
      },
    });
  }

  // ── Hovered / selected edge: emphasise label + line ──
  styles.push({
    selector: 'edge:selected, edge.hover',
    style: {
      width: 3,
      opacity: 1,
      'font-size': 10,
      color: '#f3f4f6',
      'text-outline-color': '#1f2937',
      'text-outline-width': 2,
      'text-background-color': '#1f2937',
      'text-background-opacity': 0.9,
      'text-background-padding': '3px',
      'z-index': 10,
    } as cytoscape.Css.Edge,
  });

  // ── Node: hovered / selected border ──
  styles.push({
    selector: 'node:selected',
    style: {
      'border-width': 3,
      'border-color': '#60a5fa',
      'z-index': 10,
    },
  });

  return styles;
}

// ── Helpers ──────────────────────────────────────────────────────────

function toCyNode(node: GraphNode, expandedIds: Set<string>, expandingIds: Set<string>) {
  const classes: string[] = [];
  if (expandedIds.has(node.id)) classes.push('expanded');
  if (expandingIds.has(node.id)) classes.push('expanding');

  // Spread properties first, then override with our fields to prevent
  // user properties (e.g. a "id" column on RIA_META_Concept) from
  // clobbering the Cytoscape element id / source / target.
  return {
    group: 'nodes' as const,
    data: {
      ...node.properties,
      id: node.id,
      label: node.label,
      displayLabel: deriveDisplayLabel(node),
      _graphNode: node,
    },
    classes: classes.join(' '),
  };
}

function toCyEdge(edge: GraphEdge) {
  const relationship = edge.properties.relationship;
  const relationshipLabel =
    typeof relationship === 'string' && relationship.trim().length > 0
      ? relationship
      : edge.type;

  return {
    group: 'edges' as const,
    data: {
      ...edge.properties,
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      relationshipLabel,
      _graphEdge: edge,
    },
  };
}

// ── Component ────────────────────────────────────────────────────────

/** Apply concept-based colors to ConceptInstance nodes. */
function applyConceptColors(cy: Core) {
  cy.nodes().forEach((ele) => {
    const label = ele.data('label');
    const concept = ele.data('concept');
    if (label === 'RIA_UNIV_ConceptInstance' && typeof concept === 'string' && concept.length > 0) {
      ele.style('background-color', conceptColor(concept));
    }
  });
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas(
    { expandedNodeIds, expandingNodeIds, onSelect, onExpand, onHideNode },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<Core | null>(null);

    // Keep latest callbacks in refs so Cytoscape event handlers always see current values
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onExpandRef = useRef(onExpand);
    onExpandRef.current = onExpand;
    const onHideNodeRef = useRef(onHideNode);
    onHideNodeRef.current = onHideNode;

    // Keep latest expanded/expanding sets in refs for toCyNode calls
    const expandedRef = useRef(expandedNodeIds);
    expandedRef.current = expandedNodeIds;
    const expandingRef = useRef(expandingNodeIds);
    expandingRef.current = expandingNodeIds;

    // ── Mount / Unmount ──
    useEffect(() => {
      if (!containerRef.current) return;

      const cy = cytoscape({
        container: containerRef.current,
        elements: [],
        style: buildStylesheet(),
        userPanningEnabled: true,
        userZoomingEnabled: true,
        boxSelectionEnabled: false,
      });

      // ── Events ──
      cy.on('tap', 'node', (evt) => {
        const nodeData = evt.target.data();
        const original: GraphNode | undefined = nodeData._graphNode;
        if (original) onSelectRef.current(original);
      });

      cy.on('tap', 'edge', (evt) => {
        const edgeData = evt.target.data();
        const original: GraphEdge | undefined = edgeData._graphEdge;
        if (original) onSelectRef.current(original);
      });

      cy.on('tap', (evt) => {
        if (evt.target === cy) {
          onSelectRef.current(null);
        }
      });

      cy.on('dblclick', 'node', (evt) => {
        const nodeData = evt.target.data();
        const original: GraphNode | undefined = nodeData._graphNode;
        if (original) {
          onExpandRef.current(original.id, original.label, original.properties);
        }
      });

      // Show edge label on hover by toggling the 'hover' class
      cy.on('mouseover', 'edge', (evt) => {
        evt.target.addClass('hover');
      });
      cy.on('mouseout', 'edge', (evt) => {
        evt.target.removeClass('hover');
      });

      // ── Right-click context menu on nodes ──
      cy.on('cxttap', 'node', (evt) => {
        evt.originalEvent.preventDefault();
        const nodeData = evt.target.data();
        const original: GraphNode | undefined = nodeData._graphNode;
        if (!original) return;

        const items = [
          { id: 'hide', label: 'Hide Node' },
          { id: 'expand', label: 'Expand Node' },
        ];

        void api.contextMenu.show(items).then((selectedId) => {
          if (selectedId === 'hide') {
            onHideNodeRef.current?.(original.id);
          } else if (selectedId === 'expand') {
            onExpandRef.current(original.id, original.label, original.properties);
          }
        });
      });

      cyRef.current = cy;

      // ── ResizeObserver — tell Cytoscape whenever the container changes size ──
      // This is critical: Cytoscape initialises when the container may still be
      // 0×0 (flex layout hasn't resolved). The observer fires on the first real
      // size and on every subsequent resize (panel drag, window resize, etc.).
      const ro = new ResizeObserver(() => {
        if (!cy.destroyed()) cy.resize();
      });
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        cy.destroy();
        cyRef.current = null;
      };
    }, []);

    // ── Sync expanded / expanding CSS classes ──
    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) return;

      cy.nodes().forEach((ele) => {
        const id = ele.id();
        if (expandedNodeIds.has(id)) {
          ele.addClass('expanded');
        } else {
          ele.removeClass('expanded');
        }
        if (expandingNodeIds.has(id)) {
          ele.addClass('expanding');
        } else {
          ele.removeClass('expanding');
        }
      });
    }, [expandedNodeIds, expandingNodeIds]);

    // ── Imperative API ──
    const setElements = useCallback(
      (newNodes: GraphNode[], newEdges: GraphEdge[]) => {
        const cy = cyRef.current;
        if (!cy) return;

        // Ensure Cytoscape knows the current container size before layout
        cy.resize();

        cy.elements().remove();

        const cyNodes = newNodes.map((n) =>
          toCyNode(n, expandedRef.current, expandingRef.current),
        );
        const cyEdges = newEdges.map(toCyEdge);
        cy.add([...cyNodes, ...cyEdges]);

        applyConceptColors(cy);

        if (newNodes.length > 0) {
          cy.layout(FCOSE_LAYOUT).run();
        }
      },
      [],
    );

    const mergeExpansion = useCallback(
      (
        newNodes: GraphNode[],
        newEdges: GraphEdge[],
        expandedNodeId: string,
      ) => {
        const cy = cyRef.current;
        if (!cy) return;

        // Collect IDs of all nodes that already exist before adding new ones
        const existingNodeIds = new Set<string>();
        cy.nodes().forEach((ele) => { existingNodeIds.add(ele.id()); });

        // Only add elements not already present
        const cyNodes = newNodes
          .filter((n) => !cy.getElementById(n.id).length)
          .map((n) => toCyNode(n, expandedRef.current, expandingRef.current));
        const cyEdges = newEdges
          .filter((e) => !cy.getElementById(e.id).length)
          .map(toCyEdge);

        if (cyNodes.length === 0 && cyEdges.length === 0) return;

        const added = cy.add([...cyNodes, ...cyEdges]);

        applyConceptColors(cy);

        // Seed new nodes near the expanded node so fcose has a reasonable
        // starting position (avoids them spawning at 0,0).
        const expandedEle = cy.getElementById(expandedNodeId);
        if (expandedEle.length && added.nodes().length) {
          const pos = expandedEle.position();
          added.nodes().forEach((n, i) => {
            const angle = (2 * Math.PI * i) / Math.max(added.nodes().length, 1);
            n.position({
              x: pos.x + 150 * Math.cos(angle),
              y: pos.y + 150 * Math.sin(angle),
            });
          });
        }

        // Pin all pre-existing nodes at their current positions so the user's
        // manual arrangement is preserved. Only the newly added nodes will be
        // positioned by fcose.
        const fixedNodeConstraint: { nodeId: string; position: { x: number; y: number } }[] = [];
        cy.nodes().forEach((ele) => {
          if (existingNodeIds.has(ele.id())) {
            const pos = ele.position();
            fixedNodeConstraint.push({ nodeId: ele.id(), position: { x: pos.x, y: pos.y } });
          }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fcose-specific options not in base LayoutOptions
        cy.layout({
          ...FCOSE_LAYOUT,
          // Don't randomize — we want new nodes to start from their seeded
          // positions near the expanded node, not random locations.
          randomize: false,
          fixedNodeConstraint,
          // Fit the viewport to include the new nodes without jumping
          fit: true,
        } as any).run();
      },
      [],
    );

    const refreshElements = useCallback(
      (refreshNodes: GraphNode[], refreshEdges: GraphEdge[]) => {
        const cy = cyRef.current;
        if (!cy) return;

        for (const node of refreshNodes) {
          const existing = cy.getElementById(node.id);
          if (existing.length) {
            existing.data({
              label: node.label,
              displayLabel: deriveDisplayLabel(node),
              ...node.properties,
              _graphNode: node,
            });
          } else {
            cy.add(toCyNode(node, expandedRef.current, expandingRef.current));
          }
        }

        for (const edge of refreshEdges) {
          const existing = cy.getElementById(edge.id);
          if (existing.length) {
            existing.data({
              type: edge.type,
              ...edge.properties,
              _graphEdge: edge,
            });
          } else {
            cy.add(toCyEdge(edge));
          }
        }

        applyConceptColors(cy);
      },
      [],
    );

    const removeNode = useCallback((nodeId: string) => {
      const cy = cyRef.current;
      if (!cy) return;
      const ele = cy.getElementById(nodeId);
      if (ele.length) {
        // Remove the node and all its connected edges
        ele.connectedEdges().remove();
        ele.remove();
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({ setElements, mergeExpansion, refreshElements, removeNode }),
      [setElements, mergeExpansion, refreshElements, removeNode],
    );

    return (
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: '#111827' }}
      />
    );
  },
);
