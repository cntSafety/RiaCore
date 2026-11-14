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
import type { AggregatedRelationshipContainer, AggregatedRelationshipEdge, AggregatedRelationshipsResult } from '@riacore/app-contracts';
import { computeElkLayout, type ElkLayoutResult, type ElkNodeInput } from './elkLayout';
import { computeRadialCityLayout, type AggregationLayoutResult } from './cgraphRadialLayout';
import { computeIncrementalLayout, type AggregationLayoutHint } from './cgraphIncrementalLayout';

/** The metamodel name CGraph importer registers (see cgraph-core's CGRAPH_METAMODEL_NAME). */
export const CGRAPH_METAMODEL = 'CGraphV2';

/**
 * Cheap pre-filter: could this concept possibly route to the CGraph lens?
 *
 * Runs before the element's metamodel is known, so it only exists to keep the
 * SysML/ARXML path from mounting the metamodel-resolving route. A false
 * positive is harmless — that route falls back to the standard canvas when the
 * metamodel does not match — so a prefix test is preferable to a list of
 * concept names, which would have to be kept in step with the metamodel by
 * hand. Every CGraph concept is `c_`-prefixed; no shipped concept from another
 * metamodel is (ARXML's nearest are `cdd_swc` and `cs_interface`).
 */
export function mayUseCGraphAggregationModel(concept: string): boolean {
  return concept.startsWith('c_');
}

/**
 * The authoritative gate: any element of a CGraph namespace gets this lens.
 *
 * Deliberately concept-independent. It used to admit only `c_component` and
 * `c_file`, on the reasoning that an aggregation is meaningful only where there
 * are containment children to aggregate — but the backend rolls up whatever
 * crosses the subtree boundary, and for a leaf that is its own call and
 * data-access neighbourhood, which is the question most often asked of a
 * function. Measured on a reference corpus: a function yields its callers,
 * callees and types; a variable yields the functions that take its address; a
 * typedef yields what it aliases; an external symbol yields the component that
 * declares it. The only concepts that produce nothing are those with no
 * outbound relationships at all, and the diagram already states that plainly
 * rather than rendering blank.
 *
 * Matching the metamodel by prefix keeps a future major (CGraphV3) working, the
 * same way the tree decoration does.
 */
export function usesCGraphAggregationModel(metamodel: string | undefined): boolean {
  return typeof metamodel === 'string' && metamodel.startsWith('CGraph');
}

/**
 * CGraph's relationship slots, grouped the way the diagram filters them. Kept
 * separate from the backend, which stays metamodel-agnostic: any relationship
 * name not listed here (e.g. a future slot, or a different importer entirely)
 * falls into `other` rather than being dropped.
 */
export type RelationshipCategory = 'control' | 'data' | 'structural' | 'other';

const CATEGORY_BY_RELATIONSHIP: Record<string, RelationshipCategory> = {
  calls: 'control',
  calls_external: 'control',
  reads: 'data',
  writes: 'data',
  read_writes: 'data',
  references: 'data',
  registers: 'data',
  takes_address_of: 'data',
  // CGraph 2.6.0. may_dispatch_to and dispatches_through describe indirect
  // calls; binds and flows_to move values between ports; may_read/may_write
  // are the value-analysis counterparts of reads/writes.
  may_dispatch_to: 'control',
  dispatches_through: 'control',
  may_read: 'data',
  may_write: 'data',
  binds: 'data',
  flows_to: 'data',
  has_return: 'structural',
  has_indirect_call_site: 'structural',
  owns_region: 'structural',
  declares: 'structural',
  includes: 'structural',
  defines: 'structural',
  defines_type: 'structural',
  has_member_type: 'structural',
  has_member: 'structural',
  has_parameter: 'structural',
  has_type: 'structural',
  returns: 'structural',
  aliases: 'structural',
};

export function classifyRelationship(relationship: string): RelationshipCategory {
  return CATEGORY_BY_RELATIONSHIP[relationship] ?? 'other';
}

export const CATEGORY_ORDER: RelationshipCategory[] = ['control', 'data', 'structural', 'other'];

export const CATEGORY_LABEL: Record<RelationshipCategory, string> = {
  control: 'Calls',
  data: 'Data access',
  structural: 'Structural',
  other: 'Other',
};

