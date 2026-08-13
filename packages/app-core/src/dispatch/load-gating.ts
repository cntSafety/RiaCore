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

export function createLoadGate(
  dispatcher: ICommandDispatcher,
  workspaceService: IWorkspaceService,
): LoadGate {
  let drain: Promise<void> = Promise.resolve();

  async function runDispatch<C extends keyof IpcChannelMap>(
    channel: C, payload: IpcChannelMap[C]['input'], deps: ServiceDependencies,
  ): Promise<IpcChannelMap[C]['output']> {
    try {
      return await dispatcher.dispatch(channel, payload, deps);
    } catch (err) {
      if (DbGenerationChangedError.is(err)) {
        return { superseded: true } as IpcChannelMap[C]['output'];
      }
      throw err;
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
