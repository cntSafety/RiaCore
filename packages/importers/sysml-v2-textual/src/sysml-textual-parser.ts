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
 * sysml-textual-parser.ts
 *
 * Parses .sysml source files using the Langium SysIDE grammar (from
 * @riacore/sysml-language) and extracts a flat list of SysmlTextualElementInfo
 * records that are structurally equivalent to what the JSON importer produces.
 *
 * AST traversal:
 *   Namespace.children → OwningMembership → elements[0] (the owned Element)
 *   → recurse into (Element as Namespace).children
 *
 * Stable path:  Element.declaredName segments joined by '/', prepended with '/'.
 *   e.g.  TigerDetectionSystemExample::PerceptionSystem
 *       → /TigerDetectionSystemExample/PerceptionSystem
 */
import * as fs from 'node:fs';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createSysmlSubsetServices } from '@riacore/sysml-language';
import type { Namespace, Element, OwningMembership } from '@riacore/sysml-language';
import {
  isPackage, isLibraryPackage,
  isPartDefinition, isPortDefinition, isItemDefinition,
  isAttributeDefinition, isEnumerationDefinition,
  isActionDefinition, isStateDefinition, isInterfaceDefinition,
  isRequirementDefinition, isConstraintDefinition, isConnectionDefinition,
  isFlowConnectionDefinition, isUseCaseDefinition, isViewDefinition,
  isViewpointDefinition, isMetadataDefinition,
  isPartUsage, isPortUsage, isItemUsage, isAttributeUsage, isActionUsage,
  isStateUsage, isExhibitStateUsage, isConnectionUsage, isInterfaceUsage,
  isFlowConnectionUsage, isRequirementUsage,
  isConnector, isItemFlowEnd,
  isOwningMembership, isElement, isNamespace, isDefinition, isUsage, isType,
} from '@riacore/sysml-language';
import type { Type as SysmlType } from '@riacore/sysml-language';
import type { SysmlTextualEnabledCategories } from './config-loader.js';
import type { ImportDiagnostic } from '@riacore/app-contracts';

// ── Element info (mirrors the JSON importer's SysmlElementInfo) ──────────────

export interface SysmlTextualElementInfo {
  /** Unique stable identity — qualified name as path  */
  stablePath: string;
  /** Declared element name (may contain spaces if quoted) */
  name: string;
  /** '::'-joined qualified name  */
  qualifiedName: string;
  /** snake_case concept type, e.g. 'part_definition'  */
  concept: string;
  /** $type from the AST, e.g. 'PartDefinition'  */
  sysmlType: string;
  /** Whether the element is abstract */
  isAbstract?: boolean;
  /** Qualified or short names referenced by typing/specialization relationships. */
  superTypeNames: string[];
  /** Ordered qualified feature paths for binary connector ends. */
  connectorEnds?: string[][];
  /** Direction and feature flags mirrored from the JSON importer. */
  direction?: string;
  isComposite?: boolean;
  isOrdered?: boolean;
  isUnique?: boolean;
  isEnd?: boolean;
  isIndividual?: boolean;
  isVariation?: boolean;
  isReference?: boolean;
  isDerived?: boolean;
  isReadonly?: boolean;
  isPortion?: boolean;
  isConjugated?: boolean;
  /** File the element was defined in */
  sourceFile: string;
}

export interface SysmlTextualRelationshipInfo {
  relationship: string;
  sourceStablePath: string;
  targetStablePath: string;
}

export interface SysmlTextualModel {
  elements: SysmlTextualElementInfo[];
  relationships: SysmlTextualRelationshipInfo[];
  skippedElements: Map<string, number>;
  diagnostics: ImportDiagnostic[];
}

// ── Concept mapping ───────────────────────────────────────────────────────────

type ElementCategory = 'structure' | 'behavior' | 'features' | 'memberships' | 'imports';

