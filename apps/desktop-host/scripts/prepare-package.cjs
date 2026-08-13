const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const desktopHostDir = path.resolve(__dirname, '..');
const rendererDir = path.join(repoRoot, 'apps', 'renderer');
const profilesDir = path.join(repoRoot, 'packages', 'profiles');
const releaseDir = path.join(desktopHostDir, '.release');
const appDir = path.join(releaseDir, 'app');
const sidecarDir = path.join(releaseDir, 'sidecar');
const sourceIconPath = path.join(desktopHostDir, 'logo', 'icon_1024.png');
const buildIconsDir = path.join(desktopHostDir, 'build', 'icons');

/**
 * Workspace packages that are copied as source (dist/ + package.json).
 * These are handled by copyWorkspacePackage and excluded from the
 * external dependency walk.
 */
const workspacePackages = [
  { name: '@riacore/app-contracts', dir: path.join(repoRoot, 'packages', 'app-contracts') },
  { name: '@riacore/importer-sdk', dir: path.join(repoRoot, 'packages', 'importer-sdk') },
  { name: '@riacore/importer-arxml', dir: path.join(repoRoot, 'packages', 'importers', 'arxml-core') },
  { name: '@riacore/importer-sn', dir: path.join(repoRoot, 'packages', 'importers', 'sn-core') },
  { name: '@riacore/importer-sysml-v2', dir: path.join(repoRoot, 'packages', 'importers', 'sysml-v2-core') },
  // Workspace packages, so they must be staged as dist/ + package.json like their
  // siblings. Left off this list they were classified as *external* deps and copied
  // wholesale, which dragged their pnpm node_modules junction farms into the package.
  // Only dist/ is needed at runtime: sysml-language's main is dist/index.js, and its
  // sysml-2ls-grammar/ (Langium source grammar) and syntaxes/ (TextMate) directories
  // are build-time and editor assets.
  { name: '@riacore/importer-sysml-v2-textual', dir: path.join(repoRoot, 'packages', 'importers', 'sysml-v2-textual') },
  { name: '@riacore/sysml-language', dir: path.join(repoRoot, 'packages', 'sysml-language') },
  { name: '@riacore/app-core', dir: path.join(repoRoot, 'packages', 'app-core') },
];

const workspacePackageNames = new Set(workspacePackages.map((p) => p.name));

// ---------------------------------------------------------------------------
// Dependency graph walker
// ---------------------------------------------------------------------------

/**
 * Resolve a package name to its on-disk directory using Node's own module
 * resolution logic, starting from `fromDir`.
 */
