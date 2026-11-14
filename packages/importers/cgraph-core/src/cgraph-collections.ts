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
 * cgraph-collections.ts — streaming readers for the JSONL collections.
 *
 * Deliberately line-at-a-time rather than `readFileSync(...).split('\n')`. On a
 * full-build corpus `nodes/c_typedef.jsonl` and `edges/defines_type.jsonl` reach
 * hundreds of megabytes; reading one whole and then splitting it holds the text
 * and the array of lines in memory simultaneously, at which point the import
 * fails for reasons that have nothing to do with the graph.
 *
 * Both readers skip blank lines and report a malformed or incomplete record
 * rather than throwing. One bad line in a 200MB collection should cost that
 * line, not the run — and a counted, reported drop is visible in reconciliation,
 * whereas an aborted import tells the user nothing about how much was good.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ConceptBatch, RelationshipBatch } from '@riacore/app-contracts';

export interface CollectionReadIssue {
  /** 1-based line number within the collection file. */
  line: number;
  reason: string;
}

export interface NodeCollection {
  concept: string;
  batch: ConceptBatch;
  issues: CollectionReadIssue[];
  /** True when the file is absent — a legitimate empty collection. */
  missing: boolean;
}

export interface EdgeCollection {
  slot: string;
  batch: RelationshipBatch;
  issues: CollectionReadIssue[];
  missing: boolean;
  /** Records whose endpoints were not among the imported concepts — the sum of the two below. */
  droppedUnknownEndpoint: number;
  /**
   * Of those, records whose every missing endpoint is a node of a deselected
   * concept. Dropped by the user's element selection, so reconciliation
   * subtracts them from the manifest count.
   */
  droppedExcludedEndpoint: number;
  /** `droppedExcludedEndpoint` split by the deselected concept of the missing endpoint. */
  droppedExcludedByConcept: Record<string, number>;
  /**
   * Records with an endpoint that is neither imported nor a deselected node:
   * a node the write service refused, a truncated node collection, or an edge
   * the generator emitted to nothing. A defect; reconciliation reports it.
   */
  droppedUnresolvedEndpoint: number;
}

