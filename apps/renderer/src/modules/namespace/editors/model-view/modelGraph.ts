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
 * The model view's render model: `CommonModel` content reshaped into tiles and
 * edges (spec-view.md Phase 5.3).
 *
 * This replaces the fixed sender / focus / receiver decomposition the connection
 * diagram used. That shape could describe exactly one thing — a component and
 * its immediate connection partners — and could not express what the model view
 * has to show once the user expands it: a package and the elements it contains,
 * a partner's own partners, a component reached two steps out.
 *
 * So the model here is the general one. Every element that can stand on its own
 * is a **tile**; ports are rows *inside* the tile that exposes them; and every
 * relationship between two tiles — a `Connection` between two port rows, an
 * `Ownership` between two tiles — is an **edge**. What the view shows is then
 * purely a function of which representatives it has fetched, which is exactly
 * what expansion changes.
 *
 * Nothing here knows how the content was computed, and no source-metamodel
 * concept name appears: the vocabulary is `CommonModel` throughout, and the
 * source concept travels only as `sourceConcept` for tree navigation.
 */
import type { MalfunctionInfo, Representative, RepresentativeRelationship } from '@riacore/app-contracts';
import {
  ACTIVE_ELEMENT_CONCEPT,
  CONNECTION_CONCEPT,
  PORT_CONCEPTS,
  isDelegationLink,
  isFlowLink,
  portDirection,
  resolveMaxAsil,
  type DiagramMalfunctionRef,
  type PortConcept,
} from '../safety-analysis/components/diagramModel';

// ---------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------

/** A port row inside a tile. */
export interface ModelPort {
  /** Representative id — also the React Flow handle suffix. */
  id: string;
  /** node_id of the source element, for safety data and tree navigation. */
  nodeId: number;
  name: string;
  concept: PortConcept;
  /** The source element's own concept, which is what the tree knows it by. */
  sourceConcept: string;
  dir: 'in' | 'out';
  /** Whether any drawn connection touches this port. */
  connected: boolean;
  malfunctions: DiagramMalfunctionRef[];
  maxAsil: string | null;
  warn: boolean;
}

/** One node on the canvas. */
export interface ModelTile {
  /** Representative id — the React Flow node id. */
  id: string;
  nodeId: number;
  namespace: string;
  name: string;
  /** `CommonModel` concept: drives icon, colour, and what expansion offers. */
  concept: string;
  /** The source element's own concept, for tree navigation and the subtitle. */
  sourceConcept: string;
  qualifiedName: string;
  /** The tile the view is centred on — rendered with emphasis. */
  isFocus: boolean;
  /**
   * The tile that owns this one, when both are on the canvas.
   *
   * Containment is drawn by *nesting* a tile inside its owner rather than by a
   * line between them, because a line cannot be told apart from the connections
   * and flows that share the canvas: a `perform action` inside a part read as a
   * peer component exchanging data with it. Position says "inside"; only edges
   * say "talks to".
   *
   * Set for one level, from the owner nearest the focus — see `assignParents`.
   */
  parentId?: string;
  ports: ModelPort[];
  malfunctions: DiagramMalfunctionRef[];
  maxAsil: string | null;
  warn: boolean;
}

/** One edge on the canvas. */
export interface ModelEdge {
  id: string;
  /**
   * `connection` and `flow` both anchor at port rows; `ownership` anchors at the
   * tiles. `flow` is separated from `connection` because its direction is
   * declared rather than incidental — see `isFlowLink`.
   *
   * An `ownership` edge is only emitted where nesting could *not* express the
   * containment — see {@link ModelTile.parentId}. Drawing both would say the same
   * thing twice, in the one visual channel that is already carrying flows.
   */
  kind: 'connection' | 'flow' | 'ownership';
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  /** Delegation connectors render dashed; an unrecognized kind renders solid. */
  dashed: boolean;
  warn: boolean;
}

export interface ModelGraph {
  tiles: ModelTile[];
  edges: ModelEdge[];
}

/**
 * React Flow handle ids.
 *
 * Every port row carries **both** a source and a target handle, and every tile
 * carries a tile-level pair. Which one an edge uses is decided by the role the
 * representative plays in that edge — a `ConnectionSource` end attaches to the
 * source handle — rather than by the port's own direction. `InOutPort` exists
 * precisely because a port can play either role, so deriving the handle from
 * direction would make its connections undrawable.
 */