function resolvePackageDir(name, fromDir) {
  try {
    // require.resolve returns the main entry point; we want the package root.
    const mainFile = require.resolve(name, { paths: [fromDir] });
    // Walk up until we find a directory whose package.json has the right name.
    let dir = path.dirname(mainFile);
    while (dir !== path.dirname(dir)) {
      const pkgJsonPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (pkgJson.name === name) return dir;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // require.resolve failed — try a direct node_modules path walk as fallback
  }

  // Fallback: walk up from fromDir looking in node_modules/
  const nameParts = name.split('/');
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', ...nameParts);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Recursively collect all runtime (non-workspace, non-dev) dependencies
 * reachable from `startDirs`.
 *
 * Returns:
 *   topLevel: Map<packageName, resolvedDir>   — goes into app/node_modules/<name>
 *   nested:   Array<{ dependentName, name, sourceDir }>
 *             — version conflicts that must be nested under app/node_modules/<dependentName>/node_modules/<name>
 *
 * Version conflicts arise in pnpm workspaces: if package A resolved to dep@v2
 * but the hoisted dep@v3 was already recorded, A needs its own nested copy of dep@v2
 * so that `require('dep')` from A's directory resolves to the right version.
 */
function collectExternalDeps(startDirs) {
  const topLevel = new Map();   // name -> resolvedDir  (hoisted version)
  // nested: "dependentName|name" -> sourceDir
  // We use a map so we don't duplicate the same (dependent, dep, version) triple.
  const nestedMap = new Map();
  const visited = new Set();    // "name:resolvedDir" keys already enqueued
  const queue = [];             // { name, fromDir, dependentName }

  function enqueueDeps(pkgJsonPath, fromDir, dependentName) {
    if (!fs.existsSync(pkgJsonPath)) return;
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    // Include both `dependencies` and `peerDependencies` — some packages
    // (e.g. @ai-sdk/* providers) declare shared runtime deps as peers.
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.peerDependencies,
    };
    for (const dep of Object.keys(allDeps)) {
      if (!workspacePackageNames.has(dep)) {
        queue.push({ name: dep, fromDir, dependentName });
      }
    }
  }

  // Seed: runtime deps of every workspace package + desktop-host itself
  for (const dir of startDirs) {
    enqueueDeps(path.join(dir, 'package.json'), dir, null);
  }

  while (queue.length > 0) {
    const { name, fromDir, dependentName } = queue.shift();

    const pkgDir = resolvePackageDir(name, fromDir);
    if (!pkgDir) {
      // Likely an optional peer dependency that isn't installed — skip silently.
      continue;
    }

    const existingDir = topLevel.get(name);
    if (!existingDir) {
      // First time we see this package name — hoist it.
      topLevel.set(name, pkgDir);
    } else if (existingDir !== pkgDir) {
      // Version conflict: a different version of this package was already hoisted.
      // The dependent package needs a nested copy — record it for EVERY dependent
      // that requires this alternate version.
      if (dependentName) {
        const nestedKey = `${dependentName}|${name}`;
        if (!nestedMap.has(nestedKey)) {
          nestedMap.set(nestedKey, { dependentName, name, sourceDir: pkgDir });
          console.log(`[RiaCore]   ~ nested ${name} under ${dependentName} (version conflict)`);
        }
      }
      // Don't recurse further from this nested copy's version — its own sub-deps
      // would also need nesting under the right parent.  For the packages we've
      // seen in practice (readable-stream@2, tar, minipass, mkdirp…) this is safe
      // because those sub-deps are either already hoisted at the right version or
      // have no further conflicts.  Extend this logic if deeper nesting is needed.
      continue;
    }

    // Avoid re-walking the same (package, resolvedDir) pair.
    const visitKey = `${name}:${pkgDir}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    // Recurse into this package's own runtime deps, attributing them to this package.
    enqueueDeps(path.join(pkgDir, 'package.json'), pkgDir, name);
  }

  return { topLevel, nested: Array.from(nestedMap.values()) };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function assertExists(targetPath, description) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${description} not found at ${targetPath}`);
  }
}

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDir(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
}

/**
 * Copy a package's own files, skipping any `node_modules` directory inside it.
 *
 * `dereference: true` is required (pnpm's store entries are symlinked), but a pnpm
 * package directory also contains a `node_modules` full of junctions to its own
 * dependencies — including sibling workspace packages, which in turn have their own
 * junctioned `node_modules`. Copying those with dereference turns the symlink farm
 * into real, recursively duplicated trees: dugite's bundled MinGW Git ended up staged
 * four times (~410 MB), and the deepest chain produced paths of 267 characters. Windows
 * Explorer rejects an ENTIRE zip as "invalid" if any single entry path exceeds MAX_PATH
 * (260), which is what broke the win-x64-portable.zip release asset.
 *
 * Skipping `node_modules` is safe because this script builds the resolution tree itself:
 * every runtime dependency is collected by collectExternalDeps into `topLevel` (hoisted
 * to app/node_modules/<name>) or `nested` (explicit version-conflict copies). Node's
 * resolution walks up parent directories, so a package staged at
 * app/node_modules/@scope/name still resolves everything in app/node_modules.
 */
function copyPackageDir(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (src) => path.basename(src) !== 'node_modules',
  });
}

