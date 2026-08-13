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
 * spike.ts — Langium SysML v2 with SysIDE Legacy grammar
 *
 * Validates the grammar against tiger.sysml and extracts elements + connections.
 *
 * Grammar: sysml-2ls-grammar/ (SysIDE Legacy, MIT licence — sensmetry/sysml-2ls)
 * Patches applied:
 *   - NewExpression: 'new Type()' constructor expression support
 *   - RefPrefix: 'constant' keyword support
 *
 * Run:  pnpm dev
 *
 * Test suite: to be added — pointing at the OMG SysML v2 Release corpus
 *   (github.com/Systems-Modeling/SysML-v2-Release, sysml/src/ directory)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createSysmlSubsetServices } from './sysml-module.js';
import type { Namespace } from './generated/ast.js';
import {
  isPackage, isPartDefinition, isPortDefinition, isItemDefinition,
  isAttributeDefinition, isEnumerationDefinition, isActionDefinition,
  isStateDefinition, isInterfaceDefinition, isRequirementDefinition,
  isConstraintDefinition, isConnectionDefinition, isFlowConnectionDefinition,
  isUseCaseDefinition, isViewDefinition, isViewpointDefinition,
  isPartUsage, isPortUsage, isItemUsage, isAttributeUsage, isActionUsage,
  isStateUsage, isExhibitStateUsage, isConnectionUsage, isInterfaceUsage,
  isFlowConnectionUsage, isRequirementUsage, isMetadataDefinition,
  isOwningMembership, isElement, isNamespace, isDefinition, isUsage,
  isLibraryPackage,
} from './generated/ast.js';
import type {
  Element, OwningMembership, Import, Membership,
} from './generated/ast.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const TIGER_PATH = path.resolve(__dirname, '../../../qualification/ref-project/2-sys-design/tiger.sysml');

// ── Stable path derivation ────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.trim().replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function qualToPath(segments: string[]): string {
  return '/' + segments.map(sanitize).filter(Boolean).join('/');
}

function getElementName(el: Element): string | undefined {
  return el.declaredName ?? el.declaredShortName;
}

// ── Extraction state ──────────────────────────────────────────────────────────

interface Ex {
  kind: string;
  name: string;
  qualifiedName: string;
  stablePath: string;
  superTypes: string[];
}

interface Conn {
  kind: string;
  sourceQName: string;
  targetQName: string;
  ownerQName: string;
}

const elements: Ex[] = [];
const connections: Conn[] = [];
const skipped = new Map<string, number>();

function conceptOf(el: Element): string {
  if (isPackage(el) || isLibraryPackage(el)) return 'package';
  if (isPartDefinition(el)) return 'part_definition';
  if (isPortDefinition(el)) return 'port_definition';
  if (isItemDefinition(el)) return 'item_definition';
  if (isAttributeDefinition(el)) return 'attribute_definition';
  if (isEnumerationDefinition(el)) return 'enumeration_definition';
  if (isActionDefinition(el)) return 'action_definition';
  if (isStateDefinition(el)) return 'state_definition';
  if (isInterfaceDef(el)) return 'interface_definition';
  if (isRequirementDefinition(el)) return 'requirement_definition';
  if (isConstraintDefinition(el)) return 'constraint_definition';
  if (isConnectionDefinition(el)) return 'connection_definition';
  if (isFlowConnectionDefinition(el)) return 'flow_connection_definition';
  if (isUseCaseDefinition(el)) return 'use_case_definition';
  if (isViewDefinition(el)) return 'view_definition';
  if (isViewpointDefinition(el)) return 'viewpoint_definition';
  if (isMetadataDefinition(el)) return 'metadata_definition';
  if (isExhibitStateUsage(el)) return 'exhibit_state_usage';
  if (isPartUsage(el)) return 'part_usage';
  if (isPortUsage(el)) return 'port_usage';
  if (isItemUsage(el)) return 'item_usage';
  if (isAttributeUsage(el)) return 'attribute_usage';
  if (isActionUsage(el)) return 'action_usage';
  if (isStateUsage(el)) return 'state_usage';
  if (isConnectionUsage(el)) return 'connection_usage';
  if (isInterfaceUsage(el)) return 'interface_usage';
  if (isFlowConnectionUsage(el)) return 'flow_connection_usage';
  if (isRequirementUsage(el)) return 'requirement_usage';
  if (isDefinition(el)) return 'definition';
  if (isUsage(el)) return 'usage';
  if (isNamespace(el)) return 'namespace';
  return el.$type ?? 'unknown';
}

// Helper since isInterfaceDefinition may not exist directly
function isInterfaceDef(el: Element): boolean {
  return el.$type === 'InterfaceDefinition';
}

function getSuperTypes(el: Element): string[] {
  if (!isNamespace(el)) return [];
  const ns = el as Namespace;
  // heritage contains Subclassification/FeatureTyping — get target element names
  return (ns.heritage ?? []).flatMap(h => {
    const rel = h as { target?: Element; general?: Element };
    const target = rel.target ?? rel.general;
    if (target && isElement(target)) {
      const name = getElementName(target);
      return name ? [name] : [];
    }
    return [];
  });
}

