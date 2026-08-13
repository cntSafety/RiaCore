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
 * Namespace loader — produces a SerializedNamespace from either a live
 * graph database or from a serialized ria-data/ export directory on disk.
 *
 * Reuses the same DB query patterns as persistor-store.ts and the same
 * file-reading patterns as persistor-load.ts, without writing to or
 * reading from the full persistor file hierarchy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IDbModule } from '../db/db-module.js';
import { loadAttributeMetadata, loadAttributeMetadataFromFiles } from '../persistor/persistor-helpers.js';
import { resolveStableIdFromMeta, replaceNodeIdsWithStableIds } from '../persistor/stable-id.js';
import { parseTable } from '../persistor/serializer.js';
import { sanitizeDirectoryName } from '../persistor/sanitize-directory.js';
import type { SerializedNamespace } from './diff-types.js';

// ── Live namespace loading ─────────────────────────────────────────────────────

/**
 * Query a single namespace from the live database and return it in the
 * same stable-ID-based in-memory format that the persistor uses for serialization.
 */
export async function loadLiveNamespace(
  namespace: string,
  dbModule: IDbModule,
): Promise<SerializedNamespace> {
  // Load attribute metadata (identity attrs per concept type)
  const { nodeKeyAttrs, edgeKeyAttrs } = await loadAttributeMetadata(dbModule);

  // Verify the namespace exists and retrieve its metamodel
  const nsRows = await dbModule.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace {name: $namespace})
     RETURN ns.metamodel AS metamodel`,
    { namespace },
  );
  if (nsRows.length === 0) {
    throw new Error(`Namespace '${namespace}' not found in the live database`);
  }
  const metamodel = String(nsRows[0]?.metamodel ?? '');

  // Query concept instances
  const conceptInstances = await dbModule.runQuery(
    `MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
     RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept,
            ci.metamodel AS metamodel, ci.attributes AS attributes
     ORDER BY ci.node_id`,
    { namespace },
  );

  // Query relationship instances
  const relationshipInstances = await dbModule.runQuery(
    `MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = $namespace
     RETURN ri.namespace AS namespace, ri.relationship AS relationship,
            ri.metamodel AS metamodel, ri.source_node_id AS source_node_id,
            ri.target_node_id AS target_node_id, ri.attributes AS attributes`,
    { namespace },
  );

  // Query cross-namespace edges where this namespace is the source
  const crossNsEdgesAsSource = await dbModule.runQuery(
    `MATCH (x:RIA_UNIV_CrossNSRelationshipInstance) WHERE x.source_namespace = $namespace
     RETURN x.source_namespace AS source_namespace,
            x.target_namespace AS target_namespace, x.metamodel AS metamodel,
            x.relationship AS relationship, x.source_node_id AS source_node_id,
            x.target_node_id AS target_node_id, x.attributes AS attributes`,
    { namespace },
  );

  // Build node_id → stableId lookup
  const nodeIdToStableId = new Map<number, string>();
  for (const ci of conceptInstances) {
    const nodeId = Number(ci.node_id);
    let stableId = '';
    try {
      stableId = resolveStableIdFromMeta(
        String(ci.attributes ?? '{}'),
        String(ci.concept ?? ''),
        nodeKeyAttrs,
      );
    } catch {
      // Concept type not in metadata — stableId stays ''
    }
    if (stableId !== '') nodeIdToStableId.set(nodeId, stableId);
  }

  // Replace ephemeral IDs with stable IDs in relationship instances
  const relInstancesWithStableIds = relationshipInstances.map(ri => {
    const sourceStableId = nodeIdToStableId.get(Number(ri.source_node_id)) ?? '';
    const targetStableId = nodeIdToStableId.get(Number(ri.target_node_id)) ?? '';
    return replaceNodeIdsWithStableIds(ri, sourceStableId, targetStableId);
  });

  // Replace ephemeral IDs with stable IDs in cross-namespace edges
  const crossNsWithStableIds = crossNsEdgesAsSource.map(x => {
    const sourceStableId = nodeIdToStableId.get(Number(x.source_node_id)) ?? '';
    // For cross-NS edges the target is in another namespace — we use the stored
    // target_node_id to find the stable ID in the target namespace's own lookup.
    // At this point we only know the source namespace's lookup, so we resolve
    // the source. The target's stable_id is stored in the edge's attributes
    // as `target_external_id` by the import writer, if available.
    const attrs = parseEdgeAttributes(x.attributes);
    const targetStableId =
      typeof attrs['target_external_id'] === 'string'
        ? attrs['target_external_id']
        : '';
    const { source_node_id: _s, target_node_id: _t, ...rest } = x;
    return {
      ...rest,
      source_stable_id: sourceStableId,
      target_stable_id: targetStableId,
    };
  });

  return {
    namespace,
    metamodel,
    conceptInstances,
    relationshipInstances: relInstancesWithStableIds,
    crossNsEdgesAsSource: crossNsWithStableIds,
    nodeKeyAttrs,
    edgeKeyAttrs,
  };
}

// ── Snapshot namespace loading ─────────────────────────────────────────────────

/**
 * Read a namespace from a serialized ria-data/ export directory and return it
 * in the stable-ID-based in-memory format.
 *
 * This does NOT require a running database — it reads only from JSON files.
 */
export function loadSnapshotNamespace(
  exportDir: string,
  namespace: string,
): SerializedNamespace {
  // Load attribute metadata from the meta/ layer JSON files
  const { nodeKeyAttrs, edgeKeyAttrs } = loadAttributeMetadataFromFiles(exportDir);

  // Find the namespace directory (the persistor sanitizes namespace names)
  const nsDir = findNamespaceDir(exportDir, namespace);
  if (!nsDir) {
    throw new Error(
      `Namespace '${namespace}' not found in export directory '${exportDir}'. ` +
      `Expected a subdirectory named '${sanitizeDirectoryName(namespace)}' or listed in manifest.json.`,
    );
  }

  // Load namespace.json for metamodel info
  const namespaceMeta = loadNamespaceMeta(nsDir, namespace);
  const metamodel = String(namespaceMeta.metamodel ?? '');

  // Load concept instances from nsDir/concepts/<ConceptType>.json
  // (The persistor writes one file per concept type under a concepts/ subdirectory,
  // not a single flat RIA_UNIV_ConceptInstance.json.)
  const conceptInstances: Record<string, unknown>[] = loadConceptInstances(nsDir);

  // Load relationship instances from nsDir/relationships/<RelType>.json
  // (The persistor writes one file per relationship type under a relationships/
  // subdirectory, not flat JSON files directly in the namespace directory.)
  const relationshipInstances = loadRelationshipInstances(nsDir);

  // Load cross-namespace edges from the shared cross_namespace/ directory at the
  // ria-data root — they are NOT stored inside the per-namespace directory.
  // Filter to edges where this namespace is the source and extract stable IDs
  // from attributes.source_external_id / attributes.target_external_id.
  const crossNsEdgesAsSource: Record<string, unknown>[] = loadCrossNsEdgesForNamespace(
    exportDir,
    namespace,
  );

  return {
    namespace,
    metamodel,
    conceptInstances,
    relationshipInstances,
    crossNsEdgesAsSource,
    nodeKeyAttrs,
    edgeKeyAttrs,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parseEdgeAttributes(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>; } catch { return {}; }
}

function findNamespaceDir(exportDir: string, namespace: string): string | null {
  // First try the sanitized name directly
  const sanitized = sanitizeDirectoryName(namespace);
  const directPath = path.join(exportDir, sanitized);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    return directPath;
  }

  // Fall back: look in manifest.json
  const manifestPath = path.join(exportDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        namespaces?: Array<{ name: string; directory: string }>;
      };
      const entry = manifest.namespaces?.find(n => n.name === namespace);
      if (entry) {
        const entryPath = path.join(exportDir, entry.directory);
        if (fs.existsSync(entryPath)) return entryPath;
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

function loadNamespaceMeta(nsDir: string, namespace: string): Record<string, unknown> {
  const nsJsonPath = path.join(nsDir, 'namespace.json');
  if (fs.existsSync(nsJsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(nsJsonPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // fallback below
    }
  }
  return { namespace };
}

/**
 * Load all concept instances for a namespace from the concepts/ subdirectory.
 * The persistor writes one file per concept type: nsDir/concepts/<ConceptType>.json.
 */
function loadConceptInstances(nsDir: string): Record<string, unknown>[] {
  const conceptsDir = path.join(nsDir, 'concepts');
  const results: Record<string, unknown>[] = [];
  if (!fs.existsSync(conceptsDir)) return results;
  for (const entry of fs.readdirSync(conceptsDir)) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(conceptsDir, entry);
    try {
      results.push(...parseTable(fs.readFileSync(filePath, 'utf-8')));
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

/**
 * Load all relationship instances for a namespace from the relationships/ subdirectory.
 * The persistor writes one file per relationship type: nsDir/relationships/<RelType>.json.
 * Each record already has source_stable_id and target_stable_id (the persistor strips
 * the ephemeral node IDs and replaces them before writing).
 */
function loadRelationshipInstances(nsDir: string): Record<string, unknown>[] {
  const relsDir = path.join(nsDir, 'relationships');
  const results: Record<string, unknown>[] = [];
  if (!fs.existsSync(relsDir)) return results;
  for (const entry of fs.readdirSync(relsDir)) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(relsDir, entry);
    try {
      results.push(...parseTable(fs.readFileSync(filePath, 'utf-8')));
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

/**
 * Load cross-namespace edges for a specific namespace from the shared
 * cross_namespace/ directory at the ria-data root.
 *
 * The persistor stores ALL cross-namespace edges in a single file:
 *   exportDir/cross_namespace/RIA_UNIV_CrossNSRelationshipInstance.json
 * with columns: source_namespace, target_namespace, metamodel, relationship, attributes.
 * The stable IDs are encoded inside attributes as source_external_id / target_external_id.
 * We filter by source_namespace and promote them to top-level source_stable_id /
 * target_stable_id fields as expected by buildCrossNsEdgeMap.
 */
function loadCrossNsEdgesForNamespace(
  exportDir: string,
  namespace: string,
): Record<string, unknown>[] {
  const crossNsPath = path.join(exportDir, 'cross_namespace', 'RIA_UNIV_CrossNSRelationshipInstance.json');
  if (!fs.existsSync(crossNsPath)) return [];
  try {
    const allEdges = parseTable(fs.readFileSync(crossNsPath, 'utf-8'));
    return allEdges
      .filter(e => String(e.source_namespace ?? '') === namespace)
      .map(e => {
        const attrs = parseEdgeAttributes(e.attributes);
        const sourceStableId =
          typeof attrs['source_external_id'] === 'string' ? attrs['source_external_id'] : '';
        const targetStableId =
          typeof attrs['target_external_id'] === 'string' ? attrs['target_external_id'] : '';
        return {
          ...e,
          source_stable_id: sourceStableId,
          target_stable_id: targetStableId,
        };
      });
  } catch {
    return [];
  }
}
