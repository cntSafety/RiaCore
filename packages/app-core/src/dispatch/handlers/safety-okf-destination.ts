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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

export const OKF_MANIFEST = '.riacore-okf.json';
const PRODUCER = 'process:riacore-okf-export';
const managedRoots = new Set(['elements', 'tasks', 'requirements', 'functional-insufficiencies', 'triggering-conditions', 'notes', 'reviews', 'tags', 'unassigned']);
type EntryKind = 'file' | 'directory' | 'symlink';
interface Destination {
  exists: boolean;
  fingerprint: string;
  entries: Map<string, EntryKind>;
  managed: Set<string>;
}

function isHousekeeping(relative: string, kind: EntryKind): boolean {
  return relative === '.git' || (path.posix.basename(relative) === '.DS_Store' && kind === 'file');
}

/** Detect changes during staging without loading unrelated files into memory. */
async function snapshot(root: string): Promise<Omit<Destination, 'managed'>> {
  const entries = new Map<string, EntryKind>(), signature: string[] = [];
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('OKF destination must be a directory, not a file or symbolic link.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, fingerprint: '', entries };
    throw error;
  }
  async function walk(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const filename = path.join(dir, name), relative = path.relative(root, filename).split(path.sep).join('/');
      const stat = await fs.lstat(filename, { bigint: true });
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
      entries.set(relative, kind);
      // Git history and Finder metadata are never read, fingerprinted or modified.
      // Treat .git as opaque, including worktree gitdir files and symbolic links.
      if (isHousekeeping(relative, kind)) continue;
      signature.push(JSON.stringify([relative, kind, String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.mode),
        kind === 'symlink' ? await fs.readlink(filename) : '']));
      if (kind === 'directory') await walk(filename);
    }
  }
  await walk(root);
  return { exists: true, entries, fingerprint: createHash('sha256').update(signature.join('\n')).digest('hex') };
}

function metadata(text: string): Record<string, any> | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) return undefined;
  try { return parse(frontmatter[1]) as Record<string, any>; } catch { return undefined; }
}

function isManagedPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('.md') || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..')) return false;
  return value === 'analysis.md' || value === 'index.md' || managedRoots.has(value.split('/')[0]);
}

async function readManifest(root: string, entries: Map<string, EntryKind>): Promise<{ namespace: string; files: string[] } | undefined> {
  if (!entries.has(OKF_MANIFEST)) return undefined;
  const invalid = () => new Error('Invalid OKF export manifest. Existing files were not changed.');
  if (entries.get(OKF_MANIFEST) !== 'file') throw invalid();
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, OKF_MANIFEST), 'utf8')); }
  catch { throw invalid(); }
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 'riacore-okf-export' || manifest.version !== 1 ||
    typeof manifest.namespace !== 'string' || !manifest.namespace.trim() ||
    !Array.isArray(manifest.files) || !manifest.files.every(isManagedPath) ||
    !manifest.files.includes('analysis.md') || !manifest.files.includes('index.md')) throw invalid();
  return manifest;
}

/** Also recognizes bundles written before manifests were introduced. */
export async function inspectOkfDestination(root: string, namespace: string): Promise<Destination> {
  const state = await snapshot(root), managed = new Set<string>();
  if (!state.entries.size) return { ...state, managed };
  const manifest = await readManifest(root, state.entries);
  // Finder leaves hidden metadata behind when visible documents are deleted.
  // A valid stale manifest may be replaced for any analysis only once all data
  // files are gone. Do not carry its old ownership claims into the new export.
  if ([...state.entries].every(([file, kind]) => kind === 'directory' || isHousekeeping(file, kind) || (file === OKF_MANIFEST && manifest))) {
    return { ...state, managed };
  }
  if (state.entries.get('analysis.md') !== 'file' || state.entries.get('index.md') !== 'file') {
    throw new Error('This folder is not a RiaCore OKF export. Choose a new or empty folder, or an existing export of this analysis.');
  }
  const analysis = metadata(await fs.readFile(path.join(root, 'analysis.md'), 'utf8'));
  const index = metadata(await fs.readFile(path.join(root, 'index.md'), 'utf8'));
  if (analysis?.type !== 'Safety Analysis' || analysis.generated?.by !== PRODUCER || String(index?.okf_version) !== '0.2') {
    throw new Error('This folder is not a recognized RiaCore OKF export. Existing files were not changed.');
  }
  if (analysis.ria?.namespace !== namespace) throw new Error('This OKF folder belongs to a different analysis. Choose its original folder or a new destination.');
  if (manifest) {
    if (manifest.namespace !== namespace) throw new Error('Invalid OKF export manifest. Existing files were not changed.');
    manifest.files.forEach((file: string) => managed.add(file));
  } else {
    // Legacy bundles mark concept documents with our producer. Only their
    // navigation indexes are inferred; other documents and files remain private.
    for (const [file, kind] of state.entries) {
      if (kind !== 'file' || !isManagedPath(file) || path.posix.basename(file) === 'index.md') continue;
      const doc = metadata(await fs.readFile(path.join(root, file), 'utf8'));
      if (doc?.generated?.by !== PRODUCER) continue;
      managed.add(file);
      let dir = path.posix.dirname(file);
      while (dir !== '.') {
        const indexPath = `${dir}/index.md`;
        if (state.entries.get(indexPath) === 'file') managed.add(indexPath);
        dir = path.posix.dirname(dir);
      }
    }
    managed.add('index.md');
  }
  return { ...state, managed };
}

