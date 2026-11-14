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
/** Recoverable publication for bounded CLI safety writes. The DB is a cache;
 * the committed snapshot is authoritative after an interrupted publication. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { graphDbFiles } from '../db/graph-engine.js';
import { writeFileAtomic } from './persistor-helpers.js';

import { writeSafetyRequestReceipt, type SafetyRequestReceipt } from '../safety/request-receipts.js';

const JOURNAL = '.ria-write';
interface Journal { version: 1; pid: number; host: string; token: string; phase: 'preparing' | 'publishing' | 'committed'; hadSnapshot: boolean; receipt?: SafetyRequestReceipt }
export function snapshotFingerprint(directory: string): string {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Snapshot root is a symbolic link: ${directory}`);
  const hash = createHash('sha256');
  function visit(dir: string, parts: string[]) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Snapshot contains a symbolic link: ${file}`);
      const next = [...parts, name];
      if (stat.isDirectory()) visit(file, next);
      else if (stat.isFile()) { hash.update(JSON.stringify(next)); hash.update(fs.readFileSync(file)); }
      else throw new Error(`Unsupported snapshot entry: ${file}`);
    }
  }
  visit(directory, []);
  return hash.digest('hex');
}
function readJournal(root: string): Journal {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'journal.json'), 'utf8')) as Journal;
  if (data.version !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.host !== 'string'
      || typeof data.token !== 'string' || !/^[0-9a-f-]{36}$/.test(data.token) || typeof data.hadSnapshot !== 'boolean'
      || !['preparing', 'publishing', 'committed'].includes(data.phase)) throw new Error('Invalid safety write recovery journal; preserve it for inspection');
  return data;
}
function writeJournal(root: string, data: Journal) {
  writeFileAtomic(path.join(root, 'journal.json'), JSON.stringify(data));
}
function ownerAlive(data: Journal): boolean {
  if (data.host !== os.hostname()) return true; // Never steal a lease on a shared filesystem.
  try { process.kill(data.pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Must run before lifecycle classification/open. Active owners are refused.
 * Recovery is idempotent: keep its journal until snapshot AND cache are settled. */
export function recoverAtomicPublication(workingDir: string, ownerToken?: string): 'committed' | 'rolled_back' | undefined {
  const root = path.join(workingDir, JOURNAL);
  if (!fs.existsSync(root)) return;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Recovery journal must not be a symbolic link');
  const journal = readJournal(root);
  if (journal.token !== ownerToken && ownerAlive(journal)) throw new Error('Workspace busy: a safety write is in progress');
  // Fail closed if another opener is recovering, or recovery itself was interrupted.
  // Never allow two processes to restore files or quarantine a cache concurrently.
  try { fs.writeFileSync(path.join(root, 'recovery.lock'), String(process.pid), { flag: 'wx' }); }
  catch { throw new Error('Workspace recovery is already running or was interrupted; preserve .ria-write for inspection'); }
  const live = path.join(workingDir, 'ria-data');
  const backup = path.join(root, 'previous');
  if (journal.phase !== 'committed') {
    if (fs.existsSync(backup)) {
      fs.rmSync(live, { recursive: true, force: true });
      // Copy, not rename: a crash during restoration can repeat from the backup.
      fs.cpSync(backup, live, { recursive: true });
    } else if (!journal.hadSnapshot && journal.phase === 'publishing') {
      fs.rmSync(live, { recursive: true, force: true });
    } else if (journal.hadSnapshot && !fs.existsSync(live)) {
      throw new Error('Safety recovery snapshot is missing; preserve the journal for inspection');
    }
  } else if (!fs.existsSync(path.join(live, 'manifest.json'))) {
    throw new Error('Committed safety snapshot is missing; preserve the journal for inspection');
  }
  // A crash may have committed the DB before the snapshot decision. Quarantine
  // its cache files rather than trusting dirty-marker sync or deleting evidence.
  if (journal.phase !== 'preparing') {
    const cache = path.join(workingDir, `.ria-recovered-${journal.token}`);
    for (const file of graphDbFiles(path.join(workingDir, 'db'))) {
      if (fs.existsSync(file)) {
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(path.join(cache, '.gitignore'), '*\n');
        const target = path.join(cache, path.basename(file));
        if (fs.existsSync(target)) throw new Error('Recovery cache conflict; preserve both copies for inspection');
        fs.renameSync(file, target);
      }
    }
  }
  if (journal.phase === 'committed' && journal.receipt) writeSafetyRequestReceipt(workingDir, journal.receipt);
  fs.rmSync(root, { recursive: true, force: true });
  return journal.phase === 'committed' ? 'committed' : 'rolled_back';
}

export function beginAtomicPublication(workingDir: string) {
  const live = path.join(workingDir, 'ria-data');
  const fingerprint = snapshotFingerprint(live);
  const root = path.join(workingDir, JOURNAL);
  const temporary = fs.mkdtempSync(path.join(workingDir, '.ria-write-'));
  const journal: Journal = { version: 1, pid: process.pid, host: os.hostname(), token: randomUUID(), phase: 'preparing', hadSnapshot: fs.existsSync(live) };
  fs.writeFileSync(path.join(temporary, '.gitignore'), '*\n');
  writeJournal(temporary, journal);
  try { fs.renameSync(temporary, root); }
  catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
  const stagingDir = path.join(root, 'candidate');
  try {
    fs.mkdirSync(stagingDir);
    if (journal.hadSnapshot) fs.cpSync(live, path.join(stagingDir, 'ria-data'), { recursive: true });
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  return {
    stagingDir,
    token: journal.token,
    publish() {
      if (snapshotFingerprint(live) !== fingerprint) throw new Error('Snapshot changed during the request; refusing publication');
      journal.phase = 'publishing'; writeJournal(root, journal);
      if (journal.hadSnapshot) fs.renameSync(live, path.join(root, 'previous'));
      fs.renameSync(path.join(stagingDir, 'ria-data'), live);
    },
    commit(receipt?: SafetyRequestReceipt) { journal.phase = 'committed'; journal.receipt = receipt; writeJournal(root, journal); },
    finish() {
      if (journal.receipt) writeSafetyRequestReceipt(workingDir, journal.receipt);
      const finished = path.join(workingDir, `.ria-write-finished-${journal.token}`);
      fs.renameSync(root, finished);
      fs.rmSync(finished, { recursive: true, force: true });
    },
    abort() {
      if (journal.phase === 'preparing') fs.rmSync(root, { recursive: true, force: true });
      else throw new Error('Publication started; close the database before recovery');
    },
  };
}
