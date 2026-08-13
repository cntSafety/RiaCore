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
import { useRef, useCallback, useEffect } from 'react';
import { App } from 'antd';
import { api } from '../api/riacore';
import { useWorkspaceState, isDbOpen } from './useWorkspaceState';
import { useLifecycleHudStore } from '../store/lifecycleHudStore';
import { useAutoSaveStatusStore } from '../store/autoSaveStatusStore';

/**
 * Returns `triggerAutoSave` (debounced, 500ms) and `flushAutoSave` (immediate).
 *
 * Use `triggerAutoSave` for rapid edits (field blur, tree navigation).
 * Use `flushAutoSave` after structural mutations (create/delete) so the
 * namespace is stored before the user can reload the renderer.
 *
 * A `beforeunload` listener also flushes any pending debounced save so that
 * Electron's "Force Reload" (Ctrl+Shift+R) doesn't lose unsaved changes.
 */
export function useAutoSave(authoredNamespace: string | null) {
  // Instance-based message API so the toast inherits the active theme (dark
  // mode). The static `message` export renders outside the <App> provider.
  const { message } = App.useApp();
  const state = useWorkspaceState();
  const phase = state.phase;
  const workingDir = phase !== 'no_workspace' ? state.workingDir : null;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const queued = useRef(false);

  // Keep stable refs so the beforeunload handler always sees the latest values
  const workingDirRef = useRef(workingDir);
  const authoredNamespaceRef = useRef(authoredNamespace);
  const stateRef = useRef(state);
  workingDirRef.current = workingDir;
  authoredNamespaceRef.current = authoredNamespace;
  stateRef.current = state;

  const runStore = useCallback(async () => {
    if (!workingDir || !authoredNamespace || !isDbOpen(state)) return;
    inFlight.current = true;
    useAutoSaveStatusStore.getState().setStatus('saving');
    try {
      await api.persistor.store({ workingDir, namespace: authoredNamespace });
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      useLifecycleHudStore.getState().logActivity(
        `${ts} ✓ Auto-saved — ${authoredNamespace}`,
        'success',
        workingDir,
      );
      // Only settle to 'saved' if no further mutation queued while this save
      // was in flight — a queued follow-up will re-derive its own status.
      if (!queued.current) useAutoSaveStatusStore.getState().setStatus('saved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      useLifecycleHudStore.getState().logActivity(
        `${ts} · Auto-save failed: ${msg}`,
        'error',
        workingDir,
      );
      useAutoSaveStatusStore.getState().setStatus('failed', msg);
      message.warning(`Auto-save failed: ${msg}`);
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void runStore();
      }
    }
  }, [workingDir, authoredNamespace, phase, message]);

  /** Debounced save — resets the timer on every call. Uses 0ms delay so it
   *  fires on the next event loop tick, batching rapid synchronous calls
   *  but not delaying across user interactions. */
  const triggerAutoSave = useCallback(() => {
    if (!isDbOpen(state)) return;
    useAutoSaveStatusStore.getState().setStatus('pending');
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      if (inFlight.current) {
        queued.current = true;
      } else {
        void runStore();
      }
    }, 0);
  }, [phase, runStore]);

  /**
   * Immediate save — bypasses the debounce timer.
   * Use after structural mutations (create/delete malfunction, etc.) so the
   * namespace is persisted before the user can reload the renderer.
   */
  const flushAutoSave = useCallback(() => {
    if (!isDbOpen(state)) return;
    useAutoSaveStatusStore.getState().setStatus('pending');
    // Cancel any pending debounce — we're saving now
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (inFlight.current) {
      queued.current = true;
    } else {
      void runStore();
    }
  }, [phase, runStore]);

  // Flush any pending debounced save when the renderer is about to unload
  // (Electron Force Reload, window close, etc.)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (
        debounceTimer.current !== null &&
        isDbOpen(stateRef.current) &&
        workingDirRef.current &&
        authoredNamespaceRef.current
      ) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        // Fire a synchronous-style store — best effort, renderer is unloading
        // sendBeacon isn't available for IPC, so we use the regular API.
        // The store will complete if the renderer stays alive long enough.
        if (!inFlight.current) {
          void api.persistor.store({
            workingDir: workingDirRef.current,
            namespace: authoredNamespaceRef.current,
          });
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []); // mount once — uses refs for current values

  return { triggerAutoSave, flushAutoSave };
}
