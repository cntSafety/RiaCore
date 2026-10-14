const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const supplementsDir = path.join(desktopDir, 'build', 'third-party');
const publicLicenseSource = () => fs.existsSync(path.join(repoRoot, 'LICENSE'))
  ? path.join(repoRoot, 'LICENSE') : path.join(repoRoot, 'internal/release-licensing/RiaCore-GPL-3.0.txt');
const reviewedLicenses = new Set(['MIT', 'MIT/X11', 'Apache-2.0', 'ISC', 'BlueOak-1.0.0', 'BSD-3-Clause', 'BSD-2-Clause', 'OFL-1.1', 'Unlicense', '0BSD', '(AFL-2.1 OR BSD-3-Clause)', '(MIT OR GPL-3.0-or-later)', '(MIT AND Zlib)', '(BSD-2-Clause OR MIT OR Apache-2.0)', 'EPL-2.0 OR GPL-3.0-or-later']);

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function resolvePackageDirectory(name, from) {
  try {
    let dir = path.dirname(require.resolve(name, { paths: [from] }));
    while (dir !== path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest) && readJson(manifest).name === name) return fs.realpathSync(dir);
      dir = path.dirname(dir);
    }
  } catch { /* CSS-only packages and packages without a main use the fallback. */ }
  for (let dir = from; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
  }
  return null;
}

function collectRuntimeGraph(root) {
  const visited = new Set();
  function visit(dir) {
    dir = fs.realpathSync(dir);
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    const deps = { ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.dependencies };
    for (const name of Object.keys(deps)) {
      const found = resolvePackageDirectory(name, dir);
      if (found) visit(found);
      else if (pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name]) throw new Error(`Cannot inventory required dependency ${name} of ${pkg.name}`);
    }
  }
  visit(root);
  return [...visited];
}

function packagedPackages(appDir) {
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      const candidate = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) { walk(candidate); continue; }
      if (fs.existsSync(path.join(candidate, 'package.json'))) found.push(candidate);
      walk(path.join(candidate, 'node_modules'));
    }
  }
  walk(path.join(appDir, 'node_modules'));
  return found;
}

function licenseFiles(dir) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^(licen[cs]e|copying|notice|copyright|ofl|unlicense|third[-_ ]?party(?:[-_ ]?(?:notices?|licen[cs]es?))?)([._ -]|$)/i.test(entry.name)) files.push(file);
    }
  }
  walk(dir);
  // Some upstreams put their complete grant and copyright in the README.
  for (const name of fs.readdirSync(dir).filter(name => /^readme([._-]|$)/i.test(name))) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile() && /permission (?:is hereby granted|to use, copy)/i.test(fs.readFileSync(file, 'utf8'))) files.push(file);
  }
  return files.sort();
}

