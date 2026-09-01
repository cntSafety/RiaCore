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
 * arxml-parser.ts — ARXML Example Project Parser
 *
 * Reads all .arxml files from a project directory and extracts a
 * typed model used by the ARXML importer to populate the graph database.
 *
 * No external dependencies — uses Node.js built-ins only.
 *
 * Reused from importer/arxml/arxml-src/arxml-parser.ts with only:
 *   - Import path updated to use ESM .js extension
 *  
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { type EnabledCategories, DEFAULT_ENABLED_CATEGORIES } from './config-loader.js';

// ── Minimal XML parser ────────────────────────────────────────────────────────
// Handles the well-structured ARXML files without any external library.

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  /** Ordered text/children, needed for mixed-content documentation such as DESC. */
  content: Array<string | XmlNode>;
}

function decodeXmlText(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity];
    const value = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : match;
  });
}

function parseXml(source: string): XmlNode | null {
  const xml = source;

  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '', content: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const ltIdx = xml.indexOf('<', i);
    if (ltIdx === -1) break;

    // Text between tags
    if (ltIdx > i) {
      const rawText = xml.slice(i, ltIdx);
      const text = rawText.trim();
      stack[stack.length - 1]?.content.push(decodeXmlText(rawText));
      if (text) {
        const top = stack[stack.length - 1];
        if (top) top.text = text;
      }
    }

    // Skip markup here, not with a global replacement that would alter CDATA.
    if (xml.startsWith('<!--', ltIdx) || xml.startsWith('<?', ltIdx)) {
      const closing = xml.startsWith('<!--', ltIdx) ? '-->' : '?>';
      const end = xml.indexOf(closing, ltIdx + 2);
      if (end === -1) break;
      i = end + closing.length;
      continue;
    }

    if (xml.startsWith('<![CDATA[', ltIdx)) {
      const end = xml.indexOf(']]>', ltIdx + 9);
      if (end === -1) break;
      const value = xml.slice(ltIdx + 9, end);
      const top = stack[stack.length - 1];
      if (top) {
        top.text = value;
        top.content.push(value);
      }
      i = end + 3;
      continue;
    }

    const gtIdx = xml.indexOf('>', ltIdx);
    if (gtIdx === -1) break;

    const inner = xml.slice(ltIdx + 1, gtIdx).trim();
    i = gtIdx + 1;

    if (inner.startsWith('/')) {
      // End tag
      stack.pop();
    } else if (!inner.startsWith('!') && !inner.startsWith('?')) {
      // Start or self-closing tag
      const selfClosing = inner.endsWith('/');
      const content = selfClosing ? inner.slice(0, -1).trim() : inner;

      // Tag name = first non-whitespace token
      let j = 0;
      while (j < content.length && !/\s/.test(content[j])) j++;
      const tagName = content.slice(0, j);

      // Attributes
      const attrStr = content.slice(j);
      const attrs: Record<string, string> = {};
      const attrRe = /([\w:.\-]+)\s*=\s*"([^"]*)"/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrStr)) !== null) {
        attrs[am[1]] = am[2];
      }

      const node: XmlNode = { tag: tagName, attrs, children: [], text: '', content: [] };
      const top = stack[stack.length - 1];
      if (top) {
        top.children.push(node);
        top.content.push(node);
      }
      if (!selfClosing) stack.push(node);
    }
  }

  return root.children[0] ?? null;
}

// ── XML navigation helpers ────────────────────────────────────────────────────

function children(node: XmlNode | undefined, tag: string): XmlNode[] {
  return node?.children.filter((c) => c.tag === tag) ?? [];
}

function child(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  return node?.children.find((c) => c.tag === tag);
}

/** Text content of the first child matching `tag`. */
function textOf(node: XmlNode | undefined, tag: string): string {
  return child(node, tag)?.text.trim() ?? '';
}

function documentationText(node: XmlNode): string {
  return node.content.map(part => typeof part === 'string' ? part : documentationText(part)).join('');
}

/** Collect only an element's own DESC; do not inherit a parent's or a child's note. */
function collectDescriptions(node: XmlNode, parentPath: string, descriptions: Map<string, string>): void {
  const name = textOf(node, 'SHORT-NAME');
  const path = name ? `${parentPath}/${name}` : parentPath;
  const desc = child(node, 'DESC');
  if (name && desc && !descriptions.has(path)) {
    const languages = children(desc, 'L-2');
    const text = languages.length ? languages.map(language => {
      const value = documentationText(language).replace(/\s+/g, ' ').trim();
      return languages.length > 1 ? `[${language.attrs.L ?? 'und'}] ${value}` : value;
    }).join('\n') : documentationText(desc).replace(/\s+/g, ' ').trim();
    if (text) descriptions.set(path, text);
  }
  for (const nested of node.children) collectDescriptions(nested, path, descriptions);
}

// ── Model types ───────────────────────────────────────────────────────────────

export type SwcKind =
  | 'application_swc'
  | 'composition_swc'
  | 'ecu_abstraction_swc'
  | 'service_swc'
  | 'cdd_swc'
  | 'sensor_actuator_swc'
  | 'nv_block_swc'
  | 'parameter_swc'
  | 'service_proxy_swc';

export interface ArPackageInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  parentStablePath: string | null;
}

export interface SwcTypeInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  kind: SwcKind;
}

export interface PPortInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  ownerStablePath: string;
  interfaceRef: string;
}

export interface RPortInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  ownerStablePath: string;
  interfaceRef: string;
}

export interface SrInterfaceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface CsInterfaceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface DataElementInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  interfaceArPath: string;
}

export interface CsOperationInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  interfaceArPath: string;
}

export interface SwcPrototypeInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  compositionArPath: string;
  typeRef: string;
}

export interface InternalBehaviorInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  swcArPath: string;
}

export interface SwcImplementationInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  behaviorRef: string;
}

export interface AssemblyConnectorInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  compositionArPath: string;
  providerPortRef: string;
  requesterPortRef: string;
}

export interface DelegationConnectorInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  compositionArPath: string;
  innerPortRef: string;
  outerPortRef: string;
}

export interface RootCompositionInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  systemArPath: string;
  softwareCompositionRef: string;
}

export interface SystemInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface ImplDataTypeInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  category: string;
}

export interface ImplDataTypeElementInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  parentStablePath: string;
  typeRef: string;
}

export interface SwBaseTypeInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  baseTypeSize: string;
  baseTypeEncoding: string;
}

export interface CompuMethodInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  category: string;
}

export interface DataConstrInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface ModeDeclarationGroupInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  category: string;
}

