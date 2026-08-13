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
 * Persistor load() — imports data back from git-friendly JSON files
 * in `{workingDir}/ria-data/` into the graph database.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IDbModule } from '../db/db-module.js';
import type { ImportLogger } from '../infra/logger.js';
import { parseTable } from './serializer.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { getTablesByLayer } from './table-registry.js';
import { resolveStableIdFromMeta, buildStableIdLookupFromMeta } from './stable-id.js';
import type { PersistorLoadParams, LoadResult, Manifest } from './persistor-types.js';
import { LOAD_BATCH_SIZE } from './persistor-types.js';
import {
  e,
  sqlVal,
  emitProgress,
  batchInsertNodes,
  createInstanceRelEdges,
  createCrossNsInstanceRelEdges,
  loadSharedNodeTable,
  loadAttributeMetadata,
  buildSharedLayerClearStatements,
  buildSharedEdgeImportSpecs,
  deleteNamespace,
} from './persistor-helpers.js';
import { computeNamespaceHashFromFiles, computeMetaHash } from './persistor.js';
import { computeUniverseFileHash } from './persistor-store.js';

export async function load(
  params: PersistorLoadParams,
  dbModule: IDbModule,
  logger: ImportLogger,
): Promise<LoadResult> {
  const loadStart = Date.now();
  const exportDir = path.join(params.workingDir, 'ria-data');

  const manifestPath = path.join(exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('No export found: manifest.json is missing');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch: manifest schema_version (${manifest.schema_version}) differs from current (${SCHEMA_VERSION})`,
    );
  }

  // Verify meta_hash if present. A mismatch means the meta layer files on disk
  // differ from what was last stored — either the metamodel YAML changed (a
  // legitimate code update) or the files were manually edited. Either way the
  // load proceeds: the meta layer is always re-imported unconditionally, and the
  // post-load wiring step repairs any missing DEFINEDBY/CATEGORIZEDBY edges.
  // This is a warning, not an error, because meta changes from YAML updates are
  // expected and should not block workspace open.
  if (manifest.meta_hash) {
    const metaDir = path.join(exportDir, 'meta');
    const diskMetaHash = computeMetaHash(metaDir);
    if (diskMetaHash !== manifest.meta_hash) {
      logger.warn(
        `meta layer hash mismatch — meta files on disk differ from last store` +
        ` (manifest=${manifest.meta_hash.slice(0, 20)}... disk=${diskMetaHash.slice(0, 20)}...)` +
        ` — proceeding with load; ensureNamespaceWiring() on workspace open will repair any missing edges`,
        { manifest_meta_hash: manifest.meta_hash, disk_meta_hash: diskMetaHash },
      );
    } else {
      logger.debug(`meta layer hash verified (${manifest.meta_hash.slice(0, 20)}...)`);
    }
  }

  // Verify each recorded Universe_Hash before importing any data. Unlike the
  // meta layer (which is always re-imported, so a mismatch is a warning), the
  // universe-layer files carry the durable canvas layout and namespace
  // connections. A mismatch or a missing/unreadable file means the on-disk data
  // is corrupt or was edited behind the app, so we abort the load — reusing the
  // exact `"file integrity check failed"` convention that the namespace-layer
  // check below uses. This lights up `useWorkspaceState.filesCorrupted` and the
  // `BottomPanel` repair-hash flow unchanged (Req 6.3, 6.4, 6.5). On-disk
  // contents are left untouched: we only read and compare, never write.
  if (manifest.universe_hashes) {
    for (const [relPath, recordedHash] of Object.entries(manifest.universe_hashes)) {
      if (!recordedHash) continue;
      const universeFilePath = path.join(exportDir, relPath);

      let diskContent: string;
      try {
        if (!fs.existsSync(universeFilePath)) {
          throw new Error('file not found');
        }
        diskContent = fs.readFileSync(universeFilePath, 'utf-8');
      } catch (err) {
        logger.error(
          `Universe file '${relPath}': file integrity check failed — ` +
          `recorded in manifest but absent or unreadable on disk` +
          ` (${err instanceof Error ? err.message : String(err)})`,
          { universe_file: relPath, manifest_hash: recordedHash },
        );
        throw new Error(
          `Universe file '${relPath}': file integrity check failed. ` +
          `The file is recorded in the manifest (hash: ${recordedHash}) but is ` +
          `absent or unreadable on disk. ` +
          `If you trust the workspace, regenerate manifest.json via repairManifest.`
        );
      }

      const diskHash = computeUniverseFileHash(diskContent);
      if (diskHash !== recordedHash) {
        logger.error(
          `Universe file '${relPath}': file integrity check failed — ` +
          `manifest=${recordedHash.slice(0, 20)}... disk=${diskHash.slice(0, 20)}...`,
          { universe_file: relPath, manifest_hash: recordedHash, disk_hash: diskHash },
        );
        throw new Error(
          `Universe file '${relPath}': file integrity check failed. ` +
          `Manifest hash: ${recordedHash}, computed from file: ${diskHash}. ` +
          `The universe-layer file may be corrupted or manually edited. ` +
          `If you trust the file, regenerate manifest.json via repairManifest.`
        );
      }
      logger.debug(`universe file integrity check passed`, { universe_file: relPath, hash: recordedHash });
    }
  }

  logger.info(`load started — ${manifest.namespaces.length} namespace(s) in manifest`);

  // Query existing namespace content_hashes from DB
  const existingHashRows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace) RETURN ns.name AS name, ns.content_hash AS content_hash`
  );
  const existingHashes = new Map<string, string>();
  for (const row of existingHashRows) {
    existingHashes.set(String(row.name ?? ''), String(row.content_hash ?? ''));
  }

  // Warn about DB namespaces not in manifest
  for (const [dbNs] of existingHashes) {
    if (!manifest.namespaces.find(n => n.name === dbNs)) {
      logger.warn(`namespace '${dbNs}' exists in DB but is not listed in the manifest — skipped`);
    }
  }

  const namespacesImported: string[] = [];
  const namespacesSkipped: string[] = [];
  let totalRecordsImported = 0;
  let totalRelationshipsFailed = 0;

  // Shared layers are always cleared and re-imported unconditionally, even when
  // individual namespaces are delta-skipped. These layers contain metamodel
  // definitions and source-tracking data that may have changed independently of
  // any single namespace (e.g. a new metamodel version or import-source edit).
  // Re-importing them is cheap and avoids stale-metadata bugs.
  //
  // The clear statements are derived from the canonical schema (schema.ts) via
  // the table registry so that adding a new meta/sourcemaster/cross_namespace
  // table automatically includes it here — no manual update needed.
  logger.debug(`clearing meta/sourcemaster/cross_namespace layers...`);
  emitProgress(params.onProgress, { phase: 'shared', message: 'Clearing shared layers...' }, logger);
  for (const stmt of buildSharedLayerClearStatements()) {
    await dbModule.runQuery(stmt);
  }

  // Import meta layer — node tables (batched UNWIND inserts)
  const sharedNodeTables = [...getTablesByLayer('meta'), ...getTablesByLayer('sourcemaster')]
    .filter((table) => table.type === 'node');
  const sharedTotal = sharedNodeTables.length;
  let sharedIdx = 0;
  for (const table of sharedNodeTables) {
    const layerDir = table.layer === 'meta' ? 'meta' : 'sourcemaster';
    const filePath = path.join(exportDir, layerDir, `${table.name}.json`);
    const importedRows = await loadSharedNodeTable(table, filePath, dbModule);
    totalRecordsImported += importedRows;
    logger.debug(`shared layer: imported ${table.name} — ${importedRows} records`);
    sharedIdx++;
    emitProgress(params.onProgress, { phase: 'shared', message: `${table.name} — ${importedRows} records`, current: sharedIdx, total: sharedTotal }, logger);
  }

  // Meta + sourcemaster edge tables — derived from the table registry so that
  // adding a new rel table to schema.ts + table-registry automatically includes
  // it here. Edges that reference RIA_UNIV_Namespace are deferred until after
  // the namespace loop (those nodes don't exist yet at this point).
  const { immediate: immediateEdgeSpecs, deferred: deferredEdgeSpecs } =
    buildSharedEdgeImportSpecs(['meta', 'sourcemaster']);

  for (const edge of immediateEdgeSpecs) {
    const filePath = path.join(exportDir, edge.file);
    if (!fs.existsSync(filePath)) continue;
    const rows = parseTable(fs.readFileSync(filePath, 'utf-8'));
    if (rows.length === 0) continue;
    const pairs = rows.map(row => ({ src: row[`src_${edge.srcPk}`] ?? null, dst: row[`dst_${edge.dstPk}`] ?? null }));
    for (let i = 0; i < pairs.length; i += LOAD_BATCH_SIZE) {
      const batch = pairs.slice(i, i + LOAD_BATCH_SIZE);
      await dbModule.runQuery(
        `UNWIND $rows AS pair MATCH (s:${edge.srcTable}), (d:${edge.dstTable}) WHERE s.${edge.srcPk} = pair.src AND d.${edge.dstPk} = pair.dst CREATE (s)-[:${edge.rel}]->(d)`,
        { rows: batch }
      );
    }
    logger.debug(`shared layer: imported ${edge.rel} — ${rows.length} edges`);
  }

  // Load attribute metadata from the freshly-imported meta layer.
  // Must happen AFTER the meta node/edge tables are imported above so that
  // RIA_META_NodeAttribute rows are present in the DB. The key-attr maps drive
  // stable-id resolution for every namespace, so stale metadata here would
  // silently produce wrong node lookups during relationship import.
  const { nodeKeyAttrs } = await loadAttributeMetadata(dbModule);

  // Helper: fire-and-forget namespace-level progress push event.
  // Errors in the callback are silently swallowed so they can never cause
  // the load operation to fail (Requirement 16.9).
  const emitNamespaceProgress = (kind: 'namespace_start' | 'namespace_done', namespaceName: string, namespaceIndex: number): void => {
    if (!params.onNamespaceProgress) return;
    try {
      params.onNamespaceProgress({
        kind,
        namespaceName,
        namespaceIndex,
        totalNamespaces: manifest.namespaces.length,
      });
    } catch {
      // swallow — progress events are fire-and-forget
    }
  };

  // Namespace loop
  for (let nsIdx = 0; nsIdx < manifest.namespaces.length; nsIdx++) {
    const nsEntry = manifest.namespaces[nsIdx];
    const namespace = nsEntry.name;
    const metamodel = nsEntry.metamodel;
    const manifestHash = manifest.namespace_hashes[namespace] ?? '';
    const nsDir = path.join(exportDir, (nsEntry as { directory?: string }).directory ?? namespace);

    // Emit namespace_start before processing (1-based index)
    emitNamespaceProgress('namespace_start', namespace, nsIdx + 1);

    emitProgress(params.onProgress, { phase: 'namespace', message: `${namespace} (${nsIdx + 1}/${manifest.namespaces.length})`, current: nsIdx + 1, total: manifest.namespaces.length }, logger);

    // Delta skip — compare the DB's stored content_hash against the manifest hash.
    // If they match, the DB already holds the same data as the JSON files, so
    // re-importing would be a no-op. The instance-service invalidates the stored
    // hash (sets it to '') on every write mutation (create/update/delete), so a
    // match here guarantees no unsaved in-DB edits exist. This makes load()
    // act as "undo to last store" when the user has modified data in the DB.
    const existingHash = existingHashes.get(namespace) ?? '';
    if (manifestHash && existingHash === manifestHash) {
      logger.debug(`skip ${namespace}: hash match (${manifestHash.slice(0, 20)}...)`);
      namespacesSkipped.push(namespace);
      continue;
    }

    if (!existingHash) {
      logger.info(`import ${namespace}: new namespace`, { hash: manifestHash });
    } else if (existingHash === '') {
      logger.info(`import ${namespace}: hash empty (write-invalidated)`, { namespace });
    } else {
      logger.info(`import ${namespace}: hash mismatch`, { manifest_hash: manifestHash, db_hash: existingHash });
    }

    // File integrity check runs AFTER the delta-skip decision. Skipped namespaces
    // don't need verification (the DB is already authoritative). For namespaces
    // that will be re-imported, we verify the on-disk JSON hasn't been corrupted
    // or hand-edited since the last store, before we delete existing DB data.
    if (manifestHash) {
      // Collect per-section hash lines on the first (and only) pass.
      // We emit them only on mismatch, so the happy-path log stays clean.
      const sectionLines: string[] = [];
      const diskHash = computeNamespaceHashFromFiles(
        namespace, nsDir, exportDir,
        (msg) => sectionLines.push(msg),
      );
      if (diskHash !== manifestHash) {
        // Log the summary at ERROR level so it's immediately visible.
        logger.error(
          `Namespace '${namespace}': file integrity check failed — ` +
          `manifest=${manifestHash.slice(0, 20)}... disk=${diskHash.slice(0, 20)}...`,
          { namespace, manifest_hash: manifestHash, disk_hash: diskHash },
        );
        // Emit each per-section hash line so the log immediately shows which
        // section (concepts / relationships / cross-ns) caused the difference
        // without needing to re-run or cross-reference a separate store log.
        for (const line of sectionLines) {
          logger.error(`  [integrity/section] ${line}`, { namespace });
        }
        throw new Error(
          `Namespace '${namespace}': file integrity check failed. ` +
          `Manifest hash: ${manifestHash}, computed from files: ${diskHash}. ` +
          `The exported JSON files may be corrupted or manually edited. ` +
          `If you trust the files, regenerate manifest.json via repairManifest.`
        );
      }
      logger.debug(`integrity check passed`, { namespace, hash: manifestHash });
    }

    // Delete existing namespace data (silently skip if not found)
    // Wrap delete + concept inserts + relationship inserts in a transaction if supported
    if (dbModule.beginTransaction) {
      const tx = await dbModule.beginTransaction();
      try {
        await deleteNamespace(namespace, dbModule, tx);

        const namespaceMetadataPath = path.join(nsDir, 'namespace.json');
        let namespaceRole = (nsEntry as { namespace_role?: string }).namespace_role ?? '';
        let namespaceOwningApplication = (nsEntry as { namespace_owning_application?: string }).namespace_owning_application ?? '';
        if (fs.existsSync(namespaceMetadataPath)) {
          const nsMeta = JSON.parse(fs.readFileSync(namespaceMetadataPath, 'utf-8')) as {
            namespace_role?: unknown;
            namespace_owning_application?: unknown;
          };
          if (typeof nsMeta.namespace_role === 'string') namespaceRole = nsMeta.namespace_role;
          if (typeof nsMeta.namespace_owning_application === 'string') namespaceOwningApplication = nsMeta.namespace_owning_application;
        }

        // Create namespace node
        await tx.runQuery(
          `CREATE (:RIA_UNIV_Namespace {
            name: '${e(namespace)}',
            metamodel: '${e(metamodel)}',
            namespace_role: '${e(namespaceRole)}',
            namespace_owning_application: '${e(namespaceOwningApplication)}',
            content_hash: '${e(manifestHash)}'
          })`
        );

        // Insert concept instances
        const conceptsDir = path.join(nsDir, 'concepts');
        if (fs.existsSync(conceptsDir)) {
          const conceptFiles = fs.readdirSync(conceptsDir).filter(f => f.endsWith('.json'));
          emitProgress(params.onProgress, { phase: 'concepts', message: `${namespace}: importing ${conceptFiles.length} concept type(s)...`, current: 0, total: conceptFiles.length }, logger);
          for (let conceptIdx = 0; conceptIdx < conceptFiles.length; conceptIdx++) {
            const file = conceptFiles[conceptIdx];
            const concept = file.replace('.json', '');
            const records = parseTable(fs.readFileSync(path.join(conceptsDir, file), 'utf-8'));
            const conceptRows = records.map(r => ({
              namespace: namespace,
              concept: concept,
              metamodel: metamodel,
              attributes: JSON.stringify(r.attributes ?? {}),
            }));
            await batchInsertNodes(
              `UNWIND $rows AS row
CREATE (:RIA_UNIV_ConceptInstance {
  namespace:  row.namespace,
  concept:    row.concept,
  metamodel:  row.metamodel,
  attributes: row.attributes
})`,
              conceptRows,
              dbModule,
              tx
            );
            totalRecordsImported += records.length;
            logger.debug(`${namespace} concepts/${file} — ${records.length} records`, { namespace, concept, records: records.length });
            emitProgress(params.onProgress, { phase: 'concepts', message: `${namespace}: ${concept} — ${records.length} records`, current: conceptIdx + 1, total: conceptFiles.length }, logger);
          }
        }

        // Build stable-id → node_id lookup (query within the transaction)
        const insertedConcepts = await tx.runQuery(
          `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
           RETURN ci.node_id AS node_id, ci.concept AS concept, ci.attributes AS attributes`,
          { namespace }
        );
        const stableIdToNodeId = buildStableIdLookupFromMeta(
          insertedConcepts as Array<{ node_id: unknown; concept: unknown; attributes: unknown }>,
          nodeKeyAttrs,
        );

        // Guard: if concepts were inserted but the stable-id map is empty, the
        // meta layer (nodeKeyAttrs) is missing identity-attribute declarations for
        // this metamodel. Relationship loading would silently drop every edge, so
        // fail fast here with a clear error rather than producing a flat namespace.
        if (insertedConcepts.length > 0 && stableIdToNodeId.size === 0) {
          throw new Error(
            `Namespace '${namespace}': stable-id lookup is empty after inserting ` +
            `${insertedConcepts.length} concept(s). The meta layer may be missing ` +
            `'is_identity = true' attribute declarations for metamodel '${metamodel}'. ` +
            `All relationship edges would be silently dropped — aborting load.`
          );
        }

        // Insert relationship instances
        const relationshipsDir = path.join(nsDir, 'relationships');
        if (fs.existsSync(relationshipsDir)) {
          const relFiles = fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'));
          emitProgress(params.onProgress, { phase: 'relationships', message: `${namespace}: importing ${relFiles.length} relationship type(s)...`, current: 0, total: relFiles.length }, logger);
          for (let relIdx = 0; relIdx < relFiles.length; relIdx++) {
            const file = relFiles[relIdx];
            const relType = file.replace('.json', '');
            const records = parseTable(fs.readFileSync(path.join(relationshipsDir, file), 'utf-8'));
            let failCount = 0;
            const relRows: Record<string, unknown>[] = [];
            for (const record of records) {
              const sourceNodeId = stableIdToNodeId.get(String(record.source_stable_id ?? ''));
              const targetNodeId = stableIdToNodeId.get(String(record.target_stable_id ?? ''));
              if (sourceNodeId === undefined || targetNodeId === undefined) {
                failCount++;
                const unresolvable = sourceNodeId === undefined ? record.source_stable_id : record.target_stable_id;
                logger.warn(`${namespace}/${relType}: cannot resolve stable_id '${String(unresolvable ?? '')}' — ${failCount} failure(s) in this file`);
                continue;
              }
              const recordRelType = String(record.relationship ?? relType);
              const attrsStr = JSON.stringify(record.attributes ?? {});
              relRows.push({
                namespace: namespace,
                relationship: recordRelType,
                metamodel: metamodel,
                source_node_id: sourceNodeId,
                target_node_id: targetNodeId,
                attributes: attrsStr,
              });
            }
            // If every edge in this file failed to resolve, the stable-id map is
            // likely broken (e.g. meta layer mismatch). Fail fast rather than
            // silently producing a namespace with concepts but no relationships.
            if (failCount > 0 && relRows.length === 0 && records.length > 0) {
              throw new Error(
                `Namespace '${namespace}': all ${records.length} edge(s) in '${relType}' ` +
                `failed stable-id resolution — no edges were loaded. ` +
                `This usually means the meta layer identity attributes do not match ` +
                `the concept types in this namespace.`
              );
            }
            if (failCount > 0) {
              logger.error(
                `${namespace}/${relType}: ${failCount}/${records.length} edge(s) could not be resolved — ` +
                `these relationships are missing from the DB`,
                { namespace, relType, failCount, total: records.length }
              );
              totalRelationshipsFailed += failCount;
            }
            await batchInsertNodes(
              `UNWIND $rows AS row
CREATE (:RIA_UNIV_RelationshipInstance {
  namespace:        row.namespace,
  relationship:     row.relationship,
  metamodel:        row.metamodel,
  source_node_id:   row.source_node_id,
  target_node_id:   row.target_node_id,
  attributes:       row.attributes
})`,
              relRows,
              dbModule,
              tx
            );
            // Bulk-fetch all edge_ids for this relType in one query instead of issuing
            // one query per relationship row (N+1 problem). edge_ids are assigned on
            // CREATE, so we must read them back to wire up the graph-level INSTANCE_REL edges.
            const allEdgeIdRowsTx = await (tx ?? dbModule).runQuery(
              `MATCH (ri:RIA_UNIV_RelationshipInstance)
               WHERE ri.namespace = '${e(namespace)}' AND ri.relationship = '${e(relType)}'
               RETURN ri.source_node_id AS source_node_id, ri.target_node_id AS target_node_id, ri.edge_id AS edge_id`
            );
            const edgeIdMapTx = new Map<string, number>();
            for (const r of allEdgeIdRowsTx) {
              const key = `${r.source_node_id}:${r.target_node_id}`;
              if (!edgeIdMapTx.has(key)) edgeIdMapTx.set(key, Number(r.edge_id));
            }
            const edgeRelRows: Array<{ source_node_id: number; target_node_id: number; edge_id: number; relationship: string; metamodel: string }> = [];
            for (const relRow of relRows) {
              const key = `${relRow.source_node_id}:${relRow.target_node_id}`;
              const edgeId = edgeIdMapTx.get(key);
              if (edgeId !== undefined) {
                edgeRelRows.push({
                  source_node_id: Number(relRow.source_node_id),
                  target_node_id: Number(relRow.target_node_id),
                  edge_id: edgeId,
                  relationship: String(relRow.relationship ?? ''),
                  metamodel: String(relRow.metamodel ?? ''),
                });
              }
            }
            await createInstanceRelEdges(edgeRelRows, tx ?? dbModule);
            totalRecordsImported += relRows.length;
            logger.debug(`${namespace} relationships/${file} — ${relRows.length} records`, { namespace, relType, records: relRows.length });
            emitProgress(params.onProgress, { phase: 'relationships', message: `${namespace}: ${relType} — ${relRows.length} records`, current: relIdx + 1, total: relFiles.length }, logger);
          }
        }

        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    } else {
      // Fallback: non-transactional path (backward compatibility)
      try {
        await deleteNamespace(namespace, dbModule);
      } catch { /* namespace may not exist yet */ }

      const namespaceMetadataPath = path.join(nsDir, 'namespace.json');
      let namespaceRole = (nsEntry as { namespace_role?: string }).namespace_role ?? '';
      let namespaceOwningApplication = (nsEntry as { namespace_owning_application?: string }).namespace_owning_application ?? '';
      if (fs.existsSync(namespaceMetadataPath)) {
        const nsMeta = JSON.parse(fs.readFileSync(namespaceMetadataPath, 'utf-8')) as {
          namespace_role?: unknown;
          namespace_owning_application?: unknown;
        };
        if (typeof nsMeta.namespace_role === 'string') namespaceRole = nsMeta.namespace_role;
        if (typeof nsMeta.namespace_owning_application === 'string') namespaceOwningApplication = nsMeta.namespace_owning_application;
      }

      // Create namespace node
      await dbModule.runQuery(
        `CREATE (:RIA_UNIV_Namespace {
          name: '${e(namespace)}',
          metamodel: '${e(metamodel)}',
          namespace_role: '${e(namespaceRole)}',
          namespace_owning_application: '${e(namespaceOwningApplication)}',
          content_hash: '${e(manifestHash)}'
        })`
      );

      // Insert concept instances
      const conceptsDir = path.join(nsDir, 'concepts');
      if (fs.existsSync(conceptsDir)) {
        const conceptFiles = fs.readdirSync(conceptsDir).filter(f => f.endsWith('.json'));
        emitProgress(params.onProgress, { phase: 'concepts', message: `${namespace}: importing ${conceptFiles.length} concept type(s)...`, current: 0, total: conceptFiles.length }, logger);
        for (let conceptIdx = 0; conceptIdx < conceptFiles.length; conceptIdx++) {
          const file = conceptFiles[conceptIdx];
          const concept = file.replace('.json', '');
          const records = parseTable(fs.readFileSync(path.join(conceptsDir, file), 'utf-8'));
          const conceptRows = records.map(r => ({
            namespace: namespace,
            concept: concept,
            metamodel: metamodel,
            attributes: JSON.stringify(r.attributes ?? {}),
          }));
          await batchInsertNodes(
            `UNWIND $rows AS row
CREATE (:RIA_UNIV_ConceptInstance {
  namespace:  row.namespace,
  concept:    row.concept,
  metamodel:  row.metamodel,
  attributes: row.attributes
})`,
            conceptRows,
            dbModule
          );
          totalRecordsImported += records.length;
          logger.debug(`${namespace} concepts/${file} — ${records.length} records`, { namespace, concept, records: records.length });
          emitProgress(params.onProgress, { phase: 'concepts', message: `${namespace}: ${concept} — ${records.length} records`, current: conceptIdx + 1, total: conceptFiles.length }, logger);
        }
      }

      // Build stable-id → node_id lookup
      const insertedConcepts = await dbModule.runQuery(
        `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
         RETURN ci.node_id AS node_id, ci.concept AS concept, ci.attributes AS attributes`,
        { namespace }
      );
      const stableIdToNodeId = buildStableIdLookupFromMeta(
        insertedConcepts as Array<{ node_id: unknown; concept: unknown; attributes: unknown }>,
        nodeKeyAttrs,
      );

      // Guard: if concepts were inserted but the stable-id map is empty, the
      // meta layer (nodeKeyAttrs) is missing identity-attribute declarations for
      // this metamodel. Relationship loading would silently drop every edge, so
      // fail fast here with a clear error rather than producing a flat namespace.
      if (insertedConcepts.length > 0 && stableIdToNodeId.size === 0) {
        throw new Error(
          `Namespace '${namespace}': stable-id lookup is empty after inserting ` +
          `${insertedConcepts.length} concept(s). The meta layer may be missing ` +
          `'is_identity = true' attribute declarations for metamodel '${metamodel}'. ` +
          `All relationship edges would be silently dropped — aborting load.`
        );
      }

      // Insert relationship instances
      const relationshipsDir = path.join(nsDir, 'relationships');
      if (fs.existsSync(relationshipsDir)) {
        const relFiles = fs.readdirSync(relationshipsDir).filter(f => f.endsWith('.json'));
        emitProgress(params.onProgress, { phase: 'relationships', message: `${namespace}: importing ${relFiles.length} relationship type(s)...`, current: 0, total: relFiles.length }, logger);
        for (let relIdx = 0; relIdx < relFiles.length; relIdx++) {
          const file = relFiles[relIdx];
          const relType = file.replace('.json', '');
          const records = parseTable(fs.readFileSync(path.join(relationshipsDir, file), 'utf-8'));
          let failCount = 0;
          const relRows: Record<string, unknown>[] = [];
          for (const record of records) {
            const sourceNodeId = stableIdToNodeId.get(String(record.source_stable_id ?? ''));
            const targetNodeId = stableIdToNodeId.get(String(record.target_stable_id ?? ''));
            if (sourceNodeId === undefined || targetNodeId === undefined) {
              failCount++;
              const unresolvable = sourceNodeId === undefined ? record.source_stable_id : record.target_stable_id;
              logger.warn(`${namespace}/${relType}: cannot resolve stable_id '${String(unresolvable ?? '')}' — ${failCount} failure(s) in this file`);
              continue;
            }
            const recordRelType = String(record.relationship ?? relType);
            const attrsStr = JSON.stringify(record.attributes ?? {});
            relRows.push({
              namespace: namespace,
              relationship: recordRelType,
              metamodel: metamodel,
              source_node_id: sourceNodeId,
              target_node_id: targetNodeId,
              attributes: attrsStr,
            });
          }
          // If every edge in this file failed to resolve, the stable-id map is
          // likely broken (e.g. meta layer mismatch). Fail fast rather than
          // silently producing a namespace with concepts but no relationships.
          if (failCount > 0 && relRows.length === 0 && records.length > 0) {
            throw new Error(
              `Namespace '${namespace}': all ${records.length} edge(s) in '${relType}' ` +
              `failed stable-id resolution — no edges were loaded. ` +
              `This usually means the meta layer identity attributes do not match ` +
              `the concept types in this namespace.`
            );
          }
          if (failCount > 0) {
            logger.error(
              `${namespace}/${relType}: ${failCount}/${records.length} edge(s) could not be resolved — ` +
              `these relationships are missing from the DB`,
              { namespace, relType, failCount, total: records.length }
            );
            totalRelationshipsFailed += failCount;
          }
          await batchInsertNodes(
            `UNWIND $rows AS row
CREATE (:RIA_UNIV_RelationshipInstance {
  namespace:        row.namespace,
  relationship:     row.relationship,
  metamodel:        row.metamodel,
  source_node_id:   row.source_node_id,
  target_node_id:   row.target_node_id,
  attributes:       row.attributes
})`,
            relRows,
            dbModule
          );
          // Bulk-fetch all edge_ids for this relType in one query instead of issuing
          // one query per relationship row (N+1 problem). edge_ids are assigned on
          // CREATE, so we must read them back to wire up the graph-level INSTANCE_REL edges.
          const allEdgeIdRows = await dbModule.runQuery(
            `MATCH (ri:RIA_UNIV_RelationshipInstance)
             WHERE ri.namespace = '${e(namespace)}' AND ri.relationship = '${e(relType)}'
             RETURN ri.source_node_id AS source_node_id, ri.target_node_id AS target_node_id, ri.edge_id AS edge_id`
          );
          const edgeIdMap = new Map<string, number>();
          for (const r of allEdgeIdRows) {
            const key = `${r.source_node_id}:${r.target_node_id}`;
            if (!edgeIdMap.has(key)) edgeIdMap.set(key, Number(r.edge_id));
          }
          const edgeRelRows: Array<{ source_node_id: number; target_node_id: number; edge_id: number; relationship: string; metamodel: string }> = [];
          for (const relRow of relRows) {
            const key = `${relRow.source_node_id}:${relRow.target_node_id}`;
            const edgeId = edgeIdMap.get(key);
            if (edgeId !== undefined) {
              edgeRelRows.push({
                source_node_id: Number(relRow.source_node_id),
                target_node_id: Number(relRow.target_node_id),
                edge_id: edgeId,
                relationship: String(relRow.relationship ?? ''),
                metamodel: String(relRow.metamodel ?? ''),
              });
            }
          }
          await createInstanceRelEdges(edgeRelRows, dbModule);
          totalRecordsImported += relRows.length;
          logger.debug(`${namespace} relationships/${file} — ${relRows.length} records`, { namespace, relType, records: relRows.length });
          emitProgress(params.onProgress, { phase: 'relationships', message: `${namespace}: ${relType} — ${relRows.length} records`, current: relIdx + 1, total: relFiles.length }, logger);
        }
      }
    }

    namespacesImported.push(namespace);
    // Emit namespace_done after successful import (1-based index)
    emitNamespaceProgress('namespace_done', namespace, nsIdx + 1);
  }

  // Cross-namespace resolution must happen AFTER all namespaces are processed,
  // because a cross-ns edge can reference a target node in any namespace —
  // including one that was just imported in this load() run. Building the
  // stable-id map here guarantees every namespace's concept nodes are present.
  const allNamespaces = [...namespacesImported, ...namespacesSkipped];
  // Stable paths are only unique inside a namespace. Authored analysis
  // namespaces can contain reference copies with the same stable_path as the
  // native imported node, so a global stableId-only map can silently bind a
  // cross-namespace edge to the wrong copy after load.
  const crossNsStableIdMap = new Map<string, number>(); // namespace + stableId → nodeId
  for (const ns of allNamespaces) {
    const ciRows = await dbModule.runQuery(
      `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $ns
       RETURN ci.node_id AS node_id, ci.concept AS concept, ci.attributes AS attributes`,
      { ns }
    );
    for (const row of ciRows) {
      // createCrossNsRelationship always stores stable_path as the external ID
      // for both source and target nodes. Use stable_path as the primary key here
      // so load resolution matches exactly what was stored — no secondary fallback needed.
      try {
        const attrs = JSON.parse(String(row.attributes ?? '{}')) as Record<string, unknown>;
        if (typeof attrs.stable_path === 'string' && attrs.stable_path) {
          crossNsStableIdMap.set(`${ns}\u0000${attrs.stable_path}`, Number(row.node_id));
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // Deferred edges: these rel tables reference RIA_UNIV_Namespace as an endpoint.
  // Namespace nodes are created inside the per-namespace loop above, so they
  // don't exist yet when the shared layers are imported. The deferred list is
  // derived from the table registry (any rel with fromTable/toTable =
  // RIA_UNIV_Namespace), so adding a new namespace-dependent rel table to
  // schema.ts + table-registry automatically includes it here.
  for (const edge of deferredEdgeSpecs) {
    const filePath = path.join(exportDir, edge.file);
    if (!fs.existsSync(filePath)) continue;
    const rows = parseTable(fs.readFileSync(filePath, 'utf-8'));
    for (const row of rows) {
      await dbModule.runQuery(
        `MATCH (s:${edge.srcTable}), (d:${edge.dstTable}) WHERE s.${edge.srcPk} = ${sqlVal(row[`src_${edge.srcPk}`])} AND d.${edge.dstPk} = ${sqlVal(row[`dst_${edge.dstPk}`])} CREATE (s)-[:${edge.rel}]->(d)`
      );
    }
    logger.debug(`shared layer: imported ${edge.rel} — ${rows.length} edges`);
  }

  // ── Restore per-pair namespace connections (RIA_UNIV_NamespaceConnection) ──
  // These universe-layer edges are keyed by namespace name and reference
  // RIA_UNIV_Namespace nodes on both ends, so they are restored here — after the
  // namespace loop has (re)created every namespace node. Only connections whose
  // BOTH endpoints are present in the loaded workspace are restored; a connection
  // that references an absent namespace (dangling reference) is the only one
  // omitted, and an error is surfaced identifying it (Requirement 8.5).
  const connectionsSkipped: { source: string; target: string }[] = [];
  const connFilePath = path.join(exportDir, 'universe', 'RIA_UNIV_NamespaceConnection.json');
  if (fs.existsSync(connFilePath)) {
    // Clear any existing per-pair edges so the loaded set equals the persisted
    // set exactly — zero connections added, zero removed for present endpoints
    // (Requirement 8.2).
    await dbModule.runQuery(`MATCH ()-[r:RIA_UNIV_NamespaceConnection]->() DELETE r`);

    const connRows = parseTable(fs.readFileSync(connFilePath, 'utf-8'));
    const presentNsRows = await dbModule.runQuery(
      `MATCH (ns:RIA_UNIV_Namespace) RETURN ns.name AS name`
    );
    const presentNamespaces = new Set(presentNsRows.map(r => String(r.name ?? '')));

    let connectionsRestored = 0;
    for (const row of connRows) {
      const source = String(row.src_name ?? '');
      const target = String(row.dst_name ?? '');
      if (!source || !target) continue;
      const sourceMissing = !presentNamespaces.has(source);
      const targetMissing = !presentNamespaces.has(target);
      if (sourceMissing || targetMissing) {
        connectionsSkipped.push({ source, target });
        const missingDesc = sourceMissing && targetMissing
          ? `both endpoints '${source}' and '${target}' are`
          : sourceMissing
            ? `source namespace '${source}' is`
            : `target namespace '${target}' is`;
        logger.error(
          `namespace connection skipped — dangling reference: '${source}' -> '${target}' ` +
          `(${missingDesc} absent from the loaded workspace)`,
          { source, target },
        );
        continue;
      }
      await dbModule.runQuery(
        `MATCH (s:RIA_UNIV_Namespace), (d:RIA_UNIV_Namespace)
         WHERE s.name = ${sqlVal(source)} AND d.name = ${sqlVal(target)}
         CREATE (s)-[:RIA_UNIV_NamespaceConnection]->(d)`
      );
      connectionsRestored++;
    }
    totalRecordsImported += connectionsRestored;
    logger.debug(
      `universe: restored ${connectionsRestored} namespace connection(s), ` +
      `skipped ${connectionsSkipped.length} dangling`,
    );
  }

  // ── Restore the global canvas layout (RIA_UNIV_CanvasLayout) ──
  // Global universe-layer node table keyed by layout_id, restored here from the
  // shared top-level universe/ folder (a sibling of RIA_UNIV_NamespaceConnection.json).
  // Each row is MERGEd by layout_id and every persisted record is restored VERBATIM —
  // including records whose element_kind is not one of the two current values — so the
  // full stored set survives load unchanged (Requirements 5.2, 5.3, 5.4).
  //
  // This step does NOT prune dangling references; that is done later by
  // LayoutService.reconcile() (invoked from workspace-service after load). A missing
  // file is treated as an empty layout (not an error) so older ria-data/ or a workspace
  // that never positioned an element simply loads no records; a corrupt/unreadable file
  // surfaces a non-fatal error and load continues.
  const layoutFilePath = path.join(exportDir, 'universe', 'RIA_UNIV_CanvasLayout.json');
  if (fs.existsSync(layoutFilePath)) {
    try {
      const layoutRows = parseTable(fs.readFileSync(layoutFilePath, 'utf-8'));
      let layoutRestored = 0;
      for (const row of layoutRows) {
        const layoutId = String(row.layout_id ?? '');
        if (!layoutId) continue;
        // Parameterize every value so finite doubles outside fixed-notation range
        // (e.g. 1e+21) are stored exactly rather than interpolated as scientific
        // notation the Cypher parser rejects (Requirements 5.2, 5.3, 5.4).
        await dbModule.runQuery(
          `MERGE (l:RIA_UNIV_CanvasLayout {layout_id: $layout_id})
           SET l.element_kind = $element_kind,
               l.element_key  = $element_key,
               l.x = $x, l.y = $y`,
          {
            layout_id: layoutId,
            element_kind: String(row.element_kind ?? ''),
            element_key: String(row.element_key ?? ''),
            x: Number(row.x),
            y: Number(row.y),
          },
        );
        layoutRestored++;
      }
      totalRecordsImported += layoutRestored;
      logger.debug(`universe: restored ${layoutRestored} canvas layout record(s)`);
    } catch (err) {
      // Non-fatal: a corrupt/unreadable layout file must not abort the load.
      logger.error(
        `canvas layout not restored — failed to read/parse '${layoutFilePath}': ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Cross-namespace layer
  emitProgress(params.onProgress, { phase: 'cross_namespace', message: 'Importing cross-namespace instances...' }, logger);
  const nsRelPath = path.join(exportDir, 'cross_namespace', 'RIA_UNIV_NamespaceRelation.json');
  if (fs.existsSync(nsRelPath)) {
    const rows = parseTable(fs.readFileSync(nsRelPath, 'utf-8'));
    if (rows.length > 0) {
      const batchRows = rows.map(row => ({
        source_namespace: row.source_namespace ?? null,
        target_namespace: row.target_namespace ?? null,
        metamodel: row.metamodel ?? null,
        relationship: row.relationship ?? null,
      }));
      await batchInsertNodes(
        `UNWIND $rows AS row CREATE (:RIA_UNIV_NamespaceRelation { source_namespace: row.source_namespace, target_namespace: row.target_namespace, metamodel: row.metamodel, relationship: row.relationship })`,
        batchRows,
        dbModule
      );
      totalRecordsImported += rows.length;
    }
  }

  for (const { file, rel } of [
    { file: 'RIA_UNIV_NSR_SOURCE.json', rel: 'RIA_UNIV_NSR_SOURCE' },
    { file: 'RIA_UNIV_NSR_TARGET.json', rel: 'RIA_UNIV_NSR_TARGET' },
  ]) {
    const p = path.join(exportDir, 'cross_namespace', file);
    if (!fs.existsSync(p)) continue;
    const rows = parseTable(fs.readFileSync(p, 'utf-8'));
    for (const row of rows) {
      await dbModule.runQuery(
        `MATCH (nr:RIA_UNIV_NamespaceRelation), (ns:RIA_UNIV_Namespace) WHERE nr.source_namespace = ${sqlVal(row.src_source_namespace)} AND nr.target_namespace = ${sqlVal(row.src_target_namespace)} AND nr.relationship = ${sqlVal(row.src_relationship)} AND ns.name = ${sqlVal(row.dst_name)} CREATE (nr)-[:${rel}]->(ns)`
      );
    }
  }

  const crossNsInstPath = path.join(exportDir, 'cross_namespace', 'RIA_UNIV_CrossNSRelationshipInstance.json');

  if (fs.existsSync(crossNsInstPath)) {
    const rows = parseTable(fs.readFileSync(crossNsInstPath, 'utf-8'));
    let crossNsInstCount = 0;
    const crossNsInstRows: Record<string, unknown>[] = [];
    for (const row of rows) {
      const srcNs = String(row.source_namespace ?? '');
      const dstNs = String(row.target_namespace ?? '');
      const mm    = String(row.metamodel ?? '');
      const rel   = String(row.relationship ?? '');
      const attrs = typeof row.attributes === 'object' ? JSON.stringify(row.attributes) : String(row.attributes ?? '{}');
      let sourceExternalId = '';
      let targetExternalId = '';
      try {
        const attrsObj = (typeof row.attributes === 'object' ? row.attributes : JSON.parse(attrs)) as Record<string, unknown>;
        sourceExternalId = String(attrsObj.source_external_id ?? '');
        targetExternalId = String(attrsObj.target_external_id ?? '');
      } catch { /* ignore */ }

      if (!sourceExternalId || !targetExternalId) {
        logger.error(`cross_namespace: CrossNSRelationshipInstance missing source_external_id or target_external_id (ns=${srcNs}, rel=${rel})`);
        continue;
      }

      const srcNodeId = crossNsStableIdMap.get(`${srcNs}\u0000${sourceExternalId}`);
      const dstNodeId = crossNsStableIdMap.get(`${dstNs}\u0000${targetExternalId}`);

      if (srcNodeId === undefined) {
        logger.error(`cross_namespace: cannot resolve source_external_id '${sourceExternalId}' (ns=${srcNs}, rel=${rel})`);
        continue;
      }
      if (dstNodeId === undefined) {
        logger.error(`cross_namespace: cannot resolve target_external_id '${targetExternalId}' (ns=${dstNs}, rel=${rel})`);
        continue;
      }

      crossNsInstRows.push({
        source_namespace: srcNs,
        target_namespace: dstNs,
        metamodel: mm,
        relationship: rel,
        source_node_id: srcNodeId,
        target_node_id: dstNodeId,
        attributes: attrs,
      });
      crossNsInstCount++;
    }
    if (crossNsInstRows.length > 0) {
      await batchInsertNodes(
        `UNWIND $rows AS row CREATE (:RIA_UNIV_CrossNSRelationshipInstance { source_namespace: row.source_namespace, target_namespace: row.target_namespace, metamodel: row.metamodel, relationship: row.relationship, source_node_id: row.source_node_id, target_node_id: row.target_node_id, attributes: row.attributes })`,
        crossNsInstRows,
        dbModule
      );
      totalRecordsImported += crossNsInstRows.length;

      // Bulk-fetch all cross-namespace edge_ids in one query instead of issuing
      // one query per row (N+1 problem), same pattern as intra-namespace edges above.
      const srcNamespaces = [...new Set(crossNsInstRows.map(r => String(r.source_namespace ?? '')))];
      const nsListLiteral = srcNamespaces.map(ns => `'${e(ns)}'`).join(', ');
      const allCrossNsEdgeIds = await dbModule.runQuery(
        `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance) WHERE x.source_namespace IN [${nsListLiteral}]
         RETURN x.source_node_id AS source_node_id, x.target_node_id AS target_node_id,
                x.edge_id AS edge_id, x.relationship AS relationship, x.metamodel AS metamodel,
                x.source_namespace AS source_namespace, x.target_namespace AS target_namespace`
      );
      const crossNsEdgeIdMap = new Map<string, typeof allCrossNsEdgeIds[0]>();
      for (const r of allCrossNsEdgeIds) {
        const key = `${r.source_node_id}:${r.target_node_id}`;
        if (!crossNsEdgeIdMap.has(key)) crossNsEdgeIdMap.set(key, r);
      }
      const crossNsEdgeRelRows: Array<{ source_node_id: number; target_node_id: number; edge_id: number; relationship: string; metamodel: string; source_namespace: string; target_namespace: string }> = [];
      for (const instRow of crossNsInstRows) {
        const key = `${instRow.source_node_id}:${instRow.target_node_id}`;
        const r = crossNsEdgeIdMap.get(key);
        if (r) {
          crossNsEdgeRelRows.push({
            source_node_id: Number(instRow.source_node_id),
            target_node_id: Number(instRow.target_node_id),
            edge_id: Number(r.edge_id),
            relationship: String(r.relationship ?? instRow.relationship ?? ''),
            metamodel: String(r.metamodel ?? instRow.metamodel ?? ''),
            source_namespace: String(instRow.source_namespace ?? ''),
            target_namespace: String(instRow.target_namespace ?? ''),
          });
        }
      }
      await createCrossNsInstanceRelEdges(crossNsEdgeRelRows, dbModule);
      logger.debug(`cross_namespace — ${crossNsEdgeRelRows.length} CROSSNS_INSTANCE_REL graph edges`);
    }
    logger.debug(`cross_namespace — ${crossNsInstCount} CrossNSRelationshipInstance records`);
  }

  const elapsed = Date.now() - loadStart;
  const failSuffix = totalRelationshipsFailed > 0 ? `, relationships_failed=${totalRelationshipsFailed}` : '';
  logger.info(`load done — imported=${namespacesImported.length}, skipped=${namespacesSkipped.length}, records=${totalRecordsImported}${failSuffix}, elapsed=${elapsed}ms`);

  emitProgress(params.onProgress, { phase: 'finalizing', message: 'Load complete.' }, logger);

  const logFile = (logger as { logFile?: string }).logFile;
  return {
    namespaces_imported: namespacesImported,
    namespaces_skipped: namespacesSkipped,
    total_records_imported: totalRecordsImported,
    log_file: logFile,
    ...(totalRelationshipsFailed > 0 ? { relationships_failed: totalRelationshipsFailed } : {}),
    ...(connectionsSkipped.length > 0 ? { connections_skipped: connectionsSkipped } : {}),
  };
}
