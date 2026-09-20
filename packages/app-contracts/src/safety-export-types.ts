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
// ── Safety export data-model interfaces ─────────────────────────────────────
// These interfaces define the shape of data returned by the
// safety.getSafetyData IPC channel and produced by aggregateExportData().

export interface RiskRatingData {
  has_severity: string;
  has_occurrence_level: string;
  has_detection_level: string;
  risk_priority_number: string;
  risk_rating_note: string;
}

export interface MalfunctionExportData {
  nodeId: number;
  id: string;
  name: string;
  description: string;
  asil: string;
  portName?: string;
  portKind?: 'receiver' | 'provider';
  /** IDs of malfunctions that propagate INTO this one (i.e. causes / propagates_from direction). */
  propagatesFromIds: string[];
  /** IDs of malfunctions that this one propagates TO (outgoing / propagates_to direction). */
  propagatesToIds: string[];
  taskIds: string[];
  reqIds: string[];
  riskRating: RiskRatingData | null;
  /** Review items attached to this malfunction. */
  reviews: ReviewExportData[];
  functionalInsufficiencies?: SafetyDetailExportData[];
  triggeringConditions?: SafetyDetailExportData[];
}

export interface RequirementExportData {
  nodeId: number;
  id: string;
  name: string;
  reqId: string;
  reqText: string;
  reqAsil: string;
  reqLinkedTo?: string;
  originatingTask?: string;
}

export interface SafetyTaskExportData {
  nodeId: number;
  id: string;
  name: string;
  description: string;
  status: string;
  type: string;
  responsible?: string;
  reference?: string;
}

export interface SafetyNoteExportData {
  nodeId: number;
  id: string;
  noteText: string;
}

export interface ReviewExportData {
  nodeId: number;
  /** Name / title of the review item */
  name: string;
  /** Review status: 'open' | 'resolved' */
  status: string;
  /** The reviewer's initial comment */
  reviewerComment: string;
  /** The author's resolution comment (if resolved) */
  authorComment: string;
  /** Verdict set on resolution (may be empty) */
  verdict: string;
  authorStatus?: string;
}

/** Authored SOTIF detail, shared by one or more analysis cases. */
export interface SafetyDetailExportData {
  nodeId: number;
  name: string;
  description: string;
  source: string;
}

export interface TagExportData {
  nodeId: number;
  name: string;
  description: string;
  color: string;
}

export interface PortExportData {
  nodeId: number;
  name: string;
  kind: 'receiver' | 'provider';
}

export interface ComponentExportData {
  nodeId: number;
  name: string;
  uuid: string;
  componentType: string;
  /** The namespace this component lives in (the imported namespace, not the safety namespace). */
  namespace: string;
  arxmlPath?: string;
  functionalMFs: MalfunctionExportData[];
  receiverPortMFs: MalfunctionExportData[];
  providerPortMFs: MalfunctionExportData[];
  requirements: RequirementExportData[];
  safetyTasks: SafetyTaskExportData[];
  safetyNotes: SafetyNoteExportData[];
  portCount: number;
  ports: PortExportData[];
  tags: string[];
  tagDetails?: TagExportData[];
  /** Preserve authored records that have not yet been linked to a malfunction. */
  unlinkedFunctionalInsufficiencies?: SafetyDetailExportData[];
  unlinkedTriggeringConditions?: SafetyDetailExportData[];
  unlinkedReviews?: ReviewExportData[];
}

export interface SafetyExportData {
  namespace: string;
  components: ComponentExportData[];
  generatedAt: string;
}
