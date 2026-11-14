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

/**
 * The desktop host sets this before loading any worker modules. Bundling changes
 * __dirname, so packaged assets must be anchored at resources/app, never cwd or
 * a build-machine path. Without the root, callers retain their development paths.
 */
export function packagedAssetPath(relativePath: string, override?: string): string | undefined {
  const root = process.env.RIACORE_APP_ROOT;
  if (!root) return undefined;
  if (!path.isAbsolute(root)) throw new Error('RIACORE_APP_ROOT must be an absolute path');
  const target = override ? path.resolve(override) : path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!override && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    throw new Error(`Runtime asset escapes RIACORE_APP_ROOT: ${relativePath}`);
  }
  if (!fs.existsSync(target)) throw new Error(`Required packaged runtime asset is missing: ${target}`);
  return target;
}

/** Importer assets remain beside each package's dist directory in all packages. */
export function importerAssetPath(packageName: string, relativePath: string, moduleDir: string): string {
  return packagedAssetPath(path.join('node_modules', packageName, relativePath))
    ?? path.resolve(moduleDir, '..', relativePath);
}
