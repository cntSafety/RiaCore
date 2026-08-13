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
import { useMutation } from '@tanstack/react-query';
import { App } from 'antd';
import { api } from '../api/riacore';
import { useWorkspaceState } from './useWorkspaceState';
import { useLifecycleHudStore } from '../store/lifecycleHudStore';

/**
 * Full workspace save mutation — calls `persistor.store` for all namespaces.
 * Used by both the File → Save menu item and the Save button in the canvas.
 * Appends a timestamped entry to the HUD activity log on success or failure.
 */
export function useFullWorkspaceSaveMutation() {
  // Instance-based message API so the error toast inherits the active theme
  // (dark mode). The static `message` export renders outside the <App> provider.
  const { message } = App.useApp();
  const state = useWorkspaceState();
  const workingDir = state.phase !== 'no_workspace' ? state.workingDir : null;

  return useMutation({
    mutationFn: () => api.persistor.store({ workingDir: workingDir! }),
    onSuccess: (result) => {
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const nsCount = result.namespaces_written.length;
      const skipped = result.namespaces_skipped.length;
      const detail = nsCount > 0
        ? `${nsCount} namespace${nsCount !== 1 ? 's' : ''} written${skipped > 0 ? `, ${skipped} unchanged` : ''}`
        : skipped > 0
          ? `${skipped} namespace${skipped !== 1 ? 's' : ''} unchanged`
          : 'no changes';
      useLifecycleHudStore.getState().logActivity(
        `${ts} ✓ Saved — ${detail}`,
        'success',
        workingDir ?? undefined,
      );
    },
    onError: (err) => {
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const msg = err instanceof Error ? err.message : String(err);
      useLifecycleHudStore.getState().logActivity(
        `${ts} · Save failed: ${msg}`,
        'error',
        workingDir ?? undefined,
      );
      void message.error(`Save failed: ${msg}`);
    },
  });
}
