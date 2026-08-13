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
import { api } from '../../../../../api/riacore';
import type { CreateMalfunctionParams, CreateRiskRatingParams } from '@riacore/app-contracts';
import type { CopiedMalfunctionData } from '../../../../../store/workspaceStore';
import { treeChildrenQueryKey } from './useTreeQueries';
import { requestCrossWindowInvalidation } from '../../../../../lib/cache-invalidation-subscriber';
import { beginOpTrace, type OpTrace } from '../../../../../lib/opTrace';

// ---------------------------------------------------------------------------
// Diagnostics helper: how many tree.children queries are currently cached for a
// namespace. The tree keeps its nodes in a local reducer and does NOT mount
// observers for loaded branches, so these queries are inactive and eligible for
// garbage collection. When the count is 0, a mutation's tree.children
// invalidation matches nothing and the tree-sync subscription never fires — the
// branch is not refreshed. Logging this count makes that failure mode visible
// in the lifecycle log.
// ---------------------------------------------------------------------------
function countTreeChildrenCached(
  qc: ReturnType<typeof useQueryClient>,
  workspaceKey: string | null,
  namespace: string,
): { cached: number; rootCached: boolean } {
  if (!workspaceKey) return { cached: 0, rootCached: false };
  let rootCached = false;
  const queries = qc.getQueryCache().findAll({
    predicate: (q) => {
      const key = q.queryKey;
      const match = Array.isArray(key)
        && key[0] === 'tree.children'
        && key[1] === workspaceKey
        && key[2] === namespace;
      if (match && (key as unknown[])[3] === undefined) rootCached = true;
      return match;
    },
  });
  return { cached: queries.length, rootCached };
}

// ---------------------------------------------------------------------------
// Helper: broadcast the derived propagation cache keys to OTHER windows.
//
// propagationGraph (aggregate BFS result) and the per-node safety.propagations*
// lists only exist in a window that is currently showing a propagation view.
// The automatic QueryCache-event broadcaster therefore never emits them from a
// window that isn't — so a malfunction edited in the spawn window (which shows
// no propagation view) would refresh the tree in the main window but leave its
// open propagation diagram stale. These explicit broadcasts close that gap.
// They do not invalidate locally — each mutation's onSuccess already invalidates
// the same keys in the originating window.
// ---------------------------------------------------------------------------
function broadcastPropagationInvalidations() {
  requestCrossWindowInvalidation(['propagationGraph']);
  requestCrossWindowInvalidation(['safety.propagations']);
  requestCrossWindowInvalidation(['safety.propagationsForComponent']);
}

// ---------------------------------------------------------------------------
// Helper: invalidate tree.children for a namespace root and optionally a
// specific structural parent (for cross-namespace reference nodes).
// Returns a Promise so callers can await it in onSuccess.
// ---------------------------------------------------------------------------
async function invalidateTreeChildren(
  qc: ReturnType<typeof useQueryClient>,
  workspaceKey: string | null,
  namespace: string,
  parentNodeId?: number,
) {
  if (!workspaceKey) return;
  await qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, namespace, parentNodeId) });
}

// ---------------------------------------------------------------------------
// Helper: invalidate ALL tree.children keys for a single namespace, regardless
// of parentNodeId. Use this as a robust safety net when the exact structural
// parent of an affected node cannot be determined cheaply — the tree only
// re-fetches parents that are currently loaded, so the cost is bounded.
// ---------------------------------------------------------------------------
async function invalidateAllTreeChildrenForNamespace(
  qc: ReturnType<typeof useQueryClient>,
  workspaceKey: string | null,
  namespace: string,
) {
  if (!workspaceKey) return;
  await qc.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey;
      return Array.isArray(key)
        && key[0] === 'tree.children'
        && key[1] === workspaceKey
        && key[2] === namespace;
    },
  });
}

