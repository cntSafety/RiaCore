/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@profiles': path.resolve(__dirname, '../../packages/profiles'),
    },
  },
  build: {
    outDir: 'dist',
  },
  optimizeDeps: {
    // @riacore/app-contracts is a pnpm workspace package (symlinked, not a
    // real node_modules install), so Vite treats it as project "source" and
    // skips pre-bundling it by default. It is compiled to CommonJS, though
    // (tsconfig.base.json: module: NodeNext, no "type": "module"), and
    // without pre-bundling, the dev server serves its raw CJS bytes straight
    // to the browser's native ES module loader via /@fs/ — which cannot
    // parse `exports.foo = ...` as ESM at all. Any named import of a runtime
    // value (not just types) from this package then fails with "does not
    // provide an export named '...'" the moment that import sits on a
    // component's static import graph. Forcing it through the optimizer
    // (esbuild + cjs-module-lexer) here is what actually performs the
    // CJS -> ESM interop, the same path every real node_modules CJS
    // dependency already goes through.
    include: ['@riacore/app-contracts'],
  },
});