function walkNamespace(ns: Namespace, pathSegments: string[]): void {
  for (const child of ns.children ?? []) {
    // child is Import | Membership
    if (isOwningMembership(child)) {
      const om = child as OwningMembership;
      // The owned element is in the relationship's elements array or target
      const rel = om as unknown as { elements?: Element[]; target?: Element };
      const owned = rel.elements?.[0] ?? rel.target;
      if (owned && isElement(owned)) {
        processElement(owned as Element, pathSegments);
      }
    }
  }
}

function processElement(el: Element, parentSegments: string[]): void {
  const name = getElementName(el);
  if (!name) {
    // Anonymous — skip but count
    const t = el.$type ?? 'unknown';
    skipped.set(t, (skipped.get(t) ?? 0) + 1);
    // Still recurse into namespaces
    if (isNamespace(el)) {
      walkNamespace(el as Namespace, parentSegments);
    }
    return;
  }

  const segments = [...parentSegments, name];
  const qualifiedName = segments.join('::');
  const stablePath = qualToPath(segments);
  const concept = conceptOf(el);
  const superTypes = getSuperTypes(el);

  elements.push({ kind: concept, name, qualifiedName, stablePath, superTypes });

  // Recurse into namespaces (packages, definitions, usages that contain members)
  if (isNamespace(el)) {
    walkNamespace(el as Namespace, segments);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🔬 Langium SysML v2 — SysIDE Legacy Grammar\n');
  console.log(`Target: ${path.relative(process.cwd(), TIGER_PATH)}\n`);

  const source = fs.readFileSync(TIGER_PATH, 'utf-8');
  const services = createSysmlSubsetServices(EmptyFileSystem);
  const parse = parseHelper<Namespace>(services.SysmlSubset);

  const t0 = Date.now();
  const document = await parse(source, { validation: false });
  const ms = Date.now() - t0;

  const lexErr = document.parseResult.lexerErrors;
  const parseErr = document.parseResult.parserErrors;

  console.log(`Parse time:    ${ms}ms`);
  console.log(`Lexer errors:  ${lexErr.length}`);
  console.log(`Parser errors: ${parseErr.length}`);

  if (parseErr.length > 0) {
    console.log('\n⚠️  First 10 parser errors:');
    for (const e of parseErr.slice(0, 10)) {
      console.log(`  line ${e.token?.startLine ?? '?'}: ${e.message?.slice(0, 100)}`);
    }
  }

  // The root is a Namespace containing all top-level members
  walkNamespace(document.parseResult.value, []);

  console.log(`\nElements:    ${elements.length}`);
  console.log(`Connections: ${connections.length}`);
  if (skipped.size > 0) {
    const top = [...skipped.entries()].sort((a,b) => b[1]-a[1]).slice(0,8);
    console.log(`Skipped:     ${top.map(([k,v]) => `${k}(${v})`).join(', ')}`);
  }

  // ── Print by kind ─────────────────────────────────────────────────────────
  console.log('\n=== ELEMENTS BY KIND ===\n');
  const byKind = new Map<string, Ex[]>();
  for (const el of elements) {
    if (!byKind.has(el.kind)) byKind.set(el.kind, []);
    byKind.get(el.kind)!.push(el);
  }
  for (const [kind, els] of [...byKind.entries()].sort()) {
    console.log(`${kind} × ${els.length}`);
    for (const el of els) {
      const st = el.superTypes.length > 0 ? ` :> ${el.superTypes.join(', ')}` : '';
      console.log(`    ${el.stablePath}${st}`);
    }
  }

  // ── Assertions ────────────────────────────────────────────────────────────
  console.log('\n=== ASSERTIONS ===\n');
  const assert = (label: string, ok: boolean) => console.log(`  ${ok ? '✅' : '❌'} ${label}`);

  const pkg = elements.find(e => e.kind === 'package');
  assert('Package TigerDetectionSystemExample found', pkg?.name === 'TigerDetectionSystemExample');

  const percDef = elements.find(e => e.name === 'PerceptionSystem' && e.kind === 'part_definition');
  assert('PartDef PerceptionSystem found', percDef !== undefined);
  assert('PerceptionSystem stable path correct',
    percDef?.stablePath === '/TigerDetectionSystemExample/PerceptionSystem');

  const percUsage = elements.find(e => e.name === 'perception' && e.kind === 'part_usage');
  assert('"perception" part_usage found', percUsage !== undefined);

  const portDefs = byKind.get('port_definition') ?? [];
  assert('Port definitions extracted (≥4)', portDefs.length >= 4);

  const itemDefs = byKind.get('item_definition') ?? [];
  assert('Item definitions extracted (≥3)', itemDefs.length >= 3);

  const exhibits = byKind.get('exhibit_state_usage') ?? [];
  assert('ExhibitState nodes found (≥3)', exhibits.length >= 3);

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log('');
  if (parseErr.length === 0 && lexErr.length === 0) {
    console.log('✅ VERDICT: SysIDE grammar parses tiger.sysml with ZERO errors.\n');
  } else {
    console.log(`⚠️  VERDICT: ${parseErr.length} parser errors, ${lexErr.length} lexer errors.\n`);
  }
}

main().catch(console.error);
