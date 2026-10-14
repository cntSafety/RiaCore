const path = require('node:path');
const { bundleMacNativeLibraries } = require('./mac-native-libraries.cjs');
const { bundleWindowsVcRuntime } = require('./windows-vc-runtime.cjs');
const { finalizeReleaseLicenses } = require('./license-bundle.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    // The installer and portable archive both use this assembled app tree.
    bundleWindowsVcRuntime(path.join(context.appOutDir, 'resources'));
    finalizeReleaseLicenses(path.join(context.appOutDir, 'resources'), 'win');
    return;
  }
  if (context.electronPlatformName !== 'darwin') {
    finalizeReleaseLicenses(path.join(context.appOutDir, 'resources'), 'linux');
    return;
  }
  // electron-builder can add optional native packages after prepare-package.
  // Relocate every final copy before electron-builder signs the complete app.
  const packageRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  bundleMacNativeLibraries(packageRoot);
  finalizeReleaseLicenses(path.join(packageRoot, 'Contents', 'Resources'), 'mac');
};
