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
// Feature: persistor-shared-layer-sync, Task 7.1 — the five-state rule as a pure function.
//
// The concept this file encodes is described in docs/coreSpecs/persistorStates.md.
// Everything follows from comparing three values per domain:
//
//   M  the hash recorded in manifest.json
//   F  the hash computed from the files on disk right now
//   D  the hash the database was synced to
//
// M and F together only answer "are the files intact?" — a file always matches its own
// recorded hash. D is what makes "is the database current?" answerable, which is why
// every domain gets one.
//
// This module is pure. It reads no file, opens no database, and knows nothing about
// which domain a triple of hashes came from. The planner (task 7.5) is below; the
// outcome resolver (task 7.7) belongs here too and is added in that task.

/**
 * The five states of a domain, from `docs/coreSpecs/persistorStates.md`:
 *
 * - `S1` everything agrees — the files are intact and the database came from them.
 *   No action.
 * - `S2` the files are intact but the database came from another snapshot. Load this
 *   domain into the database.
 * - `S3` the files were edited behind the app and the database agrees with the
 *   manifest. Ask the user: repair the manifest and load the files, or save the
 *   database over the files.
 * - `S4` the manifest is stale — the files and the database agree with each other.
 *   Repair the manifest; no data moves.
 * - `S5` three-way disagreement. Ask the user; the database is the only coherent
 *   authority.
 */
export type SyncState = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

/**
 * The kinds of domain the rule is applied to.
 *
 * `manifest` is special in two ways: it has no M (a digest stored inside a file cannot
 * validate that file), and a match of F against D licenses skipping the per-domain D
 * comparisons. `meta` is special in one: it is regenerated from the shipped profiles
 * rather than authored, so it never acquires a D and stays on its existing
 * M-versus-F comparison.
 */
export type SyncDomainKind =
  | 'manifest'
  | 'namespace'
  | 'sourcemaster'
  | 'universe'
  | 'cross_namespace'
  | 'meta';

export interface SyncDomain {
  kind: SyncDomainKind;
  /** Namespace name, or the ria-data-relative file path. Absent for meta. */
  id: string;
}

export interface SyncHashes {
  /** Recorded in the manifest. Null for the manifest domain, which has no M. */
  m: string | null;
  /** Computed from the files now. Null when the files could not be read. */
  f: string | null;
  /** What the database was synced to. Null when no record exists. */
  d: string | null;
}

/**
 * The whole decision table. A pure function of three values and nothing else --
 * not of the domain, not of the filesystem, not of the database.
 *
 * A null D is never resolved in the direction of a write: it lands in S2 (load)
 * when the files are intact and S5 (ask) when they are not. A database with no
 * origin record -- one that predates this table, or was reset -- therefore
 * rebuilds from intact files and asks about edited ones.
 */
export function classifySyncState(h: SyncHashes): SyncState {
  const filesIntact = h.m === h.f;
  if (filesIntact) return h.d !== null && h.d === h.m ? 'S1' : 'S2';
  if (h.d !== null && h.d === h.m) return 'S3';
  if (h.d !== null && h.d === h.f) return 'S4';
  return 'S5';
}
/** A domain, its three hashes, and the state they classify to. */
export interface DomainStateEntry {
  domain: SyncDomain;
  hashes: SyncHashes;
  state: SyncState;
}

/**
 * What a load should clear and re-import. Anything absent from the plan keeps whatever
 * the database already holds, which is the point: resolving one layer must not wipe
 * another.
 */
export interface LoadPlan {
  /** Always true: meta has no D and is regenerated wholesale. */
  meta: true;
  sourcemaster: boolean;
  universe: boolean;
  crossNamespace: boolean;
  /** Namespaces to re-import. The per-namespace delta-skip still applies inside the load. */
  namespaces: string[];
}

/**
 * The plan is per layer for the shared domains and per namespace for authored content:
 * a layer is cleared and re-imported whole when any of its files needs loading,
 * and a namespace is re-imported when its own state needs loading. S4 needs only
 * manifest repair: its database origin already matches the files. Loading an
 * S4-only layer would discard its unsaved work for no incoming content.
 *
 * Invariant 3 -- the cross-namespace layer is never partial. It is in the plan whenever
 * any cross-namespace domain needs loading **or** any namespace is in the plan, and a
 * cross-namespace domain that needs loading promotes the plan to every namespace in the
 * manifest -- including the namespaces that are themselves S1.
 *
 * The reason is that cross-namespace edges are graph edges between concept-instance
 * nodes, and node IDs are reassigned whenever a namespace is wiped and re-imported. A
 * partial operation can therefore leave edges that disagree with the namespaces they
 * connect, which is a silently broken graph: worse than the bug being fixed. So any
 * divergence in cross_namespace widens the operation to a full one, and whenever any
 * namespace is loaded the layer is reloaded with it. This mirrors the epoch-promotion
 * rule already in the store: when a condition makes a scoped operation unsafe, the
 * response is to widen the operation rather than to reason about which parts are still
 * safe.
 *
 * Detection stays per file regardless -- each cross-namespace domain keeps its own
 * three-hash entry -- so a report can still name the file that moved even though the
 * action is always whole-layer.
 *
 * The full namespace list is derived from the entries rather than taken as a parameter:
 * the evaluation produces one entry per namespace in the manifest, S1 or not, so the
 * entries already carry it and a second source could disagree with them.
 *
 * `manifest` and `meta` entries are ignored here. The manifest is decided before any
 * carrier is dereferenced, and meta is in every plan unconditionally.
 */
