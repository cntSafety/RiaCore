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
 * The concept presentation catalog (spec-view.md Phase 4.1).
 *
 * Replaces the renderer's hardcoded per-metamodel concept sets. Presentation is
 * stored outside the view and outside `CommonModel` (docs/coreSpecs/RiaViews.md
 * — P6), so this is the only place the renderer learns which concepts it
 * renders and how.
 *
 * The catalog is read on demand by the backend rather than cached for the
 * process lifetime, so an edited `<repo>/ria-config/concept-presentation.json`
 * takes effect without a restart. The `staleTime` below is what bounds how soon
 * the renderer notices — long enough that classification does not re-fetch on
 * every selection, short enough that an edit is not stuck behind a reload.
 */
import { useQuery } from '@tanstack/react-query';
import type { ConceptPresentation } from '@riacore/app-contracts';
import { api } from '../api/riacore';

/** The immediate metamodel of every view the renderer currently displays. */
export const COMMON_MODEL_METAMODEL = 'COMMON_MODEL';

const EMPTY: ConceptPresentation[] = [];

export function usePresentation(
  metamodel: string,
  workspaceKey: string | null | undefined,
) {
  return useQuery<ConceptPresentation[]>({
    queryKey: ['presentation.get', workspaceKey, metamodel],
    queryFn: () => api.presentation.get(metamodel),
    enabled: !!workspaceKey && !!metamodel,
    staleTime: 60_000,
  });
}

/** The `CommonModel` entries, defaulting to an empty catalog while loading. */
export function useCommonModelPresentation(workspaceKey: string | null | undefined): ConceptPresentation[] {
  const { data } = usePresentation(COMMON_MODEL_METAMODEL, workspaceKey);
  return data ?? EMPTY;
}
