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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LlmSaveSettingsInput } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Mutation hook for persisting LLM settings via the `llm.saveSettings`
 * IPC channel.
 *
 * On success it invalidates the `['llm.settings']` TanStack Query key so that
 * `useLlmSettings` re-fetches the freshly persisted record. This is the only
 * TanStack Query invalidation in the LLM Component Review feature — Review_Runs
 * never invalidate any cache key (see Requirement 8.12).
 *
 * Errors thrown by the worker (missing OS keychain, provider rejection, etc.)
 * propagate as `Error` to the caller via the standard mutation error path so
 * the dialog can surface them through its toast affordance.
 */
export function useSaveLlmSettings() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, LlmSaveSettingsInput>({
    mutationFn: (input) => api.llm.saveSettings(input),
    onSuccess: () => {
      return queryClient.invalidateQueries({ queryKey: ['llm.settings'] });
    },
  });
}
