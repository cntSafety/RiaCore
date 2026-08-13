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
/** Contract types for metamodel-driven rendering and profile metadata. */

/** Resolved rendering settings for a single metamodel concept. */
export interface ConceptRendering {
  /** ant-design icon component name (e.g. "BlockOutlined"); absent when omitted. */
  icon?: string;
  /** CSS color string (e.g. "#1677ff"); absent when omitted. */
  color?: string;
  /** Whether the concept is hidden by default. */
  hidden: boolean;
}

/** Concept name → rendering settings, for one metamodel. */
export type MetamodelRenderingConfig = Record<string, ConceptRendering>;

export interface ProfileSchemaMetadata {
  name: string;
  version?: string;
  description?: string;
}

export interface ProfileSlotMetadata {
  name: string;
  order: number;
  description?: string;
  domain?: string;
  range?: string;
  required: boolean;
  multivalued: boolean;
  identifier: boolean;
  containment: boolean;
  defaultValue?: string;
}

export interface ProfileClassMetadata {
  name: string;
  order: number;
  description?: string;
  abstract: boolean;
  isA?: string;
  slots: ProfileSlotMetadata[];
}

export interface ProfilePermissibleValueMetadata {
  value: string;
  order: number;
  description?: string;
}

export interface ProfileEnumMetadata {

  name: string;
  order: number;
  description?: string;
  permissibleValues: ProfilePermissibleValueMetadata[];
}

export interface ProfileReviewOption {
  value: string;
  label: string;
  description?: string;
  color?: string;
  tag?: string;
  /** Whether review summaries should break this verdict down by author status. */
  showAuthorStatusBreakdown?: boolean;
  /** Marks the author status that completes/resolves a review item. */
  isResolution?: boolean;
}

export interface ProfileReviewWorkflow {
  verdicts: ProfileReviewOption[];
  authorStatuses: ProfileReviewOption[];
  snapshotPolicy?: string;
}

export interface ProfileReviewInstructionSection {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  note?: string;
  catalogs?: string[];
}

export interface ProfileReviewCatalogItem {
  key: string;
  name: string;
  description: string;
  measures?: string;
}

export interface ProfileReviewCatalog {
  id: string;
  title: string;
  items: ProfileReviewCatalogItem[];
}

export interface ProfileReviewInstructions {
  title: string;
  format: 'markdown';
  sections: ProfileReviewInstructionSection[];
  catalogs: ProfileReviewCatalog[];
}

export interface ProfileReviewMetadata {
  version: number;
  workflow: ProfileReviewWorkflow;
  instructions: ProfileReviewInstructions;
}

/** Ordered, normalized profile metadata parsed from a LinkML schema. */
export interface MetamodelProfileMetadata {
  schema: ProfileSchemaMetadata;
  classes: ProfileClassMetadata[];
  slots: ProfileSlotMetadata[];
  enums: ProfileEnumMetadata[];
  review?: ProfileReviewMetadata;
  /** Ordered list of attribute names to try when producing a display label for a node from this metamodel. */
  displayIdentifierAttrs?: string[];
}
