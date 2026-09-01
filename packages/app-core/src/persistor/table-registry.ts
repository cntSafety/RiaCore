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
import { getCanonicalNodeTable } from '../db/schema.js';

export interface TableDef {
  name: string;           // Kuzu table name
  layer: 'meta' | 'sourcemaster' | 'universe' | 'cross_namespace';
  type: 'node' | 'rel';
  primaryKey: string;     // column used to sort records
  columns: string[];      // explicit column order used for import/export row mapping
  jsonColumns: string[];  // columns containing JSON strings to inline
  omitColumns: string[];  // columns to exclude from export
  customQuery?: string;   // override the default MATCH query
  srcPk?: string;         // primary key column of the source node (rel tables only)
  dstPk?: string;         // primary key column of the destination node (rel tables only)
}

function nodeTable(name: string, omitColumns: string[]): TableDef {
  const canonical = getCanonicalNodeTable(name);
  if (!canonical) {
    throw new Error(`Canonical node table not found for ${name}`);
  }
  return {
    name,
    layer: canonical.layer,
    type: 'node',
    primaryKey: canonical.primaryKey,
    columns: canonical.columns.map((c) => c.name),
    jsonColumns: canonical.jsonColumns,
    omitColumns,
  };
}

export const TABLE_REGISTRY: TableDef[] = [
  // ── Meta layer: Node tables ────────────────────────────────────────────────
  nodeTable('RIA_META_Metamodel', []),
  nodeTable('RIA_META_Concept', []),
  nodeTable('RIA_META_Relationship', []),
  nodeTable('RIA_META_NodeAttribute', []),
  nodeTable('RIA_META_EdgeAttribute', []),

  // ── Meta layer: Rel tables ─────────────────────────────────────────────────
  { name: 'RIA_META_DEFINES_CONCEPT',       layer: 'meta', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'id' },
  { name: 'RIA_META_DEFINES_RELATIONSHIP',  layer: 'meta', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'id' },
  { name: 'RIA_META_CONCEPT_SUBTYPEOF',     layer: 'meta', type: 'rel', primaryKey: 'src_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'id',   dstPk: 'id' },
  { name: 'RIA_META_REL_SUBTYPEOF',         layer: 'meta', type: 'rel', primaryKey: 'src_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'id',   dstPk: 'id' },
  { name: 'RIA_META_REL_SOURCE',            layer: 'meta', type: 'rel', primaryKey: 'src_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'id',   dstPk: 'id' },
  { name: 'RIA_META_REL_TARGET',            layer: 'meta', type: 'rel', primaryKey: 'src_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'id',   dstPk: 'id' },
  { name: 'RIA_META_CONCEPT_ATTRIBUTE',     layer: 'meta', type: 'rel', primaryKey: 'src_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'id',   dstPk: 'id' },
  { name: 'RIA_META_REL_ATTRIBUTE',         layer: 'meta', type: 'rel', primaryKey: 'src_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'id',   dstPk: 'id' },
  { name: 'RIA_META_DEFINEDBY',             layer: 'meta', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'name' },
  { name: 'RIA_META_CATEGORIZEDBY',         layer: 'meta', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'name' },

  // ── Sourcemaster layer: Node tables ───────────────────────────────────────
  nodeTable('RIA_SRC_Source', []),
  nodeTable('RIA_SRC_ImportRun', []),

  // ── Sourcemaster layer: Rel tables ────────────────────────────────────────
  { name: 'RIA_SRC_RUN_FOR',    layer: 'sourcemaster', type: 'rel', primaryKey: 'src_run_id',   columns: [], jsonColumns: [], omitColumns: [], srcPk: 'run_id',   dstPk: 'source_id' },
  { name: 'RIA_SRC_TARGETS_NS', layer: 'sourcemaster', type: 'rel', primaryKey: 'src_source_id', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'source_id', dstPk: 'name' },

  // ── Universe layer: Node tables ───────────────────────────────────────────
  nodeTable('RIA_UNIV_Namespace', ['content_hash']),
  nodeTable('RIA_UNIV_ConceptInstance', ['node_id']),
  nodeTable('RIA_UNIV_RelationshipInstance', ['edge_id', 'source_node_id', 'target_node_id']),
  nodeTable('RIA_UNIV_CategoryLink', ['link_id']),
  nodeTable('RIA_UNIV_RelCategoryLink', ['link_id']),
  // GLOBAL universe table keyed by the content-derived layout_id (never node_id).
  // Registered for schema/column/primary-key consistency ONLY: the persistor never
  // exports the universe layer generically, so this entry does not itself store or load
  // the table — the round-trip is provided by the bespoke store/load steps (see design
  // §2 "Persistor — bespoke universe-layer store/load"). Keying by layout_id is what
  // keeps each Layout_Record stable across node-ID reassignment.
  nodeTable('RIA_UNIV_CanvasLayout', []),
  // GLOBAL universe table keyed by name (a View's own primary key). Registered for
  // schema/column/primary-key consistency ONLY — same reasoning as
  // RIA_UNIV_CanvasLayout above: the persistor never exports the universe layer
  // generically, so this entry does not itself store or load the table — the
  // round-trip is provided by the bespoke store/load steps in persistor-store.ts /
  // persistor-load.ts.
  nodeTable('RIA_UNIV_View', []),

  // ── Universe layer: Rel tables ────────────────────────────────────────────
  { name: 'RIA_UNIV_INSTANCE_REL', layer: 'universe', type: 'rel', primaryKey: 'src_node_id', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'node_id', dstPk: 'node_id' },
  { name: 'RIA_UNIV_NamespaceConnection', layer: 'universe', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'name' },
  { name: 'RIA_UNIV_VIEW_DEFINEDBY', layer: 'universe', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'name' },
  { name: 'RIA_UNIV_VIEW_CATEGORIZEDBY', layer: 'universe', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'name' },
  { name: 'RIA_UNIV_VIEW_SOURCE', layer: 'universe', type: 'rel', primaryKey: 'src_name', columns: [], jsonColumns: [], omitColumns: [], srcPk: 'name', dstPk: 'name' },

  // ── Cross-namespace layer: Node tables ────────────────────────────────────
  nodeTable('RIA_UNIV_NamespaceRelation', ['rel_id']),
  nodeTable('RIA_UNIV_CrossNSRelationshipInstance', ['edge_id', 'source_node_id', 'target_node_id']),

  // ── Cross-namespace layer: Rel tables ─────────────────────────────────────
  { name: 'RIA_UNIV_NSR_SOURCE', layer: 'cross_namespace', type: 'rel', primaryKey: 'src_source_namespace', columns: [], jsonColumns: [], omitColumns: [],
    customQuery: `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_SOURCE]->(ns:RIA_UNIV_Namespace)
                  RETURN nr.source_namespace AS src_source_namespace, nr.target_namespace AS src_target_namespace,
                         nr.relationship AS src_relationship, ns.name AS dst_name` },
  { name: 'RIA_UNIV_NSR_TARGET', layer: 'cross_namespace', type: 'rel', primaryKey: 'src_source_namespace', columns: [], jsonColumns: [], omitColumns: [],
    customQuery: `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_TARGET]->(ns:RIA_UNIV_Namespace)
                  RETURN nr.source_namespace AS src_source_namespace, nr.target_namespace AS src_target_namespace,
                         nr.relationship AS src_relationship, ns.name AS dst_name` },
  { name: 'RIA_UNIV_CROSSNS_INSTANCE_REL', layer: 'cross_namespace', type: 'rel', primaryKey: 'src_attributes', columns: [], jsonColumns: ['src_attributes', 'dst_attributes'], omitColumns: [],
    customQuery: `MATCH (src:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(dst:RIA_UNIV_ConceptInstance)
                  RETURN src.attributes AS src_attributes, src.namespace AS src_namespace, src.concept AS src_concept, src.metamodel AS src_metamodel,
                         dst.attributes AS dst_attributes, dst.namespace AS dst_namespace, dst.concept AS dst_concept, dst.metamodel AS dst_metamodel,
                         r.relationship AS relationship, r.metamodel AS rel_metamodel,
                         r.source_namespace AS source_namespace, r.target_namespace AS target_namespace` },
];

export function getTablesByLayer(layer: TableDef['layer']): TableDef[] {
  return TABLE_REGISTRY.filter(t => t.layer === layer);
}

export function getTableByName(name: string): TableDef | undefined {
  return TABLE_REGISTRY.find((t) => t.name === name);
}