/** Line color per category — kept distinct from the ASIL palette used elsewhere. */
export const CATEGORY_COLOR: Record<RelationshipCategory, string> = {
  control: '#4f8ef0',
  data: '#d48806',
  structural: '#8c8c8c',
  other: '#9254de',
};

export const CATEGORY_DASH: Record<RelationshipCategory, string | undefined> = {
  control: undefined,
  data: '6 4',
  structural: '2 3',
  other: '1 3',
};

export const AGGREGATION_NODE_WIDTH = 220;
export const AGGREGATION_NODE_HEIGHT = 72;

/**
 * Depths the lens offers. 1 is the flat rollup.
 *
 * The ceiling matches the channel's own, so the control cannot ask for
 * something the backend will clamp. 5 is what deep directory nesting needs to
 * reach a function: a component three `contains_component` levels inside
 * another spends three levels before it reaches a file at all.
 *
 * A level being offered does not mean every selection can be drawn at it. The
 * backend reduces the depth it applies to whatever fits, which is why
 * `requestedDepth` exists and why the canvas reports a reduction.
 */
export const AGGREGATION_DEPTHS = [1, 2, 3, 4, 5] as const;
export const AGGREGATION_DEFAULT_DEPTH = 1;

/**
 * Calls on by default; data access, structural facts and anything unclassified
 * start hidden to keep the first view readable.
 */
export const AGGREGATION_DEFAULT_CATEGORIES: readonly RelationshipCategory[] = ['control'];

/** Room a frame reserves for its own title row, above whatever is nested in it. */
export const AGGREGATION_FRAME_HEADER = 38;
/**
 * Clearance a frame keeps between its border and the boxes inside it.
 *
 * Only whitespace here, unlike the model view's `FRAME_INSET`: this view has no
 * delegation routes that have to run inside the border, because containment is
 * never drawn as an edge. So it is set for legibility — enough that the border,
 * the gap, and the child read as three things — rather than derived from a
 * router's requirements.
 */
export const AGGREGATION_FRAME_PADDING = 18;

export interface AggregationGraphNode {
  id: string;
  container: AggregatedRelationshipContainer;
  /** The selected element — the one box the layout centres on. Exactly one per graph. */
  isRoot: boolean;
  /**
   * An element the reader expanded, so its own rollup is merged into this graph
   * too. Drawn with a marker, and offered "Collapse" rather than "Expand".
   */
  isExpansionRoot: boolean;
  /**
   * The frame this box is drawn inside, as a node id, or `undefined` for a
   * top-level box. Always the id of another node in the same graph, and always
   * listed before this one — React Flow drops a child declared ahead of its
   * parent.
   */
  parentId?: string;
  /** Whether this box has visible children, and so is drawn as a frame rather than a leaf. */
  isFrame: boolean;
}

export interface AggregationGraphEdge {
  id: string;
  source: string;
  target: string;
  /** One entry per category present on this pair, in `CATEGORY_ORDER`. */
  segments: { category: RelationshipCategory; relationship: string; count: number }[];
  /**
   * Whether the opposite direction between the same two boxes is also drawn.
   *
   * Read only for label placement — see {@link aggregationLabelFraction}. Two
   * such edges are collinear, so their labels would otherwise be computed at
   * the same point and printed on top of each other.
   */
  hasCounterpart: boolean;
}

export interface CGraphAggregationGraph {
  nodes: AggregationGraphNode[];
  edges: AggregationGraphEdge[];
  /**
   * Diagram id of the selected element.
   *
   * Carried on the graph rather than being a constant, because a box's id is
   * now its node id in every case. The lens used to rewrite the selection's id
   * to the literal `'root'`, which cannot survive expansion: one rollup's root
   * is another's partner, so the same element would be `'root'` in one payload
   * and a numeric id in the next, and the merge would draw it twice.
   */
  rootId: string;
}

