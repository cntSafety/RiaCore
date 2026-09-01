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
import type { ConceptPresentation } from '@riacore/app-contracts';
import type { ServiceDependencies } from '../types.js';
import type { createRegistry } from '../channel-registry.js';
import { loadPresentationCatalog, presentationForMetamodel } from '../../views/presentation-catalog.js';

/**
 * Register the presentation channel (spec-view.md Phase 4.1):
 *   - presentation.get
 *
 * Read-only, and it reads a JSON catalog rather than the graph — presentation is
 * deliberately stored outside the view and outside `CommonModel`
 * (docs/coreSpecs/RiaViews.md — P6). It still requires an open workspace,
 * because the repository override lives at `<workingDir>/ria-config/` and there
 * is no working directory to resolve it against otherwise; returning only the
 * shipped entries in that case would silently ignore a project's overrides.
 */
export function registerPresentationChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  async function currentWorkingDir(deps: ServiceDependencies): Promise<string> {
    const status = await deps.workspaceService.getStatus();
    if (status.state !== 'open') {
      throw new Error('presentation.get requires an open workspace');
    }
    return status.info.workingDir;
  }

  registry.register('presentation.get', async (payload, deps, _ctx) => {
    const metamodel = payload?.metamodel?.trim() ?? '';
    if (!metamodel) throw new Error('presentation.get requires a non-empty metamodel');
    const workingDir = await currentWorkingDir(deps);
    // Read on demand, not cached: an edited repository catalog takes effect on
    // the next call without a restart, matching the query catalog's contract.
    const catalog = loadPresentationCatalog(workingDir);
    return presentationForMetamodel(catalog, metamodel) satisfies ConceptPresentation[];
  }, { requiresWorkspace: true, category: 'presentation' });
}
