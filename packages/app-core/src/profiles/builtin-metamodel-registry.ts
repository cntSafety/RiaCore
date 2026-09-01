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
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A shipped metamodel registered for use as a view's immediate metamodel only
 * (docs/coreSpecs/RiaViews.md). Distinct from {@link IProfileRegistry}, whose
 * `AuthoredProfileDescriptor` hardcodes `namespaceRole: 'authored'` and exists
 * to create authored namespaces from profiles — a built-in metamodel creates no
 * namespace at all.
 */
export interface BuiltInMetamodelDescriptor {
  metamodelName: string;
  version: string;
  description?: string;
  metamodelPath: string;
}

export interface IBuiltInMetamodelRegistry {
  listAvailable(): BuiltInMetamodelDescriptor[];
  findById(metamodelName: string): BuiltInMetamodelDescriptor | null;
}

/**
 * Resolve the `packages/profiles/` directory, mirroring
 * `profile-registry.ts`'s `resolveProfilesRoot()` dev/packaged path search.
 * `__dirname` is `dist/profiles/` in the compiled output.
 */
function resolveProfilesRoot(): string {
  const envRoot = process.env.RIACORE_PROFILES_ROOT;
  const candidates = [
    envRoot,
    path.resolve(__dirname, '..', '..', '..', 'profiles'),
    path.resolve(__dirname, '..', '..', '..', '..', 'profiles'),
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'profiles'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? path.resolve(__dirname, '..', '..', '..', 'profiles');
}

const PROFILES_ROOT = resolveProfilesRoot();

const BUILT_IN_METAMODELS: BuiltInMetamodelDescriptor[] = [
  {
    metamodelName: 'COMMON_MODEL',
    version: '1.0.0',
    description: 'Unified structural/behavioural vocabulary for use as a view\'s immediate metamodel only.',
    metamodelPath: path.join(PROFILES_ROOT, 'common-model', 'common-model.linkml.yaml'),
  },
];

export function createBuiltInMetamodelRegistry(): IBuiltInMetamodelRegistry {
  return {
    listAvailable(): BuiltInMetamodelDescriptor[] {
      return BUILT_IN_METAMODELS.map((m) => ({ ...m }));
    },
    findById(metamodelName: string): BuiltInMetamodelDescriptor | null {
      return BUILT_IN_METAMODELS.find((m) => m.metamodelName === metamodelName) ?? null;
    },
  };
}