/**
 * Builds the diagram graph from the backend's per-relationship rollup,
 * dropping anything whose category isn't in `activeCategories` and any
 * partner left with no visible edge afterward.
 *
 * At `depth: 1` every box is top-level and this is a flat star, as it has
 * always been. Above that the payload carries `parentContainerId`, and the
 * containment chains it describes become nesting: a box an edge terminates at
 * is kept, *and so is every frame above it*, even though no edge touches the
 * frame itself — otherwise the file the call actually lands in would be drawn
 * loose on the canvas, with nothing saying which module it belongs to, which is
 * the whole point of asking for the extra level.
 *
 * Edges are not re-aggregated here. The backend already terminated each one at
 * the deepest box the requested depth allows, so what the diagram draws and
 * what the counts describe are the same thing by construction.
 */
export function buildCGraphAggregationGraph(
  results: readonly AggregatedRelationshipsResult[],
  activeCategories: ReadonlySet<RelationshipCategory>,
): CGraphAggregationGraph {
  const primary = results[0];
  if (!primary) return { nodes: [], edges: [], rootId: '' };

  /**
   * One box per element, merged by node id across every rollup.
   *
   * Node ids are plain graph ids with no per-call keying, so the same id in two
   * rollups is the same element and merging needs no re-keying. What does need
   * a policy is the containment parent: a rollup reports its own root
   * parentless and tops every other containment path out at *its* sibling
   * level, so whether a box carries a parent describes the rollup that
   * described it rather than the element. A box nested in a frame by the
   * primary rollup therefore arrives parentless from its own expansion, and a
   * last-write-wins merge would pop it out of that frame.
   *
   * So: never downgrade a known parent to none, and never overwrite one that is
   * already known.
   */
  const containers = new Map<number, AggregatedRelationshipContainer>();
  const addContainer = (container: AggregatedRelationshipContainer, pinned: boolean) => {
    const existing = containers.get(container.node_id);
    if (!existing) { containers.set(container.node_id, container); return; }
    if (pinned || existing.parentContainerId !== undefined || container.parentContainerId === undefined) return;
    containers.set(container.node_id, { ...existing, parentContainerId: container.parentContainerId });
  };

  const rootIds = new Set<number>();
  for (const result of results) {
    rootIds.add(result.root.node_id);
    // The selection stays top-level whatever a later rollup says about it. An
    // expansion rooted deeper reports it with a containment path of its own,
    // which would wrap the reader's anchor box in frames and move it — the one
    // thing an incremental expansion must not do.
    addContainer(result.root, result.root.node_id === primary.root.node_id);
    for (const container of result.containers) {
      addContainer(container, container.node_id === primary.root.node_id);
    }
  }

  /**
   * Relationships from every rollup, deduplicated by endpoint pair and name.
   *
   * The same pair can be reported by two rollups — the edge from the selection
   * to a partner appears in the selection's own rollup and again in that
   * partner's expansion. Where that happens the counts agree: a count folds the
   * underlying relationships between the two boxes' subtrees, and a
   * relationship that crosses one of the two roots' boundaries crosses the
   * other's too whenever both rollups resolve it to this same pair. `max` is
   * the tiebreak rather than a sum, because summing would double a count that
   * describes one set of relationships seen twice.
   */
  const deduped = new Map<string, { source: number; target: number; relationship: string; count: number }>();
  for (const result of results) {
    for (const edge of result.edges) {
      if (!activeCategories.has(classifyRelationship(edge.relationship))) continue;
      const key = `${edge.sourceContainerId}->${edge.targetContainerId}:${edge.relationship}`;
      const existing = deduped.get(key);
      if (existing) existing.count = Math.max(existing.count, edge.count);
      else {
        deduped.set(key, {
          source: edge.sourceContainerId,
          target: edge.targetContainerId,
          relationship: edge.relationship,
          count: edge.count,
        });
      }
    }
  }

  const grouped = new Map<string, AggregationGraphEdge>();
  const endpointIds = new Set<number>();
  for (const edge of deduped.values()) {
    endpointIds.add(edge.source);
    endpointIds.add(edge.target);
    const source = String(edge.source);
    const target = String(edge.target);
    const key = `${source}->${target}`;
    const entry = grouped.get(key) ?? { id: key, source, target, segments: [], hasCounterpart: false };
    entry.segments.push({ category: classifyRelationship(edge.relationship), relationship: edge.relationship, count: edge.count });
    grouped.set(key, entry);
  }
  for (const edge of grouped.values()) {
    edge.segments.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.relationship.localeCompare(b.relationship));
    edge.hasCounterpart = grouped.has(`${edge.target}->${edge.source}`);
  }

  // Every endpoint and every rollup root, plus the frames above each. Walking
  // up stops at a container already kept, so a module with twenty files is
  // walked once per file and added once; it ends at a container with no parent.
  // Roots are walked too — an expanded element can itself sit inside a frame,
  // and dropping that frame would leave it loose on the canvas.
  const kept = new Set<number>();
  const keepWithAncestors = (startId: number) => {
    let current: number | undefined = startId;
    while (current !== undefined && !kept.has(current)) {
      kept.add(current);
      current = containers.get(current)?.parentContainerId;
    }
  };
  for (const rootId of rootIds) keepWithAncestors(rootId);
  for (const endpointId of endpointIds) keepWithAncestors(endpointId);

  const nodeIdOfParent = (container: AggregatedRelationshipContainer): string | undefined => {
    // A parent outside `kept` cannot happen for a container reached by the walk
    // above, but a malformed payload must not produce a React Flow node whose
    // `parentId` names nothing — that silently drops the node.
    const parentId = container.parentContainerId;
    if (parentId === undefined) return undefined;
    return kept.has(parentId) ? String(parentId) : undefined;
  };
  /**
   * Containment distance from a top-level box, used only to order the node
   * list. Bounded by the container count, so a payload whose parent references
   * form a cycle yields a meaningless order rather than hanging the renderer.
   */
  const depthOf = (container: AggregatedRelationshipContainer): number => {
    let depth = 0;
    let current = container.parentContainerId;
    while (current !== undefined && depth <= containers.size) {
      depth += 1;
      current = containers.get(current)?.parentContainerId;
    }
    return depth;
  };

  const nodes: AggregationGraphNode[] = [...containers.values()]
    .filter((container) => kept.has(container.node_id))
    .map((container) => ({
      id: String(container.node_id),
      container,
      isRoot: container.node_id === primary.root.node_id,
      isExpansionRoot: rootIds.has(container.node_id) && container.node_id !== primary.root.node_id,
      parentId: nodeIdOfParent(container),
      isFrame: false,
    }));
  // Parents before children, which React Flow requires. A stable sort keeps the
  // backend's order within a level, so the layout is reproducible.
  nodes.sort((a, b) => depthOf(a.container) - depthOf(b.container));

  const framed = new Set(nodes.map((node) => node.parentId).filter((id): id is string => id !== undefined));
  for (const node of nodes) node.isFrame = framed.has(node.id);

  return { nodes, edges: [...grouped.values()], rootId: String(primary.root.node_id) };
}

