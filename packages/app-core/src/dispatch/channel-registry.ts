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

/**
 * How a channel changes persisted workspace content.
 *
 * This is the Auto_Save classification. A channel that mutates the database
 * without declaring a scope leaves the DB ahead of `ria-data/`, so its changes
 * exist only in the DB and are lost on the next `persistor.load` (the documented
 * "load-as-undo" path). Declaring a scope here is what makes the database a
 * disposable cache rather than a second source of truth.
 *
 * Read-only channels leave `mutates` undefined.
 *
 * @see docs/coreSpecs/WorkspaceLifecycle.md — Auto-Save
 */
export type MutationScope =
  /**
   * Namespace-layer content (concepts, relationships, cross-namespace edges).
   *
   * The affected namespaces are NOT taken from the payload — they are resolved
   * at flush time by querying for `content_hash = ''`, which every write through
   * `instance-service` already sets. That indirection is deliberate: it means a
   * channel cannot declare the wrong namespace, and a new write path is covered
   * the moment it goes through the instance service.
   */
  | 'namespace'
  /**
   * Universe-layer only — canvas layout, view definitions, namespace
   * connections. Flushed with `store({ scope: 'universe' })`, which rewrites
   * just those files and leaves every namespace hash byte-identical.
   */
  | 'universe'
  /**
   * Requires a complete store. Needed when the change is not expressible as a
   * dirty namespace: sourcemaster rows (import source config), adding or
   * removing a namespace (stale-directory cleanup only runs on a full store),
   * or arbitrary user-supplied Cypher.
   */
  | 'full'
  /**
   * Mutates persisted content but performs its own `persistor.store`, so the
   * coordinator must NOT schedule a second one. Applies to the merge channels,
   * the persistor channels themselves, and workspace lifecycle operations.
   */
  | 'self';

/** Metadata for a registered channel */
export interface ChannelMeta {
  /** Whether the channel requires an open workspace/DB */
  requiresWorkspace: boolean;
  /** Whether the channel is Electron-only (worker process state) */
  electronOnly?: boolean;
  /** Human-readable category for grouping in --list output */
  category: string;
  /**
   * Auto_Save classification — how a successful dispatch changes persisted
   * content. Omitted for read-only channels.
   *
   * Every channel must be classified in
   * `__tests__/channel-mutation.conformance.test.ts`, which fails for any
   * channel it does not know about. That test is the reason a newly added
   * mutating channel cannot silently skip auto-save.
   */
  mutates?: MutationScope;
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
