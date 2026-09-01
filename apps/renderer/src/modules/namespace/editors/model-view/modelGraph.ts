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
  ports: ModelPort[];
  malfunctions: DiagramMalfunctionRef[];
  maxAsil: string | null;
  warn: boolean;
}

/** One edge on the canvas. */
export interface ModelEdge {
  id: string;
  /** `connection` anchors at port rows; `ownership` anchors at the tiles. */
  kind: 'connection' | 'ownership';
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

  for (const rep of result.representatives) {
    if (rep.concept === CONNECTION_CONCEPT) continue;          // an edge, not a tile
    if (PORT_CONCEPTS.has(rep.concept) && ownerOfPort.has(rep.id)) continue; // a row
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

    edges.push({
      id: `conn-${rep.id}`,
      kind: 'connection',
      source: sourceTile,
      target: targetTile,
      sourceHandle: portSourceHandle(sourcePortId),
      targetHandle: portTargetHandle(targetPortId),
      dashed: isDelegationLink(attr(rep, 'kind')),
      warn: sourcePort.warn || targetPort.warn,
    });
  }

  // ── Ownership edges ───────────────────────────────────────────────────────
  // Only between two tiles: `Ownership` never targets a Port, and a Connection
  // is not an Element, so nothing here can point at a row.
  for (const rel of result.relationships) {
    if (rel.relationship !== 'Ownership') continue;
    if (!tiles.has(rel.sourceRepresentativeId) || !tiles.has(rel.targetRepresentativeId)) continue;
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

  return { tiles: [...tiles.values()], edges };
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