/**
 * Total count across an edge's visible segments.
 *
 * Read for the edge's tooltip and for the radial layout's ring order. It used
 * to scale the stroke as well — see {@link AGGREGATION_EDGE_WIDTH} for why that
 * went.
 */
export function totalCount(edge: AggregationGraphEdge): number {
  return edge.segments.reduce((sum, segment) => sum + segment.count, 0);
}

/**
 * Every edge is one hairline, whatever it carries.
 *
 * The weight used to scale with the count, up to 8px. Two things were wrong
 * with that. The count is already printed on the edge, so the width restated
 * one number less precisely and in the only channel a reader cannot compare
 * across a crowded canvas. And SVG markers scale with `strokeWidth` by default,
 * so a heavy edge grew an arrowhead several times a box's text size — on a star
 * graph, where every arrow converges on the same two borders, that is what
 * covered the selection.
 */
export const AGGREGATION_EDGE_WIDTH = 1;
/**
 * Arrowhead box in pixels. Explicit, because React Flow's default (12.5) is
 * sized for a thicker stroke than this view draws.
 */
export const AGGREGATION_ARROW_SIZE = 9;

const AGGREGATION_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.direction': 'RIGHT',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.spacing.nodeNode': '48',
};

/**
 * The room a frame leaves inside its border, as an ELK padding vector. The top
 * clears the title row; the other three sides are plain clearance.
 */
