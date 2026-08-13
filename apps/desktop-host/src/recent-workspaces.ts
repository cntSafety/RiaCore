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
 * Persists the list of recently opened workspace directories.
 * Stored as JSON in the Electron userData directory alongside config.json.
 *
 * Location: %APPDATA%/RiaCore/recent-workspaces.json
 */
import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const MAX_RECENT = 5;

function resolveStorePath(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    const appName = process.env.PORTABLE_EXECUTABLE_APP_FILENAME ?? app.getName();
    return path.join(portableDir, `${appName}Data`, 'recent-workspaces.json');
  }
  return path.join(app.getPath('userData'), 'recent-workspaces.json');
}

/** Read the stored list. Returns an empty array on any error. */
export function getRecentWorkspaces(): string[] {
  try {
    const raw = readFileSync(resolveStorePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed.slice(0, MAX_RECENT);
    }
  } catch {
    // File missing or malformed — start fresh
  }
  return [];
}

/**
 * Prepend `workingDir` to the recent list, deduplicate, cap at MAX_RECENT,
 * and persist. Safe to call from any IPC handler.
 */
export function addRecentWorkspace(workingDir: string): string[] {
  const existing = getRecentWorkspaces().filter((p) => p !== workingDir);
  const updated = [workingDir, ...existing].slice(0, MAX_RECENT);
  try {
    const storePath = resolveStorePath();
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {
    // Non-fatal — best effort
  }
  return updated;
}