async function assertSafeParents(root: string, relative: string) {
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('OKF destination must be a directory, not a file or symbolic link.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parts = relative.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = path.join(root, ...parts.slice(0, i));
    try {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`OKF path conflicts with an existing file or symbolic link: ${parts.slice(0, i).join('/')}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** generated.at describes content changes, not another click on Export. */
function retainUnchangedDocument(original: string, generated: string): string {
  const oldMeta = metadata(original), newMeta = metadata(generated);
  const oldGenerated = oldMeta?.generated;
  if (oldGenerated?.by !== PRODUCER || newMeta?.generated?.by !== PRODUCER ||
    typeof oldGenerated.at !== 'string' || !Number.isFinite(Date.parse(oldGenerated.at))) return generated;
  const body = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/\r\n/g, '\n');
  delete oldMeta!.generated.at;
  delete newMeta!.generated.at;
  return isDeepStrictEqual(oldMeta, newMeta) && body(original) === body(generated) ? original : generated;
}

async function assertUnchangedDestination(root: string, previous: Destination) {
  const latest = await snapshot(root);
  if (latest.exists !== previous.exists || latest.fingerprint !== previous.fingerprint) {
    throw new Error('The destination changed during export. Existing files were not replaced; please retry.');
  }
}

async function installFile(source: string, target: string, installed: () => void) {
  try { await fs.link(source, target); installed(); }
  catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    // Some removable/network filesystems cannot hard-link. Exclusive creation
    // still prevents overwriting unrelated content and permits tracked rollback.
    const file = await fs.open(target, 'wx');
    installed();
    try { await file.writeFile(await fs.readFile(source)); }
    finally { await file.close(); }
  }
}

/** Stage changed files only; untouched files retain their bytes, inode and mtime. */
export async function publishSafetyOkf(
  root: string, namespace: string, files: Map<string, string>, previous: Destination,
): Promise<string[]> {
  const desired = new Map(files);
  desired.set(OKF_MANIFEST, JSON.stringify({
    format: 'riacore-okf-export', version: 1, namespace, files: [...files.keys()].sort(),
  }, null, 2) + '\n');
  const changed = new Map<string, string>();
  const removed = [...previous.managed].filter(file => !desired.has(file) && previous.entries.has(file));
  for (const [relative, generated] of desired) {
    await assertSafeParents(root, relative);
    const kind = previous.entries.get(relative);
    if (kind && !previous.managed.has(relative) && relative !== OKF_MANIFEST) {
      throw new Error(`Failed to write OKF file ${relative}: an unrelated file already exists at this path.`);
    }
    if (kind === 'directory') throw new Error(`Failed to write OKF file ${relative}: a directory already exists at this path.`);
    const original = kind === 'file' ? await fs.readFile(path.join(root, relative), 'utf8') : undefined;
    const content = original === undefined ? generated : retainUnchangedDocument(original, generated);
    if (content !== original) changed.set(relative, content);
  }
  for (const relative of removed) {
    await assertSafeParents(root, relative);
    if (previous.entries.get(relative) === 'directory') throw new Error(`Cannot remove an OKF document replaced by a directory: ${relative}`);
  }
  await assertUnchangedDestination(root, previous);
  // A no-op export does not even create a staging directory or touch the manifest.
  if (!changed.size && !removed.length) return [...desired.keys()].sort();

  await fs.mkdir(path.dirname(root), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(root), '.riacore-okf-'));
  const installed: string[] = [], backedUp: string[] = [];
  const createdDirectories = new Set<string>();
  let preserveRecovery = false;
  async function makeParents(relative: string) {
    const dirs = [root];
    let current = root;
    for (const segment of relative.split('/').slice(0, -1)) { current = path.join(current, segment); dirs.push(current); }
    for (const dir of dirs) {
      try { await fs.mkdir(dir); createdDirectories.add(dir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('OKF path conflicts with an existing file or symbolic link.');
      }
    }
  }
  try {
    for (const [relative, content] of changed) {
      try {
        const filename = path.join(staging, 'new', relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, content, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        throw new Error(`Failed to write OKF file ${relative}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await assertUnchangedDestination(root, previous);
    for (const relative of [...removed, ...changed.keys()]) {
      if (!previous.entries.has(relative)) continue;
      await assertSafeParents(root, relative);
      const backup = path.join(staging, 'previous', relative);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.rename(path.join(root, relative), backup);
      backedUp.push(relative);
    }
    for (const relative of changed.keys()) {
      await makeParents(relative);
      // Exclusive publication never overwrites a file appearing after inspection.
      await installFile(path.join(staging, 'new', relative), path.join(root, relative), () => installed.push(relative));
    }
  } catch (error) {
    try {
      for (const relative of installed.reverse()) await fs.unlink(path.join(root, relative));
      for (const relative of backedUp.reverse()) {
        await installFile(path.join(staging, 'previous', relative), path.join(root, relative), () => {});
      }
      for (const dir of [...createdDirectories].sort((a, b) => b.length - a.length)) {
        try { await fs.rmdir(dir); }
        catch (cleanup) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cleanup as NodeJS.ErrnoException).code || '')) throw cleanup; }
      }
    } catch {
      preserveRecovery = true;
      throw new Error(`OKF refresh failed. Previous documents are preserved at ${path.join(staging, 'previous')}. ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  } finally {
    if (!preserveRecovery) await fs.rm(staging, { recursive: true, force: true });
  }
  // Remove only empty directories left by deleted/renamed generated documents.
  const obsoleteDirectories = new Set<string>();
  for (const file of removed) {
    let dir = path.posix.dirname(file);
    while (dir !== '.') { obsoleteDirectories.add(dir); dir = path.posix.dirname(dir); }
  }
  for (const dir of [...obsoleteDirectories].sort((a, b) => b.length - a.length)) {
    try { await fs.rmdir(path.join(root, dir)); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  }
  return [...desired.keys()].sort();
}