export interface MsInterfaceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  modeGroupRef: string;
}

export interface NvDataInterfaceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface ParameterInterfaceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface TriggerInterfaceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface DataTypeMappingSetInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface RunnableEntityInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  behaviorArPath: string;
  symbol: string;
  canBeInvokedConcurrently: string;
  minimumStartInterval: string;
}

export interface EventInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  behaviorArPath: string;
  kind: string;
  period: string;
  startOnEventRef: string;
}

export interface ExclusiveAreaInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  behaviorArPath: string;
}

export interface PerInstanceMemoryInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  behaviorArPath: string;
}

export interface BswModuleDescriptionInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface BswInternalBehaviorInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  moduleArPath: string;
}

export interface BswModuleEntryInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  callType: string;
  executionContext: string;
}

export interface BswEntityInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  behaviorArPath: string;
  implementedEntryRef: string;
}

export interface AppDataTypeInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  kind: 'app_primitive_data_type' | 'app_record_data_type' | 'app_array_data_type';
}

export interface UnitInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  displayName: string;
}

export interface PrPortInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  ownerStablePath: string;
  interfaceRef: string;
}

// ── Phase C model types ───────────────────────────────────────────────────────

export interface EcucValueCollectionInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface EcucModuleConfigInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  definitionRef: string;
}

export interface EcucContainerValueInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  parentStablePath: string;
  definitionRef: string;
}

// ── Phase B model types ───────────────────────────────────────────────────────

export interface EcuInstanceInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface CommClusterInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  kind: 'can_cluster' | 'lin_cluster';
}

export interface CommFrameInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
  kind: 'can_frame' | 'lin_frame';
}

export interface ISignalInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface ISignalIPduInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface IPduGroupInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface SystemSignalInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface SystemSignalGroupInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface ISignalGroupInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface LinSporadicFrameInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface ConstantSpecificationInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface SwAddrMethodInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface SrToSignalMappingInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  systemArPath: string;
  signalRef: string;
  dataElementRef: string;
}

export interface FlatMapInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  packageStablePath: string;
}

export interface FlatInstanceDescriptorInfo {
  uuid: string;
  shortName: string;
  stablePath: string;
  flatMapArPath: string;
}

export interface ArxmlModel {
  packages: ArPackageInfo[];
  swcTypes: SwcTypeInfo[];
  pPorts: PPortInfo[];
  rPorts: RPortInfo[];
  srInterfaces: SrInterfaceInfo[];
  csInterfaces: CsInterfaceInfo[];
  dataElements: DataElementInfo[];
  operations: CsOperationInfo[];
  swcPrototypes: SwcPrototypeInfo[];
  internalBehaviors: InternalBehaviorInfo[];
  implementations: SwcImplementationInfo[];
  assemblyConnectors: AssemblyConnectorInfo[];
  delegationConnectors: DelegationConnectorInfo[];
  systems: SystemInfo[];
  rootCompositions: RootCompositionInfo[];
  implDataTypes: ImplDataTypeInfo[];
  implDataTypeElements: ImplDataTypeElementInfo[];
  swBaseTypes: SwBaseTypeInfo[];
  compuMethods: CompuMethodInfo[];
  dataConstrs: DataConstrInfo[];
  modeDeclarationGroups: ModeDeclarationGroupInfo[];
  msInterfaces: MsInterfaceInfo[];
  nvDataInterfaces: NvDataInterfaceInfo[];
  parameterInterfaces: ParameterInterfaceInfo[];
  triggerInterfaces: TriggerInterfaceInfo[];
  dataTypeMappingSets: DataTypeMappingSetInfo[];
  runnableEntities: RunnableEntityInfo[];
  events: EventInfo[];
  exclusiveAreas: ExclusiveAreaInfo[];
  perInstanceMemories: PerInstanceMemoryInfo[];
  bswModuleDescriptions: BswModuleDescriptionInfo[];
  bswInternalBehaviors: BswInternalBehaviorInfo[];
  bswModuleEntries: BswModuleEntryInfo[];
  bswEntities: BswEntityInfo[];
  appDataTypes: AppDataTypeInfo[];
  units: UnitInfo[];
  prPorts: PrPortInfo[];
  // Phase B
  ecuInstances: EcuInstanceInfo[];
  commClusters: CommClusterInfo[];
  commFrames: CommFrameInfo[];
  iSignals: ISignalInfo[];
  iSignalIPdus: ISignalIPduInfo[];
  iPduGroups: IPduGroupInfo[];
  systemSignals: SystemSignalInfo[];
  systemSignalGroups: SystemSignalGroupInfo[];
  iSignalGroups: ISignalGroupInfo[];
  srToSignalMappings: SrToSignalMappingInfo[];
  flatMaps: FlatMapInfo[];
  flatInstanceDescriptors: FlatInstanceDescriptorInfo[];
  linSporadicFrames: LinSporadicFrameInfo[];
  constantSpecifications: ConstantSpecificationInfo[];
  swAddrMethods: SwAddrMethodInfo[];
  // Phase C
  ecucValueCollections: EcucValueCollectionInfo[];
  ecucModuleConfigs: EcucModuleConfigInfo[];
  ecucContainerValues: EcucContainerValueInfo[];
  /** Element types skipped because they are not in the metamodel, grouped by tag name */
  skippedElements: Map<string, number>;
  /** Plain-text DESC documentation keyed by the same stable paths as imported elements. */
  descriptions?: Map<string, string>;
}

// ── Extraction state (deduplication sets) ─────────────────────────────────────
// Each element has a globally unique arPath, so a single seen-set per element
// type prevents duplicates from files that re-declare the same package context.

