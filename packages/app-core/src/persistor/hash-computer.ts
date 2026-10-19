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
 * Serialize the cross-namespace section of a namespace hash.
 *
 * The one section of `computeNamespaceHashFromFileContents` that is derived
 * from records rather than file bytes, because its file is shared across every
 * namespace — see that function's doc comment for why.
 */
function serializeCrossNsSection(records: Record<string, unknown>[]): string {
  const serialized = records
    .map((r) => serializeRecord(r, JSON_COLUMNS, OMIT_COLUMNS))
    .sort();
  return serialized.length === 0
    ? "[]\n"
    : "[\n" + serialized.join(",\n") + "\n]\n";
}

/**
 * Universe_Hash (`sha256:<hex>`) over a universe-layer file's exact serialized
 * bytes. Per-file rather than per-directory (as `computeMetaHash` is) so load can
 * name the specific corrupted file and repair can rewrite only its manifest entry.
 * Store, load and repair all call this, so the three agree byte-for-byte.
 */
export function computeUniverseFileHash(serializedContent: string): string {
  return `sha256:${createHash("sha256").update(serializedContent, "utf-8").digest("hex")}`;
}

// ── Byte-based namespace hash ─────────────────────────────────────────────────

/**
 * One file belonging to a namespace's `concepts/` or `relationships/`
 * directory, paired with its exact serialized content.
 */
export interface NamespaceSectionFile {
  /**
   * File name only — e.g. `malfunction.json`. Never a path, never a directory
   * prefix: the section marker already identifies which directory the file
   * belongs to, and including a path would make the digest depend on the
   * platform's separator.
   */
  fileName: string;
  /**
   * The exact serialized UTF-8 content of the file: the string handed to
   * `fs.writeFileSync` on the store side, and the string returned by
   * `fs.readFileSync(..., 'utf-8')` on the file side. Not a re-serialization of
   * parsed records — the whole point is that the digest covers the bytes that
   * are actually on disk.
   */
  content: string;
}

export interface NamespaceFileHashInput {
  namespace: string;
  /** Files under `<namespace>/concepts/`. Order is irrelevant; see sorting below. */
  conceptFiles: NamespaceSectionFile[];
  /** Files under `<namespace>/relationships/`. Order is irrelevant; see sorting below. */
  relationshipFiles: NamespaceSectionFile[];
  /**
   * Rows of `RIA_UNIV_CrossNSRelationshipInstance` whose `source_namespace` is
   * this namespace. Records, not file content — see the cross-NS note below.
   */
  crossNsEdgesAsSource: Record<string, unknown>[];
  /**
   * Optional diagnostic callback. Emits per-section file counts and section
   * digests without writing model records or project content to the log.
   */
  debugLog?: (msg: string) => void;
}

/**
 * Section markers. They exist to make the three sections non-splicable: without
 * them a namespace with one concept file and no relationship files would digest
 * identically to one with the same file under `relationships/` instead.
 */
const SECTION_MARKER_CONCEPTS = "concepts\n";
const SECTION_MARKER_RELATIONSHIPS = "relationships\n";
const SECTION_MARKER_CROSS_NS = "cross_ns\n";

/** Sort by file name, ascending, by UTF-16 code unit — the same order `Array#sort` gives bare strings. */
function sortSectionFiles(files: NamespaceSectionFile[]): NamespaceSectionFile[] {
  return [...files].sort((a, b) =>
    a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
  );
}

function updateWithSectionFiles(
  hash: ReturnType<typeof createHash>,
  marker: string,
  files: NamespaceSectionFile[],
): void {
  hash.update(marker);
  for (const file of sortSectionFiles(files)) {
    hash.update(file.fileName);
    hash.update(file.content, "utf-8");
  }
}

/**
 * Namespace content hash (`sha256:<hex>`): a digest over the bytes of the
 * namespace's written files, plus a record-based digest of its cross-namespace
 * edges.
 *
 * Both sides of the store/verify pair call this, so every digest input is fixed
 * here: section order, an unconditional marker per section, files sorted by name
 * with the name fed before its content, and UTF-8. Records are not sorted here --
 * the writer already did. The digest is line-ending sensitive by construction.
 *
 * Cross-NS edges are the one record-based section: their file is shared across
 * every namespace, so byte-hashing it would move every namespace's hash on any
 * single edge change.
 */
export function computeNamespaceHashFromFileContents(
  input: NamespaceFileHashInput,
): string {
  const log = input.debugLog;
  const hash = createHash("sha256");

  updateWithSectionFiles(hash, SECTION_MARKER_CONCEPTS, input.conceptFiles);
  if (log) {
    const sectionHash = createHash("sha256");
    updateWithSectionFiles(sectionHash, SECTION_MARKER_CONCEPTS, input.conceptFiles);
    log(
      `hash:concepts files=${input.conceptFiles.length} ` +
      `names=[${sortSectionFiles(input.conceptFiles).map(f => f.fileName).join(',')}] ` +
      `section_sha256=${sectionHash.digest("hex")}`,
    );
  }

  updateWithSectionFiles(hash, SECTION_MARKER_RELATIONSHIPS, input.relationshipFiles);
  if (log) {
    const sectionHash = createHash("sha256");
    updateWithSectionFiles(sectionHash, SECTION_MARKER_RELATIONSHIPS, input.relationshipFiles);
    log(
      `hash:relationships files=${input.relationshipFiles.length} ` +
      `names=[${sortSectionFiles(input.relationshipFiles).map(f => f.fileName).join(',')}] ` +
      `section_sha256=${sectionHash.digest("hex")}`,
    );
  }

  const crossNsBytes = serializeCrossNsSection(input.crossNsEdgesAsSource);
  hash.update(SECTION_MARKER_CROSS_NS);
  hash.update(crossNsBytes, "utf-8");
  if (log) {
    const sectionHash = createHash("sha256")
      .update(SECTION_MARKER_CROSS_NS)
      .update(crossNsBytes, "utf-8")
      .digest("hex");
    log(
      `hash:cross_ns count=${input.crossNsEdgesAsSource.length} section_sha256=${sectionHash}`,
    );
  }

  const result = `sha256:${hash.digest("hex")}`;
  if (log) {
    log(`hash:final namespace=${input.namespace} sha256=${result}`);
  }
  return result;
}