export const portSourceHandle = (portId: string) => `psrc-${portId}`;
export const portTargetHandle = (portId: string) => `ptgt-${portId}`;
export const TILE_SOURCE_HANDLE = 'tsrc';
export const TILE_TARGET_HANDLE = 'ttgt';

// ---------------------------------------------------------------------------
// Reading an evaluation result
// ---------------------------------------------------------------------------

function attr(rep: Representative | undefined, key: string): string {
  const value = rep?.attributes?.[key];
  return typeof value === 'string' ? value : '';
}

/** The source `node_id` a direct representative stands for. */
function sourceNodeId(rep: Representative): number {
  return rep.sources[0]?.nodeId ?? Number(rep.id);
}

function indexRelationships(relationships: RepresentativeRelationship[]) {
  const bySourceAndType = new Map<string, string[]>();
  const byTargetAndType = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const rel of relationships) {
    push(bySourceAndType, `${rel.relationship}|${rel.sourceRepresentativeId}`, rel.targetRepresentativeId);
    push(byTargetAndType, `${rel.relationship}|${rel.targetRepresentativeId}`, rel.sourceRepresentativeId);
  }
  return {
    targetsOf: (relationship: string, id: string) => bySourceAndType.get(`${relationship}|${id}`) ?? [],
    sourcesOf: (relationship: string, id: string) => byTargetAndType.get(`${relationship}|${id}`) ?? [],
  };
}

/** A display name that is never empty, so no tile renders as a blank box. */
function displayName(rep: Representative): string {
  const name = attr(rep, 'name').trim();
  if (name) return name;
  const qualified = attr(rep, 'qualified_name').trim();
  if (qualified) {
    const segments = qualified.split('/').filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1];
  }
  return `Element ${rep.id}`;
}

function toMalfunctionRefs(malfunctions: MalfunctionInfo[]): DiagramMalfunctionRef[] {
  return malfunctions.map((m) => ({ nodeId: m.nodeId, name: m.name, description: m.description }));
}

/**
 * The element that owns the focus, which this view deliberately does not draw.
 *
 * The focus is what the user opened the view to look at, and `assignParents`
 * refuses to nest it so that it stays the outermost frame. That leaves its owner
 * with nowhere sensible to go: it cannot contain the focus, so it lands beside it
 * as another root tile — and because the focus's *siblings* are owned by it and
 * do nest, it arrives as a full frame of equal standing packed with elements the
 * user did not ask about. Reported twice on this model: opening `CC_Task1s` and
 * then `CC_Task100ms` both drew `ClstrCtrl` as a partner subsystem that the focus
 * appeared to communicate with.
 *
 * Nothing is lost by dropping it. Its *ports* are what actually reach the focus —
 * each one delegating a signal in from the enclosing system — and those become
 * standalone tiles instead of rows, so every connection keeps both ends and still
 * says where the signal comes from. What disappears is the box that implied a peer
 * relationship. The siblings, no longer having a parent on the canvas, are drawn
 * as the peers they are.
 *
 * Only the *first* owner is hidden, matching the one `assignParents` would have
 * used. A second element claiming to own the focus is a real ambiguity in the
 * source model and stays visible rather than being quietly swallowed.
 */