function conceptAndCategory(el: Element): { concept: string; category: ElementCategory } | null {
  // Langium's generated type guards include subtypes. Matching a broad type
  // such as PartUsage before ConnectionUsage therefore silently classifies a
  // connection as a part. Prefer the concrete parser type for every construct
  // represented by this importer, then retain the guards only as fallbacks.
  const exact: Record<string, { concept: string; category: ElementCategory }> = {
    Package: { concept: 'package', category: 'structure' },
    LibraryPackage: { concept: 'library_package', category: 'structure' },
    PartDefinition: { concept: 'part_definition', category: 'structure' },
    PortDefinition: { concept: 'port_definition', category: 'structure' },
    ItemDefinition: { concept: 'item_definition', category: 'structure' },
    AttributeDefinition: { concept: 'attribute_definition', category: 'structure' },
    EnumerationDefinition: { concept: 'enumeration_definition', category: 'structure' },
    ConnectionDefinition: { concept: 'connection_definition', category: 'structure' },
    InterfaceDefinition: { concept: 'interface_definition', category: 'structure' },
    FlowConnectionDefinition: { concept: 'flow_connection_definition', category: 'structure' },
    MetadataDefinition: { concept: 'metadata_definition', category: 'structure' },
    PartUsage: { concept: 'part_usage', category: 'structure' },
    PortUsage: { concept: 'port_usage', category: 'structure' },
    ItemUsage: { concept: 'item_usage', category: 'structure' },
    AttributeUsage: { concept: 'attribute_usage', category: 'structure' },
    ConnectionUsage: { concept: 'connection_usage', category: 'structure' },
    InterfaceUsage: { concept: 'interface_usage', category: 'structure' },
    ReferenceUsage: { concept: 'reference_usage', category: 'structure' },
    FlowConnectionUsage: { concept: 'flow_connection_usage', category: 'behavior' },
    ActionDefinition: { concept: 'action_definition', category: 'behavior' },
    StateDefinition: { concept: 'state_definition', category: 'behavior' },
    ConstraintDefinition: { concept: 'constraint_definition', category: 'behavior' },
    RequirementDefinition: { concept: 'requirement_definition', category: 'behavior' },
    UseCaseDefinition: { concept: 'use_case_definition', category: 'behavior' },
    ViewDefinition: { concept: 'view_definition', category: 'behavior' },
    ViewpointDefinition: { concept: 'viewpoint_definition', category: 'behavior' },
    PerformActionUsage: { concept: 'perform_action_usage', category: 'behavior' },
    ExhibitStateUsage: { concept: 'exhibit_state_usage', category: 'behavior' },
    StateUsage: { concept: 'state_usage', category: 'behavior' },
    ActionUsage: { concept: 'action_usage', category: 'behavior' },
    RequirementUsage: { concept: 'requirement_usage', category: 'behavior' },
  };
  const exactMatch = exact[el.$type];
  if (exactMatch) return exactMatch;

  if (isLibraryPackage(el))         return { concept: 'library_package',             category: 'structure' };
  if (isPackage(el))                return { concept: 'package',                     category: 'structure' };
  if (isInterfaceDefinition(el))    return { concept: 'interface_definition',        category: 'structure' };
  if (isFlowConnectionDefinition(el)) return { concept: 'flow_connection_definition', category: 'structure' };
  if (isConnectionDefinition(el))   return { concept: 'connection_definition',       category: 'structure' };
  if (isStateDefinition(el))        return { concept: 'state_definition',            category: 'behavior' };
  if (isActionDefinition(el))       return { concept: 'action_definition',           category: 'behavior' };
  if (isRequirementDefinition(el))  return { concept: 'requirement_definition',      category: 'behavior' };
  if (isConstraintDefinition(el))   return { concept: 'constraint_definition',       category: 'behavior' };
  if (isPartDefinition(el))         return { concept: 'part_definition',             category: 'structure' };
  if (isPortDefinition(el))         return { concept: 'port_definition',             category: 'structure' };
  if (isItemDefinition(el))         return { concept: 'item_definition',             category: 'structure' };
  if (isAttributeDefinition(el))    return { concept: 'attribute_definition',        category: 'structure' };
  if (isEnumerationDefinition(el))  return { concept: 'enumeration_definition',      category: 'structure' };
  if (isInterfaceUsage(el))         return { concept: 'interface_usage',             category: 'structure' };
  if (isConnectionUsage(el))        return { concept: 'connection_usage',            category: 'structure' };
  if (isFlowConnectionUsage(el))    return { concept: 'flow_connection_usage',       category: 'behavior' };
  if (isPortUsage(el))              return { concept: 'port_usage',                  category: 'structure' };
  if (isPartUsage(el))              return { concept: 'part_usage',                  category: 'structure' };
  if (isItemUsage(el))              return { concept: 'item_usage',                  category: 'structure' };
  if (isAttributeUsage(el))         return { concept: 'attribute_usage',             category: 'structure' };
  if (isExhibitStateUsage(el))      return { concept: 'exhibit_state_usage',         category: 'behavior' };
  if (isStateUsage(el))             return { concept: 'state_usage',                 category: 'behavior' };
  if (isActionUsage(el))            return { concept: 'action_usage',                category: 'behavior' };
  if (isRequirementUsage(el))       return { concept: 'requirement_usage',           category: 'behavior' };
  if (isUseCaseDefinition(el))      return { concept: 'use_case_definition',         category: 'behavior' };
  if (isViewDefinition(el))         return { concept: 'view_definition',             category: 'behavior' };
  if (isViewpointDefinition(el))    return { concept: 'viewpoint_definition',        category: 'behavior' };
  if (isMetadataDefinition(el))     return { concept: 'metadata_definition',         category: 'structure' };
  // Generic fallbacks — map to concrete metamodel classes so the persistor
  // can resolve an identity attribute. These catch any Definition/Usage subtype
  // not explicitly handled above (e.g. AllocationDefinition, CaseUsage, etc.)
  if (isDefinition(el))             return { concept: 'unclassified_definition',     category: 'structure' };
  if (isUsage(el))                  return { concept: 'unclassified_usage',          category: 'structure' };
  if (isNamespace(el))              return { concept: 'namespace',                   category: 'structure' };
  return null;
}

