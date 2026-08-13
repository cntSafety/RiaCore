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
 * useShowInTree — hook that wraps `api.window.showInTree(payload)` in a
 * useMutation. Mirrors the structure of useOpenGraphCoreWindow.
 *
 * This is the only React-side caller of the IPC channel. ShowInTreeTrigger
 * uses this hook (or calls api.window.showInTree directly) when no in-place
 * navigation callback is provided.
 *
 * Requirements: 4.6
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/riacore';
import type { ShowInTreePayload } from '@riacore/app-contracts';

export function useShowInTree() {
  return useMutation({
    mutationFn: (payload: ShowInTreePayload) => api.window.showInTree(payload),
  });
}