export function planLoad(entries: DomainStateEntry[]): LoadPlan {
  const needsLoad = (e: DomainStateEntry): boolean => e.state !== 'S1' && e.state !== 'S4';
  const layerNeedsLoad = (kind: SyncDomainKind): boolean =>
    entries.some((e) => e.domain.kind === kind && needsLoad(e));

  const allNamespaces: string[] = [];
  const staleNamespaces: string[] = [];
  for (const e of entries) {
    if (e.domain.kind !== 'namespace') continue;
    if (!allNamespaces.includes(e.domain.id)) allNamespaces.push(e.domain.id);
    if (needsLoad(e) && !staleNamespaces.includes(e.domain.id)) {
      staleNamespaces.push(e.domain.id);
    }
  }

  const crossNamespaceDiverged = layerNeedsLoad('cross_namespace');
  const namespaces = crossNamespaceDiverged ? allNamespaces : staleNamespaces;

  return {
    meta: true,
    sourcemaster: layerNeedsLoad('sourcemaster'),
    universe: layerNeedsLoad('universe'),
    // Both directions of the promotion: a diverged layer pulls the namespaces in, and
    // any namespace in the plan pulls the layer in.
    crossNamespace: crossNamespaceDiverged || namespaces.length > 0,
    namespaces,
  };
}

// ── Outcome resolution (task 7.7) ─────────────────────────────────────────────

/**
 * Why a domain cannot be resolved without a person.
 *
 * - `files_edited` — at least one domain is S3: the files moved behind the app
 *   while the database still agrees with the manifest. Either direction loses
 *   something.
 * - `three_way` — at least one domain is S5: manifest, files and database all
 *   disagree. Strictly worse than S3, so it names the whole decision when both
 *   are present.
 * - `manifest_unusable` — `manifest.json` is missing or unparseable while other
 *   `ria-data/` content is present. No M exists and no F can be computed, so the
 *   database is the sole authority. Produced by the `ria-data` classification
 *   rather than by this function, and carried here so the user surface has one
 *   shape to render.
 */
export type DecisionReason = 'files_edited' | 'three_way' | 'manifest_unusable';

export type SyncOutcome =
  | { kind: 'consistent' }
  | { kind: 'load'; plan: LoadPlan }
  | { kind: 'repair_manifest'; keys: string[] }
  | { kind: 'needs_decision'; reason: DecisionReason; domains: DomainStateEntry[] };

/**
 * Most restrictive wins, in the order
 * `needs_decision > load > repair_manifest > consistent`.
 *
 * A pending decision **anywhere** suppresses both the automatic load and the
 * automatic store for the whole workspace, because either direction would write
 * over something nobody has agreed to lose. Scoping the suppression to the
 * offending domain was considered and rejected: the automatic store is a
 * whole-workspace operation (and the auto-save coordinator fires it about 150 ms
 * after a keystroke), so a per-domain suppression has nothing to attach to.
 *
 * The `manifest` entry is excluded. The manifest is an index, not content: a
 * manifest whose digest differs from the one the database synced from says only
 * that `manifest.json` was rewritten, and whatever it indexes is evaluated on
 * its own three hashes anyway. Letting it vote would turn an edit to a field
 * nobody compares — `exported_at`, say — into a full load. Its real job is to
 * license the short-circuit, which `SyncEvaluation.shortCircuited` records.
 *
 * `meta` entries do participate: meta has no D, so the evaluator classifies it
 * S1 when M equals F and S2 otherwise, and S2 correctly means "load" (the meta
 * layer is re-imported on every load regardless).
 *
 * A set containing both S2 and S4 resolves to `load`, but the workspace must
 * repair the S4 entries before calling load, whose integrity checks require
 * M=F. The plan excludes S4-only layers so their unsaved work survives. Repair
 * must not advance the origin of S2 content that has not yet been loaded.
 */
export function resolveOutcome(allEntries: DomainStateEntry[]): SyncOutcome {
  const entries = allEntries.filter((e) => e.domain.kind !== 'manifest');
  const undecidable = entries.filter((e) => e.state === 'S3' || e.state === 'S5');
  if (undecidable.length > 0) {
    const reason: DecisionReason = undecidable.some((e) => e.state === 'S5')
      ? 'three_way'
      : 'files_edited';
    return { kind: 'needs_decision', reason, domains: undecidable };
  }

  if (entries.some((e) => e.state === 'S2')) {
    return { kind: 'load', plan: planLoad(entries) };
  }

  const stale = entries.filter((e) => e.state === 'S4');
  if (stale.length > 0) {
    return { kind: 'repair_manifest', keys: stale.map((e) => e.domain.id) };
  }

  return { kind: 'consistent' };
}