// ── Stable path helpers ───────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.trim().replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function buildStablePath(segments: string[]): string {
  return '/' + segments.map(sanitize).filter(Boolean).join('/');
}

function getElementName(el: Element): string | undefined {
  return el.declaredName ?? el.declaredShortName ?? undefined;
}

function getSuperTypeNames(el: Element): string[] {
  if (!isType(el)) return [];
  const t = el as SysmlType;
  return (t.heritage ?? []).flatMap((h: unknown) => {
    const rel = h as {
      target?: Element;
      general?: Element;
      targetRef?: { parts?: Array<{ $refText?: string }> };
    };
    const target = rel.target ?? rel.general;
    if (target && isElement(target)) {
      const n = getElementName(target);
      return n ? [n] : [];
    }
    const refName = rel.targetRef?.parts
      ?.map((part) => part.$refText)
      .filter((part): part is string => Boolean(part))
      .join('::');
    if (refName) return [refName];
    return [];
  });
}

/**
 * Concepts whose ends are resolved into endpoint references.
 *
 * Exactly the concepts `sysml-v2-textual.linkml.yaml` declares as
 * `connection_usage` or a subtype of it — which is what makes them projectable
 * as a CommonModel `Connection`. Deliberately keyed on the *concept* name
 * rather than the AST `$type`: the concept name is the vocabulary the view
 * layer resolves structurally through `RIA_META_CONCEPT_SUBTYPEOF`, so the two
 * ends of the pipeline agree on one notion of "connection-like".
 *
 * `sysml-textual-parser.test.ts` asserts this set stays in step with the
 * metamodel's `is_a` declarations, so adding a subtype there cannot silently
 * leave its endpoints unimported.
 */
export const CONNECTOR_CONCEPTS: ReadonlySet<string> = new Set([
  'connection_usage',
  'interface_usage',
  'flow_connection_usage',
]);

/**
 * Feature kinds that carry a container's payload rather than being containers
 * themselves — a port definition's `out item dcPower`, an action definition's
 * `in dcPower` parameter.
 *
 * A genuine enumeration, not a subtype closure: the metamodel declares all three
 * as plain `usage` siblings of `port_usage` and `part_usage`, so there is no base
 * concept that separates "payload" from "container". This is what distinguishes
 * a flow end's second segment (`dcPowerPort.dcPower` — a payload) from a
 * connection end's second segment (`battery.dcPowerPort` — a port).
 */
