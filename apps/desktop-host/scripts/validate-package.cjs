const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MINIMUM_MACOS_VERSION, validateMacNativeLibraries } = require('./mac-native-libraries.cjs');
const { validateWindowsVcRuntime } = require('./windows-vc-runtime.cjs');
const { validateRuntimeNotices } = require('./runtime-notices.cjs');
const { validateReleaseLicenses } = require('./license-bundle.cjs');

const desktopHostDir = path.resolve(__dirname, '..');
const outputDir = path.join(desktopHostDir, 'dist-electron');

function fail(message) {
  throw new Error(`[RiaCore] Package validation failed: ${message}`);
}

function parsePlatform() {
  const index = process.argv.indexOf('--platform');
  const platform = index >= 0 ? process.argv[index + 1] : null;
  if (!['mac', 'win', 'linux'].includes(platform)) {
    fail('use --platform mac, --platform win, or --platform linux');
  }
  return platform;
}

function findMacApp() {
  if (!fs.existsSync(outputDir)) fail(`output directory is missing: ${outputDir}`);
  for (const directory of fs.readdirSync(outputDir)) {
    const candidate = path.join(outputDir, directory, 'RiaCore.app');
    if (fs.existsSync(candidate)) return candidate;
  }
  fail(`RiaCore.app was not found under ${outputDir}`);
}

function countSymlinks(rootDir) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        count++;
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  };
  walk(rootDir);
  return count;
}

function findNestedDugiteGit(rootDir) {
  const matches = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.name === 'git' && path.basename(dir) === 'dugite') {
        matches.push(entryPath);
      } else {
        walk(entryPath);
      }
    }
  };
  walk(rootDir);
  return matches;
}

function directorySize(rootDir) {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(entryPath);
      else bytes += fs.statSync(entryPath).size;
    }
  };
  walk(rootDir);
  return bytes;
}

function validateDatabase(nodeBinary, appDir, platform) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(DYLD_|LD_|NODE_PATH$|NODE_OPTIONS$)/i.test(key)) delete env[key];
  }
  // Do not allow a developer's PATH or global Node packages to satisfy dependencies.
  if (platform === 'win') {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  } else {
    env.PATH = '/usr/bin:/bin';
  }
  const script = `
    const assert = require('node:assert/strict');
    const { Database, Connection } = require(process.argv[1]);
    (async () => {
      const database = new Database(':memory:', 64 * 1024 * 1024);
      const connection = new Connection(database);
      try {
        const result = await connection.query('RETURN 42 AS answer');
        try { assert.equal(Number((await result.getAll())[0].answer), 42); }
        finally { await result.close(); }
      } finally {
        await connection.close();
        await database.close();
      }
      console.log('Database native module loaded and query passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = execFileSync(nodeBinary, ['-e', script, path.join(appDir, 'node_modules', '@ladybugdb', 'core')], {
      cwd: appDir, env, encoding: 'utf8', timeout: 60_000,
    });
    console.log(`[RiaCore]   ${result.trim()}`);
  } catch (error) {
    fail(`bundled Node cannot use the packaged database: ${error.stderr?.toString() || error.message}`);
  }
}

function main() {
  const platform = parsePlatform();
  const rootIndex = process.argv.indexOf('--package-root');
  if (rootIndex >= 0 && !process.argv[rootIndex + 1]) fail('--package-root requires a path');
  const packageRoot = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : platform === 'mac'
    ? findMacApp()
    : path.join(outputDir, platform === 'win' ? 'win-unpacked' : 'linux-unpacked');
  const resourcesDir = platform === 'mac'
    ? path.join(packageRoot, 'Contents', 'Resources')
    : path.join(packageRoot, 'resources');

  if (!fs.existsSync(resourcesDir)) fail(`resources directory is missing: ${resourcesDir}`);
  validateRuntimeNotices(resourcesDir, platform);
  const licenseCount = validateReleaseLicenses(resourcesDir);
  console.log(`[RiaCore]   GPL release license and ${licenseCount} third-party license entries verified`);
  console.log('[RiaCore]   Third-party runtime notices and platform license files are present');

  const gitDir = path.join(resourcesDir, 'git');
  const gitBinary = path.join(gitDir, platform === 'win' ? 'cmd/git.exe' : 'bin/git');
  const nodeBinary = path.join(
    resourcesDir,
    'node-sidecar',
    platform === 'win' ? 'node.exe' : 'node',
  );
  const appDir = path.join(resourcesDir, 'app');

  if (!fs.existsSync(gitBinary)) fail(`portable Git is missing: ${gitBinary}`);
  if (!fs.existsSync(nodeBinary)) fail(`Node sidecar is missing: ${nodeBinary}`);

  const duplicates = findNestedDugiteGit(appDir);
  if (duplicates.length > 0) {
    fail(`duplicate Dugite Git payload found at ${duplicates.join(', ')}`);
  }

  const symlinkCount = countSymlinks(gitDir);
  if (platform !== 'win' && symlinkCount === 0) {
    fail('portable Git contains no symlinks; it was probably copied with dereference enabled');
  }

  if (platform === 'mac') {
    const minimum = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', path.join(packageRoot, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    if (minimum !== MINIMUM_MACOS_VERSION) fail(`LSMinimumSystemVersion must be ${MINIMUM_MACOS_VERSION}, found: ${minimum}`);
    const nativeFiles = validateMacNativeLibraries(packageRoot);
    console.log(`[RiaCore]   ${nativeFiles.length} native binaries have no unbundled non-system dependencies`);
    const architectures = execFileSync('lipo', ['-archs', nodeBinary], {
      encoding: 'utf8',
    }).trim();
    if (architectures !== 'arm64') {
      fail(`Node sidecar must be arm64-only, found: ${architectures}`);
    }

    // A successful DMG build does not guarantee a valid app signature. Check
    // standalone executables explicitly too: code under Resources can be sealed
    // as data, rather than recursively verified as nested code by --deep.
    // Do not use spctl as a gate: ad-hoc signing provides no Developer ID trust.
    for (const target of new Set([packageRoot, nodeBinary, gitBinary, ...nativeFiles.filter(file => file.endsWith('.node') || file.endsWith('.dylib'))])) {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', target], {
        stdio: 'inherit',
        timeout: 60_000,
      });
    }
    console.log('[RiaCore]   Verified macOS app, Node sidecar, and portable Git signatures');
  }

  if (platform === 'win') {
    const count = validateWindowsVcRuntime(resourcesDir);
    console.log(`[RiaCore]   ${count} Visual C++ x64 runtime DLLs are bundled and unmodified`);
  }
  validateDatabase(nodeBinary, appDir, platform);

  const gitVersion = execFileSync(gitBinary, ['--version'], { encoding: 'utf8' }).trim();
  const nodeVersion = execFileSync(nodeBinary, ['--version'], { encoding: 'utf8' }).trim();
  const gitSizeMiB = (directorySize(gitDir) / 1024 / 1024).toFixed(1);

  console.log(`[RiaCore] Validated ${packageRoot}`);
  console.log(`[RiaCore]   ${gitVersion}; ${gitSizeMiB} MiB; ${symlinkCount} symlinks`);
  console.log(`[RiaCore]   Node ${nodeVersion}; ${platform === 'mac' ? 'arm64-only' : process.arch}`);
  console.log('[RiaCore]   No duplicate node_modules/dugite/git payload');
}

main();