const FRAME_PADDING_VECTOR =
  `[top=${AGGREGATION_FRAME_HEADER + AGGREGATION_FRAME_PADDING},left=${AGGREGATION_FRAME_PADDING},`
  + `bottom=${AGGREGATION_FRAME_PADDING},right=${AGGREGATION_FRAME_PADDING}]`;

/**
 * Group the graph's nodes by the frame they sit in — the inverse of the
 * `parentId` the render model carries, which is the direction ELK wants.
 */
export function aggregationChildrenByParent(graph: CGraphAggregationGraph): Map<string, AggregationGraphNode[]> {
  const byParent = new Map<string, AggregationGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.parentId === undefined) continue;
    const siblings = byParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else byParent.set(node.parentId, [node]);
  }
  return byParent;
}

/**
 * The two arrangements of the same graph.
 *
 * `radial` puts the selected element at the centre and distributes its partners
 * on rings around it, which is what this graph's shape calls for — see
 * {@link ./cgraphRadialLayout}. `layered` is ELK's `layered` algorithm, which
 * resolves a star into incoming / selection / outgoing columns: a narrow use of
 * the canvas, but the reading order some diagrams are easier to follow in, and
 * the only one of the two that is crossing-aware in the general case.
 */
export type AggregationLayoutMode = 'radial' | 'layered';
export const AGGREGATION_LAYOUT_MODES: readonly AggregationLayoutMode[] = ['radial', 'layered'];
export const AGGREGATION_DEFAULT_LAYOUT_MODE: AggregationLayoutMode = 'radial';

/** Gap between two boxes packed inside the same frame, in the radial layout. */
export const AGGREGATION_CHILD_GAP = 16;
/** Clear space between the selection and the first ring, and between rings — room for the edge labels. */
export const AGGREGATION_RING_GAP = 150;
/** Minimum arc between two neighbours on the same ring. */
export const AGGREGATION_RING_SPACING = 72;
/** Space an incrementally placed box keeps from everything already drawn. */
export const AGGREGATION_EXPANSION_CLEARANCE = 40;

/**
 * Lay the graph out, nesting frames when the graph has any.
 *
 * Both modes report the same thing: parent-relative positions (React Flow's own
 * convention for a nested node), absolute positions for anything doing geometry
 * across a frame boundary, and the size each frame ended up at — a frame's
 * `width`/`height` are a result rather than an input in either mode.
 *
 * `radial` is synchronous and `layered` is not, so this stays `async` for one
 * call site either way.
 *
 * In the ELK path, containment enters as hierarchy rather than as edges: a box
 * with a `parentId` is handed in as a child of that frame, and
 * `computeElkLayout` switches to `INCLUDE_CHILDREN` on its own once it sees
 * nesting. Every edge stays declared at the root whatever level its endpoints
 * sit on — ELK re-homes each one and the wrapper normalises the routes back to
 * canvas coordinates.
 */