export const PAYLOAD_FEATURE_CONCEPTS: ReadonlySet<string> = new Set([
  'item_usage',
  'attribute_usage',
  'reference_usage',
]);

/**
 * The `$refText` path carried by one heritage relationship: a `targetChain`
 * (`a.b.c`) if there is one, otherwise the bare `targetRef` (`a`).
 */
function heritageSegments(relationship: unknown): string[] {
  const rel = relationship as {
    targetChain?: { typeRelationships?: Array<{ targetRef?: { parts?: Array<{ $refText?: string }> } }> };
    targetRef?: { parts?: Array<{ $refText?: string }> };
  } | undefined;
  const chained = (rel?.targetChain?.typeRelationships ?? []).flatMap((part) =>
    (part.targetRef?.parts ?? [])
      .map((ref) => ref.$refText)
      .filter((ref): ref is string => Boolean(ref)),
  );
  if (chained.length > 0) return chained;
  return (rel?.targetRef?.parts ?? [])
    .map((ref) => ref.$refText)
    .filter((ref): ref is string => Boolean(ref));
}

/**
 * The feature path of each end of a connector-shaped usage, in declaration
 * order — `[['a', 'p'], ['b', 'p']]` for `connect a.p to b.p`.
 *
 * Two AST shapes, because SysML represents the two kinds of end differently:
 *
 * - A **connector** end (`connect`, `interface`, `allocate`) is a plain feature
 *   whose `ReferenceSubsetting` carries the entire path as a `targetChain`.
 * - A **flow** end (`flow from outerPort.dcPower to convert.dcPower`) is an
 *   `ItemFlowEnd` that splits the path in two: the *container* is subsetted on
 *   the end itself (`outerPort`), and the *payload feature* is a nested feature
 *   that **redefines** the container's feature (`dcPower`). Neither half is a
 *   chain. Recombining them here is what lets both kinds of end reach
 *   `resolveChain` as one ordered path and be resolved by the same code — and
 *   it is why `flow from a.p to b.p` between two part usages produces exactly
 *   the `part_usage.port_usage` pair a connection does.
 *
 * Every connector-shaped usage is read, including ones this importer does not
 * project as connections; which of them actually gets endpoint references
 * synthesised is decided by {@link CONNECTOR_CONCEPTS} at the call site.
 */
function getConnectorEnds(el: Element): string[][] | undefined {
  if (!isConnector(el)) return undefined;
  const connector = el as unknown as { ends?: Array<{ target?: Element; elements?: Element[] }> };
  const ends = (connector.ends ?? []).map((end) => {
    const target = (end.target ?? end.elements?.[0]) as
      (Element & { heritage?: unknown[]; children?: unknown[] }) | undefined;
    if (!target) return [];
    const container = heritageSegments(target.heritage?.[0]);
    // Only a flow end nests its payload feature. A connector end's children —
    // multiplicities, bindings, documentation — must never be mistaken for
    // path segments, hence the node-type test rather than "children if any".
    if (!isItemFlowEnd(target)) return container;
    const payload = (target.children ?? []).flatMap((child) => {
      const membership = child as { target?: Element; elements?: Element[] };
      const feature = (membership.target ?? membership.elements?.[0]) as { heritage?: unknown[] } | undefined;
      const redefinition = (feature?.heritage ?? []).find(
        (heritage) => (heritage as { $type?: string }).$type === 'Redefinition',
      );
      return redefinition === undefined ? [] : heritageSegments(redefinition);
    });
    return [...container, ...payload];
  }).filter((end) => end.length > 0);
  return ends.length > 0 ? ends : undefined;
}

// ── AST walker ────────────────────────────────────────────────────────────────

function walkNamespace(
  ns: Namespace,
  pathSegments: string[],
  sourceFile: string,
  enabled: SysmlTextualEnabledCategories,
  output: SysmlTextualElementInfo[],
  skipped: Map<string, number>,
): void {
  for (const child of ns.children ?? []) {
    if (!isOwningMembership(child)) continue;
    const om = child as OwningMembership;
    const rel = om as unknown as { elements?: Element[]; target?: Element };
    const owned = rel.elements?.[0] ?? rel.target;
    if (!owned || !isElement(owned)) continue;
    processElement(owned as Element, pathSegments, sourceFile, enabled, output, skipped);
  }
}