function ownerOfFocus(
  relationships: RepresentativeRelationship[],
  focusId: string,
  byId: Map<string, Representative>,
): string | undefined {
  for (const rel of relationships) {
    if (rel.relationship !== 'Ownership') continue;
    if (rel.targetRepresentativeId !== focusId) continue;
    const owner = rel.sourceRepresentativeId;
    if (owner === focusId || !byId.has(owner)) continue;
    return owner;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// buildModelGraph
// ---------------------------------------------------------------------------

/**
 * Reshape one coherent evaluation result into tiles and edges.
 *
 * "Coherent" matters: the relationships must have been computed against exactly
 * this set of representatives, which is why the data source ends its walk with
 * a single `mode=elements` evaluation over everything it discovered rather than
 * stitching together the edge sets of the individual traversals.
 *
 * A representative that cannot be placed is never silently dropped. A port
 * whose exposing element was not fetched becomes a tile in its own right, so
 * expanding a connection always produces something visible even when the far
 * side's owner has not been reached yet.
 */
export function buildModelGraph(
  result: { representatives: Representative[]; relationships: RepresentativeRelationship[] },
  focusId: string,
  fallbackNamespace: string,
  malfunctionsByNodeId: Record<number, MalfunctionInfo[]>,
): ModelGraph {
  const byId = new Map(result.representatives.map((rep) => [rep.id, rep]));
  const { targetsOf, sourcesOf } = indexRelationships(result.relationships);
  const malfunctionsFor = (nodeId: number) => malfunctionsByNodeId[nodeId] ?? [];

  // ── Which element exposes each port ───────────────────────────────────────
  // Expose is ActiveElement -> Port, so the exposing element is the edge's
  // *source*. A port whose owner was not fetched keeps `undefined` and becomes
  // a tile below.
  const ownerOfPort = new Map<string, string>();
  for (const rep of result.representatives) {
    if (!PORT_CONCEPTS.has(rep.concept)) continue;
    const ownerId = sourcesOf('Expose', rep.id).find((id) => byId.has(id));
    if (ownerId !== undefined) ownerOfPort.set(rep.id, ownerId);
  }

  // ── Tiles ─────────────────────────────────────────────────────────────────
  const tiles = new Map<string, ModelTile>();
  const makeTile = (rep: Representative): ModelTile => {
    const nodeId = sourceNodeId(rep);
    const malfunctions = malfunctionsFor(nodeId);
    return {
      id: rep.id,
      nodeId,
      namespace: rep.sources[0]?.namespace ?? fallbackNamespace,
      name: displayName(rep),
      concept: rep.concept,
      // `kind` carries the source discriminator the mapping collapsed; the
      // CommonModel concept is the fallback so a mapping that sets no kind
      // still yields a usable navigation target rather than an empty one.
      sourceConcept: attr(rep, 'kind') || rep.concept,
      qualifiedName: attr(rep, 'qualified_name'),
      isFocus: rep.id === focusId,
      ports: [],
      malfunctions: toMalfunctionRefs(malfunctions),
      maxAsil: resolveMaxAsil(malfunctions),
      warn: malfunctions.length > 0,
    };
  };

  // ── The focus's own owner is not drawn ────────────────────────────────────
  const hiddenOwnerId = ownerOfFocus(result.relationships, focusId, byId);

  for (const rep of result.representatives) {
    if (rep.concept === CONNECTION_CONCEPT) continue;          // an edge, not a tile
    if (rep.id === hiddenOwnerId) continue;                    // see `ownerOfFocus`
    // A port is a row on its exposing element rather than a tile — unless that
    // element is the one being hidden, in which case the port becomes a tile of
    // its own further down, so the signal it carries into the focus survives.
    const portOwner = PORT_CONCEPTS.has(rep.concept) ? ownerOfPort.get(rep.id) : undefined;
    if (portOwner !== undefined && portOwner !== hiddenOwnerId) continue;
    tiles.set(rep.id, makeTile(rep));
  }

  // ── Port rows ─────────────────────────────────────────────────────────────
  const portRowById = new Map<string, ModelPort>();
  const tileOfPort = new Map<string, string>();
  for (const rep of result.representatives) {
    if (!PORT_CONCEPTS.has(rep.concept)) continue;
    const nodeId = sourceNodeId(rep);
    const malfunctions = malfunctionsFor(nodeId);
    const port: ModelPort = {
      id: rep.id,
      nodeId,
      name: displayName(rep),
      concept: rep.concept as PortConcept,
      sourceConcept: attr(rep, 'kind') || rep.concept,
      dir: portDirection(rep.concept),
      connected: false,
      malfunctions: toMalfunctionRefs(malfunctions),
      maxAsil: resolveMaxAsil(malfunctions),
      warn: malfunctions.length > 0,
    };
    portRowById.set(rep.id, port);

    const ownerId = ownerOfPort.get(rep.id);
    if (ownerId !== undefined && tiles.has(ownerId)) {
      tiles.get(ownerId)!.ports.push(port);
      tileOfPort.set(rep.id, ownerId);
    } else {
      // An unowned port stands alone rather than vanishing. Its own tile lists
      // it as its single row, so the connection into it still has an anchor.
      const standalone = tiles.get(rep.id);
      if (standalone) {
        standalone.ports.push(port);
        tileOfPort.set(rep.id, rep.id);
      }
    }
  }

  // ── Connection edges ──────────────────────────────────────────────────────
  const edges: ModelEdge[] = [];
  for (const rep of result.representatives) {
    if (rep.concept !== CONNECTION_CONCEPT) continue;
    const sourcePortId = targetsOf('ConnectionSource', rep.id).find((id) => portRowById.has(id));
    const targetPortId = targetsOf('ConnectionTarget', rep.id).find((id) => portRowById.has(id));
    if (sourcePortId === undefined || targetPortId === undefined) continue;
    const sourceTile = tileOfPort.get(sourcePortId);
    const targetTile = tileOfPort.get(targetPortId);
    if (sourceTile === undefined || targetTile === undefined) continue;

    const sourcePort = portRowById.get(sourcePortId)!;
    const targetPort = portRowById.get(targetPortId)!;
    sourcePort.connected = true;
    targetPort.connected = true;

    const connectorKind = attr(rep, 'kind');
    edges.push({
      // The id stays `conn-` prefixed for every connector kind: it keys the
      // ELK layout sections, and a flow is still a connection representative.
      id: `conn-${rep.id}`,
      kind: isFlowLink(connectorKind) ? 'flow' : 'connection',
      source: sourceTile,
      target: targetTile,
      sourceHandle: portSourceHandle(sourcePortId),
      targetHandle: portTargetHandle(targetPortId),
      dashed: isDelegationLink(connectorKind),
      warn: sourcePort.warn || targetPort.warn,
    });
  }

  // ── Containment ───────────────────────────────────────────────────────────
  // Nesting first: it decides which ownership relationships still need an edge.
  const nested = assignParents(tiles, result.relationships, focusId);

  // ── Ownership edges ───────────────────────────────────────────────────────
  // Only between two tiles: `Ownership` never targets a Port, and a Connection
  // is not an Element, so nothing here can point at a row. And only where the
  // owned tile is not nested inside the owner already.
  for (const rel of result.relationships) {
    if (rel.relationship !== 'Ownership') continue;
    if (!tiles.has(rel.sourceRepresentativeId) || !tiles.has(rel.targetRepresentativeId)) continue;
    if (nested.get(rel.targetRepresentativeId) === rel.sourceRepresentativeId) continue;
    // Never draw anything reaching *into* the focus to say it is owned.
    //
    // `ownerOfFocus` already removes the owner this would normally come from, so
    // what is left here is the runner-up: a second element that also claims to
    // own the focus. That tile stays visible, because the ambiguity is real — but
    // the line would still land in the channel that means "these two exchange
    // data", which is the misreading both rules exist to prevent.
    if (rel.targetRepresentativeId === focusId) continue;
    edges.push({
      id: `own-${rel.sourceRepresentativeId}-${rel.targetRepresentativeId}`,
      kind: 'ownership',
      source: rel.sourceRepresentativeId,
      target: rel.targetRepresentativeId,
      sourceHandle: TILE_SOURCE_HANDLE,
      targetHandle: TILE_TARGET_HANDLE,
      dashed: false,
      warn: false,
    });
  }

  // Ports read out-first then in, and alphabetically within each, so a tile's
  // rows do not reshuffle between evaluations of the same content.
  for (const tile of tiles.values()) {
    tile.ports.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir === 'in' ? -1 : 1));
    // A component's own ASIL is the highest of its own malfunctions and its
    // ports', matching how the connection diagram aggregated it.
    const asils = [tile.maxAsil, ...tile.ports.map((p) => p.maxAsil)].filter((a): a is string => a !== null);
    tile.maxAsil = asils.length > 0
      ? asils.reduce((a, b) => (asilLevel(a) >= asilLevel(b) ? a : b))
      : null;
    tile.warn = tile.warn || tile.ports.some((p) => p.warn);
  }

  // Children fold into their frame *after* every tile has its own total, so a
  // frame reports the worst thing anywhere inside it. A reader who has collapsed
  // the internals must still see that something in there is rated D.
  //
  // Deepest-first, so a chain of frames accumulates rather than each one seeing
  // only its direct children's un-aggregated figures.
  for (const tile of [...tiles.values()].sort((a, b) => depthOf(b, tiles) - depthOf(a, tiles))) {
    const parent = tile.parentId === undefined ? undefined : tiles.get(tile.parentId);
    if (!parent) continue;
    if (tile.maxAsil !== null
      && (parent.maxAsil === null || asilLevel(tile.maxAsil) > asilLevel(parent.maxAsil))) {
      parent.maxAsil = tile.maxAsil;
    }
    parent.warn = parent.warn || tile.warn;
  }

  return { tiles: [...tiles.values()], edges };
}

