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
import { readFileSync } from 'node:fs';
import type { SysmlEnabledCategories } from './config-loader.js';

// ---------------------------------------------------------------------------
// Supported SysML v2 / KerML types
// ---------------------------------------------------------------------------

export type SupportedSysmlType =
  // structure — definitions
  | 'Package'
  | 'LibraryPackage'
  | 'Namespace'
  | 'PartDefinition'
  | 'ItemDefinition'
  | 'PortDefinition'
  | 'ConnectionDefinition'
  | 'InterfaceDefinition'
  | 'AllocationDefinition'
  | 'AttributeDefinition'
  | 'EnumerationDefinition'
  | 'OccurrenceDefinition'
  | 'IndividualDefinition'
  | 'AssociationStructure'
  | 'DataType'
  | 'MetadataDefinition'
  // structure — usages
  | 'PartUsage'
  | 'ItemUsage'
  | 'PortUsage'
  | 'ConnectionUsage'
  | 'InterfaceUsage'
  | 'AllocationUsage'
  | 'AttributeUsage'
  | 'EnumerationUsage'
  | 'ReferenceUsage'
  | 'MetadataUsage'
  | 'IndividualUsage'
  | 'Comment'
  | 'Documentation'
  // behavior — definitions
  | 'ActionDefinition'
  | 'StateDefinition'
  | 'ConstraintDefinition'
  | 'RequirementDefinition'
  | 'CalculationDefinition'
  | 'CaseDefinition'
  | 'VerificationCaseDefinition'
  | 'AnalysisCaseDefinition'
  | 'UseCaseDefinition'
  | 'ViewDefinition'
  | 'RenderingDefinition'
  // behavior — usages
  | 'OccurrenceUsage'
  | 'ActionUsage'
  | 'PerformActionUsage'
  | 'AcceptActionUsage'
  | 'StateUsage'
  | 'ExhibitStateUsage'
  | 'TransitionUsage'
  | 'FlowUsage'
  | 'FlowEnd'
  | 'SuccessionAsUsage'
  | 'ForkNode'
  | 'JoinNode'
  | 'MergeNode'
  | 'DecisionNode'
  | 'WhileLoopActionUsage'
  | 'ForLoopActionUsage'
  | 'ConstraintUsage'
  | 'RequirementUsage'
  | 'CalculationUsage'
  | 'CaseUsage'
  | 'VerificationCaseUsage'
  | 'AnalysisCaseUsage'
  | 'UseCaseUsage'
  | 'EventOccurrenceUsage'
  | 'ViewUsage'
  | 'RenderingUsage'
  // features — KerML feature types
  | 'Feature'
  | 'FeatureValue'
  | 'FeatureTyping'
  | 'FeatureChaining'
  | 'FeatureInverting'
  | 'Conjugation'
  | 'Subclassification'
  | 'Multiplicity'
  | 'MultiplicityRange'
  | 'Subsetting'
  | 'Redefinition'
  | 'ReferenceSubsetting'
  | 'BindingConnectorAsUsage'
  | 'FeatureReferenceExpression'
  | 'FeatureChainExpression'
  | 'OperatorExpression'
  | 'InvocationExpression'
  | 'PayloadFeature'
  | 'LiteralBoolean'
  | 'LiteralInteger'
  | 'LiteralRational'
  | 'LiteralString'
  | 'LiteralInfinity'
  // memberships
  | 'OwningMembership'
  | 'FeatureMembership'
  | 'Membership'
  | 'ParameterMembership'
  | 'ReturnParameterMembership'
  | 'EndFeatureMembership'
  | 'ObjectiveMembership'
  | 'SubjectMembership'
  | 'ResultExpressionMembership'
  | 'ElementFilterMembership'
  | 'RequirementConstraintMembership'
  | 'RequirementVerificationMembership'
  | 'TransitionFeatureMembership'
  | 'StateSubactionMembership'
  | 'ViewRenderingMembership'
  | 'MembershipExpose'
  | 'MembershipImport'
  // imports
  | 'NamespaceImport';

