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
 * The model view's data source (spec-view.md Phase 5.3), built on
 * `views.evaluate` alone.
 *
 * It supersedes `useConnectionView`, which could fetch exactly one thing: a
 * component and its immediate connection partners. This one fetches a
 * *neighbourhood that grows*, because the view it feeds is expandable — the
 * user opens a tile's menu and asks for its contained elements or its
 * connections, one step at a time.
 *
 * ## Shape of a load
 *
 * 1. Resolve the selected element through the view (`mode=element`). Anything
 *    the mapping does not project is not something the view can anchor on.
 * 2. Seed: for a component, the connection neighbourhood the diagram has always
 *    shown; for anything else, its contained elements. A port anchors on the
 *    element that exposes it, as before.
 * 3. Apply each expansion the user has asked for, in the same way.
 * 4. **One** `mode=elements` evaluation over everything discovered. Steps 2 and
 *    3 only find out *which* elements are involved; this call is what produces
 *    an edge set that is mutually consistent, because it is computed against
 *    exactly the node set that will be drawn.
 * 5. Safety data (malfunctions, ASIL) alongside, from `rep.sources[].nodeId` —
 *    it is deliberately outside `CommonModel`.
 *
 * ## Why the sequencing is what it is
 *
 * Every evaluation is an IPC round trip, and the walk has real data
 * dependencies — the connections are not knowable until the ports are. What is
 * *not* dependent runs concurrently: the two connection ends, and the far
 * owners against the connection owners. Opening the view used to be nine
 * strictly sequential round trips; it is now six waves, and the anchor
 * resolution is shared with the query that decides whether to offer the lens at
 * all, so by the time the canvas mounts that step is usually already resolved.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ConceptInstanceData,
  EvaluationResult,
  MalfunctionInfo,
  Representative,
  TraversalDirection,
} from '@riacore/app-contracts';
import { api } from '../api/riacore';
import {
  ACTIVE_ELEMENT_CONCEPT,
  PORT_CONCEPTS,
  isDiagramAnchorConcept,
} from '../modules/namespace/editors/safety-analysis/components/diagramModel';
import {
  buildModelGraph,
  type ModelGraph,
} from '../modules/namespace/editors/model-view/modelGraph';
import { useCommonModelPresentation } from './usePresentation';

/** The view's immediate metamodel. The model view speaks only this vocabulary. */
const COMMON_MODEL = 'COMMON_MODEL';

/**
 * Depth 1 throughout. Every step of the walk is a single hop, and expansion is
 * defined as one step — a deeper walk would pull in a neighbourhood the user
 * did not ask for and could not then collapse.
 */
const ONE_HOP = 1;

/** One expansion the user has performed, in the order performed. */
export interface ModelExpansion {
  /** `contained` walks Ownership; `connections` walks the connection chain. */
  kind: 'contained' | 'connections';
  /** The representative whose menu it was invoked from. */
  representativeId: string;
}