const seen = {
  pkg:        new Set<string>(),
  swc:        new Set<string>(),
  pPort:      new Set<string>(),
  rPort:      new Set<string>(),
  srIf:       new Set<string>(),
  csIf:       new Set<string>(),
  dataEl:     new Set<string>(),
  op:         new Set<string>(),
  proto:      new Set<string>(),
  ib:         new Set<string>(),
  impl:       new Set<string>(),
  assembly:   new Set<string>(),
  delegation: new Set<string>(),
  system:     new Set<string>(),
  rootComp:   new Set<string>(),
  implDataType:   new Set<string>(),
  implDataTypeEl: new Set<string>(),
  swBaseType:     new Set<string>(),
  compuMethod:    new Set<string>(),
  dataConstr:     new Set<string>(),
  modeDecGroup:   new Set<string>(),
  msIf:           new Set<string>(),
  nvDataIf:       new Set<string>(),
  paramIf:        new Set<string>(),
  triggerIf:      new Set<string>(),
  dtMappingSet:   new Set<string>(),
  runnable:       new Set<string>(),
  event:          new Set<string>(),
  exclArea:       new Set<string>(),
  pim:            new Set<string>(),
  bswModDesc:     new Set<string>(),
  bswIb:          new Set<string>(),
  bswEntry:       new Set<string>(),
  bswEntity:      new Set<string>(),
  appDataType:    new Set<string>(),
  unit:           new Set<string>(),
  prPort:         new Set<string>(),
  // Phase B
  ecuInstance:    new Set<string>(),
  commCluster:    new Set<string>(),
  commFrame:      new Set<string>(),
  iSignal:        new Set<string>(),
  iSignalIPdu:    new Set<string>(),
  iSignalGroup:   new Set<string>(),
  iPduGroup:      new Set<string>(),
  systemSignal:   new Set<string>(),
  systemSignalGroup: new Set<string>(),
  srToSignalMapping: new Set<string>(),
  flatMap:        new Set<string>(),
  flatInstanceDesc: new Set<string>(),
  linSporadicFrame: new Set<string>(),
  constantSpec:   new Set<string>(),
  swAddrMethod:   new Set<string>(),
  // Phase C
  ecucValueCollection: new Set<string>(),
  ecucModuleConfig:    new Set<string>(),
  ecucContainerValue:  new Set<string>(),
};

// ── ARXML element tag → concept kind ──────────────────────────────────────────

const SWC_TAG_TO_KIND: Record<string, SwcKind> = {
  'APPLICATION-SW-COMPONENT-TYPE':            'application_swc',
  'COMPOSITION-SW-COMPONENT-TYPE':            'composition_swc',
  'ECU-ABSTRACTION-SW-COMPONENT-TYPE':        'ecu_abstraction_swc',
  'SERVICE-SW-COMPONENT-TYPE':                'service_swc',
  'COMPLEX-DEVICE-DRIVER-SW-COMPONENT-TYPE':  'cdd_swc',
  'SENSOR-ACTUATOR-SW-COMPONENT-TYPE':        'sensor_actuator_swc',
  'NV-BLOCK-SW-COMPONENT-TYPE':               'nv_block_swc',
  'PARAMETER-SW-COMPONENT-TYPE':              'parameter_swc',
  'SERVICE-PROXY-SW-COMPONENT-TYPE':          'service_proxy_swc',
};

// ── Recursive extraction ──────────────────────────────────────────────────────

function extractPackage(
  pkg: XmlNode,
  parentArPath: string | null,
  model: ArxmlModel,
  categories: EnabledCategories,
): void {
  const shortName = textOf(pkg, 'SHORT-NAME');
  if (!shortName) return;

  const arPath = (parentArPath ?? '') + '/' + shortName;
  const uuid   = pkg.attrs['UUID'] ?? '';

  if (!seen.pkg.has(arPath)) {
    seen.pkg.add(arPath);
    model.packages.push({ uuid, shortName, stablePath: arPath, parentStablePath: parentArPath });
  }

  // Nested sub-packages
  const subPkgs = child(pkg, 'AR-PACKAGES');
  for (const sub of children(subPkgs, 'AR-PACKAGE')) {
    extractPackage(sub, arPath, model, categories);
  }

  // Owned elements
  const elements = child(pkg, 'ELEMENTS');
  if (!elements) return;

  for (const el of elements.children) {
    const swcKind = SWC_TAG_TO_KIND[el.tag];
    if (swcKind) {
      if (categories.swc_types) {
        extractSwcType(el, arPath, swcKind, model, categories);
      }
    } else if (el.tag === 'SENDER-RECEIVER-INTERFACE') {
      if (categories.port_interfaces) {
        extractSrInterface(el, arPath, model);
      }
    } else if (el.tag === 'CLIENT-SERVER-INTERFACE') {
      if (categories.port_interfaces) {
        extractCsInterface(el, arPath, model);
      }
    } else if (el.tag === 'SWC-IMPLEMENTATION') {
      if (categories.swc_behavior) {
        extractImplementation(el, arPath, model);
      }
    } else if (el.tag === 'SYSTEM') {
      if (categories.system) {
        extractSystem(el, arPath, model);
      }
    }
    // ── Phase A extraction (gated by categories) ──
    else if (el.tag === 'IMPLEMENTATION-DATA-TYPE') {
      if (categories.data_types) extractImplDataType(el, arPath, model);
    } else if (el.tag === 'SW-BASE-TYPE') {
      if (categories.data_types) extractSwBaseType(el, arPath, model);
    } else if (el.tag === 'COMPU-METHOD') {
      if (categories.data_types) extractCompuMethod(el, arPath, model);
    } else if (el.tag === 'DATA-CONSTR') {
      if (categories.data_types) extractDataConstr(el, arPath, model);
    } else if (el.tag === 'APPLICATION-PRIMITIVE-DATA-TYPE') {
      if (categories.data_types) extractAppDataType(el, arPath, 'app_primitive_data_type', model);
    } else if (el.tag === 'APPLICATION-RECORD-DATA-TYPE') {
      if (categories.data_types) extractAppDataType(el, arPath, 'app_record_data_type', model);
    } else if (el.tag === 'APPLICATION-ARRAY-DATA-TYPE') {
      if (categories.data_types) extractAppDataType(el, arPath, 'app_array_data_type', model);
    } else if (el.tag === 'DATA-TYPE-MAPPING-SET') {
      if (categories.data_types) extractDataTypeMappingSet(el, arPath, model);
    } else if (el.tag === 'UNIT') {
      if (categories.data_types) extractUnit(el, arPath, model);
    } else if (el.tag === 'CONSTANT-SPECIFICATION') {
      if (categories.data_types) extractConstantSpecification(el, arPath, model);
    } else if (el.tag === 'SW-ADDR-METHOD') {
      if (categories.data_types) extractSwAddrMethod(el, arPath, model);
    } else if (el.tag === 'MODE-SWITCH-INTERFACE') {
      if (categories.port_interfaces) extractMsInterface(el, arPath, model);
    } else if (el.tag === 'NV-DATA-INTERFACE') {
      if (categories.port_interfaces) extractNvDataInterface(el, arPath, model);
    } else if (el.tag === 'PARAMETER-INTERFACE') {
      if (categories.port_interfaces) extractParameterInterface(el, arPath, model);
    } else if (el.tag === 'TRIGGER-INTERFACE') {
      if (categories.port_interfaces) extractTriggerInterface(el, arPath, model);
    } else if (el.tag === 'MODE-DECLARATION-GROUP') {
      if (categories.swc_behavior) extractModeDeclarationGroup(el, arPath, model);
    } else if (el.tag === 'BSW-MODULE-DESCRIPTION') {
      if (categories.bsw_modules) extractBswModuleDescription(el, arPath, model);
    } else if (el.tag === 'BSW-MODULE-ENTRY') {
      if (categories.bsw_modules) extractBswModuleEntry(el, arPath, model);
    }
    // Phase B extraction (gated by categories)
    else if (el.tag === 'ECU-INSTANCE') {
      if (categories.system) extractEcuInstance(el, arPath, model);
    } else if (el.tag === 'CAN-CLUSTER') {
      if (categories.communication) extractCommCluster(el, arPath, 'can_cluster', model);
    } else if (el.tag === 'LIN-CLUSTER') {
      if (categories.communication) extractCommCluster(el, arPath, 'lin_cluster', model);
    } else if (el.tag === 'CAN-FRAME') {
      if (categories.communication) extractCommFrame(el, arPath, 'can_frame', model);
    } else if (el.tag === 'LIN-UNCONDITIONAL-FRAME') {
      if (categories.communication) extractCommFrame(el, arPath, 'lin_frame', model);
    } else if (el.tag === 'I-SIGNAL') {
      if (categories.communication) extractISignal(el, arPath, model);
    } else if (el.tag === 'I-SIGNAL-I-PDU') {
      if (categories.communication) extractISignalIPdu(el, arPath, model);
    } else if (el.tag === 'I-SIGNAL-I-PDU-GROUP') {
      if (categories.communication) extractIPduGroup(el, arPath, model);
    } else if (el.tag === 'SYSTEM-SIGNAL') {
      if (categories.communication) extractSystemSignal(el, arPath, model);
    } else if (el.tag === 'SYSTEM-SIGNAL-GROUP') {
      if (categories.communication) extractSystemSignalGroup(el, arPath, model);
    } else if (el.tag === 'I-SIGNAL-GROUP') {
      if (categories.communication) extractISignalGroup(el, arPath, model);
    } else if (el.tag === 'LIN-SPORADIC-FRAME') {
      if (categories.communication) extractLinSporadicFrame(el, arPath, model);
    } else if (el.tag === 'FLAT-MAP') {
      if (categories.system) extractFlatMap(el, arPath, model);
    }
    // Phase C extraction (gated by categories)
    else if (el.tag === 'ECUC-VALUE-COLLECTION') {
      if (categories.ecuc) extractEcucValueCollection(el, arPath, model);
    } else if (el.tag === 'ECUC-MODULE-CONFIGURATION-VALUES') {
      if (categories.ecuc) extractEcucModuleConfig(el, arPath, model);
    } else {
      // Count skipped element types — reported as a grouped summary after parsing
      model.skippedElements.set(el.tag, (model.skippedElements.get(el.tag) ?? 0) + 1);
    }
  }
}

