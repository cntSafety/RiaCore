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
import type { Representative } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/** Check Model and the diagram consume the same scoped, evaluated check rows. */
export async function loadModelPortChecks(
  representatives: Representative[], namespace: string, safetyNamespace: string | undefined,
  diagnostics: string[],
): Promise<Record<number, string>> {
  if (!safetyNamespace || !representatives.some(rep => rep.attributes.kind === 'port_usage')) return {};
  try {
    const id = 'sa-sysml-port-asil-consistency';
    const checks = await api.checks.loadApplicable(safetyNamespace);
    if (!checks.some(check => check.id === id)) return {};
    const pageSize = 500;
    const run = await api.checks.runCheck(id, safetyNamespace, pageSize);
    let page = run.firstPage; let loaded = 0;
    const messages: Record<number, string> = {};
    while (true) {
      for (const row of page.violations) {
        if (row.namespace === namespace) {
          messages[row.nodeId] = row.attributeValues.check_message
            ?? 'ASIL mismatch: a connected producer has a lower ASIL allocation than this consumer.';
        }
      }
      loaded += page.violations.length;
      if (!page.hasMore) break;
      if (!page.violations.length || loaded >= run.totalViolations) throw new Error('Incomplete ASIL check pagination');
      page = await api.checks.getPage(run.runId, page.page + 1, pageSize);
    }
    return messages;
  } catch (error) {
    diagnostics.push(`SysML ASIL mismatch check unavailable: ${String(error)}`);
    return {};
  }
}