// ---------------------------------------------------------------------------
// Standardized helper: invalidate the tree for an element that may appear both
// (a) in its own authored namespace (as a node and/or under a parent element),
// and (b) as a cross-namespace reference child under a structural parent in an
// imported namespace (e.g. a malfunction's occurs_at port).
//
// This replaces the fragile pattern of reading occursAtTarget from the query
// cache (which silently no-ops on a cold cache). It is robust because:
//   1. It always invalidates ALL tree.children for the element's own namespace
//      (covers the namespace root AND any expanded parent element subtree).
//   2. If an explicit structural parent is known, it invalidates that key too.
//   3. If the structural parent is NOT supplied, it resolves it on demand from
//      the malfunction record (never depending on cache warmth).
//
// `resolveOccursAtFor` is an optional node id; when provided and no explicit
// structuralParent is given, the malfunction's occurs_at target is fetched and
// invalidated. Pass it for malfunction create/update/delete.
// ---------------------------------------------------------------------------
async function invalidateElementInTree(
  qc: ReturnType<typeof useQueryClient>,
  workspaceKey: string | null,
  namespace: string,
  opts: {
    /** Explicit structural parent (imported namespace) if already known. */
    structuralParent?: { nodeId: number; namespace: string } | null;
    /** Malfunction node id whose occurs_at target should be resolved + invalidated. */
    resolveOccursAtFor?: number;
  } = {},
) {
  if (!workspaceKey) return;

  const tasks: Promise<void>[] = [
    // (1) Robust net: every loaded parent in the element's own namespace.
    invalidateAllTreeChildrenForNamespace(qc, workspaceKey, namespace),
  ];

  // (2) Explicit structural parent, if the caller already knows it.
  if (opts.structuralParent) {
    tasks.push(
      invalidateTreeChildren(qc, workspaceKey, opts.structuralParent.namespace, opts.structuralParent.nodeId),
    );
  } else if (opts.resolveOccursAtFor !== undefined) {
    // (3) Resolve occurs_at without depending on cache warmth.
    tasks.push(
      (async () => {
        let target =
          qc.getQueryData<import('@riacore/app-contracts').MalfunctionData>(
            ['safety.malfunction', opts.resolveOccursAtFor!],
          )?.occursAtTarget ?? null;
        if (!target) {
          try {
            const fm = await api.safety.getMalfunction(opts.resolveOccursAtFor!);
            target = fm.occursAtTarget ?? null;
          } catch {
            // Best effort — the namespace-wide net above still covers the
            // authored-side reference; a missing imported-side refresh will
            // self-heal on next expand.
          }
        }
        if (target) {
          await invalidateTreeChildren(qc, workspaceKey, target.namespace, target.node_id);
        }
      })(),
    );
  }

  await Promise.all(tasks);
}

// ── Malfunction mutations ──────────────────────────────────────────────────

export function useCreateMalfunction(
  namespace: string,
  workspaceKey: string | null = null,
  occursAtNamespace?: string,
  triggerAutoSave?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    onMutate: (params: CreateMalfunctionParams): { trace: OpTrace } => ({
      trace: beginOpTrace('malfunction.create', 'Malfunction create requested', {
        namespace,
        occursAtNodeId: params.occursAtNodeId,
        workspaceKeyPresent: !!workspaceKey,
      }),
    }),
    mutationFn: (params: CreateMalfunctionParams) => api.safety.createMalfunction(params),
    onError: (error, _params, ctx) => {
      ctx?.trace.fail(error);
    },
    onSuccess: async (_data, params, ctx) => {
      ctx?.trace.backend('DB updated — malfunction created', {
        newNodeId: (_data as { node_id?: number } | undefined)?.node_id,
      });
      const invalidations: Promise<void>[] = [
        qc.invalidateQueries({ queryKey: ['safety.malfunctions', namespace] }),
        // Keep the table view (MalfunctionTableView) in sync — it uses
        // propagationsForComponent as its data source.
        qc.invalidateQueries({ queryKey: ['safety.propagationsForComponent'] }),
      ];
      if (params.occursAtNodeId !== undefined) {
        invalidations.push(
          qc.invalidateQueries({ queryKey: ['safety.malfunctionsForElement', params.occursAtNodeId] }),
        );
      }
      // Refresh the authored namespace (all loaded parents) and, when known, the
      // imported structural parent where the new malfunction appears as a
      // reference child.
      invalidations.push(
        invalidateElementInTree(qc, workspaceKey, namespace, {
          structuralParent:
            params.occursAtNodeId !== undefined && occursAtNamespace
              ? { nodeId: params.occursAtNodeId, namespace: occursAtNamespace }
              : null,
        }),
      );
      await Promise.all(invalidations);
      // Cross-window: a newly created malfunction should appear in propagation
      // views in other windows (e.g. scoped diagrams for its occurs_at element).
      broadcastPropagationInvalidations();
      const treeCache = countTreeChildrenCached(qc, workspaceKey, namespace);
      ctx?.trace.frontend('Tree refresh requested (invalidations dispatched)', treeCache);
      ctx?.trace.end();
      triggerAutoSave?.();
    },
  });
}