const TYPE_CATEGORY: Record<SupportedSysmlType, keyof SysmlEnabledCategories> = {
  // structure — definitions
  Package: 'structure',
  LibraryPackage: 'structure',
  Namespace: 'structure',
  PartDefinition: 'structure',
  ItemDefinition: 'structure',
  PortDefinition: 'structure',
  ConnectionDefinition: 'structure',
  InterfaceDefinition: 'structure',
  AllocationDefinition: 'structure',
  AttributeDefinition: 'structure',
  EnumerationDefinition: 'structure',
  OccurrenceDefinition: 'structure',
  IndividualDefinition: 'structure',
  AssociationStructure: 'structure',
  DataType: 'structure',
  MetadataDefinition: 'structure',
  // structure — usages
  PartUsage: 'structure',
  ItemUsage: 'structure',
  PortUsage: 'structure',
  ConnectionUsage: 'structure',
  InterfaceUsage: 'structure',
  AllocationUsage: 'structure',
  AttributeUsage: 'structure',
  EnumerationUsage: 'structure',
  ReferenceUsage: 'structure',
  MetadataUsage: 'structure',
  IndividualUsage: 'structure',
  Comment: 'structure',
  Documentation: 'structure',
  // behavior — definitions
  ActionDefinition: 'behavior',
  StateDefinition: 'behavior',
  ConstraintDefinition: 'behavior',
  RequirementDefinition: 'behavior',
  CalculationDefinition: 'behavior',
  CaseDefinition: 'behavior',
  VerificationCaseDefinition: 'behavior',
  AnalysisCaseDefinition: 'behavior',
  UseCaseDefinition: 'behavior',
  ViewDefinition: 'behavior',
  RenderingDefinition: 'behavior',
  // behavior — usages
  OccurrenceUsage: 'behavior',
  ActionUsage: 'behavior',
  PerformActionUsage: 'behavior',
  AcceptActionUsage: 'behavior',
  StateUsage: 'behavior',
  ExhibitStateUsage: 'behavior',
  TransitionUsage: 'behavior',
  FlowUsage: 'behavior',
  FlowEnd: 'behavior',
  SuccessionAsUsage: 'behavior',
  ForkNode: 'behavior',
  JoinNode: 'behavior',
  MergeNode: 'behavior',
  DecisionNode: 'behavior',
  WhileLoopActionUsage: 'behavior',
  ForLoopActionUsage: 'behavior',
  ConstraintUsage: 'behavior',
  RequirementUsage: 'behavior',
  CalculationUsage: 'behavior',
  CaseUsage: 'behavior',
  VerificationCaseUsage: 'behavior',
  AnalysisCaseUsage: 'behavior',
  UseCaseUsage: 'behavior',
  EventOccurrenceUsage: 'behavior',
  ViewUsage: 'behavior',
  RenderingUsage: 'behavior',
  // features — KerML feature types
  Feature: 'features',
  FeatureValue: 'features',
  FeatureTyping: 'features',
  FeatureChaining: 'features',
  FeatureInverting: 'features',
  Conjugation: 'features',
  Subclassification: 'features',
  Multiplicity: 'features',
  MultiplicityRange: 'features',
  Subsetting: 'features',
  Redefinition: 'features',
  ReferenceSubsetting: 'features',
  BindingConnectorAsUsage: 'features',
  FeatureReferenceExpression: 'features',
  FeatureChainExpression: 'features',
  OperatorExpression: 'features',
  InvocationExpression: 'features',
  PayloadFeature: 'features',
  LiteralBoolean: 'features',
  LiteralInteger: 'features',
  LiteralRational: 'features',
  LiteralString: 'features',
  LiteralInfinity: 'features',
  // memberships
  OwningMembership: 'memberships',
  FeatureMembership: 'memberships',
  Membership: 'memberships',
  ParameterMembership: 'memberships',
  ReturnParameterMembership: 'memberships',
  EndFeatureMembership: 'memberships',
  ObjectiveMembership: 'memberships',
  SubjectMembership: 'memberships',
  ResultExpressionMembership: 'memberships',
  ElementFilterMembership: 'memberships',
  RequirementConstraintMembership: 'memberships',
  RequirementVerificationMembership: 'memberships',
  TransitionFeatureMembership: 'memberships',
  StateSubactionMembership: 'memberships',
  ViewRenderingMembership: 'memberships',
  MembershipExpose: 'memberships',
  MembershipImport: 'memberships',
  // imports
  NamespaceImport: 'imports',
};