export async function layoutCGraphAggregationGraph(
  graph: CGraphAggregationGraph,
  mode: AggregationLayoutMode = AGGREGATION_DEFAULT_LAYOUT_MODE,
  hint?: AggregationLayoutHint,
): Promise<AggregationLayoutResult> {
  // An expansion preserves the arrangement on screen rather than reproducing
  // the rule behind it, so the hint overrides the mode. Re-running the chosen
  // algorithm on the grown graph is what "Auto Layout" is for.
  if (hint) {
    return computeIncrementalLayout(graph, {
      leafWidth: AGGREGATION_NODE_WIDTH,
      leafHeight: AGGREGATION_NODE_HEIGHT,
      frameHeader: AGGREGATION_FRAME_HEADER,
      framePadding: AGGREGATION_FRAME_PADDING,
      childGap: AGGREGATION_CHILD_GAP,
      ringGap: AGGREGATION_RING_GAP,
      clearance: AGGREGATION_EXPANSION_CLEARANCE,
    }, hint);
  }

  if (mode === 'radial') {
    return computeRadialCityLayout(
      {
        nodes: graph.nodes,
        edges: graph.edges.map((edge) => ({ source: edge.source, target: edge.target, count: totalCount(edge) })),
      },
      {
        leafWidth: AGGREGATION_NODE_WIDTH,
        leafHeight: AGGREGATION_NODE_HEIGHT,
        frameHeader: AGGREGATION_FRAME_HEADER,
        framePadding: AGGREGATION_FRAME_PADDING,
        childGap: AGGREGATION_CHILD_GAP,
        ringGap: AGGREGATION_RING_GAP,
        ringSpacing: AGGREGATION_RING_SPACING,
        rootId: graph.rootId,
      },
    );
  }

  const childrenOf = aggregationChildrenByParent(graph);
  const toElkNode = (node: AggregationGraphNode): ElkNodeInput => {
    const children = childrenOf.get(node.id);
    return {
      id: node.id,
      width: AGGREGATION_NODE_WIDTH,
      height: AGGREGATION_NODE_HEIGHT,
      ...(children
        ? {
          children: children.map(toElkNode),
          layoutOptions: {
            // A compound node's interior is laid out against the node's own
            // options rather than the graph's, so the spacing tuned for this
            // view has to be repeated here or the inside falls back to ELK's
            // much tighter defaults.
            ...AGGREGATION_LAYOUT_OPTIONS,
            'elk.padding': FRAME_PADDING_VECTOR,
            // Keeps the given size a floor, so a frame around one small child is
            // still wide enough to read its title.
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            'elk.nodeSize.minimum': `(${AGGREGATION_NODE_WIDTH},${AGGREGATION_NODE_HEIGHT})`,
          },
        }
        : {}),
    };
  };

  const layout = await computeElkLayout({
    nodes: graph.nodes.filter((node) => node.parentId === undefined).map(toElkNode),
    edges: graph.edges.map(({ id, source, target }) => ({ id, source, target })),
    layoutOptions: AGGREGATION_LAYOUT_OPTIONS,
  });
  return layout;
}

/**
 * What a box measures after layout: ELK's computed size for a frame, the fixed
 * leaf size otherwise. The grid fallback reports the input size for every node,
 * so a frame there measures its floor and its children are drawn flat beside
 * it — degraded, which is what the fallback banner already says.
 */
export function aggregationNodeSize(
  nodeId: string,
  sizes: ElkLayoutResult['sizes'],
): { width: number; height: number } {
  return sizes.get(nodeId) ?? { width: AGGREGATION_NODE_WIDTH, height: AGGREGATION_NODE_HEIGHT };
}

/**
 * Handle ids. A box carries all eight, so an edge can leave and arrive on
 * whichever border faces its peer — in a radial arrangement a peer is as often
 * above or below as beside.
 *
 * The four horizontal ids keep the names they had, so a layered diagram anchors
 * at exactly the handles it used to.
 */
export const AGGREGATION_HANDLE = {
  sourceEast: 'out',
  sourceWest: 'out-w',
  sourceNorth: 'out-n',
  sourceSouth: 'out-s',
  targetWest: 'in',
  targetEast: 'in-e',
  targetNorth: 'in-n',
  targetSouth: 'in-s',
} as const;

/**
 * Which side of each box an edge attaches to.
 *
 * The flat diagram used one target handle on the left and one source handle on
 * the right, and that pair is half of what made it read as three columns: with
 * a star layout every route necessarily ran left to right, so the fixed sides
 * were always the facing ones. Nesting breaks that. A frame's children are laid
 * out inside it, so a call from a file in a right-hand frame back to one in a
 * left-hand frame leaves eastward, loops around both frames, and arrives from
 * the west — crossing everything in between to reach handles on the far sides of
 * its own endpoints.
 *
 * So the side is chosen from the geometry instead: whichever way the peer
 * actually lies. Absolute positions, because the two endpoints may sit in
 * different frames and a parent-relative x says nothing across that boundary.
 *
 * The radial layout extends the same argument to the other axis. A partner
 * placed directly above the selection has no facing left or right border at
 * all, and anchoring it east-to-west sends a straight line diagonally across
 * both boxes to reach a handle on the far side. So the *dominant* axis of the
 * offset picks the pair: whichever of the two deltas is larger decides whether
 * this is a horizontal or a vertical crossing, and its sign decides which way.
 * A tie keeps the left-to-right reading, which is also what a layered diagram
 * always produces.
 */
