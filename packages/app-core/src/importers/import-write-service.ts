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
 * Import Write Service — owns all database mutations during import.
 *
 * Provides bulk write operations for importers: metamodel registration,
 * namespace replacement, concept/relationship creation, and SourceMaster
 * provenance recording. All writes flow through IDbModule.
 */

import type { IImportWriteService } from '@riacore/importer-sdk';
import type {
  ImportSession,
  BeginSessionParams,
  ConceptBatch,
  RelationshipBatch,
  NodeIdMap,
  ImportStats,
  ImportConfigData,
  MetamodelProfileMetadata,
  ProfileReviewMetadata,
} from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import type { Connection } from '@ladybugdb/core';
import { buildMetamodelProfileMetadata } from './profile-metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape single quotes for inline Cypher string literals. */
function e(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface SourceConfigMeta {
  configPath?: string;
  configDigest?: string;
  metamodelPath?: string;
  metamodelDigest?: string;
  configDirty?: boolean;
  lastAppliedAt?: string;
}

function parseSourceConfigMeta(raw: unknown): SourceConfigMeta {
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as SourceConfigMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mergeSourceConfigMeta(raw: unknown, patch: Partial<SourceConfigMeta>): string {
  const merged: Record<string, unknown> = { ...parseSourceConfigMeta(raw) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return JSON.stringify(merged);
}

async function updateSourceConfigMeta(
  db: IDbModule,
  sourceId: string,
  patch: Partial<SourceConfigMeta>,
): Promise<void> {
  const rows = await db.runQuery(
    `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId RETURN s.config AS config`,
    { sourceId },
  );
  if (!rows.length) return;

  const merged = mergeSourceConfigMeta(rows[0].config, patch);
  await db.runQuery(
    `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(sourceId)}'
     SET s.config = '${e(merged)}'`,
  );
}

/** Run a query on an existing connection and return all rows. */
async function qry(conn: Connection, cypher: string): Promise<Record<string, unknown>[]> {
  const raw = await conn.query(cypher);
  const result = Array.isArray(raw) ? raw[0] : raw;
  try {
    return await result.getAll();
  } finally {
    result.close();
  }
}

/** Run a statement on an existing connection, discarding results. */
async function stmt(conn: Connection, cypher: string): Promise<void> {
  const raw = await conn.query(cypher);
  if (Array.isArray(raw)) {
    raw.forEach(r => r.close());
  } else {
    raw.close();
  }
}

/** Concept id in the metamodel: "{metamodel}__{name}" */
function conceptId(metamodel: string, name: string): string {
  return `${metamodel}__${name}`;
}

/** Relationship id in the metamodel: "{metamodel}__{name}" */
function relId(metamodel: string, name: string): string {
  return `${metamodel}__${name}`;
}

const CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Parsed LinkML schema shape (produced by linkml-parser, Task 5.2)
// ---------------------------------------------------------------------------

/**
 * Per-concept tree rendering configuration declared in the LinkML metamodel.
 * All fields are optional; an omitted field is left absent rather than defaulted.
 */
export interface RenderingConfig {
  icon?: string; // ant-design icon component name, e.g. "BlockOutlined"
  color?: string; // any CSS color string, e.g. "#1677ff"
  hidden?: boolean;
}

export interface LinkMLClass {
  name: string;
  is_a?: string;
  is_abstract?: boolean;
  description?: string;
  identity_attribute?: string;
  attributes?: Record<string, LinkMLAttribute>;
  rendering?: RenderingConfig; // absent when the YAML omits the block
}

export interface LinkMLAttribute {
  name: string;
  required?: boolean;
  range?: string;
  multivalued?: boolean;
  description?: string;
  identifier?: boolean;
  default_value?: string;
}

export interface LinkMLSlot {
  name: string;
  domain?: string;
  range?: string;
  description?: string;
  required?: boolean;
  multivalued?: boolean;
  identifier?: boolean;
  is_containment?: boolean;
  default_value?: string;
}

export interface LinkMLPermissibleValue {
  value: string;
  description?: string;
}

export interface LinkMLEnum {
  name: string;
  description?: string;
  permissible_values: LinkMLPermissibleValue[];
}

export interface LinkMLSchema {
  name: string;
  version?: string;
  description?: string;
  classes: Record<string, LinkMLClass>;
  slots: Record<string, LinkMLSlot>;
  enums?: Record<string, LinkMLEnum>;
  review?: ProfileReviewMetadata;
  profile_metadata?: MetamodelProfileMetadata;
  /** Ordered list of attribute names to try when producing a human-readable label for a node from this metamodel. */
  display_identifier_attrs?: string[];
}


// ---------------------------------------------------------------------------
// Metamodel Registration
// ---------------------------------------------------------------------------

async function registerMetamodel(
  db: IDbModule,
  schema: LinkMLSchema,
  metamodelName: string,
): Promise<void> {
  const version = schema.version ?? '1.0.0';
  const description = schema.description ?? '';
  const profileMetadata = JSON.stringify(
    schema.profile_metadata ?? buildMetamodelProfileMetadata(schema),
  );

  // Create metamodel node, including the normalized profile snapshot used by
  // renderer and CLI consumers. Keeping one JSON value preserves source order.
  await db.runQuery(
    `CREATE (m:RIA_META_Metamodel {
      name: '${e(metamodelName)}',
      version: '${e(version)}',
      description: '${e(description)}',
      long_name: '${e(metamodelName)}',
      profile_metadata: $profileMetadata
    })`,
    { profileMetadata },
  );

  // Sort classes: abstract first, then concrete (preserves is_a ordering)
  const allClasses = Object.values(schema.classes);
  const abstractClasses = allClasses.filter((c) => c.is_abstract);
  const concreteClasses = allClasses.filter((c) => !c.is_abstract);
  const sortedClasses = [...abstractClasses, ...concreteClasses];

  // Register concepts
  for (const cls of sortedClasses) {
    const id = conceptId(metamodelName, cls.name);
    const isAbstract = cls.is_abstract ?? false;
    const desc = cls.description ?? '';
    const rIcon = cls.rendering?.icon ?? '';
    const rColor = cls.rendering?.color ?? '';
    const rHidden = cls.rendering?.hidden ?? false;

    await db.runQuery(
      `CREATE (:RIA_META_Concept {
        id: '${e(id)}',
        name: '${e(cls.name)}',
        metamodel: '${e(metamodelName)}',
        is_abstract: ${isAbstract},
        description: '${e(desc)}',
        long_name: '${e(cls.name)}',
        render_icon: '${e(rIcon)}',
        render_color: '${e(rColor)}',
        render_hidden: ${rHidden}
      })`,
    );

    // Link metamodel → concept
    await db.runQuery(
      `MATCH (mm:RIA_META_Metamodel), (c:RIA_META_Concept)
       WHERE mm.name = '${e(metamodelName)}' AND c.id = '${e(id)}'
       CREATE (mm)-[:RIA_META_DEFINES_CONCEPT]->(c)`,
    );

    // Create is_a (SUBTYPEOF) edge if parent exists
    if (cls.is_a) {
      const parentId = conceptId(metamodelName, cls.is_a);
      await db.runQuery(
        `MATCH (child:RIA_META_Concept), (parent:RIA_META_Concept)
         WHERE child.id = '${e(id)}' AND parent.id = '${e(parentId)}'
         CREATE (child)-[:RIA_META_CONCEPT_SUBTYPEOF]->(parent)`,
      );
    }

    // Register all class attributes as RIA_META_NodeAttribute entries.
    // Only for concrete classes — abstract classes don't have instances.
    if (!isAbstract && cls.attributes && Object.keys(cls.attributes).length > 0) {
      for (const [attrName, attr] of Object.entries(cls.attributes)) {
        const attrId = `${metamodelName}__${cls.name}__${attrName}`;
        const isIdentity = cls.identity_attribute === attrName;
        const attrType = attr.range ?? 'string';
        const required = attr.required ?? false;
        const multivalued = attr.multivalued ?? false;

        await db.runQuery(
          `CREATE (:RIA_META_NodeAttribute {
            id: '${e(attrId)}',
            name: '${e(attrName)}',
            concept: '${e(cls.name)}',
            metamodel: '${e(metamodelName)}',
            required: ${required},
            attribute_type: '${e(attrType)}',
            multiplicity: '${multivalued ? '*' : ''}',
            is_key: false,
            is_identity: ${isIdentity}
          })`,
        );
        await db.runQuery(
          `MATCH (c:RIA_META_Concept), (a:RIA_META_NodeAttribute)
           WHERE c.id = '${e(id)}' AND a.id = '${e(attrId)}'
           CREATE (c)-[:RIA_META_CONCEPT_ATTRIBUTE]->(a)`,
        );
      }
    } else if (!isAbstract && cls.identity_attribute) {
      // Fallback: register only the identity attribute if no attributes map
      const attrId = `${metamodelName}__${cls.name}__${cls.identity_attribute}`;
      await db.runQuery(
        `CREATE (:RIA_META_NodeAttribute {
          id: '${e(attrId)}',
          name: '${e(cls.identity_attribute)}',
          concept: '${e(cls.name)}',
          metamodel: '${e(metamodelName)}',
          required: true,
          attribute_type: 'string',
          multiplicity: '',
          is_key: false,
          is_identity: true
        })`,
      );
      await db.runQuery(
        `MATCH (c:RIA_META_Concept), (a:RIA_META_NodeAttribute)
         WHERE c.id = '${e(id)}' AND a.id = '${e(attrId)}'
         CREATE (c)-[:RIA_META_CONCEPT_ATTRIBUTE]->(a)`,
      );
    }
  }

  // Register relationships (slots)
  for (const slot of Object.values(schema.slots)) {
    const id = relId(metamodelName, slot.name);
    const sourceConcept = slot.domain ?? '';
    const targetConcept = slot.range ?? '';
    const desc = slot.description ?? '';

    await db.runQuery(
      `CREATE (:RIA_META_Relationship {
        id: '${e(id)}',
        name: '${e(slot.name)}',
        metamodel: '${e(metamodelName)}',
        source_concept: '${e(sourceConcept)}',
        target_concept: '${e(targetConcept)}',
        is_abstract: false,
        is_containment: ${slot.is_containment ?? false},
        description: '${e(desc)}',
        long_name: '${e(slot.name)}'
      })`,
    );

    // Link metamodel → relationship
    await db.runQuery(
      `MATCH (mm:RIA_META_Metamodel), (r:RIA_META_Relationship)
       WHERE mm.name = '${e(metamodelName)}' AND r.id = '${e(id)}'
       CREATE (mm)-[:RIA_META_DEFINES_RELATIONSHIP]->(r)`,
    );

    // Create REL_SOURCE edge if source concept exists
    if (sourceConcept) {
      const srcId = conceptId(metamodelName, sourceConcept);
      await db.runQuery(
        `MATCH (r:RIA_META_Relationship), (c:RIA_META_Concept)
         WHERE r.id = '${e(id)}' AND c.id = '${e(srcId)}'
         CREATE (r)-[:RIA_META_REL_SOURCE]->(c)`,
      );
    }

    // Create REL_TARGET edge if target concept exists
    if (targetConcept) {
      const tgtId = conceptId(metamodelName, targetConcept);
      await db.runQuery(
        `MATCH (r:RIA_META_Relationship), (c:RIA_META_Concept)
         WHERE r.id = '${e(id)}' AND c.id = '${e(tgtId)}'
         CREATE (r)-[:RIA_META_REL_TARGET]->(c)`,
      );
    }
  }
}


// ---------------------------------------------------------------------------
// Namespace Replacement / Creation helpers
// ---------------------------------------------------------------------------

export interface CreateNamespaceParams {
  namespace: string;
  metamodel: string;
  /** Role assigned to the namespace node in the graph.
   *  - 'imported': regular imported namespace (default for importers).
   *  - 'authored': user-created namespace.
   *  - 'supervised_update_temp': temporary namespace used during a supervised
   *    update review; excluded from normal user-facing views and cleaned up
   *    automatically.
   */
  namespaceRole: 'imported' | 'authored' | 'supervised_update_temp';
  namespaceOwningApplication: string;
  replaceExisting?: boolean;
}

export async function replaceNamespace(db: IDbModule, namespace: string): Promise<void> {
  // Check if namespace exists; if not, skip deletion
  const nsRows = await db.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $ns RETURN count(ns) AS cnt`,
    { ns: namespace },
  );
  if (Number(nsRows[0]?.cnt ?? 0) === 0) {
    return; // Namespace doesn't exist — nothing to delete
  }

  const t0 = Date.now();
  process.stdout.write(`  [delete] Replacing namespace '${namespace}'...\n`);

  // Dependency-ordered deletion:
  const steps: [string, string][] = [
    ['INSTANCE_REL edges', `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance) WHERE a.namespace = '${e(namespace)}' OR b.namespace = '${e(namespace)}' DELETE r`],
    ['RelationshipInstances', `MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = '${e(namespace)}' DELETE ri`],
    ['CROSSNS edges', `MATCH (a:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(b:RIA_UNIV_ConceptInstance) WHERE a.namespace = '${e(namespace)}' OR b.namespace = '${e(namespace)}' DELETE r`],
    ['CrossNSRelInstances', `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance) WHERE x.source_namespace = '${e(namespace)}' OR x.target_namespace = '${e(namespace)}' DELETE x`],
    ['ConceptInstances', `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = '${e(namespace)}' DETACH DELETE ci`],
    ['NSR_SOURCE edges', `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_SOURCE]->() WHERE nr.source_namespace = '${e(namespace)}' OR nr.target_namespace = '${e(namespace)}' DELETE r`],
    ['NSR_TARGET edges', `MATCH (nr:RIA_UNIV_NamespaceRelation)-[r:RIA_UNIV_NSR_TARGET]->() WHERE nr.source_namespace = '${e(namespace)}' OR nr.target_namespace = '${e(namespace)}' DELETE r`],
    ['NamespaceRelation nodes', `MATCH (nr:RIA_UNIV_NamespaceRelation) WHERE nr.source_namespace = '${e(namespace)}' OR nr.target_namespace = '${e(namespace)}' DELETE nr`],
    ['Namespace node', `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = '${e(namespace)}' DETACH DELETE ns`],
  ];

  const checkpointAfter = new Set([1, 4]); // after RelInstances and ConceptInstances

  for (let i = 0; i < steps.length; i++) {
    const [label, cypher] = steps[i];
    const t1 = Date.now();
    await db.runQuery(cypher);
    process.stdout.write(`  [delete] ${label} (${Date.now() - t1}ms)\n`);
    if (checkpointAfter.has(i)) {
      const tc = Date.now();
      await db.checkpoint();
      process.stdout.write(`  [delete] checkpoint (${Date.now() - tc}ms)\n`);
    }
  }

  await db.checkpoint();
  process.stdout.write(`  [delete] done (${Date.now() - t0}ms total)\n`);
}

export async function createOrReplaceNamespace(
  db: IDbModule,
  params: CreateNamespaceParams,
): Promise<void> {
  if (!params.namespace || params.namespace.trim().length === 0) {
    throw new Error('createOrReplaceNamespace: namespace must be non-empty');
  }
  if (!params.metamodel || params.metamodel.trim().length === 0) {
    throw new Error('createOrReplaceNamespace: metamodel must be non-empty');
  }

  const mmRows = await db.runQuery(
    `MATCH (m:RIA_META_Metamodel) WHERE m.name = $name RETURN count(m) AS cnt`,
    { name: params.metamodel },
  );
  if (Number(mmRows[0]?.cnt ?? 0) === 0) {
    throw new Error(
      `Metamodel '${params.metamodel}' not found. Register it before creating the namespace.`,
    );
  }

  const nsRows = await db.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $ns RETURN count(ns) AS cnt`,
    { ns: params.namespace },
  );
  const exists = Number(nsRows[0]?.cnt ?? 0) > 0;

  if (exists && !params.replaceExisting) {
    throw new Error(`Namespace '${params.namespace}' already exists. Use overwrite: true to replace it.`);
  }

  // Snapshot RIA_UNIV_NamespaceConnection edges before the wipe.
  // replaceNamespace ends with DETACH DELETE on the Namespace node, which
  // implicitly removes all edges attached to it — including NamespaceConnection
  // (imported → authored) and RIA_META_CATEGORIZEDBY (imported → metamodel).
  // We capture these connections so they can be restored after the namespace
  // node is recreated.
  let connectedAuthoredNamespaces: string[] = [];
  if (exists) {
    const connRows = await db.runQuery(
      `MATCH (i:RIA_UNIV_Namespace {name: $ns})-[:RIA_UNIV_NamespaceConnection]->(a:RIA_UNIV_Namespace)
       RETURN a.name AS authoredNamespace`,
      { ns: params.namespace },
    );
    connectedAuthoredNamespaces = connRows
      .map(r => String(r.authoredNamespace ?? ''))
      .filter(n => n.length > 0);
    await replaceNamespace(db, params.namespace);
  }

  await db.runQuery(
    `CREATE (n:RIA_UNIV_Namespace {
      name: '${e(params.namespace)}',
      metamodel: '${e(params.metamodel)}',
      namespace_role: '${e(params.namespaceRole)}',
      namespace_owning_application: '${e(params.namespaceOwningApplication)}',
      content_hash: ''
    })`,
  );

  await db.runQuery(
    `MATCH (n:RIA_UNIV_Namespace), (m:RIA_META_Metamodel)
     WHERE n.name = '${e(params.namespace)}' AND m.name = '${e(params.metamodel)}'
     CREATE (n)-[:RIA_META_DEFINEDBY]->(m)`,
  );

  // Restore RIA_UNIV_NamespaceConnection edges and derived RIA_META_CATEGORIZEDBY
  // edges that were deleted by the DETACH DELETE of the old namespace node.
  for (const authoredNs of connectedAuthoredNamespaces) {
    // Verify the authored namespace still exists (it should, but guard defensively).
    const authoredNsRows = await db.runQuery(
      `MATCH (a:RIA_UNIV_Namespace {name: $ns}) RETURN count(a) AS cnt`,
      { ns: authoredNs },
    );
    if (Number(authoredNsRows[0]?.cnt ?? 0) === 0) continue;

    // Re-create the NamespaceConnection edge (imported → authored).
    await db.runQuery(
      `MATCH (i:RIA_UNIV_Namespace), (a:RIA_UNIV_Namespace)
       WHERE i.name = '${e(params.namespace)}' AND a.name = '${e(authoredNs)}'
       CREATE (i)-[:RIA_UNIV_NamespaceConnection]->(a)`,
    );

    // Re-create the derived RIA_META_CATEGORIZEDBY edge (imported → authored metamodel).
    // Resolve the authored metamodel via RIA_META_DEFINEDBY, falling back to ns.metamodel.
    const mmRows = await db.runQuery(
      `MATCH (a:RIA_UNIV_Namespace {name: $ns})
       OPTIONAL MATCH (a)-[:RIA_META_DEFINEDBY]->(mm:RIA_META_Metamodel)
       RETURN coalesce(mm.name, a.metamodel) AS metamodelName`,
      { ns: authoredNs },
    );
    if (mmRows.length > 0 && mmRows[0].metamodelName) {
      const authoredMm = String(mmRows[0].metamodelName);
      // Idempotent: only create when absent (multiple authored NSes may share the same metamodel).
      const catRows = await db.runQuery(
        `MATCH (i:RIA_UNIV_Namespace {name: $ns})-[:RIA_META_CATEGORIZEDBY]->(mm:RIA_META_Metamodel {name: $mm})
         RETURN count(*) AS cnt`,
        { ns: params.namespace, mm: authoredMm },
      );
      if (Number(catRows[0]?.cnt ?? 0) === 0) {
        await db.runQuery(
          `MATCH (ns:RIA_UNIV_Namespace), (mm:RIA_META_Metamodel)
           WHERE ns.name = '${e(params.namespace)}' AND mm.name = '${e(authoredMm)}'
           CREATE (ns)-[:RIA_META_CATEGORIZEDBY]->(mm)`,
        );
      }
    }
  }
}