async function* readLines(file: string): AsyncGenerator<{ text: string; line: number }> {
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of reader) {
      line += 1;
      yield { text, line };
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

function parseRecord(text: string): Record<string, unknown> | null {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Read one `nodes/<concept>.jsonl` into a ConceptBatch.
 *
 * `stable_path` is copied into the item's `stablePath` *and* left in
 * `attributes`, where the generator already put it. Both are load-bearing:
 * `bulkCreateConcepts` keys its returned NodeIdMap on `stablePath`, but
 * `bulkCreateRelationships` rebuilds its endpoint lookup by re-reading each
 * stored node's `attributes.stable_path`. Drop it from the attributes and every
 * edge is silently skipped.
 *
 * A duplicate path is rejected rather than overwritten. Identity is unique
 * across concepts by the generator's prefix discipline, so a repeat means the
 * output is inconsistent, and keeping one arbitrarily would wire that concept's
 * edges to whichever record happened to win.
 */
export async function readNodeCollection(
  file: string,
  concept: string,
  claimedPaths: Set<string>,
): Promise<NodeCollection> {
  const batch: ConceptBatch = { concept, items: [] };
  const issues: CollectionReadIssue[] = [];

  if (!existsSync(file)) {
    return { concept, batch, issues, missing: true };
  }

  for await (const { text, line } of readLines(file)) {
    const trimmed = text.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown> | null;
    try {
      record = parseRecord(trimmed);
    } catch (err) {
      issues.push({ line, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!record) {
      issues.push({ line, reason: 'record is not a JSON object' });
      continue;
    }

    const stablePath = typeof record.stable_path === 'string' ? record.stable_path : '';
    if (!stablePath) {
      issues.push({ line, reason: 'missing or empty stable_path' });
      continue;
    }
    if (claimedPaths.has(stablePath)) {
      issues.push({ line, reason: `duplicate stable_path: ${stablePath}` });
      continue;
    }

    const attributes = (record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes))
      ? { ...record.attributes as Record<string, unknown> }
      : {};
    attributes.stable_path = stablePath;

    claimedPaths.add(stablePath);
    batch.items.push({ stablePath, attributes });
  }

  return { concept, batch, issues, missing: false };
}

/**
 * Read one `edges/<slot>.jsonl` into a RelationshipBatch.
 *
 * Endpoints are checked against `knownPaths` here rather than left to the write
 * service. The write service also skips an unresolvable endpoint, but silently
 * and without a count, so a deselected element group or a truncated collection
 * would show up only as a smaller number than expected. Counting the drops is
 * what makes the reconciliation step in the runtime able to distinguish
 * "selection removed these" from "something went wrong".
 */
export async function readEdgeCollection(
  file: string,
  slot: string,
  knownPaths: Set<string>,
  /** stable_path → concept, for nodes of concepts the selection turned off. */
  excludedPaths: ReadonlyMap<string, string> = new Map(),
): Promise<EdgeCollection> {
  const batch: RelationshipBatch = { relationship: slot, items: [] };
  const issues: CollectionReadIssue[] = [];
  let droppedExcludedEndpoint = 0;
  let droppedUnresolvedEndpoint = 0;
  const droppedExcludedByConcept: Record<string, number> = {};
  const result = (missing: boolean): EdgeCollection => ({
    slot,
    batch,
    issues,
    missing,
    droppedUnknownEndpoint: droppedExcludedEndpoint + droppedUnresolvedEndpoint,
    droppedExcludedEndpoint,
    droppedExcludedByConcept,
    droppedUnresolvedEndpoint,
  });

  if (!existsSync(file)) {
    return result(true);
  }

  for await (const { text, line } of readLines(file)) {
    const trimmed = text.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown> | null;
    try {
      record = parseRecord(trimmed);
    } catch (err) {
      issues.push({ line, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!record) {
      issues.push({ line, reason: 'record is not a JSON object' });
      continue;
    }

    const source = typeof record.source === 'string' ? record.source : '';
    const target = typeof record.target === 'string' ? record.target : '';
    if (!source || !target) {
      issues.push({ line, reason: 'missing or empty source/target' });
      continue;
    }

    const sourceKnown = knownPaths.has(source);
    const targetKnown = knownPaths.has(target);
    if (!sourceKnown || !targetKnown) {
      // Excluded only when EVERY missing endpoint is a deselected node. One
      // unresolved end makes the record a defect, even if the other end was
      // deselected — otherwise deselection could hide a dangling edge.
      const excluded = (sourceKnown || excludedPaths.has(source))
        && (targetKnown || excludedPaths.has(target));
      if (excluded) {
        droppedExcludedEndpoint += 1;
        // Attributed to the source's concept when both ends were deselected.
        const concept = excludedPaths.get(sourceKnown ? target : source) ?? 'unknown';
        droppedExcludedByConcept[concept] = (droppedExcludedByConcept[concept] ?? 0) + 1;
      } else {
        droppedUnresolvedEndpoint += 1;
      }
      continue;
    }

    const attributes = (record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes))
      ? record.attributes as Record<string, unknown>
      : {};

    batch.items.push({
      sourceStablePath: source,
      targetStablePath: target,
      attributes,
    });
  }

  return result(false);
}

/**
 * Collect only the `stable_path` of every record in a node collection.
 *
 * Used for concepts the element selection turned OFF, so the edge reader can
 * tell an edge dropped by that choice from one whose endpoint is genuinely
 * missing. Nothing is imported from these files and their attributes are not
 * retained; a malformed line is ignored, which can only make an edge look
 * unresolved (reported) rather than excluded (silent). Absent file → no paths.
 */
export async function readStablePaths(
  file: string,
  concept: string,
  into: Map<string, string>,
): Promise<void> {
  if (!existsSync(file)) return;
  for await (const { text } of readLines(file)) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      const record = parseRecord(trimmed);
      if (record && typeof record.stable_path === 'string' && record.stable_path) {
        into.set(record.stable_path, concept);
      }
    } catch {
      // See above: an unreadable line never widens what counts as excluded.
    }
  }
}

export interface GeneratorDiagnostic {
  severity: string;
  rule: string;
  detail?: string;
  file?: string;
  line?: number;
}

/**
 * Read the generator's own diagnostics channel.
 *
 * These are facts the generator could not turn into an edge — an indirect call,
 * a write through a pointer, a member type that reduces to no named type. They
 * belong in the import report because they describe where the graph's claims
 * stop holding, which a reviewer reading an absence needs to know.
 */
export async function readGeneratorDiagnostics(file: string): Promise<GeneratorDiagnostic[]> {
  if (!existsSync(file)) return [];
  const out: GeneratorDiagnostic[] = [];
  for await (const { text } of readLines(file)) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      const record = parseRecord(trimmed);
      if (!record) continue;
      out.push({
        severity: typeof record.severity === 'string' ? record.severity : 'info',
        rule: typeof record.rule === 'string' ? record.rule : 'unknown',
        detail: typeof record.detail === 'string' ? record.detail : undefined,
        file: typeof record.file === 'string' ? record.file : undefined,
        line: typeof record.line === 'number' ? record.line : undefined,
      });
    } catch {
      // A malformed diagnostics line must not fail an otherwise good import.
    }
  }
  return out;
}