function createInventory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const records = new Map();
  function addFile(relative, data) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return { path: relative.split(path.sep).join('/'), sha256: digest(data) };
  }
  function addComponent(id, data, documents) {
    const existing = records.get(id);
    if (existing) {
      if (existing.license !== data.license) throw new Error(`Conflicting license declarations for ${id}`);
      existing.origins = [...new Set([...existing.origins, ...data.origins])].sort();
      const key = digest(id).slice(0, 16);
      for (const document of documents) {
        if (existing.files.some(file => file.sha256 === digest(document.data))) continue;
        existing.files.push(addFile(`components/${key}/${existing.files.length}-${path.basename(document.name)}`, document.data));
      }
      return;
    }
    const key = digest(id).slice(0, 16);
    const files = documents.map((doc, i) => addFile(`components/${key}/${i}-${path.basename(doc.name)}`, doc.data));
    if (!files.length) throw new Error(`No license evidence for ${id}`);
    records.set(id, { id, ...data, files });
  }
  function addPackage(dir, origin) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg.name.startsWith('@riacore/')) return; // RiaCore's release GPL covers these packages.
    const id = `${pkg.name}@${pkg.version}`;
    const supplement = readJson(path.join(supplementsDir, 'npm-supplements.json'))[id];
    const license = pkg.license || supplement?.license;
    if (!reviewedLicenses.has(license)) throw new Error(`Unreviewed or missing license for ${id}: ${JSON.stringify(license)}. Review before releasing; do not guess a license.`);
    const documents = licenseFiles(dir).map(file => ({ name: path.relative(dir, file).replaceAll(path.sep, '-'), data: fs.readFileSync(file) }));
    if (supplement) {
      for (const name of supplement.files) {
        const data = fs.readFileSync(path.join(supplementsDir, name));
        if (digest(data) !== supplement.sha256[name]) throw new Error(`Upstream license supplement changed without review: ${name}`);
        documents.push({ name, data });
      }
    }
    // These publisher archives explicitly declare MIT/X11 but ship no separate
    // license file. Preserve the declaration and publisher attribution; include
    // canonical MIT terms separately rather than inventing copyright years.
    const metadataOnly = new Set(['binary@0.3.0', 'chainsaw@0.1.0', 'node-buffers@0.1.1']);
    if (!documents.length && !metadataOnly.has(id)) throw new Error(`License text missing for ${id}; add a version-specific upstream supplement.`);
    documents.push({ name: 'upstream-package.json', data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n') });
    addComponent(id, {
      name: pkg.name, version: pkg.version, license, origins: [origin],
      author: pkg.author || null, repository: pkg.repository || null,
      supplementalSource: supplement?.source || null,
      evidence: documents.length === 1 ? 'Publisher license declaration and attribution; canonical terms in terms/.' : 'Upstream license and notice documents.',
      licenseChoice: license === 'EPL-2.0 OR GPL-3.0-or-later' ? 'GPL-3.0-or-later'
        : license === '(AFL-2.1 OR BSD-3-Clause)' ? 'BSD-3-Clause'
        : license === '(MIT OR GPL-3.0-or-later)' ? 'MIT' : license,
    }, documents);
  }
  function save() {
    const components = [...records.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const manifest = { schemaVersion: 1, releaseVersion: readJson(path.join(repoRoot, 'package.json')).version, components };
    fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify(manifest, null, 2) + '\n');
    const index = ['RiaCore release: third-party license inventory', '', 'RiaCore is GPL-3.0-or-later. Dependencies retain their own licenses.', 'Frontend entries conservatively include the renderer runtime dependency graph.', 'Original texts and publisher attribution are supplied in the referenced files.', 'Native runtimes also include their upstream aggregate third-party notices.', '', ...components.flatMap(c => [
      `${c.id} — ${c.license} (${c.origins.join(', ')})`,
      ...c.files.map(f => `  ${f.path}`), '',
    ])].join('\n');
    fs.writeFileSync(path.join(directory, 'THIRD-PARTY-LICENSES.txt'), index);
    return manifest;
  }
  return { records, addFile, addPackage, addComponent, save };
}

