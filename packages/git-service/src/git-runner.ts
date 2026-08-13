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
 * Create a configured simple-git instance for the given base directory.
 *
 * The `unsafe.allowUnsafeCustomBinary` option is required because the dugite
 * binary path is an absolute filesystem path containing characters like `:` and `\`
 * on Windows, which simple-git's default security check rejects. Since the path
 * is resolved from the trusted dugite package (not user input), this is safe.
 */
export async function createGitRunner(baseDir: string): Promise<SimpleGit> {
  const binary = await resolveGitBinaryPath();
  return simpleGit({
    binary,
    baseDir,
    maxConcurrentProcesses: 4,
    timeout: { block: 30_000 },
    unsafe: { allowUnsafeCustomBinary: true },
  });
}
