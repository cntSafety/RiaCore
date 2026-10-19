const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

function validateRendererPackage(appDir) {
  const rendererDir = path.resolve(appDir, 'renderer');
  const entry = path.join(rendererDir, 'index.html');
  const required = [entry, ...['main.js', 'preload.js', 'worker.js'].map(name => path.join(appDir, 'dist', name))];
  const assertFile = file => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size) {
      throw new Error(`Application file is missing or empty: ${file}`);
    }
  };
  required.forEach(assertFile);
  const html = fs.readFileSync(entry, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
  const links = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)].map(match => match[1]);
  if (!scripts.length) throw new Error(`Renderer has no application script: ${entry}`);
  for (const asset of [...scripts, ...links]) {
    const url = new URL(asset, pathToFileURL(entry));
    if (url.protocol !== 'file:') throw new Error(`Renderer asset must be packaged locally: ${asset}`);
    const file = fileURLToPath(url);
    const relative = path.relative(rendererDir, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Renderer asset is outside the renderer directory: ${asset}`);
    }
    assertFile(file);
  }
}

module.exports = { validateRendererPackage };