export function useUpdateMalfunction(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    onMutate: ({ nodeId }: { nodeId: number; updates: Record<string, unknown> }): { trace: OpTrace } => ({
      trace: beginOpTrace('malfunction.update', 'Malfunction update requested', {
        nodeId,
        namespace,
        workspaceKeyPresent: !!workspaceKey,
      }),
    }),
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown> }) =>
      api.safety.updateMalfunction(nodeId, updates),
    onError: (error, _vars, ctx) => {
      // A failure here with "ConceptInstance with node_id N not found" means the
      // node is gone from the DB but was still selectable in the tree — i.e. a
      // stale tree node. This is the user-visible symptom of the delete/tree-sync
      // bug; logging it ties the error to the node id for post-mortem analysis.
      ctx?.trace.fail(error);
    },
    onSuccess: async (_data, { nodeId }, ctx) => {
      ctx?.trace.backend('DB updated — malfunction updated', { nodeId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.malfunctions', namespace] }),
        qc.invalidateQueries({ queryKey: ['safety.malfunction', nodeId] }),
        qc.invalidateQueries({ queryKey: ['propagationGraph'] }),
        qc.invalidateQueries({ queryKey: ['safety.propagationsForComponent'] }),
        // Per-node propagation lists feed the propagation graph (usePropagationGraph
        // rebuilds neighbour names from ['safety.propagations', id]). The renamed
        // malfunction appears in its own list AND in every neighbour's list, so a
        // broad prefix invalidation is required — otherwise the graph refetches but
        // reads stale names from these un-invalidated per-node caches.
        qc.invalidateQueries({ queryKey: ['safety.propagations'] }),
        // Robustly refresh the authored namespace AND the imported-namespace
        // reference node under the malfunction's occurs_at port. The occurs_at
        // target is resolved on demand, so the reference title never goes stale
        // due to a cold cache.
        invalidateElementInTree(qc, workspaceKey, namespace, { resolveOccursAtFor: nodeId }),
      ]);
      // Cross-window: refresh propagation views in other windows (e.g. the main
      // window) when the rename/edit happened in a window with no propagation
      // view of its own. See broadcastPropagationInvalidations.
      broadcastPropagationInvalidations();
      const treeCache = countTreeChildrenCached(qc, workspaceKey, namespace);
      ctx?.trace.frontend('Tree refresh requested (invalidations dispatched)', treeCache);
      ctx?.trace.end();
      triggerAutoSave?.();
    },
  });
}

