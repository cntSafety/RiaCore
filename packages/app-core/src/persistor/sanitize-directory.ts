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
 * Namespace directory name sanitization for the Persistor.
 *
 * Namespace names are arbitrary strings stored in the DB and may contain
 * characters forbidden on Windows/macOS/Linux filesystems. This module
 * derives a safe directory name for each namespace and detects collisions.
 */

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Derive a safe filesystem directory name from a namespace logical name.
 *
 * Algorithm (applied in order):
 * 1. Replace forbidden chars [\\/:*?"<>|\x00] with `_`
 * 2. Strip leading/trailing whitespace and `.` characters
 * 3. Prepend `_` if result matches a Windows reserved name (case-insensitive)
 * 4. Truncate to 200 characters
 * 5. Throw if result is empty
 */
export function sanitizeDirectoryName(namespaceName: string): string {
  // Step 1: replace forbidden filesystem characters
  let result = namespaceName.replace(/[\\/:*?"<>|\x00]/g, '_');

  // Step 2: strip leading/trailing whitespace and periods
  result = result.replace(/^[\s.]+|[\s.]+$/g, '');

  // Step 3: prepend _ for Windows reserved names
  if (WINDOWS_RESERVED.has(result.toUpperCase())) {
    result = '_' + result;
  }

  // Step 4: truncate to 200 chars
  result = result.slice(0, 200);

  // Step 5: error if empty
  if (result.length === 0) {
    throw new Error(
      `Namespace name "${namespaceName}" sanitizes to an empty directory name. ` +
      `Rename the namespace before exporting.`
    );
  }

  return result;
}

/**
 * Detect case-insensitive directory name collisions across all namespaces.
 * Throws before any files are written if two namespaces would map to the same
 * directory on a case-insensitive filesystem (macOS HFS+, Windows NTFS).
 */
export function detectDirectoryConflicts(
  namespaces: { name: string; directory: string }[],
): void {
  const seen = new Map<string, string>(); // lower-case dir → first namespace name
  const conflicts: string[] = [];

  for (const ns of namespaces) {
    const lower = ns.directory.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined) {
      conflicts.push(`"${existing}" and "${ns.name}" both map to directory "${ns.directory}"`);
    } else {
      seen.set(lower, ns.name);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Namespace directory name conflicts detected (case-insensitive collision):\n` +
      conflicts.map(c => `  - ${c}`).join('\n') + '\n' +
      `Rename the conflicting namespaces before exporting.`
    );
  }
}
