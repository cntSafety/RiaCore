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
import { classifySchemaCompatibility, describeIncompatibleSchema } from '../db/schema-compat.js';
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
import { originFromManifest, writeSnapshotOrigin } from './snapshot-origin.js';
import type { LoadPlan } from '../workspace/sync-state.js';

/**
 * Universe and sourcemaster edges whose endpoints this load is about to
 * destroy, captured so a load that SKIPS those layers can put them back.
 *
 * Why a snapshot rather than a re-read of the edge files: the skipped layer is
 * S1, so its files and this snapshot agree on everything that was ever saved —
 * but the snapshot additionally carries edges authored in this session and not
 * yet written out. Restoring from the files would discard exactly the unsaved
 * work that skipping the layer exists to preserve.
 *
 * What is destroyed, and by what:
 *
 * - the meta clear deletes the `RIA_META_Metamodel` nodes that
 *   `RIA_UNIV_VIEW_DEFINEDBY` and `RIA_UNIV_VIEW_CATEGORIZEDBY` point at, so
 *   those edges go with them on EVERY load, even one that touches nothing else;
 * - the per-namespace path `DETACH DELETE`s the `RIA_UNIV_Namespace` node that
 *   `RIA_UNIV_VIEW_SOURCE`, `RIA_UNIV_NamespaceConnection` and
 *   `RIA_SRC_TARGETS_NS` point at, and additionally cascade-deletes every view
 *   sourced on that namespace (a domain rule that is deliberate for a real
 *   namespace deletion and incidental here, since the namespace is recreated
 *   moments later).
 *
 * Nothing here is needed when the owning layer IS in the plan: the ordinary
 * restore step rebuilds it from the files.
 */
interface SkippedLayerSnapshot {
  /** Full `RIA_UNIV_View` rows, so a cascade-deleted view node can be restored. */
  views: Record<string, unknown>[];
  viewDefinedBy: { view: string; metamodel: string }[];
  viewCategorizedBy: { view: string; metamodel: string }[];
  viewSource: { view: string; namespace: string }[];
  namespaceConnections: { source: string; target: string }[];
  /** `RIA_SRC_Source` → `RIA_UNIV_Namespace`. Captured only when sourcemaster is skipped. */
  sourceTargetsNs: { sourceId: string; namespace: string }[];
}

