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
export const conceptTypeLabels: Record<string, string> = {
  MALFUNCTION:  'Malfunction',
  RISKRATING:   'Risk Rating',
  SAFETYREQ:    'Safety Requirement',
  SAFETYTASK:   'Safety Task',
  SAFETYNOTE:   'Safety Note',
  TAG:          'Tag',
  REVIEWITEM:   'Review Item',
};

export const attributeKeyLabels: Record<string, string> = {
  has_name:              'Name',
  malfunction_asil:      'ASIL',
  malfunction_description: 'Description',
  has_severity:          'Severity',
  has_occurrence_level:  'Occurrence',
  has_detection_level:   'Detection',
  risk_priority_number:  'RPN',
  task_status:           'Task Status',
  task_type:             'Task Type',
  task_responsible:      'Responsible',
  req_id:                'Requirement ID',
  req_asil:              'Req. ASIL',
  review_status:         'Review Status',
  reviewer_verdict:      'Verdict',
  tag_color:             'Tag Color',
};

export const relationshipTypeLabels: Record<string, string> = {
  has_safety_tasks:         'Linked Safety Task',
  has_safety_requirements:  'Linked Requirement',
  has_direct_requirements:  'Direct Requirement Link',
  propagates_to:            'Propagates To',
  has_notes:                'Note Attached',
  has_tag:                  'Tag Attached / Removed',
  has_review:               'Review Item',
  occurs_at:                'Occurs At',
};

/** Translate a concept type identifier, falling back to the raw string. */
export function labelConceptType(raw: string, metamodel: string): string {
  if (metamodel !== 'SAFETY_ANALYSIS') return raw;
  return Object.prototype.hasOwnProperty.call(conceptTypeLabels, raw)
    ? conceptTypeLabels[raw]
    : raw;
}

/** Translate an attribute key, falling back to the raw string. */
export function labelAttributeKey(raw: string, metamodel: string): string {
  if (metamodel !== 'SAFETY_ANALYSIS') return raw;
  return Object.prototype.hasOwnProperty.call(attributeKeyLabels, raw)
    ? attributeKeyLabels[raw]
    : raw;
}

/** Translate a relationship type identifier, falling back to the raw string. */
export function labelRelationshipType(raw: string, metamodel: string): string {
  if (metamodel !== 'SAFETY_ANALYSIS') return raw;
  return Object.prototype.hasOwnProperty.call(relationshipTypeLabels, raw)
    ? relationshipTypeLabels[raw]
    : raw;
}
