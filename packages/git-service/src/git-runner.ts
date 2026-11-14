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
import simpleGit from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { resolveGitBinaryPath } from './binary-resolver.js';

/**
 * simple-git's custom-binary plugin emits this exact message through
 * `console.warn` whenever `unsafe.allowUnsafeCustomBinary` permits a path its
 * character whitelist rejects. The option is set deliberately below, so the
 * warning carries no information and is emitted once per runner construction.
 */
const EXPECTED_CUSTOM_BINARY_WARNING =
  'Invalid value supplied for custom binary, restricted characters must be removed or supply the unsafe.allowUnsafeCustomBinary option';

/**
 * Run `construct` with the expected simple-git custom-binary warning silenced.
 * Any other `console.warn` output is passed through unchanged.
 */
function withoutCustomBinaryWarning<T>(construct: () => T): T {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === EXPECTED_CUSTOM_BINARY_WARNING) {
      return;
    }
    originalWarn.apply(console, args as Parameters<typeof console.warn>);
  };
  try {
    return construct();
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Create a configured simple-git instance for the given base directory.
 *
 * The `unsafe.allowUnsafeCustomBinary` option is required because the dugite
 * binary path is an absolute filesystem path containing characters like `:` and `\`
 * on Windows, which simple-git's default security check rejects. Since the path
 * is resolved from the trusted dugite package (not user input), this is safe.
 */
export async function createGitRunner(baseDir: string): Promise<SimpleGit> {
  const binary = await resolveGitBinaryPath();
  return withoutCustomBinaryWarning(() =>
    simpleGit({
      binary,
      baseDir,
      maxConcurrentProcesses: 4,
      timeout: { block: 30_000 },
      unsafe: { allowUnsafeCustomBinary: true },
    }),
  );
}
