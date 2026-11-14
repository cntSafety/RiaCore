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
 * cgraph-runtime.ts — loads a CGraph generator output directory into the graph.
 *
 * This is a loader, not a parser. The generator has already resolved every call
 * target, classified every variable access and assigned every stable path, so
 * each `nodes/<concept>.jsonl` line is a ConceptBatch item and each
 * `edges/<slot>.jsonl` line is a RelationshipBatch item. The work here is
 * selection, streaming, endpoint integrity and reconciliation.
 *
 * Order matters in one place: all selected node collections are read and written
 * before any edge collection is read, because an edge can only be emitted once
 * both endpoints are known to exist. That is also why the known-path set is
 * accumulated across concepts rather than per concept — `calls` runs between two
 * functions, but `owns_file` crosses from component to file.
 */

import type { ImporterRuntime, ImporterContext, ImporterResult } from '@riacore/importer-sdk';
import { resolveWorkspacePath } from '@riacore/importer-sdk';
import type { ImportDiagnostic, ConceptBatch, RelationshipBatch } from '@riacore/app-contracts';
import { normalizeElementSelection, resolveSelection } from './cgraph-selection.js';
import type { CgraphImportConfig } from './cgraph-config.js';
import {
  readManifest,
  gateSchemaVersion,
  nodeCollectionPath,
  edgeCollectionPath,
  diagnosticsPath,
  type CgraphManifest,
} from './cgraph-manifest.js';
import {
  readNodeCollection,
  readEdgeCollection,
  readGeneratorDiagnostics,
  readStablePaths,
  type CollectionReadIssue,
} from './cgraph-collections.js';
import {
  CGRAPH_CONCEPTS,
  CGRAPH_SLOT_ENDPOINTS,
  expandConcepts,
  type CgraphConcept,
  type CgraphSlot,
} from './cgraph-schema.js';

/**
 * How many malformed-record details to report per collection.
 *
 * A systematically broken collection produces one issue per line. Reporting all
 * of them would bury the summary that actually tells the user what happened, so
 * the count is always exact and the examples are capped.
 */
const MAX_REPORTED_ISSUES_PER_COLLECTION = 5;

/** How many generator diagnostic details to write to the log per rule. */
const MAX_LOGGED_DIAGNOSTIC_DETAILS_PER_RULE = 20;

/**
 * Resolve the generator output directory.
 *
 * A secondary path the runtime owns, like `needs_file` in the Sphinx-Needs
 * importer: `context.projectDir` is `project_dir` pre-resolved, and for this
 * importer that is the advisory repository root, not the input. Anchoring is
 * still the workspace root — never the config file's directory.
 */
export function resolveScanResultDir(context: ImporterContext, config: CgraphImportConfig): string {
  return resolveWorkspacePath(context.workspaceRoot, config.scan_result_dir, context.projectDir);
}

function describeIssues(label: string, issues: CollectionReadIssue[]): string {
  const examples = issues
    .slice(0, MAX_REPORTED_ISSUES_PER_COLLECTION)
    .map((i) => `line ${i.line}: ${i.reason}`)
    .join('; ');
  const suffix = issues.length > MAX_REPORTED_ISSUES_PER_COLLECTION
    ? ` (showing ${MAX_REPORTED_ISSUES_PER_COLLECTION} of ${issues.length})`
    : '';
  return `${label}: skipped ${issues.length} malformed record(s)${suffix}. ${examples}`;
}

/**
 * Compare what the manifest promised against what was imported.
 *
 * The one check that distinguishes "selection removed these" from "the loader or
 * the output is wrong", and it is free because the manifest is already parsed.
 * Only selected collections are compared — an unselected one is expected to be
 * absent, not missing.
 */