function copyFile(sourceFile, targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);
}

function runQuiet(command, args) {
  execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function ensureMacIconsFromSource() {
  if (process.platform !== 'darwin') return;

  assertExists(sourceIconPath, 'source application icon');
  const pngDir = path.join(buildIconsDir, 'png');
  const macDir = path.join(buildIconsDir, 'mac');
  fs.mkdirSync(pngDir, { recursive: true });
  fs.mkdirSync(macDir, { recursive: true });

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    runQuiet('sips', [
      '-z', String(size), String(size),
      sourceIconPath,
      '--out', path.join(pngDir, `${size}x${size}.png`),
    ]);
  }
  copyFile(sourceIconPath, path.join(pngDir, '1024x1024.png'));

  const iconsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riacore-iconset-'));
  const iconsetPath = `${iconsetDir}.iconset`;
  fs.renameSync(iconsetDir, iconsetPath);
  try {
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const resizedIcon = path.join(iconsetPath, `icon_${size}x${size}.png`);
      runQuiet('sips', [
        '-z', String(size), String(size),
        sourceIconPath,
        '--out', resizedIcon,
      ]);
      if (size >= 32) {
        const half = size / 2;
        copyFile(resizedIcon, path.join(iconsetPath, `icon_${half}x${half}@2x.png`));
      }
    }
    runQuiet('iconutil', ['-c', 'icns', iconsetPath, '-o', path.join(macDir, 'icon.icns')]);
  } finally {
    fs.rmSync(iconsetPath, { recursive: true, force: true });
  }

  console.log(`[RiaCore] Synced macOS app icons from ${path.relative(desktopHostDir, sourceIconPath)}`);
}

// ---------------------------------------------------------------------------
// Package copying
// ---------------------------------------------------------------------------

function copyWorkspacePackage(pkg) {
  const packageJsonPath = path.join(pkg.dir, 'package.json');
  const distDir = path.join(pkg.dir, 'dist');
  assertExists(packageJsonPath, `${pkg.name} package.json`);
  assertExists(distDir, `${pkg.name} dist output`);

  const packageTargetDir = path.join(appDir, 'node_modules', ...pkg.name.split('/'));
  fs.mkdirSync(packageTargetDir, { recursive: true });
  copyFile(packageJsonPath, path.join(packageTargetDir, 'package.json'));
  copyDir(distDir, path.join(packageTargetDir, 'dist'));

  // Copy importer-data/ (metamodels, config templates) when present.
  const importerDataDir = path.join(pkg.dir, 'importer-data');
  if (fs.existsSync(importerDataDir)) {
    copyDir(importerDataDir, path.join(packageTargetDir, 'importer-data'));
  }
}

/**
 * Copy a package and its full transitive sub-dependency tree into `targetNodeModules`.
 * This is used for nested (version-conflict) packages: the package itself AND all
 * of its deps (resolved from its on-disk directory) must live in the same nested
 * node_modules folder so that `require()` from inside the package resolves correctly.
 *
 * `alreadyInParent` is the set of package names already available in the parent
 * (hoisted) node_modules — we skip those to avoid duplicating them unnecessarily.
 */
