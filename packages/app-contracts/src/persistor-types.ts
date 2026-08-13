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

export interface PersistorLoadParams {
  workingDir: string;
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
   * are absent from the loaded workspace (dangling reference). All connections
   * whose endpoints are both present are still restored; only the dangling ones
   * are omitted. Present only when at least one connection was skipped
   * (Requirement 8.5).
   */
  connections_skipped?: { source: string; target: string }[];
}

export interface DbStats {
  namespace_count: number;
  node_count: number;
  edge_count: number;
}

export interface NamespaceStats {
  name: string;
  node_count: number;
  edge_count: number;
}

export interface RepairManifestResult {
  namespaces_repaired: string[];
  namespaces_unchanged: string[];
  manifest_updated: boolean;
}

export interface LoadProgressPushEvent {
  /** 'namespace_start' emitted before loading; 'namespace_done' emitted after */
  kind: 'namespace_start' | 'namespace_done';
  namespaceName: string;
  /** 1-based index of this namespace in the load sequence */
  namespaceIndex: number;
  /** Total namespaces to load; null if unknown */
  totalNamespaces: number | null;
}
