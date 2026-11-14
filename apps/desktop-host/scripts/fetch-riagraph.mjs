#!/usr/bin/env node
/**
 * Fetch the RiaGraph Node.js binding pinned in apps/desktop-host/riagraph.lock.json and stage it
 * where RiaCore finds it: vendor/riagraph-core/<platform>-<arch>/.
 *
 * RiaGraph publishes self-contained bindings (JS wrapper, riagjs.node with
 * OpenSSL linked in, package.json, LICENSE, OPENSSL-LICENSE.txt,
 * BUILD_INFO.json) as GitHub release assets of cntSafety/RiaGraph, built by its
 * `nodejs-binaries.yml` workflow. The lock names the release, and the file and
 * SHA-256 of each platform's archive; nothing unverified is staged.
 *
 *   node apps/desktop-host/scripts/fetch-riagraph.mjs                  this machine's platform
 *   node apps/desktop-host/scripts/fetch-riagraph.mjs --platform linux-x64
 *   node apps/desktop-host/scripts/fetch-riagraph.mjs --all            every platform in the lock
 *   node apps/desktop-host/scripts/fetch-riagraph.mjs --from <archive> stage a local archive (checked against the lock)
 *   node apps/desktop-host/scripts/fetch-riagraph.mjs --check          verify what is staged; download nothing
 *
 * The repository is public, so downloads work unauthenticated. An optional token
 * from RIAGRAPH_TOKEN, GH_TOKEN or GITHUB_TOKEN (or else `gh auth token`) is used
 * when present, mainly to avoid GitHub's low unauthenticated rate limit.
 * A platform that is already staged from the pinned commit is left alone.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const lockFile = path.join(scriptDir, '..', 'riagraph.lock.json');
const vendorDir = path.join(repoRoot, 'vendor', 'riagraph-core');

/** The platforms RiaCore packages: what electron-builder.yml targets. */
export const PACKAGED_PLATFORMS = ['win32-x64', 'darwin-arm64', 'linux-x64'];

function fail(message) {
  console.error(`fetch-riagraph: ${message}`);
  process.exit(1);
}

export function readLock(file = lockFile) {
  const lock = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const key of ['repository', 'release', 'version', 'commit', 'assets']) {
    if (!lock[key]) throw new Error(`${file}: "${key}" is missing`);
  }
  return lock;
}

/**
 * bsdtar, which ships with Windows 10+ and macOS, and GNU tar on Linux. On
 * Windows the system one is named explicitly: a GNU tar from Git Bash or
 * MSYS earlier on PATH reads `C:\...` as a remote host.
 */
export function tarExecutable() {
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(system)) return system;
  }
  return 'tar';
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readBuildInfo(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'BUILD_INFO.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** Whether `dir` holds the pinned build for `platform`; the reason when not. */
export function stagedMismatch(dir, lock, platform) {
  if (!fs.existsSync(path.join(dir, 'riagjs.node'))) return 'not staged';
  const info = readBuildInfo(dir);
  if (!info) return 'BUILD_INFO.json is missing';
  if (info.commit !== lock.commit) return `staged from ${info.commit}, the lock pins ${lock.commit}`;
  if (info.platform !== platform) return `staged for ${info.platform}`;
  return null;
}

function token() {
  for (const name of ['RIAGRAPH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[name]) return process.env[name];
  }
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

async function download(lock, asset, target) {
  const auth = token();
  const api = `https://api.github.com/repos/${lock.repository}`;
  const headers = {
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'riacore-fetch-riagraph',
  };
  const release = await fetch(`${api}/releases/tags/${encodeURIComponent(lock.release)}`, { headers: { ...headers, Accept: 'application/vnd.github+json' } });
  if (!release.ok) fail(`release ${lock.release} of ${lock.repository}: HTTP ${release.status} ${await release.text()}`);
  const found = (await release.json()).assets?.find((a) => a.name === asset.file);
  if (!found) fail(`release ${lock.release} has no asset ${asset.file}`);
  // The asset endpoint redirects to storage; fetch drops the token on that cross-origin hop.
  const response = await fetch(`${api}/releases/assets/${found.id}`, { headers: { ...headers, Accept: 'application/octet-stream' } });
  if (!response.ok) fail(`download of ${asset.file}: HTTP ${response.status}`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

/** Verify `archive` against the lock and unpack it into `outDir` (replacing it). */
export function stageArchive(archive, lock, platform, outDir) {
  const asset = lock.assets[platform];
  if (!asset) throw new Error(`the lock has no asset for ${platform}`);
  const actual = sha256(archive);
  if (actual !== asset.sha256) {
    throw new Error(`${path.basename(archive)}: SHA-256 ${actual} does not match the lock's ${asset.sha256}`);
  }
  const unpack = fs.mkdtempSync(path.join(os.tmpdir(), 'riagraph-unpack-'));
  try {
    execFileSync(tarExecutable(), ['-xzf', path.resolve(archive), '-C', unpack], { stdio: 'inherit' });
    const binding = path.join(unpack, 'riagraph-core');
    const problem = stagedMismatch(binding, lock, platform);
    if (problem) throw new Error(`${path.basename(archive)} does not hold the pinned build: ${problem}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(binding, outDir, { recursive: true });
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`${name} needs a value`);
    return args[i + 1];
  };
  const lock = readLock();
  const current = `${process.platform}-${process.arch}`;
  const platforms = args.includes('--all') ? Object.keys(lock.assets) : [option('--platform') ?? current];
  for (const platform of platforms) {
    if (!lock.assets[platform]) fail(`the lock pins no build for ${platform} (it has ${Object.keys(lock.assets).join(', ')})`);
  }

  if (args.includes('--check')) {
    let bad = 0;
    for (const platform of platforms) {
      const problem = stagedMismatch(path.join(vendorDir, platform), lock, platform);
      console.log(`${platform}: ${problem ?? `RiaGraph ${lock.version} (${lock.commit.slice(0, 9)}) staged`}`);
      if (problem) bad += 1;
    }
    process.exit(bad === 0 ? 0 : 1);
  }

  const from = option('--from');
  if (from && platforms.length !== 1) fail('--from stages one platform; name it with --platform');
  for (const platform of platforms) {
    const outDir = path.join(vendorDir, platform);
    if (!from && !stagedMismatch(outDir, lock, platform)) {
      console.log(`${platform}: RiaGraph ${lock.version} already staged`);
      continue;
    }
    let archive = from;
    let tmp = null;
    if (!archive) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riagraph-download-'));
      archive = path.join(tmp, lock.assets[platform].file);
      console.log(`${platform}: downloading ${lock.assets[platform].file} from ${lock.repository} ${lock.release}`);
      await download(lock, lock.assets[platform], archive);
    }
    try {
      stageArchive(archive, lock, platform, outDir);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`${platform}: RiaGraph ${lock.version} (${lock.commit.slice(0, 9)}) staged in ${path.relative(repoRoot, outDir)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
}
