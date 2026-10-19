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
 * Persistor types, interfaces, and constants.
 */

// ── Interfaces ─────────────────────────────────────────────────────────────────

export interface PersistorStoreParams {
  workingDir: string;
  /** If provided, store only this namespace; leave all other namespace hashes in the manifest unchanged. */
  namespace?: string;
  /**
   * When 'universe', write ONLY the universe-layer files
   * (RIA_UNIV_CanvasLayout.json, RIA_UNIV_NamespaceConnection.json), record
   * their Universe_Hash + inventory in the manifest, and leave every
   * namespace-layer file and per-namespace hash byte-identical.
   * Mutually exclusive with `namespace`.
   */
  scope?: 'universe';
  /**
   * Write even though `ria-data/` no longer matches the snapshot the database
   * was loaded from.
   *
   * The escape hatch for the deliberate "port my work to this branch" flow: the
   * user has been shown what changed and chose to overwrite it. NEVER a default,
   * and never set by auto-save.
   */
  allowSnapshotMismatch?: boolean;
}

export interface LoadProgressEvent {
  phase: 'shared' | 'namespace' | 'concepts' | 'relationships' | 'cross_namespace' | 'finalizing';
  message: string;
  current?: number;
  total?: number;
}

export type OnLoadProgress = (event: LoadProgressEvent) => void;

export interface PersistorLoadParams {
  workingDir: string;
  /** Explicitly adopt edited files: validate them and repair stale manifest hashes before a full load. */
  acceptFileChanges?: boolean;
  /**
   * Which domains to clear and re-import. Anything the plan does not name keeps
   * whatever the database already holds, so resolving one stale layer cannot
   * wipe a layer that was never stale.
   *
   * Omitted: the load evaluates the sync state itself and plans from it, so a
   * direct caller and the CLI behave exactly like the open path. An explicit
   * plan is honoured as given — the drift dialog's Load button passes a full
   * plan deliberately, overriding an evaluation that would have planned nothing.
   */
  plan?: import('../workspace/sync-state.js').LoadPlan;
  onProgress?: OnLoadProgress;
  /**
   * Optional callback for namespace-level progress events.
   * Emits `namespace_start` before each namespace is processed and
   * `namespace_done` after each namespace is successfully imported.
   * Failures in this callback are silently swallowed — they must never
   * cause the load operation to fail.
   */
  onNamespaceProgress?: (event: import('@riacore/app-contracts').LoadProgressPushEvent) => void;
}

export interface PersistorRepairParams {
  workingDir: string;
}

/**
 * One concept or relationship type that the store deliberately did not write to
 * disk, or one group of instances dropped for having no type at all.
 *
 * Exists so a declined write is reported rather than silent. The two cases it
 * covers both used to be invisible: a concept type whose sort threw was skipped
 * with only a WARN in the workspace log, and an instance with an empty
 * `concept`/`relationship` field was dropped by a bare `continue`. Both were
 * nevertheless counted inside the recorded namespace hash, which is how a store
 * that succeeded could produce a `ria-data/` that failed its own integrity
 * check at the next load.
 */
export interface SkippedTypeReport {
  /** The namespace whose export declined to write this. */
  namespace: string;
  kind: 'concept' | 'relationship';
  /**
   * The concept or relationship type. Empty string for the dropped-untyped
   * case, where the absent type field is the reason itself.
   */
  type: string;
  /** Why it was not written, in a form safe to show a user. */
  reason: string;
  /** How many instances were affected. */
  count: number;
}

export interface StoreResult {
  files_written: number;
  total_records: number;
  namespaces_written: string[];
  namespaces_skipped: string[];
  exported_at: string;
  /** Universe files written in this store (ria-data-relative paths). */
  universe_files_written?: string[];
  /**
   * Types not written and instances dropped, across every namespace this store
   * considered. Present only when there was at least one — absence means every
   * instance in the DB reached a file.
   */
  skipped_types?: SkippedTypeReport[];
}

export interface LoadResult {
  namespaces_imported: string[];
  namespaces_skipped: string[];
  total_records_imported: number;
  log_file?: string;
  /**
   * Total number of relationship edges that could not be loaded because their
   * source or target stable_id could not be resolved to a node_id. A non-zero
   * value indicates a partial load — the namespace was imported but some
   * containment or reference edges are missing.
   */
  relationships_failed?: number;
  /**
   * Per-pair namespace connections (RIA_UNIV_NamespaceConnection) that were
   * persisted but could NOT be restored because one or both endpoint namespaces
   * are absent from the loaded workspace (dangling reference). Each such
   * connection is omitted while all connections whose endpoints are both present
   * are restored. Present only when at least one connection was skipped
   */
  connections_skipped?: { source: string; target: string }[];
  /**
   * View definitions (RIA_UNIV_View) that were persisted but could NOT be fully
   * restored because at least one of their VIEW_SOURCE namespaces or
   * VIEW_DEFINEDBY/VIEW_CATEGORIZEDBY metamodels is absent from the loaded
   * workspace. A view left with zero VIEW_SOURCE edges after skipping dangling
   * ones is dropped entirely — a view with zero sources is invalid
   * (docs/coreSpecs/RiaViews.md). Present only when at least one view was skipped.
   */
  views_skipped?: { view: string; reason: string }[];
}

