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

export interface AuthoredProfileDescriptor {
  profileId: string;
  label: string;
  version: string;
  description?: string;
  metamodelName: string;
  /**
   * Single-file metamodel schema. Mutually exclusive with `layers`; when
   * `layers` is set the schema is composed from those instead.
   */
  metamodelPath?: string;
  /**
   * Ordered layer files (base first, overlays last) composed into one schema
   * via composeProfileSchema(). Lets profiles share a common base instead of
   * duplicating the whole metamodel.
   */
  layers?: string[];
  rulesPath?: string;
  namespaceRole: 'authored';
  owningApplication: string;
}

export interface IProfileRegistry {
  listAvailable(): AuthoredProfileDescriptor[];
  findById(profileId: string): AuthoredProfileDescriptor | null;
}

function resolveProfilesRoot(): string {
  const envRoot = process.env.RIACORE_PROFILES_ROOT;
  // __dirname is dist/profiles/ in the compiled output.
  // In dev:     dist/profiles/ → ../../ → app-core/ → ../../ → packages/ → ../profiles
  // In packaged: dist/profiles/ → ../../ → app-core/ → ../../ → @riacore/ → ../ → node_modules/ → ../ → app/ → profiles/
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

const BUILT_IN_PROFILES: AuthoredProfileDescriptor[] = [
  {
    profileId: 'safety-core',
    label: 'SW Safety Analysis',
    version: '4.0.6',
    description: 'FMEA-style safety analysis authored profile.',
    metamodelName: 'SAFETY_ANALYSIS',
    // Composed from the shared base + a thin SW-safety overlay.
    layers: [
      path.join(PROFILES_ROOT, '_base', 'safety-analysis-base.linkml.yaml'),
      path.join(PROFILES_ROOT, 'safety-core', 'safety-meta', 'safety.overlay.linkml.yaml'),
    ],
    rulesPath: path.join(PROFILES_ROOT, 'safety-core', 'safety-meta', 'safety-rules.linkml.yaml'),
    namespaceRole: 'authored',
    owningApplication: 'Safety-Analysis',
  },
  {
    profileId: 'system-safety-core',
    label: 'System Safety Analysis',
    version: '1.0.0',
    description: 'System-level FMEA-style safety analysis authored profile. Reuses the Safety Analysis editor.',
    metamodelName: 'SYSTEM_SAFETY_ANALYSIS',
    // Composed from the shared base + a thin system-safety overlay.
    layers: [
      path.join(PROFILES_ROOT, '_base', 'safety-analysis-base.linkml.yaml'),
      path.join(PROFILES_ROOT, 'system-safety-core', 'sys-safety-meta', 'sys-safety.overlay.linkml.yaml'),
    ],
    rulesPath: path.join(PROFILES_ROOT, 'system-safety-core', 'sys-safety-meta', 'sys-safety-rules.linkml.yaml'),
    namespaceRole: 'authored',
    // Shares the 'Safety-Analysis' owning application so it routes to the same
    // SafetyEditor and sub-editors. The distinct metamodel (SYSTEM_SAFETY_ANALYSIS)
    // keeps its own profile_metadata snapshot, which drives the profile-specific
    // occurrence levels, review instructions, and failure-mode catalog.
    owningApplication: 'Safety-Analysis',
  },
  {
    profileId: 'security-core',
    label: 'Security Analysis',
    version: '1.0.0',
    description: 'TARA-style security analysis authored profile.',
    metamodelName: 'SECURITY_ANALYSIS',
    metamodelPath: path.join(PROFILES_ROOT, 'security-core', 'security-meta', 'security-meta.linkml.yaml'),
    rulesPath: path.join(PROFILES_ROOT, 'security-core', 'security-meta', 'security-rules.linkml.yaml'),
    namespaceRole: 'authored',
    owningApplication: 'Security-Analysis',
  },
  {
    profileId: 'monitoring-core',
    label: 'Monitoring Analysis',
    version: '1.0.0',
    description: 'Monitoring analysis authored profile. Shares the FMEA base with the safety profiles; occurrence = likelihood of the monitored fault, detection = runtime monitoring capability. Reuses the Safety Analysis editor.',
    metamodelName: 'MONITORING_ANALYSIS',
    // Composed from the shared base + a thin monitoring overlay instead of a
    // duplicated standalone metamodel.
    layers: [
      path.join(PROFILES_ROOT, '_base', 'safety-analysis-base.linkml.yaml'),
      path.join(PROFILES_ROOT, 'monitoring-core', 'monitoring-meta', 'monitoring.overlay.linkml.yaml'),
    ],
    namespaceRole: 'authored',
    // Shares the 'Safety-Analysis' owning application so it routes to the same
    // SafetyEditor. The distinct metamodel (MONITORING_ANALYSIS) keeps its own
    // profile_metadata snapshot (monitoring occurrence/detection wording).
    owningApplication: 'Safety-Analysis',
  },
  {
    profileId: 'sotif-core',
    label: 'SOTIF Analysis',
    version: '1.0.0',
    description:
      'SOTIF analysis authored profile. Shares the FMEA base with the safety profiles but characterises each no-fault concern by its functional insufficiencies and triggering conditions instead of a Severity/Occurrence/Detection risk rating; Risk Rating is reduced to a free-text residual-risk argument. Reuses the Safety Analysis editor.',
    metamodelName: 'SOTIF_ANALYSIS',
    // Composed from the shared base + a thin SOTIF overlay that adds the
    // functional_insufficiency and triggering_condition concepts.
    layers: [
      path.join(PROFILES_ROOT, '_base', 'safety-analysis-base.linkml.yaml'),
      path.join(PROFILES_ROOT, 'sotif-core', 'sotif-meta', 'sotif.overlay.linkml.yaml'),
    ],
    namespaceRole: 'authored',
    // Shares the 'Safety-Analysis' owning application so it routes to the same
    // SafetyEditor. The distinct metamodel (SOTIF_ANALYSIS) keeps its own
    // profile_metadata snapshot (functional insufficiency / triggering condition
    // catalogs, SOTIF review checklist).
    owningApplication: 'Safety-Analysis',
  },
];

export function createProfileRegistry(): IProfileRegistry {
  return {
    listAvailable(): AuthoredProfileDescriptor[] {
      return BUILT_IN_PROFILES.map((profile) => ({ ...profile }));
    },

    findById(profileId: string): AuthoredProfileDescriptor | null {
      return BUILT_IN_PROFILES.find((profile) => profile.profileId === profileId) ?? null;
    },
  };
}