function processElement(
  el: Element,
  parentSegments: string[],
  sourceFile: string,
  enabled: SysmlTextualEnabledCategories,
  output: SysmlTextualElementInfo[],
  skipped: Map<string, number>,
): void {
  const name = getElementName(el);

  // Anonymous elements — still recurse into namespaces but don't emit a record
  if (!name) {
    skipped.set(el.$type ?? 'unknown', (skipped.get(el.$type ?? 'unknown') ?? 0) + 1);
    if (isNamespace(el)) {
      walkNamespace(el as Namespace, parentSegments, sourceFile, enabled, output, skipped);
    }
    return;
  }

  const cc = conceptAndCategory(el);
  if (!cc) {
    // Unrecognised type — skip but count
    skipped.set(el.$type ?? 'unknown', (skipped.get(el.$type ?? 'unknown') ?? 0) + 1);
    if (isNamespace(el)) {
      const segments = [...parentSegments, name];
      walkNamespace(el as Namespace, segments, sourceFile, enabled, output, skipped);
    }
    return;
  }

  // Category filter
  if (!enabled[cc.category]) {
    if (isNamespace(el)) {
      const segments = [...parentSegments, name];
      walkNamespace(el as Namespace, segments, sourceFile, enabled, output, skipped);
    }
    return;
  }

  const segments = [...parentSegments, name];
  const qualifiedName = segments.join('::');
  const stablePath = buildStablePath(segments);
  const superTypeNames = getSuperTypeNames(el);
  const feature = el as unknown as {
    direction?: string;
    isComposite?: unknown;
    isOrdered?: boolean;
    isNonunique?: boolean;
    isEnd?: unknown;
    isIndividual?: boolean;
    isVariation?: boolean;
    isReference?: boolean;
    isDerived?: unknown;
    isReadOnly?: unknown;
    isPortion?: unknown;
    heritage?: Array<{ $type?: string }>;
  };

  output.push({
    stablePath,
    name,
    qualifiedName,
    concept: cc.concept,
    sysmlType: el.$type ?? cc.concept,
    isAbstract: (el as { isAbstract?: unknown }).isAbstract === true
                  || (el as { isAbstract?: unknown }).isAbstract === 'abstract',
    superTypeNames,
    connectorEnds: getConnectorEnds(el),
    direction: feature.direction,
    isComposite: feature.isComposite === true || feature.isComposite === 'composite',
    isOrdered: feature.isOrdered,
    isUnique: feature.isNonunique === undefined ? undefined : !feature.isNonunique,
    isEnd: feature.isEnd === true || feature.isEnd === 'end',
    isIndividual: feature.isIndividual,
    isVariation: feature.isVariation,
    isReference: feature.isReference,
    isDerived: feature.isDerived === true || feature.isDerived === 'derived',
    isReadonly: feature.isReadOnly === true || feature.isReadOnly === 'readonly',
    isPortion: feature.isPortion === true || feature.isPortion === 'portion',
    isConjugated: feature.heritage?.some((relationship) => relationship.$type === 'ConjugatedPortTyping'),
    sourceFile,
  });

  // Recurse
  if (isNamespace(el)) {
    walkNamespace(el as Namespace, segments, sourceFile, enabled, output, skipped);
  }
}

/** Name resolution over a parsed model, shared by the passes that need it. */
interface ElementIndex {
  byQualifiedName: Map<string, SysmlTextualElementInfo>;
  /** Resolve a reference the way SysML scoping does: exact, then outward. */
  resolveLexically(reference: string, scopeQualifiedName: string): SysmlTextualElementInfo | undefined;
  /** The definition a usage is typed by, or the supertype of a definition. */
  resolveType(element: SysmlTextualElementInfo): SysmlTextualElementInfo | undefined;
  /** The elements whose qualified name makes them members of `owner`. */
  membersOf(owner: SysmlTextualElementInfo): SysmlTextualElementInfo[];
}