export interface RepairManifestResult {
  namespaces_repaired: string[];
  namespaces_unchanged: string[];
  manifest_updated: boolean;
  /**
   * `sourcemaster/` files (ria-data-relative paths) whose recorded hash was
   * rewritten from the file's on-disk bytes. Includes files that had no
   * manifest entry at all: repair enumerates the sourcemaster table registry
   * rather than the manifest's existing keys, so it can *complete* the carrier
   * and not merely correct it.
   *
   * This is the only field this result gained for `sourcemaster_hashes`.
   * `repairManifest` stays synchronous with its `(params, logger)` signature and
   * takes no `dbModule`: an earlier draft added a DB-backed backfill of the
   * namespace identity fields, which was cut because repair recomputes digests
   * from files and has no source for namespace identity once the manifest entry
   * is gone. There is deliberately no `namespace_entries_backfilled` /
   * `namespace_entries_unrepairable` here.
   */
  sourcemaster_files_repaired?: string[];
}

/**
 * `ria-data/manifest.json`.
 *
 * A parse assertion, not runtime validation: it describes the manifest THIS
 * version of the code writes, which is the only manifest whose hash carriers are
 * comparable. A required field is therefore enforced on the write side -- a
 * literal missing a carrier is a compile error -- but not on the read side,
 * where `JSON.parse(...) as Manifest` hands back an object whose required fields
 * may be absent because an older-epoch file predates them.
 *
 * Reading an older manifest is safe regardless: the epoch guard is evaluated
 * before any carrier is dereferenced.
 */
export interface Manifest {
  schema_version: string;
  namespaces: {
    name: string;
    directory: string;
    metamodel: string;
    metamodel_version: string;
    /**
     * Required: the manifest entry is the sole authority for namespace identity.
     * A silently-absent role defaults to `''`, which disables concept creation,
     * view sourcing and imported↔authored wiring with no visible cause.
     */
    namespace_role: string;
    namespace_owning_application: string;
  }[];
  metamodel_versions: Record<string, string>;
  namespace_hashes: Record<string, string>;
  /**
   * SHA-256 hash of the meta layer files (metamodel definitions, DEFINEDBY,
   * CATEGORIZEDBY, etc.). Computed on store and verified on load. A mismatch
   * means the meta layer on disk differs from what was last stored — either
   * the metamodel YAML changed (legitimate) or the files were manually edited.
   * Unlike namespace_hashes, a meta_hash mismatch is a warning, not an error:
   * the load proceeds and the post-load wiring step repairs any missing edges.
   * Required: it was optional only to tolerate manifests written before the
   * field existed, a case the epoch guard now covers wholesale.
   */
  meta_hash: string;
  /**
   * Content hash of each `sourcemaster/` file, keyed by its ria-data-relative
   * path (e.g. "sourcemaster/RIA_SRC_Source.json"). Written on every full or
   * namespace-scoped store from the exact bytes `exportLayer` wrote, verified on
   * load, and completed by `repairManifest`.
   *
   * Hashed with the same `computeUniverseFileHash` the universe layer uses, so
   * store, load and repair agree byte-for-byte rather than each deriving a
   * digest its own way.
   *
   * A mismatch here is a hard failure at load, not a warning like `meta_hash`:
   * sourcemaster is serialized DB record data that load clears and re-imports
   * unconditionally, and nothing regenerates it from code. The `meta_hash`
   * warning exists only because the meta layer *is* legitimately regenerated.
   */
  sourcemaster_hashes: Record<string, string>;
  /**
   * Content hash of each universe-layer file, keyed by its ria-data-relative
   * path (e.g. "universe/RIA_UNIV_CanvasLayout.json"). Recorded on every store
   * and verified on load, exactly like namespace_hashes. Because Auto_Save is
   * still in development there is no pre-hash legacy: every universe-layer file
   * is always written with a Universe_Hash.
   */
  universe_hashes: Record<string, string>;
  /**
   * Content hash of each `cross_namespace/` file, keyed by its ria-data-relative
   * forward-slash path. Per file, like `universe_hashes` and
   * `sourcemaster_hashes`, so load can name the offending file and repair can
   * rewrite one entry.
   *
   * These files were previously unhashed AS FILES. The per-namespace content hash
   * digests a namespace's cross-NS edges record-based, filtered by
   * `source_namespace` -- a different question (does this namespace's slice
   * agree?) at a different granularity. Do not reuse it here, and do not add a
   * second derivation from DB rows: see "Namespace Content Hash / Why it is a
   * digest over bytes" in PersistorGitFriendlyFormat.md for the failure that
   * produced.
   */
  cross_namespace_hashes: Record<string, string>;
  file_inventory: Record<string, number>;
}

export interface IPersistorService {
  store(params: PersistorStoreParams): Promise<StoreResult>;
  load(params: PersistorLoadParams): Promise<LoadResult>;
  repairManifest(params: PersistorRepairParams): Promise<RepairManifestResult>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const LOAD_BATCH_SIZE = 500;

// ── Attribute metadata types ───────────────────────────────────────────────────

/** Map of concept_type → sorted list of key/identity attribute names */
export type NodeKeyAttrMap = Map<string, string[]>;
/** Map of relationship_type → sorted list of is_key edge attribute names */
export type EdgeKeyAttrMap = Map<string, string[]>;
