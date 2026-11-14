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
// packages/app-core/src/dispatch/load-gating.ts
import type { IpcChannelMap } from '@riacore/app-contracts';
import type { ICommandDispatcher, ServiceDependencies } from './index.js';
import type { IWorkspaceService } from '../workspace/workspace-service.js';
import { DbGenerationChangedError } from '../db/db-module.js';

/** Channels allowed to run while a Case B load is in flight (Req 6.4, 6.6 — single source). */
export const READ_ONLY_EXEMPTION_SET: ReadonlySet<string> = new Set([
  'workspace.open',
  'workspace.getStatus',
  'workspace.getRecent',
  'workspace.addRecent',
  'db.getStatus',
  'db.getStats',
]);

export interface LoadGate {
  dispatch<C extends keyof IpcChannelMap>(
    channel: C,
    payload: IpcChannelMap[C]['input'],
    deps: ServiceDependencies,
  ): Promise<IpcChannelMap[C]['output']>;
}

export interface GatedResult<T> { superseded?: true; data?: T; }

/**
 * A channel whose method names a read (`db.getStats`, `namespace.list`,
 * `graph.expand`, `views.evaluate`, `diff.computeNamespaces`). Verbs that are
 * reads only sometimes (`load`, `export`, `run`) are deliberately not here.
 */
const READ_VERB = /^(get|list|search|find|count|lookup|preview|expand|evaluate|compute)/i;

/** How often a read a database reopen overtook is answered again before it reports superseded. */
export const SUPERSEDED_READ_ATTEMPTS = 3;

/**
 * Whether `channel` may simply be run again after a database reopen overtook
 * it: it declares no `mutates` and its name says it reads. Not every channel
 * without `mutates` is read-only (Git commits, settings and check files write
 * outside the database), so the name has to say so as well; anything else is
 * reported superseded and never repeated, since repeating it would apply it to
 * whatever database is open now — possibly another workspace's.
 */
export function isRepeatableRead(dispatcher: ICommandDispatcher, channel: string): boolean {
  const meta = dispatcher.getChannelMeta(channel);
  const method = channel.split(/[.:]/).pop() ?? '';
  return !!meta && !meta.mutates && READ_VERB.test(method);
}

export function createLoadGate(
  dispatcher: ICommandDispatcher,
  workspaceService: IWorkspaceService,
): LoadGate {
  let drain: Promise<void> = Promise.resolve();

  async function runDispatch<C extends keyof IpcChannelMap>(
    channel: C, payload: IpcChannelMap[C]['input'], deps: ServiceDependencies,
  ): Promise<IpcChannelMap[C]['output']> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await dispatcher.dispatch(channel, payload, deps);
      } catch (err) {
        if (!DbGenerationChangedError.is(err)) throw err;
        // A read is answered from the database that is open now — what the
        // renderer, which follows the current workspace, wants anyway.
        if (attempt < SUPERSEDED_READ_ATTEMPTS && isRepeatableRead(dispatcher, channel as string)) {
          await workspaceService.whenLoadSettled();
          continue;
        }
        return { superseded: true } as IpcChannelMap[C]['output'];
      }
    }
  }

  const dispatch: LoadGate['dispatch'] = async (channel, payload, deps) => {
    const loading = await isLoadingFromRiaData(workspaceService);
    if (!loading || READ_ONLY_EXEMPTION_SET.has(channel as string)) {
      return runDispatch(channel, payload, deps);
    }
    const gated = drain
      .then(() => workspaceService.whenLoadSettled())
      .then(() => runDispatch(channel, payload, deps));
    drain = gated.then(() => undefined, () => undefined);
    return gated;
  };

  return { dispatch };
}

async function isLoadingFromRiaData(ws: IWorkspaceService): Promise<boolean> {
  const status = await ws.getStatus();
  return status.state === 'open' && status.info.lifecycleAction === 'loading_from_ria_data';
}
