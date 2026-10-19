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
 * Schema-version compatibility policy.
 *
 * `SCHEMA_VERSION` (see `./schema.js`) is the version this code writes. This
 * module answers the separate question of which versions this code is willing to
 * *read*, and it is the single place that question is answered — the persistor
 * load, the sync evaluation and the workspace open flow all route through
 * `classifySchemaCompatibility` rather than comparing version strings
 * themselves.
 *
 * ## Why a floor exists at all
 *
 * Before this module, any version older than `SCHEMA_VERSION` was accepted
 * unconditionally: hash comparison was suspended, the data was loaded as-is, and
 * the next store re-stamped `ria-data/` at the current version. That is the right
 * behaviour for a *recent* older version, whose file layout this code still
 * understands and whose only difference is that its digests were computed
 * differently.
 *
 * It is the wrong behaviour once the file layout itself has moved. A pre-1.5.0
 * snapshot keeps `namespace_role` and `namespace_owning_application` in
 * `<namespace>/namespace.json`, which 1.5.0 deleted in favour of
 * `manifest.namespaces[]`. Accepting such a manifest does not produce a working
 * workspace — it produces a load that warns reassuringly about a suspended epoch
 * and then dies 177 lines later inside `assertManifestNamespaceIdentity` with a
 * message about missing namespace identity, by which point the stale-DB path has
 * already deleted the database it was going to rebuild. The floor converts that
 * into one refusal taken before anything is read or deleted.
 *
 * `MIN_READABLE_SCHEMA_VERSION` is therefore a factual claim about the loader,
 * not a support policy: it is the oldest on-disk format the current code can
 * actually parse. Lowering it means teaching the loader to read the older layout
 * (and adding a fixture that proves it), not editing the constant.
 *
 * ## Why a major-version rule exists
 *
 * A major bump is the signal reserved for a change that moves more than the
 * on-disk format — queries, views, the exporter, the renderer's assumptions about
 * what a namespace is. Such a snapshot may parse perfectly and still be
 * misinterpreted, which is worse than being refused. So a differing major is
 * refused in BOTH directions, independently of the floor, and the refusal names
 * the one recovery that applies: run a RiaCore built for that generation.
 *
 * ## What this module deliberately does not do
 *
 * It does not gate on the *database's* schema version. A database whose version
 * differs from the code's is deleted and rebuilt from `ria-data/` by
 * `performFreshLoad`, and that recovery is correct for a database from any
 * generation — it is discarded, not interpreted. `ria-data/` is the only artifact
 * whose version has to be trusted, because it is the one that gets read.
 */

import { SCHEMA_VERSION } from './schema.js';

/**
 * The oldest `manifest.schema_version` the current loader can read.
 *
 * `1.5.0` because that is the release that made `manifest.namespaces[]` the sole
 * authority for namespace identity. `assertManifestNamespaceIdentity` requires
 * those fields on every entry and has no fallback, so a 1.4.x or older manifest
 * cannot complete a load regardless of what this constant says. Claiming a lower
 * floor would be a promise no code keeps.
 *
 * Raise this when a format change makes an older layout genuinely unreadable;
 * lower it only together with loader support and a fixture at that version.
 */
export const MIN_READABLE_SCHEMA_VERSION = '1.5.0';

/** Why a snapshot's declared schema version is refused. */
export type SchemaIncompatibilityReason =
  /** Absent, empty, or not a dotted numeric version — the epoch is unknowable. */
  | 'malformed'
  /** A different major generation, in either direction. */
  | 'different_major'
  /** Same major, but newer than this code writes. */
  | 'newer'
  /** Same major, but older than `MIN_READABLE_SCHEMA_VERSION`. */
  | 'below_floor';

export type SchemaCompatibility =
  | {
    kind: 'supported';
    /** True when the version equals `SCHEMA_VERSION`, so hash comparison is live. */
    exact: boolean;
    version: string;
  }
  | {
    kind: 'incompatible';
    reason: SchemaIncompatibilityReason;
    /** The declared version, rendered for messages (`'(absent)'` when not a string). */
    version: string;
    /** One-sentence cause, without the recovery advice. */
    summary: string;
  };

/**
 * Compare two dotted versions numerically: negative when `a` is older than `b`,
 * positive when newer, zero when equal.
 *
 * Lenient by design — a non-numeric segment counts as 0, and a shorter version is
 * padded with zeroes, so `'1.6'` and `'1.6.0'` compare equal. Leniency is safe
 * here because malformed input never reaches this function as a decision:
 * `classifySchemaCompatibility` rejects it on its own strict parse first. Kept
 * exported so ordering can be asserted directly in tests.
 */