export function aggregationEdgeHandles(
  edge: Pick<AggregationGraphEdge, 'source' | 'target'>,
  layout: Pick<ElkLayoutResult, 'absolutePositions' | 'sizes'>,
): { sourceHandle: string; targetHandle: string } {
  const center = (nodeId: string): { x: number; y: number } => {
    const position = layout.absolutePositions.get(nodeId);
    if (!position) return { x: 0, y: 0 };
    const size = aggregationNodeSize(nodeId, layout.sizes);
    return { x: position.x + size.width / 2, y: position.y + size.height / 2 };
  };
  const from = center(edge.source);
  const to = center(edge.target);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: AGGREGATION_HANDLE.sourceEast, targetHandle: AGGREGATION_HANDLE.targetWest }
      : { sourceHandle: AGGREGATION_HANDLE.sourceWest, targetHandle: AGGREGATION_HANDLE.targetEast };
  }
  return dy >= 0
    ? { sourceHandle: AGGREGATION_HANDLE.sourceSouth, targetHandle: AGGREGATION_HANDLE.targetNorth }
    : { sourceHandle: AGGREGATION_HANDLE.sourceNorth, targetHandle: AGGREGATION_HANDLE.targetSouth };
}

/**
 * The three canvas controls as one value, in the widened form the store keeps.
 *
 * Deliberately `number` and `string[]` rather than this module's unions. The
 * store is a container and holds no opinion about what a valid depth or
 * category is, which is what keeps it free of any runtime import from this
 * module — and it means a stored value from a session where the sets differed
 * cannot make a field's declared type a lie. {@link resolveAggregationView} is
 * the one boundary where the widening is checked.
 */
export interface StoredAggregationView {
  depth: number;
  layoutMode: string;
  categories: string[];
}

/** The same three values narrowed back to what the canvas renders from. */
export interface AggregationView {
  depth: number;
  layoutMode: AggregationLayoutMode;
  categories: Set<RelationshipCategory>;
}

/**
 * Narrow a remembered view, falling back per field rather than wholesale.
 *
 * Per field because the three controls are independent: a depth this build no
 * longer offers should not also discard a remembered layout. An *empty*
 * category list is a real choice — the user switched everything off — and is
 * kept, which is why the presence of the array decides the fallback rather than
 * its length.
 */
export function resolveAggregationView(stored: StoredAggregationView | null | undefined): AggregationView {
  const categories = Array.isArray(stored?.categories)
    ? CATEGORY_ORDER.filter((category) => stored.categories.includes(category))
    : AGGREGATION_DEFAULT_CATEGORIES;
  return {
    depth: AGGREGATION_DEPTHS.find((level) => level === stored?.depth) ?? AGGREGATION_DEFAULT_DEPTH,
    layoutMode: AGGREGATION_LAYOUT_MODES.find((mode) => mode === stored?.layoutMode) ?? AGGREGATION_DEFAULT_LAYOUT_MODE,
    categories: new Set(categories),
  };
}

/**
 * How far along its own route an edge's label sits, as a fraction from the
 * source.
 *
 * A straight route between two boxes and the straight route back are the same
 * line, so both midpoints are the same point and the two labels print on top of
 * each other — which is what happens as soon as a reader enables a second
 * relationship category and a partner both calls into and reads from the
 * selection. Shifting each label toward its own source separates them by
 * {@link AGGREGATION_LABEL_SHIFT} twice over, and gives the pair a reading
 * order: the label nearer a box describes what leaves it.
 *
 * A one-way edge keeps the midpoint. There is nothing to avoid there, and the
 * midpoint is the point furthest from both boxes — on a short ring edge, a
 * shifted label would instead sit over the box it belongs to.
 */
export const AGGREGATION_LABEL_SHIFT = 0.17;

export function aggregationLabelFraction(edge: Pick<AggregationGraphEdge, 'hasCounterpart'>): number {
  return edge.hasCounterpart ? 0.5 - AGGREGATION_LABEL_SHIFT : 0.5;
}

export type { AggregatedRelationshipContainer, AggregatedRelationshipEdge, AggregatedRelationshipsResult };
export type { AggregationLayoutResult, AggregationLayoutHint };
