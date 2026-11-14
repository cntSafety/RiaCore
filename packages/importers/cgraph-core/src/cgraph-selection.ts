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
 * cgraph-selection.ts — turns element-group switches into a concept/slot set.
 *
 * Two rules, and the second is the one that matters:
 *
 *  1. A group names the concepts it owns. Selecting the group selects them.
 *  2. A slot is imported only when at least one concrete concept in its
 *     expanded domain AND at least one in its expanded range are selected.
 *
 * Rule 2 is why selection is derived rather than configured. `aliases` is a
 * type-layer edge, but `defines` is not — it is a structure-to-symbol edge, and
 * turning off `symbols` has to remove it even though `structure` is still on.
 * Enumerating slots per group by hand would get that wrong the first time a
 * slot's range changed, which is exactly what happened between schema 2.0.0 and
 * 2.1.0 when three access slots widened to `c_referenceable`.
 *
 * The closure is also the reason `c_external_symbol` belongs to the `symbols`
 * group rather than being independently selectable. Since 2.1.0 the access and
 * address-taking slots range over `c_referenceable`, so an out-of-corpus target
 * is a legitimate endpoint for `reads` as much as for `calls_external`. Make it
 * separately deselectable and a quarter of the access edges silently become
 * unknown-endpoint drops.
 */

import {
  CGRAPH_CONCEPTS,
  CGRAPH_SLOTS,
  CGRAPH_SLOT_ENDPOINTS,
  expandConcepts,
  type CgraphConcept,
  type CgraphSlot,
} from './cgraph-schema.js';

export const CGRAPH_ELEMENT_GROUPS = [
  'structure',
  'symbols',
  'call_graph',
  'data_access',
  'types',
  'parameters',
  'members',
  'registration',
  'asm_sites',
  'indirect_calls',
  'value_analysis',
] as const;

export type CgraphElementGroup = typeof CGRAPH_ELEMENT_GROUPS[number];

export type CgraphElementSelection = Record<CgraphElementGroup, boolean>;

/**
 * Defaults: everything on. `types` because it is the change-impact layer;
 * `parameters` and `members` because other enabled layers target them, so
 * switching them off turns complete collections into unknown-endpoint drops.
 */
export const DEFAULT_ELEMENT_SELECTION: CgraphElementSelection = {
  structure: true,
  symbols: true,
  call_graph: true,
  data_access: true,
  types: true,
  // On since 2.6.0, for the reason `members` is on: ports are now endpoints of
  // `binds`, `flows_to` and `dispatches_through`. With parameters off those
  // edges lose their port endpoints as unknown-endpoint drops and
  // reconciliation reports the collections as short.
  parameters: true,
  // On, unlike `parameters`, and the reason is the access layer rather than the
  // node count. Since 2.5.0 `reads` / `writes` / `read_writes` may target a
  // c_member, and `data_access` is on by default — so with members off a real
  // corpus loses those edges to unknown-endpoint drops and reconciliation
  // reports a discrepancy for three collections that are in fact complete.
  // Turn it off together with `data_access`, or accept the drop warnings.
  members: true,
  registration: true,
  asm_sites: true,
  indirect_calls: true,
  value_analysis: true,
};

/** Concepts each group owns. Groups that contribute only slots own none. */
const GROUP_CONCEPTS: Record<CgraphElementGroup, readonly CgraphConcept[]> = {
  structure: ['c_component', 'c_file'],
  // c_external_symbol lives here deliberately — see the module comment.
  symbols: ['c_function', 'c_variable', 'c_external_symbol'],
  call_graph: [],
  data_access: [],
  types: ['c_record', 'c_enum', 'c_typedef', 'c_builtin_type'],
  // The function's ports: parameters in, return value out (c_return, 2.6.0).
  parameters: ['c_parameter', 'c_return'],
  members: ['c_member'],
  registration: [],
  asm_sites: ['c_asm_site'],
  indirect_calls: ['c_indirect_call_site'],
  // c_absolute_region is configured hardware storage that exists in the graph
  // only as a value-analysis access target, so it goes with that layer.
  value_analysis: ['c_absolute_region'],
};

/**
 * Slots each group gates, beyond what endpoint closure already decides.
 *
 * Closure answers "can this slot's endpoints exist"; this answers "did the user
 * ask for this kind of fact". Both must hold. `calls` and `takes_address_of`
 * both run between selected symbols, so without this table `call_graph: false`
 * would have no effect.
 */
