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
 * Persistent store for {@link ExportSettings} — the global preferences that
 * shape safety report exports (currently: whether the semi-quantitative
 * risk-rating values are written into the report).
 *
 * Plaintext JSON under the host-supplied `userDataDir`, outside any workspace
 * directory (same placement as `LlmSettingsStore` and
 * `CrossNsLinkSettingsStore`), since this is a per-user preference, not
 * workspace data.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ExportSettings } from '@riacore/app-contracts';

export const EXPORT_SETTINGS_FILENAME = 'export-settings.json';

/**
 * Ratings are included by default so an upgrade never silently drops content
 * from a report a project already relies on.
 */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = Object.freeze({
  includeRiskRatings: true,
});

export interface ExportSettingsStoreOptions {
  userDataDir: () => string;
}

export class ExportSettingsStore {
  private readonly userDataDir: () => string;

  constructor(opts: ExportSettingsStoreOptions) {
    this.userDataDir = opts.userDataDir;
  }

  private settingsPath(): string {
    return path.join(this.userDataDir(), EXPORT_SETTINGS_FILENAME);
  }

  /** Read the persisted settings. Returns defaults when no file exists or it is malformed. */
  async load(): Promise<ExportSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.settingsPath(), 'utf-8');
    } catch (err) {
      if (isFileNotFoundError(err)) return { ...DEFAULT_EXPORT_SETTINGS };
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_EXPORT_SETTINGS };
    }
    if (!isExportSettings(parsed)) return { ...DEFAULT_EXPORT_SETTINGS };
    return parsed;
  }

  async save(settings: ExportSettings): Promise<void> {
    await fs.mkdir(this.userDataDir(), { recursive: true });
    await fs.writeFile(this.settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  }
}

function isExportSettings(value: unknown): value is ExportSettings {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.includeRiskRatings === 'boolean';
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