function extractSwcType(
  el: XmlNode,
  packageArPath: string,
  kind: SwcKind,
  model: ArxmlModel,
  categories: EnabledCategories,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;

  const arPath = packageArPath + '/' + shortName;
  const uuid   = el.attrs['UUID'] ?? '';

  if (!seen.swc.has(arPath)) {
    seen.swc.add(arPath);
    model.swcTypes.push({ uuid, shortName, stablePath: arPath, packageStablePath: packageArPath, kind });
  }

  // ── Ports (gated by ports category) ──
  if (categories.ports) {
    for (const port of child(el, 'PORTS')?.children ?? []) {
      if (port.tag === 'P-PORT-PROTOTYPE') {
        const name   = textOf(port, 'SHORT-NAME');
        const pPath  = arPath + '/' + name;
        if (name && !seen.pPort.has(pPath)) {
          seen.pPort.add(pPath);
          model.pPorts.push({
            uuid: port.attrs['UUID'] ?? '',
            shortName: name,
            stablePath: pPath,
            ownerStablePath: arPath,
            interfaceRef: textOf(port, 'PROVIDED-INTERFACE-TREF'),
          });
        }
      } else if (port.tag === 'R-PORT-PROTOTYPE') {
        const name  = textOf(port, 'SHORT-NAME');
        const rPath = arPath + '/' + name;
        if (name && !seen.rPort.has(rPath)) {
          seen.rPort.add(rPath);
          model.rPorts.push({
            uuid: port.attrs['UUID'] ?? '',
            shortName: name,
            stablePath: rPath,
            ownerStablePath: arPath,
            interfaceRef: textOf(port, 'REQUIRED-INTERFACE-TREF'),
          });
        }
      } else if (port.tag === 'PR-PORT-PROTOTYPE') {
        const name   = textOf(port, 'SHORT-NAME');
        const prPath = arPath + '/' + name;
        if (name && !seen.prPort.has(prPath)) {
          seen.prPort.add(prPath);
          model.prPorts.push({
            uuid: port.attrs['UUID'] ?? '',
            shortName: name,
            stablePath: prPath,
            ownerStablePath: arPath,
            interfaceRef: textOf(port, 'PROVIDED-REQUIRED-INTERFACE-TREF'),
          });
        }
      }
    }
  }

  // ── Internal behaviours (gated by swc_behavior category) ──
  if (categories.swc_behavior) {
    const ibs = child(el, 'INTERNAL-BEHAVIORS');
    for (const ib of children(ibs, 'SWC-INTERNAL-BEHAVIOR')) {
      const name   = textOf(ib, 'SHORT-NAME');
      const ibPath = arPath + '/' + name;
      if (name && !seen.ib.has(ibPath)) {
        seen.ib.add(ibPath);
        model.internalBehaviors.push({
          uuid: ib.attrs['UUID'] ?? '',
          shortName: name,
          stablePath: ibPath,
          swcArPath: arPath,
        });
      }

      // ── Enriched SWC behavior extraction ──

      // Runnable entities
      const runnables = child(ib, 'RUNNABLES');
      for (const re of children(runnables, 'RUNNABLE-ENTITY')) {
        const reName = textOf(re, 'SHORT-NAME');
        const rePath = ibPath + '/' + reName;
        if (reName && !seen.runnable.has(rePath)) {
          seen.runnable.add(rePath);
          model.runnableEntities.push({
            uuid: re.attrs['UUID'] ?? '',
            shortName: reName,
            stablePath: rePath,
            behaviorArPath: ibPath,
            symbol: textOf(re, 'SYMBOL'),
            canBeInvokedConcurrently: textOf(re, 'CAN-BE-INVOKED-CONCURRENTLY'),
            minimumStartInterval: textOf(re, 'MINIMUM-START-INTERVAL'),
          });
        }
      }

      // Events (TIMING-EVENT, INIT-EVENT, DATA-RECEIVED-EVENT, MODE-SWITCH-EVENT)
      const eventsNode = child(ib, 'EVENTS');
      const eventKindMap: Record<string, string> = {
        'TIMING-EVENT': 'timing_event',
        'INIT-EVENT': 'init_event',
        'DATA-RECEIVED-EVENT': 'data_received_event',
        'MODE-SWITCH-EVENT': 'mode_switch_event',
      };
      for (const ev of eventsNode?.children ?? []) {
        const kind = eventKindMap[ev.tag];
        if (!kind) continue;
        const evName = textOf(ev, 'SHORT-NAME');
        const evPath = ibPath + '/' + evName;
        if (evName && !seen.event.has(evPath)) {
          seen.event.add(evPath);
          model.events.push({
            uuid: ev.attrs['UUID'] ?? '',
            shortName: evName,
            stablePath: evPath,
            behaviorArPath: ibPath,
            kind,
            period: textOf(ev, 'PERIOD'),
            startOnEventRef: textOf(ev, 'START-ON-EVENT-REF'),
          });
        }
      }

      // Exclusive areas
      const exclAreas = child(ib, 'EXCLUSIVE-AREAS');
      for (const ea of children(exclAreas, 'EXCLUSIVE-AREA')) {
        const eaName = textOf(ea, 'SHORT-NAME');
        const eaPath = ibPath + '/' + eaName;
        if (eaName && !seen.exclArea.has(eaPath)) {
          seen.exclArea.add(eaPath);
          model.exclusiveAreas.push({
            uuid: ea.attrs['UUID'] ?? '',
            shortName: eaName,
            stablePath: eaPath,
            behaviorArPath: ibPath,
          });
        }
      }

      // Per-instance memories (AR-TYPED-PER-INSTANCE-MEMORYS > VARIABLE-DATA-PROTOTYPE)
      const pims = child(ib, 'AR-TYPED-PER-INSTANCE-MEMORYS');
      for (const pim of children(pims, 'VARIABLE-DATA-PROTOTYPE')) {
        const pimName = textOf(pim, 'SHORT-NAME');
        const pimPath = ibPath + '/' + pimName;
        if (pimName && !seen.pim.has(pimPath)) {
          seen.pim.add(pimPath);
          model.perInstanceMemories.push({
            uuid: pim.attrs['UUID'] ?? '',
            shortName: pimName,
            stablePath: pimPath,
            behaviorArPath: ibPath,
          });
        }
      }
    }
  }

  // ── SW-Component prototypes (compositions) — always extracted when swc_types is enabled ──
  const comps = child(el, 'COMPONENTS');
  for (const comp of children(comps, 'SW-COMPONENT-PROTOTYPE')) {
    const name     = textOf(comp, 'SHORT-NAME');
    const compPath = arPath + '/' + name;
    if (name && !seen.proto.has(compPath)) {
      seen.proto.add(compPath);
      model.swcPrototypes.push({
        uuid: comp.attrs['UUID'] ?? '',
        shortName: name,
        stablePath: compPath,
        compositionArPath: arPath,
        typeRef: textOf(comp, 'TYPE-TREF'),
      });
    }
  }

  // ── Connectors (compositions, gated by connectors category) ──
  if (categories.connectors) {
    for (const conn of child(el, 'CONNECTORS')?.children ?? []) {
      const name = textOf(conn, 'SHORT-NAME');
      if (!name) continue;
      const cPath = arPath + '/' + name;

      if (conn.tag === 'ASSEMBLY-SW-CONNECTOR' && !seen.assembly.has(cPath)) {
        seen.assembly.add(cPath);
        const provIref = child(conn, 'PROVIDER-IREF');
        const reqIref  = child(conn, 'REQUESTER-IREF');
        model.assemblyConnectors.push({
          uuid: conn.attrs['UUID'] ?? '',
          shortName: name,
          stablePath: cPath,
          compositionArPath: arPath,
          providerPortRef:  textOf(provIref, 'TARGET-P-PORT-REF'),
          requesterPortRef: textOf(reqIref,  'TARGET-R-PORT-REF'),
        });

      } else if (conn.tag === 'DELEGATION-SW-CONNECTOR' && !seen.delegation.has(cPath)) {
        seen.delegation.add(cPath);
        const innerIref = child(conn, 'INNER-PORT-IREF');
        // Inner iref child is either R-PORT-IN-COMPOSITION-INSTANCE-REF or P-PORT-IN-...
        const innerEl = innerIref?.children[0];
        const innerPortRef =
          textOf(innerEl, 'TARGET-R-PORT-REF') ||
          textOf(innerEl, 'TARGET-P-PORT-REF');
        model.delegationConnectors.push({
          uuid: conn.attrs['UUID'] ?? '',
          shortName: name,
          stablePath: cPath,
          compositionArPath: arPath,
          innerPortRef,
          outerPortRef: textOf(conn, 'OUTER-PORT-REF'),
        });
      }
    }
  }
}