function indexElements(elements: SysmlTextualElementInfo[]): ElementIndex {
  const byQualifiedName = new Map(elements.map((element) => [element.qualifiedName, element]));
  const byShortName = new Map<string, SysmlTextualElementInfo[]>();
  const byOwner = new Map<string, SysmlTextualElementInfo[]>();
  for (const element of elements) {
    const named = byShortName.get(element.name) ?? [];
    named.push(element);
    byShortName.set(element.name, named);

    const owner = element.qualifiedName.split('::').slice(0, -1).join('::');
    if (!owner) continue;
    const owned = byOwner.get(owner) ?? [];
    owned.push(element);
    byOwner.set(owner, owned);
  }

  function resolveLexically(reference: string, scopeQualifiedName: string): SysmlTextualElementInfo | undefined {
    const exact = byQualifiedName.get(reference);
    if (exact) return exact;

    const scope = scopeQualifiedName.split('::').filter(Boolean);
    for (let length = scope.length; length > 0; length -= 1) {
      const candidate = [...scope.slice(0, length), reference].join('::');
      const match = byQualifiedName.get(candidate);
      if (match) return match;
    }

    const shortMatches = byShortName.get(reference) ?? [];
    return shortMatches.length === 1 ? shortMatches[0] : undefined;
  }

  function resolveType(element: SysmlTextualElementInfo): SysmlTextualElementInfo | undefined {
    const ownerScope = element.qualifiedName.split('::').slice(0, -1).join('::');
    for (const reference of element.superTypeNames) {
      const match = resolveLexically(reference, ownerScope);
      if (match) return match;
    }
    return undefined;
  }

  return {
    byQualifiedName,
    resolveLexically,
    resolveType,
    membersOf: (owner) => byOwner.get(owner.qualifiedName) ?? [],
  };
}

/** A feature direction as SysML declares it. */
type FeatureDirection = 'in' | 'out' | 'inout';

function asFeatureDirection(value: string | undefined): FeatureDirection | undefined {
  return value === 'in' || value === 'out' || value === 'inout' ? value : undefined;
}

/** Conjugating a port swaps the direction of everything it carries. */
function conjugated(direction: FeatureDirection): FeatureDirection {
  return direction === 'in' ? 'out' : direction === 'out' ? 'in' : 'inout';
}

/**
 * Give each port usage the direction its payload actually flows.
 *
 * A port declares no direction of its own — its *features* do, and a conjugated
 * type reverses them:
 *
 *     port def DcPowerPort { out item dcPower : DcPower; }
 *     port dcPowerPort : ~DcPowerPort;   // therefore receives dcPower
 *
 * Resolving that needs three things at once: the port, the definition it is
 * typed by, and that definition's features. Only the importer holds all three.
 * The view layer cannot do it, because a feature's `direction` lives inside the
 * opaque `attributes` JSON of a *different* node, and the query engine has no
 * JSON parsing — the very reason attribute shaping is procedural there. So the
 * effective direction is materialised here, where the type is still resolved,
 * and the projection reads it as if the port had declared it outright.
 *
 * Without this every typed port projects as an `InOutPort`, which is why they all
 * used to be laid out on the same side of a tile regardless of which way their
 * data ran.
 *
 * Deliberately conservative: a port whose features disagree, or that resolves to
 * no features at all, is left alone and stays bidirectional. A guess would be
 * worse than the honest "unknown" the diagram already knows how to draw.
 */
export function resolvePortDirections(elements: SysmlTextualElementInfo[]): void {
  const index = indexElements(elements);

  /** The single direction `owner`'s own features agree on, if they do. */
  const featureDirection = (owner: SysmlTextualElementInfo | undefined): FeatureDirection | undefined => {
    if (!owner) return undefined;
    const declared = new Set(
      index.membersOf(owner)
        .map((member) => asFeatureDirection(member.direction))
        .filter((direction): direction is FeatureDirection => direction !== undefined),
    );
    return declared.size === 1 ? [...declared][0] : undefined;
  };

  for (const port of elements) {
    // An explicit direction on the port itself is the author's word; never override it.
    if (port.concept !== 'port_usage' || asFeatureDirection(port.direction)) continue;

    // Features declared on the port body win over the ones it inherits, matching
    // how a redefinition shadows the definition it came from.
    const direction = featureDirection(port) ?? featureDirection(index.resolveType(port));
    if (!direction) continue;

    port.direction = port.isConjugated ? conjugated(direction) : direction;
  }
}

