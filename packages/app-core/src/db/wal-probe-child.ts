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
 * Throwaway child process that attempts a database open — and therefore a WAL
 * replay — so that its parent never has to risk one.
 *
 * Spawned by `probeDbOpen()` in `./wal-recovery.ts`; see that file for why this
 * has to happen out-of-process. Contract:
 *
 *   exit 0  → opened and queried successfully; replay is safe in-process
 *   exit 1  → the native layer raised a catchable error, printed on stdout
 *             prefixed with the shared marker
 *   other   → this process was aborted or killed by the native layer, which is
 *             exactly the outcome the parent needs to detect and avoid
 *
 * Deliberately minimal: no logging framework and no app-core imports beyond the
 * shared marker, so that nothing but the database engine can influence how it
 * exits.
 */
import { createRequire } from 'node:module';
import type lbugModule from '@ladybugdb/core';
import { WAL_PROBE_ERROR_PREFIX } from './wal-probe-protocol.js';

type Engine = Pick<typeof lbugModule, 'Database' | 'Connection'>;

/**
 * The engine to probe with: ladybug, unless the parent passes
 * `riagraph <modulePath>` (see walProbeTarget in graph-engine.ts). Exactly one
 * engine is loaded — never both: the two native libraries embed the same C++
 * code, and a process holding both crashes on exit, which this probe would
 * misread as an unreplayable WAL.
 */
function engineFromArgs(): Engine {
  const load = createRequire(__filename);
  if (process.argv[3] !== 'riagraph') {
    const lbug = load('@ladybugdb/core') as { default?: Engine } & Engine;
    return lbug.default ?? lbug;
  }
  const modulePath = process.argv[4];
  if (!modulePath) throw new Error('RiaGraph binding not found');
  return load(modulePath) as Engine;
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    throw new Error('no database path argument');
  }
  const engine = engineFromArgs();

  // Opening is lazy in the binding — the WAL is not touched until a connection
  // forces initialisation, so the query below is load-bearing rather than a
  // sanity check. `show_tables` is the cheapest statement that guarantees the
  // catalog has been read back after replay.
  const db = new engine.Database(dbPath);
  const conn = new engine.Connection(db);
  try {
    const raw = await conn.query('CALL show_tables() RETURN *');
    const queryResult = Array.isArray(raw) ? raw[0] : raw;
    await queryResult.getAll();
    if (typeof queryResult.close === 'function') {
      await queryResult.close();
    }
  } finally {
    await conn.close();
    // Closing cleanly lets the engine checkpoint, so a WAL that replayed here is
    // already folded into the database file by the time the parent opens it.
    await db.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${WAL_PROBE_ERROR_PREFIX}${message.replace(/\r?\n/g, ' ')}\n`);
    process.exit(1);
  },
);
