const fs = require('node:fs');
const path = require('node:path');

const sourceNotice = path.resolve(__dirname, '../../../THIRD-PARTY-NOTICES.txt');

function validateRuntimeNotices(resourcesDir, platform) {
  const packagedNotice = path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt');
  if (!fs.existsSync(packagedNotice)) throw new Error(`Third-party runtime notices are missing: ${packagedNotice}`);
  if (!fs.readFileSync(packagedNotice).equals(fs.readFileSync(sourceNotice))) {
    throw new Error(`Third-party runtime notices differ from the release source: ${packagedNotice}`);
  }
  if (platform === 'mac') {
    const nativeDir = path.join(resourcesDir, 'native-libs');
    for (const name of ['OpenSSL-LICENSE.txt', 'OpenSSL-AUTHORS.md', 'OpenSSL-VERSION.txt']) {
      const file = path.join(nativeDir, name);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim().length === 0) {
        throw new Error(`OpenSSL license, attribution or version is missing or empty: ${file}`);
      }
    }
    // A bare major ("3") does not identify the code a user received, and only
    // OpenSSL 3 carries the Apache-2.0 terms reviewed for a GPL release.
    const version = fs.readFileSync(path.join(nativeDir, 'OpenSSL-VERSION.txt'), 'utf8').trim();
    if (!/^3\.\d+\.\d+[a-z]?$/.test(version)) {
      throw new Error(`Bundled OpenSSL version must be a complete 3.x.y version, found: ${version}`);
    }
  }
}

module.exports = { validateRuntimeNotices };
