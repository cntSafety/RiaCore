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
 * Shared handling for a store refused because `ria-data/` changed on disk.
 *
 * Every path that can surface a `persistor.store` error must route through
 * `consumeSnapshotDriftError` FIRST. A refused store is not a failure — nothing
 * is broken and nothing is lost; the user owes a decision (Store or Load). The
 * raw message is useless to them: it leaks `Error invoking remote method
 * 'persistor.store'` and the `RIA_SNAPSHOT_DRIFT` marker, and it describes a
 * crash that did not happen.
 *
 * Centralised rather than inlined per call site because there are five of them
 * (`useAutoSave`, `useFullWorkspaceSaveMutation`, `useScopedSaveMutation` via the
 * canvas, and two stores inside `useRiacoreMutations`), and patching them one at
 * a time is how the first leak reached the user.
 *
 * See docs/coreSpecs/RiaDataChangeDetection.md §4.4.
 */
import type { QueryClient } from '@tanstack/react-query';
import { isSnapshotDriftError } from '@riacore/app-contracts';
import { SNAPSHOT_DRIFT_QUERY_KEY } from '../hooks/useSnapshotDrift';
import { useAutoSaveStatusStore } from '../store/autoSaveStatusStore';
import { useLifecycleHudStore } from '../store/lifecycleHudStore';

/** What the user is told in the activity log while the decision is outstanding. */
const PAUSED_MESSAGE =
  'Saving paused — the analysis files in ria-data/ changed on disk. Choose Store or Load to continue.';

/**
 * If `err` is a snapshot-drift refusal, absorb it and return true.
 *
 * Side effects on a match: mark the save status `needs_decision`, log a neutral
 * (non-error) activity entry, and refresh the drift query so
 * `SnapshotDriftDialog` raises the decision immediately instead of on the next
 * 5-second poll.
 *
 * Returns false for every other error, which the caller must then report as it
 * normally would.
 *
 * @example
 * onError: (err) => {
 *   if (consumeSnapshotDriftError(err, queryClient, workingDir)) return;
 *   // …normal error reporting…
 * }
 */
export function consumeSnapshotDriftError(
  err: unknown,
  queryClient: QueryClient,
  workingDir?: string | null,
): boolean {
  if (!isSnapshotDriftError(err)) return false;

  useAutoSaveStatusStore.getState().setStatus('needs_decision');

  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  useLifecycleHudStore.getState().logActivity(
    `${ts} · ${PAUSED_MESSAGE}`,
    'info',
    workingDir ?? undefined,
  );

  void queryClient.invalidateQueries({ queryKey: SNAPSHOT_DRIFT_QUERY_KEY });
  return true;
}
