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
 * safety-xlsx-generator.ts
 *
 * Pure XLSX generator for the safety analysis export.
 * Takes a SafetyExportData object (produced by safety-export-aggregator.ts —
 * the same data used by the Sphinx-Needs RST export) and returns an in-memory
 * .xlsx workbook buffer.
 *
 * Workbook structure:
 *   - "Overview"            one row per component (name, type, tags, max ASIL,
 *                           malfunction count, port count, ports w/o malfunctions)
 *   - one tab per component  the component's safety analysis — one row per
 *                            malfunction (functional + port), like the per-component RST
 *   - "Safety Tasks"        all safety tasks, linked back to their component tab
 *   - "Safety Requirements" all requirements, linked back to their component tab
 *   - "Tags"                all (component, tag) pairs, linked back to the component tab
 *
 * Cross-sheet hyperlinks tie the malfunction analysis to the tasks /
 * requirements tabs and back to the component tabs.
 *
 * No file I/O: the caller is responsible for writing the returned buffer to disk.
 * Deterministic: the same input always yields the same workbook content.
 */

import ExcelJS from 'exceljs';
import type {
  SafetyExportData,
  ComponentExportData,
  MalfunctionExportData,
  RiskRatingData,
  ReviewExportData,
} from '@riacore/app-contracts';

// ── ASIL priority (mirrors sphinx-needs-generator.ts) ───────────────────────

