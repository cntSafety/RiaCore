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
import { useMemo } from 'react';
import type {
  ActionPriorityLevel,
  ActionPriorityMetadata,
  MetamodelProfileMetadata,
  ProfileReviewMetadata,
  ProfileReviewOption,
} from '@riacore/app-contracts';
import { resolveActionPriority } from '@riacore/app-contracts';
import { useMetamodelProfileMetadata } from '../../../../../hooks/useMetamodelProfileMetadata';
import { useSafetyMetamodel, DEFAULT_SAFETY_METAMODEL } from './safetyMetamodelContext';

/** @deprecated Use the metamodel from `useSafetyMetamodel()` — kept for compatibility. */
export const SAFETY_METAMODEL = DEFAULT_SAFETY_METAMODEL;

export interface SafetyProfileSelectOption {
  value: string;
  label: string;
  desc?: string;
}

export interface SafetyAsilGroup {
  label: string;
  options: string[];
}

interface SafetyProfileView {
  severityOptions: SafetyProfileSelectOption[];
  occurrenceOptions: SafetyProfileSelectOption[];
  detectionOptions: SafetyProfileSelectOption[];
  taskStatusOptions: SafetyProfileSelectOption[];
  taskTypeOptions: SafetyProfileSelectOption[];
  asilGroups: SafetyAsilGroup[];
  riskDefaults: { severity: string; occurrence: string; detection: string };
  taskDefaults: { status: string; type: string };
  authorStatusDefault: string;
  review?: ProfileReviewMetadata;
  verdicts: ProfileReviewOption[];
  authorStatuses: ProfileReviewOption[];
  /** Profile-configured Action Priority table. Absent for profiles that have not migrated from RPN. */
  actionPriority?: ActionPriorityMetadata;
  /**
   * Resolve the Action Priority level for a (severity, occurrence, detection)
   * triple against this profile's table. Computed on demand — never
   * persisted alongside the risk rating. Returns `undefined` when the
   * profile has no `actionPriority` table or the triple doesn't resolve
   * (e.g. an incomplete risk rating).
   */
  getActionPriority: (severity: string, occurrence: string, detection: string) => ActionPriorityLevel | undefined;
}

function enumOptions(
  metadata: MetamodelProfileMetadata | undefined,
  enumName: string,
): SafetyProfileSelectOption[] {
  const enumeration = metadata?.enums.find((item) => item.name === enumName);
  return enumeration?.permissibleValues.map((item) => {
    const match = item.description?.match(/^Level\s+\d+\s+[—-]\s+([^:]+):\s*(.*)$/);
    return {
      value: item.value,
      label: match?.[1] ?? item.value,
      ...(match?.[2] ? { desc: match[2] } : item.description ? { desc: item.description } : {}),
    };
  }) ?? [];
}

function slotDefault(
  metadata: MetamodelProfileMetadata | undefined,
  conceptName: string,
  slotName: string,
): string {
  return metadata?.classes
    .find((item) => item.name === conceptName)
    ?.slots.find((item) => item.name === slotName)
    ?.defaultValue ?? '';
}

function buildView(metadata: MetamodelProfileMetadata | undefined): SafetyProfileView {
  const asilValues = enumOptions(metadata, 'AsilLevel').map((item) => item.value);
  const review = metadata?.review;
  return {
    severityOptions: enumOptions(metadata, 'SeverityLevel'),
    occurrenceOptions: enumOptions(metadata, 'OccurrenceLevel'),
    detectionOptions: enumOptions(metadata, 'DetectionLevel'),
    taskStatusOptions: enumOptions(metadata, 'TaskStatus'),
    taskTypeOptions: enumOptions(metadata, 'TaskType'),
    asilGroups: [
      { label: 'Core', options: asilValues.filter((value) => !value.includes('(')) },
      { label: 'Decomposition', options: asilValues.filter((value) => value.includes('(')) },
    ].filter((group) => group.options.length > 0),
    riskDefaults: {
      severity: slotDefault(metadata, 'risk_rating', 'has_severity'),
      occurrence: slotDefault(metadata, 'risk_rating', 'has_occurrence_level'),
      detection: slotDefault(metadata, 'risk_rating', 'has_detection_level'),
    },
    taskDefaults: {
      status: slotDefault(metadata, 'safety_task', 'task_status'),
      type: slotDefault(metadata, 'safety_task', 'task_type'),
    },
    authorStatusDefault: slotDefault(metadata, 'review_item', 'author_status'),
    review,
    verdicts: review?.workflow.verdicts ?? [],
    authorStatuses: review?.workflow.authorStatuses ?? [],
    actionPriority: metadata?.actionPriority,
    getActionPriority: (severity: string, occurrence: string, detection: string) =>
      resolveActionPriority(metadata?.actionPriority, severity, occurrence, detection),
  };
}

/** Profile-derived safety options, defaults, workflow metadata, and instructions. */
export function useSafetyProfileMetadata() {
  const metamodel = useSafetyMetamodel();
  const query = useMetamodelProfileMetadata(metamodel);
  const view = useMemo(() => buildView(query.data), [query.data]);
  return { ...query, ...view };
}
