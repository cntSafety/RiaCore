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
import type { CheckElementReference, CheckFinding, CheckFindingEndpoint, UserCheckDefinition } from '@riacore/app-contracts';

interface Element {
  id: number;
  namespace: string;
  concept: string;
  attributes: Record<string, unknown>;
}
export interface EvaluatedCheckRows {
  nodeIds: number[];
  findings: Record<number, CheckFinding[]>;
  computedAttributes: Record<number, Record<string, string>>;
}
const payloads = new Set(['item_usage', 'reference_usage', 'attribute_usage', 'port_usage']);
const connectors = new Set(['connection_usage', 'interface_usage', 'flow_usage', 'binding_connector_as_usage']);
const levels = ['QM', 'A', 'B', 'C', 'D'];

/** Profile-permitted labels; compare the allocated leading level, as the R/P check does. */
function allocation(value: unknown): { rank: number; label: string } | undefined {
  if (typeof value !== 'string') return;
  const rank = levels.indexOf(value);
  if (rank >= 0) return { rank, label: value };
  const decomposed = /^(QM|A|B|C|D)\((A|B|C|D)\)$/.exec(value);
  if (!decomposed) return;
  const allocated = levels.indexOf(decomposed[1]); const original = levels.indexOf(decomposed[2]);
  if (allocated <= original) return { rank: allocated, label: value };
}

