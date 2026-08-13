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
 * Stable identifier utilities for the Persistor.
 *
 * Kuzu node_id / edge_id values are ephemeral SERIAL integers that change
 * every time a namespace is deleted and re-imported.  The Persistor never
 * exports those IDs.  Instead it uses the *stable identifier* — a string
 * value stored inside each concept instance's `attributes` JSON column —
 * to express relationships in a machine-independent way.
 *
 * Each importer defines its own stable-identifier convention via the
 * `identifier: true` field on one attribute in its LinkML schema:
 *   - ARXML:    `stable_path`  (e.g. "/Components/Foo")
 *   - SysML v2: `sysml_id`
 *   - Sphinx-needs: `id`
 *   - TS-symbols: `stable_path`
 *
 * All concept types within a single metamodel share the same identity
 * attribute (declared via a common mixin/abstract base in the LinkML schema).
 * The identity attribute is stored in RIA_META_NodeAttribute with
 * is_identity = true and loaded into nodeKeyAttrs by loadAttributeMetadata.
 */

/**
 * Extracts the stable identifier from a concept instance's `attributes`
 * JSON string.
 *
 * @param attributes      - Raw JSON string stored in the `attributes` column
 * @param stableAttribute - The key whose value is the stable identifier
 * @returns The string value, or `""` if absent, non-string, or parse failure.
 */
export function resolveStableId(attributes: string, stableAttribute: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(attributes) as Record<string, unknown>;
  } catch {
    return '';
  }
  const value = parsed[stableAttribute];
  if (typeof value !== 'string') return '';
  return value;
}

/**
 * Returns a new relationship-instance record with ephemeral node IDs
 * replaced by stable identifiers.  The input record is not mutated.
 */
export function replaceNodeIdsWithStableIds(
  relRecord: Record<string, unknown>,
  sourceStableId: string,
  targetStableId: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { source_node_id, target_node_id, ...rest } = relRecord;
  return { ...rest, source_stable_id: sourceStableId, target_stable_id: targetStableId };
}

/**
 * Builds a lookup map from stable identifier → Kuzu `node_id` for a set of
 * concept instances, using a single known identity attribute name.
 *
 * Instances with an empty stable ID are excluded.  If two instances share
 * the same stable ID, both are excluded (deduplication).
 *
 * @param conceptInstances - Raw Kuzu rows with `node_id` and `attributes`
 * @param stableAttribute  - The identity attribute key (e.g. `"stable_path"`)
 */
export function buildStableIdLookup(
  conceptInstances: Record<string, unknown>[],
  stableAttribute: string,
): Map<string, number> {
  const lookup = new Map<string, number>();
  const duplicates = new Set<string>();

  for (const row of conceptInstances) {
    const stableId = resolveStableId(String(row.attributes ?? ''), stableAttribute);
    if (stableId === '') continue;
    if (duplicates.has(stableId)) continue;
    if (lookup.has(stableId)) {
      lookup.delete(stableId);
      duplicates.add(stableId);
      continue;
    }
    lookup.set(stableId, Number(row.node_id));
  }

  return lookup;
}

/**
 * Resolve the identity attribute name for a given concept type from the
 * schema-declared nodeKeyAttrs map.
 *
 * Throws if the concept type has no identity attribute registered — every
 * importer must declare `identifier: true` on exactly one attribute per
 * concrete concept type.
 *
 * @param conceptType  - The concept type (e.g. `"ar_package"`)
 * @param nodeKeyAttrs - Map of concept_type → [identityAttr, ...keyAttrs]
 * @throws If no identity attribute is declared for this concept type
 */
export function resolveIdentityAttr(
  conceptType: string,
  nodeKeyAttrs: Map<string, string[]>,
): string {
  const keyAttrs = nodeKeyAttrs.get(conceptType);
  if (!keyAttrs || keyAttrs.length === 0) {
    throw new Error(
      `Concept type "${conceptType}" has no identity attribute declared in the metamodel. ` +
      `Every importer must declare 'identifier: true' on exactly one attribute per concrete concept type.`
    );
  }
  return keyAttrs[0];
}

/**
 * Resolve the stable identifier for a single concept instance using the
 * schema-declared identity attribute.
 *
 * @param attributes   - Raw JSON string from the `attributes` column
 * @param conceptType  - The concept type of the instance
 * @param nodeKeyAttrs - Map of concept_type → [identityAttr, ...keyAttrs]
 * @returns The stable identifier string, or `""` if the value is absent/empty
 * @throws  If the concept type has no identity attribute declared
 */
export function resolveStableIdFromMeta(
  attributes: string,
  conceptType: string,
  nodeKeyAttrs: Map<string, string[]>,
): string {
  return resolveStableId(attributes, resolveIdentityAttr(conceptType, nodeKeyAttrs));
}

/**
 * Build a `stableId → node_id` lookup map for a set of concept instances
 * using the schema-declared identity attribute per concept type.
 *
 * Throws if any concept type has no identity attribute registered.
 * Deduplicates: if two instances share the same stable ID, both are excluded.
 *
 * @param conceptInstances - Kuzu rows with `node_id`, `concept`, `attributes`
 * @param nodeKeyAttrs     - Map of concept_type → [identityAttr, ...keyAttrs]
 * @throws If any concept type has no identity attribute declared
 */
export function buildStableIdLookupFromMeta(
  conceptInstances: Array<{ node_id: unknown; concept: unknown; attributes: unknown }>,
  nodeKeyAttrs: Map<string, string[]>,
): Map<string, number> {
  const lookup = new Map<string, number>();
  const duplicates = new Set<string>();

  for (const ci of conceptInstances) {
    const stableId = resolveStableIdFromMeta(
      String(ci.attributes ?? ''),
      String(ci.concept ?? ''),
      nodeKeyAttrs,
    );
    if (stableId === '') continue;
    if (duplicates.has(stableId)) continue;
    if (lookup.has(stableId)) {
      lookup.delete(stableId);
      duplicates.add(stableId);
      continue;
    }
    lookup.set(stableId, Number(ci.node_id));
  }

  return lookup;
}
