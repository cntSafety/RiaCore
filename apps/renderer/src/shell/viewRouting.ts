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
 * View staleness rules for the root router.
 *
 * `RootApp` keeps the current view in plain local state, which makes it a SECOND
 * source of truth for "which namespace is open" — `workspaceStore.activeNamespace`
 * is the first. When the two drift apart the user is left looking at an editor
 * that no longer has a workspace or a selection behind it, and in one case with no
 * way back: `TopBar` gates the home button and the namespace breadcrumb on
 * `activeNamespace`, so clearing it while a namespace view is showing removes the
 * only escape and leaves a force reload as the only option.
 *
 * Extracted from the component so the rule is testable: it has already been
 * rediscovered twice (workspace close, then ria-data load), and both times the
 * symptom was a trapped UI rather than an obvious crash.
 */
import type { NamespaceContext } from '../store/workspaceStore';

export type View =
  | { type: 'canvas' }
  | { type: 'namespace'; ns: NamespaceContext }
  | { type: 'imports' }
  | { type: 'diff' };

export interface ViewContext {
  /** True when the app phase is `no_workspace`. */
  workspaceGone: boolean;
  /** The store's current namespace selection. */
  activeNamespace: NamespaceContext | null;
}

/**
 * Is `view` showing something that no longer exists?
 *
 * Two independent causes:
 *
 * 1. **The workspace is gone.** No workspace-scoped view can outlive it.
 * 2. **A namespace view has lost its store-side selection.** Every legitimate
 *    `setView({ type: 'namespace' })` also sets `activeNamespace`, so the pair
 *    being out of step can only mean something cleared the store from underneath
 *    the view — a ria-data load, a merge, an import, a namespace delete. All of
 *    those reassign node IDs, so the editor's local selection is stale regardless.
 */
export function isViewStale(view: View, ctx: ViewContext): boolean {
  if (ctx.workspaceGone) return true;
  return view.type === 'namespace' && ctx.activeNamespace === null;
}

/**
 * The view that should actually be rendered.
 *
 * Returns the canvas (overview / start screen) whenever the requested view is
 * stale, so correctness does not depend on every call site remembering to
 * navigate home after a teardown.
 */
export function resolveEffectiveView(view: View, ctx: ViewContext): View {
  if (view.type === 'canvas') return view;
  return isViewStale(view, ctx) ? { type: 'canvas' } : view;
}
