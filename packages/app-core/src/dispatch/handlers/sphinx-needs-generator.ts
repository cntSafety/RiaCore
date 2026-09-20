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
 * sphinx-needs-generator.ts
 *
 * Pure RST generator for Sphinx-Needs safety export.
 * Takes a SafetyExportData object (produced by safety-export-aggregator.ts)
 * and returns a Map<string, string> of relative file paths → file content strings.
 *
 * No I/O, no side effects. Deterministic: same input → same output.
 */

import { formatReviews, formatSotifDetails } from './safety-export-format.js';

import type {
  SafetyExportData,
  ComponentExportData,
  MalfunctionExportData,
  RequirementExportData,
  SafetyTaskExportData,
  SafetyNoteExportData,
  RiskRatingData,
} from '@riacore/app-contracts';

// ── Public interface ─────────────────────────────────────────────────────────

export interface SphinxNeedsOutput {
  /** Relative path (forward-slash separators) → file content string */
  files: Map<string, string>;
}

/**
 * Caller-controlled switches for what the generated report contains.
 * Every field is optional and defaults to the historical behaviour, so
 * `generateSphinxNeedsRst(data)` is unchanged.
 */
export interface SphinxNeedsGeneratorOptions {
  /**
   * Write the semi-quantitative risk-rating values — Severity, Occurrence,
   * Detection and RPN — into the report. Default `true`.
   *
   * When `false`, the malfunction "Risk Rating" field, the "Max Risk Rating"
   * column of `status.rst` and the risk-rating rows of the per-component
   * Analysis Statistics table are all omitted. A malfunction's free-text
   * risk-rating note survives, rendered as its own "Risk Rating Note" field.
   */
  includeRiskRatings?: boolean;
}

/** Options with every default applied, threaded through the private builders. */
interface ResolvedOptions {
  includeRiskRatings: boolean;
}

function resolveOptions(options: SphinxNeedsGeneratorOptions | undefined): ResolvedOptions {
  return {
    // Only an explicit `false` turns ratings off — undefined keeps them.
    includeRiskRatings: options?.includeRiskRatings !== false,
  };
}

// ── ASIL priority ────────────────────────────────────────────────────────────

