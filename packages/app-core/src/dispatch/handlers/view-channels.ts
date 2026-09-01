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
import type {
  ViewDefinition,
  EvaluationResult,
  MaterializeResult,
} from '@riacore/app-contracts';
import type { ServiceDependencies } from '../types.js';
import type { createRegistry } from '../channel-registry.js';
import { createViewService } from '../../views/view-service.js';

/**
 * Register the view channels (docs/coreSpecs/RiaViews.md):
 *   - views.list / views.get / views.create / views.update / views.delete
 *   - views.evaluate (read-only) / views.materialize (write)
 *
 * All require an open workspace. The backing service returns `Result<T>`; the
 * IPC contract instead returns `T` directly and throws `Error` on failure, so
 * each handler unwraps the Result: throw `new Error(result.error)` on failure,
 * otherwise return `result.data`.
 */
export function registerViewChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  /**
   * Uses the injected service, falling back to constructing one from the
   * injected mapping registry. There is deliberately no fallback *registry*:
   * an entry point that forgot to wire one would otherwise get a silently
   * divergent second registry — mappings registered by the application would
   * be invisible here — which is exactly the regression the wiring test in
   * apps/desktop-host exists to catch.
   */
  function service(deps: ServiceDependencies) {
    if (deps.viewService) return deps.viewService;
    if (!deps.mappingRegistry) {
      throw new Error('views.* requires mappingRegistry (or viewService) in ServiceDependencies');
    }
    return createViewService(deps.mappingRegistry, deps.dbModule);
  }

  async function currentWorkingDir(deps: ServiceDependencies): Promise<string> {
    const status = await deps.workspaceService.getStatus();
    if (status.state !== 'open') {
      throw new Error('views.evaluate/views.materialize require an open workspace');
    }
    return status.info.workingDir;
  }

  registry.register('views.list', async (_payload, deps, _ctx) => {
    const result = await service(deps).listViews();
    if (!result.ok) throw new Error(result.error);
    return result.data satisfies ViewDefinition[];
  }, { requiresWorkspace: true, category: 'views' });

  registry.register('views.get', async (payload, deps, _ctx) => {
    const result = await service(deps).getView(payload.name);
    if (!result.ok) throw new Error(result.error);
    return result.data satisfies ViewDefinition;
  }, { requiresWorkspace: true, category: 'views' });

  registry.register('views.create', async (payload, deps, _ctx) => {
    const result = await service(deps).createView(payload);
    if (!result.ok) throw new Error(result.error);
    return result.data satisfies ViewDefinition;
  }, { requiresWorkspace: true, category: 'views' });

  registry.register('views.update', async (payload, deps, _ctx) => {
    const result = await service(deps).updateView(payload);
    if (!result.ok) throw new Error(result.error);
    return result.data satisfies ViewDefinition;
  }, { requiresWorkspace: true, category: 'views' });

  registry.register('views.delete', async (payload, deps, _ctx) => {
    const result = await service(deps).deleteView(payload.name);
    if (!result.ok) throw new Error(result.error);
  }, { requiresWorkspace: true, category: 'views' });

  registry.register('views.evaluate', async (payload, deps, _ctx) => {
    const workingDir = await currentWorkingDir(deps);
    const result = await service(deps).evaluateView(workingDir, payload);
    if (!result.ok) throw new Error(result.error);
    return result.data satisfies EvaluationResult;
  }, { requiresWorkspace: true, category: 'views' });

  registry.register('views.materialize', async (payload, deps, _ctx) => {
    const workingDir = await currentWorkingDir(deps);
    const result = await service(deps).materializeView(workingDir, payload);
    if (!result.ok) throw new Error(result.error);
    return result.data satisfies MaterializeResult;
  }, { requiresWorkspace: true, category: 'views' });
}
