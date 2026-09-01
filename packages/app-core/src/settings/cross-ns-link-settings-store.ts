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
 * Persistent store for {@link CrossNsLinkSettings} — the global preference
 * governing what the Imported Requirement picker does when a matching
 * element's namespace isn't connected to the current analysis yet.
 *
 * Plaintext JSON under the host-supplied `userDataDir`, outside any workspace
 * directory (same placement as `LlmSettingsStore`), since this is a per-user
 * preference, not workspace data.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CrossNsLinkSettings, CrossNsLinkUnconnectedMode } from '@riacore/app-contracts';

export const CROSS_NS_LINK_SETTINGS_FILENAME = 'cross-ns-link-settings.json';

export const DEFAULT_CROSS_NS_LINK_SETTINGS: CrossNsLinkSettings = Object.freeze({
  unconnectedNamespaceMode: 'prompt',
});

export interface CrossNsLinkSettingsStoreOptions {
  userDataDir: () => string;
}

export class CrossNsLinkSettingsStore {
  private readonly userDataDir: () => string;

  constructor(opts: CrossNsLinkSettingsStoreOptions) {
    this.userDataDir = opts.userDataDir;
  }

  private settingsPath(): string {
    return path.join(this.userDataDir(), CROSS_NS_LINK_SETTINGS_FILENAME);
  }

  /** Read the persisted settings. Returns defaults when no file exists or it is malformed. */
  async load(): Promise<CrossNsLinkSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.settingsPath(), 'utf-8');
    } catch (err) {
      if (isFileNotFoundError(err)) return { ...DEFAULT_CROSS_NS_LINK_SETTINGS };
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_CROSS_NS_LINK_SETTINGS };
    }
    if (!isCrossNsLinkSettings(parsed)) return { ...DEFAULT_CROSS_NS_LINK_SETTINGS };
    return parsed;
  }

  async save(settings: CrossNsLinkSettings): Promise<void> {
    await fs.mkdir(this.userDataDir(), { recursive: true });
    await fs.writeFile(this.settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  }
}

const VALID_MODES = new Set<string>(['prompt', 'restrict'] satisfies CrossNsLinkUnconnectedMode[]);

function isCrossNsLinkSettings(value: unknown): value is CrossNsLinkSettings {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.unconnectedNamespaceMode === 'string' && VALID_MODES.has(v.unconnectedNamespaceMode);
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