const ASIL_PRIORITY: Record<string, number> = {
  QM: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

function normalizeAsil(asil: string | undefined | null): string | undefined {
  if (!asil) return undefined;
  const upper = asil.trim().toUpperCase();
  if (upper in ASIL_PRIORITY) return upper;
  const match = upper.match(/^([A-D]|QM)/);
  return match ? match[1] : undefined;
}

/**
 * Maximum ASIL across all malfunctions and their linked requirements for a
 * component. Mirrors the RST status-table computation so the Overview tab and
 * the .rst report stay consistent.
 */
function computeMaxAsil(component: ComponentExportData): string | undefined {
  let bestScore = -1;
  let bestAsil: string | undefined;

  const consider = (raw: string | undefined | null) => {
    const normalized = normalizeAsil(raw);
    if (!normalized) return;
    const score = ASIL_PRIORITY[normalized];
    if (score > bestScore) {
      bestScore = score;
      bestAsil = normalized;
    }
  };

  for (const mf of allMalfunctions(component)) consider(mf.asil);
  for (const req of component.requirements) consider(req.reqAsil);

  return bestAsil;
}

function allMalfunctions(component: ComponentExportData): MalfunctionExportData[] {
  return [
    ...component.functionalMFs,
    ...component.receiverPortMFs,
    ...component.providerPortMFs,
  ];
}

function malfunctionCount(component: ComponentExportData): number {
  return (
    component.functionalMFs.length +
    component.receiverPortMFs.length +
    component.providerPortMFs.length
  );
}

function portsWithoutMalfunctions(component: ComponentExportData): number {
  const portsWithMF = component.receiverPortMFs.length + component.providerPortMFs.length;
  return Math.max(0, (component.portCount ?? 0) - portsWithMF);
}

// ── Risk-rating formatting ──────────────────────────────────────────────────

function flatten(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/\r\n?|\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function formatRiskRating(rr: RiskRatingData | null): string {
  if (!rr) return '';
  const parts: string[] = [];
  if (flatten(rr.has_severity)) parts.push(`Severity: ${flatten(rr.has_severity)}`);
  if (flatten(rr.has_occurrence_level)) parts.push(`Occurrence: ${flatten(rr.has_occurrence_level)}`);
  if (flatten(rr.has_detection_level)) parts.push(`Detection: ${flatten(rr.has_detection_level)}`);
  if (flatten(rr.risk_priority_number)) parts.push(`RPN: ${flatten(rr.risk_priority_number)}`);
  if (flatten(rr.risk_rating_note)) parts.push(`Note: ${flatten(rr.risk_rating_note)}`);
  return parts.join('\n');
}

function formatReviews(reviews: ReviewExportData[]): string {
  if (reviews.length === 0) return '';
  return reviews.map(r => {
    const status = r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '';
    const verdict = flatten(r.verdict);
    const comment = flatten(r.reviewerComment);
    const authorNote = flatten(r.authorComment);
    const parts = [status];
    if (verdict) parts.push(`Verdict: ${verdict}`);
    if (comment) parts.push(`Comment: ${comment}`);
    if (authorNote) parts.push(`Resolution: ${authorNote}`);
    return parts.join(' | ');
  }).join('\n');
}

// ── Sheet-name sanitisation ─────────────────────────────────────────────────

/**
 * Excel sheet names: max 31 chars, may not contain \ / ? * [ ] : and may not
 * be blank. We also strip single quotes so internal hyperlink targets of the
 * form #'Sheet'!A1 stay simple. Names are made unique by appending ~N.
 */
function sanitizeSheetName(rawName: string, used: Set<string>): string {
  let name = (rawName || 'Component')
    .replace(/[\\/?*[\]:']/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (name.length === 0) name = 'Component';
  if (name.length > 31) name = name.slice(0, 31).trim();

  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }

  // Disambiguate with a numeric suffix that still fits within 31 chars.
  for (let i = 2; ; i++) {
    const suffix = `~${i}`;
    const base = name.slice(0, 31 - suffix.length).trim();
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/** Build an internal hyperlink target string for a sheet/cell. */
function internalLink(sheetName: string, cell: string): string {
  // Single quotes inside the name are already stripped by sanitizeSheetName.
  return `#'${sheetName}'!${cell}`;
}

// ── Styling helpers ─────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F3A5F' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
const LINK_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF0563C1' }, underline: true };

function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle' };
  });
}

function setColumnWidths(sheet: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
}

// ── Flat models for the global tabs ─────────────────────────────────────────

interface TaskRow {
  componentName: string;
  sheetName: string;
  id: string;
  name: string;
  description: string;
  status: string;
  type: string;
  responsible: string;
  reference: string;
}

interface RequirementRow {
  componentName: string;
  sheetName: string;
  id: string;
  name: string;
  reqId: string;
  asil: string;
  text: string;
  link: string;
}

interface TagRow {
  componentName: string;
  sheetName: string;
  tag: string;
}

interface NoteRow {
  componentName: string;
  sheetName: string;
  id: string;
  noteText: string;
}

// ── Main entry point ─────────────────────────────────────────────────────────

const OVERVIEW_SHEET = 'Overview';
const TASKS_SHEET = 'Safety Tasks';
const REQUIREMENTS_SHEET = 'Safety Requirements';
const NOTES_SHEET = 'Safety Notes';
const TAGS_SHEET = 'Tags';

/**
 * Generate the safety-analysis workbook from a SafetyExportData object and
 * return it as an in-memory .xlsx buffer.
 */
export async function generateSafetyXlsx(data: SafetyExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RiaCore';
  workbook.created = new Date(data.generatedAt);

  // Components are already sorted by the aggregator; sort defensively.
  const components = [...data.components].sort((a, b) => a.name.localeCompare(b.name));

  // Assign a unique, Excel-safe sheet name to each component.
  const usedSheetNames = new Set<string>([
    OVERVIEW_SHEET.toLowerCase(),
    TASKS_SHEET.toLowerCase(),
    REQUIREMENTS_SHEET.toLowerCase(),
    NOTES_SHEET.toLowerCase(),
    TAGS_SHEET.toLowerCase(),
  ]);
  const sheetNameByComponent = new Map<number, string>();
  for (const component of components) {
    sheetNameByComponent.set(component.nodeId, sanitizeSheetName(component.name, usedSheetNames));
  }

  // ── Pre-compute the global tabs' rows (deterministic ordering) ────────────
  // Row maps let the per-component malfunction rows hyperlink to the exact
  // task / requirement row.
  const taskRows: TaskRow[] = [];
  const requirementRows: RequirementRow[] = [];
  const tagRows: TagRow[] = [];
  const noteRows: NoteRow[] = [];
  const taskRowById = new Map<string, number>();
  const requirementRowById = new Map<string, number>();

  const DATA_START_ROW = 2; // row 1 is the header
  for (const component of components) {
    const sheetName = sheetNameByComponent.get(component.nodeId)!;

    for (const task of component.safetyTasks) {
      taskRowById.set(task.id, DATA_START_ROW + taskRows.length);
      taskRows.push({
        componentName: component.name,
        sheetName,
        id: task.id,
        name: task.name,
        description: task.description,
        status: task.status,
        type: task.type,
        responsible: task.responsible ?? '',
        reference: task.reference ?? '',
      });
    }

    for (const req of component.requirements) {
      requirementRowById.set(req.id, DATA_START_ROW + requirementRows.length);
      requirementRows.push({
        componentName: component.name,
        sheetName,
        id: req.id,
        name: req.name,
        reqId: req.reqId,
        asil: req.reqAsil,
        text: req.reqText,
        link: req.reqLinkedTo ?? '',
      });
    }

    for (const tag of component.tags) {
      tagRows.push({ componentName: component.name, sheetName, tag });
    }

    for (const note of component.safetyNotes) {
      noteRows.push({
        componentName: component.name,
        sheetName,
        id: note.id,
        noteText: note.noteText,
      });
    }
  }

  // ── Build sheets (creation order = tab order) ─────────────────────────────
  buildOverviewSheet(workbook, components, sheetNameByComponent);
  for (const component of components) {
    buildComponentSheet(
      workbook,
      component,
      sheetNameByComponent.get(component.nodeId)!,
      taskRowById,
      requirementRowById,
    );
  }
  buildTasksSheet(workbook, taskRows);
  buildRequirementsSheet(workbook, requirementRows);
  buildNotesSheet(workbook, noteRows);
  buildTagsSheet(workbook, tagRows);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ── Overview sheet ────────────────────────────────────────────────────────────

function buildOverviewSheet(
  workbook: ExcelJS.Workbook,
  components: ComponentExportData[],
  sheetNameByComponent: Map<number, string>,
): void {
  const sheet = workbook.addWorksheet(OVERVIEW_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const header = sheet.addRow([
    'Component Name',
    'Component Type',
    'Tags',
    'Max ASIL',
    'Malfunctions',
    'Ports',
    'Ports without Malfunctions',
  ]);
  styleHeaderRow(header);

  for (const component of components) {
    const sheetName = sheetNameByComponent.get(component.nodeId)!;
    const row = sheet.addRow([
      component.name,
      component.componentType || 'Unknown',
      component.tags.join('; '),
      computeMaxAsil(component) ?? '',
      malfunctionCount(component),
      component.portCount ?? 0,
      portsWithoutMalfunctions(component),
    ]);
    // Hyperlink the component name to its analysis tab.
    const nameCell = row.getCell(1);
    nameCell.value = { text: component.name, hyperlink: internalLink(sheetName, 'A1') };
    nameCell.font = LINK_FONT;
  }

  setColumnWidths(sheet, [32, 22, 30, 10, 14, 8, 24]);
  sheet.autoFilter = { from: 'A1', to: 'G1' };
}

// ── Per-component malfunction sheet ────────────────────────────────────────────

function buildComponentSheet(
  workbook: ExcelJS.Workbook,
  component: ComponentExportData,
  sheetName: string,
  taskRowById: Map<string, number>,
  requirementRowById: Map<string, number>,
): void {
  const sheet = workbook.addWorksheet(sheetName);

  // ── Title + component metadata block ───────────────────────────────────
  const titleRow = sheet.addRow([`Component: ${component.name}`]);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 6);

  const meta: Array<[string, string]> = [
    ['Component Type', component.componentType || 'Unknown'],
    ['UUID', component.uuid || ''],
    ['Namespace', component.namespace || ''],
    ['Max ASIL', computeMaxAsil(component) ?? ''],
    ['Tags', component.tags.join('; ')],
    ['Safety Notes', component.safetyNotes.map(n => n.noteText).join(' | ')],
  ];
  if (component.arxmlPath) meta.push(['ARXML Path', component.arxmlPath]);
  for (const [label, value] of meta) {
    const r = sheet.addRow([label, value]);
    r.getCell(1).font = { bold: true };
  }

  // Back-link to the Overview tab.
  const backRow = sheet.addRow(['Back to Overview']);
  backRow.getCell(1).value = { text: 'Back to Overview', hyperlink: internalLink(OVERVIEW_SHEET, 'A1') };
  backRow.getCell(1).font = LINK_FONT;

  sheet.addRow([]); // spacer

  // ── Malfunction table header ────────────────────────────────────────────
  const header = sheet.addRow([
    'Element',
    'Element Type',
    'Malfunction ID',
    'Malfunction',
    'Description',
    'ASIL',
    'Risk Rating',
    'Propagates From',
    'Propagates To',
    'Safety Tasks',
    'Safety Requirements',
    'Review',
  ]);
  styleHeaderRow(header);
  const headerRowNumber = header.number;
  // Freeze everything above and including the table header.
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  const renderMfRow = (mf: MalfunctionExportData, elementType: string) => {
    const elementName = mf.portName ? mf.portName : component.name;
    const row = sheet.addRow([
      elementName,
      elementType,
      mf.id,
      mf.name,
      mf.description,
      mf.asil,
      formatRiskRating(mf.riskRating),
      mf.propagatesFromIds.join(', '),
      mf.propagatesToIds.join(', '),
      mf.taskIds.join(', '),
      mf.reqIds.join(', '),
      formatReviews(mf.reviews),
    ]);
    row.alignment = { vertical: 'top', wrapText: true };

    // Link the Safety Tasks cell to the first referenced task on the Tasks tab.
    if (mf.taskIds.length > 0) {
      const targetRow = taskRowById.get(mf.taskIds[0]);
      if (targetRow !== undefined) {
        const cell = row.getCell(10);
        cell.value = { text: mf.taskIds.join(', '), hyperlink: internalLink(TASKS_SHEET, `A${targetRow}`) };
        cell.font = LINK_FONT;
      }
    }
    // Link the Safety Requirements cell to the first referenced requirement.
    if (mf.reqIds.length > 0) {
      const targetRow = requirementRowById.get(mf.reqIds[0]);
      if (targetRow !== undefined) {
        const cell = row.getCell(11);
        cell.value = { text: mf.reqIds.join(', '), hyperlink: internalLink(REQUIREMENTS_SHEET, `A${targetRow}`) };
        cell.font = LINK_FONT;
      }
    }
  };

  for (const mf of component.functionalMFs) renderMfRow(mf, 'Component');
  for (const mf of component.receiverPortMFs) renderMfRow(mf, 'Receiver Port');
  for (const mf of component.providerPortMFs) renderMfRow(mf, 'Provider Port');

  if (malfunctionCount(component) === 0) {
    const note = sheet.addRow(['No malfunctions recorded for this component.']);
    sheet.mergeCells(note.number, 1, note.number, 12);
    note.getCell(1).font = { italic: true };
  }

  setColumnWidths(sheet, [24, 14, 18, 28, 40, 8, 30, 22, 22, 22, 24, 28]);

}

// ── Safety Tasks sheet ──────────────────────────────────────────────────────

function buildTasksSheet(workbook: ExcelJS.Workbook, taskRows: TaskRow[]): void {
  const sheet = workbook.addWorksheet(TASKS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const header = sheet.addRow([
    'Task ID',
    'Component',
    'Name',
    'Description',
    'Status',
    'Type',
    'Responsible',
    'Reference',
  ]);
  styleHeaderRow(header);

  for (const task of taskRows) {
    const row = sheet.addRow([
      task.id,
      task.componentName,
      task.name,
      task.description,
      task.status,
      task.type,
      task.responsible,
      task.reference,
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    const compCell = row.getCell(2);
    compCell.value = { text: task.componentName, hyperlink: internalLink(task.sheetName, 'A1') };
    compCell.font = LINK_FONT;
  }

  if (taskRows.length === 0) {
    sheet.addRow(['No safety tasks recorded.']).getCell(1).font = { italic: true };
  }

  setColumnWidths(sheet, [18, 24, 26, 44, 14, 16, 18, 18]);
  sheet.autoFilter = { from: 'A1', to: 'H1' };
}

// ── Safety Requirements sheet ───────────────────────────────────────────────

function buildRequirementsSheet(workbook: ExcelJS.Workbook, requirementRows: RequirementRow[]): void {
  const sheet = workbook.addWorksheet(REQUIREMENTS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const header = sheet.addRow([
    'Requirement ID',
    'Component',
    'Name',
    'External ID',
    'ASIL',
    'Requirement Text',
    'Link',
  ]);
  styleHeaderRow(header);

  for (const req of requirementRows) {
    const row = sheet.addRow([
      req.id,
      req.componentName,
      req.name,
      req.reqId,
      req.asil,
      req.text,
      req.link,
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    const compCell = row.getCell(2);
    compCell.value = { text: req.componentName, hyperlink: internalLink(req.sheetName, 'A1') };
    compCell.font = LINK_FONT;

    if (req.link) {
      const linkCell = row.getCell(7);
      linkCell.value = { text: req.link, hyperlink: req.link };
      linkCell.font = LINK_FONT;
    }
  }

  if (requirementRows.length === 0) {
    sheet.addRow(['No safety requirements recorded.']).getCell(1).font = { italic: true };
  }

  setColumnWidths(sheet, [20, 24, 26, 18, 8, 50, 28]);
  sheet.autoFilter = { from: 'A1', to: 'G1' };
}

// ── Safety Notes sheet ──────────────────────────────────────────────────────

function buildNotesSheet(workbook: ExcelJS.Workbook, noteRows: NoteRow[]): void {
  const sheet = workbook.addWorksheet(NOTES_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const header = sheet.addRow(['Note ID', 'Component', 'Note']);
  styleHeaderRow(header);

  for (const note of noteRows) {
    const row = sheet.addRow([note.id, note.componentName, note.noteText]);
    row.alignment = { vertical: 'top', wrapText: true };
    const compCell = row.getCell(2);
    compCell.value = { text: note.componentName, hyperlink: internalLink(note.sheetName, 'A1') };
    compCell.font = LINK_FONT;
  }

  if (noteRows.length === 0) {
    sheet.addRow(['No safety notes recorded.']).getCell(1).font = { italic: true };
  }

  setColumnWidths(sheet, [18, 24, 70]);
  sheet.autoFilter = { from: 'A1', to: 'C1' };
}

// ── Tags sheet ──────────────────────────────────────────────────────────────

function buildTagsSheet(workbook: ExcelJS.Workbook, tagRows: TagRow[]): void {
  const sheet = workbook.addWorksheet(TAGS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const header = sheet.addRow(['Tag', 'Component']);
  styleHeaderRow(header);

  for (const tag of tagRows) {
    const row = sheet.addRow([tag.tag, tag.componentName]);
    const compCell = row.getCell(2);
    compCell.value = { text: tag.componentName, hyperlink: internalLink(tag.sheetName, 'A1') };
    compCell.font = LINK_FONT;
  }

  if (tagRows.length === 0) {
    sheet.addRow(['No tags recorded.']).getCell(1).font = { italic: true };
  }

  setColumnWidths(sheet, [28, 28]);
  sheet.autoFilter = { from: 'A1', to: 'B1' };
}