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
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';
import { parse, stringify } from 'yaml';
import type { SafetyExportData, MalfunctionExportData } from '@riacore/app-contracts';
import type { OkfSourceNode, SafetyOkfContext } from './safety-okf-context.js';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const identity = (node: OkfSourceNode) => JSON.stringify([node.namespace, node.concept, node.stableId]);
const isPort = (node: OkfSourceNode) => ['r_port', 'p_port', 'pr_port', 'port_usage'].includes(node.concept);
const inline = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>]/g, '\\$&');
const excerpt = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 100);

/** One rule for names and hierarchy segments, including Windows device names. */
export function okfSlug(value: string): string {
  let result = value.normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  if (!result) result = 'record';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9]|index|log|element|ports|malfunctions)$/i.test(result)) result = `record-${result}`;
  // Byte limits matter for multibyte filesystem names as well as character counts.
  if (Buffer.byteLength(result) > 90) {
    let prefix = '';
    for (const char of result) { if (Buffer.byteLength(prefix + char) > 65) break; prefix += char; }
    result = `${prefix.replace(/-+$/, '')}-${hash(value)}`;
  }
  return result;
}

interface Doc {
  node: OkfSourceNode;
  type: string;
  title: string;
  filename: string;
  fields: Record<string, unknown>;
  sections: Map<string, string>;
  links: Map<string, Set<Doc>>;
}

function description(doc: Doc): string {
  return excerpt(doc.sections.get('Description') || doc.sections.get('Requirement') ||
    doc.sections.get('Note') || doc.sections.get('Reviewer comment') || `${doc.type} in ${doc.node.namespace}.`);
}

export interface SafetyOkfOptions { includeRiskRatings?: boolean }
export interface SafetyOkfOutput { files: Map<string, string> }

