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
 * Phase step sequences per lifecycle action.
 *
 * Each lifecycle case maps to an ordered list of HudPhaseStep objects.
 * These are used by FloatingActivityHUD to reconstruct the phase sequence
 * once the workspace operation result arrives.
 *
 * Requirements: 15.1–15.19
 */

import type { HudPhaseStep } from '../store/lifecycleHudStore';

export type LifecycleAction =
  | 'created'
  | 'opened_consistent'
  | 'opened_loaded_from_ria_data'
  | 'opened_saved_to_ria_data'
  | 'opened_db_only';

/**
 * Returns the ordered phase step sequence for the given lifecycle action.
 * All steps are marked 'done' — this is used for post-hoc reconstruction
 * after the operation completes successfully.
 *
 * Phase sequences (Requirement 15):
 * - created:                    Locate → Initialise DB → Ready
 * - opened_loaded_from_ria_data: Locate → Initialise DB → Load from ria-data → Ready
 * - opened_saved_to_ria_data:   Locate → Open DB → Export to ria-data → Ready
 * - opened_consistent:          Locate → Open DB → Verify → Ready
 * - opened_db_only:             Locate → Open DB → Ready
 */
export function buildPhaseSequence(action: LifecycleAction): HudPhaseStep[] {
  switch (action) {
    case 'created':
      return [
        { id: 'locate',   label: 'Locate',        status: 'done' },
        { id: 'init_db',  label: 'Initialise DB',  status: 'done' },
        { id: 'ready',    label: 'Ready',           status: 'done' },
      ];

    case 'opened_loaded_from_ria_data':
      return [
        { id: 'locate',        label: 'Locate',             status: 'done' },
        { id: 'init_db',       label: 'Initialise DB',       status: 'done' },
        { id: 'load_ria_data', label: 'Load from ria-data',  status: 'done' },
        { id: 'ready',         label: 'Ready',               status: 'done' },
      ];

    case 'opened_saved_to_ria_data':
      return [
        { id: 'locate',          label: 'Locate',              status: 'done' },
        { id: 'open_db',         label: 'Open DB',              status: 'done' },
        { id: 'export_ria_data', label: 'Export to ria-data',   status: 'done' },
        { id: 'ready',           label: 'Ready',                status: 'done' },
      ];

    case 'opened_consistent':
      return [
        { id: 'locate',   label: 'Locate',   status: 'done' },
        { id: 'open_db',  label: 'Open DB',  status: 'done' },
        { id: 'verify',   label: 'Verify',   status: 'done' },
        { id: 'ready',    label: 'Ready',    status: 'done' },
      ];

    case 'opened_db_only':
      return [
        { id: 'locate',  label: 'Locate',  status: 'done' },
        { id: 'open_db', label: 'Open DB', status: 'done' },
        { id: 'ready',   label: 'Ready',   status: 'done' },
      ];
  }
}

/**
 * Returns the generic indeterminate phase sequence shown while the operation
 * is in flight (before the lifecycle action is known).
 */
export function buildGenericPhases(): HudPhaseStep[] {
  return [
    { id: 'locate', label: 'Locate', status: 'active' },
  ];
}

/**
 * Returns the active load phase ID for a given set of phases.
 * Used to identify which phase step to update with progress events.
 */
export function findActiveLoadPhaseId(phases: HudPhaseStep[]): string | null {
  return phases.find(
    (p) =>
      (p.id === 'load_ria_data' || p.id === 'reload_ria_data') &&
      p.status === 'active',
  )?.id ?? null;
}

/**
 * Calculates the progress percentage for a namespace load operation.
 *
 * For any (namespaceIndex, totalNamespaces) pair where totalNamespaces > 0,
 * the progress percentage SHALL equal Math.round((namespaceIndex / totalNamespaces) * 100).
 *
 * Property 11: Progress percentage calculation is correct
 * Validates: Requirements 16.5
 */
export function calculateProgressPercent(
  namespaceIndex: number,
  totalNamespaces: number,
): number {
  return Math.round((namespaceIndex / totalNamespaces) * 100);
}