function copyNestedPackageTree(name, sourceDir, targetNodeModules, alreadyInParent) {
  const targetDir = path.join(targetNodeModules, ...name.split('/'));
  if (fs.existsSync(targetDir)) return; // already copied in this nested scope
  copyPackageDir(sourceDir, targetDir);

  // Recursively copy any deps of this package that are NOT already satisfiable
  // from the parent (hoisted) node_modules.
  const pkgJsonPath = path.join(sourceDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const allDeps = { ...pkgJson.dependencies, ...pkgJson.peerDependencies };

  for (const depName of Object.keys(allDeps)) {
    if (workspacePackageNames.has(depName)) continue;
    if (alreadyInParent.has(depName)) {
      // The hoisted version might satisfy the range. Check if the resolved dir
      // from sourceDir matches what's already hoisted — if not, we need to nest it too.
      const resolvedFromNested = resolvePackageDir(depName, sourceDir);
      const resolvedFromParent = resolvePackageDir(depName, appDir);
      if (!resolvedFromNested || resolvedFromNested === resolvedFromParent) continue;
      // Different version needed — recurse nest it here too.
      copyNestedPackageTree(depName, resolvedFromNested, targetNodeModules, alreadyInParent);
    } else {
      const resolvedDir = resolvePackageDir(depName, sourceDir);
      if (resolvedDir) {
        copyNestedPackageTree(depName, resolvedDir, targetNodeModules, alreadyInParent);
      }
    }
  }
}

function copyExternalDeps(topLevel, nested) {
  for (const [name, sourceDir] of topLevel) {
    const targetDir = path.join(appDir, 'node_modules', ...name.split('/'));
    console.log(`[RiaCore]   + ${name}`);
    copyPackageDir(sourceDir, targetDir);
  }

  const hoistedNames = new Set(topLevel.keys());

  // Copy version-conflict packages as nested node_modules under their dependent,
  // including the full sub-dep tree of each nested package.
  for (const { dependentName, name, sourceDir } of nested) {
    const nestedNodeModules = path.join(
      appDir, 'node_modules', ...dependentName.split('/'), 'node_modules',
    );
    console.log(`[RiaCore]   + ${name} (nested under ${dependentName})`);
    copyNestedPackageTree(name, sourceDir, nestedNodeModules, hoistedNames);
  }
}

function copyProfileAssets() {
  assertExists(profilesDir, 'profile asset directory');
  copyDir(profilesDir, path.join(appDir, 'profiles'));
}

function writeAppPackageJson(topLevel) {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const desktopPackageJson = JSON.parse(
    fs.readFileSync(path.join(desktopHostDir, 'package.json'), 'utf8'),
  );
  const dependencies = {};

  for (const pkg of workspacePackages) {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'),
    );
    dependencies[pkg.name] = packageJson.version;
  }

  for (const [name, sourceDir] of topLevel) {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'),
    );
    dependencies[name] = packageJson.version;
  }

  const packagedAppPackageJson = {
    name: desktopPackageJson.name,
    version: rootPackageJson.version,
    private: true,
    main: 'dist/main.js',
    productName: 'RiaCore',
    description: 'RiaCore desktop application',
    author: 'RiaCore',
    dependencies,
  };

  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(packagedAppPackageJson, null, 2) + '\n',
    'utf8',
  );
}

function copySidecarNode() {
  const sidecarName = process.platform === 'win32' ? 'node.exe' : 'node';
  const sidecarPath = path.join(sidecarDir, sidecarName);
  copyFile(process.execPath, sidecarPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(sidecarPath, 0o755);
  }
}

function copyAboutIcon() {
  const iconSource = path.join(desktopHostDir, 'build', 'icons', 'png', '48x48.png');
  const iconTarget = path.join(appDir, 'build', 'icons', 'png', '48x48.png');
  assertExists(iconSource, 'About panel icon');
  copyFile(iconSource, iconTarget);
}

// ---------------------------------------------------------------------------
// Path length guard
// ---------------------------------------------------------------------------

/** Windows MAX_PATH. Windows Explorer's zip handler refuses to open an archive
 *  containing ANY entry whose path is longer than this — it reports the whole
 *  archive as invalid rather than skipping the offending entry. */
const MAX_PATH = 260;

/** electron-builder stages `directories.app` at `resources/app/` inside the package,
 *  so that prefix counts against the budget for every path we stage here. */
const PACKAGED_PREFIX = 'resources/app/';

/** Node on Windows does not add the \\?\ prefix itself, so a plain readdir throws
 *  ENAMETOOLONG on exactly the trees this guard exists to find. */
function longPathSafe(p) {
  if (process.platform !== 'win32') return p;
  return p.startsWith('\\\\?\\') ? p : `\\\\?\\${path.resolve(p)}`;
}