// ── Phase A extraction functions ───────────────────────────────────────────────

function extractImplDataType(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.implDataType.has(arPath)) return;
  seen.implDataType.add(arPath);
  model.implDataTypes.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    category: textOf(el, 'CATEGORY'),
  });
  // SUB-ELEMENTS children
  const subEls = child(el, 'SUB-ELEMENTS');
  for (const se of children(subEls, 'IMPLEMENTATION-DATA-TYPE-ELEMENT')) {
    const seName = textOf(se, 'SHORT-NAME');
    const sePath = arPath + '/' + seName;
    if (seName && !seen.implDataTypeEl.has(sePath)) {
      seen.implDataTypeEl.add(sePath);
      model.implDataTypeElements.push({
        uuid: se.attrs['UUID'] ?? '', shortName: seName, stablePath: sePath,
        parentStablePath: arPath,
        typeRef: textOf(child(se, 'SW-DATA-DEF-PROPS-VARIANTS')?.children[0], 'IMPLEMENTATION-DATA-TYPE-REF')
          || textOf(se, 'TYPE-TREF'),
      });
    }
  }
}

function extractSwBaseType(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.swBaseType.has(arPath)) return;
  seen.swBaseType.add(arPath);
  model.swBaseTypes.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    baseTypeSize: textOf(el, 'BASE-TYPE-SIZE'),
    baseTypeEncoding: textOf(el, 'BASE-TYPE-ENCODING'),
  });
}