const GROUP_SLOTS: Record<CgraphElementGroup, readonly CgraphSlot[]> = {
  structure: ['contains_component', 'owns_file', 'includes'],
  // `declares_external` is the containment parent of a c_external_symbol, and
  // that concept belongs to this group — so it is gated here, next to the
  // `defines` edge it is the complement of.
  symbols: ['defines', 'declares', 'declares_external'],
  // `binds` (2.6.0) is an AST fact about direct call sites: which callee port
  // the caller supplies or uses. Its targets are ports, so it needs
  // `parameters` too; closure cannot tell, because the declared range is
  // c_referenceable.
  call_graph: ['calls', 'calls_external', 'takes_address_of', 'binds'],
  data_access: ['reads', 'writes', 'read_writes'],
  // `declares_type` sits beside `defines_type` for the same reason: the pair is
  // total over named types with a source location, and which of the two a type
  // has is what says whether its members are known.
  types: ['defines_type', 'declares_type', 'has_type', 'returns', 'aliases', 'has_member_type'],
  parameters: ['has_parameter', 'has_return'],
  // `has_member` is the containment parent of a c_member, so it is gated with
  // the group that owns the concept — and closure then drops it when `types` is
  // off, because its domain is c_record. A member with no imported record is a
  // containment orphan, which is the 2.4.0 lesson applied in advance.
  members: ['has_member'],
  registration: ['references', 'registers'],
  asm_sites: ['contains_asm'],
  // The AST half of the indirect-call layer: the site, its containment and the
  // holder the pointer is read from. Always present in 2.6.0 output.
  indirect_calls: ['has_indirect_call_site', 'dispatches_through'],
  // Every value-analysis fact, so switching this group off yields an AST-only
  // graph. `may_dispatch_to` is gated here, not with `indirect_calls`, and
  // closure drops it when `indirect_calls` is off because its domain is the
  // site. Node attributes that are value-analysis facts
  // (`analysis_reached`, `has_contract`, `resolution`) stay on their nodes.
  value_analysis: ['owns_region', 'may_read', 'may_write', 'may_dispatch_to', 'flows_to'],
};

export interface ResolvedSelection {
  concepts: CgraphConcept[];
  slots: CgraphSlot[];
  /** Slots dropped by endpoint closure despite their group being on, with the reason. */
  slotsDroppedByClosure: Array<{ slot: CgraphSlot; missing: string }>;
}

/** Coerce arbitrary stored config into a complete, typed group selection. */
export function normalizeElementSelection(
  raw: Record<string, unknown> | undefined | null,
): CgraphElementSelection {
  const result = { ...DEFAULT_ELEMENT_SELECTION };
  if (!raw || typeof raw !== 'object') return result;
  for (const group of CGRAPH_ELEMENT_GROUPS) {
    const value = raw[group];
    if (typeof value === 'boolean') result[group] = value;
  }
  return result;
}

/** Group switches → the concepts and slots to read, plus what closure removed. */
export function resolveSelection(selection: CgraphElementSelection): ResolvedSelection {
  const concepts = new Set<CgraphConcept>();
  for (const group of CGRAPH_ELEMENT_GROUPS) {
    if (!selection[group]) continue;
    for (const concept of GROUP_CONCEPTS[group]) concepts.add(concept);
  }

  const requestedSlots = new Set<CgraphSlot>();
  for (const group of CGRAPH_ELEMENT_GROUPS) {
    if (!selection[group]) continue;
    for (const slot of GROUP_SLOTS[group]) requestedSlots.add(slot);
  }

  const slots: CgraphSlot[] = [];
  const slotsDroppedByClosure: Array<{ slot: CgraphSlot; missing: string }> = [];

  for (const slot of CGRAPH_SLOTS) {
    if (!requestedSlots.has(slot)) continue;
    const { domain, range } = CGRAPH_SLOT_ENDPOINTS[slot];
    const domainOk = expandConcepts(domain).some((c) => concepts.has(c));
    const rangeOk = expandConcepts(range).some((c) => concepts.has(c));
    if (domainOk && rangeOk) {
      slots.push(slot);
      continue;
    }
    const missing = !domainOk && !rangeOk
      ? `${domain} and ${range}`
      : !domainOk ? domain : range;
    slotsDroppedByClosure.push({ slot, missing });
  }

  return {
    concepts: CGRAPH_CONCEPTS.filter((c) => concepts.has(c)),
    slots,
    slotsDroppedByClosure,
  };
}