/** Pure, deterministic conversion. Database and report keys never enter output. */
export function generateSafetyOkf(
  data: SafetyExportData, context: SafetyOkfContext, options: SafetyOkfOptions = {},
): SafetyOkfOutput {
  const docs = new Map<string, Doc>();
  const byNode = new Map<number, Doc>();
  const elements = new Set<number>();
  const portKinds = new Map<number, string>();
  function source(id: number): OkfSourceNode {
    const node = context.nodes.get(id);
    if (!node?.stableId.trim()) throw new Error('A source record is missing its persistent identity; cannot export OKF.');
    return node;
  }
  function add(id: number, type: string, directory: string, title: string, preferred?: string): Doc {
    const node = source(id), key = identity(node);
    let doc = docs.get(key);
    if (!doc) {
      doc = { node, type, title: title || node.name || type, filename: `${directory}/${okfSlug(preferred || title || node.name || type)}.md`,
        fields: {}, sections: new Map(), links: new Map() };
      docs.set(key, doc);
    }
    byNode.set(id, doc);
    return doc;
  }
  function section(doc: Doc, label: string, value: string | undefined) {
    if (value) doc.sections.set(label, value);
  }
  function link(doc: Doc, label: string, target: Doc | undefined) {
    if (!target) throw new Error(`Cannot resolve an OKF relationship from ${doc.title}.`);
    if (!doc.links.has(label)) doc.links.set(label, new Set());
    doc.links.get(label)!.add(target);
  }
  function element(id: number, trail = new Set<number>()) {
    if (trail.has(id)) throw new Error('Cyclic structural ancestry; cannot export OKF.');
    if (elements.has(id)) return;
    trail.add(id);
    const node = source(id);
    const parent = context.parents.get(id);
    if (parent !== undefined) element(parent, trail);
    elements.add(id);
    add(id, isPort(node) ? 'Port' : 'Element', 'elements', node.name || node.concept);
  }

  // Source structure is independent of the collector's component grouping.
  for (const component of data.components) {
    if (component.componentType !== 'unassigned') element(component.nodeId);
    for (const port of component.ports) { element(port.nodeId); portKinds.set(port.nodeId, port.kind); }
  }
  for (const target of context.occursAt.values()) element(target);
  for (const hosts of context.recordHosts.values()) for (const host of hosts) {
    if (source(host).concept !== 'malfunction') element(host);
  }

  // Allocate sibling segments together so collisions do not depend on query order.
  const segments = new Map<number, string>();
  const siblingGroups = new Map<string, number[]>();
  for (const id of elements) {
    const n = source(id), parent = context.parents.get(id);
    const key = JSON.stringify([n.namespace, parent === undefined ? null : identity(source(parent)), isPort(n), okfSlug(n.name || n.concept)]);
    const group = siblingGroups.get(key) ?? []; group.push(id); siblingGroups.set(key, group);
  }
  for (const group of siblingGroups.values()) for (const id of group) {
    const n = source(id);
    segments.set(id, `${okfSlug(n.name || n.concept)}${group.length > 1 ? `-${hash(identity(n))}` : ''}`);
  }
  const namespaces = [...new Set([...context.nodes.values()].map(node => node.namespace))];
  function namespaceSegment(ns: string): string {
    const slug = okfSlug(ns);
    return namespaces.filter(other => okfSlug(other) === slug).length > 1 ? `${slug}-${hash(ns)}` : slug;
  }
  const directories = new Map<number, string>();
  function elementDir(id: number): string {
    const cached = directories.get(id); if (cached) return cached;
    const n = source(id), parent = context.parents.get(id);
    const base = parent === undefined ? `elements/${namespaceSegment(n.namespace)}` : elementDir(parent);
    const dir = `${base}/${isPort(n) ? 'ports/' : ''}${segments.get(id)}`;
    directories.set(id, dir);
    return dir;
  }
  for (const id of elements) {
    const doc = byNode.get(id)!;
    doc.filename = `${elementDir(id)}/element.md`;
    doc.fields.element_type = doc.node.concept;
    if (isPort(doc.node)) {
      doc.fields.port_kind = portKinds.get(id) || (doc.node.concept === 'r_port' || doc.node.direction === 'in' ? 'receiver' : doc.node.concept === 'pr_port' || doc.node.direction === 'inout' ? 'bidirectional' : 'provider');
      if (doc.node.direction) doc.fields.port_direction = doc.node.direction;
    }
    const parent = context.parents.get(id);
    if (parent !== undefined) { link(doc, 'Parent element', byNode.get(parent)); link(byNode.get(parent)!, isPort(doc.node) ? 'Ports' : 'Child elements', doc); }
  }

  const malfunctionRefs = new Map<string, Doc>();
  const localRefs = new Map<string, Doc>();
  const allMalfunctions: { mf: MalfunctionExportData; componentId: number }[] = [];
  const unassignedRecords = new Set<Doc>();
  for (const c of data.components) {
    const owner = c.componentType === 'unassigned' ? undefined : byNode.get(c.nodeId);
    if (owner) { owner.fields.port_count = c.portCount; owner.fields.tags = [...c.tags].sort(compare); }
    for (const mf of [...c.functionalMFs, ...c.receiverPortMFs, ...c.providerPortMFs]) {
      const target = context.occursAt.get(mf.nodeId);
      const doc = add(mf.nodeId, 'Malfunction', target === undefined ? 'unassigned/malfunctions' : `${elementDir(target)}/malfunctions`, mf.name);
      doc.fields.asil = mf.asil;
      doc.fields.location_kind = target === undefined ? 'unassigned' : isPort(source(target)) ? 'port' : 'element';
      if (target !== undefined) {
        link(doc, 'Occurs at', byNode.get(target)); link(byNode.get(target)!, 'Malfunctions', doc);
        if (mf.portKind) doc.fields.port_kind = mf.portKind;
      } else unassignedRecords.add(doc);
      section(doc, 'Description', mf.description);
      if (mf.riskRating) {
        const rr = mf.riskRating;
        if (options.includeRiskRatings !== false) {
          doc.fields.risk_rating = { severity: rr.has_severity, occurrence: rr.has_occurrence_level, detection: rr.has_detection_level, rpn: rr.risk_priority_number };
          section(doc, 'Risk rating', [['Severity', rr.has_severity], ['Occurrence', rr.has_occurrence_level], ['Detection', rr.has_detection_level], ['RPN', rr.risk_priority_number]]
            .filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${inline(v)}`).join('\n'));
        }
        section(doc, 'Risk assessment note', rr.risk_rating_note);
      }
      malfunctionRefs.set(mf.id, doc);
      allMalfunctions.push({ mf, componentId: c.nodeId });
    }
    for (const req of c.requirements) {
      const doc = add(req.nodeId, 'Safety Requirement', `requirements/${namespaceSegment(source(req.nodeId).namespace)}`, req.name, req.reqId || req.name);
      Object.assign(doc.fields, { external_id: req.reqId, asil: req.reqAsil });
      section(doc, 'Requirement', req.reqText); section(doc, 'External reference', req.reqLinkedTo); section(doc, 'Originating task', req.originatingTask);
      localRefs.set(`${c.nodeId}\0${req.id}`, doc);
      if (owner) link(owner, 'Requirements', doc); else unassignedRecords.add(doc);
    }
    for (const task of c.safetyTasks) {
      const doc = add(task.nodeId, 'Safety Task', 'tasks', task.name, task.reference ? `${task.reference}-${task.name}` : task.name);
      Object.assign(doc.fields, { task_status: task.status, task_type: task.type });
      if (task.reference) doc.fields.task_reference = task.reference;
      if (task.responsible) doc.fields.responsible = task.responsible;
      section(doc, 'Description', task.description); section(doc, 'Status', task.status); section(doc, 'Type', task.type);
      section(doc, 'Responsible', task.responsible); section(doc, 'Reference', task.reference);
      localRefs.set(`${c.nodeId}\0${task.id}`, doc);
      if (owner) link(owner, 'Safety tasks', doc); else unassignedRecords.add(doc);
    }
    for (const note of c.safetyNotes) {
      const doc = add(note.nodeId, 'Safety Note', 'notes', excerpt(note.noteText)); section(doc, 'Note', note.noteText);
      if (!context.recordHosts.get(note.nodeId)?.size) unassignedRecords.add(doc);
    }
    for (const tag of c.tagDetails ?? []) {
      const doc = add(tag.nodeId, 'Tag', 'tags', tag.name); doc.fields.color = tag.color; section(doc, 'Description', tag.description);
      if (!context.recordHosts.get(tag.nodeId)?.size) unassignedRecords.add(doc);
    }
    for (const [label, list] of [
      ['Functional Insufficiency', c.unlinkedFunctionalInsufficiencies], ['Triggering Condition', c.unlinkedTriggeringConditions],
    ] as const) for (const detail of list ?? []) {
      const doc = add(detail.nodeId, label, label === 'Functional Insufficiency' ? 'functional-insufficiencies' : 'triggering-conditions', detail.name);
      doc.fields.source = detail.source; section(doc, 'Description', detail.description); unassignedRecords.add(doc);
    }
    for (const review of c.unlinkedReviews ?? []) {
      const doc = add(review.nodeId, 'Review', 'reviews', review.name || excerpt(review.reviewerComment));
      Object.assign(doc.fields, { review_status: review.status, verdict: review.verdict, author_status: review.authorStatus || '' });
      section(doc, 'Verdict', review.verdict); section(doc, 'Author status', review.authorStatus);
      section(doc, 'Reviewer comment', review.reviewerComment); section(doc, 'Author resolution', review.authorComment); unassignedRecords.add(doc);
    }
  }
  for (const { mf, componentId } of allMalfunctions) {
    const doc = byNode.get(mf.nodeId)!;
    for (const [label, refs] of [['Propagates from', mf.propagatesFromIds], ['Propagates to', mf.propagatesToIds]] as const) {
      for (const ref of refs) link(doc, label, malfunctionRefs.get(ref));
    }
    for (const [label, refs] of [['Safety tasks', mf.taskIds], ['Requirements', mf.reqIds]] as const) {
      for (const ref of refs) link(doc, label, localRefs.get(`${componentId}\0${ref}`));
    }
    for (const [label, list] of [['Functional insufficiencies', mf.functionalInsufficiencies], ['Triggering conditions', mf.triggeringConditions]] as const) {
      for (const detail of list ?? []) {
        const d = add(detail.nodeId, label === 'Functional insufficiencies' ? 'Functional Insufficiency' : 'Triggering Condition', label === 'Functional insufficiencies' ? 'functional-insufficiencies' : 'triggering-conditions', detail.name);
        d.fields.source = detail.source; section(d, 'Description', detail.description); link(doc, label, d);
      }
    }
    for (const note of mf.safetyNotes ?? []) {
      const d = add(note.nodeId, 'Safety Note', 'notes', excerpt(note.noteText)); section(d, 'Note', note.noteText); link(doc, 'Safety notes', d);
    }
    for (const review of mf.reviews) {
      const d = add(review.nodeId, 'Review', 'reviews', review.name || excerpt(review.reviewerComment));
      Object.assign(d.fields, { review_status: review.status, verdict: review.verdict, author_status: review.authorStatus || '' });
      section(d, 'Verdict', review.verdict); section(d, 'Author status', review.authorStatus);
      section(d, 'Reviewer comment', review.reviewerComment); section(d, 'Author resolution', review.authorComment);
      link(doc, 'Reviews', d);
    }
  }
  for (const [id, hosts] of context.recordHosts) {
    const record = byNode.get(id); if (!record) continue;
    for (const host of hosts) {
      const owner = byNode.get(host);
      if (owner) { link(owner, record.type === 'Tag' ? 'Tags' : 'Safety notes', record); link(record, 'Applies to', owner); unassignedRecords.delete(record); }
    }
  }
  // Backlinks retain every association to a shared record, not just its first owner.
  for (const doc of docs.values()) for (const [label, targets] of [...doc.links]) {
    if (label === 'Referenced by') continue;
    for (const target of targets) {
      if (!['Element', 'Port', 'Malfunction'].includes(target.type)) link(target, 'Referenced by', doc);
    }
  }

  // Move orphan records into an explicit group (shared linked records stay canonical).
  for (const doc of unassignedRecords) {
    if (!doc.links.get('Referenced by')?.size && !doc.filename.startsWith('unassigned/')) doc.filename = `unassigned/${doc.filename}`;
  }
  const filenames = new Map<string, Doc[]>();
  for (const doc of docs.values()) {
    const group = filenames.get(doc.filename.toLowerCase()) ?? []; group.push(doc); filenames.set(doc.filename.toLowerCase(), group);
  }
  for (const group of filenames.values()) if (group.length > 1) {
    for (const doc of group) doc.filename = doc.filename.replace(/\.md$/, `-${hash(identity(doc.node))}.md`);
  }
  // Reject extreme ancestry rather than silently flattening its source structure.
  for (const doc of docs.values()) {
    if (Buffer.byteLength(doc.filename) > 900) throw new Error(`Source hierarchy is too deep to export safely: ${doc.title}.`);
  }
  const targets = new Set([...docs.values()].map(d => d.filename));
  if (targets.size !== docs.size) throw new Error('Persistent source identities produce conflicting OKF filenames.');
  const files = new Map<string, string>();
  const generatedLinks: { from: string; target: string }[] = [];
  const markdownLink = (from: string, target: string, title: string) => {
    generatedLinks.push({ from, target });
    return `[${inline(title)}](${path.relative(path.dirname(from), target).split('/').map(encodeURIComponent).join('/')})`;
  };
  for (const doc of [...docs.values()].sort((a, b) => compare(a.filename, b.filename))) {
    const n = doc.node;
    const ria = { namespace: n.namespace, concept: n.concept, stable_id: n.stableId,
      ...(n.uuid ? { uuid: n.uuid } : {}),
      ...(n.sysmlId ? { sysml_id: n.sysmlId } : {}),
      ...(n.elementId ? { element_id: n.elementId } : {}),
      ...(n.sourcePath ? { source_path: n.sourcePath } : {}), ...doc.fields };
    const frontmatter = { type: doc.type, title: doc.title, description: description(doc),
      generated: { by: 'process:riacore-okf-export', at: data.generatedAt }, ria };
    let body = `# ${inline(doc.title)}\n`;
    if (doc.fields.asil) body += `\n**ASIL:** ${inline(String(doc.fields.asil))}\n`;
    for (const [label, value] of doc.sections) body += `\n## ${label}\n\n${value}\n`;
    for (const [label, linked] of [...doc.links].sort(([a], [b]) => compare(a, b))) {
      body += `\n## ${label}\n\n`;
      for (const target of [...linked].sort((a, b) => compare(a.filename, b.filename))) {
        if (!targets.has(target.filename)) throw new Error('Unresolved generated OKF link.');
        body += `- ${markdownLink(doc.filename, target.filename, target.title)}\n`;
      }
    }
    files.set(doc.filename, `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}`);
  }
  const counts = new Map<string, number>();
  for (const doc of docs.values()) counts.set(doc.type, (counts.get(doc.type) ?? 0) + 1);
  files.set('analysis.md', `---\n${stringify({ type: 'Safety Analysis', title: data.namespace,
    description: `Safety analysis exported from ${data.namespace}.`,
    generated: { by: 'process:riacore-okf-export', at: data.generatedAt },
    ria: { namespace: data.namespace, metamodel: context.metamodel, metamodel_version: context.metamodelVersion } }, { lineWidth: 0 })}---\n\n# ${inline(data.namespace)}\n\n` +
    `Read element documents to locate malfunctions, then follow their propagation, requirement, task, note and review links.\n\n` +
    `Risk ratings and workflow states reproduce the analysis; export does not imply verification or residual-risk acceptance.\n\n## Contents\n\n` +
    [...counts].sort(([a], [b]) => compare(a, b)).map(([type, count]) => `- ${type}: ${count}`).join('\n') + '\n');
  const topDirectories = [...new Set([...docs.values()].map(doc => doc.filename.split('/')[0]))].sort(compare);
  files.set('analysis.md', files.get('analysis.md')! + '\n## Navigation\n\n' + topDirectories
    .map(dir => `- ${markdownLink('analysis.md', `${dir}/index.md`, dir)}`).join('\n') + '\n');

  // Every populated directory, including ancestry-only containers, is discoverable.
  const dirs = new Set(['']);
  for (const filename of files.keys()) {
    let dir = path.dirname(filename);
    while (dir !== '.') { dirs.add(dir); dir = path.dirname(dir); }
  }
  for (const dir of [...dirs].sort(compare)) {
    const indexPath = dir ? `${dir}/index.md` : 'index.md';
    let content = dir ? `# ${inline(path.basename(dir))}\n\n` : `---\nokf_version: "0.2"\n---\n\n# ${inline(data.namespace)}\n\n`;
    for (const child of [...dirs].filter(d => d && (path.dirname(d) === (dir || '.'))).sort(compare)) {
      content += `- ${markdownLink(indexPath, `${child}/index.md`, path.basename(child))}\n`;
    }
    for (const [filename] of [...files].filter(([f]) => path.dirname(f) === (dir || '.')).sort(([a], [b]) => compare(a, b))) {
      const doc = [...docs.values()].find(d => d.filename === filename);
      content += `- ${markdownLink(indexPath, filename, doc?.title || data.namespace)}${doc ? ` — ${inline(description(doc))}` : ' — Analysis overview'}\n`;
    }
    files.set(indexPath, content);
  }
  for (const { from, target } of generatedLinks) {
    if (!files.has(target)) throw new Error(`Unresolved generated OKF link from ${from} to ${target}.`);
  }
  validateSafetyOkf(files);
  return { files: new Map([...files].sort(([a], [b]) => compare(a, b))) };
}

/** Validate generated structure before any filesystem writes. */
export function validateSafetyOkf(files: Map<string, string>): void {
  const seen = new Set<string>();
  for (const [filename, content] of files) {
    if (filename.startsWith('/') || filename.includes('\\') || filename.split('/').some(p => !p || p === '.' || p === '..') || seen.has(filename.toLowerCase())) {
      throw new Error(`Unsafe or conflicting OKF path: ${filename}`);
    }
    seen.add(filename.toLowerCase());
    if (path.basename(filename) === 'index.md') continue;
    const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
    const metadata = match ? parse(match[1]) : null;
    if (!metadata || typeof metadata.type !== 'string' || !metadata.type.trim()) throw new Error(`Invalid OKF frontmatter: ${filename}`);
  }
}