/** How many frames a tile sits inside. Bounded by the parent chain being acyclic. */
function depthOf(tile: ModelTile, tiles: Map<string, ModelTile>): number {
  let depth = 0;
  let current = tile.parentId;
  const seen = new Set<string>([tile.id]);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = tiles.get(current)?.parentId;
  }
  return depth;
}

/**
 * Nest each tile inside the tile that owns it, and report what was nested.
 *
 * One level only, which is the depth that answers the question the view is asked:
 * *what is this element made of?* Nesting the whole ownership chain would redraw
 * the containment tree, and a canvas is a poor tree.
 *
 * "One level" is defined structurally rather than by walking down from the focus,
 * so the result cannot depend on the order relationships happen to arrive in: a
 * tile becomes a **frame** when nothing on the canvas owns it, and a tile
 * **nests** when its owner is such a frame. An owner that is itself nested never
 * becomes a frame, which caps the depth at one by construction.
 *
 * Two further rules keep the result well-formed:
 *
 * - a tile takes at most one parent, so the result is a forest and never a
 *   diamond, however many `Ownership` rows name it;
 * - the focus is never given a parent. It is the thing being looked at, so it
 *   stays the outermost frame even when its own owner is on the canvas —
 *   otherwise selecting a part would nest it inside its enclosing composition and
 *   shrink it to a box in the corner.
 */
