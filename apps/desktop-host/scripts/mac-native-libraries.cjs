const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MINIMUM_MACOS_VERSION = '26.0.0';
const MACH_O_MAGICS = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 60_000 }).trim();
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSystemLibrary(file) {
  return file.startsWith('/usr/lib/') || file.startsWith('/System/Library/');
}

function findMachOFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      // Framework and Git aliases are inspected through their real files.
      if (entry.isSymbolicLink()) {
        if (!fs.existsSync(file) || !inside(root, fs.realpathSync(file))) {
          throw new Error(`Broken or external package symlink: ${file}`);
        }
      } else if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        const fd = fs.openSync(file, 'r');
        const header = Buffer.alloc(4);
        try {
          if (fs.readSync(fd, header, 0, 4, 0) === 4 && MACH_O_MAGICS.has(header.toString('hex'))) files.push(file);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  }
  walk(root);
  return files;
}

function inspectMachO(file) {
  // otool interprets a trailing '(GPU)' as an archive-member selector. Inspect
  // through an inherited descriptor so Electron helper names remain literal.
  const fd = fs.openSync(file, 'r');
  let output;
  try {
    output = execFileSync('otool', ['-l', '/dev/fd/3'], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe', fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const commands = output.split(/Load command \d+/);
  const dependencies = new Set();
  const rpaths = new Set();
  const minimumVersions = [];
  let id = null;
  for (const command of commands) {
    const type = command.match(/\bcmd (LC_\w+)/)?.[1];
    const name = command.match(/\bname (.+?) \(offset \d+\)/)?.[1];
    if (['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB'].includes(type) && name) dependencies.add(name);
    if (type === 'LC_ID_DYLIB') id = name;
    if (type === 'LC_RPATH') rpaths.add(command.match(/\bpath (.+?) \(offset \d+\)/)[1]);
    if (type === 'LC_BUILD_VERSION' && /\bplatform (1|macos)\b/i.test(command)) minimumVersions.push(command.match(/\bminos (\S+)/)[1]);
    if (type === 'LC_VERSION_MIN_MACOSX') minimumVersions.push(command.match(/\bversion (\S+)/)[1]);
  }
  return { file, dependencies: [...dependencies], rpaths: [...rpaths], minimumVersions, id };
}

function expandLoaderPath(value, file, executableDir) {
  return value.replace(/^@loader_path(?=\/|$)/, path.dirname(file))
    .replace(/^@executable_path(?=\/|$)/, executableDir);
}

function dependencyCandidates(dependency, record, packageRoot) {
  const frameworksDir = path.join(packageRoot, 'Contents', 'Frameworks');
  const executableDir = path.basename(path.dirname(record.file)) === 'MacOS'
    ? path.dirname(record.file)
    : path.join(packageRoot, 'Contents', 'MacOS');
  if (dependency.startsWith('@rpath/')) {
    // Electron frameworks inherit the main executable's Frameworks rpath.
    const rpaths = [...record.rpaths];
    if (inside(frameworksDir, record.file)) rpaths.push(frameworksDir);
    return rpaths.map((rpath) => path.resolve(expandLoaderPath(rpath, record.file, executableDir), dependency.slice('@rpath/'.length)));
  }
  return [expandLoaderPath(dependency, record.file, executableDir)];
}

function resolveDependency(dependency, record, packageRoot, bundledOnly) {
  const candidates = dependencyCandidates(dependency, record, packageRoot);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync(candidate);
    if (!bundledOnly || inside(packageRoot, resolved)) return resolved;
  }
  throw new Error(`Native library ${dependency} required by ${record.file} is not ${bundledOnly ? 'bundled' : 'available on the build machine'}. Searched: ${candidates.join(', ')}. For OpenSSL 3, install the build prerequisite with brew install openssl@3.`);
}

/**
 * Read the exact OpenSSL version out of the binary we are about to ship.
 *
 * OpenSSL compiles OPENSSL_VERSION_TEXT into libcrypto, so the version is a
 * property of the bytes themselves rather than of the build machine's package
 * manager. That matters for a GPL distribution: the inventory has to name the
 * version a user actually received, and `brew install openssl@3` resolves to
 * whatever Homebrew serves that day. Homebrew's versioned Cellar path is the
 * fallback for a layout that strips the banner.
 */
function readOpenSslVersion(dylib) {
  const banner = fs.readFileSync(dylib).toString('latin1').match(/OpenSSL\s+(\d+\.\d+\.\d+[a-z]?)/);
  if (banner) return banner[1];
  // …/Cellar/openssl@3/3.6.2/lib/libcrypto.3.dylib
  const segments = fs.realpathSync(dylib).split(path.sep);
  const index = segments.findIndex(segment => /^openssl@\d+$/.test(segment));
  if (index >= 0 && /^\d+\.\d+\.\d+/.test(segments[index + 1] || '')) return segments[index + 1];
  return null;
}

function versionGreaterThan(actual, expected) {
  const a = actual.split('.').map(Number);
  const b = expected.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function validateMacNativeLibraries(packageRoot) {
  packageRoot = fs.realpathSync(packageRoot);
  const files = findMachOFiles(packageRoot);
  for (const file of files) {
    const record = inspectMachO(file);
    for (const minimum of record.minimumVersions) {
      if (versionGreaterThan(minimum, MINIMUM_MACOS_VERSION)) {
        throw new Error(`${file} requires macOS ${minimum}, higher than the advertised ${MINIMUM_MACOS_VERSION}`);
      }
    }
    for (const rpath of record.rpaths) {
      if (path.isAbsolute(rpath) && !isSystemLibrary(rpath)) {
        throw new Error(`External native library search path in ${file}: ${rpath}`);
      }
    }
    for (const dependency of record.dependencies) {
      if (isSystemLibrary(dependency)) continue; // macOS libraries can live in the dyld shared cache.
      if (path.isAbsolute(dependency)) {
        throw new Error(`External native library dependency in ${file}: ${dependency}`);
      }
      resolveDependency(dependency, record, packageRoot, true);
    }
  }
  return files;
}

function bundleMacNativeLibraries(packageRoot) {
  packageRoot = fs.realpathSync(packageRoot);
  const libraryDir = path.join(packageRoot, 'Contents', 'Resources', 'native-libs');
  const files = findMachOFiles(packageRoot);
  const sourcesByName = new Map();
  const processed = new Set();

  function relocate(file, source = file) {
    if (processed.has(file)) return;
    processed.add(file);
    // Inspect the source before changing its paths, so transitive dylibs can be resolved.
    const record = inspectMachO(source);
    const edits = [];
    for (const dependency of record.dependencies) {
      if (isSystemLibrary(dependency)) continue;
      const resolved = resolveDependency(dependency, record, packageRoot, false);
      if (inside(packageRoot, resolved)) {
        if (path.isAbsolute(dependency)) edits.push('-change', dependency, `@loader_path/${path.relative(path.dirname(file), resolved).split(path.sep).join('/')}`);
        continue;
      }
      const name = path.basename(resolved);
      const previous = sourcesByName.get(name);
      if (previous && previous !== resolved) throw new Error(`Conflicting bundled library ${name}: ${previous} and ${resolved}`);
      sourcesByName.set(name, resolved);
      const target = path.join(libraryDir, name);
      if (!previous) {
        if (fs.existsSync(target)) throw new Error(`Bundled library already exists with an unknown source: ${target}`);
        fs.mkdirSync(libraryDir, { recursive: true });
        fs.copyFileSync(resolved, target);
        fs.chmodSync(target, 0o755);
        const architectures = run('lipo', ['-archs', target]).split(/\s+/);
        if (!architectures.includes('arm64')) throw new Error(`Bundled library does not support arm64: ${resolved}`);
        if (architectures.length > 1) {
          const thin = `${target}.arm64`;
          run('lipo', ['-thin', 'arm64', target, '-output', thin]);
          fs.renameSync(thin, target);
        }
        relocate(target, resolved);
      }
      edits.push('-change', dependency, `@loader_path/${path.relative(path.dirname(file), target).split(path.sep).join('/')}`);
    }
    if (source !== file && record.id) edits.push('-id', `@rpath/${path.basename(file)}`);
    for (const rpath of record.rpaths) {
      if (path.isAbsolute(rpath) && !isSystemLibrary(rpath)) edits.push('-delete_rpath', rpath);
    }
    if (edits.length) {
      fs.chmodSync(file, fs.statSync(file).mode | 0o200);
      run('install_name_tool', [...edits, file]);
    }
  }

  for (const file of files) relocate(file);
  validateMacNativeLibraries(packageRoot);

  // Preserve upstream licensing/attribution alongside the repackaged binaries.
  let opensslVersion = null;
  for (const [name, source] of sourcesByName) {
    if (!/^lib(ssl|crypto)\./.test(name)) continue;
    const sourceRoot = path.join(path.dirname(source), '..');
    const license = path.join(sourceRoot, 'LICENSE.txt');
    if (!fs.existsSync(license)) throw new Error(`OpenSSL license was not found: ${license}`);
    fs.copyFileSync(license, path.join(libraryDir, 'OpenSSL-LICENSE.txt'));
    const authors = path.join(sourceRoot, 'AUTHORS.md');
    if (!fs.existsSync(authors)) throw new Error(`OpenSSL author attribution was not found: ${authors}`);
    fs.copyFileSync(authors, path.join(libraryDir, 'OpenSSL-AUTHORS.md'));
    for (const noticeName of ['NOTICE', 'NOTICE.txt']) {
      const notice = path.join(sourceRoot, noticeName);
      if (fs.existsSync(notice)) {
        fs.copyFileSync(notice, path.join(libraryDir, 'OpenSSL-NOTICE.txt'));
        break;
      }
    }
    // libcrypto carries the version banner; libssl is only a fallback source.
    if (!opensslVersion || /^libcrypto\./.test(name)) {
      opensslVersion = readOpenSslVersion(path.join(libraryDir, name)) || opensslVersion;
    }
  }

  // Record the version in the package so the shipped artifact self-documents
  // which OpenSSL it contains, and refuse anything but the reviewed major.
  // OpenSSL 3 is Apache-2.0; 1.x used the SSLeay license, whose advertising
  // clause is incompatible with RiaCore's GPL-3.0-or-later release terms.
  if ([...sourcesByName.keys()].some(name => /^lib(ssl|crypto)\./.test(name))) {
    if (!opensslVersion) {
      throw new Error('Bundled OpenSSL version could not be determined; it must be recorded for the release license inventory.');
    }
    if (!opensslVersion.startsWith('3.')) {
      throw new Error(`Only OpenSSL 3 (Apache-2.0) is reviewed for release; found ${opensslVersion}.`);
    }
    fs.writeFileSync(path.join(libraryDir, 'OpenSSL-VERSION.txt'), `${opensslVersion}\n`);
  }
  console.log(`[RiaCore] Bundled ${sourcesByName.size} external native libraries; checked ${files.length} native binaries`);
}

module.exports = { MINIMUM_MACOS_VERSION, bundleMacNativeLibraries, validateMacNativeLibraries, readOpenSslVersion };