function extractCompuMethod(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.compuMethod.has(arPath)) return;
  seen.compuMethod.add(arPath);
  model.compuMethods.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    category: textOf(el, 'CATEGORY'),
  });
}

function extractDataConstr(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.dataConstr.has(arPath)) return;
  seen.dataConstr.add(arPath);
  model.dataConstrs.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractModeDeclarationGroup(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.modeDecGroup.has(arPath)) return;
  seen.modeDecGroup.add(arPath);
  model.modeDeclarationGroups.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    category: textOf(el, 'CATEGORY'),
  });
}

function extractMsInterface(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.msIf.has(arPath)) return;
  seen.msIf.add(arPath);
  const modeGroup = child(el, 'MODE-GROUP');
  model.msInterfaces.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    modeGroupRef: textOf(modeGroup, 'TYPE-TREF'),
  });
}

function extractNvDataInterface(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.nvDataIf.has(arPath)) return;
  seen.nvDataIf.add(arPath);
  model.nvDataInterfaces.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractParameterInterface(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.paramIf.has(arPath)) return;
  seen.paramIf.add(arPath);
  model.parameterInterfaces.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractTriggerInterface(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.triggerIf.has(arPath)) return;
  seen.triggerIf.add(arPath);
  model.triggerInterfaces.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractDataTypeMappingSet(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.dtMappingSet.has(arPath)) return;
  seen.dtMappingSet.add(arPath);
  model.dataTypeMappingSets.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractAppDataType(
  el: XmlNode, packageArPath: string,
  kind: 'app_primitive_data_type' | 'app_record_data_type' | 'app_array_data_type',
  model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.appDataType.has(arPath)) return;
  seen.appDataType.add(arPath);
  model.appDataTypes.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath, kind,
  });
}

function extractUnit(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.unit.has(arPath)) return;
  seen.unit.add(arPath);
  model.units.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    displayName: textOf(el, 'DISPLAY-NAME'),
  });
}

// ── BSW extraction functions ──────────────────────────────────────────────────

function extractBswModuleDescription(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  const uuid = el.attrs['UUID'] ?? '';

  if (!seen.bswModDesc.has(arPath)) {
    seen.bswModDesc.add(arPath);
    model.bswModuleDescriptions.push({ uuid, shortName, stablePath: arPath, packageStablePath: packageArPath });
  }

  // BSW-INTERNAL-BEHAVIOR children inside INTERNAL-BEHAVIORS
  const ibs = child(el, 'INTERNAL-BEHAVIORS');
  for (const ib of children(ibs, 'BSW-INTERNAL-BEHAVIOR')) {
    const ibName = textOf(ib, 'SHORT-NAME');
    const ibPath = arPath + '/' + ibName;
    if (ibName && !seen.bswIb.has(ibPath)) {
      seen.bswIb.add(ibPath);
      model.bswInternalBehaviors.push({
        uuid: ib.attrs['UUID'] ?? '',
        shortName: ibName,
        stablePath: ibPath,
        moduleArPath: arPath,
      });
    }

    // Exclusive areas (reuse same model array as SWC exclusive areas)
    const exclAreas = child(ib, 'EXCLUSIVE-AREAS');
    for (const ea of children(exclAreas, 'EXCLUSIVE-AREA')) {
      const eaName = textOf(ea, 'SHORT-NAME');
      const eaPath = ibPath + '/' + eaName;
      if (eaName && !seen.exclArea.has(eaPath)) {
        seen.exclArea.add(eaPath);
        model.exclusiveAreas.push({
          uuid: ea.attrs['UUID'] ?? '',
          shortName: eaName,
          stablePath: eaPath,
          behaviorArPath: ibPath,
        });
      }
    }

    // BSW entities: BSW-SCHEDULABLE-ENTITY and BSW-CALLED-ENTITY from ENTITYS
    const entitys = child(ib, 'ENTITYS');
    const bswEntityKindMap: Record<string, 'schedulable' | 'called'> = {
      'BSW-SCHEDULABLE-ENTITY': 'schedulable',
      'BSW-CALLED-ENTITY': 'called',
    };
    for (const ent of entitys?.children ?? []) {
      const kind = bswEntityKindMap[ent.tag];
      if (!kind) continue;
      const entName = textOf(ent, 'SHORT-NAME');
      const entPath = ibPath + '/' + entName;
      if (entName && !seen.bswEntity.has(entPath)) {
        seen.bswEntity.add(entPath);
        model.bswEntities.push({
          uuid: ent.attrs['UUID'] ?? '',
          shortName: entName,
          stablePath: entPath,
          behaviorArPath: ibPath,
          implementedEntryRef: textOf(ent, 'IMPLEMENTED-ENTRY-REF'),
        });
      }
    }
  }
}

function extractBswModuleEntry(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.bswEntry.has(arPath)) return;
  seen.bswEntry.add(arPath);
  model.bswModuleEntries.push({
    uuid: el.attrs['UUID'] ?? '',
    shortName,
    stablePath: arPath,
    packageStablePath: packageArPath,
    callType: textOf(el, 'CALL-TYPE'),
    executionContext: textOf(el, 'EXECUTION-CONTEXT'),
  });
}

// ── Phase B extraction functions ──────────────────────────────────────────────

function extractEcuInstance(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.ecuInstance.has(arPath)) return;
  seen.ecuInstance.add(arPath);
  model.ecuInstances.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractCommCluster(
  el: XmlNode, packageArPath: string,
  kind: 'can_cluster' | 'lin_cluster', model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.commCluster.has(arPath)) return;
  seen.commCluster.add(arPath);
  model.commClusters.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath, kind,
  });
}

function extractCommFrame(
  el: XmlNode, packageArPath: string,
  kind: 'can_frame' | 'lin_frame', model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.commFrame.has(arPath)) return;
  seen.commFrame.add(arPath);
  model.commFrames.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath, kind,
  });
}

