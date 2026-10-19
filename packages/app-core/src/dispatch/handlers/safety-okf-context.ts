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
import type { SafetyExportData } from '@riacore/app-contracts';
import type { ServiceDependencies } from '../types.js';
import { extractNodeName } from '../utils/node-name.js';

/** Database keys are lookup handles only. The generator never serializes them. */
export interface OkfSourceNode {
  nodeId: number;
  namespace: string;
  concept: string;
  metamodel: string;
  stableId: string;
  /** Native identifier: ARXML/authored uuid, or the SysML source identifier. */
  uuid?: string;
  sysmlId?: string;
  elementId?: string;
  sourcePath?: string;
  direction?: string;
  name: string;
}

export interface SafetyOkfContext {
  metamodel: string;
  metamodelVersion: string;
  nodes: Map<number, OkfSourceNode>;
  parents: Map<number, number>;
  occursAt: Map<number, number>;
  recordHosts: Map<number, Set<number>>;
}

function attrs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return JSON.parse(String(value || '{}')) as Record<string, unknown>;
}

export function collectOkfNodeIds(data: SafetyExportData): Set<number> {
  const ids = new Set<number>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'nodeId' && typeof child === 'number' && child >= 0) ids.add(child);
      else visit(child);
    }
  }
  visit(data);
  return ids;
}

/** Enrich the common report data without changing the report collector or graph. */
export async function loadSafetyOkfContext(
  data: SafetyExportData, deps: ServiceDependencies,
): Promise<SafetyOkfContext> {
  const db = deps.dbModule;
  const metadata = await db.runQuery(
    `MATCH (ns:RIA_UNIV_Namespace) WHERE ns.name = $namespace
     OPTIONAL MATCH (m:RIA_META_Metamodel) WHERE m.name = ns.metamodel
     RETURN ns.namespace_owning_application AS application, ns.metamodel AS metamodel, m.version AS version`,
    { namespace: data.namespace },
  );
  if (metadata.length !== 1 || metadata[0].application !== 'Safety-Analysis') {
    throw new Error('OKF export requires a Safety-Analysis namespace.');
  }
  const context: SafetyOkfContext = {
    metamodel: String(metadata[0].metamodel), metamodelVersion: String(metadata[0].version || ''),
    nodes: new Map(), parents: new Map(), occursAt: new Map(), recordHosts: new Map(),
  };
  const ids = collectOkfNodeIds(data);
  const occurrences = await db.runQuery(
    `MATCH (fm:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_CROSSNS_INSTANCE_REL]->(target:RIA_UNIV_ConceptInstance)
     WHERE fm.namespace = $namespace AND fm.concept = 'malfunction' AND r.relationship = 'occurs_at'
     RETURN fm.node_id AS malfunction, target.node_id AS target`, { namespace: data.namespace },
  );
  for (const row of occurrences) {
    const fm = Number(row.malfunction), target = Number(row.target);
    if (context.occursAt.has(fm) && context.occursAt.get(fm) !== target) {
      throw new Error('A malfunction has conflicting multiple occurs_at locations. Resolve its location before exporting OKF.');
    }
    context.occursAt.set(fm, target);
    ids.add(target);
  }
  // Preserve the actual host of notes/tags (including port hosts), rather than
  // guessing from the collector's display-only appliesTo field.
  for (const table of ['RIA_UNIV_CROSSNS_INSTANCE_REL', 'RIA_UNIV_INSTANCE_REL']) {
    const hosts = await db.runQuery(
      `MATCH (host:RIA_UNIV_ConceptInstance)-[r:${table}]->(record:RIA_UNIV_ConceptInstance)
       WHERE record.namespace = $namespace AND record.concept IN ['safety_note', 'tag']
         AND r.relationship IN ['has_notes', 'has_tag']
       RETURN host.node_id AS host, record.node_id AS record`, { namespace: data.namespace },
    );
    for (const row of hosts) {
      const record = Number(row.record), host = Number(row.host);
      if (!ids.has(record)) continue;
      if (!context.recordHosts.has(record)) context.recordHosts.set(record, new Set());
      context.recordHosts.get(record)!.add(host);
      ids.add(host);
    }
  }
  const containment = await db.runQuery(
    'MATCH (r:RIA_META_Relationship) WHERE r.is_containment = true RETURN r.metamodel AS metamodel, r.name AS name',
  );
  const allowed = new Set(containment.map(row => `${row.metamodel}\0${row.name}`));
  const relationships = [...new Set(containment.map(row => String(row.name)))];
  let pending = [...ids];
  for (let depth = 0; pending.length; depth++) {
    if (depth > 64) throw new Error('Structural ancestry is cyclic or exceeds 64 levels; cannot export OKF.');
    const rows = await db.runQuery(
      `MATCH (n:RIA_UNIV_ConceptInstance) WHERE n.node_id IN $ids
       RETURN n.node_id AS node_id, n.namespace AS namespace, n.concept AS concept,
              n.metamodel AS metamodel, n.attributes AS attributes`, { ids: pending },
    );
    for (const row of rows) {
      const a = attrs(row.attributes);
      const identifier = (key: string) => typeof a[key] === 'string' && (a[key] as string).trim()
        ? (a[key] as string).trim() : undefined;
      const sysmlId = identifier('sysml_id'), elementId = identifier('element_id');
      const uuid = identifier('uuid') || sysmlId || elementId;
      const stableId = uuid || identifier('stable_path');
      const name = extractNodeName(a, String(row.concept));
      if (!stableId) throw new Error(`Missing persistent identity for ${String(row.namespace)} / ${name || String(row.concept)}. Store or reimport this record before exporting OKF.`);
      context.nodes.set(Number(row.node_id), {
        nodeId: Number(row.node_id), namespace: String(row.namespace), concept: String(row.concept),
        metamodel: String(row.metamodel), stableId, name, uuid, sysmlId, elementId,
        sourcePath: typeof a.stable_path === 'string' ? a.stable_path : undefined,
        direction: typeof a.direction === 'string' ? a.direction : undefined,
      });
    }
    if (pending.some(id => !context.nodes.has(id))) throw new Error('Cannot resolve a source record needed by the OKF export.');
    const parents = relationships.length ? await db.runQuery(
      `MATCH (parent:RIA_UNIV_ConceptInstance)-[r:RIA_UNIV_INSTANCE_REL]->(child:RIA_UNIV_ConceptInstance)
       WHERE child.node_id IN $ids AND r.relationship IN $relationships
       RETURN parent.node_id AS parent, parent.namespace AS namespace, child.node_id AS child,
              child.metamodel AS metamodel, r.relationship AS relationship`, { ids: pending, relationships },
    ) : [];
    const next = new Set<number>();
    for (const row of parents) {
      const child = Number(row.child), parent = Number(row.parent);
      if (!allowed.has(`${row.metamodel}\0${row.relationship}`) || context.nodes.get(child)?.namespace !== row.namespace || context.nodes.get(child)?.namespace === data.namespace) continue;
      if (context.parents.has(child) && context.parents.get(child) !== parent) {
        throw new Error(`Conflicting structural parents for ${context.nodes.get(child)!.name}; cannot select an OKF hierarchy.`);
      }
      context.parents.set(child, parent);
      if (!context.nodes.has(parent)) next.add(parent);
    }
    pending = [...next];
  }
  return context;
}
