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
 * Reads the optional config.json from the app's user-data directory.
 *
 * Location (non-portable): %APPDATA%/RiaCore/config.json
 * Location (portable):     <exe-dir>/<AppName>Data/config.json
 *
 * If the file is missing or malformed the defaults are used silently.
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '@riacore/app-contracts';

const DEFAULT_CONFIG: AppConfig = { debug: true };

let cached: AppConfig | null = null;

function resolveConfigPath(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    const appName = process.env.PORTABLE_EXECUTABLE_APP_FILENAME ?? app.getName();
    return path.join(portableDir, `${appName}Data`, 'config.json');
  }
  return path.join(app.getPath('userData'), 'config.json');
}

export function getAppConfig(): AppConfig {
  if (cached) return cached;

  try {
    const raw = readFileSync(resolveConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    cached = {
      debug: typeof parsed.debug === 'boolean' ? parsed.debug : DEFAULT_CONFIG.debug,
    };
  } catch {
    cached = { ...DEFAULT_CONFIG };
  }

  return cached;
}
