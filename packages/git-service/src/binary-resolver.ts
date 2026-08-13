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
import * as fs from 'node:fs';
import * as path from 'node:path';

let cachedBinaryPath: string | undefined;

/**
 * Resolve the git binary path from the dugite package directory.
 * Dugite bundles a platform-appropriate git binary in its own `git/` subdirectory.
 */
function resolveFromDugite(): string {
  // In CJS context, require.resolve is available to locate dugite
  // __dirname points to packages/git-service/src (or dist after build)
  // We need to find the dugite package root
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dugitePkgPath: string = require.resolve('dugite/package.json');
  const dugiteRoot = path.dirname(dugitePkgPath);
  const gitDir = path.join(dugiteRoot, 'git');

  if (process.platform === 'win32') {
    return path.join(gitDir, 'cmd', 'git.exe');
  } else {
    return path.join(gitDir, 'bin', 'git');
  }
}

/**
 * Resolve the git binary path for use with simple-git.
 *
 * Resolution order:
 *  1. RIACORE_GIT_BINARY_PATH environment variable (set by Electron main for packaged builds)
 *  2. dugite's bundled binary (development mode — finds the binary in node_modules/dugite/git/)
 *
 * The result is cached after the first call.
 */
export async function resolveGitBinaryPath(): Promise<string> {
  if (cachedBinaryPath !== undefined) {
    return cachedBinaryPath;
  }

  const envOverride = process.env['RIACORE_GIT_BINARY_PATH'];
  if (envOverride && envOverride.trim() !== '') {
    if (!fs.existsSync(envOverride)) {
      throw new Error(
        `RIACORE_GIT_BINARY_PATH is set to "${envOverride}" but the file does not exist.`,
      );
    }
    cachedBinaryPath = envOverride;
    return cachedBinaryPath;
  }

  // Fall back to dugite's bundled binary
  const resolved = resolveFromDugite();
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `dugite git binary not found at "${resolved}". ` +
        'Run "pnpm install" and "pnpm approve-builds" to ensure dugite post-install scripts have run.',
    );
  }
  cachedBinaryPath = resolved;
  return cachedBinaryPath;
}
