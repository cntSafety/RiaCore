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
import { createHash } from "crypto";
import { serializeRecord } from "./serializer.js";

const OMIT_COLUMNS = ["node_id", "edge_id", "source_node_id", "target_node_id"];
const JSON_COLUMNS = ["attributes"];

/**
 * Compute a Universe_Hash (`sha256:<hex>`) over a universe-layer file's exact
 * serialized bytes. Uses the same `createHash('sha256')` primitive used for
 * `meta_hash`. Because the digest is taken over the serialized UTF-8 content,
 * it matches a hash computed from the file bytes on load — guaranteeing an
 * identical value across store (record), load (verify), and repair (recompute).
 *
 * This is the single shared per-file byte-hash helper for the universe layer.
 * It deliberately does NOT reuse `computeMetaHash` (which hashes a whole
 * directory into one hash); the universe layer needs a per-file byte hash so
 * load can identify the specific corrupted file and repair can rewrite only its
 * manifest entry. Shared by the universe-scoped store path, the full/namespace
 * store path (task 2.2), load-time verification, and repair, so `createHash`
 * stays confined to this hashing module.
 */
export function computeUniverseFileHash(serializedContent: string): string {
  return `sha256:${createHash("sha256").update(serializedContent, "utf-8").digest("hex")}`;
}

/** Map of concept_type → sorted list of key/identity attribute names */
type NodeKeyAttrMap = Map<string, string[]>;
/** Map of relationship_type → sorted list of is_key edge attribute names */
type EdgeKeyAttrMap = Map<string, string[]>;

export interface NamespaceHashInput {
  namespace: string;
  conceptInstances: Record<string, unknown>[];
  relationshipInstances: Record<string, unknown>[];
  crossNsEdgesAsSource: Record<string, unknown>[];
  /** Pre-loaded from RIA_META_NodeAttribute (is_key/is_identity attrs per concept type) */
  nodeKeyAttrs?: NodeKeyAttrMap;
  /** Pre-loaded from RIA_META_EdgeAttribute (is_key attrs per relationship type) */
  edgeKeyAttrs?: EdgeKeyAttrMap;
  /**
   * Optional diagnostic callback. When provided, emits per-section counts,
   * hashes, and identity-attribute usage without serializing model records.
   */
  debugLog?: (msg: string) => void;
}

function parseAttrs(record: Record<string, unknown>): Record<string, unknown> {
  const raw = record.attributes;
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>; }
  catch { return {}; }
}

function sortConceptInstancesForHash(
  instances: Record<string, unknown>[],
  conceptType: string,
  nodeKeyAttrs: NodeKeyAttrMap,
): Record<string, unknown>[] {
  const keyAttrs = nodeKeyAttrs.get(conceptType) ?? [];

  return [...instances].sort((a, b) => {
    const aAttrs = parseAttrs(a);
    const bAttrs = parseAttrs(b);
    const allAttrNames = [...new Set([...Object.keys(aAttrs), ...Object.keys(bAttrs)])].sort();
    const nonKeyAttrs = allAttrNames.filter(n => !keyAttrs.includes(n));

    for (const attrName of [...keyAttrs, ...nonKeyAttrs]) {
      const aVal = String(aAttrs[attrName] ?? '');
      const bVal = String(bAttrs[attrName] ?? '');
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
    }
    return 0;
  });
}

function sortRelInstancesForHash(
  instances: Record<string, unknown>[],
  relType: string,
  edgeKeyAttrs: EdgeKeyAttrMap,
): Record<string, unknown>[] {
  const keyAttrs = edgeKeyAttrs.get(relType) ?? [];

  return [...instances].sort((a, b) => {
    const aSrc = String(a.source_stable_id ?? '');
    const bSrc = String(b.source_stable_id ?? '');
    if (aSrc < bSrc) return -1;
    if (aSrc > bSrc) return 1;

    const aTgt = String(a.target_stable_id ?? '');
    const bTgt = String(b.target_stable_id ?? '');
    if (aTgt < bTgt) return -1;
    if (aTgt > bTgt) return 1;

    if (keyAttrs.length > 0) {
      const aAttrs = parseAttrs(a);
      const bAttrs = parseAttrs(b);
      for (const attrName of keyAttrs) {
        const aVal = String(aAttrs[attrName] ?? '');
        const bVal = String(bAttrs[attrName] ?? '');
        if (aVal < bVal) return -1;
        if (aVal > bVal) return 1;
      }
    }
    return 0;
  });
}