export function useDeleteMalfunction(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    onMutate: (nodeId: number): { trace: OpTrace } => ({
      trace: beginOpTrace('malfunction.delete', 'Malfunction delete requested', {
        nodeId,
        namespace,
        workspaceKeyPresent: !!workspaceKey,
      }),
    }),
    // Resolve the occurs_at target BEFORE deleting — afterwards the malfunction
    // record is gone and can no longer be fetched. Prefer the cache, fall back
    // to a live read so the result never depends on cache warmth.
    mutationFn: async (nodeId: number) => {
      let structuralParent: { nodeId: number; namespace: string } | null = null;
      let target =
        qc.getQueryData<import('@riacore/app-contracts').MalfunctionData>(
          ['safety.malfunction', nodeId],
        )?.occursAtTarget ?? null;
      if (!target) {
        try {
          const fm = await api.safety.getMalfunction(nodeId);
          target = fm.occursAtTarget ?? null;
        } catch {
          // ignore — namespace-wide net below still covers the authored side
        }
      }
      if (target) structuralParent = { nodeId: target.node_id, namespace: target.namespace };

      await api.safety.deleteMalfunction(nodeId);
      return { nodeId, structuralParent };
    },
    onError: (error, _nodeId, ctx) => {
      ctx?.trace.fail(error);
    },
    onSuccess: async ({ nodeId, structuralParent }, _vars, ctx) => {
      ctx?.trace.backend('DB updated — malfunction deleted', { nodeId, structuralParent });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.malfunctions', namespace] }),
        qc.invalidateQueries({ queryKey: ['safety.malfunction', nodeId] }),
        // Keep the table view (MalfunctionTableView) in sync — it uses
        // propagationsForComponent as its data source.
        qc.invalidateQueries({ queryKey: ['safety.propagationsForComponent'] }),
        // Robustly remove the node from the authored namespace AND its reference
        // node under the imported occurs_at port (captured before deletion).
        invalidateElementInTree(qc, workspaceKey, namespace, { structuralParent }),
      ]);
      // Cross-window: a deleted malfunction must disappear from propagation
      // views in other windows too.
      broadcastPropagationInvalidations();
      const treeCache = countTreeChildrenCached(qc, workspaceKey, namespace);
      ctx?.trace.frontend('Tree refresh requested (invalidations dispatched)', treeCache);
      triggerAutoSave?.();

      // Verify against the authoritative source whether the node is still served
      // as a child of the namespace root. If it is, the tree will keep showing
      // it — the stale-node symptom. Logging this distinguishes a backend delete
      // failure from a frontend tree-sync miss.
      if (workspaceKey) {
        try {
          const root = await api.namespaces.getChildren(namespace, undefined, 0, 200);
          const stillPresent = root.children.some((c) => c.node_id === nodeId);
          ctx?.trace.step('verify', stillPresent
            ? 'Node still present in namespace root after delete'
            : 'Node absent from namespace root (delete confirmed)', {
            nodeId,
            stillPresentInRootChildren: stillPresent,
            rootChildCount: root.children.length,
            rootHasMore: root.hasMore,
          });
        } catch (err) {
          ctx?.trace.step('verify', 'Verification fetch failed', { nodeId, error: String(err) });
        }
      }
      ctx?.trace.end();
    },
  });
}

// ── Risk Rating mutations ───────────────────────────────────────────────────
// Risk ratings are not tree nodes — no tree.children invalidation needed.

export function useCreateRiskRating(triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateRiskRatingParams) => api.safety.createRiskRating(params),
    onSuccess: async (_data, params) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.riskRating', params.failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.malfunction', params.failureModeNodeId] }),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUpdateRiskRating(fmNodeId: number | undefined, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown> }) =>
      api.safety.updateRiskRating(nodeId, updates),
    onSuccess: async () => {
      if (fmNodeId !== undefined) {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['safety.riskRating', fmNodeId] }),
          qc.invalidateQueries({ queryKey: ['safety.malfunction', fmNodeId] }),
        ]);
      }
      triggerAutoSave?.();
    },
  });
}

export function useDeleteRiskRating(fmNodeId: number | undefined, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: number) => api.safety.deleteRiskRating(nodeId),
    onSuccess: async () => {
      if (fmNodeId !== undefined) {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['safety.riskRating', fmNodeId] }),
          qc.invalidateQueries({ queryKey: ['safety.malfunction', fmNodeId] }),
        ]);
      }
      triggerAutoSave?.();
    },
  });
}

/** Tree-level delete for risk_rating nodes. Invalidates tree.children so the
 *  node disappears from the namespace tree. The fmNodeId-scoped invalidations
 *  (safety.riskRating, safety.malfunction) are not needed here because the
 *  malfunction editor re-fetches on selection, not on tree change. */
