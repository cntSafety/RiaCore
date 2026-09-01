const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

function main() {
  const platform = parsePlatform();
  const packageRoot = platform === 'mac'
    ? findMacApp()
    : path.join(outputDir, platform === 'win' ? 'win-unpacked' : 'linux-unpacked');
  const resourcesDir = platform === 'mac'
    ? path.join(packageRoot, 'Contents', 'Resources')
    : path.join(packageRoot, 'resources');

  if (!fs.existsSync(resourcesDir)) fail(`resources directory is missing: ${resourcesDir}`);

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
    for (const target of [packageRoot, nodeBinary, gitBinary]) {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', target], {
        stdio: 'inherit',
        timeout: 60_000,
      });
    }
    console.log('[RiaCore]   Verified macOS app, Node sidecar, and portable Git signatures');
  }

  const gitVersion = execFileSync(gitBinary, ['--version'], { encoding: 'utf8' }).trim();
  const nodeVersion = execFileSync(nodeBinary, ['--version'], { encoding: 'utf8' }).trim();
  const gitSizeMiB = (directorySize(gitDir) / 1024 / 1024).toFixed(1);

  console.log(`[RiaCore] Validated ${packageRoot}`);
  console.log(`[RiaCore]   ${gitVersion}; ${gitSizeMiB} MiB; ${symlinkCount} symlinks`);
  console.log(`[RiaCore]   Node ${nodeVersion}; ${platform === 'mac' ? 'arm64-only' : process.arch}`);
  console.log('[RiaCore]   No duplicate node_modules/dugite/git payload');
}

main();
