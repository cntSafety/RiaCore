const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildSync } = require('esbuild');

/** Bundle only the packaged copy; development/CLI dist remains ordinary tsc output. */
function bundleWorker(appDir, mode = process.env.RIACORE_PACKAGE_WORKER || 'bundled') {
  if (!['bundled', 'unbundled'].includes(mode)) throw new Error(`Unknown RIACORE_PACKAGE_WORKER: ${mode}`);
  let inputs = 0;
  if (mode === 'bundled') {
    const result = buildSync({
      absWorkingDir: path.resolve(__dirname, '../../..'),
      entryPoints: [path.resolve(__dirname, '../dist/worker.js')],
      outfile: path.join(appDir, 'dist/worker.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      // Keep native addons and optional runtime-resolved bindings on disk.
      external: ['@ladybugdb/core', '@riagraph/core', 'neo4j-driver', 'dugite/package.json'],
      sourcemap: 'external',
      sourcesContent: false,
      metafile: true,
      logLevel: 'silent',
    });
    // Dynamic resolution warnings must be reviewed, never hidden by packaging.
    if (result.warnings.length) throw new Error(result.warnings.map(w => w.text).join('\n'));
    inputs = Object.keys(result.metafile.inputs).length;
    fs.writeFileSync(path.join(appDir, '..', 'worker-metafile.json'), JSON.stringify(result.metafile, null, 2));
  }
  const worker = fs.readFileSync(path.join(appDir, 'dist/worker.js'));
  const manifest = { mode, target: 'node24', inputs, bytes: worker.length, sha256: crypto.createHash('sha256').update(worker).digest('hex') };
  fs.writeFileSync(path.join(appDir, 'worker-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[RiaCore] Worker ${mode}: ${inputs} build inputs, ${manifest.bytes} bytes`);
  return manifest;
}

module.exports = { bundleWorker };