function attributes(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Evaluate one immutable fact result from the read-only SysML default query. */
export function evaluateSysmlPortAsil(
  rows: Record<string, unknown>[],
  evaluator: NonNullable<UserCheckDefinition['evaluator']>,
): EvaluatedCheckRows {
  const nodes = new Map<number, Element>();
  const outgoing = new Map<number, Map<string, Set<number>>>();
  const incomingChains = new Map<number, Set<number>>();
  const incomingOwners = new Map<number, Set<number>>();
  const allocations = new Map<number, Map<number, unknown>>();
  for (const row of rows) {
    const source = Number(row.sourceId); const target = Number(row.targetId);
    if (!['node', 'edge', 'allocation'].includes(String(row.rowType)) || !Number.isSafeInteger(source) || source < 0
      || !Number.isSafeInteger(target) || target < (row.rowType === 'node' ? -1 : 0)
      || typeof row.namespace !== 'string' || !row.namespace || typeof row.concept !== 'string') {
      throw new Error('Invalid SysML ASIL fact query result');
    }
    if (row.rowType === 'node') {
      nodes.set(source, { id: source, namespace: String(row.namespace), concept: String(row.concept), attributes: attributes(row.attributes) });
    } else if (row.rowType === 'edge') {
      let relationships = outgoing.get(source);
      if (!relationships) outgoing.set(source, relationships = new Map());
      const relationship = String(row.relationship);
      let targets = relationships.get(relationship);
      if (!targets) relationships.set(relationship, targets = new Set());
      targets.add(target);
      if (relationship === 'owns_element') {
        let owners = incomingOwners.get(target);
        if (!owners) incomingOwners.set(target, owners = new Set());
        owners.add(source);
      }
      if (row.concept === 'feature_chaining' && relationship === 'references_source') {
        let chains = incomingChains.get(target);
        if (!chains) incomingChains.set(target, chains = new Set());
        chains.add(source);
      }
    } else if (row.rowType === 'allocation') {
      let values = allocations.get(target);
      if (!values) allocations.set(target, values = new Map());
      values.set(source, attributes(row.attributes).malfunction_asil);
    }
  }
  const targets = (id: number, ...relationships: string[]): number[] =>
    [...new Set(relationships.flatMap(relationship => [...outgoing.get(id)?.get(relationship) ?? []]))];
  const shortName = (node: Element) => String(node.attributes.name ?? node.attributes.declared_name
    ?? String(node.attributes.qualified_name ?? '').split('::').at(-1) ?? '').trim()
    || `Unnamed ${node.concept.replace(/_/g, ' ')}`;
  const named = (node: Element) => String(node.attributes.qualified_name ?? '').trim() || shortName(node);
  const reference = (node: Element): CheckElementReference => ({ nodeId: node.id, namespace: node.namespace, concept: node.concept, label: named(node) });
  const ownerOf = (id: number) => {
    const owners = [...incomingOwners.get(id) ?? []].map(id => nodes.get(id)!).filter(Boolean);
    return owners.length === 1 ? owners[0] : undefined;
  };
  const baseTypes = (id: number) => targets(id, 'has_type', 'has_definition')
    .filter(target => nodes.get(target)?.concept === 'port_definition');
  const rank = (id: number) => {
    const values = [...allocations.get(id)?.values() ?? []];
    const parsed = values.map(allocation);
    const maximum = parsed.reduce((maximum, value) => Math.max(maximum, value?.rank ?? -1), -1);
    const label = [...new Set(parsed.filter(value => value?.rank === maximum).map(value => value!.label))].sort().join(' / ');
    return { valid: parsed.length > 0 && parsed.every(value => value !== undefined), rank: maximum, label,
      missing: values.length === 0, invalid: values.filter((_, index) => !parsed[index]).map(value => value == null || value === '' ? '<missing ASIL>' : JSON.stringify(value)) };
  };
  interface ResolvedEnd { port?: Element; owner?: Element; supported: boolean; problem?: string }
  const resolvePort = (id: number, namespace: string): ResolvedEnd => {
    let endpoint = nodes.get(id);
    if (!endpoint || endpoint.namespace !== namespace) return { supported: false, problem: 'Endpoint reference is missing from this architecture.' };
    if (endpoint.concept === 'port_usage') return { port: endpoint, supported: true };
    if (endpoint.concept === 'reference_usage') {
      const features = targets(id, 'owns_element').filter(target => nodes.get(target)?.concept === 'feature');
      if (features.length !== 1) return { supported: false, problem: `Endpoint reference contains ${features.length} feature paths; one is required.` };
      endpoint = nodes.get(features[0])!;
    }
    if (endpoint.concept !== 'feature') return { supported: false, problem: `Endpoint is a ${endpoint.concept.replace(/_/g, ' ')}, rather than a port.` };
    const members = [...new Set([...incomingChains.get(endpoint.id) ?? []]
      .flatMap(chain => targets(chain, 'chains_feature')))];
    const ports = members.filter(member => nodes.get(member)?.concept === 'port_usage');
    const owners = members.filter(member => ['part_usage', 'part_definition'].includes(nodes.get(member)?.concept ?? ''));
    const supported = ports.length === 1 && owners.length <= 1 && members.length === ports.length + owners.length;
    return { port: ports.length === 1 ? nodes.get(ports[0]) : undefined,
      owner: owners.length === 1 ? nodes.get(owners[0]) : undefined, supported,
      ...(!supported ? { problem: `Feature path resolves to ${ports.length} ports and ${owners.length} part contexts; a single unambiguous port path is required.` } : {}) };
  };
  const endpointEvidence = (end: ResolvedEnd, index: number): CheckFindingEndpoint => {
    if (!end.port) return { label: `Unresolved endpoint ${index + 1}`, path: `Unresolved endpoint ${index + 1}`,
      ...(end.owner ? { owner: reference(end.owner) } : {}), analysisStatus: 'unresolved' };
    const port = end.port; const analysis = rank(port.id);
    const path = end.owner ? `${named(end.owner)}.${shortName(port)}` : named(port);
    const label = end.owner ? `${shortName(end.owner)}.${shortName(port)}` : path.split('::').slice(-2).join('.');
    return { label, path, port: reference(port), owner: end.owner ? reference(end.owner) : ownerOf(port.id) ? reference(ownerOf(port.id)!) : undefined,
      ...(analysis.valid ? { asil: analysis.label } : {}), analysisStatus: analysis.missing ? 'missing' : analysis.valid ? 'known' : 'invalid' };
  };
  const directions = (p: Element, q: Element): [boolean, boolean] => {
    const pd = p.attributes.direction; const qd = q.attributes.direction;
    if (['in', 'out', 'inout'].includes(String(pd)) && ['in', 'out', 'inout'].includes(String(qd))) {
      return [pd !== 'in' && qd !== 'out', qd !== 'in' && pd !== 'out'];
    }
    if ((pd !== undefined && pd !== null && pd !== '') || (qd !== undefined && qd !== null && qd !== '')) return [false, false];
    const pc = p.attributes.effective_is_conjugated; const qc = q.attributes.effective_is_conjugated;
    if (typeof pc !== 'boolean' || typeof qc !== 'boolean' || pc === qc) return [false, false];
    const pt = baseTypes(p.id); const qt = baseTypes(q.id);
    if (pt.length !== 1 || qt.length !== 1 || pt[0] !== qt[0]) return [false, false];
    if (baseTypes(pt[0]).length || targets(pt[0], 'specializes').some(id => nodes.get(id)?.concept === 'port_definition')) return [false, false];
    if ([p, q].some(port => targets(port.id, 'owns_element').some(id => payloads.has(nodes.get(id)?.concept ?? '')))) return [false, false];
    const features = targets(pt[0], 'owns_element').map(id => nodes.get(id)!)
      .filter(node => node && payloads.has(node.concept));
    const values = features.map(node => node.attributes.direction);
    const mixed = values.includes('in') && values.includes('out')
      && values.every(value => ['in', 'out', 'inout'].includes(String(value)));
    return [mixed, mixed];
  };

  const findings = new Map<number, CheckFinding[]>();
  const add = (id: number, finding: CheckFinding) => {
    let entries = findings.get(id);
    if (!entries) findings.set(id, entries = []);
    if (!entries.some(entry => entry.connection.nodeId === finding.connection.nodeId && entry.code === finding.code
      && entry.message === finding.message)) entries.push(finding);
  };
  for (const connector of nodes.values()) {
    if (!connectors.has(connector.concept)) continue;
    const explicit = targets(connector.id, 'references_source', 'references_target');
    const ends = explicit.length ? explicit : targets(connector.id, 'connects');
    const resolved = ends.map(id => resolvePort(id, connector.namespace));
    const endpoints = resolved.map(endpointEvidence);
    const connection = reference(connector);
    const context = ownerOf(connector.id);
    const base = { connection, ...(context ? { context: reference(context) } : {}), endpoints };
    let problem: Pick<CheckFinding, 'category' | 'code' | 'message' | 'nextStep'> | undefined;
    if (connector.concept === 'binding_connector_as_usage') {
      problem = { category: 'unsupported', code: 'unsupported-binding',
        message: 'ASIL comparison for binding connections is not supported; no comparison was performed.',
        nextStep: 'Inspect the endpoint ports in Model. This is a limitation of the check and does not establish an ASIL error.' };
    } else if (ends.length !== 2) {
      problem = { category: 'unresolved', code: 'nonbinary-connection',
        message: `Connection has ${ends.length} endpoint references; this check requires exactly two.`,
        nextStep: 'Inspect the connection in its owning model context and review the endpoint references.' };
    } else if (resolved.some(end => !end.supported) || resolved[0].port!.id === resolved[1].port!.id) {
      problem = { category: 'unresolved', code: 'unresolved-endpoint',
        message: resolved.some(end => !end.supported)
          ? resolved.flatMap((end, index) => end.problem ? [`Endpoint ${index + 1}: ${end.problem}`] : []).join(' ')
          : 'Both endpoint references resolve to the same port declaration; the transfer cannot be assessed.',
        nextStep: 'Inspect the known ports or owning model context. Review the imported endpoint paths; this check cannot choose an ambiguous port or usage.' };
    } else {
      const [p, q] = resolved.map(end => end.port!) as [Element, Element];
      const [pToQ, qToP] = directions(p, q);
      const pr = rank(p.id); const qr = rank(q.id);
      if (!(pToQ || qToP)) {
        const typed = [p, q].map(port => baseTypes(port.id));
        const missingConjugation = [p, q].some(port => typeof port.attributes.effective_is_conjugated !== 'boolean');
        const inherited = typed.flat().some(id => baseTypes(id).length || targets(id, 'specializes').some(id => nodes.get(id)?.concept === 'port_definition'));
        const overridden = [p, q].some(port => targets(port.id, 'owns_element').some(id => payloads.has(nodes.get(id)?.concept ?? '')));
        const scalar = [p, q].every(port => ['in', 'out', 'inout'].includes(String(port.attributes.direction)));
        if (scalar) {
          problem = { category: 'unresolved', code: 'incompatible-directions',
            message: `Port directions (${p.attributes.direction} / ${q.attributes.direction}) do not establish a producer-to-consumer transfer.`,
            nextStep: 'Review the declared feature directions on both ports.' };
        } else if (inherited || overridden) {
          problem = { category: 'unsupported', code: 'unsupported-port-definition',
            message: 'Direction depends on inherited port definitions or usage-owned feature overrides, which this check does not resolve.',
            nextStep: 'Inspect the effective port features in Model. This check currently supports only immediate, unmodified port definitions.' };
        } else if (missingConjugation) {
          problem = { category: 'unresolved', code: 'missing-conjugation',
            message: 'Mixed-port direction cannot be resolved because effective conjugation information is missing.',
            nextStep: 'Re-import older SysML models with an importer that preserves effective conjugation, then rerun this check.' };
        } else if (typed.some(types => types.length !== 1) || typed[0][0] !== typed[1][0]) {
          problem = { category: 'unresolved', code: 'unresolved-port-type',
            message: 'The ports do not resolve to one shared original port definition for mixed-direction assessment.',
            nextStep: 'Inspect the port types and the imported original-definition links.' };
        } else {
          problem = { category: 'unresolved', code: 'unresolved-direction',
            message: 'The port definitions, feature directions and effective conjugation do not establish a supported transfer.',
            nextStep: 'Inspect both ports and their immediate payload directions. A bidirectional drawing alone does not establish data direction.' };
        }
      } else if (!pr.valid || !qr.valid) {
        problem = { category: 'analysis', code: [pr, qr].some(r => !r.missing && !r.valid) ? 'invalid-asil' : 'missing-analysis',
          message: [pr, qr].flatMap((r, index) => r.valid ? [] : [r.missing
            ? `No port malfunctions are linked to ${endpoints[index].path} in the selected analysis.`
            : `Invalid or missing ASIL on ${endpoints[index].path}: ${r.invalid.join(', ')}.`]).join(' '),
          nextStep: 'Review the affected port malfunctions in the selected analysis. Assign an explicit valid ASIL, including QM where appropriate; missing analysis is not QM.' };
      } else if (evaluator === 'sysml-port-asil-consistency') {
        for (const [producer, consumer, producerAllocation, consumerAllocation, transfer] of [
          [0, 1, pr, qr, pToQ], [1, 0, qr, pr, qToP],
        ] as const) {
          if (transfer && consumerAllocation.rank > 0 && producerAllocation.rank < consumerAllocation.rank) {
            add(resolved[consumer].port!.id, { ...base, endpoints: [endpoints[producer], endpoints[consumer]],
              category: 'mismatch', code: 'producer-below-consumer',
              message: `ASIL mismatch: producer ${endpoints[producer].path} (${producerAllocation.label}) is below consumer ${endpoints[consumer].path} (${consumerAllocation.label}) on ${named(connector)}.`,
              nextStep: 'Review the producer and consumer allocations and failure modes. This check applies each port maximum to its supported transfers; it does not match individual failure modes.' });
          }
        }
      }
    }
    if (problem && evaluator === 'sysml-port-asil-incomplete') add(connector.id, { ...base, ...problem });
  }
  const nodeIds = [...findings.keys()].sort((a, b) => a - b);
  const captured = Object.fromEntries(nodeIds.map(id => [id, findings.get(id)!.sort((a, b) => a.connection.nodeId - b.connection.nodeId || a.message.localeCompare(b.message))]));
  const labels = { mismatch: 'ASIL mismatch', analysis: 'Missing / invalid analysis', unsupported: 'Not supported', unresolved: 'Unresolved connection' };
  return { nodeIds, findings: captured, computedAttributes: Object.fromEntries(nodeIds.map(id => {
    const entries = captured[id];
    return [id, { check_affected: [...new Set(entries.map(entry => entry.endpoints.map(end => end.label).join(entry.category === 'mismatch' ? ' → ' : ' ↔ ') || 'Unresolved connection'))].join('\n'),
      check_assessment: [...new Set(entries.map(entry => labels[entry.category]))].join(' / '),
      check_message: [...new Set(entries.map(entry => entry.message))].join('\n') }];
  })) };
}
