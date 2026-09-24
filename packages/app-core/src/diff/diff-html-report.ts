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
 * Self-contained HTML report for a computed diff — an archival record of a
 * change set as it was reviewed.
 *
 * Design constraints, in priority order:
 *
 *  1. **Archivable.** One file, no external CSS, fonts, or scripts. It must
 *     still render correctly years later, opened from a network share, offline.
 *  2. **Fully expanded.** Every section and every attribute change is visible
 *     without interaction, because the reader may be printing it or reading it
 *     in a viewer that runs no JavaScript.
 *  3. **Same words as the UI.** Labels and word-level highlighting come from
 *     `@riacore/app-contracts` (diff-presentation.ts), the same module the
 *     review screen uses, so the document cannot describe the change set
 *     differently from the screen it was exported from.
 */

import type {
  NamespaceDiffResult,
  NodeSnapshot,
  NodeModification,
  EdgeSnapshot,
  EdgeModification,
  CrossNsEdgeSnapshot,
  CrossNsEdgeModification,
  PropertyChange,
  Segment,
} from '@riacore/app-contracts';
import {
  labelSectionHeading,
  labelConceptType,
  labelAttributeKey,
  labelRelationshipType,
  diffPropertyValues,
  splitChangedTextForDisplay,
} from '@riacore/app-contracts';

/** Context shown in the report header. All optional — a diff may be standalone. */
export interface DiffHtmlReportMeta {
  /** Target namespace the change set would be applied to. */
  targetNamespace?: string;
  /** Git ref the change set came from, e.g. `origin/feature-x`. */
  sourceRef?: string;
  /** Short commit hash of `sourceRef`. */
  sourceCommit?: string;
  /** Composite selection keys the reviewer had ticked, if a subset. */
  selectedChangeIds?: string[];
  /** ISO timestamp for the report itself. Defaults to now. */
  exportedAt?: string;
}

// ── Escaping ──────────────────────────────────────────────────────────────────

/**
 * Escape for HTML text and attribute contexts.
 *
 * Model content is user data and lands directly in the document: a requirement
 * text containing `<script>` must not become one.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a changed segment, making informative whitespace visible.
 *
 * Which whitespace qualifies is decided by `splitChangedTextForDisplay` in
 * app-contracts, shared with the on-screen review so both mark the same things.
 * A newline emits its glyph plus the real newline, so `pre-wrap` still breaks
 * where the stored value does.
 */
function escChangedText(text: string, whitespaceOnlyChange: boolean): string {
  return splitChangedTextForDisplay(text, whitespaceOnlyChange)
    .map((part) => {
      if (!part.mark) return esc(part.text);
      const cls = part.label ? 'ws exotic' : 'ws';
      const title = part.label ? ` title="${esc(part.label)}"` : '';
      const glyph = `<span class="${cls}"${title}>${esc(part.glyph ?? '')}</span>`;
      return part.text === '\n' ? `${glyph}\n` : glyph;
    })
    .join('');
}

function renderSegments(segments: Segment[], whitespaceOnlyChange: boolean): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'same') return esc(segment.text);
      const cls = segment.kind === 'removed' ? 'del' : 'ins';
      return `<span class="${cls}">${escChangedText(segment.text, whitespaceOnlyChange)}</span>`;
    })
    .join('');
}

function renderPlainValue(value: unknown): string {
  if (value === undefined || value === null) return '<span class="empty">—</span>';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return esc(text);
}

// ── Element naming ────────────────────────────────────────────────────────────

const NAME_ATTRS = [
  'has_name', 'short_name', 'req_name', 'name', 'title', 'note_text', 'tag_name',
];