function ensureElectronDistributionNotices(electronDir, run = execFileSync) {
  const names = ['LICENSE', 'LICENSES.chromium.html'];
  const missing = () => names.filter(name => !fs.existsSync(path.join(electronDir, 'dist', name)));
  // Electron 43 exposes install-electron instead of running a postinstall hook.
  // Fresh installs need the matching runtime archive before we can collect its
  // Chromium notices. The official installer verifies the archive checksums.
  if (missing().length) {
    run(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  }
  for (const name of missing()) {
    throw new Error(`Electron distribution notice is missing: ${path.join(electronDir, 'dist', name)}`);
  }
}

function stageReleaseLicenses() {
  const legalDir = path.join(desktopDir, '.release', 'licenses');
  const inventory = createInventory(legalDir);
  const gpl = fs.readFileSync(publicLicenseSource());
  if (!gpl.includes(Buffer.from('Version 3, 29 June 2007'))) throw new Error('Expected the canonical RiaCore GPLv3 release license');
  inventory.addFile('RiaCore-LICENSE.txt', gpl);
  inventory.addFile('RiaCore-COPYRIGHT.txt', Buffer.from('Copyright (c) Samir Sarkic and Simon Roth\n\nRiaCore release code is licensed under GPL-3.0-or-later.\nSee RiaCore-LICENSE.txt. This notice applies to the public RiaCore release,\nnot to the private RiaCoreDev repository as a whole.\n'));
  for (const name of fs.readdirSync(supplementsDir).filter(name => name.startsWith('terms-'))) {
    inventory.addFile(`terms/${name.slice('terms-'.length)}`, fs.readFileSync(path.join(supplementsDir, name)));
  }
  for (const dir of collectRuntimeGraph(path.join(repoRoot, 'apps', 'renderer'))) inventory.addPackage(dir, 'frontend');
  inventory.save();
  // Keep frontend evidence before packaging strips node_modules and minifies JS.
  fs.copyFileSync(path.join(legalDir, 'inventory.json'), path.join(legalDir, 'frontend-inventory.json'));

  const nodeLicense = [process.env.RIACORE_NODE_LICENSE_FILE,
    path.join(path.dirname(process.execPath), 'LICENSE'),
    path.join(path.dirname(process.execPath), '..', 'LICENSE'),
    path.join(path.dirname(process.execPath), '..', 'share', 'doc', 'node', 'LICENSE')]
    .filter(Boolean).find(file => fs.existsSync(file));
  if (!nodeLicense) throw new Error('Node distribution LICENSE is missing. Set RIACORE_NODE_LICENSE_FILE to the matching distribution license.');
  fs.copyFileSync(nodeLicense, path.join(legalDir, 'Node-LICENSE.txt'));
  const electronDir = resolvePackageDirectory('electron', desktopDir);
  ensureElectronDistributionNotices(electronDir);
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const source = path.join(electronDir, 'dist', name);
    if (!fs.existsSync(source)) throw new Error(`Electron distribution notice is missing: ${source}`);
    fs.copyFileSync(source, path.join(legalDir, name === 'LICENSE' ? 'Electron-LICENSE.txt' : name));
  }
}

