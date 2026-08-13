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
   * namespace-layer file and per-namespace hash byte-identical (Req 10).
   * Mutually exclusive with `namespace`.
   */
  scope?: 'universe';
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

export interface StoreResult {
  files_written: number;
  total_records: number;
  namespaces_written: string[];
  namespaces_skipped: string[];
  exported_at: string;
  /** Universe files written in this store (ria-data-relative paths). */
  universe_files_written?: string[];
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
   * (Requirement 8.5).
   */
  connections_skipped?: { source: string; target: string }[];
}

export interface RepairManifestResult {
  namespaces_repaired: string[];
  namespaces_unchanged: string[];
  manifest_updated: boolean;
}

export interface Manifest {
  schema_version: string;
  namespaces: {
    name: string;
    directory: string;
    metamodel: string;
    metamodel_version: string;
    namespace_role?: string;
    namespace_owning_application?: string;
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
   * Optional for backward compatibility with manifests written before this field.
   */
  meta_hash?: string;
  /**
   * Content hash of each universe-layer file, keyed by its ria-data-relative
   * path (e.g. "universe/RIA_UNIV_CanvasLayout.json"). Recorded on every store
   * and verified on load, exactly like namespace_hashes. Because Auto_Save is
   * still in development there is no pre-hash legacy: every universe-layer file
   * is always written with a Universe_Hash.
   */
  universe_hashes: Record<string, string>;
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