export function reconcileCounts(
  manifest: CgraphManifest,
  imported: { nodes: Record<string, number>; edges: Record<string, number> },
  excluded: { edges: Record<string, number> } = { edges: {} },
): string[] {
  const discrepancies: string[] = [];

  for (const [concept, count] of Object.entries(imported.nodes)) {
    const expected = manifest.counts.nodes[concept];
    if (expected === undefined) {
      if (count > 0) {
        discrepancies.push(`nodes/${concept}: imported ${count}, manifest does not list this concept`);
      }
    } else if (expected !== count) {
      discrepancies.push(`nodes/${concept}: manifest ${expected}, imported ${count}`);
    }
  }

  // The gate stays exact: the only thing subtracted is the per-record count of
  // edges whose missing endpoints are all nodes of a deselected concept, which
  // the edge reader established line by line. Anything else short — a malformed
  // line, a refused node, a truncated node collection — still shows here.
  for (const [slot, count] of Object.entries(imported.edges)) {
    const listed = manifest.counts.edges[slot];
    const byselection = excluded.edges[slot] ?? 0;
    if (listed === undefined) {
      if (count > 0) {
        discrepancies.push(`edges/${slot}: imported ${count}, manifest does not list this relationship`);
      }
      continue;
    }
    const expected = listed - byselection;
    if (expected !== count) {
      discrepancies.push(byselection > 0
        ? `edges/${slot}: manifest ${listed}, ${byselection} excluded by element selection, ` +
          `expected ${expected}, imported ${count}`
        : `edges/${slot}: manifest ${listed}, imported ${count}`);
    }
  }

  return discrepancies;
}

/**
 * Deselected concepts that some selected slot can reach.
 *
 * Only these need their stable paths read: an edge can be excluded by
 * selection only if one of its endpoints is of such a concept. A deselected
 * concept no selected slot touches (the whole type layer with `types` off)
 * costs nothing.
 */
export function excludedEndpointConcepts(
  selectedConcepts: readonly CgraphConcept[],
  selectedSlots: readonly CgraphSlot[],
): CgraphConcept[] {
  const selected = new Set(selectedConcepts);
  const reachable = new Set<CgraphConcept>();
  for (const slot of selectedSlots) {
    const { domain, range } = CGRAPH_SLOT_ENDPOINTS[slot];
    for (const c of [...expandConcepts(domain), ...expandConcepts(range)]) {
      if (!selected.has(c)) reachable.add(c);
    }
  }
  return CGRAPH_CONCEPTS.filter((c) => reachable.has(c));
}


/**
 * One report line per analysis unit, or one saying there is no value analysis.
 *
 * Only called when the `value_analysis` group is on. A manifest without the
 * block (pre-2.6 output, or a generator run with value analysis disabled) is
 * not an error, but it means every may_* / flows_to collection is legitimately
 * empty, which is worth saying rather than leaving the user to infer it.
 */
export function describeValueAnalysis(manifest: CgraphManifest): string[] {
  const va = manifest.value_analysis;
  if (!va || va.units.length === 0) {
    return [
      'The CGraph output carries no value analysis, so no may_read, may_write, ' +
      'may_dispatch_to or flows_to facts are imported. AST facts are unaffected.',
    ];
  }
  const tool = va.tool ?? 'an unnamed analyser';
  return va.units.map((unit) => {
    const reached = unit.functions_reached !== undefined && unit.functions_defined !== undefined
      ? `reached ${unit.functions_reached} of ${unit.functions_defined} function(s)`
      : 'reach not reported';
    const alarms = unit.alarms !== undefined ? `, ${unit.alarms} alarm(s)` : '';
    const status = unit.status ? `, status ${unit.status}` : '';
    return `Value analysis unit '${unit.name}' by ${tool}` +
      `${unit.entry ? ` from entry '${unit.entry}'` : ''}: ${reached}${alarms}${status}. ` +
      'Value-analysis facts are sound over-approximations in this unit; an absent ' +
      'edge is meaningful only for a function with analysis_reached = true.';
  });
}

