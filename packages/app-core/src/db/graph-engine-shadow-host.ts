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
 * Child process that hosts the RiaGraph engine for dual mode
 * (see graph-engine-shadow.ts for the parent side and why it exists).
 *
 * Loads the RiaGraph binding from the module path in argv[2] and executes
 * the requests its parent sends over the IPC channel ('advanced'
 * serialization, so bigint, Date, Map and byte arrays cross unchanged).
 *
 * Deliberately dependency-free — node built-ins only — so it runs both
 * compiled (dist/db/graph-engine-shadow-host.js) and straight from source
 * under vitest (Node strips the types), and nothing but the engine can
 * influence how it behaves or exits.
 */
import { createRequire } from 'node:module';

interface Binding {
  Database: new (path: string, ...rest: unknown[]) => { close(): Promise<void> };
  Connection: new (db: unknown) => {
    query(s: string): Promise<unknown>;
    prepare(s: string): Promise<unknown>;
    execute(ps: unknown, params?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  };
}

type Request =
  | { id: number; op: 'openDb'; db: number; path: string; args: unknown[] }
  | { id: number; op: 'closeDb'; db: number }
  | { id: number; op: 'connect'; conn: number; db: number }
  | { id: number; op: 'closeConn'; conn: number }
  | { id: number; op: 'query'; conn: number; statement: string }
  | { id: number; op: 'prepare'; conn: number; ps: number; statement: string }
  | { id: number; op: 'execute'; conn: number; ps: number; params?: Record<string, unknown> };

interface QueryResultLike { getAll(): Promise<Record<string, unknown>[]>; close(): void | Promise<void> }

const modulePath = process.argv[2];
// argv[1] (this script) rather than __filename: run from source, Node treats
// this file as an ES module, where __filename does not exist.
const loaded = createRequire(process.argv[1])(modulePath) as Binding & { default?: Binding };
// ladybug's package exposes the binding as its default export, RiaGraph's as the module itself.
const binding: Binding = loaded.default ?? loaded;
const dbs = new Map<number, InstanceType<Binding['Database']>>();
const conns = new Map<number, InstanceType<Binding['Connection']>>();
const statements = new Map<number, unknown>();

/** Read every result fully (the parent compares whole results) and release it. */
async function drain(raw: unknown): Promise<{ multi: boolean; rows: Record<string, unknown>[][] }> {
  const list = (Array.isArray(raw) ? raw : [raw]) as QueryResultLike[];
  const rows: Record<string, unknown>[][] = [];
  for (const result of list) {
    rows.push(await result.getAll());
    await result.close();
  }
  return { multi: Array.isArray(raw), rows };
}

function need<T>(map: Map<number, T>, key: number, what: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`RiaGraph shadow host: unknown ${what} ${key}`);
  return value;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'openDb':
      dbs.set(req.db, new binding.Database(req.path, ...req.args));
      return null;
    case 'closeDb': {
      const db = dbs.get(req.db);
      dbs.delete(req.db);
      if (db) await db.close();
      return null;
    }
    case 'connect':
      conns.set(req.conn, new binding.Connection(need(dbs, req.db, 'database')));
      return null;
    case 'closeConn': {
      const conn = conns.get(req.conn);
      conns.delete(req.conn);
      if (conn) await conn.close();
      return null;
    }
    case 'query':
      return drain(await need(conns, req.conn, 'connection').query(req.statement));
    case 'prepare':
      statements.set(req.ps, await need(conns, req.conn, 'connection').prepare(req.statement));
      return null;
    case 'execute': {
      const ps = need(statements, req.ps, 'prepared statement');
      return drain(await need(conns, req.conn, 'connection').execute(ps, req.params ?? {}));
    }
  }
}

process.on('message', (req: Request) => {
  handle(req).then(
    (value) => process.send?.({ id: req.id, ok: true, value }),
    (err: unknown) => process.send?.({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
});

// The parent closed the channel (it closed the database, exited, or crashed):
// release the engine and leave.
process.on('disconnect', () => {
  void (async () => {
    for (const conn of conns.values()) { try { await conn.close(); } catch { /* exiting */ } }
    for (const db of dbs.values()) { try { await db.close(); } catch { /* exiting */ } }
    process.exit(0);
  })();
});

process.send?.({ id: 0, ok: true, value: 'ready' });