async function snapshotSkippedLayerEdges(
  dbModule: IDbModule,
  plan: LoadPlan,
  logger: ImportLogger,
): Promise<SkippedLayerSnapshot | null> {
  if (plan.universe && plan.sourcemaster) return null;
  const empty: SkippedLayerSnapshot = {
    views: [], viewDefinedBy: [], viewCategorizedBy: [], viewSource: [],
    namespaceConnections: [], sourceTargetsNs: [],
  };
  try {
    if (!plan.universe) {
      empty.views = await dbModule.runQuery(
        `MATCH (v:RIA_UNIV_View)
         RETURN v.name AS name, v.description AS description, v.metamodel AS metamodel,
                v.mapping AS mapping, v.parameters AS parameters`,
      );
      const pairs = async (rel: string): Promise<{ src: string; dst: string }[]> =>
        (await dbModule.runQuery(
          `MATCH (a)-[:${rel}]->(b) RETURN a.name AS src, b.name AS dst`,
        )).map((r) => ({ src: String(r.src ?? ''), dst: String(r.dst ?? '') }))
          .filter((p) => p.src !== '' && p.dst !== '');
      empty.viewDefinedBy = (await pairs('RIA_UNIV_VIEW_DEFINEDBY'))
        .map((p) => ({ view: p.src, metamodel: p.dst }));
      empty.viewCategorizedBy = (await pairs('RIA_UNIV_VIEW_CATEGORIZEDBY'))
        .map((p) => ({ view: p.src, metamodel: p.dst }));
      empty.viewSource = (await pairs('RIA_UNIV_VIEW_SOURCE'))
        .map((p) => ({ view: p.src, namespace: p.dst }));
      empty.namespaceConnections = (await pairs('RIA_UNIV_NamespaceConnection'))
        .map((p) => ({ source: p.src, target: p.dst }));
    }
    if (!plan.sourcemaster) {
      empty.sourceTargetsNs = (await dbModule.runQuery(
        `MATCH (s:RIA_SRC_Source)-[:RIA_SRC_TARGETS_NS]->(ns:RIA_UNIV_Namespace)
         RETURN s.source_id AS source_id, ns.name AS name`,
      )).map((r) => ({ sourceId: String(r.source_id ?? ''), namespace: String(r.name ?? '') }))
        .filter((p) => p.sourceId !== '' && p.namespace !== '');
    }
    return empty;
  } catch (err) {
    // A failed snapshot must not abort a load. The cost is the edges the rewire
    // would have restored, which the next store-and-load cycle re-establishes
    // from the files.
    logger.error(
      `load: could not snapshot the edges of the skipped layers — ` +
      `view and connection edges may be missing after this load: ` +
      (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/**
 * Put back what {@link snapshotSkippedLayerEdges} captured.
 *
 * Runs after the namespace loop, so every endpoint node exists again. An edge
 * whose endpoint is genuinely gone — a view sourced on a namespace the manifest
 * no longer lists — is dropped rather than re-created, matching what the
 * ordinary universe restore does with a dangling reference.
 */
async function rewireSkippedLayerEdges(
  dbModule: IDbModule,
  snapshot: SkippedLayerSnapshot,
  logger: ImportLogger,
): Promise<void> {
  const present = async (label: string, key: string): Promise<Set<string>> =>
    new Set((await dbModule.runQuery(`MATCH (n:${label}) RETURN n.${key} AS k`))
      .map((r) => String(r.k ?? '')));

  const metamodels = await present('RIA_META_Metamodel', 'name');
  const namespaces = await present('RIA_UNIV_Namespace', 'name');
  let views = await present('RIA_UNIV_View', 'name');

  // Re-create view nodes the namespace cascade removed. Verbatim from the
  // snapshot: this is the same database's own row, not a re-read of a file.
  let viewsRestored = 0;
  for (const row of snapshot.views) {
    const name = String(row.name ?? '');
    if (!name || views.has(name)) continue;
    // A view with no surviving source namespace is invalid and must not be
    // resurrected as one (docs/coreSpecs/RiaViews.md).
    const sources = snapshot.viewSource.filter((s) => s.view === name && namespaces.has(s.namespace));
    if (sources.length === 0) {
      logger.warn(
        `load: view '${name}' was removed with its source namespace and is not restored — ` +
        `no source namespace survives this load`,
        { view: name },
      );
      continue;
    }
    await dbModule.runQuery(
      `CREATE (:RIA_UNIV_View {name: $name, description: $description, metamodel: $metamodel,
         mapping: $mapping, parameters: $parameters})`,
      {
        name,
        description: String(row.description ?? ''),
        metamodel: String(row.metamodel ?? ''),
        mapping: String(row.mapping ?? ''),
        parameters: String(row.parameters ?? '{}'),
      },
    );
    viewsRestored++;
  }
  if (viewsRestored > 0) views = await present('RIA_UNIV_View', 'name');

  const link = async (
    rel: string, fromLabel: string, toLabel: string,
    pairs: { from: string; to: string }[],
    fromSet: Set<string>, toSet: Set<string>,
  ): Promise<number> => {
    let created = 0;
    for (const pair of pairs) {
      if (!fromSet.has(pair.from) || !toSet.has(pair.to)) continue;
      await dbModule.runQuery(
        `MATCH (a:${fromLabel}), (b:${toLabel}) WHERE a.name = $from AND b.name = $to
         AND NOT EXISTS { MATCH (a)-[:${rel}]->(b) }
         CREATE (a)-[:${rel}]->(b)`,
        { from: pair.from, to: pair.to },
      );
      created++;
    }
    return created;
  };

  const definedBy = await link('RIA_UNIV_VIEW_DEFINEDBY', 'RIA_UNIV_View', 'RIA_META_Metamodel',
    snapshot.viewDefinedBy.map((p) => ({ from: p.view, to: p.metamodel })), views, metamodels);
  const categorizedBy = await link('RIA_UNIV_VIEW_CATEGORIZEDBY', 'RIA_UNIV_View', 'RIA_META_Metamodel',
    snapshot.viewCategorizedBy.map((p) => ({ from: p.view, to: p.metamodel })), views, metamodels);
  const viewSource = await link('RIA_UNIV_VIEW_SOURCE', 'RIA_UNIV_View', 'RIA_UNIV_Namespace',
    snapshot.viewSource.map((p) => ({ from: p.view, to: p.namespace })), views, namespaces);
  const connections = await link('RIA_UNIV_NamespaceConnection', 'RIA_UNIV_Namespace', 'RIA_UNIV_Namespace',
    snapshot.namespaceConnections.map((p) => ({ from: p.source, to: p.target })), namespaces, namespaces);

  let targetsNs = 0;
  for (const pair of snapshot.sourceTargetsNs) {
    if (!namespaces.has(pair.namespace)) continue;
    await dbModule.runQuery(
      `MATCH (s:RIA_SRC_Source), (ns:RIA_UNIV_Namespace)
       WHERE s.source_id = $sourceId AND ns.name = $namespace
       AND NOT EXISTS { MATCH (s)-[:RIA_SRC_TARGETS_NS]->(ns) }
       CREATE (s)-[:RIA_SRC_TARGETS_NS]->(ns)`,
      { sourceId: pair.sourceId, namespace: pair.namespace },
    );
    targetsNs++;
  }

  logger.debug(
    `load: rewired skipped-layer edges — views_restored=${viewsRestored}, ` +
    `view_definedby=${definedBy}, view_categorizedby=${categorizedBy}, view_source=${viewSource}, ` +
    `namespace_connections=${connections}, source_targets_ns=${targetsNs}`,
  );
}

/**
 * Fail the load before it writes anything when any `manifest.namespaces[]` entry
 * lacks `namespace_role` or `namespace_owning_application`.
 *
 * The manifest is the sole authority for both, so there is nowhere to fall back
 * to, and defaulting is worse than failing: the role is a gate, not a label, and
 * an empty one silently disables concept creation, view sourcing, dirty-tracking
 * exclusion and imported/authored wiring. One pass ahead of the namespace loop
 * keeps a defective entry from leaving the database half-imported and reports
 * every offender at once.
 *
 * The recovery wording omits `repairManifest` on purpose: it recomputes content
 * digests from disk and has no source for identity.
 */
function assertManifestNamespaceIdentity(manifest: Manifest, manifestPath: string): void {
  const offenders: string[] = [];

  manifest.namespaces.forEach((entry, index) => {
    const raw = entry as {
      name?: unknown;
      namespace_role?: unknown;
      namespace_owning_application?: unknown;
    };
    const label =
      typeof raw.name === 'string' && raw.name !== ''
        ? `namespaces[${index}] ('${raw.name}')`
        : `namespaces[${index}] (unnamed)`;

    const missing: string[] = [];
    // `namespace_role` must be a NON-EMPTY string: `''` is not a role the rest
    // of the application recognises, it is the absence of one, and it fails the
    // four gates above identically to the field being missing.
    if (typeof raw.namespace_role !== 'string' || raw.namespace_role === '') {
      missing.push('namespace_role');
    }
    // `namespace_owning_application` must be a string but MAY be empty — unlike
    // the role it is descriptive, not a gate, and `''` is its ordinary value for
    // a namespace no application owns (see `provisioning-service.ts`, which sets
    // it to `''` on every provisioned import namespace). Rejecting `''` here
    // would refuse to load most existing workspaces for no benefit.
    if (typeof raw.namespace_owning_application !== 'string') {
      missing.push('namespace_owning_application');
    }

    if (missing.length > 0) {
      offenders.push(`${label}: missing ${missing.join(' and ')}`);
    }
  });

  if (offenders.length === 0) return;

  throw new Error(
    `Cannot load: '${manifestPath}' does not carry namespace identity for ` +
    `${offenders.length} of its ${manifest.namespaces.length} namespaces[] ` +
    `entr${manifest.namespaces.length === 1 ? 'y' : 'ies'}, and the manifest entry is ` +
    `the only source for it:\n` +
    offenders.map((o) => `  - ${o}`).join('\n') + '\n' +
    `Run a full 'persistor store' from a workspace whose database still holds this ` +
    `content, or restore ria-data/manifest.json from version control. ` +
    `Recomputing the manifest's content hashes cannot recover namespace identity — ` +
    `it is not derived from the files on disk.`,
  );
}

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
  // Kept, not re-read at the end: the origin record must carry the digest of the
  // bytes this load actually consumed. A second read could pick up a manifest
  // rewritten while the load was running and record a version the database was
  // never built from — the one thing an origin row must never say.
  const manifestBytes = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(manifestBytes) as Manifest;

  // ── Schema compatibility + hash epoch guard ───────────────────────────────
  // Two decisions, in order, both driven by `manifest.schema_version`.
  //
  // FIRST, may this code read the snapshot at all? `classifySchemaCompatibility`
  // owns that answer (see `db/schema-compat.ts`): a differing major generation,
  // a version newer than this code writes, one older than
  // `MIN_READABLE_SCHEMA_VERSION`, or an unparseable one is refused here, before
  // any file is read. `workspaceService.open` normally refuses earlier still, at
  // classification time, so this throw is the backstop for a direct `load()` —
  // the CLI, a test, or any future caller that did not classify first.
  //
  // SECOND, within the supported range: is the hash epoch the current one? A hash
  // means nothing to code that did not compute it, so comparison is valid only
  // within one epoch, and across epochs every comparison below is SUSPENDED
  // rather than failed. Evaluated once here, before any carrier is dereferenced,
  // because `Manifest` is a parse assertion — a field declared required can still
  // be absent at runtime in an older-epoch file.
  const compatibility = classifySchemaCompatibility(manifest.schema_version);
  if (compatibility.kind === 'incompatible') {
    throw new Error(`Cannot load '${manifestPath}': ${describeIncompatibleSchema(compatibility)}`);
  }

  const hashEpochMatches = compatibility.exact;
  if (!hashEpochMatches) {
    logger.warn(
      `manifest schema_version (${manifest.schema_version}) predates the current schema (${SCHEMA_VERSION}) — ` +
      `loading the data as-is and suspending all hash verification (namespace, universe, sourcemaster, meta); ` +
      `the next store rewrites ria-data at ${SCHEMA_VERSION}`,
      { manifest_schema_version: manifest.schema_version, current_schema_version: SCHEMA_VERSION },
    );
  }

  // Verify meta_hash if present, within the current hash epoch only. A mismatch
  // means the meta layer files on disk differ from what was last stored — either
  // the metamodel YAML changed (a legitimate code update) or the files were
  // manually edited. Either way the load proceeds: the meta layer is always
  // re-imported unconditionally, and the post-load wiring step repairs any
  // missing DEFINEDBY/CATEGORIZEDBY edges. This is a warning, not an error,
  // because meta changes from YAML updates are expected and should not block
  // workspace open.
  if (hashEpochMatches && manifest.meta_hash) {
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
  // `BottomPanel` repair-hash flow unchanged. On-disk
  // contents are left untouched: we only read and compare, never write.
  //
  // Guarded by the hash epoch: an older-epoch manifest's universe hashes cannot
  // be reproduced by this code, so comparing them would report corruption for a
  // workspace that is merely out of date.
  if (hashEpochMatches && manifest.universe_hashes) {
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

  // Verify each recorded sourcemaster hash before importing any data, using the
  // same rules and the same `"file integrity check failed"` convention as the
  // universe block directly above: absent, unreadable, or a differing hash is a
  // hard failure naming `repairManifest` as the recovery. Nothing is
  // written here either — we only read and compare.
  //
  // This is a hard failure and not a warning, and the asymmetry with the
  // `meta_hash` check three blocks up is deliberate rather than accidental.
  // `sourcemaster/` holds serialized DB record data — import sources and import
  // runs — which load clears and re-imports unconditionally from these files,
  // exactly like the universe layer, and which nothing regenerates from code. If
  // its bytes no longer match what store recorded, the only copy of that data is
  // the one being distrusted, so continuing would import it as if it were
  // intact. `meta_hash` warns only because the meta layer *is* legitimately
  // regenerated from profiles and YAML on every workspace open, so a mismatch
  // there is an expected consequence of a code update rather than evidence about
  // the data. That does not apply here.
  //
  // Guarded by the hash epoch for the same reason the universe block is: an
  // older-epoch manifest's hashes cannot be reproduced by this code, so
  // comparing them would report corruption for a workspace that is merely out
  // of date.
  if (hashEpochMatches && manifest.sourcemaster_hashes) {
    for (const [relPath, recordedHash] of Object.entries(manifest.sourcemaster_hashes)) {
      if (!recordedHash) continue;
      const sourcemasterFilePath = path.join(exportDir, relPath);

      let diskContent: string;
      try {
        if (!fs.existsSync(sourcemasterFilePath)) {
          throw new Error('file not found');
        }
        diskContent = fs.readFileSync(sourcemasterFilePath, 'utf-8');
      } catch (err) {
        logger.error(
          `Sourcemaster file '${relPath}': file integrity check failed — ` +
          `recorded in manifest but absent or unreadable on disk` +
          ` (${err instanceof Error ? err.message : String(err)})`,
          { sourcemaster_file: relPath, manifest_hash: recordedHash },
        );
        throw new Error(
          `Sourcemaster file '${relPath}': file integrity check failed. ` +
          `The file is recorded in the manifest (hash: ${recordedHash}) but is ` +
          `absent or unreadable on disk. ` +
          `If you trust the workspace, regenerate manifest.json via repairManifest.`
        );
      }

      const diskHash = computeUniverseFileHash(diskContent);
      if (diskHash !== recordedHash) {
        logger.error(
          `Sourcemaster file '${relPath}': file integrity check failed — ` +
          `manifest=${recordedHash.slice(0, 20)}... disk=${diskHash.slice(0, 20)}...`,
          { sourcemaster_file: relPath, manifest_hash: recordedHash, disk_hash: diskHash },
        );
        throw new Error(
          `Sourcemaster file '${relPath}': file integrity check failed. ` +
          `Manifest hash: ${recordedHash}, computed from file: ${diskHash}. ` +
          `The sourcemaster-layer file may be corrupted or manually edited. ` +
          `If you trust the file, regenerate manifest.json via repairManifest.`
        );
      }
      logger.debug(`sourcemaster file integrity check passed`, { sourcemaster_file: relPath, hash: recordedHash });
    }
  }

  // Namespace identity is validated in ONE pass here, before the first write,
  // so a defective manifest reports every offending entry at once instead of
  // half-importing and then failing on the first gap it reaches. See the
  // function's own comment for why there is no fallback and why the recovery
  // wording deliberately omits `repairManifest`.
  assertManifestNamespaceIdentity(manifest, manifestPath);

  // ── Load plan ──────────────────────────────────────────────────────────────
  // Which domains this run clears and re-imports. Supplied by the open path,
  // which has already evaluated the sync states; computed here otherwise so a
  // direct caller and the CLI behave identically.
  //
  // Across an epoch difference the plan is full regardless: no recorded hash is
  // comparable, so there is no basis on which to narrow the operation.
  const fullPlan: LoadPlan = {
    meta: true, sourcemaster: true, universe: true, crossNamespace: true,
    namespaces: manifest.namespaces.map((n) => n.name).filter((n) => !!n),
  };
  // No plan means a full load, deliberately, and NOT "evaluate the sync state
  // and plan from it".
  //
  // Every production caller that omits the plan is asking for a wholesale
  // rebuild from the files: `performFreshLoad` (which has just deleted the
  // database), the CLI's `persistor load`, and the renderer's "Load from
  // ria-data" button. For the last two, narrowing the operation would make the
  // button silently do nothing in exactly the case the user pressed it — a
  // database that diverged from the files without the files changing is S1 by
  // the three-hash rule (Invariant 1: origin rows are not invalidated by an
  // edit), so a planned load would skip the very layer the user wants
  // discarded. Requirement 14.5 says the Load action runs the load; it does not
  // say it runs a subset.
  //
  // The scoping of Requirement 9 belongs to the open path, which is the only
  // caller with a basis for narrowing: it has just evaluated every domain and
  // passes the resulting plan explicitly. Across an epoch difference the plan is
  // full regardless, since no recorded hash is comparable.
  const plan: LoadPlan = hashEpochMatches ? params.plan ?? fullPlan : fullPlan;
  const plannedNamespaces = new Set(plan.namespaces);

  logger.info(
    `load started — ${manifest.namespaces.length} namespace(s) in manifest; ` +
    `plan: meta=yes sourcemaster=${plan.sourcemaster ? 'yes' : 'SKIP'} ` +
    `universe=${plan.universe ? 'yes' : 'SKIP'} cross_namespace=${plan.crossNamespace ? 'yes' : 'SKIP'} ` +
    `namespaces=${plan.namespaces.length}/${manifest.namespaces.length}`,
    {
      plan_sourcemaster: plan.sourcemaster,
      plan_universe: plan.universe,
      plan_cross_namespace: plan.crossNamespace,
      plan_namespaces: plan.namespaces,
    },
  );
  if (!plan.sourcemaster) {
    logger.info(
      'load: skipping sourcemaster/ — every sourcemaster domain is S1, so the files hold nothing ' +
      'this database has not already consumed; unsaved import-source and import-run rows survive',
    );
  }
  if (!plan.universe) {
    logger.info(
      'load: skipping universe/ — every universe domain is S1; view, layout and connection rows ' +
      'are kept and only the edge rows this load destroys are re-created',
    );
  }
  if (!plan.crossNamespace) {
    logger.info(
      'load: skipping cross_namespace/ — every cross-namespace domain is S1 and no namespace is ' +
      'in this plan (Invariant 3: the layer is never operated on partially)',
    );
  }

  // Captured before the first destructive statement, and only for the layers
  // this run skips. See SkippedLayerSnapshot.
  const skippedEdges = await snapshotSkippedLayerEdges(dbModule, plan, logger);

  // Query existing namespace content_hashes from DB
  const existingHashRows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace) RETURN ns.name AS name, ns.content_hash AS content_hash`
  );
  const existingHashes = new Map<string, string>();
  for (const row of existingHashRows) {
    existingHashes.set(String(row.name ?? ''), String(row.content_hash ?? ''));
  }

  // An explicit full load adopts snapshot membership as well as content. A
  // supplied open-time plan must preserve DB-only work outside its scope.
  const manifestNamespaces = new Set(manifest.namespaces.map(n => n.name));
  const namespacesToRemove: string[] = [];
  for (const [dbNs] of existingHashes) {
    if (!manifestNamespaces.has(dbNs)) {
      if (params.plan === undefined) {
        namespacesToRemove.push(dbNs);
      } else {
        logger.warn(`namespace '${dbNs}' exists in DB but is not listed in the manifest — preserved by scoped load`);
      }
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
  const clearedLayers: Array<'meta' | 'sourcemaster' | 'cross_namespace'> = ['meta'];
  if (plan.sourcemaster) clearedLayers.push('sourcemaster');
  if (plan.crossNamespace) clearedLayers.push('cross_namespace');
  logger.debug(`clearing ${clearedLayers.join('/')} layer(s)...`);
  emitProgress(params.onProgress, { phase: 'shared', message: 'Clearing shared layers...' }, logger);

  // Views are cleared here, ahead of the shared-layer clear, not in the restore
  // block further down. A view's VIEW_DEFINEDBY / VIEW_CATEGORIZEDBY edges point
  // at RIA_META_Metamodel nodes that the shared-layer clear deletes, so those
  // edges go with them; leaving the view *nodes* behind would produce views with
  // no immediate metamodel, which is invalid (docs/coreSpecs/RiaViews.md — a view
  // has exactly one VIEW_DEFINEDBY). The clear matches the universe restore
  // below: the loaded set of views equals the persisted set exactly, so a
  // workspace with no RIA_UNIV_View.json loads as a workspace with no views.
  //
  // Skipped when the universe layer is not in the plan, because then there is no
  // restore to pair it with — the view rows in the database are the only copy of
  // this session's view work. Their DEFINEDBY/CATEGORIZEDBY edges are still
  // destroyed by the meta clear and are put back by the rewire step.
  if (plan.universe) {
    await dbModule.runQuery(`MATCH (v:RIA_UNIV_View) DETACH DELETE v`);
  }

  for (const stmt of buildSharedLayerClearStatements(clearedLayers)) {
    await dbModule.runQuery(stmt);
  }

  // Import meta layer — node tables (batched UNWIND inserts). The sourcemaster
  // tables join in only when the plan named that layer; skipping the clear
  // without skipping the import would duplicate every row.
  const sharedNodeTables = [
    ...getTablesByLayer('meta'),
    ...(plan.sourcemaster ? getTablesByLayer('sourcemaster') : []),
  ]
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
  //
  // Built for the planned layers only, for the same reason the node import is:
  // the sourcemaster edges were not cleared, so re-creating them from the files
  // would duplicate them. `RIA_SRC_TARGETS_NS` is the exception that the rewire
  // step handles — it terminates on a namespace node the load destroys, so it
  // has to be put back from the snapshot rather than from the file.
  const { immediate: immediateEdgeSpecs, deferred: deferredEdgeSpecs } =
    buildSharedEdgeImportSpecs(plan.sourcemaster ? ['meta', 'sourcemaster'] : ['meta']);

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
  // the load operation to fail.
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
    // Optional-chained on purpose: `namespace_hashes` is declared required but
    // the declaration is a parse assertion, so an older-epoch manifest may not
    // carry it at all. The recorded value is still written to the namespace
    // node's `content_hash` even across an epoch difference, so a subsequent
    // open delta-skips the re-import instead of redoing it on every open.
    const manifestHash = manifest.namespace_hashes?.[namespace] ?? '';
    const nsDir = path.join(exportDir, (nsEntry as { directory?: string }).directory ?? namespace);

    // Plan skip, ahead of the delta skip. The delta skip asks "does the database
    // already hold these bytes?"; this asks "was this namespace stale at all?".
    // They almost always agree — a namespace the plan left out is S1, which
    // means its content_hash equals the manifest hash — but the plan is the
    // authority on scope and saying so explicitly keeps the two independent.
    if (!plannedNamespaces.has(namespace)) {
      logger.debug(
        `skip ${namespace}: not in the load plan (the namespace is S1 — the database already ` +
        `holds the file version on disk)`,
        { namespace, reason: 'plan_skip' },
      );
      namespacesSkipped.push(namespace);
      continue;
    }

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
      // A skipped namespace is loaded without its files being read, so a file
      // corrupted since the last store is not detected here. Sound for the data
      // and bounded: open rehashes every namespace from disk, and store compares
      // on-disk hashes. Logged so the window is traceable.
      logger.debug(
        `skip ${namespace}: on-disk file integrity not verified; ` +
        `verification runs only on the re-import path`,
        { namespace, reason: 'delta_skip' },
      );
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
    //
    // Suspended across a hash-epoch difference: the recorded hash was computed
    // by a different algorithm over a different input set, so every namespace
    // would fail here and abort the very rebuild the epoch rule exists to allow.
    if (hashEpochMatches && manifestHash) {
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

        // The manifest entry is the sole authority for namespace identity, and
        // `assertManifestNamespaceIdentity` has already established that both
        // fields are present on every entry — so there is nothing to default
        // and nothing to override. A `<namespace>/namespace.json` left behind by
        // a pre-1.5.0 store is inert: nothing reads it.
        const namespaceRole = (nsEntry as { namespace_role?: string }).namespace_role ?? '';
        const namespaceOwningApplication = (nsEntry as { namespace_owning_application?: string }).namespace_owning_application ?? '';

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

      // Same as the transactional twin above: the manifest entry is the sole
      // authority, already validated ahead of the loop, and any leftover
      // `namespace.json` is inert.
      const namespaceRole = (nsEntry as { namespace_role?: string }).namespace_role ?? '';
      const namespaceOwningApplication = (nsEntry as { namespace_owning_application?: string }).namespace_owning_application ?? '';

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

  // Wait until the manifest namespaces have loaded successfully before pruning
  // DB-only namespaces, but do it before restoring shared references so those
  // references cannot bind to namespaces absent from the selected snapshot.
  // Use the graph-aware deletion path to remove instances and dependent rows,
  // rather than leaving orphaned content that a later store could resurrect.
  if (namespacesToRemove.length > 0) {
    const tx = await dbModule.beginTransaction?.();
    try {
      for (const namespace of namespacesToRemove) {
        await deleteNamespace(namespace, dbModule, tx);
      }
      await tx?.commit();
    } catch (err) {
      await tx?.rollback();
      throw err;
    }
    for (const namespace of namespacesToRemove) {
      logger.info(`remove ${namespace}: absent from manifest during full load`, { namespace });
    }
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
  // omitted, and an error is surfaced identifying it.
  const connectionsSkipped: { source: string; target: string }[] = [];
  const connFilePath = path.join(exportDir, 'universe', 'RIA_UNIV_NamespaceConnection.json');
  if (plan.universe && fs.existsSync(connFilePath)) {
    // Clear any existing per-pair edges so the loaded set equals the persisted
    // set exactly — zero connections added, zero removed for present endpoints
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
  // full stored set survives load unchanged.
  //
  // This step does NOT prune dangling references; that is done later by
  // LayoutService.reconcile() (invoked from workspace-service after load). A missing
  // file is treated as an empty layout (not an error) so older ria-data/ or a workspace
  // that never positioned an element simply loads no records; a corrupt/unreadable file
  // surfaces a non-fatal error and load continues.
  const layoutFilePath = path.join(exportDir, 'universe', 'RIA_UNIV_CanvasLayout.json');
  if (plan.universe && fs.existsSync(layoutFilePath)) {
    try {
      const layoutRows = parseTable(fs.readFileSync(layoutFilePath, 'utf-8'));
      let layoutRestored = 0;
      for (const row of layoutRows) {
        const layoutId = String(row.layout_id ?? '');
        if (!layoutId) continue;
        // Parameterize every value so finite doubles outside fixed-notation range
        // (e.g. 1e+21) are stored exactly rather than interpolated as scientific
        // notation the Cypher parser rejects.
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

  // ── Restore view definitions (RIA_UNIV_View) ──
  // Global universe-layer node table + its three relationship tables, restored
  // here after the namespace loop (VIEW_SOURCE targets RIA_UNIV_Namespace) and
  // after the meta layer (VIEW_DEFINEDBY/VIEW_CATEGORIZEDBY target
  // RIA_META_Metamodel, already restored in the shared-layer step above).
  // The matching clear ran before the shared-layer clear, not here — see the
  // comment on that statement.
  // Clear-then-restore semantics, like RIA_UNIV_NamespaceConnection: the loaded
  // set of views equals the persisted set exactly for every view whose sources
  // and metamodels are all present. A view whose VIEW_DEFINEDBY metamodel is
  // missing, or that is left with zero VIEW_SOURCE edges after dropping dangling
  // ones, is not restored at all — a view with zero sources is invalid
  // (docs/coreSpecs/RiaViews.md) and must not be silently resurrected as one.
  const viewsSkipped: { view: string; reason: string }[] = [];
  const viewFilePath = path.join(exportDir, 'universe', 'RIA_UNIV_View.json');
  if (plan.universe && fs.existsSync(viewFilePath)) {
    const readViewTable = (file: string): Record<string, unknown>[] => {
      const p = path.join(exportDir, 'universe', file);
      return fs.existsSync(p) ? parseTable(fs.readFileSync(p, 'utf-8')) : [];
    };
    const viewRows = readViewTable('RIA_UNIV_View.json');
    const viewSourceRows = readViewTable('RIA_UNIV_VIEW_SOURCE.json');
    const viewDefinedByRows = readViewTable('RIA_UNIV_VIEW_DEFINEDBY.json');
    const viewCategorizedByRows = readViewTable('RIA_UNIV_VIEW_CATEGORIZEDBY.json');

    const presentNsRowsForViews = await dbModule.runQuery(`MATCH (ns:RIA_UNIV_Namespace) RETURN ns.name AS name`);
    const presentNamespacesForViews = new Set(presentNsRowsForViews.map(r => String(r.name ?? '')));
    const presentMmRows = await dbModule.runQuery(`MATCH (mm:RIA_META_Metamodel) RETURN mm.name AS name`);
    const presentMetamodels = new Set(presentMmRows.map(r => String(r.name ?? '')));

    let viewsRestored = 0;
    for (const row of viewRows) {
      const name = String(row.name ?? '');
      if (!name) continue;

      const definedByRow = viewDefinedByRows.find(r => String(r.src_name ?? '') === name);
      const definedByMetamodel = definedByRow ? String(definedByRow.dst_name ?? '') : '';
      if (!definedByMetamodel || !presentMetamodels.has(definedByMetamodel)) {
        viewsSkipped.push({ view: name, reason: `immediate metamodel '${definedByMetamodel || '(missing)'}' is absent` });
        logger.error(
          `view '${name}' skipped — immediate metamodel '${definedByMetamodel || '(missing)'}' is absent from the loaded workspace`,
          { view: name },
        );
        continue;
      }

      const sourceRows = viewSourceRows.filter(r => String(r.src_name ?? '') === name);
      const presentSources = sourceRows
        .map(r => String(r.dst_name ?? ''))
        .filter(ns => ns && presentNamespacesForViews.has(ns));
      const droppedSources = sourceRows.length - presentSources.length;
      if (droppedSources > 0) {
        logger.error(
          `view '${name}': ${droppedSources} source namespace(s) absent from the loaded workspace — dropped`,
          { view: name },
        );
      }
      if (presentSources.length === 0) {
        viewsSkipped.push({ view: name, reason: 'no source namespace is present in the loaded workspace' });
        logger.error(
          `view '${name}' skipped — left with zero source namespaces after dropping dangling references`,
          { view: name },
        );
        continue;
      }

      const categorizedByRows = viewCategorizedByRows.filter(r => String(r.src_name ?? '') === name);
      const presentCategorizedBy = categorizedByRows
        .map(r => String(r.dst_name ?? ''))
        .filter(mm => mm && presentMetamodels.has(mm));

      await dbModule.runQuery(
        `CREATE (:RIA_UNIV_View {
          name: $name, description: $description, metamodel: $metamodel,
          mapping: $mapping, parameters: $parameters
        })`,
        {
          name,
          description: String(row.description ?? ''),
          metamodel: String(row.metamodel ?? ''),
          mapping: String(row.mapping ?? ''),
          parameters: JSON.stringify(row.parameters ?? {}),
        },
      );
      await dbModule.runQuery(
        `MATCH (v:RIA_UNIV_View), (mm:RIA_META_Metamodel)
         WHERE v.name = $name AND mm.name = $mm
         CREATE (v)-[:RIA_UNIV_VIEW_DEFINEDBY]->(mm)`,
        { name, mm: definedByMetamodel },
      );
      for (const ns of presentSources) {
        await dbModule.runQuery(
          `MATCH (v:RIA_UNIV_View), (ns:RIA_UNIV_Namespace)
           WHERE v.name = $name AND ns.name = $ns
           CREATE (v)-[:RIA_UNIV_VIEW_SOURCE]->(ns)`,
          { name, ns },
        );
      }
      for (const mm of presentCategorizedBy) {
        await dbModule.runQuery(
          `MATCH (v:RIA_UNIV_View), (mm:RIA_META_Metamodel)
           WHERE v.name = $name AND mm.name = $mm
           CREATE (v)-[:RIA_UNIV_VIEW_CATEGORIZEDBY]->(mm)`,
          { name, mm },
        );
      }
      viewsRestored++;
    }
    totalRecordsImported += viewsRestored;
    logger.debug(`universe: restored ${viewsRestored} view definition(s), skipped ${viewsSkipped.length}`);
  }

  // ── Rewire the edges of the layers this run skipped ───────────────────────
  // Must run after the namespace loop, so every endpoint node exists again, and
  // before the cross-namespace import, which is unaffected by it.
  if (skippedEdges) {
    await rewireSkippedLayerEdges(dbModule, skippedEdges, logger);
  }

  // Cross-namespace layer
  emitProgress(params.onProgress, { phase: 'cross_namespace', message: 'Importing cross-namespace instances...' }, logger);
  const nsRelPath = path.join(exportDir, 'cross_namespace', 'RIA_UNIV_NamespaceRelation.json');
  if (plan.crossNamespace && fs.existsSync(nsRelPath)) {
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

  for (const { file, rel } of plan.crossNamespace ? [
    { file: 'RIA_UNIV_NSR_SOURCE.json', rel: 'RIA_UNIV_NSR_SOURCE' },
    { file: 'RIA_UNIV_NSR_TARGET.json', rel: 'RIA_UNIV_NSR_TARGET' },
  ] : []) {
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

  if (plan.crossNamespace && fs.existsSync(crossNsInstPath)) {
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

  // ── Record D — the file version this database was synced from (task 5.1) ──
  // From the manifest values this load just read, plus the digest of the exact
  // manifest bytes it read. One of only two moments where the system may claim
  // the database and the files agree; the other is the end of a store.
  //
  // Written for the whole origin key space even when the plan skipped a layer.
  // That is correct rather than sloppy: a skipped layer was skipped BECAUSE its
  // D already equalled its M, so re-recording the same value changes nothing,
  // and recording only the loaded keys would delete the others (the write is a
  // wholesale replacement, by design — see writeSnapshotOrigin).
  await writeSnapshotOrigin(
    dbModule,
    originFromManifest(manifest, manifestBytes),
    logger,
  );

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
    ...(viewsSkipped.length > 0 ? { views_skipped: viewsSkipped } : {}),
  };
}