export function useDeleteRiskRatingFromTree(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: number) => api.safety.deleteRiskRating(nodeId),
    onSuccess: async () => {
      await Promise.all([
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Safety Task mutations ───────────────────────────────────────────────────

export function useCreateSafetyTask(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { failureModeNodeId: number; name: string; description: string; status: string; type: string }) =>
      api.safety.createSafetyTask(namespace, params.name, params.description, params.status, params.type)
        .then(async (created) => {
          await api.safety.linkSafetyTaskToFm(params.failureModeNodeId, created.node_id);
          return created;
        }),
    onSuccess: async (_data, params) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.safetyTasks', params.failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] }),
        // Covers a flat authored namespace (task at root) AND a structured one
        // (task nested under the expanded malfunction).
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useLinkSafetyTaskToFm(namespace: string, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, safetyTaskNodeId }: { failureModeNodeId: number; safetyTaskNodeId: number }) =>
      api.safety.linkSafetyTaskToFm(failureModeNodeId, safetyTaskNodeId),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.safetyTasks', failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] }),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUnlinkSafetyTaskFromFm(namespace: string, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, safetyTaskNodeId }: { failureModeNodeId: number; safetyTaskNodeId: number }) =>
      api.safety.unlinkSafetyTaskFromFm(failureModeNodeId, safetyTaskNodeId),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.safetyTasks', failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] }),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUpdateSafetyTask(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown>; fmNodeId?: number }) =>
      api.safety.updateSafetyTask(nodeId, updates),
    onSuccess: async (_data, { fmNodeId }) => {
      await Promise.all([
        fmNodeId !== undefined
          ? qc.invalidateQueries({ queryKey: ['safety.safetyTasks', fmNodeId] })
          : Promise.resolve(),
        qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

// spec: safety-task-risk-rating-delete §3.1 — no changes needed here.
// When called with { nodeId } (no fmNodeId) from NamespaceTreePanel the
// fmNodeId-conditional safety.safetyTasks invalidation is intentionally
// skipped; safety.allSafetyTasks and tree.children are always invalidated.
// Requirements: 3.3, 3.4, 4.3, 4.4
export function useDeleteSafetyTask(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: number; fmNodeId?: number }) =>
      api.safety.deleteSafetyTask(nodeId),
    onSuccess: async (_data, { fmNodeId }) => {
      await Promise.all([
        fmNodeId !== undefined
          ? qc.invalidateQueries({ queryKey: ['safety.safetyTasks', fmNodeId] })
          : Promise.resolve(),
        qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Requirement mutations ───────────────────────────────────────────────────

export function useCreateRequirement(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { name: string; reqId: string; reqText: string; asil?: string; linkedToUrl?: string; fmNodeId?: number }) =>
      api.safety.createRequirement(namespace, params.name, params.reqId, params.reqText, params.asil, params.linkedToUrl),
    onSuccess: async (_data, { fmNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] }),
        fmNodeId !== undefined
          ? qc.invalidateQueries({ queryKey: ['safety.requirementsForFm', fmNodeId] })
          : Promise.resolve(),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUpdateRequirement(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown>; fmNodeId?: number }) =>
      api.safety.updateRequirement(nodeId, updates),
    onSuccess: async (_data, { fmNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] }),
        fmNodeId !== undefined
          ? qc.invalidateQueries({ queryKey: ['safety.requirementsForFm', fmNodeId] })
          : Promise.resolve(),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useDeleteRequirement(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: number) => api.safety.deleteRequirement(nodeId),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] }),
        qc.invalidateQueries({ queryKey: ['safety.requirementsForFm'] }),
        qc.invalidateQueries({ queryKey: ['requirements.details'] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Safety Note mutations ───────────────────────────────────────────────────

export function useCreateSafetyNote(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { noteText: string; targetNodeId: number }) =>
      api.safety.createSafetyNote(namespace, params.noteText, params.targetNodeId),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.safetyNotes', namespace] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUpdateSafetyNote(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown> }) =>
      api.safety.updateSafetyNote(nodeId, updates),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.safetyNotes', namespace] }),
        qc.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith('safety.notesFor') }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useDeleteSafetyNote(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: number; parentNodeId?: number; parentNamespace?: string }) => api.safety.deleteSafetyNote(nodeId),
    onSuccess: async (_data, { parentNodeId, parentNamespace }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.safetyNotes', namespace] }),
        qc.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith('safety.notesFor') }),
        // Authored namespace net (covers the note as a flat-root node AND as a
        // reference child under its parent malfunction) + the parent element's
        // key when it lives in a different (imported) namespace.
        invalidateElementInTree(qc, workspaceKey, namespace, {
          structuralParent:
            parentNodeId !== undefined && parentNamespace && parentNamespace !== namespace
              ? { nodeId: parentNodeId, namespace: parentNamespace }
              : null,
        }),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Tag tree-level delete mutation ──────────────────────────────────────────
// Deletes a tag node from the authored namespace and invalidates all tag-related
// query keys so the tree, tag lists, and element tag panels stay in sync.

