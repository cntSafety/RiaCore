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
import type { Result, CreateAuthoredNamespaceParams, CreatedNamespaceInfo } from '@riacore/app-contracts';
import type { IDbModule } from '../db/db-module.js';
import { parseLinkMLSchema, composeProfileSchema } from '../importers/linkml-parser.js';
import { createImportWriteService, createOrReplaceNamespace } from '../importers/import-write-service.js';
import type { IProfileRegistry } from '../profiles/profile-registry.js';
import type { ImportLogger } from '../infra/logger.js';

export interface INamespaceService {
  createAuthoredNamespace(
    params: CreateAuthoredNamespaceParams,
  ): Promise<Result<CreatedNamespaceInfo>>;
}

export function createNamespaceService(
  profileRegistry: IProfileRegistry,
  dbModule: IDbModule,
  logger?: ImportLogger,
): INamespaceService {
  const writeService = createImportWriteService(dbModule);

  return {
    async createAuthoredNamespace(
      params: CreateAuthoredNamespaceParams,
    ): Promise<Result<CreatedNamespaceInfo>> {
      const workingDir = typeof params.workingDir === 'string' ? params.workingDir.trim() : '';
      const namespace = typeof params.namespace === 'string' ? params.namespace.trim() : '';
      const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';

      if (!workingDir) {
        return { ok: false, error: 'Working directory is required' };
      }
      if (!namespace) {
        return { ok: false, error: 'Namespace must be non-empty' };
      }
      if (!profileId) {
        return { ok: false, error: 'Profile ID is required' };
      }

      const profile = profileRegistry.findById(profileId);
      if (!profile) {
        return { ok: false, error: `No authored profile found with id '${profileId}'` };
      }

      if (!profile.layers?.length && !profile.metamodelPath) {
        return { ok: false, error: `Profile '${profileId}' has neither metamodelPath nor layers` };
      }

      try {
        const schema = profile.layers?.length
          ? composeProfileSchema(profile.layers)
          : parseLinkMLSchema(profile.metamodelPath!);
        await writeService.registerMetamodelFromSchema(schema, profile.metamodelName);

        await createOrReplaceNamespace(dbModule, {
          namespace,
          metamodel: profile.metamodelName,
          namespaceRole: profile.namespaceRole,
          namespaceOwningApplication: profile.owningApplication,
          replaceExisting: params.overwrite ?? false,
        });

        return {
          ok: true,
          data: {
            namespace,
            profileId: profile.profileId,
            metamodel: profile.metamodelName,
            namespaceRole: profile.namespaceRole,
            namespaceOwningApplication: profile.owningApplication,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Failed to create authored namespace '${namespace}': ${message}`,
        };
      }
    },
  };
}