export interface SysmlElementInfo {
  id: string;
  elementId: string;
  type: SupportedSysmlType;
  concept: string;
  stablePath: string;
  name: string;
  declaredName: string;
  qualifiedName: string;
  ownerId?: string;
  owningNamespaceId?: string;
  owningRelationshipId?: string;
  owningMembershipId?: string;
  owningRelatedElementId?: string;
  owningTypeId?: string;
  memberElementId?: string;
  featureWithValueId?: string;
  valueId?: string;
  generalId?: string;
  specificId?: string;
  typedFeatureId?: string;
  chainingFeatureId?: string;
  importedNamespaceId?: string;
  importedElementId?: string;
  typeIds: string[];
  definitionIds: string[];
  sourceIds: string[];
  targetIds: string[];
  memberIds: string[];
  membershipIds: string[];
  ownedMembershipIds: string[];
  ownedElementIds: string[];
  connectorEndIds: string[];
  isLibraryElement?: boolean;
  isImplied?: boolean;
  isImpliedIncluded?: boolean;
  isComposite?: boolean;
  isOrdered?: boolean;
  isUnique?: boolean;
  isEnd?: boolean;
  isAbstract?: boolean;
  isSufficient?: boolean;
  isIndividual?: boolean;
  isVariation?: boolean;
  isReference?: boolean;
  isDerived?: boolean;
  isReadonly?: boolean;
  isPortion?: boolean;
  isConjugated?: boolean;
  mayTimeVary?: boolean;
  direction?: string;
  visibility?: string;
  operator?: string;
  body?: string;
  memberName?: string;
  literalValue?: boolean | number | string;
}

export interface SysmlModel {
  elements: SysmlElementInfo[];
  skippedElements: Map<string, number>;
  /**
   * Conjugated port definition id → the port definition it conjugates.
   *
   * `ConjugatedPortDefinition` is not an imported concept: the export derives one
   * for *every* port definition whether or not the model conjugates anything, so
   * emitting them would double the port definitions in the graph with `~X` nodes
   * nothing references. But a port usage written `: ~P` is typed by that derived
   * definition, and the definition carries no features of its own — it inherits
   * them from `originalPortDefinition`. That link is the only way to reach the
   * directions such a port conveys, so it is kept here rather than discarded with
   * the element. See `resolvePortDirections`.
   */
  conjugatedPortDefinitions: Map<string, string>;
}

interface RawIdentity {
  '@id'?: string;
}

interface RawRecord {
  payload?: Record<string, unknown>;
  identity?: RawIdentity;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function refId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as RawIdentity)['@id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function refIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => refId(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function booleanField(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .replace(/::/g, '/')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Convert a SysML qualified name ("A::B::C") into a hierarchical path
 * ("/A/B/C"), sanitizing each segment. Returns '' if nothing usable remains.
 */
function qualifiedNameToPath(qualifiedName: string): string {
  const segments = qualifiedName
    .split('::')
    .map((seg) => sanitizeSegment(seg))
    .filter((seg) => seg.length > 0);
  return segments.join('/');
}

function buildStablePath(concept: string, payload: Record<string, unknown>, id: string, fallbackName: string): string {
  // Preferred: a clean, UUID-free hierarchical path derived from the element's
  // qualified name (e.g. "TigerDetectionSystemExample::PerceptionSystem" →
  // "/TigerDetectionSystemExample/PerceptionSystem"). SysML qualified names are
  // unique per named element, so this is a safe stable identity.
  const qualifiedName = stringField(payload, 'qualifiedName');
  if (qualifiedName) {
    const path = qualifiedNameToPath(qualifiedName);
    if (path) return `/${path}`;
  }

  // Fallback for anonymous / unqualified elements (relationships, expressions,
  // literals, memberships, …): these have no unique qualified name, so keep the
  // concept-scoped, id-suffixed form to guarantee uniqueness.
  const declaredName = stringField(payload, 'declaredName');
  const name = stringField(payload, 'name');
  const memberName = stringField(payload, 'memberName');
  const stem = firstNonEmpty(declaredName, name, memberName, fallbackName, id);
  const normalizedStem = sanitizeSegment(stem) || id;
  return `/${concept}/${normalizedStem}@${id}`;
}

function isSupportedType(value: string): value is SupportedSysmlType {
  return value in TYPE_CATEGORY;
}

function extractLiteralValue(payload: Record<string, unknown>): boolean | number | string | undefined {
  const v = payload.value;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && !v.startsWith('{')) return v;
  return undefined;
}