export function createCgraphRuntime(): ImporterRuntime {
  return {
    async run(context: ImporterContext): Promise<ImporterResult> {
      const t0 = Date.now();
      const raw = (context.config ?? {}) as Partial<CgraphImportConfig> & { elements?: unknown };
      const config: CgraphImportConfig = {
        namespace: String(raw.namespace ?? ''),
        source_name: raw.source_name,
        sourceType: String(raw.sourceType ?? 'cgraph_graph'),
        scan_result_dir: raw.scan_result_dir,
        project_dir: raw.project_dir,
        elements: normalizeElementSelection(
          (raw.elements && typeof raw.elements === 'object')
            ? raw.elements as Record<string, unknown>
            : undefined,
        ),
      };

      const diagnostics: ImportDiagnostic[] = [];
      const scanResultDir = resolveScanResultDir(context, config);

      // ── Manifest and schema gate ──────────────────────────────────────────
      // Orchestration preflight has already run both before namespace
      // replacement; this read is for the counts, and it re-gates so the
      // runtime is also correct when driven directly in a test.
      context.onProgress({ phase: 'parsing', message: 'Reading CGraph manifest...' });
      const manifest = readManifest(scanResultDir);
      const gate = gateSchemaVersion(manifest);
      if (gate.warning) {
        context.logger.warn(gate.warning);
        diagnostics.push({ level: 'warning', message: gate.warning });
      }

      context.logger.info('CGraph output identified', {
        scanResultDir,
        schema: manifest.schema,
        schemaVersion: manifest.schema_version,
        generatorVersion: manifest.generator_version,
        buildId: manifest.build_id,
        generatedAt: manifest.generated_at,
        translationUnits: manifest.translation_units?.length ?? 0,
      });

      // ── Value-analysis provenance (schema 2.6.0) ───────────────────────────
      // may_* and flows_to are over-approximations within an analysis unit,
      // and an absent edge means something only for a reached function. The
      // report therefore states which analyser produced them and how much of
      // each unit it reached, so a reviewer reads the facts in context.
      if (config.elements.value_analysis) {
        for (const message of describeValueAnalysis(manifest)) {
          context.logger.info(message);
          diagnostics.push({ level: 'info', message, source: 'manifest.json' });
        }
        if (manifest.value_analysis) {
          context.logger.info('CGraph value-analysis provenance', {
            tool: manifest.value_analysis.tool,
            settings: manifest.value_analysis.settings,
            units: manifest.value_analysis.units,
          });
        }
      }

      // ── Element selection ─────────────────────────────────────────────────
      const selection = resolveSelection(config.elements);
      context.logger.info('Resolved CGraph element selection', {
        groups: config.elements,
        concepts: selection.concepts,
        relationships: selection.slots,
      });
      for (const dropped of selection.slotsDroppedByClosure) {
        const message =
          `Relationship '${dropped.slot}' is not imported: its group is enabled but ` +
          `no selected concept satisfies '${dropped.missing}'. Enable that element ` +
          'group to include these edges.';
        context.logger.info(message);
        diagnostics.push({ level: 'info', message });
      }

      if (selection.concepts.length === 0) {
        const message = 'No element groups are enabled, so there is nothing to import.';
        context.logger.warn(message);
        return {
          stats: {
            conceptsCreated: 0,
            relationshipsCreated: 0,
            errors: 0,
            filesProcessed: 0,
            durationMs: Date.now() - t0,
          },
          diagnostics: [...diagnostics, { level: 'warning', message }],
        };
      }

      // Exact progress totals, taken from the manifest before any data is read.
      const expectedConcepts = selection.concepts
        .reduce((sum, c) => sum + (manifest.counts.nodes[c] ?? 0), 0);
      const expectedRelationships = selection.slots
        .reduce((sum, s) => sum + (manifest.counts.edges[s] ?? 0), 0);

      const parsedFiles: string[] = [];
      const importedNodeCounts: Record<string, number> = {};
      const importedEdgeCounts: Record<string, number> = {};
      const skippedElements: Record<string, number> = {};

      // ── Nodes ─────────────────────────────────────────────────────────────
      const knownPaths = new Set<string>();
      const conceptBatches: ConceptBatch[] = [];
      let readNodes = 0;

      for (const concept of selection.concepts) {
        const file = nodeCollectionPath(scanResultDir, concept);
        const collection = await readNodeCollection(file, concept, knownPaths);

        if (collection.missing) {
          // Absent is legitimate: the generator omits a file for a concept with
          // no instances. A manifest count above zero makes it a real problem.
          const expected = manifest.counts.nodes[concept] ?? 0;
          if (expected > 0) {
            const message =
              `nodes/${concept}.jsonl is missing but the manifest reports ${expected} ` +
              'instance(s). The output directory is incomplete.';
            context.logger.error(message);
            diagnostics.push({ level: 'error', message, source: file });
          }
          continue;
        }

        parsedFiles.push(file);
        if (collection.issues.length > 0) {
          const message = describeIssues(`nodes/${concept}.jsonl`, collection.issues);
          context.logger.warn(message);
          diagnostics.push({ level: 'warning', message, source: file });
          skippedElements[`nodes/${concept}`] = collection.issues.length;
        }

        if (collection.batch.items.length > 0) {
          conceptBatches.push(collection.batch);
          importedNodeCounts[concept] = collection.batch.items.length;
        }
        readNodes += collection.batch.items.length;

        context.onProgress({
          phase: 'parsing',
          message: `Read ${readNodes} CGraph node(s)...`,
          current: readNodes,
          total: expectedConcepts,
        });
      }

      context.onProgress({
        phase: 'concepts',
        message: `Creating ${readNodes} CGraph concept instance(s)...`,
        current: 0,
        total: readNodes,
      });
      const nodeIdMap = conceptBatches.length > 0
        ? await context.writeService.bulkCreateConcepts(context.session, conceptBatches)
        : new Map<string, number>();
      context.onProgress({
        phase: 'concepts',
        message: `Created ${nodeIdMap.size} CGraph concept instance(s)`,
        current: nodeIdMap.size,
        total: readNodes,
      });

      if (nodeIdMap.size !== readNodes) {
        const message =
          `Wrote ${nodeIdMap.size} concept instance(s) from ${readNodes} record(s). ` +
          'Relationships whose endpoints are among the missing nodes will be dropped.';
        context.logger.error(message);
        diagnostics.push({ level: 'error', message });
      }

      // ── Edges ─────────────────────────────────────────────────────────────
      // Endpoints are validated against what was actually written, not against
      // what was read, so a node the write service rejected cannot leave an
      // edge pointing at nothing.
      const writtenPaths = nodeIdMap.size > 0 ? new Set(nodeIdMap.keys()) : knownPaths;
      const relationshipBatches: RelationshipBatch[] = [];
      let readEdges = 0;

      // Stable paths of the deselected concepts a selected slot can reach. An
      // edge dropped for one of these was removed by the user's selection, not
      // lost, and reconciliation must be able to tell the two apart (RIA-GAP-125).
      const excludedConcepts = excludedEndpointConcepts(selection.concepts, selection.slots);
      const excludedPaths = new Map<string, string>();
      for (const concept of excludedConcepts) {
        await readStablePaths(nodeCollectionPath(scanResultDir, concept), concept, excludedPaths);
      }
      if (excludedConcepts.length > 0) {
        context.logger.info('Indexed deselected endpoint concepts for reconciliation', {
          concepts: excludedConcepts,
          paths: excludedPaths.size,
        });
      }
      const excludedEdgeCounts: Record<string, number> = {};

      for (const slot of selection.slots) {
        const file = edgeCollectionPath(scanResultDir, slot);
        const collection = await readEdgeCollection(file, slot, writtenPaths, excludedPaths);

        if (collection.missing) {
          const expected = manifest.counts.edges[slot] ?? 0;
          if (expected > 0) {
            const message =
              `edges/${slot}.jsonl is missing but the manifest reports ${expected} ` +
              'edge(s). The output directory is incomplete.';
            context.logger.error(message);
            diagnostics.push({ level: 'error', message, source: file });
          }
          continue;
        }

        parsedFiles.push(file);
        if (collection.issues.length > 0) {
          const message = describeIssues(`edges/${slot}.jsonl`, collection.issues);
          context.logger.warn(message);
          diagnostics.push({ level: 'warning', message, source: file });
          skippedElements[`edges/${slot}`] = collection.issues.length;
        }
        // The two causes are now separated per record, so each message states
        // its cause instead of leaving the reader to guess.
        if (collection.droppedExcludedEndpoint > 0) {
          const byConcept = Object.entries(collection.droppedExcludedByConcept)
            .sort((a, b) => b[1] - a[1])
            .map(([concept, n]) => `${n} to a deselected ${concept}`)
            .join(', ');
          const message =
            `edges/${slot}.jsonl: dropped ${collection.droppedExcludedEndpoint} edge(s) ` +
            `excluded by the element selection (${byConcept}). ` +
            'Enable that group to import them.';
          context.logger.warn(message);
          diagnostics.push({ level: 'warning', message, source: file });
          excludedEdgeCounts[slot] = collection.droppedExcludedEndpoint;
        }
        if (collection.droppedUnresolvedEndpoint > 0) {
          const message =
            `edges/${slot}.jsonl: dropped ${collection.droppedUnresolvedEndpoint} edge(s) ` +
            'whose source or target is not an imported node and not a deselected one. ' +
            'The node was refused by the write service or is absent from the output.';
          context.logger.warn(message);
          diagnostics.push({ level: 'warning', message, source: file });
        }

        if (collection.batch.items.length > 0) {
          relationshipBatches.push(collection.batch);
        }
        // Recorded even when zero, so a collection dropped to empty is still
        // reconciled instead of skipping the check.
        importedEdgeCounts[slot] = collection.batch.items.length;
        readEdges += collection.batch.items.length;

        context.onProgress({
          phase: 'parsing',
          message: `Read ${readEdges} CGraph edge(s)...`,
          current: readEdges,
          total: expectedRelationships,
        });
      }

      context.onProgress({
        phase: 'relationships',
        message: `Creating ${readEdges} CGraph relationship instance(s)...`,
        current: 0,
        total: readEdges,
      });
      const relationshipsCreated = relationshipBatches.length > 0
        ? await context.writeService.bulkCreateRelationships(context.session, relationshipBatches)
        : 0;
      context.onProgress({
        phase: 'relationships',
        message: `Created ${relationshipsCreated} CGraph relationship instance(s)`,
        current: relationshipsCreated,
        total: readEdges,
      });

      // ── Generator diagnostics ─────────────────────────────────────────────
      // Summarised per rule. These describe where the generator's own claims
      // stop — an indirect call has no statically known target, a write through
      // a pointer has no named object — so a reviewer reading an absence in the
      // graph needs them, but one entry per occurrence would bury everything
      // else in the report.
      context.onProgress({ phase: 'finalizing', message: 'Collecting generator diagnostics...' });
      const generatorDiagnostics = await readGeneratorDiagnostics(diagnosticsPath(scanResultDir));
      if (generatorDiagnostics.length > 0) {
        const byRule = new Map<string, { count: number; severity: string; details: string[] }>();
        for (const entry of generatorDiagnostics) {
          const bucket = byRule.get(entry.rule) ?? { count: 0, severity: entry.severity, details: [] };
          bucket.count += 1;
          // Keep the highest severity seen for the rule.
          if (entry.severity === 'error' || (entry.severity === 'warning' && bucket.severity === 'info')) {
            bucket.severity = entry.severity;
          }
          if (bucket.details.length < MAX_LOGGED_DIAGNOSTIC_DETAILS_PER_RULE && entry.detail) {
            bucket.details.push(entry.file ? `${entry.file}:${entry.line ?? 0} ${entry.detail}` : entry.detail);
          }
          byRule.set(entry.rule, bucket);
        }

        for (const [rule, bucket] of [...byRule.entries()].sort((a, b) => b[1].count - a[1].count)) {
          const level: ImportDiagnostic['level'] = bucket.severity === 'error'
            ? 'error'
            : bucket.severity === 'warning' ? 'warning' : 'info';
          diagnostics.push({
            level,
            message: `Generator reported ${bucket.count} '${rule}' diagnostic(s). ` +
              'These are facts the extractor could not turn into an edge; read an ' +
              'absence in the graph against them.',
            source: 'diagnostics.jsonl',
          });
          context.logger.info(`CGraph diagnostic '${rule}' x${bucket.count}`, {
            examples: bucket.details,
          });
        }
      }

      // ── Reconciliation ────────────────────────────────────────────────────
      const discrepancies = reconcileCounts(
        manifest,
        { nodes: importedNodeCounts, edges: importedEdgeCounts },
        { edges: excludedEdgeCounts },
      );
      if (discrepancies.length > 0) {
        const message =
          `Imported counts differ from the manifest in ${discrepancies.length} ` +
          `collection(s): ${discrepancies.join('; ')}`;
        context.logger.error(message);
        diagnostics.push({ level: 'error', message });
      } else {
        context.logger.info('Imported counts reconcile exactly with the manifest', {
          concepts: Object.keys(importedNodeCounts).length,
          relationships: Object.keys(importedEdgeCounts).length,
        });
      }

      if (relationshipsCreated !== readEdges) {
        const message =
          `Wrote ${relationshipsCreated} relationship instance(s) from ${readEdges} ` +
          'record(s) whose endpoints were both present. The write service dropped the rest.';
        context.logger.error(message);
        diagnostics.push({ level: 'error', message });
      }

      context.onProgress({ phase: 'finalizing', message: 'CGraph import complete.' });

      return {
        stats: {
          conceptsCreated: nodeIdMap.size,
          relationshipsCreated,
          errors: diagnostics.filter((d) => d.level === 'error').length,
          // The translation units the generator compiled, not the JSONL
          // collections this importer read. The TU count is what describes the
          // size of the analysed corpus; the collection count is an artifact of
          // how many concept kinds happened to be non-empty.
          filesProcessed: manifest.translation_units?.length ?? 0,
          durationMs: Date.now() - t0,
        },
        diagnostics,
        parsedFiles,
        ...(Object.keys(skippedElements).length > 0 ? { skippedElements } : {}),
      };
    },
  };
}
