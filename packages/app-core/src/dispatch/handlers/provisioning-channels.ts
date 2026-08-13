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
import type { ImporterInfo, ProfileInfo } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';

/**
 * Register provisioning and profile channels.
 *
 * - `importers.provisionConfig` requires a workspace (opens DB before provisioning).
 * - `importers.listAvailable` and `profiles.listAvailable` do NOT require a workspace —
 *   they enumerate built-in importers/profiles from the registry.
 */
export function registerProvisioningChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  registry.register('importers.provisionConfig', async (payload, deps, _ctx) => {
    if (!deps.provisioningService) throw new Error('Provisioning service not configured');

    // Ensure the workspace (and DB) is open before provisioning.
    const wsResult = await deps.workspaceService.open({ workingDir: payload.workingDir });
    if (!wsResult.ok) throw new Error(wsResult.error);

    const result = await deps.provisioningService.provisionConfig(payload);
    if (!result.ok) throw new Error(result.error);

    const { sourceId } = result.data;
    return sourceId;
  }, {
    requiresWorkspace: true,
    category: 'provisioning',
  });

  registry.register('importers.listAvailable', async (_payload, deps, _ctx) => {
    if (!deps.registry) throw new Error('Importer registry not configured');
    const LABELS: Record<string, string> = {
      arxml:             'AUTOSAR ARXML',
      sysml_v2_textual:  'SysML v2 Textual (.sysml)',
    };
    const importers = deps.registry.listAvailable();
    return importers.map((d): ImporterInfo => ({
      name:              d.name,
      label:             LABELS[d.name] ?? d.name,
      version:           d.version,
      sourceType:        d.sourceType,
      hasConfigTemplate: !!d.configTemplatePath,
    }));
  }, {
    requiresWorkspace: false,
    category: 'provisioning',
  });

  registry.register('profiles.listAvailable', async (_payload, deps, _ctx) => {
    if (!deps.profileRegistry) throw new Error('Profile registry not configured');
    return deps.profileRegistry.listAvailable().map((profile): ProfileInfo => ({
      profileId: profile.profileId,
      label: profile.label,
      version: profile.version,
      description: profile.description,
      metamodelName: profile.metamodelName,
      owningApplication: profile.owningApplication,
      namespaceRole: profile.namespaceRole,
    }));
  }, {
    requiresWorkspace: false,
    category: 'provisioning',
  });
}
