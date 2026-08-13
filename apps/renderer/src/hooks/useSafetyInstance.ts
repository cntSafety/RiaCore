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
import { useQuery } from '@tanstack/react-query';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/**
 * Reads the live `ConceptInstanceData` for a single node id via the
 * `safety.getInstance` IPC channel.
 *
 * The query key matches the existing `['safety.instance', nodeId]` key used
 * elsewhere in the renderer (see
 * `modules/namespace/editors/safety-analysis/hooks/useSafetyQueries.ts`),
 * so the cache is shared across all consumers.
 *
 * The hook is gated on `nodeId !== undefined` so callers can safely pass
 * `undefined` while a parent component is still resolving the selected
 * element id.
 *
 * Steering-rule note: every consumer that needs the Selected_Element's
 * display name must read it through this fresh query rather than from a
 * cached tree-click state object — names go stale after renames or
 * supervised merges. This hook is the renderer-wide entry point used by
 * `LlmReviewModal` for that purpose (Requirement 4.7).
 */
export function useSafetyInstance(nodeId: number | undefined) {
  return useQuery<ConceptInstanceData>({
    queryKey: ['safety.instance', nodeId],
    queryFn: () => api.safety.getInstance(nodeId as number),
    enabled: nodeId !== undefined,
  });
}
