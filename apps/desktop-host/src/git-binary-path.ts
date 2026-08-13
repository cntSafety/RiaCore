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
 * Resolves the path to the bundled git binary for packaged Electron builds.
 *
 * - When packaged: git binary is in process.resourcesPath/git/{cmd|bin}/git{.exe}
 * - When dev: fall back to RIACORE_GIT_BINARY_PATH env var (dugite binary is resolved
 *   automatically by the git-service package's binary-resolver if env var is unset)
 */
import * as path from 'node:path';
import { app } from 'electron';

export function getPackagedGitBinaryPath(): string | undefined {
  if (!app.isPackaged) {
    return process.env['RIACORE_GIT_BINARY_PATH'];
  }

  if (process.platform === 'win32') {
    return path.join(process.resourcesPath, 'git', 'cmd', 'git.exe');
  }
  return path.join(process.resourcesPath, 'git', 'bin', 'git');
}
