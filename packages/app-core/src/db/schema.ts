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
import lbug, { type Database } from '@ladybugdb/core';

export type SchemaLayer = 'meta' | 'sourcemaster' | 'universe' | 'cross_namespace';

export interface CanonicalColumnDef {
  name: string;
  type: 'STRING' | 'BOOLEAN' | 'INT64' | 'DOUBLE' | 'SERIAL';
}

export interface CanonicalNodeTableDef {
  name: string;
  layer: SchemaLayer;
  primaryKey: string;
  columns: CanonicalColumnDef[];
  jsonColumns: string[];
}

export interface CanonicalRelTableDef {
  name: string;
  layer: SchemaLayer;
  fromTable: string;
  toTable: string;
  columns?: CanonicalColumnDef[];
}

// 1.4.0: added RIA_UNIV_View and its three relationship tables (VIEW_DEFINEDBY,
// VIEW_CATEGORIZEDBY, VIEW_SOURCE) for the View concept (docs/coreSpecs/RiaViews.md).
// The version bump ensures existing workspaces are rebuilt from ria-data so the new
// tables exist before any view definition can be created.
export const SCHEMA_VERSION = '1.4.0';
export const DB_SCHEMA_VERSION_TABLE = 'RIA_META_SchemaVersion';
export const DB_SCHEMA_VERSION_NODE_ID = 'ria-core';