export function useDeleteTag(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: number; parentNodeId?: number; parentNamespace?: string }) => api.safety.deleteTag(nodeId),
    onSuccess: async (_data, { parentNodeId, parentNamespace }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tags'] }),
        qc.invalidateQueries({ queryKey: ['tagsForElement'] }),
        qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] }),
        qc.invalidateQueries({ queryKey: ['tagsOverview.elements'] }),
        // Authored namespace net (tag as flat-root node AND as reference child of
        // any linked element) + the parent element's key when cross-namespace.
        invalidateElementInTree(qc, workspaceKey, namespace, {
          structuralParent:
            parentNodeId !== undefined && parentNamespace && parentNamespace !== namespace
              ? { nodeId: parentNodeId, namespace: parentNamespace }
              : null,
        }),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Review Item mutations ───────────────────────────────────────────────────

export function useCreateReviewItem(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { reviewerComment: string; reviewedElementId: number; name?: string }) =>
      api.safety.createReviewItem(namespace, params.reviewerComment, params.reviewedElementId, params.name),
    onSuccess: async (_data, params) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.reviewItems', params.reviewedElementId] }),
        qc.invalidateQueries({ queryKey: ['safety.allReviewItems', namespace] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUpdateReviewItem(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, updates }: { nodeId: number; updates: Record<string, unknown>; reviewedElementId?: number }) =>
      api.safety.updateReviewItem(nodeId, updates),
    onSuccess: async (_data, { reviewedElementId }) => {
      await Promise.all([
        reviewedElementId !== undefined
          ? qc.invalidateQueries({ queryKey: ['safety.reviewItems', reviewedElementId] })
          : Promise.resolve(),
        qc.invalidateQueries({ queryKey: ['safety.allReviewItems', namespace] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useDeleteReviewItem(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: number; reviewedElementId?: number }) =>
      api.safety.deleteReviewItem(nodeId),
    onSuccess: async (_data, { reviewedElementId }) => {
      await Promise.all([
        reviewedElementId !== undefined
          ? qc.invalidateQueries({ queryKey: ['safety.reviewItems', reviewedElementId] })
          : Promise.resolve(),
        qc.invalidateQueries({ queryKey: ['safety.allReviewItems', namespace] }),
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Occurs-at mutations ─────────────────────────────────────────────────────

export function useOccursAtMutation(
  namespace: string,
  workspaceKey: string | null = null,
  hostNamespace?: string,
  triggerAutoSave?: () => void,
) {
  const qc = useQueryClient();

  const invalidate = async (fmNodeId: number, targetNodeId?: number, targetNs?: string) => {
    const promises: Promise<void>[] = [
      qc.invalidateQueries({ queryKey: ['safety.malfunction', fmNodeId] }),
      qc.invalidateQueries({ queryKey: ['safety.malfunctions', namespace] }),
      // Always refresh the authored namespace tree (the malfunction node itself).
      invalidateAllTreeChildrenForNamespace(qc, workspaceKey, namespace),
    ];
    if (targetNodeId !== undefined) {
      promises.push(qc.invalidateQueries({ queryKey: ['safety.malfunctionsForElement', targetNodeId] }));
      // Refresh the imported structural parent where the reference node appears
      // (or disappears). Prefer an explicit target namespace; fall back to the
      // configured hostNamespace.
      const ns = targetNs ?? hostNamespace;
      if (ns) promises.push(invalidateTreeChildren(qc, workspaceKey, ns, targetNodeId));
    }
    await Promise.all(promises);
  };

  const attach = useMutation({
    mutationFn: ({ fmNodeId, targetNodeId }: { fmNodeId: number; targetNodeId: number }) =>
      api.safety.attachOccursAt(fmNodeId, targetNodeId),
    onSuccess: async (_data, { fmNodeId, targetNodeId }) => {
      await invalidate(fmNodeId, targetNodeId);
      triggerAutoSave?.();
    },
  });

  const detach = useMutation({
    mutationFn: ({ fmNodeId, targetNodeId }: { fmNodeId: number; targetNodeId: number }) =>
      api.safety.detachOccursAt(fmNodeId, targetNodeId),
    onSuccess: async (_data, { fmNodeId, targetNodeId }) => {
      await invalidate(fmNodeId, targetNodeId);
      triggerAutoSave?.();
    },
  });

  const move = useMutation({
    mutationFn: ({ fmNodeId, oldTargetNodeId, newTargetNodeId }: { fmNodeId: number; oldTargetNodeId: number; newTargetNodeId: number }) =>
      api.safety.moveOccursAt(fmNodeId, oldTargetNodeId, newTargetNodeId),
    onSuccess: async (_data, { fmNodeId, oldTargetNodeId, newTargetNodeId }) => {
      await Promise.all([
        invalidate(fmNodeId, oldTargetNodeId),
        qc.invalidateQueries({ queryKey: ['safety.malfunctionsForElement', newTargetNodeId] }),
        hostNamespace ? invalidateTreeChildren(qc, workspaceKey, hostNamespace, newTargetNodeId) : Promise.resolve(),
      ]);
      triggerAutoSave?.();
    },
  });

  return { attach, detach, move };
}

// ── Propagation mutations ───────────────────────────────────────────────────

export function usePropagationMutation(namespace: string, triggerAutoSave?: () => void) {
  const qc = useQueryClient();

  const invalidate = async (fmNodeId: number) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['safety.propagations', fmNodeId] }),
      qc.invalidateQueries({ queryKey: ['safety.malfunction', fmNodeId] }),
      // Refresh the propagation diagram (PropagationCanvas / usePropagationGraph).
      // The graph is a composite query keyed ['propagationGraph', entryNodeId, ...]
      // that fetches ['safety.propagations', id] children internally via fetchQuery.
      // Invalidating those children does NOT re-run the composite — only invalidating
      // ['propagationGraph'] itself makes the mounted diagram refetch. Without this,
      // an edge added/removed via the tree context menu leaves the open diagram stale.
      qc.invalidateQueries({ queryKey: ['propagationGraph'] }),
      // Keep the table view (MalfunctionTableView) in sync — propagation edge
      // changes affect the propagation badge count for each row.
      qc.invalidateQueries({ queryKey: ['safety.propagationsForComponent'] }),
    ]);
    // Cross-window: edge changes must refresh propagation views in other windows.
    broadcastPropagationInvalidations();
  };

  const add = useMutation({
    mutationFn: ({ sourceFmNodeId, targetFmNodeId }: { sourceFmNodeId: number; targetFmNodeId: number }) =>
      api.safety.addPropagation(sourceFmNodeId, targetFmNodeId),
    onSuccess: async (_data, { sourceFmNodeId, targetFmNodeId }) => {
      await Promise.all([invalidate(sourceFmNodeId), invalidate(targetFmNodeId)]);
      triggerAutoSave?.();
    },
  });

  const remove = useMutation({
    mutationFn: ({ sourceFmNodeId, targetFmNodeId }: { sourceFmNodeId: number; targetFmNodeId: number }) =>
      api.safety.removePropagation(sourceFmNodeId, targetFmNodeId),
    onSuccess: async (_data, { sourceFmNodeId, targetFmNodeId }) => {
      await Promise.all([invalidate(sourceFmNodeId), invalidate(targetFmNodeId)]);
      triggerAutoSave?.();
    },
  });

  return { add, remove };
}

// ── Requirement → FM link mutations ─────────────────────────────────────────

export function useLinkRequirementToFm(namespace: string, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, requirementNodeId }: { failureModeNodeId: number; requirementNodeId: number }) =>
      api.safety.linkRequirementToFm(failureModeNodeId, requirementNodeId),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.requirementsForFm', failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] }),
      ]);
      triggerAutoSave?.();
    },
  });
}
export function useUnlinkRequirementFromFm(namespace: string, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, requirementNodeId }: { failureModeNodeId: number; requirementNodeId: number }) =>
      api.safety.unlinkRequirementFromFm(failureModeNodeId, requirementNodeId),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.requirementsForFm', failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] }),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Safety Note for FM mutations ────────────────────────────────────────────

