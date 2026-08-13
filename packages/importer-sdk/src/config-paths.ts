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
 * config-paths.ts — the single anchor rule for paths in import configs.
 *
 * Every path-bearing field in an import config (`project_dir`, `needs_file`,
 * `scan_result_dir`) is either absolute or **relative to the workspace root**.
 * Nothing else is an anchor. In particular the config YAML's own directory is
 * not, so a config file can be moved or regenerated without changing what it
 * points at, and the resolution never depends on the process working directory.
 *
 * Resolution happens exactly once, at the orchestration boundary, before the
 * importer runtime is invoked. Runtimes receive absolute paths and contain no
 * path logic of their own.
 *
 * Relative or absolute is decided in exactly one place — the folder picker, via
 * `toWorkspaceRelative`, which always produces a relative path when one exists.
 * Saving never re-anchors a value: `normalizeStoredPath` keeps what the user
 * entered, so typing an absolute path is how you deliberately pin a source that
 * does not travel with the workspace.
 *
 * Cross-platform notes:
 *  - Stored values always use forward slashes, so a workspace committed on
 *    Windows resolves unchanged on macOS and Linux. `path.resolve` accepts
 *    forward slashes on win32, so nothing is converted when reading them back.
 *  - An absolute path is inherently machine-specific and, for a Windows drive
 *    path, not even recognisable as absolute on POSIX. Relative values are the
 *    portable choice.
 */

import * as path from 'node:path';

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolve a configured path to an absolute filesystem path.
 *
 * Absolute values pass through. Relative values are resolved against
 * `workspaceRoot`. Blank values fall back to `fallback`, defaulting to the
 * workspace root itself.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  configured: string | undefined | null,
  fallback?: string,
): string {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  if (!trimmed) return fallback ?? path.resolve(workspaceRoot);
  // An absolute path is returned verbatim. Passing it through path.resolve would
  // rewrite a POSIX-style absolute path on win32 by prefixing the current drive
  // ('/data/src' → 'C:\data\src'), which corrupts paths that are already valid.
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(workspaceRoot, trimmed);
}

/**
 * Express `target` relative to the workspace root, for the folder picker.
 *
 * Always returns a relative path when one exists, so browsing to a folder yields
 * a portable value regardless of where it sits. Only a location on another volume
 * has no relative form and is returned absolute.
 *
 * This is the *only* place that decides between relative and absolute. Values a
 * user typed are never rewritten — see `normalizeStoredPath`.
 */
export function toWorkspaceRelative(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(target);
  const rel = path.relative(root, abs);

  if (rel === '') return '.';
  // A still-absolute result means a different volume — no relative form exists.
  if (path.isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}

/**
 * Canonical stored form for a path field.
 *
 * Deliberately makes no anchoring decision: whatever the user entered is kept,
 * relative or absolute. Only separators are normalised to forward slashes, which
 * `path.resolve` accepts on every platform, so the same stored value works on
 * Windows, macOS and Linux.
 */
export function normalizeStoredPath(configured: string | undefined | null): string {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  return trimmed ? toPosix(trimmed) : '';
}
