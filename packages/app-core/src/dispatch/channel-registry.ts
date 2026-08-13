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
import type { IpcChannelMap } from '@riacore/app-contracts';
import type { ServiceDependencies, DispatchContext } from './types.js';

/** Metadata for a registered channel */
export interface ChannelMeta {
  /** Whether the channel requires an open workspace/DB */
  requiresWorkspace: boolean;
  /** Whether the channel is Electron-only (worker process state) */
  electronOnly?: boolean;
  /** Human-readable category for grouping in --list output */
  category: string;
}

/** A handler function for a specific channel */
export type ChannelHandler<C extends keyof IpcChannelMap> = (
  payload: IpcChannelMap[C]['input'],
  deps: ServiceDependencies,
  ctx: DispatchContext,
) => Promise<IpcChannelMap[C]['output']>;

/** Internal registry entry */
export interface ChannelEntry {
  handler: ChannelHandler<any>;
  meta: ChannelMeta;
}

/** Creates a new channel registry with a `register` helper */
export function createRegistry() {
  const map = new Map<string, ChannelEntry>();

  return {
    map,
    register<C extends keyof IpcChannelMap>(
      channel: C,
      handler: ChannelHandler<C>,
      meta: ChannelMeta,
    ): void {
      map.set(channel, { handler, meta });
    },
  };
}
