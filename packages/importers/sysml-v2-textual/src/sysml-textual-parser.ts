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
  /** Names of supertypes (declaredName only — no cross-file resolution yet) */
  superTypeNames: string[];
  /** File the element was defined in */
  sourceFile: string;
}

export interface SysmlTextualModel {
  elements: SysmlTextualElementInfo[];
  skippedElements: Map<string, number>;
  diagnostics: ImportDiagnostic[];
}

// ── Concept mapping ───────────────────────────────────────────────────────────

type ElementCategory = 'structure' | 'behavior' | 'features' | 'memberships' | 'imports';

function conceptAndCategory(el: Element): { concept: string; category: ElementCategory } | null {
  if (isPackage(el) || isLibraryPackage(el)) return { concept: 'package', category: 'structure' };
  if (isPartDefinition(el))         return { concept: 'part_definition',             category: 'structure' };
  if (isPortDefinition(el))         return { concept: 'port_definition',             category: 'structure' };
  if (isItemDefinition(el))         return { concept: 'item_definition',             category: 'structure' };
  if (isAttributeDefinition(el))    return { concept: 'attribute_definition',        category: 'structure' };
  if (isEnumerationDefinition(el))  return { concept: 'enumeration_definition',      category: 'structure' };
  if (isConnectionDefinition(el))   return { concept: 'connection_definition',       category: 'structure' };
  if (isInterfaceDefinition(el))    return { concept: 'interface_definition',        category: 'structure' };
  if (isFlowConnectionDefinition(el)) return { concept: 'flow_connection_definition', category: 'structure' };
  if (isMetadataDefinition(el))     return { concept: 'metadata_definition',         category: 'structure' };
  if (isPartUsage(el))              return { concept: 'part_usage',                  category: 'structure' };
  if (isPortUsage(el))              return { concept: 'port_usage',                  category: 'structure' };
  if (isItemUsage(el))              return { concept: 'item_usage',                  category: 'structure' };
  if (isAttributeUsage(el))         return { concept: 'attribute_usage',             category: 'structure' };
  if (isConnectionUsage(el))        return { concept: 'connection_usage',            category: 'structure' };
  if (isInterfaceUsage(el))         return { concept: 'interface_usage',             category: 'structure' };
  if (isFlowConnectionUsage(el))    return { concept: 'flow_connection_usage',       category: 'structure' };
  // Behavior
  if (isActionDefinition(el))       return { concept: 'action_definition',           category: 'behavior' };
  if (isStateDefinition(el))        return { concept: 'state_definition',            category: 'behavior' };
  if (isConstraintDefinition(el))   return { concept: 'constraint_definition',       category: 'behavior' };
  if (isRequirementDefinition(el))  return { concept: 'requirement_definition',      category: 'behavior' };
  if (isUseCaseDefinition(el))      return { concept: 'use_case_definition',         category: 'behavior' };
  if (isViewDefinition(el))         return { concept: 'view_definition',             category: 'behavior' };
  if (isViewpointDefinition(el))    return { concept: 'viewpoint_definition',        category: 'behavior' };
  if (isExhibitStateUsage(el))      return { concept: 'exhibit_state_usage',         category: 'behavior' };
  if (isActionUsage(el))            return { concept: 'action_usage',                category: 'behavior' };
  if (isStateUsage(el))             return { concept: 'state_usage',                 category: 'behavior' };
  if (isRequirementUsage(el))       return { concept: 'requirement_usage',           category: 'behavior' };
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
    const rel = h as { target?: Element; general?: Element };
    const target = rel.target ?? rel.general;
    if (target && isElement(target)) {
      const n = getElementName(target);
      return n ? [n] : [];
    }
    return [];
  });
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

  output.push({
    stablePath,
    name,
    qualifiedName,
    concept: cc.concept,
    sysmlType: el.$type ?? cc.concept,
    isAbstract: (el as { isAbstract?: unknown }).isAbstract === true
                  || (el as { isAbstract?: unknown }).isAbstract === 'abstract',
    superTypeNames,
    sourceFile,
  });

  // Recurse
  if (isNamespace(el)) {
    walkNamespace(el as Namespace, segments, sourceFile, enabled, output, skipped);
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

  return { elements, skippedElements, diagnostics };
}