// ---------------------------------------------------------------------------
// SourceMaster Upsert
// ---------------------------------------------------------------------------

async function upsertSource(
  db: IDbModule,
  params: BeginSessionParams,
  configData?: ImportConfigData,
): Promise<string> {
  const sourceId = `${params.sourceType}::${params.namespace}`;
  const now = new Date().toISOString();
  const existing = await db.runQuery(
    `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId RETURN s.config AS config`,
    { sourceId },
  );
  const configJson = mergeSourceConfigMeta(existing[0]?.config, {
    configPath: params.configPath,
    configDigest: params.configDigest,
    metamodelPath: params.metamodelPath,
    metamodelDigest: params.metamodelDigest,
    configDirty: true,
  });
  // When preserveStoredConfigData is set and the source already exists,
  // do NOT overwrite config_data — the canonical project_dir (pointing to
  // the real source location, not a temporary checkout) must be preserved.
  const shouldUpdateConfigData = configData !== undefined && !params.preserveStoredConfigData;
  const configDataJson = shouldUpdateConfigData ? JSON.stringify(configData) : undefined;

  if (existing.length > 0) {
    // Update existing source.  Config_data is only updated when not in
    // preserve mode (i.e. not a git-ref branch import with a temp checkout dir).
    const configDataSet = configDataJson ? `, s.config_data = '${e(configDataJson)}'` : '';
    await db.runQuery(
      `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(sourceId)}'
       SET s.importer_version = '${e(params.importerVersion)}',
           s.config = '${e(configJson)}',
           s.updated_at = '${e(now)}'${configDataSet}`,
    );
  } else {
    // Create new source — always write config_data here regardless of
    // preserveStoredConfigData because there is no existing record to preserve.
    const newConfigDataJson = configData ? JSON.stringify(configData) : undefined;
    const configDataProp = newConfigDataJson ? `config_data: '${e(newConfigDataJson)}',` : '';
    await db.runQuery(
      `CREATE (:RIA_SRC_Source {
        source_id: '${e(sourceId)}',
        name: '${e(params.sourceName)}',
        source_type: '${e(params.sourceType)}',
        target_namespace: '${e(params.namespace)}',
        target_metamodel: '${e(params.metamodel)}',
        importer_version: '${e(params.importerVersion)}',
        config: '${e(configJson)}',
        ${configDataProp}
        created_at: '${e(now)}',
        updated_at: '${e(now)}'
      })`,
    );
  }

  // Ensure TARGETS_NS edge exists (idempotent)
  const edgeRows = await db.runQuery(
    `MATCH (s:RIA_SRC_Source)-[:RIA_SRC_TARGETS_NS]->(ns:RIA_UNIV_Namespace)
     WHERE s.source_id = $sourceId RETURN count(*) AS cnt`,
    { sourceId },
  );
  if (Number(edgeRows[0]?.cnt ?? 0) === 0) {
    const nsRows = await db.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $ns RETURN count(ns) AS cnt`,
      { ns: params.namespace },
    );
    if (Number(nsRows[0]?.cnt ?? 0) > 0) {
      await db.runQuery(
        `MATCH (s:RIA_SRC_Source), (ns:RIA_UNIV_Namespace)
         WHERE s.source_id = '${e(sourceId)}' AND ns.name = '${e(params.namespace)}'
         CREATE (s)-[:RIA_SRC_TARGETS_NS]->(ns)`,
      );
    }
  }

  return sourceId;
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Extended write service interface that adds metamodel registration.
 * The base IImportWriteService is the SDK contract; this adds the
 * registration method used by the orchestration layer.
 */
export interface IImportWriteServiceExt extends IImportWriteService {
  /**
   * Register a metamodel from a parsed LinkML schema. Idempotent —
   * skips registration if the metamodel already exists.
   */
  registerMetamodelFromSchema(
    schema: LinkMLSchema,
    metamodelName: string,
  ): Promise<void>;
}

export function createImportWriteService(dbModule: IDbModule): IImportWriteServiceExt {
  return {
    // -----------------------------------------------------------------
    // registerMetamodelFromSchema (extended, not part of SDK interface)
    // -----------------------------------------------------------------
    async registerMetamodelFromSchema(
      schema: LinkMLSchema,
      metamodelName: string,
    ): Promise<void> {
      const mmRows = await dbModule.runQuery(
        `MATCH (m:RIA_META_Metamodel) WHERE m.name = $name RETURN count(m) AS cnt`,
        { name: metamodelName },
      );
      if (Number(mmRows[0]?.cnt ?? 0) > 0) {
        return; // Already registered — idempotent (Req 1.2, 4.5)
      }
      await registerMetamodel(dbModule, schema, metamodelName);
    },

    // -----------------------------------------------------------------
    // beginSession
    // -----------------------------------------------------------------
    async beginSession(params: BeginSessionParams): Promise<ImportSession> {
      // Validate required fields (Req 1.7)
      if (!params.namespace || params.namespace.trim().length === 0) {
        throw new Error('beginSession: namespace must be non-empty');
      }
      if (!params.metamodel || params.metamodel.trim().length === 0) {
        throw new Error('beginSession: metamodel must be non-empty');
      }

      // Step 1: Verify metamodel exists (Req 1.2)
      // The orchestration layer must call registerMetamodelFromSchema() first.
      const mmRows = await dbModule.runQuery(
        `MATCH (m:RIA_META_Metamodel) WHERE m.name = $name RETURN count(m) AS cnt`,
        { name: params.metamodel },
      );
      if (Number(mmRows[0]?.cnt ?? 0) === 0) {
        throw new Error(
          `Metamodel '${params.metamodel}' not found. ` +
          `Register it via registerMetamodelFromSchema() before calling beginSession().`,
        );
      }

      // Step 2: Replace and recreate namespace with explicit lifecycle metadata
      await createOrReplaceNamespace(dbModule, {
        namespace: params.namespace,
        metamodel: params.metamodel,
        namespaceRole: params.namespaceRole,
        namespaceOwningApplication: params.namespaceOwningApplication,
        replaceExisting: true,
      });

      // Step 4: Upsert SourceMaster Source (Req 15.1)
      const sourceId = await upsertSource(dbModule, params, params.configData);

      // Step 5: Create ImportRun record (Req 15.2)
      const runId = crypto.randomUUID();
      const startedAt = new Date().toISOString();

      await dbModule.runQuery(
        `CREATE (:RIA_SRC_ImportRun {
          run_id: '${e(runId)}',
          source_id: '${e(sourceId)}',
          status: 'running',
          started_at: '${e(startedAt)}',
          completed_at: '',
          stats: '',
          triggered_by: '${e(params.triggeredBy)}'
        })`,
      );

      // Step 5b: Snapshot config_data onto the ImportRun node (Req 2.1)
      const srcRows = await dbModule.runQuery(
        `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${e(sourceId)}' RETURN s.config_data AS config_data`,
      );
      const configSnapshot = srcRows[0]?.config_data ? String(srcRows[0].config_data) : '';
      if (configSnapshot) {
        await dbModule.runQuery(
          `MATCH (r:RIA_SRC_ImportRun) WHERE r.run_id = '${e(runId)}'
           SET r.config_snapshot = '${e(configSnapshot)}'`,
        );
      }

      // Link ImportRun → Source
      await dbModule.runQuery(
        `MATCH (r:RIA_SRC_ImportRun), (s:RIA_SRC_Source)
         WHERE r.run_id = '${e(runId)}' AND s.source_id = '${e(sourceId)}'
         CREATE (r)-[:RIA_SRC_RUN_FOR]->(s)`,
      );

      return {
        sessionId: runId,
        runId,
        sourceId,
        namespace: params.namespace,
        metamodel: params.metamodel,
        startedAt,
        triggeredBy: params.triggeredBy,
      };
    },

    // -----------------------------------------------------------------
    // bulkCreateConcepts
    // -----------------------------------------------------------------
    async bulkCreateConcepts(
      session: ImportSession,
      batches: ConceptBatch[],
    ): Promise<NodeIdMap> {
      const nodeIdMap: Map<string, number> = new Map();
      let totalInserted = 0;
      const totalItems = batches.reduce((s, b) => s + b.items.length, 0);
      for (const batch of batches) {
        const items = batch.items;
        for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
          const chunk = items.slice(offset, offset + CHUNK_SIZE);
          const t0 = Date.now();

          const listItems = chunk.map(item => {
            const attrsJson = e(JSON.stringify(item.attributes));
            return `{concept: '${e(batch.concept)}', attributes: '${attrsJson}', stable_path: '${e(item.stablePath)}'}`;
          });

          const rows = await dbModule.runQuery(
            `UNWIND [${listItems.join(', ')}] AS item
             CREATE (ci:RIA_UNIV_ConceptInstance {
               namespace: '${e(session.namespace)}',
               concept: item.concept,
               metamodel: '${e(session.metamodel)}',
               attributes: item.attributes
             })
             RETURN item.stable_path AS stable_path, ci.node_id AS node_id`,
          );

          for (const row of rows) {
            if (row.node_id != null && row.stable_path != null) {
              nodeIdMap.set(String(row.stable_path), Number(row.node_id));
            }
          }
          totalInserted += chunk.length;
          const elapsed = Date.now() - t0;
          process.stdout.write(`\r  [concepts] ${totalInserted}/${totalItems} (${batch.concept} +${chunk.length} in ${elapsed}ms)   `);
        }
      }
      process.stdout.write('\n');
      return nodeIdMap;
    },

    // -----------------------------------------------------------------
    // bulkCreateRelationships
    // -----------------------------------------------------------------
    async bulkCreateRelationships(
      session: ImportSession,
      batches: RelationshipBatch[],
    ): Promise<number> {
      let totalCreated = 0;

      // Build stablePath → node_id map from all ConceptInstances in this namespace.
      const ciRows = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance)
         WHERE ci.namespace = '${e(session.namespace)}'
         RETURN ci.node_id AS node_id, ci.attributes AS attributes`,
      );

      const stablePathMap = new Map<string, number>();
      for (const row of ciRows) {
        try {
          const attrs = JSON.parse(String(row.attributes ?? '{}'));
          if (attrs.stable_path) stablePathMap.set(String(attrs.stable_path), Number(row.node_id));
        } catch { /* skip */ }
      }

      // Sub-batch size for MATCH+CREATE edge step
      // Use larger batches since we pre-filter by node_id IN list
      const EDGE_BATCH_SIZE = 200;

      for (const batch of batches) {
        const resolved = batch.items.flatMap(item => {
          const src = stablePathMap.get(item.sourceStablePath);
          const tgt = stablePathMap.get(item.targetStablePath);
          if (src === undefined || tgt === undefined) return [];
          return [{ src, tgt }];
        });

        if (resolved.length === 0) continue;

        let totalRelInserted = 0;
        for (let offset = 0; offset < resolved.length; offset += CHUNK_SIZE) {
          const chunk = resolved.slice(offset, offset + CHUNK_SIZE);
          const t0 = Date.now();
          const listItems = chunk.map(r => `{src: ${r.src}, tgt: ${r.tgt}}`);

          // Step 1: bulk-create RelationshipInstance nodes
          const createRows = await dbModule.runQuery(
            `UNWIND [${listItems.join(', ')}] AS item
             CREATE (ri:RIA_UNIV_RelationshipInstance {
               namespace: '${e(session.namespace)}',
               relationship: '${e(batch.relationship)}',
               metamodel: '${e(session.metamodel)}',
               source_node_id: item.src,
               target_node_id: item.tgt,
               attributes: '{}'
             })
             RETURN ri.edge_id AS edge_id, item.src AS src, item.tgt AS tgt`,
          );

          // Step 2: create INSTANCE_REL graph edges
          // Match source and target nodes by node_id using UNWIND + MATCH pattern
          // that KuzuDB supports — one MATCH per direction, joined by edge list.
          for (let i = 0; i < createRows.length; i += EDGE_BATCH_SIZE) {
            const edgeBatch = createRows.slice(i, i + EDGE_BATCH_SIZE);
            const edgeItems = edgeBatch.map(r =>
              `{edge_id: ${Number(r.edge_id)}, src: ${Number(r.src)}, tgt: ${Number(r.tgt)}}`,
            );
            await dbModule.runQuery(
              `UNWIND [${edgeItems.join(', ')}] AS item
               MATCH (s:RIA_UNIV_ConceptInstance)
               WHERE s.node_id = item.src
               MATCH (t:RIA_UNIV_ConceptInstance)
               WHERE t.node_id = item.tgt
               CREATE (s)-[:RIA_UNIV_INSTANCE_REL {
                 edge_instance_id: item.edge_id,
                 relationship: '${e(batch.relationship)}',
                 metamodel: '${e(session.metamodel)}'
               }]->(t)`,
            );
          }

          totalCreated += createRows.length;
          totalRelInserted += createRows.length;
          process.stdout.write(`\r  [relationships] ${batch.relationship} +${totalRelInserted} (${Date.now() - t0}ms)   `);
        }
      }
      process.stdout.write('\n');
      return totalCreated;
    },

    // -----------------------------------------------------------------
    // completeSession
    // -----------------------------------------------------------------
    async completeSession(
      session: ImportSession,
      stats: ImportStats,
    ): Promise<void> {
      const completedAt = new Date().toISOString();
      const statsJson = JSON.stringify(stats);

      await dbModule.runQuery(
        `MATCH (r:RIA_SRC_ImportRun) WHERE r.run_id = '${e(session.runId)}'
         SET r.status = 'completed',
             r.completed_at = '${e(completedAt)}',
             r.stats = '${e(statsJson)}'`,
      );

      await updateSourceConfigMeta(dbModule, session.sourceId, {
        configDirty: false,
        lastAppliedAt: completedAt,
      });

      // Checkpoint DB (Req 1.5)
      await dbModule.checkpoint();
    },

    // -----------------------------------------------------------------
    // abortSession
    // -----------------------------------------------------------------
    async abortSession(
      session: ImportSession,
      error: string,
    ): Promise<void> {
      const completedAt = new Date().toISOString();

      await dbModule.runQuery(
        `MATCH (r:RIA_SRC_ImportRun) WHERE r.run_id = '${e(session.runId)}'
         SET r.status = 'failed',
             r.completed_at = '${e(completedAt)}',
             r.stats = '${e(JSON.stringify({ error: error }))}'`,
      );

      await updateSourceConfigMeta(dbModule, session.sourceId, {
        configDirty: true,
      });

      // Checkpoint to ensure the failed-run record is durably written and
      // the DB is in a consistent state for subsequent queries.
      try {
        await dbModule.checkpoint();
      } catch {
        // Best-effort — a checkpoint failure here is non-fatal; the run
        // is already marked failed in the write-ahead log.
      }
    },
  };
}