function finalizeReleaseLicenses(resourcesDir, platform) {
  const legalDir = path.join(resourcesDir, 'licenses');
  const inventory = createInventory(legalDir);
  for (const record of readJson(path.join(legalDir, 'frontend-inventory.json')).components) inventory.records.set(record.id, record);
  for (const dir of packagedPackages(path.join(resourcesDir, 'app'))) inventory.addPackage(dir, 'backend');
  function localComponent(id, license, filenames, source = null) {
    inventory.addComponent(id, { license, origins: ['native'], ...(source ? { source } : {}) }, filenames.map(file => ({ name: path.basename(file), data: fs.readFileSync(file) })));
  }
  localComponent(`Node@${readJson(path.join(repoRoot, 'package.json')).engines.node}`, 'MIT AND bundled third-party licenses', [path.join(legalDir, 'Node-LICENSE.txt')]);
  const electronDir = resolvePackageDirectory('electron', desktopDir);
  localComponent(`Electron@${readJson(path.join(electronDir, 'package.json')).version}`, 'MIT AND bundled third-party licenses', [path.join(legalDir, 'Electron-LICENSE.txt'), path.join(legalDir, 'LICENSES.chromium.html')]);
  const nativeManifest = readJson(path.join(supplementsDir, 'native-manifest.json'));
  const ladybugVersion = readJson(path.join(resourcesDir, 'app/node_modules/@ladybugdb/core/package.json')).version;
  if (ladybugVersion !== nativeManifest.ladybugVersion) throw new Error('LadybugDB changed; refresh its upstream native dependency license texts before releasing.');
  const dugite = resolvePackageDirectory('dugite', path.join(repoRoot, 'packages/git-service'));
  const embedded = readJson(path.join(dugite, 'script', 'embedded-git.json'))[`${process.platform}-${process.arch}`];
  if (!embedded || !embedded.url.includes(`/download/${nativeManifest.dugiteTag}/`)) throw new Error('Portable Git changed; review and refresh its native license inventory before releasing.');
  const gitRoot = path.join(resourcesDir, 'git');
  function findNamed(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const result = findNamed(file, name); if (result) return result; }
      else if (entry.name === name) return file;
    }
    return null;
  }
  const gcmDeps = findNamed(gitRoot, 'git-credential-manager.deps.json');
  if (gcmDeps) {
    const libraryIds = Object.keys(readJson(gcmDeps).libraries);
    for (const [id, info] of Object.entries(readJson(gcmDeps).libraries)) {
      if (info.type === 'package' && !nativeManifest.nugetPackages.some(([name, version]) => `${name}/${version}` === id)) {
        throw new Error(`Unreviewed Credential Manager dependency ${id}; refresh native license evidence.`);
      }
    }
    if (!libraryIds.includes(`git-credential-manager/${nativeManifest.gcmVersion}`)
      || libraryIds.some(id => id.startsWith('runtimepack.') && !id.endsWith(`/${nativeManifest.dotnetVersion}`))) throw new Error('Credential Manager/.NET changed; refresh native license evidence.');
  }
  const lfs = findNamed(gitRoot, platform === 'win' ? 'git-lfs.exe' : 'git-lfs');
  if (lfs) {
    const buildInfo = fs.readFileSync(lfs).toString('latin1');
    const expected = new Set(nativeManifest.goModules.map(([name, version]) => `${name}@${version}`));
    for (const match of buildInfo.matchAll(/dep\t([^\t\n]+)\t([^\t\n]+)\t/g)) {
      if (!expected.has(`${match[1]}@${match[2]}`)) throw new Error(`Unreviewed Git LFS Go module ${match[1]}@${match[2]}; refresh native licenses.`);
    }
  }
  for (const component of nativeManifest.components) {
    inventory.addComponent(component.id, { license: component.license, origins: ['native'], source: component.source }, component.files.map(file => {
      const data = fs.readFileSync(path.join(supplementsDir, file.path));
      if (digest(data) !== file.sha256) throw new Error(`Native license supplement changed: ${file.path}`);
      return { name: path.basename(file.path), data };
    }));
  }
  // Retain all license/notice documents supplied inside the actual Git payload,
  // including platform-specific MinGit notices and Credential Manager's NOTICE.
  const gitDocuments = licenseFiles(path.join(resourcesDir, 'git'));
  if (gitDocuments.length) localComponent('Portable-Git-payload-notices', 'See upstream component licenses', gitDocuments);
  // LadybugDB's macOS native module links @rpath/libssl.3 and @rpath/libcrypto.3,
  // so OpenSSL 3 ships inside native-libs/. Its version comes from the build
  // machine's Homebrew rather than pnpm-lock, so the exact version is read back
  // out of the shipped binary instead of being assumed.
  let opensslSource = null;
  if (platform === 'mac') {
    const nativeDir = path.join(resourcesDir, 'native-libs');
    const versionFile = path.join(nativeDir, 'OpenSSL-VERSION.txt');
    if (!fs.existsSync(versionFile)) throw new Error(`Bundled OpenSSL version was not recorded: ${versionFile}`);
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    if (!/^3\.\d+\.\d+[a-z]?$/.test(version)) throw new Error(`Bundled OpenSSL version must be a complete 3.x.y version, found: ${version}`);
    opensslSource = `OpenSSL@${version}: https://github.com/openssl/openssl/tree/openssl-${version}`;
    localComponent(`OpenSSL@${version}`, 'Apache-2.0',
      ['OpenSSL-LICENSE.txt', 'OpenSSL-AUTHORS.md', 'OpenSSL-NOTICE.txt', 'OpenSSL-VERSION.txt']
        .map(name => path.join(nativeDir, name)).filter(file => fs.existsSync(file)),
      `https://github.com/openssl/openssl/tree/openssl-${version}`);
  }
  if (platform === 'win') {
    const manifest = path.join(resourcesDir, 'node-sidecar', 'vc-runtime.json');
    localComponent('Microsoft-Visual-C++-Runtime', 'Microsoft redistributable terms', [path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt'), manifest]);
  }
  inventory.save();
  fs.writeFileSync(path.join(legalDir, 'SOURCE-CODE.txt'), [
    `RiaCore ${readJson(path.join(repoRoot, 'package.json')).version} — GPL-3.0-or-later`,
    'Public release source and build instructions: https://github.com/cntSafety/RiaCore',
    'Use the source tag matching this release; pnpm-lock.yaml pins npm dependencies.',
    'Backend JavaScript and package manifests are also present in resources/app/.',
    'Third-party repositories, versions and license texts: inventory.json.',
    `Portable Git build recipe: https://github.com/desktop/dugite-native/tree/${nativeManifest.dugiteTag}`,
    ...(opensslSource ? [opensslSource] : []),
    ...nativeManifest.components.map(c => `${c.id}: ${c.source}`),
    'ELK/elkjs (GPL option): https://github.com/kieler/elkjs/tree/v0.12.0',
    '',
  ].join('\n'));
  console.log(`[RiaCore] Collected licenses and notices for ${inventory.records.size} versioned third-party components`);
}

function validateReleaseLicenses(resourcesDir) {
  const legalDir = path.join(resourcesDir, 'licenses');
  const gpl = fs.readFileSync(path.join(resourcesDir, 'LICENSE'));
  if (!gpl.equals(fs.readFileSync(publicLicenseSource())) || !gpl.equals(fs.readFileSync(path.join(legalDir, 'RiaCore-LICENSE.txt')))) throw new Error('Packaged RiaCore GPL license differs from the public release license');
  for (const name of fs.readdirSync(supplementsDir).filter(name => name.startsWith('terms-'))) {
    const target = path.join(legalDir, 'terms', name.slice('terms-'.length));
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(fs.readFileSync(path.join(supplementsDir, name)))) {
      throw new Error(`Canonical dependency license terms are missing or modified: ${name}`);
    }
  }
  const manifest = readJson(path.join(legalDir, 'inventory.json'));
  if (manifest.releaseVersion !== readJson(path.join(repoRoot, 'package.json')).version) throw new Error('License inventory has the wrong release version');
  const ids = new Set(manifest.components.map(c => c.id));
  for (const record of readJson(path.join(legalDir, 'frontend-inventory.json')).components) {
    if (!ids.has(record.id)) throw new Error(`Renderer dependency has no license inventory entry: ${record.id}`);
  }
  for (const record of readJson(path.join(supplementsDir, 'native-manifest.json')).components) {
    if (!ids.has(record.id)) throw new Error(`Native dependency has no license inventory entry: ${record.id}`);
  }
  for (const dir of packagedPackages(path.join(resourcesDir, 'app'))) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg.name.startsWith('@riacore/') && !ids.has(`${pkg.name}@${pkg.version}`)) throw new Error(`Packaged dependency has no license inventory entry: ${pkg.name}@${pkg.version}`);
  }
  for (const record of manifest.components) {
    if (!record.files.length) throw new Error(`No license files for ${record.id}`);
    for (const file of record.files) {
      const target = path.resolve(legalDir, file.path);
      if (!target.startsWith(`${path.resolve(legalDir)}${path.sep}`)) throw new Error(`Invalid license path: ${file.path}`);
      if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== file.sha256) throw new Error(`License file is missing or modified for ${record.id}: ${file.path}`);
    }
  }
  for (const file of ['THIRD-PARTY-LICENSES.txt', 'SOURCE-CODE.txt', 'Node-LICENSE.txt', 'Electron-LICENSE.txt', 'LICENSES.chromium.html', 'RiaCore-COPYRIGHT.txt']) {
    if (!fs.existsSync(path.join(legalDir, file)) || !fs.statSync(path.join(legalDir, file)).size) throw new Error(`Required release license document is missing: ${file}`);
  }
  return manifest.components.length;
}

module.exports = { stageReleaseLicenses, finalizeReleaseLicenses, validateReleaseLicenses, createInventory, collectRuntimeGraph, packagedPackages, ensureElectronDistributionNotices };