function displayName(attributes: Record<string, unknown>): string {
  for (const attr of NAME_ATTRS) {
    const value = attributes[attr];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// ── Attribute change table ────────────────────────────────────────────────────

function renderPropertyChanges(changes: PropertyChange[], metamodel: string): string {
  if (changes.length === 0) return '';

  const rows = changes.map((change) => {
    const wordDiff = diffPropertyValues(change.changeKind, change.leftValue, change.rightValue);
    const wsOnly = wordDiff?.whitespaceOnly ?? false;
    const left = wordDiff ? renderSegments(wordDiff.left, wsOnly) : renderPlainValue(change.leftValue);
    const right = wordDiff ? renderSegments(wordDiff.right, wsOnly) : renderPlainValue(change.rightValue);
    const wsNote = wordDiff?.whitespaceOnly
      ? ' <span class="badge ws-badge" title="The values differ only in whitespace.">whitespace only</span>'
      : '';
    return `
        <tr>
          <td class="kind"><span class="badge ${esc(change.changeKind)}">${esc(change.changeKind)}</span></td>
          <td class="attr" title="${esc(change.attribute)}">${esc(labelAttributeKey(change.attribute, metamodel))}${wsNote}</td>
          <td class="val">${left}</td>
          <td class="val">${right}</td>
        </tr>`;
  });

  return `
      <table class="attrs">
        <thead>
          <tr><th>Change</th><th>Attribute</th><th>Left value</th><th>Right value</th></tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>`;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderNodeSnapshots(items: NodeSnapshot[], metamodel: string): string {
  return items.map((node) => {
    const name = displayName(node.attributes);
    const attrRows = Object.entries(node.attributes)
      .filter(([key]) => key !== 'stable_path')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `
        <tr>
          <td class="attr" title="${esc(key)}">${esc(labelAttributeKey(key, metamodel))}</td>
          <td class="val" colspan="2">${renderPlainValue(value)}</td>
        </tr>`)
      .join('');

    return `
    <div class="item">
      <div class="item-head">
        <span class="item-name">${esc(name || node.stableId)}</span>
        <span class="type">${esc(labelConceptType(node.conceptType, metamodel))}</span>
      </div>
      <div class="item-id">${esc(node.stableId)}</div>
      ${attrRows ? `<table class="attrs"><tbody>${attrRows}</tbody></table>` : ''}
    </div>`;
  }).join('');
}

function renderNodeModifications(items: NodeModification[], metamodel: string): string {
  return items.map((mod) => {
    const snapshot = mod.rightSnapshot ?? mod.leftSnapshot;
    const name = displayName(snapshot.attributes);
    return `
    <div class="item">
      <div class="item-head">
        <span class="item-name">${esc(name || mod.stableId)}</span>
        <span class="type">${esc(labelConceptType(mod.conceptType, metamodel))}</span>
        <span class="count">${mod.propertyChanges.length} attribute change(s)</span>
      </div>
      <div class="item-id">${esc(mod.stableId)}</div>
      ${renderPropertyChanges(mod.propertyChanges, metamodel)}
    </div>`;
  }).join('');
}

type AnyEdge = EdgeSnapshot | CrossNsEdgeSnapshot | EdgeModification | CrossNsEdgeModification;

function edgeEndpoint(label: string | undefined, stableId: string): string {
  return esc(label || stableId);
}

function renderEdges(items: AnyEdge[], metamodel: string): string {
  return items.map((edge) => {
    const changes = (edge as EdgeModification).propertyChanges ?? [];
    const source = edgeEndpoint(edge.sourceLabel, edge.sourceStableId);
    const target = edgeEndpoint(edge.targetLabel, edge.targetStableId);
    const sourceType = edge.sourceConceptType
      ? `<span class="type">${esc(labelConceptType(edge.sourceConceptType, metamodel))}</span>`
      : '';
    const targetType = edge.targetConceptType
      ? `<span class="type">${esc(labelConceptType(edge.targetConceptType, metamodel))}</span>`
      : '';

    return `
    <div class="item">
      <div class="item-head">
        <span class="item-name">${source} ${sourceType} <span class="arrow">→</span> ${target} ${targetType}</span>
        <span class="type rel">${esc(labelRelationshipType(edge.relationshipType, metamodel))}</span>
      </div>
      <div class="item-id">${esc(edge.sourceStableId)} → ${esc(edge.targetStableId)} (${esc(edge.relationshipType)})</div>
      ${renderPropertyChanges(changes, metamodel)}
    </div>`;
  }).join('');
}

function section(heading: string, count: number, body: string): string {
  if (count === 0) return '';
  return `
  <section>
    <h2>${esc(heading)} <span class="count">(${count})</span></h2>
    ${body}
  </section>`;
}

// ── Stylesheet ────────────────────────────────────────────────────────────────

/**
 * Deliberately plain and light-themed: this is a document to archive, attach to
 * a review record, or print — not a reproduction of the dark app UI.
 */
const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 28px; background: #fff; color: #1a1a1a;
    font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 {
    font-size: 14px; margin: 26px 0 8px; padding-bottom: 4px;
    border-bottom: 2px solid #d0d0d0;
  }
  .count { font-weight: 400; color: #666; }
  .meta { margin: 0 0 4px; color: #333; }
  .meta table { border-collapse: collapse; margin-top: 8px; }
  .meta th, .meta td { text-align: left; padding: 2px 14px 2px 0; vertical-align: top; }
  .meta th { color: #666; font-weight: 500; white-space: nowrap; }
  code { font-family: Consolas, "Cascadia Code", monospace; }
  .item { border: 1px solid #ddd; border-radius: 4px; margin: 8px 0; padding: 8px 10px; page-break-inside: avoid; }
  .item-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .item-name { font-weight: 600; }
  .arrow { color: #888; font-weight: 400; }
  .type {
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
    color: #555; background: #f0f0f0; border: 1px solid #ddd;
    border-radius: 3px; padding: 1px 5px; white-space: nowrap;
  }
  .type.rel { background: #eef3fb; border-color: #cddcf3; color: #2a4c80; }
  .item-id { font-family: Consolas, monospace; font-size: 10px; color: #999; margin-top: 2px; word-break: break-all; }
  table.attrs { width: 100%; border-collapse: collapse; margin-top: 8px; table-layout: fixed; }
  table.attrs th {
    text-align: left; font-size: 11px; color: #555; font-weight: 600;
    border-bottom: 1px solid #ddd; padding: 3px 6px;
  }
  table.attrs td { border-bottom: 1px solid #f0f0f0; padding: 4px 6px; vertical-align: top; }
  td.kind { width: 78px; }
  td.attr { width: 150px; font-size: 12px; }
  /* pre-wrap so the rendered value matches the stored value: HTML would
     otherwise collapse whitespace runs and drop trailing newlines. */
  td.val { font-family: Consolas, "Cascadia Code", monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .empty { color: #999; font-style: italic; }
  .badge {
    display: inline-block; font-size: 10px; border-radius: 3px;
    padding: 1px 5px; border: 1px solid transparent; white-space: nowrap;
  }
  .badge.added { background: #e8f6ec; border-color: #b7e0c3; color: #1f6b35; }
  .badge.deleted { background: #fdeaea; border-color: #f2c2c2; color: #8c2020; }
  .badge.modified { background: #fdf3e3; border-color: #f0d9ad; color: #8a5a10; }
  .ws-badge { background: #f2f2f2; border-color: #ddd; color: #666; }
  .ins { background: #d7f2de; color: #12591f; border-radius: 2px; }
  .del { background: #fbd9d9; color: #8c1f1f; text-decoration: line-through; border-radius: 2px; }
  .ws { opacity: .55; }
  .ws.exotic { outline: 1px dotted currentColor; }
  footer { margin-top: 32px; padding-top: 8px; border-top: 1px solid #ddd; color: #888; font-size: 11px; }
  @media print { body { padding: 0; } .item { border-color: #bbb; } }
`;

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Render a diff result as a standalone HTML document.
 *
 * Pure: takes a result, returns a string. No file system, no DB — which keeps it
 * directly unit-testable and reusable from the CLI.
 */
export function renderDiffHtmlReport(
  result: NamespaceDiffResult,
  meta: DiffHtmlReportMeta = {},
): string {
  const mm = result.metamodel;
  const exportedAt = meta.exportedAt ?? new Date().toISOString();

  const totalChanges =
    result.addedNodes.length + result.deletedNodes.length + result.modifiedNodes.length +
    result.addedEdges.length + result.deletedEdges.length + result.modifiedEdges.length +
    result.addedCrossNsEdges.length + result.deletedCrossNsEdges.length +
    result.modifiedCrossNsEdges.length;

  const metaRow = (label: string, value: string | undefined): string =>
    value ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>` : '';

  const selectionNote = meta.selectedChangeIds
    ? `<tr><th>Selection</th><td>${meta.selectedChangeIds.length} of ${totalChanges} change(s) were selected for merge</td></tr>`
    : '';

  const body = [
    section(labelSectionHeading('modifiedNodes'), result.modifiedNodes.length,
      renderNodeModifications(result.modifiedNodes, mm)),
    section(labelSectionHeading('addedNodes'), result.addedNodes.length,
      renderNodeSnapshots(result.addedNodes, mm)),
    section(labelSectionHeading('deletedNodes'), result.deletedNodes.length,
      renderNodeSnapshots(result.deletedNodes, mm)),
    section(labelSectionHeading('modifiedEdges'), result.modifiedEdges.length,
      renderEdges(result.modifiedEdges, mm)),
    section(labelSectionHeading('addedEdges'), result.addedEdges.length,
      renderEdges(result.addedEdges, mm)),
    section(labelSectionHeading('deletedEdges'), result.deletedEdges.length,
      renderEdges(result.deletedEdges, mm)),
    section(labelSectionHeading('modifiedCrossNsEdges'), result.modifiedCrossNsEdges.length,
      renderEdges(result.modifiedCrossNsEdges, mm)),
    section(labelSectionHeading('addedCrossNsEdges'), result.addedCrossNsEdges.length,
      renderEdges(result.addedCrossNsEdges, mm)),
    section(labelSectionHeading('deletedCrossNsEdges'), result.deletedCrossNsEdges.length,
      renderEdges(result.deletedCrossNsEdges, mm)),
  ].join('');

  const title = meta.targetNamespace
    ? `Change Set — ${meta.targetNamespace}`
    : `Change Set — ${result.leftNamespace} vs ${result.rightNamespace}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="meta">
  <table>
    ${metaRow('Target namespace', meta.targetNamespace)}
    ${metaRow('Source branch / tag', meta.sourceRef)}
    ${metaRow('Source commit', meta.sourceCommit)}
    ${metaRow('Left namespace', result.leftNamespace)}
    ${metaRow('Right namespace', result.rightNamespace)}
    ${metaRow('Metamodel', result.metamodel)}
    ${metaRow('Diff computed', result.computedAt)}
    ${metaRow('Report exported', exportedAt)}
    <tr><th>Total changes</th><td>${totalChanges}</td></tr>
    ${selectionNote}
  </table>
</div>
${totalChanges === 0 ? '<p class="empty">No differences.</p>' : body}
${result.skippedNodes.length > 0 ? `
  <section>
    <h2>Skipped Elements <span class="count">(${result.skippedNodes.length})</span></h2>
    ${result.skippedNodes.map((s) => `
    <div class="item">
      <div class="item-head">
        <span class="item-name">${esc(displayName(s.attributes) || '(unnamed)')}</span>
        <span class="type">${esc(labelConceptType(s.conceptType, mm))}</span>
      </div>
      <div class="item-id">${esc(s.reason)}</div>
    </div>`).join('')}
  </section>` : ''}
<footer>
  Generated by RIA-Core. Diff ID <code>${esc(result.diffId)}</code>.
  Changed words are highlighted; whitespace inside a change is shown as · ⇥ ↵ ␍.
</footer>
</body>
</html>
`;
}