/**
 * Compute a SHA-256 content hash over the canonical serialized data for a namespace.
 *
 * When `debugLog` is provided, logs:
 *   - Per-section SHA-256 hashes and record counts
 *   - Identity attribute usage summary
 *
 * This makes hash mismatches diagnosable without writing model records or
 * project content to the workspace log.
 */
export function computeNamespaceHash(namespaceData: NamespaceHashInput): string {
  const nodeKeyAttrs = namespaceData.nodeKeyAttrs ?? new Map();
  const edgeKeyAttrs = namespaceData.edgeKeyAttrs ?? new Map();
  const log = namespaceData.debugLog;

  // ── Concepts ──────────────────────────────────────────────────────────────
  const conceptsByType = new Map<string, Record<string, unknown>[]>();
  for (const ci of namespaceData.conceptInstances) {
    const conceptType = String(ci.concept ?? '');
    const group = conceptsByType.get(conceptType) ?? [];
    group.push(ci);
    conceptsByType.set(conceptType, group);
  }

  if (log) {
    const identityAttrCounts: Record<string, number> = {};
    for (const attrs of nodeKeyAttrs.values()) {
      const attribute = attrs[0] ?? '(none)';
      identityAttrCounts[attribute] = (identityAttrCounts[attribute] ?? 0) + 1;
    }
    log(
      `hash:concepts identity_attr_counts=${JSON.stringify(identityAttrCounts)} concept_types=${nodeKeyAttrs.size}`,
    );
  }

  const sortedConceptTypes = [...conceptsByType.keys()].sort();
  const allSortedConcepts: Record<string, unknown>[] = [];
  for (const conceptType of sortedConceptTypes) {
    const sorted = sortConceptInstancesForHash(conceptsByType.get(conceptType)!, conceptType, nodeKeyAttrs);
    allSortedConcepts.push(...sorted);
  }

  const serializedConcepts = allSortedConcepts.map(r => serializeRecord(r, JSON_COLUMNS, OMIT_COLUMNS));
  const conceptBytes = serializedConcepts.length === 0
    ? "[]\n"
    : "[\n" + serializedConcepts.join(",\n") + "\n]\n";

  if (log) {
    const sectionHash = createHash("sha256").update(conceptBytes).digest("hex");
    log(`hash:concepts count=${serializedConcepts.length} section_sha256=${sectionHash}`);
  }

  // ── Relationships ─────────────────────────────────────────────────────────
  const relsByType = new Map<string, Record<string, unknown>[]>();
  for (const ri of namespaceData.relationshipInstances) {
    const relType = String(ri.relationship ?? '');
    const group = relsByType.get(relType) ?? [];
    group.push(ri);
    relsByType.set(relType, group);
  }

  const sortedRelTypes = [...relsByType.keys()].sort();
  const allSortedRels: Record<string, unknown>[] = [];
  for (const relType of sortedRelTypes) {
    const sorted = sortRelInstancesForHash(relsByType.get(relType)!, relType, edgeKeyAttrs);
    allSortedRels.push(...sorted);
  }

  const serializedRels = allSortedRels.map(r => serializeRecord(r, JSON_COLUMNS, OMIT_COLUMNS));
  const relationshipBytes = serializedRels.length === 0
    ? "[]\n"
    : "[\n" + serializedRels.join(",\n") + "\n]\n";

  if (log) {
    const sectionHash = createHash("sha256").update(relationshipBytes).digest("hex");
    log(`hash:relationships count=${serializedRels.length} section_sha256=${sectionHash}`);
  }

  // ── Cross-NS edges ────────────────────────────────────────────────────────
  const serializedCrossNs = namespaceData.crossNsEdgesAsSource
    .map(r => serializeRecord(r, JSON_COLUMNS, OMIT_COLUMNS))
    .sort();
  const crossNsBytes = serializedCrossNs.length === 0
    ? "[]\n"
    : "[\n" + serializedCrossNs.join(",\n") + "\n]\n";

  if (log) {
    const sectionHash = createHash("sha256").update(crossNsBytes).digest("hex");
    log(`hash:cross_ns count=${serializedCrossNs.length} section_sha256=${sectionHash}`);
  }

  // ── Final hash ────────────────────────────────────────────────────────────
  const hash = createHash("sha256");
  hash.update(conceptBytes);
  hash.update(relationshipBytes);
  hash.update(crossNsBytes);
  const result = `sha256:${hash.digest("hex")}`;

  if (log) {
    log(`hash:final namespace=${namespaceData.namespace} sha256=${result}`);
  }

  return result;
}
