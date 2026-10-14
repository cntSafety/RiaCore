const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REQUIRED_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const MANIFEST = 'vc-runtime.json';
const REDISTRIBUTION_DOCS = 'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files';

function assertX64Dll(file) {
  const data = fs.readFileSync(file);
  const offset = data.length >= 64 ? data.readUInt32LE(0x3c) : -1;
  if (data.toString('ascii', 0, 2) !== 'MZ' || offset < 0 || offset + 24 > data.length
    || data.toString('ascii', offset, offset + 4) !== 'PE\0\0'
    || data.readUInt16LE(offset + 4) !== 0x8664
    || !(data.readUInt16LE(offset + 22) & 0x2000)) {
    throw new Error(`Visual C++ runtime must be an x64 release DLL: ${file}`);
  }
}

function findVcRuntimeDirectory(env = process.env) {
  if (env.RIACORE_VC_REDIST_DIR) return path.resolve(env.RIACORE_VC_REDIST_DIR);
  let redistRoot = env.VCToolsRedistDir;
  if (!redistRoot) {
    const vswhere = path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(vswhere)) {
      throw new Error('Windows packaging requires Visual Studio C++ Build Tools with the x64 redistributable libraries. Install the Desktop development with C++ workload, or set RIACORE_VC_REDIST_DIR to its x64/Microsoft.VC14*.CRT directory.');
    }
    const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {
      encoding: 'utf8', timeout: 30_000,
    }).trim();
    if (!installation) throw new Error('Visual Studio C++ Build Tools were not found by vswhere. Install the Desktop development with C++ workload.');
    redistRoot = path.join(installation, 'VC', 'Redist', 'MSVC');
  }
  // VCToolsRedistDir points at a version folder; vswhere gives the MSVC parent.
  const versionDirs = fs.existsSync(path.join(redistRoot, 'x64')) ? [redistRoot]
    : fs.readdirSync(redistRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d+(\.\d+)+$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
      .map(entry => path.join(redistRoot, entry.name));
  for (const versionDir of versionDirs) {
    const x64 = path.join(versionDir, 'x64');
    if (!fs.existsSync(x64)) continue;
    for (const entry of fs.readdirSync(x64, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Microsoft\.VC14\d*\.CRT$/i.test(entry.name)) continue;
      const candidate = path.join(x64, entry.name);
      if (REQUIRED_DLLS.every(name => fs.existsSync(path.join(candidate, name)))) return candidate;
    }
  }
  throw new Error(`No complete x64 Visual C++ runtime was found in ${redistRoot}. Set RIACORE_VC_REDIST_DIR to the official x64/Microsoft.VC14*.CRT directory.`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function bundleWindowsVcRuntime(resourcesDir, sourceDir = findVcRuntimeDirectory()) {
  // Copy Microsoft's redistributable release folder, never DLLs from System32
  // or debug_nonredist. Include the dot libraries used by MSVCP140 itself.
  if (!/^Microsoft\.VC14\d*\.CRT$/i.test(path.basename(sourceDir)) || path.basename(path.dirname(sourceDir)).toLowerCase() !== 'x64') {
    throw new Error(`Expected the official x64/Microsoft.VC14*.CRT redistributable directory: ${sourceDir}`);
  }
  for (const name of REQUIRED_DLLS) {
    if (!fs.existsSync(path.join(sourceDir, name))) throw new Error(`Visual C++ redistributable is missing ${name}: ${sourceDir}`);
  }
  const files = fs.readdirSync(sourceDir).filter(name => name.toLowerCase().endsWith('.dll'));
  // Check every source before modifying the package.
  for (const name of files) assertX64Dll(path.join(sourceDir, name));
  const sidecarDir = path.join(resourcesDir, 'node-sidecar');
  if (!fs.existsSync(path.join(sidecarDir, 'node.exe'))) throw new Error(`Bundled Node is missing from ${sidecarDir}`);
  const dlls = {};
  for (const name of files) {
    const source = path.join(sourceDir, name);
    fs.copyFileSync(source, path.join(sidecarDir, name));
    dlls[name] = sha256(source);
  }
  fs.writeFileSync(path.join(sidecarDir, MANIFEST), JSON.stringify({
    source: `Visual Studio VC/Redist/MSVC/${path.basename(path.dirname(path.dirname(sourceDir)))}/x64/${path.basename(sourceDir)}`,
    redistribution: REDISTRIBUTION_DOCS,
    notices: '../THIRD-PARTY-NOTICES.txt',
    dlls,
  }, null, 2) + '\n');
  validateWindowsVcRuntime(resourcesDir);
  console.log(`[RiaCore] Bundled ${files.length} unmodified Visual C++ x64 runtime DLLs beside node.exe`);
}

function validateWindowsVcRuntime(resourcesDir) {
  const sidecarDir = path.join(resourcesDir, 'node-sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error(`Bundled Visual C++ runtime manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const name of REQUIRED_DLLS) {
    if (!manifest.dlls?.[name]) throw new Error(`Bundled Visual C++ runtime is missing ${name}`);
  }
  for (const [name, digest] of Object.entries(manifest.dlls)) {
    if (path.basename(name) !== name || !/\.dll$/i.test(name)) throw new Error(`Invalid Visual C++ runtime manifest entry: ${name}`);
    const file = path.join(sidecarDir, name);
    if (!fs.existsSync(file)) throw new Error(`Bundled Visual C++ runtime DLL is missing: ${file}`);
    assertX64Dll(file);
    if (sha256(file) !== digest) throw new Error(`Bundled Visual C++ runtime DLL was modified: ${file}`);
  }
  return Object.keys(manifest.dlls).length;
}

module.exports = { bundleWindowsVcRuntime, validateWindowsVcRuntime, findVcRuntimeDirectory };