export function useCreateNoteForFm(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, noteText }: { failureModeNodeId: number; noteText: string }) =>
      api.safety.createNoteForFm(failureModeNodeId, namespace, noteText),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.notesForFm', failureModeNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.safetyNotes', namespace] }),
        // The note appears under the malfunction (authored namespace) — the
        // namespace-wide net covers both flat-root and nested-child layouts.
        invalidateElementInTree(qc, workspaceKey, namespace),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useCreateNoteForElement(namespace: string, workspaceKey: string | null = null, triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ elementNodeId, elementNamespace, noteText }: { elementNodeId: number; elementNamespace: string; noteText: string }) =>
      api.safety.createNoteForElement(elementNodeId, namespace, noteText),
    onSuccess: async (_data, { elementNodeId, elementNamespace }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.notesForElement', elementNodeId] }),
        qc.invalidateQueries({ queryKey: ['safety.safetyNotes', namespace] }),
        // Authored namespace net + the imported element's children key (where the
        // note appears as a reference child).
        invalidateElementInTree(qc, workspaceKey, namespace, {
          structuralParent: { nodeId: elementNodeId, namespace: elementNamespace },
        }),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Direct (cross-namespace) requirement → FM link mutations ─────────────────

export function useLinkDirectRequirementToFm(triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, requirementNodeId }: { failureModeNodeId: number; requirementNodeId: number }) =>
      api.safety.linkDirectRequirementToFm(failureModeNodeId, requirementNodeId),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.directRequirementsForFm', failureModeNodeId] }),
      ]);
      triggerAutoSave?.();
    },
  });
}