function assignParents(
  tiles: Map<string, ModelTile>,
  relationships: RepresentativeRelationship[],
  focusId: string,
): Map<string, string> {
  // First owner wins, so a tile named by several Ownership rows still gets one
  // parent. The focus is excluded up front rather than unpicked afterwards.
  const ownerOf = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.relationship !== 'Ownership') continue;
    const owner = rel.sourceRepresentativeId;
    const owned = rel.targetRepresentativeId;
    if (owned === focusId || owned === owner) continue;
    if (!tiles.has(owner) || !tiles.has(owned)) continue;
    if (ownerOf.has(owned)) continue;
    ownerOf.set(owned, owner);
  }

  const nested = new Map<string, string>();
  for (const [owned, owner] of ownerOf) {
    // The owner must be a frame — something nothing else on the canvas owns.
    if (ownerOf.has(owner)) continue;
    nested.set(owned, owner);
    tiles.get(owned)!.parentId = owner;
  }
  return nested;
}

/** Local copy of the ASIL ordering used for the per-tile aggregation above. */
function asilLevel(asil: string): number {
  const order: Record<string, number> = { QM: 0, A: 1, B: 2, C: 3, D: 4 };
  const decomposition = asil.trim().match(/^([A-Z]+)\(([A-Z]+)\)$/);
  if (decomposition) {
    return Math.max(order[decomposition[1]] ?? -1, order[decomposition[2]] ?? -1);
  }
  return order[asil.trim()] ?? -1;
}

/**
 * Which expansions a tile can offer.
 *
 * Both are always offered for anything that can own or expose: whether a step
 * would actually add anything is only knowable by taking it, and an entry that
 * appears and disappears depending on unfetched content reads as a bug. A
 * `Connection` never gets a tile, so it never gets a menu.
 */
export function expansionsFor(concept: string): Array<'contained' | 'connections'> {
  if (concept === ACTIVE_ELEMENT_CONCEPT) return ['contained', 'connections'];
  if (PORT_CONCEPTS.has(concept)) return ['connections'];
  return ['contained'];
}
