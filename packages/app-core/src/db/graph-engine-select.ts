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
/**
 * Picks the binding to open a workspace's database with, from the workspace's
 * graph-engine configuration (see graph-engine.ts).
 *
 * One configured engine is that engine's binding. Several are the first engine
 * (the master) paired with each of the others (shadows) in turn: the pair of
 * the master and the first shadow is itself a binding, which becomes the master
 * of the pair with the second shadow. Each pair compares, journals and records
 * on its own (graph-engine-dual.ts), and every shadow is compared with the
 * master's answer, which is the one the application gets.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppCoreLogger } from './db-module.js';
import {
  type GraphEngineBinding,
  type GraphEngineMode,
  type GraphEngineName,
  type ResolvedEngineEntry,
  type ResolvedGraphEngineConfig,
  assertGraphEngineUsableInProcess,
  engineDbPath,
  ladybugBinding,
  loadRiaGraph,
  resolveGraphEngineConfig,
  resolveRiaGraph,
} from './graph-engine.js';
import { type DualEndpoint, createDualBinding, prepareDualFiles, shadowSeedMethod } from './graph-engine-dual.js';
import { createShadowProcessBinding } from './graph-engine-shadow.js';

export interface SelectedGraphEngine {
  mode: GraphEngineMode;
  /** The configured engines, master first. */
  engines: GraphEngineName[];
  binding: GraphEngineBinding;
  /** What to pass to `binding.Database` for the logical path `<workspace>/db`. */
  databasePath: string;
  /** Config file the selection came from; null for the default engine. */
  configSource: string | null;
  /** Run before opening: brings the files of the engines into a comparable state. */
  prepare(): Promise<void>;
}

const noop = async (): Promise<void> => {};

/** The package directory and version of `@ladybugdb/core`, found without loading it. */
function ladybugPackage(): { modulePath: string; version: string } {
  const requireFromHere = createRequire(path.join(__dirname, 'graph-engine.js'));
  const modulePath = path.dirname(requireFromHere.resolve('@ladybugdb/core'));
  let version = 'unknown';
  for (let dir = modulePath; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      version = String((JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { version?: string }).version ?? version);
      break;
    }
  }
  return { modulePath, version };
}

const fileErrorPaths = (file: string): string[] => [file, `${file}.wal`];

/** The engine as master: in this process, opened on its own file. */
function masterEndpoint(entry: ResolvedEngineEntry, resolved: ResolvedGraphEngineConfig): DualEndpoint {
  switch (entry.engine) {
    case 'ladybug':
      return { engine: 'ladybug', binding: ladybugBinding, pathFor: (l) => engineDbPath(l, 'ladybug'), errorPaths: (l) => fileErrorPaths(l) };
    case 'riagraph': {
      const loaded = loadRiaGraph(resolved);
      return {
        engine: 'riagraph',
        binding: loaded.binding,
        pathFor: (l) => engineDbPath(l, 'riagraph'),
        errorPaths: (l) => fileErrorPaths(engineDbPath(l, 'riagraph')),
        module: { modulePath: loaded.modulePath, build: loaded.buildInfo },
      };
    }
  }
}

/**
 * The engine as a shadow. The native engines run in a process of their own
 * (graph-engine-shadow.ts) so that no process ever holds both of them.
 */
function shadowEndpoint(entry: ResolvedEngineEntry, resolved: ResolvedGraphEngineConfig, logger?: AppCoreLogger): DualEndpoint {
  switch (entry.engine) {
    case 'ladybug': {
      const pkg = ladybugPackage();
      return {
        engine: 'ladybug',
        binding: createShadowProcessBinding({ ...pkg, engine: 'ladybug' }, logger),
        pathFor: (l) => engineDbPath(l, 'ladybug'),
        errorPaths: (l) => fileErrorPaths(l),
        module: { modulePath: pkg.modulePath, build: { version: pkg.version } },
      };
    }
    case 'riagraph': {
      const riagraph = resolveRiaGraph(resolved);
      return {
        engine: 'riagraph',
        binding: createShadowProcessBinding({ ...riagraph, engine: 'riagraph' }, logger),
        pathFor: (l) => engineDbPath(l, 'riagraph'),
        errorPaths: (l) => fileErrorPaths(engineDbPath(l, 'riagraph')),
        module: { modulePath: riagraph.modulePath, build: riagraph.buildInfo },
      };
    }
  }
}

/**
 * Resolve the engine for `logicalDbPath`. Throws when the configuration is
 * invalid or names an engine whose binding is not available here.
 */
export function selectGraphEngine(logicalDbPath: string, logger?: AppCoreLogger): SelectedGraphEngine {
  const resolved = resolveGraphEngineConfig(logicalDbPath);
  const entries = resolved.config.engines;
  const [masterEntry, ...shadowEntries] = entries;
  const engines = entries.map((e) => e.engine);
  // Before anything is prepared, deleted or loaded.
  assertGraphEngineUsableInProcess(logicalDbPath);

  if (shadowEntries.length === 0) {
    const endpoint = masterEndpoint(masterEntry, resolved);
    return {
      mode: masterEntry.engine,
      engines,
      binding: endpoint.binding,
      databasePath: endpoint.pathFor(logicalDbPath),
      configSource: resolved.source,
      prepare: noop,
    };
  }

  let pair = masterEndpoint(masterEntry, resolved);
  const prepares: Array<() => Promise<void>> = [];
  for (const shadowEntry of shadowEntries) {
    const shadow = shadowEndpoint(shadowEntry, resolved, logger);
    // ladybug and RiaGraph, either way round, keep their files in step.
    const seedMethod = shadowSeedMethod(masterEntry.engine, shadow.engine);
    if (seedMethod) {
      prepares.push(() => prepareDualFiles(logicalDbPath, {
        master: masterEntry.engine,
        shadow: shadow.engine,
        keepSeed: resolved.config.dual.journal,
        logger,
      }));
    }
    const previous = pair;
    pair = {
      engine: previous.engine,
      binding: createDualBinding({
        resolved,
        primary: previous,
        shadow,
        seedMethod,
        logger,
      }),
      // The nested pair maps the logical path onto its engines' files itself.
      pathFor: (l) => l,
      errorPaths: (l) => [...previous.errorPaths(l), ...shadow.errorPaths(l)],
      module: previous.module,
    };
  }
  return {
    mode: 'dual',
    engines,
    binding: pair.binding,
    databasePath: logicalDbPath,
    configSource: resolved.source,
    prepare: async () => { for (const prepare of prepares) await prepare(); },
  };
}