export function useUnlinkDirectRequirementFromFm(triggerAutoSave?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ failureModeNodeId, requirementNodeId }: { failureModeNodeId: number; requirementNodeId: number }) =>
      api.safety.unlinkDirectRequirementFromFm(failureModeNodeId, requirementNodeId),
    onSuccess: async (_data, { failureModeNodeId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.directRequirementsForFm', failureModeNodeId] }),
      ]);
      triggerAutoSave?.();
    },
  });
}

// ── Paste Malfunction ───────────────────────────────────────────────────────

export function usePasteMalfunction(
  workspaceKey: string | null,
  triggerAutoSave?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      copied,
      safetyNamespace,
      occursAtNodeId,
      occursAtNamespace,
    }: {
      copied: CopiedMalfunctionData;
      /** The authored safety namespace to create the new malfunction in. */
      safetyNamespace: string;
      occursAtNodeId?: number;
      occursAtNamespace?: string;
    }) => {
      const created = await api.safety.createMalfunction({
        namespace: safetyNamespace,
        name: `${copied.name} COPY`,
        description: copied.description,
        asil: copied.asil,
        occursAtNodeId,
      });

      const newFmNodeId = created.node_id;

      if (copied.riskRating?.severity && copied.riskRating.occurrence && copied.riskRating.detection) {
        const existingNote = copied.riskRating.note ?? '';
        await api.safety.createRiskRating({
          failureModeNodeId: newFmNodeId,
          severity: copied.riskRating.severity,
          occurrence: copied.riskRating.occurrence,
          detection: copied.riskRating.detection,
          note: existingNote ? `COPY ${existingNote}` : 'COPY',
        });
      }

      // These link operations must run sequentially, not via Promise.all.
      // Each IPC channel handler opens its own write transaction, and the
      // backend allows only one write transaction at a time. Firing them
      // concurrently throws "Cannot start a new write transaction in the
      // system. Only one write transaction at a time is allowed."
      for (const taskId of copied.safetyTaskNodeIds) {
        await api.safety.linkSafetyTaskToFm(newFmNodeId, taskId);
      }
      for (const reqId of copied.requirementNodeIds) {
        await api.safety.linkRequirementToFm(newFmNodeId, reqId);
      }
      for (const reqId of copied.directRequirementNodeIds) {
        await api.safety.linkDirectRequirementToFm(newFmNodeId, reqId);
      }

      return { node_id: newFmNodeId };
    },
    onSuccess: async (_data, { safetyNamespace, occursAtNodeId, occursAtNamespace }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['safety.malfunctions', safetyNamespace] }),
        ...(occursAtNodeId !== undefined
          ? [qc.invalidateQueries({ queryKey: ['safety.malfunctionsForElement', occursAtNodeId] })]
          : []),
        // Keep the table view (MalfunctionTableView) in sync — it uses
        // propagationsForComponent as its data source.
        qc.invalidateQueries({ queryKey: ['safety.propagationsForComponent'] }),
        invalidateElementInTree(qc, workspaceKey, safetyNamespace, {
          structuralParent:
            occursAtNodeId !== undefined && occursAtNamespace
              ? { nodeId: occursAtNodeId, namespace: occursAtNamespace }
              : null,
        }),
      ]);
      // Cross-window: the pasted malfunction should appear in propagation views
      // in other windows.
      broadcastPropagationInvalidations();
      triggerAutoSave?.();
    },
  });
}
