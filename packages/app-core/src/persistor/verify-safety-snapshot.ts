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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IDbModule } from '../db/db-module.js';
import type { Manifest } from './persistor-types.js';
import { evaluateSyncStates } from '../workspace/sync-evaluation.js';
import { parseTable, serializeRecord } from './serializer.js';
import { loadAttributeMetadata, normalizeRow } from './persistor-helpers.js';
import { resolveStableIdFromMeta, replaceNodeIdsWithStableIds } from './stable-id.js';
import { getTablesByLayer } from './table-registry.js';

/** Native filesystem containment; manifest carrier names remain relative. */
export function resolveSnapshotPath(root: string, carrier: string, paths: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'> = path): string {
  const resolved = paths.resolve(root, carrier);
  const relative = paths.relative(root, resolved);
  if (relative.startsWith(`..${paths.sep}`) || relative === '..' || paths.isAbsolute(relative)) throw new Error('Snapshot carrier escapes ria-data');
  return resolved;
}

function sameRecords(label: string, actual: Record<string, unknown>[], expected: Record<string, unknown>[], json = ['attributes'], omit: string[] = []) {
  const canonical = (rows: Record<string, unknown>[]) => rows.map(row => serializeRecord(row, json, omit)).sort();
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) throw new Error(`Saved snapshot differs from the graph: ${label}`);
}

/** Independent file readback: hashes alone cannot detect a consistently omitted
 * object or relationship. Compare complete safety carriers with the frozen graph. */
export async function verifySafetySnapshot(workingDir: string, db: IDbModule): Promise<void> {
  const root = path.join(workingDir, 'ria-data');
  const bytes = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(bytes) as Manifest;
  const evaluation = await evaluateSyncStates(workingDir, manifest, bytes, db);
  if (evaluation.epochSuspended || evaluation.entries.some(entry => entry.state !== 'S1')) {
    throw new Error('Saved snapshot manifest/content consistency check failed');
  }
  const namespaces = await db.runQuery('MATCH (n:RIA_UNIV_Namespace) RETURN n.name AS name');
  if (JSON.stringify(namespaces.map(row => row.name).sort()) !== JSON.stringify(manifest.namespaces.map(ns => ns.name).sort())) throw new Error('Saved snapshot namespace membership differs from graph');
  const { nodeKeyAttrs } = await loadAttributeMetadata(db);
  const identities = new Map<number, string>();
  for (const ns of manifest.namespaces) {
    // Manifest directories are snapshot-relative model carriers, not absolute paths.
    const directory = resolveSnapshotPath(root, ns.directory);
    const concepts = await db.runQuery(`MATCH (ci:RIA_UNIV_ConceptInstance) WHERE ci.namespace = $namespace
      RETURN ci.node_id AS node_id, ci.namespace AS namespace, ci.concept AS concept, ci.metamodel AS metamodel, ci.attributes AS attributes`, { namespace: ns.name });
    const seen = new Set<string>();
    for (const row of concepts) {
      const stable = resolveStableIdFromMeta(String(row.attributes), String(row.concept), nodeKeyAttrs);
      if (!stable || seen.has(stable)) throw new Error(`Missing or ambiguous stable identity in ${ns.name}`);
      seen.add(stable); identities.set(Number(row.node_id), stable);
    }
    const readSection = (section: string) => fs.readdirSync(path.join(directory, section))
      .filter(name => name.endsWith('.json')).flatMap(name => parseTable(fs.readFileSync(path.join(directory, section, name), 'utf8')));
    sameRecords(`${ns.name} concepts`, readSection('concepts'), concepts, ['attributes'], ['node_id']);
    const relationships = await db.runQuery(`MATCH (ri:RIA_UNIV_RelationshipInstance) WHERE ri.namespace = $namespace
      RETURN ri.namespace AS namespace, ri.relationship AS relationship, ri.metamodel AS metamodel,
      ri.source_node_id AS source_node_id, ri.target_node_id AS target_node_id, ri.attributes AS attributes`, { namespace: ns.name });
    const expected = relationships.map(row => {
      const source = identities.get(Number(row.source_node_id));
      const target = identities.get(Number(row.target_node_id));
      if (!source || !target) throw new Error(`Unresolved relationship endpoint in ${ns.name}`);
      return replaceNodeIdsWithStableIds(row, source, target);
    });
    sameRecords(`${ns.name} relationships`, readSection('relationships'), expected);
  }
  for (const table of getTablesByLayer('cross_namespace')) {
    const rows = table.customQuery ? await db.runQuery(table.customQuery)
      : (await db.runQuery(`MATCH (n:${table.name}) RETURN n.*`)).map(normalizeRow);
    const saved = parseTable(fs.readFileSync(path.join(root, 'cross_namespace', `${table.name}.json`), 'utf8'));
    sameRecords(table.name, saved, rows, table.jsonColumns, table.omitColumns);
  }
  // All declared carriers must exist and contain the recorded number of rows.
  for (const [file, count] of Object.entries(manifest.file_inventory)) {
    const resolved = resolveSnapshotPath(root, file);
    if (parseTable(fs.readFileSync(resolved, 'utf8')).length !== count) throw new Error(`Snapshot inventory count mismatch: ${file}`);
  }
}