export interface ModelViewData {
  graph: ModelGraph;
  /** Representative id of the tile the view is centred on. */
  focusId: string;
  /** Non-fatal issues reported by evaluation, surfaced rather than swallowed. */
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

/**
 * The ad-hoc definition every call in this file evaluates.
 *
 * No saved view is created: `views.evaluate` acquires no write lock, and
 * implicitly creating one would both fail in a read-only workspace and add a
 * row to `ria-data/universe/` on mere browsing. The mapping is deliberately
 * omitted — the service resolves the one that produces `COMMON_MODEL` content
 * from this namespace's metamodel, which is why this hook needs to know nothing
 * about ARXML or SysML.
 */
function definitionFor(namespace: string) {
  return { metamodel: COMMON_MODEL, sources: [namespace] };
}

function evaluateElement(
  namespace: string,
  elementNodeId: number,
  allowUnavailableMapping = false,
): Promise<EvaluationResult> {
  return api.views.evaluate({
    definition: definitionFor(namespace),
    mode: 'element',
    elementNodeId,
    allowUnavailableMapping,
    // Both callers — `fetchAnchor` and `useIsDiagramConcept` — read
    // `representatives[0]` and nothing else. This runs on every tree selection,
    // so the edge set it used to compute for one node was the most frequently
    // wasted work in the renderer.
    includeRelationships: false,
  });
}

function evaluateElements(namespace: string, elementNodeIds: number[]): Promise<EvaluationResult> {
  return api.views.evaluate({ definition: definitionFor(namespace), mode: 'elements', elementNodeIds });
}

/** Representative ids reached by a traversal, as a plain id list. */
async function traverseIds(
  namespace: string,
  fromIds: string[],
  relationship: string,
  direction: TraversalDirection,
  collect: (result: EvaluationResult) => void,
): Promise<string[]> {
  if (fromIds.length === 0) return [];
  const result = await api.views.evaluate({
    definition: definitionFor(namespace),
    mode: 'traversal',
    representativeIds: fromIds,
    relationship,
    direction,
    depth: ONE_HOP,
    // Ids only. The walk exists to discover *which* elements are involved; the
    // single `mode=elements` call at the end supplies the edges, computed against
    // the exact node set that will be drawn — which is the only way they come out
    // mutually consistent. Every intermediate walk was therefore paying for an
    // edge set that this function then dropped on the floor, and edge completion
    // is the dominant cost of a traversal evaluation.
    includeRelationships: false,
  });
  collect(result);
  return result.representatives.map((rep) => rep.id);
}

// ---------------------------------------------------------------------------
// The anchor query, shared with the lens-availability check
// ---------------------------------------------------------------------------

/**
 * Query key for "what does the view resolve this element to".
 *
 * Shared on purpose. `useIsDiagramConcept` runs this on every tree selection to
 * decide whether to offer the lens, and the model view needs the same answer as
 * the first step of its walk. Keying them identically means the walk starts
 * from a cache hit instead of repeating a round trip that has, by construction,
 * always just been made.
 */
export function anchorQueryKey(
  workspaceKey: string | null | undefined,
  namespace: string | null | undefined,
  nodeId: number | null | undefined,
) {
  return ['views.anchorRepresentative', workspaceKey, namespace, nodeId] as const;
}

function fetchAnchor(
  queryClient: QueryClient,
  workspaceKey: string | null | undefined,
  namespace: string,
  nodeId: number,
): Promise<Representative | null> {
  return queryClient.ensureQueryData({
    queryKey: anchorQueryKey(workspaceKey, namespace, nodeId),
    queryFn: async () => (await evaluateElement(namespace, nodeId)).representatives[0] ?? null,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Neighbourhood walks
// ---------------------------------------------------------------------------

/**
 * The connection neighbourhood of a set of elements: their ports, the
 * connections on those ports, the far ports, and the elements owning them.
 *
 * This is one expansion step as the user experiences it — "show me what this is
 * connected to" reaches the partner elements, not merely the connectors, which
 * would leave the canvas showing anonymous link nodes.
 *
 * Connections are reached by walking `ConnectionSource`/`ConnectionTarget`
 * *incoming*, because both ends are anchored at the `Connection` node.
 */
async function connectionNeighbourhood(
  namespace: string,
  elementIds: string[],
  collect: (result: EvaluationResult) => void,
): Promise<string[]> {
  const walk = (from: string[], relationship: string, direction: TraversalDirection) =>
    traverseIds(namespace, from, relationship, direction, collect);

  const portIds = await walk(elementIds, 'Expose', 'outgoing');
  // Ports the caller named directly participate as themselves — expanding a
  // port's connections must not require it to be exposed by anything.
  const allPortIds = [...new Set([...portIds, ...elementIds])];

  const connectionIds = [...new Set((await Promise.all([
    walk(allPortIds, 'ConnectionSource', 'incoming'),
    walk(allPortIds, 'ConnectionTarget', 'incoming'),
  ])).flat())];

  const farPortIds = [...new Set((await Promise.all([
    walk(connectionIds, 'ConnectionSource', 'outgoing'),
    walk(connectionIds, 'ConnectionTarget', 'outgoing'),
  ])).flat())];

  const ownerIds = await walk(farPortIds, 'Expose', 'incoming');

  // `ConnectionOwner` — the composition a connector belongs to — is
  // deliberately **not** walked. The canvas has no way to draw it: a
  // `Connection` is an edge here, not a tile, so an edge from its owner would
  // have to attach to another edge. Fetching it anyway produced a tile floating
  // on its own with nothing joining it to the rest, which reads as a rendering
  // fault rather than as information. It costs a round trip too. The
  // relationship is still produced by every mapping and is still reachable
  // through `views.evaluate` for a consumer that can express it.
  return [...portIds, ...connectionIds, ...farPortIds, ...ownerIds];
}

/**
 * One level of contained elements, including their ports and connectors.
 * Only the contained elements become tiles: unlike a connection expansion,
 * this does not fetch far ports/owners outside the selected container. The
 * final elements evaluation supplies the edges whose endpoints are present.
 */
async function containedElements(
  namespace: string,
  elementIds: string[],
  collect: (result: EvaluationResult) => void,
): Promise<string[]> {
  const children = await traverseIds(namespace, elementIds, 'Ownership', 'outgoing', collect);
  const ports = await traverseIds(namespace, children, 'Expose', 'outgoing', collect);
  const connections = (await Promise.all([
    traverseIds(namespace, ports, 'ConnectionSource', 'incoming', collect),
    traverseIds(namespace, ports, 'ConnectionTarget', 'incoming', collect),
  ])).flat();
  return [...new Set([...children, ...ports, ...connections])];
}

// ---------------------------------------------------------------------------
// Safety data
// ---------------------------------------------------------------------------

/**
 * Convert a `ConceptInstanceData` malfunction into `MalfunctionInfo`, using the
 * same attribute names the retired ARXML path did.
 */
function toMalfunctionInfo(instance: ConceptInstanceData): MalfunctionInfo {
  const attributes = (instance.attributes ?? {}) as Record<string, unknown>;
  const read = (key: string) => (typeof attributes[key] === 'string' ? (attributes[key] as string) : '');
  return {
    nodeId: instance.node_id,
    name: read('has_name'),
    description: read('malfunction_description'),
    asil: read('malfunction_asil'),
  };
}

async function loadMalfunctions(
  representatives: Representative[],
  safetyNamespace?: string,
): Promise<Record<number, MalfunctionInfo[]>> {
  // Every tile and port row can carry malfunctions, so this asks for the whole
  // drawn set at once. One batched call, not one per pin.
  const targets = representatives
    .filter((rep) => PORT_CONCEPTS.has(rep.concept) || rep.concept === ACTIVE_ELEMENT_CONCEPT)
    .map((rep) => rep.sources[0]?.nodeId ?? Number(rep.id))
    .filter(Number.isFinite);
  if (targets.length === 0) return {};

  const instances = await api.safety.getMalfunctionsForElements([...new Set(targets)], safetyNamespace);
  const byNodeId: Record<number, MalfunctionInfo[]> = {};
  for (const [key, list] of Object.entries(instances)) {
    byNodeId[Number(key)] = list.map(toMalfunctionInfo);
  }
  return byNodeId;
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

async function loadModelView(
  queryClient: QueryClient,
  workspaceKey: string | null | undefined,
  namespace: string,
  nodeId: number,
  expansions: ModelExpansion[],
  safetyNamespace?: string,
): Promise<ModelViewData | null> {
  const diagnostics: string[] = [];
  const collect = (result: EvaluationResult) => { diagnostics.push(...result.diagnostics); };

  const anchor = await fetchAnchor(queryClient, workspaceKey, namespace, nodeId);
  if (!anchor) return null;

  // A port anchors the view on the element that exposes it, as the connection
  // diagram always did. A port exposed by nothing anchors on itself rather than
  // refusing to render — it is still a thing with connections to show.
  let focusId = anchor.id;
  if (PORT_CONCEPTS.has(anchor.concept)) {
    const ownerIds = await traverseIds(namespace, [anchor.id], 'Expose', 'incoming', collect);
    if (ownerIds.length > 0) focusId = ownerIds[0];
  }

  const discovered = new Set<string>([focusId]);
  const add = (ids: string[]) => { for (const id of ids) discovered.add(id); };

  // The seed. A component opens on **both** its connections and what it
  // contains; a port opens on its connections alone, having nothing inside it.
  //
  // Both walks, not one, because they answer different questions and only their
  // union is a whole picture. `connectionNeighbourhood` never walks `Ownership`,
  // so on its own it reaches a child only when that child happens to sit on the
  // connection chain — and then only the ports that chain passes through. Opening
  // a part whose internals are actions therefore drew some of those actions, some
  // of their ports, and no containment, until the user right-clicked "expand
  // contained elements" and got a different and better diagram of the same thing.
  // Seeding with both makes the first render the complete one, and makes that
  // expansion idempotent rather than corrective.
  const focusConcept = focusId === anchor.id ? anchor.concept : ACTIVE_ELEMENT_CONCEPT;
  const seeds = PORT_CONCEPTS.has(focusConcept)
    ? [await connectionNeighbourhood(namespace, [focusId], collect)]
    : focusConcept === ACTIVE_ELEMENT_CONCEPT
      ? await Promise.all([
        connectionNeighbourhood(namespace, [focusId], collect),
        containedElements(namespace, [focusId], collect),
      ])
      // A package or a requirement exposes no ports, so its connection
      // neighbourhood is empty by construction and asking for it is a round trip
      // that can only return nothing.
      : [await containedElements(namespace, [focusId], collect)];
  for (const ids of seeds) add(ids);

  // Expansions are independent of one another — each is anchored at a
  // representative the user already had on the canvas — so they run together.
  const expanded = await Promise.all(expansions.map((expansion) => (
    expansion.kind === 'contained'
      ? containedElements(namespace, [expansion.representativeId], collect)
      : connectionNeighbourhood(namespace, [expansion.representativeId], collect)
  )));
  for (const ids of expanded) add(ids);

  // One evaluation over everything discovered: its edge set is computed against
  // this exact node set, so every edge among the drawn elements is present and
  // mutually consistent.
  const elementNodeIds = [...discovered].map(Number).filter(Number.isFinite);
  const result = await evaluateElements(namespace, elementNodeIds);
  collect(result);

  const malfunctionsByNodeId = await loadMalfunctions(result.representatives, safetyNamespace);

  return {
    graph: buildModelGraph(result, focusId, namespace, malfunctionsByNodeId),
    focusId,
    diagnostics: [...new Set(diagnostics)],
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Whether the selected element is one the model view can render.
 *
 * Two questions, as spec-view.md Phase 4.4 states them: does the view project
 * this element at all, and does the projected concept have a presentation entry
 * for the view's immediate metamodel? The first requires resolving the element
 * through the view, so this is asynchronous where the old set-membership test
 * was synchronous — an element reads as non-diagram until its single
 * `mode=element` evaluation returns.
 *
 * The two halves are split deliberately: the *query* resolves the concept and
 * is cached per element, while the *classification* is synchronous against the
 * catalog, so editing `concept-presentation.json` re-classifies without
 * re-evaluating every element.
 *
 * It shares its query with {@link useModelView} — see {@link anchorQueryKey}.
 */
export function useIsDiagramConcept(
  namespace: string | null | undefined,
  nodeId: number | null | undefined,
  workspaceKey: string | null | undefined,
) {
  const presentation = useCommonModelPresentation(workspaceKey);
  const { data } = useQuery<Representative | null>({
    queryKey: anchorQueryKey(workspaceKey, namespace, nodeId),
    queryFn: async () => (await evaluateElement(namespace!, nodeId!, true)).representatives[0] ?? null,
    retry: false,
    // `node_id` is a SERIAL starting at 0, so a truthiness check would silently
    // never load the first element ever written to the graph.
    enabled: !!namespace && nodeId !== null && nodeId !== undefined && !!workspaceKey,
    staleTime: 60_000,
  });
  // An empty catalog (not yet loaded) classifies nothing, so the lens is not
  // offered until the catalog is known — better than offering it and rendering
  // a view whose concepts have no presentation.
  return !!data && isDiagramAnchorConcept(data.concept, presentation);
}

/**
 * Load the model view for the selected element and the expansions applied to it.
 *
 * `expansions` is part of the query key, so an expansion is a *refetch of the
 * whole neighbourhood* rather than a merge into cached state. That is the
 * deliberate choice: merging would leave the canvas holding edges computed
 * against a node set that no longer exists, and would make invalidation after a
 * model change unable to repair anything it had already merged. React Query
 * keeps the previous result on screen while the new one loads, so the cost is
 * not visible as a flicker.
 *
 * `staleTime` is zero. The view's content changes whenever the model does —
 * adding a malfunction is the everyday case — and the refresh mechanism is
 * explicit invalidation from the mutations that cause it. A stale window here
 * would silently outlive those invalidations, which is exactly how the diagram
 * came to need several view switches before a new malfunction appeared.
 */
export function useModelView(
  namespace: string | null | undefined,
  nodeId: number | null | undefined,
  workspaceKey: string | null | undefined,
  expansions: ModelExpansion[],
  safetyNamespace?: string,
) {
  const queryClient = useQueryClient();
  // Structural data is shared, but annotations belong to the active analysis.
  const identity = ['views.modelView', workspaceKey, namespace, nodeId, safetyNamespace] as const;
  return useQuery<ModelViewData | null>({
    queryKey: [...identity, expansionKey(expansions)],
    queryFn: () => loadModelView(queryClient, workspaceKey, namespace!, nodeId!, expansions, safetyNamespace),
    // See useIsDiagramConcept: `node_id` 0 is a legitimate id.
    enabled: !!namespace && nodeId !== null && nodeId !== undefined && !!workspaceKey,
    staleTime: 0,
    // An expansion changes the key; keeping the previous graph on screen while
    // the larger one loads is what makes expansion feel additive rather than
    // like a reload. Never carry annotations across an analysis/element switch,
    // even temporarily while that context's request is still loading.
    placeholderData: (previous, previousQuery) =>
      identity.every((part, index) => previousQuery?.queryKey[index] === part) ? previous : undefined,
  });
}

/**
 * Order-independent key for a set of expansions: expanding A then B must not
 * be a different cache entry from expanding B then A, because it is not a
 * different result.
 */
function expansionKey(expansions: ModelExpansion[]): string {
  return [...new Set(expansions.map((e) => `${e.kind}:${e.representativeId}`))].sort().join('|');
}

/** Every React Query key this file owns. */
const MODEL_VIEW_QUERY_PREFIXES = ['views.modelView', 'views.anchorRepresentative'];

/**
 * Refresh the model view after something changed the model underneath it.
 *
 * The view is computed from the graph plus the safety data hanging off it, so
 * adding a malfunction changes what it should draw — and nothing used to say
 * so. `useSafetyMutations` invalidated some forty `safety.*` keys and no view
 * key at all, which, together with a thirty-second `staleTime`, is why a new
 * malfunction appeared only after the user switched away from the view and
 * back, sometimes several times: the remount had to happen to land outside the
 * stale window. Both halves of that are gone — the `staleTime` is zero and this
 * is called from the mutations that cause the change.
 *
 * Invalidation, not refetch: React Query re-runs only *observed* queries, so
 * this costs nothing at all unless the model view is actually on screen.
 */
export function invalidateModelViewQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => MODEL_VIEW_QUERY_PREFIXES.includes(String(query.queryKey[0])),
  });
}
