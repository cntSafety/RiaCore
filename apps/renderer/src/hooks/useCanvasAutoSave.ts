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
 * `useCanvasAutoSave` — the React binding of the Auto_Save_Coordinator core
 * (canvas-layout-auto-save, task 8.2).
 *
 * This hook wires the PURE coordinator core
 * (`createCanvasAutoSaveCoordinator`, task 6.1) to real renderer dependencies:
 *  - the real clock (`Date.now` + `window.setTimeout`),
 *  - `useScopedSaveMutation` as the injected `save` function (universe or full),
 *  - `useWorkspaceState().phase` as the phase provider (phase-gates scheduling),
 *  - the TanStack Query cache as the synchronous DB reader for the post-save
 *    divergence check (Req 1.6), and
 *  - `useAutoSaveStatusStore.setStatus` as the Save_Status sink (Req 9).
 *
 * It exposes `scheduleSave()` (notify a qualifying mutation completed) and
 * `flushSave()` (run any pending/in-flight save to completion, bounded by the
 * 5000 ms deadline — Req 7.4, 7.5). All timing/retry/coalescing logic lives in
 * the pure core; this hook only supplies live dependencies via refs so the
 * long-lived coordinator always observes the current phase, working directory,
 * mutation, and query cache.
 *
 * Requirements: 1.1, 2.1, 2.2, 7.4, 7.5
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createCanvasAutoSaveCoordinator,
  type CanvasAutoSaveCoordinator,
  type CoordinatorClock,
  type SaveScope,
} from '../lib/canvasAutoSaveCoordinator';
import { useWorkspaceState } from './useWorkspaceState';
import { useScopedSaveMutation } from './useScopedSaveMutation';
import { useAutoSaveStatusStore } from '../store/autoSaveStatusStore';
import { diagramLayoutQueryKey } from './useDiagramLayout';
import { namespaceConnectionsQueryKey } from './useNamespaceConnections';

/**
 * Opaque snapshot of the canvas-relevant DB content, read synchronously from
 * the TanStack Query cache. Used only for the coordinator's post-save
 * divergence equality check (Req 1.6); its shape is never interpreted.
 */
export interface CanvasDbSnapshot {
  layout: unknown;
  connections: unknown;
}

function readCanvasDbSnapshot(
  queryClient: QueryClient,
  workingDir: string | null,
): CanvasDbSnapshot {
  return {
    layout: queryClient.getQueryData(diagramLayoutQueryKey) ?? null,
    connections:
      queryClient.getQueryData(namespaceConnectionsQueryKey(workingDir)) ?? null,
  };
}

/** Real clock backing the coordinator in production. */
const realClock: CoordinatorClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export interface CanvasAutoSaveApi {
  /**
   * Schedule a coalesced Auto_Save at `scope` (default `'universe'`). Pass
   * `'full'` after a mutation that changes which namespaces exist (namespace /
   * import-source delete) so the deletion is actually pruned from disk.
   */
  scheduleSave: (scope?: SaveScope) => void;
  flushSave: () => Promise<void>;
}

export function useCanvasAutoSave(): CanvasAutoSaveApi {
  const ws = useWorkspaceState();
  const queryClient = useQueryClient();
  const scopedSave = useScopedSaveMutation();
  const setStatus = useAutoSaveStatusStore((s) => s.setStatus);

  const phase = ws.phase;
  const workingDir = ws.phase !== 'no_workspace' ? ws.workingDir : null;

  // Keep the latest live values in refs so the long-lived coordinator's stable
  // closures always observe current state (mirrors useAutoSave.ts).
  const phaseRef = useRef(phase);
  const workingDirRef = useRef(workingDir);
  const scopedSaveRef = useRef(scopedSave);
  const queryClientRef = useRef(queryClient);
  const setStatusRef = useRef(setStatus);
  phaseRef.current = phase;
  workingDirRef.current = workingDir;
  scopedSaveRef.current = scopedSave;
  queryClientRef.current = queryClient;
  setStatusRef.current = setStatus;

  // Create the coordinator exactly once for the lifetime of the hook.
  const coordinatorRef = useRef<CanvasAutoSaveCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createCanvasAutoSaveCoordinator<CanvasDbSnapshot>({
      clock: realClock,
      getPhase: () => phaseRef.current,
      getWorkingDir: () => workingDirRef.current,
      save: async (wd, scope) => {
        // Persist at the requested scope (reads the DB at execution time —
        // Req 4.4) and return a snapshot of the persisted content for the
        // divergence check. A 'full' scope also prunes deleted namespaces from
        // disk; 'universe' writes only the two universe-layer files.
        await scopedSaveRef.current.mutateAsync({ workingDir: wd, scope });
        return readCanvasDbSnapshot(queryClientRef.current, workingDirRef.current);
      },
      readDb: () =>
        readCanvasDbSnapshot(queryClientRef.current, workingDirRef.current),
      setStatus: (s, error) => setStatusRef.current(s, error),
    });
  }

  // Cancel outstanding timers when the hook unmounts.
  useEffect(() => {
    const coordinator = coordinatorRef.current;
    return () => coordinator?.dispose();
  }, []);

  const scheduleSave = useCallback((scope?: SaveScope) => {
    coordinatorRef.current?.scheduleSave(scope);
  }, []);

  const flushSave = useCallback(
    () => coordinatorRef.current?.flushSave() ?? Promise.resolve(),
    [],
  );

  return useMemo(() => ({ scheduleSave, flushSave }), [scheduleSave, flushSave]);
}