function parseRecord(record: RawRecord, enabled: SysmlEnabledCategories, skippedElements: Map<string, number>): SysmlElementInfo | null {
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') {
    increment(skippedElements, 'invalid_payload');
    return null;
  }

  const type = stringField(payload, '@type');
  if (!isSupportedType(type)) {
    increment(skippedElements, type || 'missing_type');
    return null;
  }

  if (!enabled[TYPE_CATEGORY[type]]) {
    increment(skippedElements, type);
    return null;
  }

  const id = firstNonEmpty(
    record.identity?.['@id'],
    stringField(payload, '@id'),
    stringField(payload, 'elementId'),
  );
  if (!id) {
    increment(skippedElements, `${type}_missing_id`);
    return null;
  }

  const concept = toSnakeCase(type);
  const name = firstNonEmpty(
    stringField(payload, 'name'),
    stringField(payload, 'declaredName'),
    stringField(payload, 'memberName'),
    stringField(payload, 'ownedMemberName'),
  );

  return {
    id,
    elementId: firstNonEmpty(stringField(payload, 'elementId'), id),
    type,
    concept,
    stablePath: buildStablePath(concept, payload, id, name || type),
    name,
    declaredName: stringField(payload, 'declaredName'),
    qualifiedName: stringField(payload, 'qualifiedName'),
    ownerId: refId(payload.owner),
    owningNamespaceId: refId(payload.owningNamespace) ?? refId(payload.membershipOwningNamespace),
    owningRelationshipId: refId(payload.owningRelationship),
    owningMembershipId: refId(payload.owningMembership),
    owningRelatedElementId: refId(payload.owningRelatedElement),
    owningTypeId: refId(payload.owningType),
    memberElementId: refId(payload.memberElement) ?? refId(payload.ownedMemberElement),
    featureWithValueId: refId(payload.featureWithValue),
    valueId: refId(payload.value),
    generalId: refId(payload.general),
    specificId: refId(payload.specific),
    typedFeatureId: refId(payload.typedFeature),
    chainingFeatureId: refId(payload.chainingFeature),
    importedNamespaceId: refId(payload.importedNamespace),
    importedElementId: refId(payload.importedElement),
    typeIds: refIds(payload.type),
    definitionIds: refIds(payload.definition),
    sourceIds: refIds(payload.source),
    targetIds: refIds(payload.target),
    memberIds: refIds(payload.member),
    membershipIds: refIds(payload.membership),
    ownedMembershipIds: refIds(payload.ownedMembership),
    ownedElementIds: refIds(payload.ownedElement),
    connectorEndIds: refIds(payload.connectorEnd),
    isLibraryElement: booleanField(payload, 'isLibraryElement'),
    isImplied: booleanField(payload, 'isImplied'),
    isImpliedIncluded: booleanField(payload, 'isImpliedIncluded'),
    isComposite: booleanField(payload, 'isComposite'),
    isOrdered: booleanField(payload, 'isOrdered'),
    isUnique: booleanField(payload, 'isUnique'),
    isEnd: booleanField(payload, 'isEnd'),
    isAbstract: booleanField(payload, 'isAbstract'),
    isSufficient: booleanField(payload, 'isSufficient'),
    isIndividual: booleanField(payload, 'isIndividual'),
    isVariation: booleanField(payload, 'isVariation'),
    isReference: booleanField(payload, 'isReference'),
    isDerived: booleanField(payload, 'isDerived'),
    isReadonly: booleanField(payload, 'isReadOnly'),
    isPortion: booleanField(payload, 'isPortion'),
    isConjugated: booleanField(payload, 'isConjugated'),
    mayTimeVary: booleanField(payload, 'mayTimeVary'),
    direction: stringField(payload, 'direction') || undefined,
    visibility: stringField(payload, 'visibility') || undefined,
    operator: stringField(payload, 'operator') || undefined,
    body: stringField(payload, 'body') || undefined,
    memberName: stringField(payload, 'memberName') || undefined,
    literalValue: extractLiteralValue(payload),
  };
}

/**
 * Record `conjugated → original` for a `ConjugatedPortDefinition` record.
 *
 * Runs alongside `parseRecord` rather than inside it: the type is deliberately
 * unsupported, so it must keep counting as skipped, and only this one field of it
 * survives.
 */
function harvestPortConjugation(record: RawRecord, conjugatedPortDefinitions: Map<string, string>): void {
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return;
  if (stringField(payload, '@type') !== 'ConjugatedPortDefinition') return;
  const id = firstNonEmpty(record.identity?.['@id'], stringField(payload, '@id'), stringField(payload, 'elementId'));
  const original = refId(payload.originalPortDefinition);
  if (id && original) conjugatedPortDefinitions.set(id, original);
}

export function parseSysmlProject(
  enabled: SysmlEnabledCategories,
  files: string[],
): SysmlModel {
  const elementsById = new Map<string, SysmlElementInfo>();
  const skippedElements = new Map<string, number>();
  const conjugatedPortDefinitions = new Map<string, string>();

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      increment(skippedElements, 'invalid_json_file');
      continue;
    }

    if (!Array.isArray(parsed)) {
      increment(skippedElements, 'invalid_root');
      continue;
    }

    for (const entry of parsed) {
      harvestPortConjugation(entry as RawRecord, conjugatedPortDefinitions);
      const element = parseRecord(entry as RawRecord, enabled, skippedElements);
      if (!element) continue;
      elementsById.set(element.id, element);
    }
  }

  return {
    elements: [...elementsById.values()],
    skippedElements,
    conjugatedPortDefinitions,
  };
}