export const CANONICAL_NODE_TABLES: CanonicalNodeTableDef[] = [
  {
    name: 'RIA_META_Metamodel',
    layer: 'meta',
    primaryKey: 'name',
    jsonColumns: ['profile_metadata'],
    columns: [
      { name: 'name', type: 'STRING' },
      { name: 'version', type: 'STRING' },
      { name: 'description', type: 'STRING' },
      { name: 'long_name', type: 'STRING' },
      { name: 'profile_metadata', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_META_Concept',
    layer: 'meta',
    primaryKey: 'id',
    jsonColumns: [],
    columns: [
      { name: 'id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'is_abstract', type: 'BOOLEAN' },
      { name: 'description', type: 'STRING' },
      { name: 'long_name', type: 'STRING' },
      { name: 'render_icon', type: 'STRING' },
      { name: 'render_color', type: 'STRING' },
      { name: 'render_hidden', type: 'BOOLEAN' },
    ],
  },
  {
    name: 'RIA_META_Relationship',
    layer: 'meta',
    primaryKey: 'id',
    jsonColumns: [],
    columns: [
      { name: 'id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'source_concept', type: 'STRING' },
      { name: 'target_concept', type: 'STRING' },
      { name: 'is_abstract', type: 'BOOLEAN' },
      { name: 'is_containment', type: 'BOOLEAN' },
      { name: 'description', type: 'STRING' },
      { name: 'long_name', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_META_NodeAttribute',
    layer: 'meta',
    primaryKey: 'id',
    jsonColumns: [],
    columns: [
      { name: 'id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'concept', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'required', type: 'BOOLEAN' },
      { name: 'attribute_type', type: 'STRING' },
      { name: 'multiplicity', type: 'STRING' },
      { name: 'is_key', type: 'BOOLEAN' },
      { name: 'is_identity', type: 'BOOLEAN' },
    ],
  },
  {
    name: 'RIA_META_EdgeAttribute',
    layer: 'meta',
    primaryKey: 'id',
    jsonColumns: [],
    columns: [
      { name: 'id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'relationship', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'required', type: 'BOOLEAN' },
      { name: 'attribute_type', type: 'STRING' },
      { name: 'is_key', type: 'BOOLEAN' },
    ],
  },
  {
    name: DB_SCHEMA_VERSION_TABLE,
    layer: 'meta',
    primaryKey: 'id',
    jsonColumns: [],
    columns: [
      { name: 'id', type: 'STRING' },
      { name: 'schema_version', type: 'STRING' },
      { name: 'created_at', type: 'STRING' },
      { name: 'updated_at', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_Namespace',
    layer: 'universe',
    primaryKey: 'name',
    jsonColumns: [],
    columns: [
      { name: 'name', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'namespace_role', type: 'STRING' },
      { name: 'namespace_owning_application', type: 'STRING' },
      { name: 'content_hash', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_ConceptInstance',
    layer: 'universe',
    primaryKey: 'node_id',
    jsonColumns: ['attributes'],
    columns: [
      { name: 'node_id', type: 'SERIAL' },
      { name: 'namespace', type: 'STRING' },
      { name: 'concept', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'attributes', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_RelationshipInstance',
    layer: 'universe',
    primaryKey: 'edge_id',
    jsonColumns: ['attributes'],
    columns: [
      { name: 'edge_id', type: 'SERIAL' },
      { name: 'namespace', type: 'STRING' },
      { name: 'relationship', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'source_node_id', type: 'INT64' },
      { name: 'target_node_id', type: 'INT64' },
      { name: 'attributes', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_CategoryLink',
    layer: 'universe',
    primaryKey: 'link_id',
    jsonColumns: [],
    columns: [
      { name: 'link_id', type: 'SERIAL' },
      { name: 'node_id', type: 'INT64' },
      { name: 'category_metamodel', type: 'STRING' },
      { name: 'category', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_RelCategoryLink',
    layer: 'universe',
    primaryKey: 'link_id',
    jsonColumns: [],
    columns: [
      { name: 'link_id', type: 'SERIAL' },
      { name: 'edge_id', type: 'INT64' },
      { name: 'category_metamodel', type: 'STRING' },
      { name: 'category', type: 'STRING' },
    ],
  },
  {
    // Global canvas layout table: one row per Layout_Key (element_kind, element_key).
    // element_kind is an opaque STRING with NO enum constraint, so any current or future
    // Element_Kind value is storable without a schema change (Requirements 1.4, 8.1).
    // Keyed by the content-derived layout_id (never node_id), so records are stable
    // across node-ID reassignment.
    name: 'RIA_UNIV_CanvasLayout',
    layer: 'universe',
    primaryKey: 'layout_id',
    jsonColumns: [],
    columns: [
      { name: 'layout_id', type: 'STRING' },
      { name: 'element_kind', type: 'STRING' },
      { name: 'element_key', type: 'STRING' },
      { name: 'x', type: 'DOUBLE' },
      { name: 'y', type: 'DOUBLE' },
    ],
  },
  {
    // A view is a peer of a namespace: a named, saved, metamodel-typed virtual
    // projection over one or more source namespaces (docs/coreSpecs/RiaViews.md).
    // Only the definition is persisted here — view CONTENT is computed on demand
    // and never stored, so there is deliberately no content_hash, computed_at, or
    // staleness column (a materialized view would have to solve refresh
    // orchestration and node-ID-reassignment survival; a virtual view has none of
    // those problems by construction).
    name: 'RIA_UNIV_View',
    layer: 'universe',
    primaryKey: 'name',
    jsonColumns: ['parameters'],
    columns: [
      { name: 'name', type: 'STRING' },
      { name: 'description', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'mapping', type: 'STRING' },
      { name: 'parameters', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_NamespaceRelation',
    layer: 'cross_namespace',
    primaryKey: 'rel_id',
    jsonColumns: [],
    columns: [
      { name: 'rel_id', type: 'SERIAL' },
      { name: 'source_namespace', type: 'STRING' },
      { name: 'target_namespace', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'relationship', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_UNIV_CrossNSRelationshipInstance',
    layer: 'cross_namespace',
    primaryKey: 'edge_id',
    jsonColumns: ['attributes'],
    columns: [
      { name: 'edge_id', type: 'SERIAL' },
      { name: 'source_namespace', type: 'STRING' },
      { name: 'target_namespace', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'relationship', type: 'STRING' },
      { name: 'source_node_id', type: 'INT64' },
      { name: 'target_node_id', type: 'INT64' },
      { name: 'attributes', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_SRC_Source',
    layer: 'sourcemaster',
    primaryKey: 'source_id',
    jsonColumns: ['config', 'config_data'],
    columns: [
      { name: 'source_id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'source_type', type: 'STRING' },
      { name: 'target_namespace', type: 'STRING' },
      { name: 'target_metamodel', type: 'STRING' },
      { name: 'importer_version', type: 'STRING' },
      { name: 'config', type: 'STRING' },
      { name: 'config_data', type: 'STRING' },
      { name: 'config_path', type: 'STRING' },
      { name: 'created_at', type: 'STRING' },
      { name: 'updated_at', type: 'STRING' },
    ],
  },
  {
    name: 'RIA_SRC_ImportRun',
    layer: 'sourcemaster',
    primaryKey: 'run_id',
    jsonColumns: ['stats', 'config_snapshot'],
    columns: [
      { name: 'run_id', type: 'STRING' },
      { name: 'source_id', type: 'STRING' },
      { name: 'status', type: 'STRING' },
      { name: 'started_at', type: 'STRING' },
      { name: 'completed_at', type: 'STRING' },
      { name: 'stats', type: 'STRING' },
      { name: 'triggered_by', type: 'STRING' },
      { name: 'config_snapshot', type: 'STRING' },
    ],
  },
];

export function getCanonicalNodeTable(name: string): CanonicalNodeTableDef | undefined {
  return CANONICAL_NODE_TABLES.find((t) => t.name === name);
}

export function buildNodeTableDdlFromCanonical(table: CanonicalNodeTableDef): string {
  const columnDefs = table.columns.map((column) => `    ${column.name} ${column.type}`).join(',\n');
  return `CREATE NODE TABLE IF NOT EXISTS ${table.name}(\n${columnDefs},\n    PRIMARY KEY(${table.primaryKey})\n  )`;
}

export const CANONICAL_REL_TABLES: CanonicalRelTableDef[] = [
  { name: 'RIA_META_DEFINES_CONCEPT', layer: 'meta', fromTable: 'RIA_META_Metamodel', toTable: 'RIA_META_Concept' },
  { name: 'RIA_META_DEFINES_RELATIONSHIP', layer: 'meta', fromTable: 'RIA_META_Metamodel', toTable: 'RIA_META_Relationship' },
  { name: 'RIA_META_CONCEPT_SUBTYPEOF', layer: 'meta', fromTable: 'RIA_META_Concept', toTable: 'RIA_META_Concept' },
  { name: 'RIA_META_REL_SUBTYPEOF', layer: 'meta', fromTable: 'RIA_META_Relationship', toTable: 'RIA_META_Relationship' },
  { name: 'RIA_META_REL_SOURCE', layer: 'meta', fromTable: 'RIA_META_Relationship', toTable: 'RIA_META_Concept' },
  { name: 'RIA_META_REL_TARGET', layer: 'meta', fromTable: 'RIA_META_Relationship', toTable: 'RIA_META_Concept' },
  { name: 'RIA_META_CONCEPT_ATTRIBUTE', layer: 'meta', fromTable: 'RIA_META_Concept', toTable: 'RIA_META_NodeAttribute' },
  { name: 'RIA_META_REL_ATTRIBUTE', layer: 'meta', fromTable: 'RIA_META_Relationship', toTable: 'RIA_META_EdgeAttribute' },
  { name: 'RIA_META_DEFINEDBY', layer: 'meta', fromTable: 'RIA_UNIV_Namespace', toTable: 'RIA_META_Metamodel' },
  { name: 'RIA_META_CATEGORIZEDBY', layer: 'meta', fromTable: 'RIA_UNIV_Namespace', toTable: 'RIA_META_Metamodel' },
  {
    name: 'RIA_UNIV_INSTANCE_REL',
    layer: 'universe',
    fromTable: 'RIA_UNIV_ConceptInstance',
    toTable: 'RIA_UNIV_ConceptInstance',
    columns: [
      { name: 'edge_instance_id', type: 'INT64' },
      { name: 'relationship', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
    ],
  },
  // Per-pair namespace connection edge (source of truth for manual connections).
  // Direction is always imported → authored; carries no payload columns — the
  // endpoint pair (imported source, authored target) is the entire content.
  { name: 'RIA_UNIV_NamespaceConnection', layer: 'universe', fromTable: 'RIA_UNIV_Namespace', toTable: 'RIA_UNIV_Namespace' },
  // View relationships (docs/coreSpecs/RiaViews.md). Distinct tables rather than a
  // reuse of RIA_META_DEFINEDBY / RIA_META_CATEGORIZEDBY, because a rel table
  // declares a single FROM/TO pair and those are already declared FROM
  // RIA_UNIV_Namespace — they cannot also serve a View source.
  { name: 'RIA_UNIV_VIEW_DEFINEDBY', layer: 'universe', fromTable: 'RIA_UNIV_View', toTable: 'RIA_META_Metamodel' },
  { name: 'RIA_UNIV_VIEW_CATEGORIZEDBY', layer: 'universe', fromTable: 'RIA_UNIV_View', toTable: 'RIA_META_Metamodel' },
  // The defining relationship of the concept: a view with zero sources is invalid.
  { name: 'RIA_UNIV_VIEW_SOURCE', layer: 'universe', fromTable: 'RIA_UNIV_View', toTable: 'RIA_UNIV_Namespace' },
  { name: 'RIA_UNIV_NSR_SOURCE', layer: 'cross_namespace', fromTable: 'RIA_UNIV_NamespaceRelation', toTable: 'RIA_UNIV_Namespace' },
  { name: 'RIA_UNIV_NSR_TARGET', layer: 'cross_namespace', fromTable: 'RIA_UNIV_NamespaceRelation', toTable: 'RIA_UNIV_Namespace' },
  {
    name: 'RIA_UNIV_CROSSNS_INSTANCE_REL',
    layer: 'cross_namespace',
    fromTable: 'RIA_UNIV_ConceptInstance',
    toTable: 'RIA_UNIV_ConceptInstance',
    columns: [
      { name: 'edge_instance_id', type: 'INT64' },
      { name: 'relationship', type: 'STRING' },
      { name: 'metamodel', type: 'STRING' },
      { name: 'source_namespace', type: 'STRING' },
      { name: 'target_namespace', type: 'STRING' },
    ],
  },
  { name: 'RIA_SRC_RUN_FOR', layer: 'sourcemaster', fromTable: 'RIA_SRC_ImportRun', toTable: 'RIA_SRC_Source' },
  { name: 'RIA_SRC_TARGETS_NS', layer: 'sourcemaster', fromTable: 'RIA_SRC_Source', toTable: 'RIA_UNIV_Namespace' },
];

export function buildRelTableDdlFromCanonical(table: CanonicalRelTableDef): string {
  const relColumns = table.columns ?? [];
  if (relColumns.length === 0) {
    return `CREATE REL TABLE IF NOT EXISTS ${table.name}(\n    FROM ${table.fromTable} TO ${table.toTable}\n  )`;
  }

  const columnDefs = relColumns.map((column) => `    ${column.name} ${column.type}`).join(',\n');
  return `CREATE REL TABLE IF NOT EXISTS ${table.name}(\n    FROM ${table.fromTable} TO ${table.toTable},\n${columnDefs}\n  )`;
}

// All DDL statements in dependency order:
// Node tables first (no dependencies), then relationship tables (reference node tables).
// Combines main schema and SourceMaster schema from RUMBLE backend.
const NODE_DDL_STATEMENTS: string[] = CANONICAL_NODE_TABLES.map(buildNodeTableDdlFromCanonical);
const REL_DDL_STATEMENTS: string[] = CANONICAL_REL_TABLES.map(buildRelTableDdlFromCanonical);

const DDL_STATEMENTS: string[] = [
  ...NODE_DDL_STATEMENTS,
  ...REL_DDL_STATEMENTS,
];

/**
 * Initialize the RIA graph schema in the given database.
 * Creates a connection, executes all DDL statements, then closes the connection.
 * All DDL uses CREATE ... IF NOT EXISTS for idempotency.
 */
export async function initializeSchema(database: Database): Promise<void> {
  const conn = new lbug.Connection(database);
  try {
    for (const ddl of DDL_STATEMENTS) {
      const raw = await conn.query(ddl);
      const result = Array.isArray(raw) ? raw[0] : raw;
      result.close();
    }
  } finally {
    await conn.close();
  }
}

export async function ensureDbSchemaVersionSeed(database: Database): Promise<void> {
  const conn = new lbug.Connection(database);
  try {
    const raw = await conn.query(
      `MATCH (sv:${DB_SCHEMA_VERSION_TABLE}) WHERE sv.id = '${DB_SCHEMA_VERSION_NODE_ID}' RETURN sv.id AS id`
    );
    const result = Array.isArray(raw) ? raw[0] : raw;
    const rows = await result.getAll();
    if (typeof result.close === 'function') {
      await result.close();
    }

    if (rows.length === 0) {
      const now = new Date().toISOString();
      const createRaw = await conn.query(
        `CREATE (:${DB_SCHEMA_VERSION_TABLE} {
          id: '${DB_SCHEMA_VERSION_NODE_ID}',
          schema_version: '${SCHEMA_VERSION}',
          created_at: '${now}',
          updated_at: '${now}'
        })`
      );
      const createResult = Array.isArray(createRaw) ? createRaw[0] : createRaw;
      createResult.close();
    }
  } finally {
    await conn.close();
  }
}