function extractISignal(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.iSignal.has(arPath)) return;
  seen.iSignal.add(arPath);
  model.iSignals.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractISignalIPdu(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.iSignalIPdu.has(arPath)) return;
  seen.iSignalIPdu.add(arPath);
  model.iSignalIPdus.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractIPduGroup(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.iPduGroup.has(arPath)) return;
  seen.iPduGroup.add(arPath);
  model.iPduGroups.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractSystemSignal(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.systemSignal.has(arPath)) return;
  seen.systemSignal.add(arPath);
  model.systemSignals.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractSystemSignalGroup(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.systemSignalGroup.has(arPath)) return;
  seen.systemSignalGroup.add(arPath);
  model.systemSignalGroups.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractISignalGroup(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.iSignalGroup.has(arPath)) return;
  seen.iSignalGroup.add(arPath);
  model.iSignalGroups.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractLinSporadicFrame(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.linSporadicFrame.has(arPath)) return;
  seen.linSporadicFrame.add(arPath);
  model.linSporadicFrames.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractConstantSpecification(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.constantSpec.has(arPath)) return;
  seen.constantSpec.add(arPath);
  model.constantSpecifications.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractSwAddrMethod(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.swAddrMethod.has(arPath)) return;
  seen.swAddrMethod.add(arPath);
  model.swAddrMethods.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractFlatMap(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.flatMap.has(arPath)) return;
  seen.flatMap.add(arPath);
  model.flatMaps.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });

  // FLAT-INSTANCE-DESCRIPTOR children inside INSTANCES
  const instances = child(el, 'INSTANCES');
  for (const fid of children(instances, 'FLAT-INSTANCE-DESCRIPTOR')) {
    const fidName = textOf(fid, 'SHORT-NAME');
    const fidPath = arPath + '/' + fidName;
    if (fidName && !seen.flatInstanceDesc.has(fidPath)) {
      seen.flatInstanceDesc.add(fidPath);
      model.flatInstanceDescriptors.push({
        uuid: fid.attrs['UUID'] ?? '',
        shortName: fidName,
        stablePath: fidPath,
        flatMapArPath: arPath,
      });
    }
  }
}

// ── Phase C extraction functions ──────────────────────────────────────────────

function extractEcucValueCollection(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.ecucValueCollection.has(arPath)) return;
  seen.ecucValueCollection.add(arPath);
  model.ecucValueCollections.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
  });
}

function extractEcucModuleConfig(el: XmlNode, packageArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = packageArPath + '/' + shortName;
  if (seen.ecucModuleConfig.has(arPath)) return;
  seen.ecucModuleConfig.add(arPath);
  model.ecucModuleConfigs.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, packageStablePath: packageArPath,
    definitionRef: textOf(el, 'DEFINITION-REF'),
  });

  // Extract ECUC-CONTAINER-VALUE children from CONTAINERS
  const containers = child(el, 'CONTAINERS');
  for (const cv of children(containers, 'ECUC-CONTAINER-VALUE')) {
    extractEcucContainerValue(cv, arPath, model);
  }
}

function extractEcucContainerValue(el: XmlNode, parentArPath: string, model: ArxmlModel): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;
  const arPath = parentArPath + '/' + shortName;
  if (seen.ecucContainerValue.has(arPath)) return;
  seen.ecucContainerValue.add(arPath);
  model.ecucContainerValues.push({
    uuid: el.attrs['UUID'] ?? '', shortName, stablePath: arPath, parentStablePath: parentArPath,
    definitionRef: textOf(el, 'DEFINITION-REF'),
  });

  // Recursively extract SUB-CONTAINERS > ECUC-CONTAINER-VALUE
  const subContainers = child(el, 'SUB-CONTAINERS');
  for (const sub of children(subContainers, 'ECUC-CONTAINER-VALUE')) {
    extractEcucContainerValue(sub, arPath, model);
  }
}

// ── Existing extraction functions ─────────────────────────────────────────────

function extractSrInterface(
  el: XmlNode,
  packageArPath: string,
  model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;

  const arPath = packageArPath + '/' + shortName;
  const uuid   = el.attrs['UUID'] ?? '';

  if (!seen.srIf.has(arPath)) {
    seen.srIf.add(arPath);
    model.srInterfaces.push({ uuid, shortName, stablePath: arPath, packageStablePath: packageArPath });
  }

  // Data elements (always re-parse to handle multi-file declarations)
  const des = child(el, 'DATA-ELEMENTS');
  for (const de of children(des, 'VARIABLE-DATA-PROTOTYPE')) {
    const name  = textOf(de, 'SHORT-NAME');
    const dPath = arPath + '/' + name;
    if (name && !seen.dataEl.has(dPath)) {
      seen.dataEl.add(dPath);
      model.dataElements.push({
        uuid: de.attrs['UUID'] ?? '',
        shortName: name,
        stablePath: dPath,
        interfaceArPath: arPath,
      });
    }
  }
}

function extractCsInterface(
  el: XmlNode,
  packageArPath: string,
  model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;

  const arPath = packageArPath + '/' + shortName;
  const uuid   = el.attrs['UUID'] ?? '';

  if (!seen.csIf.has(arPath)) {
    seen.csIf.add(arPath);
    model.csInterfaces.push({ uuid, shortName, stablePath: arPath, packageStablePath: packageArPath });
  }

  const ops = child(el, 'OPERATIONS');
  for (const op of children(ops, 'CLIENT-SERVER-OPERATION')) {
    const name  = textOf(op, 'SHORT-NAME');
    const oPath = arPath + '/' + name;
    if (name && !seen.op.has(oPath)) {
      seen.op.add(oPath);
      model.operations.push({
        uuid: op.attrs['UUID'] ?? '',
        shortName: name,
        stablePath: oPath,
        interfaceArPath: arPath,
      });
    }
  }
}

function extractImplementation(
  el: XmlNode,
  packageArPath: string,
  model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;

  const arPath = packageArPath + '/' + shortName;
  if (seen.impl.has(arPath)) return;
  seen.impl.add(arPath);

  model.implementations.push({
    uuid: el.attrs['UUID'] ?? '',
    shortName,
    stablePath: arPath,
    packageStablePath: packageArPath,
    behaviorRef: textOf(el, 'BEHAVIOR-REF'),
  });
}