function materializeConnectorEndpoints(
  elements: SysmlTextualElementInfo[],
  relationships: SysmlTextualRelationshipInfo[],
  diagnostics: ImportDiagnostic[],
): void {
  const sourceElements = [...elements];
  const { byQualifiedName, resolveLexically, resolveType } = indexElements(sourceElements);

  function resolveChain(connection: SysmlTextualElementInfo, references: string[]): SysmlTextualElementInfo[] | undefined {
    if (references.length === 0) return undefined;
    const ownerScope = connection.qualifiedName.split('::').slice(0, -1).join('::');
    const first = resolveLexically(references[0], ownerScope);
    if (!first) return undefined;

    const resolved = [first];
    let current = first;
    for (const reference of references.slice(1)) {
      let next = byQualifiedName.get(`${current.qualifiedName}::${reference}`);
      if (!next) {
        const type = resolveType(current);
        if (type) next = byQualifiedName.get(`${type.qualifiedName}::${reference}`);
      }
      if (!next) return undefined;
      resolved.push(next);
      current = next;
    }
    return resolved;
  }

  function addSynthetic(
    stablePath: string,
    concept: string,
    sysmlType: string,
    name: string,
    sourceFile: string,
  ): SysmlTextualElementInfo {
    const element: SysmlTextualElementInfo = {
      stablePath,
      name,
      // Anonymous JSON-export elements do not have qualified names. Keeping
      // this empty also prevents the generic containment derivation from
      // inventing relationships beyond the explicit JSON-equivalent shape.
      qualifiedName: '',
      concept,
      sysmlType,
      superTypeNames: [],
      sourceFile,
    };
    elements.push(element);
    return element;
  }

  function addRelationship(
    relationship: string,
    source: SysmlTextualElementInfo,
    target: SysmlTextualElementInfo,
  ): void {
    relationships.push({
      relationship,
      sourceStablePath: source.stablePath,
      targetStablePath: target.stablePath,
    });
  }

  for (const connection of sourceElements) {
    if (!CONNECTOR_CONCEPTS.has(connection.concept) || !connection.connectorEnds?.length) continue;

    if (connection.connectorEnds.length !== 2) {
      diagnostics.push({
        level: 'warning',
        message: `${connection.concept} ${connection.qualifiedName} has ${connection.connectorEnds.length} end(s); ` +
          'the CommonModel connection projection expects a binary connector.',
        source: connection.sourceFile,
      });
    }

    for (const [endIndex, references] of connection.connectorEnds.entries()) {
      const role = endIndex === 0 ? 'source' : 'target';
      const end = addSynthetic(
        `${connection.stablePath}/$end/${endIndex}`,
        'reference_usage',
        'ReferenceUsage',
        role,
        connection.sourceFile,
      );
      addRelationship('owns_element', connection, end);
      addRelationship('connects', connection, end);

      const resolved = resolveChain(connection, references);
      if (!resolved) {
        diagnostics.push({
          level: 'warning',
          message: `Could not resolve ${role} endpoint ${references.join('.')} of ` +
            `${connection.qualifiedName}; the connection end was imported without a rendered port.`,
          source: connection.sourceFile,
        });
        continue;
      }

      // The JSON importer references an unqualified port directly. A qualified
      // usage.port endpoint is represented as an anonymous Feature with one
      // FeatureChaining relationship per segment.
      if (resolved.length === 1 && resolved[0].concept === 'port_usage') {
        addRelationship(`references_${role}`, connection, resolved[0]);
        continue;
      }

      // A flow end names a feature *inside* its container: `dcPowerPort.dcPower`
      // is the port's payload item, not a nested port. Where the container is
      // itself a port, that port is already the pin a diagram draws on, so the
      // endpoint resolves straight to it — which lets the flow reuse the same
      // projection as a directly-referenced connection endpoint instead of
      // needing a contextual pin of its own.
      //
      // The feature chain below is still recorded, so which item flows stays
      // traceable; it simply is not what the endpoint resolves to. A
      // (part_usage, port_usage) chain is deliberately excluded — there the
      // second segment is the port, and the contextual-pin rules in the query
      // catalog own that case.
      if (resolved.length === 2
        && resolved[0].concept === 'port_usage'
        && PAYLOAD_FEATURE_CONCEPTS.has(resolved[1].concept)) {
        addRelationship(`references_${role}`, connection, resolved[0]);
      }

      const feature = addSynthetic(
        `${connection.stablePath}/$end/${endIndex}/$feature`,
        'feature',
        'Feature',
        '',
        connection.sourceFile,
      );
      addRelationship('owns_element', end, feature);
      addRelationship('specializes', end, feature);
      addRelationship(`references_${role}`, connection, feature);

      for (const [chainIndex, member] of resolved.entries()) {
        const chaining = addSynthetic(
          `${connection.stablePath}/$end/${endIndex}/$feature/$chain/${chainIndex}`,
          'feature_chaining',
          'FeatureChaining',
          '',
          connection.sourceFile,
        );
        addRelationship('references_source', chaining, feature);
        addRelationship('chains_feature', chaining, member);
      }
    }
  }
}