/**
 * Fail the build if any staged file would exceed MAX_PATH once packaged.
 *
 * Without this, an over-long path is invisible locally: electron-builder packages it
 * happily, the NSIS installer works, and only the zipped portable build breaks — in CI,
 * for end users, after release.
 */
function assertPackagedPathLengths() {
  const offenders = [];
  let fileCount = 0;
  let longest = { length: 0, entry: '' };

  const walk = (absDir, relDir) => {
    for (const entry of fs.readdirSync(longPathSafe(absDir), { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      fileCount++;
      const packaged = PACKAGED_PREFIX + rel;
      if (packaged.length > longest.length) longest = { length: packaged.length, entry: packaged };
      if (packaged.length > MAX_PATH) offenders.push(packaged);
    }
  };
  walk(appDir, '');

  console.log(
    `[RiaCore] Path length check: ${fileCount} files, longest packaged path ${longest.length}/${MAX_PATH} chars`,
  );

  if (offenders.length > 0) {
    const shown = offenders
      .sort((a, b) => b.length - a.length)
      .slice(0, 10)
      .map((o) => `  [${o.length}] ${o}`)
      .join('\n');
    throw new Error(
      `${offenders.length} staged file(s) exceed the ${MAX_PATH}-character Windows path limit ` +
      `once packaged. Windows Explorer will reject the whole portable zip as invalid, and ` +
      `extraction to a normal folder will fail.\n${shown}\n` +
      (offenders.length > 10 ? `  ...and ${offenders.length - 10} more\n` : '') +
      `Usually this means a package was staged with its own node_modules tree — see copyPackageDir.`,
    );
  }
}

function removeDevOnlyArtifacts() {
  const devOnlyFiles = [
    path.join(appDir, 'dist', 'web-dev-server.js'),
    path.join(appDir, 'dist', 'web-dev-server.js.map'),
    path.join(appDir, 'dist', 'web-dev-server.d.ts'),
    path.join(appDir, 'dist', 'web-dev-server.d.ts.map'),
  ];
  for (const file of devOnlyFiles) {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const desktopDistDir = path.join(desktopHostDir, 'dist');
  const rendererDistDir = path.join(rendererDir, 'dist');

  assertExists(path.join(desktopDistDir, 'main.js'), 'desktop-host build output');
  assertExists(path.join(desktopDistDir, 'worker.js'), 'desktop-host worker build output');
  assertExists(path.join(rendererDistDir, 'index.html'), 'renderer build output');
  ensureMacIconsFromSource();

  // Collect all external runtime deps by walking the full dependency graph.
  // This includes transitive deps of app-core (ai, @ai-sdk/*, zod, @ladybugdb/core, etc.)
  // without needing a hardcoded list.
  const seedDirs = [
    desktopHostDir,
    ...workspacePackages.map((p) => p.dir),
  ];
  console.log('[RiaCore] Walking dependency graph...');
  const { topLevel, nested } = collectExternalDeps(seedDirs);
  console.log(`[RiaCore] Found ${topLevel.size} top-level external runtime packages, ${nested.length} nested version overrides`);

  ensureCleanDir(releaseDir);
  fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
  fs.mkdirSync(sidecarDir, { recursive: true });

  copyDir(desktopDistDir, path.join(appDir, 'dist'));
  copyDir(rendererDistDir, path.join(appDir, 'renderer'));
  removeDevOnlyArtifacts();

  workspacePackages.forEach(copyWorkspacePackage);
  copyExternalDeps(topLevel, nested);
  copyProfileAssets();
  copyAboutIcon();
  writeAppPackageJson(topLevel);
  copySidecarNode();

  assertPackagedPathLengths();

  console.log(`[RiaCore] Prepared packaged app at ${appDir}`);
  console.log(`[RiaCore] Bundled Node sidecar from ${process.execPath}`);
}

main();