function extractSystem(
  el: XmlNode,
  packageArPath: string,
  model: ArxmlModel,
): void {
  const shortName = textOf(el, 'SHORT-NAME');
  if (!shortName) return;

  const arPath = packageArPath + '/' + shortName;
  if (!seen.system.has(arPath)) {
    seen.system.add(arPath);
    model.systems.push({
      uuid: el.attrs['UUID'] ?? '',
      shortName,
      stablePath: arPath,
      packageStablePath: packageArPath,
    });
  }

  const rootCompsEl = child(el, 'ROOT-SOFTWARE-COMPOSITIONS');
  for (const rsc of children(rootCompsEl, 'ROOT-SW-COMPOSITION-PROTOTYPE')) {
    const name    = textOf(rsc, 'SHORT-NAME');
    const rscPath = arPath + '/' + name;
    if (name && !seen.rootComp.has(rscPath)) {
      seen.rootComp.add(rscPath);
      model.rootCompositions.push({
        uuid: rsc.attrs['UUID'] ?? '',
        shortName: name,
        stablePath: rscPath,
        systemArPath: arPath,
        softwareCompositionRef: textOf(rsc, 'SOFTWARE-COMPOSITION-TREF'),
      });
    }
  }

  // SENDER-RECEIVER-TO-SIGNAL-MAPPING inside MAPPINGS > SYSTEM-MAPPING > DATA-MAPPINGS
  const mappingsEl = child(el, 'MAPPINGS');
  for (const sysMapping of children(mappingsEl, 'SYSTEM-MAPPING')) {
    const dataMappings = child(sysMapping, 'DATA-MAPPINGS');
    for (const srMap of children(dataMappings, 'SENDER-RECEIVER-TO-SIGNAL-MAPPING')) {
      const mapName = textOf(srMap, 'SHORT-NAME');
      const mapPath = arPath + '/' + mapName;
      if (mapName && !seen.srToSignalMapping.has(mapPath)) {
        seen.srToSignalMapping.add(mapPath);
        const dataElementIref = child(srMap, 'DATA-ELEMENT-IREF');
        model.srToSignalMappings.push({
          uuid: srMap.attrs['UUID'] ?? '',
          shortName: mapName,
          stablePath: mapPath,
          systemArPath: arPath,
          signalRef: textOf(srMap, 'SYSTEM-SIGNAL-REF'),
          dataElementRef: textOf(dataElementIref, 'TARGET-DATA-PROTOTYPE-REF'),
        });
      }
    }
  }
}

// ── File collection ───────────────────────────────────────────────────────────

function collectArxmlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectArxmlFiles(full));
    } else if (extname(entry).toLowerCase() === '.arxml') {
      results.push(full);
    }
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Reset deduplication state (needed if calling parseArxmlProject more than once). */
function resetSeen(): void {
  for (const s of Object.values(seen)) s.clear();
}

/**
 * Detect and log the AUTOSAR schema version from the root element attributes.
 * Checks `xmlns` for R4.0 conformance and `xsi:schemaLocation` for XSD version.
 */
function detectSchemaVersion(root: XmlNode, file: string): void {
  const xmlns = root.attrs['xmlns'] ?? '';
  const schemaLocation = root.attrs['xsi:schemaLocation'] ?? '';

  // Check for non-R4.0 schema
  if (xmlns && !xmlns.includes('r4.0')) {
    console.warn(`[parser] WARNING: Non-R4.0 schema detected in ${file} (xmlns="${xmlns}"). Attempting best-effort parsing.`);
  }

  // Detect XSD version from schemaLocation (e.g. "http://autosar.org/schema/r4.0 AUTOSAR_00048.xsd")
  if (schemaLocation) {
    const xsdMatch = schemaLocation.match(/AUTOSAR[_\-]?([\w.\-]+)\.xsd/i);
    if (xsdMatch) {
      console.log(`[parser] Schema version detected: ${xsdMatch[0]} in ${file}`);
    }
  }
}

/**
 * Parse all .arxml files under `exampleDir` and return a unified ArxmlModel.
 * Safe to call multiple times (dedup state is reset on each invocation).
 *
 * If `fileList` is provided, those files are used directly instead of
 * recursively discovering .arxml files in `exampleDir`.
 */
export function parseArxmlProject(
  exampleDir: string,
  categories: EnabledCategories = DEFAULT_ENABLED_CATEGORIES,
  fileList?: string[],
): ArxmlModel {
  resetSeen();

  const model: ArxmlModel = {
    packages: [], swcTypes: [], pPorts: [], rPorts: [],
    srInterfaces: [], csInterfaces: [], dataElements: [], operations: [],
    swcPrototypes: [], internalBehaviors: [], implementations: [],
    assemblyConnectors: [], delegationConnectors: [],
    systems: [], rootCompositions: [],
    implDataTypes: [], implDataTypeElements: [], swBaseTypes: [],
    compuMethods: [], dataConstrs: [], modeDeclarationGroups: [],
    msInterfaces: [], nvDataInterfaces: [], parameterInterfaces: [],
    triggerInterfaces: [], dataTypeMappingSets: [],
    runnableEntities: [], events: [], exclusiveAreas: [],
    perInstanceMemories: [], bswModuleDescriptions: [],
    bswInternalBehaviors: [], bswModuleEntries: [], bswEntities: [],
    appDataTypes: [], units: [], prPorts: [],
    // Phase B
    ecuInstances: [], commClusters: [], commFrames: [],
    iSignals: [], iSignalIPdus: [], iPduGroups: [],
    systemSignals: [], systemSignalGroups: [], iSignalGroups: [],
    srToSignalMappings: [], flatMaps: [], flatInstanceDescriptors: [],
    linSporadicFrames: [], constantSpecifications: [],
    swAddrMethods: [],
    // Phase C
    ecucValueCollections: [], ecucModuleConfigs: [], ecucContainerValues: [],
    skippedElements: new Map(),
    descriptions: new Map(),
  };

  // Use provided file list or discover files from directory
  let files: string[];
  if (fileList && fileList.length > 0) {
    // Filter to only .arxml files, warn about non-ARXML files
    files = [];
    for (const f of fileList) {
      if (extname(f).toLowerCase() === '.arxml') {
        if (existsSync(f)) {
          files.push(f);
        } else {
          console.warn(`[parser] File not found, skipping: ${f}`);
        }
      } else {
        console.warn(`[parser] Skipping non-ARXML file: ${f}`);
      }
    }
    console.log(`[parser] Processing ${files.length} .arxml file(s) from provided file list`);
  } else {
    files = collectArxmlFiles(exampleDir);
    console.log(`[parser] Scanning ${files.length} .arxml file(s) in ${exampleDir}`);
  }

  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    const tree   = parseXml(source);
    if (!tree) {
      console.warn(`[parser] Could not parse ${file}`);
      continue;
    }

    // Detect and log schema version from AUTOSAR root element
    if (tree.tag === 'AUTOSAR') {
      detectSchemaVersion(tree, file);
    }

    // Root element is <AUTOSAR>, its direct child is <AR-PACKAGES>
    const arPackages = child(tree, 'AR-PACKAGES');
    if (!arPackages) continue;

    // Separate from element deduplication: a later split declaration may supply DESC.
    collectDescriptions(arPackages, '', model.descriptions!);

    for (const pkg of children(arPackages, 'AR-PACKAGE')) {
      extractPackage(pkg, null, model, categories);
    }
  }

  return model;
}
