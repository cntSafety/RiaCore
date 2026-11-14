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
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { NamespaceInfo } from '@riacore/app-contracts';
import type { MetamodelRenderingConfig } from '@riacore/app-contracts';
import { api } from '../../../../../api/riacore';
import { metamodelRenderingQueryKey } from '../../../../../hooks/useMetamodelRendering';
import { useWorkspaceQueryEnabled } from '../../../../../hooks/useWorkspaceQueryEnabled';
import { useWorkspaceState } from '../../../../../hooks/useWorkspaceState';
import { useAllNamespaces } from './useTreeQueries';
import { buildSysmlDecorations } from '../config/nodeTypeConfig';

/**
 * The metamodel overlay for tree rows and related-element rows.
 *
 * Built from the rendering config of every metamodel actually present in the
 * workspace, rather than a fixed list. It used to name SysMLv2 and
 * SysMLv2Textual explicitly, which meant a metamodel declaring perfectly good
 * `rendering:` blocks in its LinkML — as the CGraph code-graph metamodel does
 * for all eleven of its concepts — rendered every node with the grey default
 * icon until someone remembered to add it here. The declaration already travels
 * from the YAML through `RIA_META_Concept.render_*` to
 * `metamodel.getRenderingConfig`; this is the one link that needed to stop
 * being a hardcoded allowlist.
 *
 * The result is a flat concept → decoration map, so two metamodels declaring
 * the same concept name would collide on last-write-wins. That was already true
 * of the SysML pair this replaced, and the merge order below is stable
 * (namespace list order), so the outcome is at least deterministic. Concept
 * names are metamodel-scoped by convention — `c_*` for CGraph, `need_*` for
 * Sphinx-Needs — which is what keeps the flat map workable.
 *
 * Note the overlay sits *below* the static NODE_TYPE_CONFIG in
 * `getNodeDecoration`'s precedence, so broadening the fetch cannot change how
 * an ARXML or safety concept already renders.
 */
export function useTreeDecorations() {
  const workspaceQueryEnabled = useWorkspaceQueryEnabled();
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;
  const { data: namespaces } = useAllNamespaces(workspaceKey);

  // Distinct and sorted so the query list — and therefore the merge order and
  // the resulting object identity — does not churn when the namespace list is
  // refetched with the same content in a different order.
  const metamodels = useMemo(() => {
    const names = (namespaces ?? [])
      .map((ns: NamespaceInfo) => ns.metamodel)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    return [...new Set(names)].sort();
  }, [namespaces]);

  // useQueries rather than a loop of useMetamodelRendering: the metamodel list
  // is discovered at runtime and changes as namespaces are imported or deleted,
  // and calling a hook per element of a varying array breaks the rules of hooks.
  // The query key and options mirror useMetamodelRendering so both share one
  // cache entry and one invalidation.
  const results = useQueries({
    queries: metamodels.map((metamodel) => ({
      queryKey: metamodelRenderingQueryKey(metamodel),
      queryFn: () => api.metamodel.getRenderingConfig(metamodel),
      enabled: workspaceQueryEnabled,
      staleTime: Infinity,
      gcTime: Infinity,
    })),
  });

  // Depend on the resolved configs, not on `results` — useQueries returns a new
  // array every render, which would rebuild the overlay each time and, via the
  // configVersion counter in NamespaceTreePanel, invalidate the icon cache for
  // every node on every render.
  const configs = results.map((r) => r.data);
  const configKey = metamodels.join('\u0001');

  return useMemo(() => {
    const merged: MetamodelRenderingConfig = {};
    let any = false;
    for (const config of configs) {
      if (!config) continue;
      any = true;
      Object.assign(merged, config);
    }
    // undefined rather than an empty object: callers treat "no overlay yet" as
    // distinct from "overlay with nothing in it", and the tests rely on it.
    if (!any) return undefined;
    return buildSysmlDecorations(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, ...configs]);
}
