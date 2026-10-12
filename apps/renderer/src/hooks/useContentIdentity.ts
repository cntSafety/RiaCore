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
 * Identity of the workspace content currently on screen.
 *
 * Use as a React `key` on any subtree holding component-local state that must not
 * outlive the content it describes. When the identity changes React unmounts and
 * remounts the subtree, discarding every `useState`, `useRef`, scroll position and
 * uncommitted form draft inside it — including the state no one thought to reset.
 *
 * Two components:
 *   workingDir        which workspace
 *   contentGeneration which generation of its content (see workspaceStore)
 *
 * This is the framework-level version of a chore that was previously done per
 * component, differently each time: `GraphCoreWindowView` kept a `prevKeyRef` and
 * cleared six fields by hand, `WorkspaceCanvas` ran its own reset effect, and
 * `SafetyEditor` did not reset at all. The last of those is how a ria-data load
 * left a malfunction editor on screen with no way back to the overview.
 *
 * Note the deliberate difference from `workspaceKey`, which several components
 * derive for query cache keys: that one answers "which workspace is this data
 * from?" and must stay stable across a content rebuild so caches are keyed
 * consistently. This one answers "is what I am looking at still the same thing?"
 * and changes on every rebuild. They are not interchangeable.
 */
import { useWorkspaceStore } from '../store/workspaceStore';

export function useContentIdentity(): string {
  const workingDir = useWorkspaceStore((s) => s.workingDir);
  const contentGeneration = useWorkspaceStore((s) => s.contentGeneration);
  return `${workingDir ?? '(none)'}::${contentGeneration}`;
}