export function compareSchemaVersions(a: string, b: string): number {
  const parse = (v: string): number[] => String(v ?? '').split('.').map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Strictly parse a declared version into its numeric segments, or `null` when it
 * is not a version at all.
 *
 * Strict where `compareSchemaVersions` is lenient: `''`, `'abc'`, `'1.x.0'` and a
 * non-string all yield `null`. An unknowable epoch must be refused rather than
 * silently ordered as "very old", because the whole point of the version is to
 * tell us which format the bytes are in.
 */
function parseStrict(version: unknown): number[] | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split('.').map((part) => Number(part));
}

/** The major component of a known-good constant. */
function majorOf(version: string): number {
  return parseStrict(version)?.[0] ?? 0;
}

/**
 * Decide whether a snapshot declaring `version` may be read by this code.
 *
 * The order of the four tests is load-bearing. `malformed` comes first because
 * every later test needs a parsed version. `different_major` comes before
 * `newer`/`below_floor` so that a `2.0.0` or a `0.9.0` is reported as a
 * generation difference — the thing a user can act on — rather than as a
 * near-miss on a bound.
 */
export function classifySchemaCompatibility(version: unknown): SchemaCompatibility {
  const rendered = typeof version === 'string' && version.trim() !== '' ? version : '(absent)';
  const parsed = parseStrict(version);

  if (parsed === null) {
    return {
      kind: 'incompatible',
      reason: 'malformed',
      version: rendered,
      summary:
        `ria-data/manifest.json declares schema_version ${rendered}, which is not a dotted ` +
        `numeric version — the format of the snapshot cannot be determined`,
    };
  }

  const declared = parsed.join('.');

  if (parsed[0] !== majorOf(SCHEMA_VERSION)) {
    const direction = parsed[0] > majorOf(SCHEMA_VERSION) ? 'newer' : 'older';
    return {
      kind: 'incompatible',
      reason: 'different_major',
      version: declared,
      summary:
        `this workspace was written at schema ${declared}, a ${direction} generation than ` +
        `this RiaCore supports (${SCHEMA_VERSION})`,
    };
  }

  if (compareSchemaVersions(declared, SCHEMA_VERSION) > 0) {
    return {
      kind: 'incompatible',
      reason: 'newer',
      version: declared,
      summary:
        `this workspace was written at schema ${declared}, which is newer than this RiaCore ` +
        `supports (${SCHEMA_VERSION})`,
    };
  }

  if (compareSchemaVersions(declared, MIN_READABLE_SCHEMA_VERSION) < 0) {
    return {
      kind: 'incompatible',
      reason: 'below_floor',
      version: declared,
      summary:
        `this workspace was written at schema ${declared}, which predates the oldest format ` +
        `this RiaCore can read (${MIN_READABLE_SCHEMA_VERSION})`,
    };
  }

  return { kind: 'supported', exact: declared === SCHEMA_VERSION, version: declared };
}

/**
 * The user-facing text for a refused schema version.
 *
 * Exported so the wording lives in one place: the workspace service puts it on
 * `lifecycleWarning`, the persistor puts it in the thrown error, and the tests
 * assert the two claims it has to make — the cause, and the recovery that
 * actually applies to that cause.
 *
 * The recovery differs by reason and that distinction is the point. "Update
 * RiaCore" is useless advice for a snapshot that is too OLD, and "restore from
 * version control" is useless for one that is too NEW.
 */
export function describeIncompatibleSchema(
  incompatibility: Extract<SchemaCompatibility, { kind: 'incompatible' }>,
): string {
  const recovery = ((): string => {
    switch (incompatibility.reason) {
      case 'newer':
        return (
          `Update RiaCore to a version that supports schema ${incompatibility.version} to open ` +
          `this workspace.`
        );
      case 'different_major':
        return (
          `Schema ${incompatibility.version} belongs to a different generation of RiaCore, whose ` +
          `queries, views and exporters this build does not implement. Use a RiaCore built for ` +
          `schema ${incompatibility.version} to open this workspace.`
        );
      case 'below_floor':
        return (
          `Open it with a RiaCore that still supports schema ${incompatibility.version} and save ` +
          `it there to migrate it forward, or restore a newer ria-data/ from version control.`
        );
      case 'malformed':
        return (
          `Restore ria-data/manifest.json from version control, or save from a workspace whose ` +
          `database still holds this content.`
        );
    }
  })();

  return (
    `${incompatibility.summary}. Nothing has been read from or written to ria-data/, so the ` +
    `snapshot on disk is untouched. ${recovery} Saves are refused while this workspace is open, ` +
    `so an incompatible snapshot cannot be overwritten by accident.`
  );
}