const ASIL_PRIORITY: Record<string, number> = {
  QM: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

/**
 * Normalize an ASIL string to its canonical single-letter form.
 * Returns undefined for empty/unrecognized values.
 */
function normalizeAsil(asil: string | undefined | null): string | undefined {
  if (!asil) return undefined;
  const upper = asil.trim().toUpperCase();
  if (upper in ASIL_PRIORITY) return upper;
  // Handle decomposition variants like "ASIL-B(D)" → extract the base letter
  const match = upper.match(/^([A-D]|QM)/);
  return match ? match[1] : undefined;
}

/**
 * Compute the maximum ASIL across all malfunctions and their linked requirements
 * for a component. Uses priority order QM < A < B < C < D.
 * Returns undefined if no valid ASIL values are found.
 */
function computeMaxAsil(component: ComponentExportData): string | undefined {
  let bestScore = -1;
  let bestAsil: string | undefined;

  const considerAsil = (raw: string | undefined | null) => {
    const normalized = normalizeAsil(raw);
    if (!normalized) return;
    const score = ASIL_PRIORITY[normalized];
    if (score > bestScore) {
      bestScore = score;
      bestAsil = normalized;
    }
  };

  const allMFs = [
    ...component.functionalMFs,
    ...component.receiverPortMFs,
    ...component.providerPortMFs,
  ];

  for (const mf of allMFs) {
    considerAsil(mf.asil);
  }

  for (const req of component.requirements) {
    considerAsil(req.reqAsil);
  }

  return bestAsil;
}

/**
 * Compute the maximum risk priority number across all malfunctions in a component.
 * Returns undefined if no risk ratings are present.
 */
function computeMaxRisk(component: ComponentExportData): number | undefined {
  let best: number | undefined;

  const allMFs = [
    ...component.functionalMFs,
    ...component.receiverPortMFs,
    ...component.providerPortMFs,
  ];

  for (const mf of allMFs) {
    if (!mf.riskRating) continue;
    const rpn = parseInt(mf.riskRating.risk_priority_number, 10);
    if (!isNaN(rpn)) {
      if (best === undefined || rpn > best) {
        best = rpn;
      }
    }
  }

  return best;
}

// ── RST formatting helpers ───────────────────────────────────────────────────

function repeatChar(char: string, length: number): string {
  return char.repeat(Math.max(0, length));
}

function formatMultiline(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Render a directive body field with bold label and indented content.
 * All lines use the same 3-space directive body indentation so docutils
 * never sees an unexpected indentation change.
 */
function renderDirectiveField(label: string, content: string): string[] {
  const indent = '   ';
  const normalized = formatMultiline(content).trim();
  const lines: string[] = [];

  if (!normalized) {
    lines.push(`${indent}**${label}:**`);
    return lines;
  }

  const contentLines = normalized.split('\n');
  if (contentLines.length === 1) {
    // Single-line: label and value on the same line
    lines.push(`${indent}**${label}:** ${contentLines[0]}`.trimEnd());
  } else {
    // Multi-line: label on its own line, content lines follow immediately (no blank line)
    lines.push(`${indent}**${label}:**`);
    for (const line of contentLines) {
      lines.push(line.trim().length > 0 ? `${indent}${line}` : '');
    }
  }

  return lines;
}

/**
 * Flatten a user-entered text value for use as a single RST field value.
 * Replaces embedded newlines with a space so the value stays on one line
 * when used as the first line of a renderDirectiveField call.
 * Multi-line content should be passed directly to renderDirectiveField instead.
 */
function flattenText(value: string): string {
  return value.replace(/\r\n?|\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** A rendered risk-rating block: the directive field label and its content. */
interface RiskRatingField {
  label: string;
  text: string;
}

/**
 * Format a risk rating as a human-readable directive field.
 * Returns undefined if the risk rating has no content worth emitting.
 *
 * With `includeRiskRatings: false` the Severity / Occurrence / Detection / RPN
 * values are dropped and only the free-text note remains — under its own
 * "Risk Rating Note" label, so the report never implies a rating that the
 * project does not maintain.
 */
function formatRiskRating(
  rr: RiskRatingData | null,
  options: ResolvedOptions,
): RiskRatingField | undefined {
  if (!rr) return undefined;

  const lines: string[] = [];

  const hasSeverity = rr.has_severity && rr.has_severity.trim().length > 0;
  const hasOccurrence = rr.has_occurrence_level && rr.has_occurrence_level.trim().length > 0;
  const hasDetection = rr.has_detection_level && rr.has_detection_level.trim().length > 0;
  const hasRpn = rr.risk_priority_number && rr.risk_priority_number.trim().length > 0;
  const hasNote = rr.risk_rating_note && rr.risk_rating_note.trim().length > 0;

  if (!hasSeverity && !hasOccurrence && !hasDetection && !hasRpn && !hasNote) {
    return undefined;
  }

  if (!options.includeRiskRatings) {
    if (!hasNote) return undefined;
    const noteOnly = flattenText(rr.risk_rating_note);
    return noteOnly ? { label: 'Risk Rating Note', text: noteOnly } : undefined;
  }

  if (hasSeverity) lines.push(`Severity: ${flattenText(rr.has_severity)}`);
  if (hasOccurrence) lines.push(`Occurrence: ${flattenText(rr.has_occurrence_level)}`);
  if (hasDetection) lines.push(`Detection: ${flattenText(rr.has_detection_level)}`);
  if (hasRpn) lines.push(`RPN: ${flattenText(rr.risk_priority_number)}`);
  if (hasNote) {
    // Replace embedded newlines with a space so the note stays on one logical
    // line inside the risk-rating block. Multi-line notes would otherwise
    // produce bare lines that renderDirectiveField cannot indent correctly.
    const noteText = flattenText(rr.risk_rating_note);
    if (noteText) lines.push(`Note: ${noteText}`);
  }

  return lines.length > 0 ? { label: 'Risk Rating', text: lines.join('\n') } : undefined;
}

// ── Malfunction directive rendering ─────────────────────────────────────────

function renderMalfunctionDirective(
  mf: MalfunctionExportData,
  options: ResolvedOptions,
): string {
  const lines: string[] = [`.. mf:: ${mf.name}`, `   :id: ${mf.id}`];

  if (mf.asil && normalizeAsil(mf.asil)) {
    lines.push(`   :asil: ${mf.asil}`);
  }

  if (mf.portName) {
    lines.push(`   :port: ${mf.portName}`);
  }

  if (mf.propagatesFromIds.length > 0) {
    lines.push(`   :causation: ${mf.propagatesFromIds.join(', ')}`);
  }

  if (mf.taskIds.length > 0) {
    lines.push(`   :taskref: ${mf.taskIds.join(', ')}`);
  }

  if (mf.reqIds.length > 0) {
    lines.push(`   :sreqref: ${mf.reqIds.join(', ')}`);
  }

  const description = mf.description && mf.description.trim().length > 0
    ? formatMultiline(mf.description)
    : 'No description provided.';

  lines.push('');
  lines.push(...renderDirectiveField('Description', description));

  const risk = formatRiskRating(mf.riskRating, options);
  if (risk) {
    lines.push('');
    lines.push(...renderDirectiveField(risk.label, risk.text));
  }

  for (const [label, content] of [
    ['Reviews', formatReviews(mf.reviews)],
    ['Functional Insufficiencies', formatSotifDetails(mf.functionalInsufficiencies)],
    ['Triggering Conditions', formatSotifDetails(mf.triggeringConditions)],
  ]) {
    if (content) lines.push('', ...renderDirectiveField(label, content));
  }
  lines.push('');
  return lines.join('\n');
}

// ── Requirement directive rendering ─────────────────────────────────────────

function renderRequirementDirective(req: RequirementExportData): string {
  const name = req.name && req.name.trim().length > 0 ? req.name : 'Safety Requirement';
  const lines: string[] = [`.. sr:: ${name}`, `   :id: ${req.id}`];

  if (req.reqAsil && normalizeAsil(req.reqAsil)) {
    lines.push(`   :asil: ${req.reqAsil}`);
  }

  lines.push('');

  if (req.reqId && req.reqId.trim().length > 0) {
    lines.push(...renderDirectiveField('Requirement ID', req.reqId));
    lines.push('');
  }

  if (req.originatingTask) {
    lines.push(...renderDirectiveField('Originating Task', req.originatingTask), '');
  }

  if (req.reqLinkedTo && req.reqLinkedTo.trim().length > 0) {
    const linkMarkup = `\`Open link <${req.reqLinkedTo}>\`__`;
    lines.push(...renderDirectiveField('Requirement Link', linkMarkup));
    lines.push('');
  }

  const text = req.reqText && req.reqText.trim().length > 0
    ? formatMultiline(req.reqText)
    : 'No requirement text provided.';
  lines.push(...renderDirectiveField('Requirement text', text));
  lines.push('');

  return lines.join('\n');
}

// ── Safety task directive rendering ─────────────────────────────────────────

function renderSafetyTaskDirective(task: SafetyTaskExportData): string {
  const name = task.name && task.name.trim().length > 0 ? task.name : 'Safety Task';
  const lines: string[] = [
    `.. safetytask:: ${name}`,
    `   :id: ${task.id}`,
    `   :taskstate: ${task.status}`,
  ];

  if (task.reference && task.reference.trim().length > 0) {
    lines.push(`   :reference: ${task.reference.trim()}`);
  }

  if (task.responsible && task.responsible.trim().length > 0) {
    lines.push(`   :responsible: ${task.responsible.trim()}`);
  }

  if (task.type && task.type.trim().length > 0) {
    lines.push(`   :tasktype: ${task.type.trim()}`);
  }

  lines.push('');

  const descriptionText = task.description && task.description.trim().length > 0
    ? formatMultiline(task.description)
    : 'No description provided.';
  const descLines = descriptionText.split('\n');
  lines.push(`   Safety Task description: ${descLines[0]}`.trimEnd());
  for (const line of descLines.slice(1)) {
    lines.push(line.trim().length > 0 ? `   ${line}` : '');
  }
  lines.push('');

  return lines.join('\n');
}

// ── Safety note directive rendering ─────────────────────────────────────────

function renderSafetyNoteDirective(note: SafetyNoteExportData): string {
  const noteText = note.noteText && note.noteText.trim().length > 0
    ? note.noteText
    : 'No note text provided.';
  const indented = noteText.replace(/\n/g, '\n   ');
  return [`.. safetynote:: Safety Note`, `   :id: ${note.id}`, '', `   ${indented}`, ''].join('\n');
}

// ── Analysis Statistics section ──────────────────────────────────────────────

function buildAnalysisStatistics(
  component: ComponentExportData,
  options: ResolvedOptions,
): string {
  const lines: string[] = [];

  // Safety Tasks by status
  const taskStatusCounts = new Map<string, number>();
  for (const task of component.safetyTasks) {
    const status = task.status && task.status.trim().length > 0 ? task.status : 'Unknown';
    taskStatusCounts.set(status, (taskStatusCounts.get(status) ?? 0) + 1);
  }
  const totalTasks = component.safetyTasks.length;

  // Safety Requirements with/without ASIL
  const requirementsWithAsil = component.requirements.filter(r => normalizeAsil(r.reqAsil) !== undefined).length;
  const requirementsWithoutAsil = component.requirements.length - requirementsWithAsil;

  // Functional MFs with/without risk rating
  const functionalWithRisk = component.functionalMFs.filter(mf => mf.riskRating !== null).length;
  const functionalWithoutRisk = component.functionalMFs.length - functionalWithRisk;

  // Ports statistics
  const totalPorts = component.portCount;
  const portsWithMF = component.receiverPortMFs.length + component.providerPortMFs.length;
  const portsWithoutMF = Math.max(0, totalPorts - portsWithMF);

  lines.push('Analysis Statistics');
  lines.push('-------------------');
  lines.push('');

  // Safety Tasks table
  lines.push('Safety Tasks');
  lines.push('~~~~~~~~~~~~');
  lines.push('');
  lines.push('.. csv-table:: Safety Tasks Summary');
  lines.push('   :header: "Metric", "Value"');
  lines.push('   :widths: auto');
  lines.push('');
  lines.push(`   "Total Safety Tasks", "${totalTasks}"`);

  // Sort status entries alphabetically for deterministic output
  const sortedStatuses = Array.from(taskStatusCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [status, count] of sortedStatuses) {
    lines.push(`   "Tasks in status '${status}'", "${count}"`);
  }
  lines.push('');
  lines.push('');

  // Safety Requirements table
  lines.push('Safety Requirements');
  lines.push('~~~~~~~~~~~~~~~~~~~');
  lines.push('');
  lines.push('.. csv-table:: Safety Requirements Summary');
  lines.push('   :header: "Metric", "Value"');
  lines.push('   :widths: auto');
  lines.push('');
  lines.push(`   "Total Safety Requirements", "${component.requirements.length}"`);
  lines.push(`   "Requirements with ASIL", "${requirementsWithAsil}"`);
  lines.push(`   "Requirements without ASIL", "${requirementsWithoutAsil}"`);
  lines.push('');
  lines.push('');

  // Functional Failure Modes table
  lines.push('Functional Failure Modes');
  lines.push('~~~~~~~~~~~~~~~~~~~~~~~~');
  lines.push('');
  lines.push('.. csv-table:: Component Malfunctions Summary');
  lines.push('   :header: "Metric", "Value"');
  lines.push('   :widths: auto');
  lines.push('');
  lines.push(`   "Total Component Malfunctions", "${component.functionalMFs.length}"`);
  if (options.includeRiskRatings) {
    lines.push(`   "Malfunctions with Risk Rating", "${functionalWithRisk}"`);
    lines.push(`   "Malfunctions without Risk Rating", "${functionalWithoutRisk}"`);
  }
  lines.push('');
  lines.push('');

  // Ports table
  lines.push('Ports');
  lines.push('~~~~~');
  lines.push('');
  lines.push('.. csv-table:: Ports Summary');
  lines.push('   :header: "Metric", "Value"');
  lines.push('   :widths: auto');
  lines.push('');
  lines.push(`   "Total Ports", "${totalPorts}"`);
  lines.push(`   "Ports with Malfunctions", "${portsWithMF}"`);
  lines.push(`   "Ports without Malfunctions", "${portsWithoutMF}"`);
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

// ── Per-component RST file ───────────────────────────────────────────────────

function buildComponentRst(
  component: ComponentExportData,
  options: ResolvedOptions,
): string {
  const lines: string[] = [];

  // Section heading
  const titleUnderline = repeatChar('=', component.name.length);
  lines.push(component.name);
  lines.push(titleUnderline);
  lines.push('');

  // Component ID and Type subsection
  lines.push('Component ID and Type');
  lines.push('----------------------');
  lines.push('');
  lines.push(`.. csv-table:: ${component.name}`);
  lines.push('   :header: "Information", "Value"');
  lines.push('   :widths: auto');
  lines.push('');
  lines.push(`   "UUID", ${component.uuid}`);
  lines.push(`   "Component Type", ${component.componentType || 'Unknown'}`);
  if (component.arxmlPath) {
    lines.push(`   "ARXML Path", ${component.arxmlPath}`);
  }
  lines.push('');
  lines.push('');

  for (const [label, content] of [
    ['Tag Details', (component.tagDetails ?? []).map(tag =>
      `Name: ${tag.name}\nDescription: ${tag.description}\nColor: ${tag.color}`).join('\n\n')],
    ['Unlinked Functional Insufficiencies', formatSotifDetails(component.unlinkedFunctionalInsufficiencies)],
    ['Unlinked Triggering Conditions', formatSotifDetails(component.unlinkedTriggeringConditions)],
    ['Unlinked Reviews', formatReviews(component.unlinkedReviews)],
  ]) {
    if (content) {
      lines.push(label, repeatChar('-', label.length), '');
      // A line block preserves readable field boundaries without creating needs.
      lines.push(...content.split('\n').map(line => `| ${line}`), '', '');
    }
  }

  // Analysis Statistics
  lines.push(buildAnalysisStatistics(component, options));

  // Safety Information (notes)
  lines.push('Safety Information');
  lines.push('------------------');
  lines.push('');
  if (component.safetyNotes.length === 0) {
    lines.push('.. note::');
    lines.push('   No safety notes recorded for this component.');
    lines.push('');
  } else {
    lines.push(component.safetyNotes.map(renderSafetyNoteDirective).join('\n\n'));
    lines.push('');
  }
  lines.push('');

  // Safety Tasks
  lines.push('Safety Tasks');
  lines.push('-------------');
  lines.push('');
  if (component.safetyTasks.length === 0) {
    lines.push('.. note::');
    lines.push('   No safety tasks linked to these failure modes.');
    lines.push('');
  } else {
    lines.push(component.safetyTasks.map(renderSafetyTaskDirective).join('\n\n'));
    lines.push('');
  }
  lines.push('');

  // Safety Requirements
  lines.push('Safety Requirements');
  lines.push('-------------------');
  lines.push('');
  if (component.requirements.length === 0) {
    lines.push('.. note::');
    lines.push('   No safety requirements linked to these failure modes.');
    lines.push('');
  } else {
    lines.push(component.requirements.map(renderRequirementDirective).join('\n\n'));
    lines.push('');
  }
  lines.push('');

  // Component Malfunctions
  lines.push('Component Malfunctions');
  lines.push('------------------------');
  lines.push('');
  if (component.functionalMFs.length === 0) {
    lines.push('.. note::');
    lines.push('   No functional failure modes recorded for this component.');
    lines.push('');
  } else {
    lines.push(component.functionalMFs.map(mf => renderMalfunctionDirective(mf, options)).join('\n\n'));
    lines.push('');
  }
  lines.push('');

  // Receiver Ports Malfunctions
  lines.push('Receiver Ports Malfunctions');
  lines.push('----------------------------');
  lines.push('');
  if (component.receiverPortMFs.length === 0) {
    lines.push('.. note::');
    lines.push('   No failure modes recorded for these ports.');
    lines.push('');
  } else {
    lines.push(component.receiverPortMFs.map(mf => renderMalfunctionDirective(mf, options)).join('\n\n'));
    lines.push('');
  }
  lines.push('');

  // Provider Ports Malfunctions
  lines.push('Provider Ports Malfunctions');
  lines.push('----------------------------');
  lines.push('');
  if (component.providerPortMFs.length === 0) {
    lines.push('.. note::');
    lines.push('   No failure modes recorded for these ports.');
    lines.push('');
  } else {
    lines.push(component.providerPortMFs.map(mf => renderMalfunctionDirective(mf, options)).join('\n\n'));
    lines.push('');
  }
  lines.push('');

  return lines.join('\n');
}

// ── status.rst ───────────────────────────────────────────────────────────────

function buildStatusRst(data: SafetyExportData, options: ResolvedOptions): string {
  // Components are already sorted alphabetically by the aggregator,
  // but we sort here too for determinism in case the caller doesn't guarantee order.
  const sorted = [...data.components].sort((a, b) => a.name.localeCompare(b.name));

  // "Max Risk Rating" is the maximum RPN, so it goes away with the ratings.
  const header = options.includeRiskRatings
    ? '   :header: "Component", "Max ASIL", "Max Risk Rating", "Ports", "Missing MF", "Tags"'
    : '   :header: "Component", "Max ASIL", "Ports", "Missing MF", "Tags"';

  const lines: string[] = [
    'Status',
    '======',
    '',
    'Status Table',
    '----------------------',
    '',
    '.. csv-table:: Safety Status',
    header,
    '   :widths: auto',
    '',
  ];

  if (sorted.length === 0) {
    lines.push(options.includeRiskRatings ? '   -, -, -, -, -, -' : '   -, -, -, -, -');
  } else {
    for (const component of sorted) {
      const maxAsil = computeMaxAsil(component) ?? '';
      const portCount = component.portCount ?? 0;

      // Missing MF: ports that have no malfunction coverage
      const portsWithMF = component.receiverPortMFs.length + component.providerPortMFs.length;
      const missingMF = Math.max(0, portCount - portsWithMF);

      const tags = component.tags && component.tags.length > 0 ? component.tags.join('; ') : '';

      const cells = [component.name, maxAsil];
      if (options.includeRiskRatings) {
        const maxRisk = computeMaxRisk(component);
        cells.push(maxRisk !== undefined ? String(maxRisk) : '');
      }
      cells.push(String(portCount), String(missingMF), tags);
      lines.push(`   ${cells.join(', ')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── index.rst ────────────────────────────────────────────────────────────────

function buildIndexRst(data: SafetyExportData, documents: ComponentDocument[]): string {
  const title = 'SW Safety Analysis Export';
  const titleUnderline = repeatChar('=', title.length);

  const lines: string[] = [
    title,
    titleUnderline,
    '',
    'Introduction',
    '------------',
    '',
    `This document contains the safety analysis export for namespace **${data.namespace}**,`,
    `generated at ${data.generatedAt}.`,
    '',
    '.. toctree::',
    '   :maxdepth: 3',
    '   :caption: Contents:',
    '   :titlesonly:',
    '',
    '   status',
  ];

  // Components are already sorted alphabetically by the aggregator
  const sorted = [...documents].sort((a, b) => a.component.name.localeCompare(b.component.name));
  for (const { docname } of sorted) {
    lines.push(`   components/${docname}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── export-info.json ─────────────────────────────────────────────────────────

function buildExportInfoJson(data: SafetyExportData, fileKeys: string[]): string {
  const totalComponentSafetyRecords = data.components.reduce(
    (sum, c) => sum + c.functionalMFs.length,
    0,
  );
  const totalPortSafetyRecords = data.components.reduce(
    (sum, c) => sum + c.receiverPortMFs.length + c.providerPortMFs.length,
    0,
  );
  const safetyTasksIncluded = data.components.reduce(
    (sum, c) => sum + c.safetyTasks.length,
    0,
  );

  // Sort files alphabetically with forward-slash separators
  const files = [...fileKeys].sort((a, b) => a.localeCompare(b));

  const info = {
    generatedAt: data.generatedAt,
    namespace: data.namespace,
    totalComponents: data.components.length,
    totalComponentSafetyRecords,
    totalPortSafetyRecords,
    safetyTasksIncluded,
    files,
  };

  return JSON.stringify(info, null, 2);
}

interface ComponentDocument {
  component: ComponentExportData;
  docname: string;
}

/** One document per input entry, even when node IDs repeat. */
function componentDocuments(components: ComponentExportData[]): ComponentDocument[] {
  const used = new Set<string>();
  return components.map(component => {
    const base = encodeURIComponent(component.name) || 'Component';
    let name = base;
    while (used.has(name.toLowerCase())) name = `${name}_${Math.abs(component.nodeId)}`;
    used.add(name.toLowerCase());
    return { component, docname: name };
  });
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Generate all Sphinx-Needs RST files from a SafetyExportData object.
 *
 * Returns a Map<string, string> of relative file paths (forward-slash separators)
 * to file content strings. The function is pure: no I/O, no side effects.
 * Same input always produces the same output.
 */
export function generateSphinxNeedsRst(
  data: SafetyExportData,
  options?: SphinxNeedsGeneratorOptions,
): SphinxNeedsOutput {
  const resolved = resolveOptions(options);
  const files = new Map<string, string>();

  const documents = componentDocuments(data.components);

  // Generate per-component RST files
  for (const { component, docname } of documents) {
    const filePath = `components/${docname}.rst`;
    files.set(filePath, buildComponentRst(component, resolved));
  }

  // Generate status.rst
  files.set('status.rst', buildStatusRst(data, resolved));

  // Generate index.rst
  files.set('index.rst', buildIndexRst(data, documents));

  // Generate export-info.json (needs the list of all file keys)
  const allFileKeys = Array.from(files.keys());
  allFileKeys.push('export-info.json'); // include itself in the listing
  files.set('export-info.json', buildExportInfoJson(data, allFileKeys));

  return { files };
}
