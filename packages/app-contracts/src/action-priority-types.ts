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
 * Action Priority (AP) Types
 */

/** One of the three Action Priority outcomes. */
export type ActionPriorityLevel = 'H' | 'M' | 'L';

/** Display metadata for one Action Priority level. */
export interface ActionPriorityLevelMetadata {
  label: string;
  color?: string;
  description?: string;
}

/**
 * One severity band's occurrence x detection lookup table.
 *
 * `table[detectionIndex][occurrenceIndex]`, where index 0 is the lowest
 * ordinal level (`detectionLevels[0]` / `occurrenceLevels[0]`) and the last
 * index is the highest. Row = detection, column = occurrence — the same
 * convention the renderer's risk-matrix grid already uses, so a table can be
 * rendered by the existing grid layout with no new geometry code.
 */
export interface ActionPrioritySeverityClass {
  /** Stable id for this severity band, e.g. "S_safety". */
  id: string;
  /** Human label shown in the UI, e.g. "Safety-Impact". */
  label: string;
  /** Values of the risk rating's `has_severity` slot that fall in this band. */
  whenSeverity: string[];
  table: ActionPriorityLevel[][];
}

/**
 * Profile-configurable Action Priority lookup, parsed from a profile's
 * `annotations.action_priority`. Absent when the profile does not define one
 * (older profiles, or profiles that have not migrated from RPN yet).
 */
export interface ActionPriorityMetadata {
  /** Ordinal `has_occurrence_level` values, lowest first. */
  occurrenceLevels: string[];
  /** Ordinal `has_detection_level` values, lowest first. */
  detectionLevels: string[];
  /** At least one entry; every `has_severity` value used by the profile must match exactly one. */
  severityClasses: ActionPrioritySeverityClass[];
  levels: Record<ActionPriorityLevel, ActionPriorityLevelMetadata>;
}

/**
 * Resolve the Action Priority for a given severity/occurrence/detection
 * triple against a profile's AP table.
 *
 * Pure and total: returns `undefined` — rather than throwing or guessing a
 * default — when `metadata` is absent, when `severity` matches no declared
 * severity class, or when `occurrence`/`detection` matches no ordinal level
 * (e.g. no risk rating has been recorded yet, or the profile predates AP).
 */
export function resolveActionPriority(
  metadata: ActionPriorityMetadata | undefined,
  severity: string,
  occurrence: string,
  detection: string,
): ActionPriorityLevel | undefined {
  if (!metadata) return undefined;
  const severityClass = metadata.severityClasses.find((cls) => cls.whenSeverity.includes(severity));
  if (!severityClass) return undefined;
  const occurrenceIndex = metadata.occurrenceLevels.indexOf(occurrence);
  const detectionIndex = metadata.detectionLevels.indexOf(detection);
  if (occurrenceIndex < 0 || detectionIndex < 0) return undefined;
  return severityClass.table[detectionIndex]?.[occurrenceIndex];
}
