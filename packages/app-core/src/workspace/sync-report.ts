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
 * `workspace.getSyncReport` — the per-domain evaluation as a flat, serialisable
 * report.
 *
 * Feature: persistor-shared-layer-sync, task 13.1. Separate from
 * `sync-evaluation.ts` so the IPC shape (`SyncReport`, declared in
 * `app-contracts`) and the internal shape (`SyncEvaluation`, which carries
 * `DomainStateEntry` objects) can move independently: the report is a contract
 * and the evaluation is an implementation.
 */

import type { SyncReport } from '@riacore/app-contracts';
import type { AppCoreLogger, IDbModule } from '../db/db-module.js';
import { classifyRiaData, evaluateSyncStates } from './sync-evaluation.js';

/**
 * Recompute the evaluation for `workingDir` and flatten it.
 *
 * Recomputed, never cached — see the channel registration for why.
 */
export async function buildSyncReport(
  workingDir: string,
  dbModule: IDbModule,
  logger?: AppCoreLogger,
): Promise<SyncReport> {
  const classification = await classifyRiaData(workingDir);

  if (classification.kind !== 'readable') {
    // Every non-readable shape reports as a single manifest domain, because that
    // is literally what is known: with no usable manifest there is no carrier
    // to enumerate domains from.
    //
    // `incompatible` reports exactly like `unusable` — S5, a pending decision,
    // no plan — because the consequence for a reader of this report is the same:
    // the snapshot must not be written and no per-domain comparison is
    // meaningful. It is NOT reported as `consistent`, which is what the previous
    // two-way ternary would have done with a third kind and which would have
    // told the caller a snapshot it cannot read is in sync.
    const blocked = classification.kind === 'unusable' || classification.kind === 'incompatible';
    return {
      domains: [{
        kind: 'manifest',
        id: 'manifest.json',
        m: null,
        f: null,
        d: null,
        state: blocked ? 'S5' : 'S1',
      }],
      action: blocked ? 'manifest_unusable' : 'consistent',
      decision: blocked
        ? {
          reason: 'manifest_unusable',
          domains: [{ kind: 'manifest', id: 'manifest.json', state: 'S5' }],
        }
        : null,
      epochSuspended: false,
      shortCircuited: false,
      plan: null,
    };
  }

  const evaluation = await evaluateSyncStates(
    workingDir, classification.manifest, classification.bytes, dbModule, logger,
  );

  const outcome = evaluation.outcome;
  return {
    domains: evaluation.entries.map((e) => ({
      kind: e.domain.kind,
      id: e.domain.id,
      m: e.hashes.m,
      f: e.hashes.f,
      d: e.hashes.d,
      state: e.state,
    })),
    action: outcome.kind,
    decision: outcome.kind === 'needs_decision'
      ? {
        reason: outcome.reason,
        domains: outcome.domains.map((e) => ({
          kind: e.domain.kind, id: e.domain.id, state: e.state,
        })),
      }
      : null,
    epochSuspended: evaluation.epochSuspended,
    shortCircuited: evaluation.shortCircuited,
    plan: outcome.kind === 'load' ? { ...outcome.plan } : null,
  };
}

/**
 * Render a `SyncReport` as fixed-width text.
 *
 * A pure, exported formatter, following the `formatDriftSummary` precedent: the
 * text shape is then assertable without spawning the CLI.
 */
export function formatSyncReport(report: SyncReport): string {
  const short = (h: string | null): string =>
    h === null ? '—' : h.startsWith('sha256:') ? h.slice(7, 19) : h.slice(0, 12);

  const rows = report.domains.map((d) => [
    d.kind, d.id, short(d.m), short(d.f), short(d.d), d.state,
  ]);
  const head = ['domain', 'id', 'M', 'F', 'D', 'state'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  const out = [
    line(head),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(line),
    '',
    `action: ${report.action}`,
  ];
  if (report.epochSuspended) {
    out.push('epoch differs — every comparison suspended, a full load is planned');
  }
  if (report.shortCircuited) {
    out.push("manifest digest matched its origin row — per-domain D taken as M (shared layers)");
  }
  if (report.plan) {
    out.push(
      `plan: meta=${report.plan.meta ? 'yes' : 'no'} ` +
      `sourcemaster=${report.plan.sourcemaster ? 'yes' : 'skip'} ` +
      `universe=${report.plan.universe ? 'yes' : 'skip'} ` +
      `cross_namespace=${report.plan.crossNamespace ? 'yes' : 'skip'} ` +
      `namespaces=[${report.plan.namespaces.join(', ')}]`,
    );
  }
  if (report.decision) {
    out.push(`decision needed (${report.decision.reason}):`);
    for (const d of report.decision.domains) {
      out.push(`  - ${d.kind}:${d.id} ${d.state}`);
    }
  }
  return out.join('\n');
}