// ── Singleton parser (lazy-initialised for the lifetime of the import run) ────

let _parseHelper: ReturnType<typeof parseHelper<Namespace>> | null = null;

function getParser(): ReturnType<typeof parseHelper<Namespace>> {
  if (!_parseHelper) {
    const services = createSysmlSubsetServices(EmptyFileSystem);
    _parseHelper = parseHelper<Namespace>(services.SysmlSubset);
  }
  return _parseHelper;
}

/** Call this at the start of each import run to force re-initialisation. */
export function resetParser(): void {
  _parseHelper = null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parseSysmlTextualProject(
  enabled: SysmlTextualEnabledCategories,
  files: string[],
): Promise<SysmlTextualModel> {
  const parse = getParser();
  const elements: SysmlTextualElementInfo[] = [];
  const relationships: SysmlTextualRelationshipInfo[] = [];
  const skippedElements = new Map<string, number>();
  const diagnostics: ImportDiagnostic[] = [];

  for (const filePath of files) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      diagnostics.push({
        level: 'error',
        message: `Cannot read file: ${filePath} — ${String(err)}`,
        source: filePath,
      });
      continue;
    }

    let doc: Awaited<ReturnType<typeof parse>>;
    try {
      doc = await parse(source, { validationChecks: 'none' });
    } catch (err) {
      diagnostics.push({
        level: 'error',
        message: `Parse failed for file: ${filePath} — ${String(err)}`,
        source: filePath,
      });
      continue;
    }

    // Collect parser errors as warnings (partial extraction still proceeds)
    if (doc.parseResult.parserErrors.length > 0) {
      const first = doc.parseResult.parserErrors[0];
      diagnostics.push({
        level: 'warning',
        message: `${doc.parseResult.parserErrors.length} parser error(s) in ${filePath}. ` +
          `First: line ${first.token?.startLine ?? '?'}: ${first.message?.slice(0, 120)}`,
        source: filePath,
      });
    }
    if (doc.parseResult.lexerErrors.length > 0) {
      diagnostics.push({
        level: 'warning',
        message: `${doc.parseResult.lexerErrors.length} lexer error(s) in ${filePath}`,
        source: filePath,
      });
    }

    // Walk the AST even if there were parse errors — partial extraction is better than nothing
    try {
      walkNamespace(doc.parseResult.value, [], filePath, enabled, elements, skippedElements);
    } catch (err) {
      diagnostics.push({
        level: 'error',
        message: `AST extraction failed for ${filePath}: ${String(err)}`,
        source: filePath,
      });
    }
  }

  // Before endpoint synthesis, so the ports the connectors resolve to already
  // carry their effective direction rather than being back-filled afterwards.
  resolvePortDirections(elements);
  materializeConnectorEndpoints(elements, relationships, diagnostics);
  return { elements, relationships, skippedElements, diagnostics };
}
