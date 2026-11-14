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
export interface DbStatus {
  state: 'closed' | 'open' | 'error';
  path?: string;
  error?: string;
  schemaVersion?: string;
  expectedSchemaVersion?: string;
  readOnly?: boolean;
  migrationNeeded?: boolean;
  warning?: string;
  /** The graph engine(s) the open database runs on (state `open`). */
  engine?: DbEngineInfo;
}

/** Graph engine of an open database, from the workspace's graph-engine.json. */
export interface DbEngineInfo {
  /** The master: its results are what the application sees. */
  master: 'ladybug' | 'riagraph';
  /** Engines running alongside the master for comparison (shadow mode); usually none. */
  shadows: Array<'ladybug' | 'riagraph'>;
  /** Engine version(s), e.g. `riagraph 0.22.0` or `ladybug 0.19.1 + riagraph 0.22.0`. */
  version: string;
  /** The graph-engine.json the selection came from; absent for the default engine. */
  config?: string;
}
