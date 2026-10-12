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
// Feature: connection-diagram-layout-persistence
//
// Pure, framework-free extraction of the Overview_Canvas node/edge build gate.
//
// The live build lives in an async effect inside `WorkspaceCanvas.tsx` that
// begins with the `db_open` render gate:
//
//     if (!d.dbOpen) { setRfNodes([]); setRfEdges([]); return; }
//
// so that while the Workspace_Phase is not `db_open` the canvas renders zero
// Canvas_Elements (Requirement 2.4). That effect also depends on `elkjs`
// (async) and React state setters, which makes it awkward to exercise directly
// under fast-check. This module re-expresses the *pure* part of that logic —
// the render gate and the deterministic node/edge construction from graph data
// — as a single synchronous function so the gate can be property-tested without
// a full React render. Position resolution mirrors the real effect
// (stored Layout_Record → Auto_Layout fallback → origin), but the gate itself
// (empty in / empty out when phase !== 'db_open') is the invariant this module
// guarantees.

import type { WorkspacePhase } from '../hooks/useWorkspaceState';
import {
  ANALYSIS_ELEMENT_KIND,
  declaredDimensions,
  IMPORTED_ELEMENT_KIND,
  type NodeDimensions,
} from './nodeDimensions';

/** The Workspace_Phase discriminant. */
export type CanvasPhase = WorkspacePhase['phase'];

// The two Element_Kinds positioned on the canvas today. They are declared in
// `nodeDimensions.ts` (which keys its Declared_Dimensions table by them) and
// re-exported here, where they have always been imported from, so this module
// can consume `declaredDimensions` without the two forming an import cycle.
export { ANALYSIS_ELEMENT_KIND, IMPORTED_ELEMENT_KIND } from './nodeDimensions';

// Layout_Key → layout_id encoding, mirroring `WorkspaceCanvas.tsx` and the
// app-core persistence layer: `${elementKind}\u0000${elementKey}`. The NUL
// separator can never appear in an identifier-like kind/key, so the encoding
// is injective.
const LAYOUT_ID_SEPARATOR = '\u0000';
export function encodeLayoutId(elementKind: string, elementKey: string): string {
  return `${elementKind}${LAYOUT_ID_SEPARATOR}${elementKey}`;
}

/** Minimal shape of an imported Canvas_Element (keyed by `targetNamespace`). */
export interface ImportSourceLike {
  targetNamespace: string;
}

/** Minimal shape of an analysis Canvas_Element (keyed by `name`). */
export interface AuthoredNamespaceLike {
  name: string;
}

/** A user-drawn Namespace_Connection (imported name → analysis name). */
export interface ConnectionLike {
  source: string;
  target: string;
}

export interface CanvasGraphInput {
  /** Current Workspace_Phase; only `db_open` renders Canvas_Elements. */
  phase: CanvasPhase;
  importSources: ImportSourceLike[];
  authoredNamespaces: AuthoredNamespaceLike[];
  connections: ConnectionLike[];
  /** Stored Diagram_Layout keyed by `layout_id` (Req 2.2). */
  storedPositions?: Map<string, { x: number; y: number }>;
  /** Auto_Layout fallback positions keyed by node id (Req 2.3). */
  fallbackPositions?: Map<string, { x: number; y: number }>;
}

export interface CanvasGraphNode {
  id: string;
  kind: typeof IMPORTED_ELEMENT_KIND | typeof ANALYSIS_ELEMENT_KIND;
  position: { x: number; y: number };
  /**
   * Declared_Dimensions for this node's Element_Kind, resolved from the one
   * dimension table the real build and Auto_Layout also read
   * (`nodeDimensions.ts`). The gate carries them so it mirrors the real build,
   * where the same values become React Flow's `initialWidth` / `initialHeight`.
   *
   * Deliberately nested rather than flat `width` / `height`: React Flow 12
   * treats top-level `width` / `height` on a node as authoritative inline
   * styles, which would freeze card height, so naming them that way here would
   * invite exactly the mistake the declared-dimension design avoids.
   */
  dimensions: NodeDimensions;
}

export interface CanvasGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasGraphResult {
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
}

/**
 * Resolve the Canvas_Elements and edges to render for the given graph data and
 * Workspace_Phase.
 *
 * The `db_open` render gate (Req 2.4): while `phase !== 'db_open'` this returns
 * zero nodes AND zero edges, regardless of how much graph data is supplied.
 * When `phase === 'db_open'`, one node is produced per import source and per
 * authored namespace, and one edge per connection whose endpoints are both
 * present as nodes. Each node's position resolves to its stored Layout_Record
 * when present (Req 2.2), else an Auto_Layout fallback (Req 2.3), else origin,
 * and each node carries the Declared_Dimensions for its Element_Kind so the gate
 * mirrors the real build.
 */
export function buildCanvasGraph(input: CanvasGraphInput): CanvasGraphResult {
  // ── db_open render gate (Req 2.4) ─────────────────────────────────────────
  if (input.phase !== 'db_open') {
    return { nodes: [], edges: [] };
  }

  const stored = input.storedPositions ?? new Map<string, { x: number; y: number }>();
  const fallback = input.fallbackPositions ?? new Map<string, { x: number; y: number }>();

  const importerNodeIds = new Set(input.importSources.map((s) => s.targetNamespace));
  const analysisNodeIds = new Set(input.authoredNamespaces.map((n) => n.name));

  // Resolved once per Element_Kind rather than per node: the table is static.
  const importedDimensions = declaredDimensions(IMPORTED_ELEMENT_KIND);
  const analysisDimensions = declaredDimensions(ANALYSIS_ELEMENT_KIND);

  const importerNodes: CanvasGraphNode[] = input.importSources.map((s) => ({
    id: s.targetNamespace,
    kind: IMPORTED_ELEMENT_KIND,
    position:
      stored.get(encodeLayoutId(IMPORTED_ELEMENT_KIND, s.targetNamespace)) ??
      fallback.get(s.targetNamespace) ?? { x: 0, y: 0 },
    dimensions: importedDimensions,
  }));

  const analysisNodes: CanvasGraphNode[] = input.authoredNamespaces.map((n) => ({
    id: n.name,
    kind: ANALYSIS_ELEMENT_KIND,
    position:
      stored.get(encodeLayoutId(ANALYSIS_ELEMENT_KIND, n.name)) ??
      fallback.get(n.name) ?? { x: 0, y: 0 },
    dimensions: analysisDimensions,
  }));

  const edges: CanvasGraphEdge[] = input.connections
    .filter((c) => importerNodeIds.has(c.source) && analysisNodeIds.has(c.target))
    .map((c) => ({ id: `conn:${c.source}->${c.target}`, source: c.source, target: c.target }));

  return { nodes: [...importerNodes, ...analysisNodes], edges };
}
