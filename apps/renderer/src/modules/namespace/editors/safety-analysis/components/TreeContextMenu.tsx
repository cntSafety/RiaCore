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
import { useEffect, useRef } from 'react';
import { api } from '../../../../../api/riacore';
import { canHostCrossNSSafetyElements } from '../config/conceptHosting';
import { useAllNamespaces } from '../hooks/useTreeQueries';
import { useWorkspaceState } from '../../../../../hooks/useWorkspaceState';
import { isLlmReviewEligible } from '../../../../../lib/reviewProfile';
import { openLlmReviewModal } from '../../../../../store/llmReviewModalStore';
import { formatShortcutHint } from '../../../../../lib/shortcutHints';
import { useSafetyMetamodel } from '../hooks/safetyMetamodelContext';
import { SAFETY_ANALYSIS_SPAWN_VIEW_FLAG } from '../../../../safety-analysis-spawn/viewFlag';

/**
 * True when this renderer is the secondary (spawn) window. "Open in second
 * window" is only meaningful from the main window, so it is hidden here.
 */
const IS_SPAWN_WINDOW =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('view') === SAFETY_ANALYSIS_SPAWN_VIEW_FLAG;

function truncateReviewTargetName(name: string, maxLength = 12): string {
  if (name.length <= maxLength) {
    return name;
  }
  if (maxLength <= 3) {
    return name.slice(0, maxLength);
  }
  return `${name.slice(0, maxLength - 3)}...`;
}

interface TreeContextMenuProps {
  node: { concept: string; nodeId: number; namespace: string; name?: string } | null;
  /**
   * The authored safety namespace this tree operates in. Passed to the spawn
   * window via "Open in second window" so it mounts the SafetyEditor on the
   * correct authored namespace (and thus the correct profile), rather than
   * falling back to the first authored Safety-Analysis namespace it finds.
   */
  safetyNamespace?: string;
  position: { x: number; y: number };
  onClose: () => void;
  onAddMalfunction?: () => void;
  onAddRiskRating?: () => void;
  onAddSafetyTask?: () => void;
  onDelete?: () => void;
  /** Delete a safety_note node (opens impact preview). */
  onDeleteSafetyNote?: () => void;
  /** Delete a tag node (opens impact preview). */
  onDeleteTag?: () => void;
  /** Delete a safety_task node (opens impact preview). */
  onDeleteSafetyTask?: () => void;
  /** Delete a risk_rating node (opens impact preview). */
  onDeleteRiskRating?: () => void;
  /** Delete a review_item node (opens impact preview). */
  onDeleteReviewItem?: () => void;
  /** Delete a safety_requirement node (opens impact preview). */
  onDeleteRequirement?: () => void;
  /** Navigate to the element's home location in the tree. */
  onShowInTree?: () => void;
  /** Navigate to the element's reference child location in the tree (malfunctions with occursAtTarget). */
  onShowReferenceInTree?: () => void;
  /** Currently pending propagation source (set after "Start propagation from" was clicked). */
  pendingPropagationSource?: { nodeId: number; name: string } | null;
  /** Set this malfunction as the propagation source. */
  onStartPropagation?: () => void;
  /** Complete propagation from the pending source to this malfunction. */
  onEndPropagation?: () => void;
  /** Copy this malfunction to the clipboard. */
  onCopyMalfunction?: () => void;
  /** Paste a copied malfunction onto this architecture element. */
  onPasteMalfunction?: () => void;
  /** Whether the clipboard currently holds a copied malfunction. */
  hasCopiedMalfunction?: boolean;
  /** Open the Malfunctions lens (the malfunction table) for this architecture scope element. */
  onOpenInTableView?: () => void;
  /** Open the reconnect-orphaned-malfunction picker for this architecture element. */
  onReconnectOrphanedMalfunction?: () => void;
}

export function TreeContextMenu({
  node, safetyNamespace, position: _position, onClose,
  onAddMalfunction,
  onAddRiskRating, onAddSafetyTask, onDelete,
  onDeleteSafetyNote, onDeleteTag, onDeleteSafetyTask,
  onDeleteRiskRating, onDeleteReviewItem, onDeleteRequirement,
  onShowInTree, onShowReferenceInTree,
  pendingPropagationSource, onStartPropagation, onEndPropagation,
  onCopyMalfunction, onPasteMalfunction, hasCopiedMalfunction,
  onOpenInTableView,
  onReconnectOrphanedMalfunction,
}: TreeContextMenuProps) {
  // Resolve the namespace's metamodel so we can gate the "Initial LLM review"
  // entry via `isLlmReviewEligible(metamodel, concept)` — Requirements 4.1–4.5.
  // The namespace list is already cached by `useAllNamespaces`; we just look
  // up the right-clicked node's namespace entry.
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;
  const { data: allNamespaces } = useAllNamespaces(workspaceKey);
  const nodeMetamodel = node
    ? allNamespaces?.find((ns) => ns.name === node.namespace)?.metamodel ?? ''
    : '';

  // Metamodel of the active authored safety analysis (SAFETY_ANALYSIS /
  // SYSTEM_SAFETY_ANALYSIS / MONITORING_ANALYSIS) this tree is bound to. Drives
  // which review checklist the AI pre-review injects — the same source the
  // "Review Instructions" button uses. Distinct from `nodeMetamodel`, which is
  // the reviewed element's own (imported) metamodel used only for eligibility.
  const activeSafetyMetamodel = useSafetyMetamodel();

  // Guard against opening the native menu twice for a single right-click.
  // handleRightClick (NamespaceTreePanel) also calls onSelect, which updates
  // parent state and re-renders this component with fresh inline callback
  // identities. Those callbacks are in this effect's dependency array, so the
  // effect would re-run and call api.contextMenu.show() a second time —
  // popping a new native menu immediately dismisses the first one, which is
  // why the menu used to require two right-clicks. We track the node instance
  // (set fresh on each right-click, reset to null on close) so show() fires
  // exactly once per right-click.
  const shownForNodeRef = useRef<typeof node>(null);

  useEffect(() => {
    if (!node) {
      shownForNodeRef.current = null;
      return;
    }
    if (shownForNodeRef.current === node) return;
    shownForNodeRef.current = node;

    const isArchitecture = canHostCrossNSSafetyElements(node.concept);
    const isMalfunction = node.concept === 'malfunction';
    const isSafetyNote = node.concept === 'safety_note';
    const isTag = node.concept === 'tag';
    const isLlmEligible = isLlmReviewEligible(nodeMetamodel, node.concept);

    const items: { id: string; label: string }[] = [];
    const handlers: Record<string, (() => void) | undefined> = {};

    // "Open in second window" — available for every element (main window only).
    // Dispatches a cross-window navigation request to the secondary (spawn)
    // window: the SpawnManager opens the window if it is closed, otherwise it
    // navigates the existing single window to this element. Mirrors the Check
    // Model view's "Show in Tree" behaviour (reuses api.window.showInTree,
    // requestKind 'home').
    if (!IS_SPAWN_WINDOW) {
      items.push({ id: 'openInSecondWindow', label: 'Open in second window' });
      handlers.openInSecondWindow = () => {
        void api.window.showInTree({
          homeTarget: { nodeId: node.nodeId, namespace: node.namespace, concept: node.concept },
          requestKind: 'home',
          // The tree's authored safety namespace, so the spawn window mounts the
          // right analysis (and profile) even when several authored safety
          // namespaces exist. The node itself may live in an imported namespace
          // (architecture element), so we cannot derive this from node.namespace.
          ...(safetyNamespace ? { safetyNamespace } : {}),
        });
      };
    }

    if (isArchitecture) {
      items.push({ id: 'addMalfunction', label: 'Add Malfunction' });
      handlers.addMalfunction = onAddMalfunction;
      if (onReconnectOrphanedMalfunction) {
        items.push({ id: 'reconnectOrphanedMalfunction', label: 'Reconnect Orphaned Malfunction…' });
        handlers.reconnectOrphanedMalfunction = onReconnectOrphanedMalfunction;
      }
      if (hasCopiedMalfunction && onPasteMalfunction) {
        items.push({ id: 'pasteMalfunction', label: `Paste Malfunction ${formatShortcutHint(['CmdOrCtrl', 'Shift'], 'M')}` });
        handlers.pasteMalfunction = onPasteMalfunction;
      }
      items.push({ id: 'openInTableView', label: 'Open in Malfunctions' });
      handlers.openInTableView = onOpenInTableView;
    }
    if (isLlmEligible) {
      // Gate is metamodel-aware (sw_arxml SWC concepts or system_sysml SysML
      // element concepts only). On click, open the top-level LlmReviewModal
      // initialized for the right-clicked node — Requirement 4.6.
      const reviewLabelSuffix = node.name
        ? ` ${truncateReviewTargetName(node.name)}`
        : '';
      items.push({ id: 'llmReview', label: `AI pre-review${reviewLabelSuffix}` });
      handlers.llmReview = () => {
        openLlmReviewModal({
          nodeId: node.nodeId,
          namespace: node.namespace,
          displayName: node.name,
          ...(activeSafetyMetamodel ? { reviewMetamodel: activeSafetyMetamodel } : {}),
        });
      };
    }
    if (isMalfunction) {
      if (onShowInTree) {
        items.push({ id: 'showInTree', label: `Show in Tree ${formatShortcutHint(['CmdOrCtrl'], 'T')}` });
        handlers.showInTree = onShowInTree;
      }
      if (onShowReferenceInTree) {
        items.push({ id: 'showReferenceInTree', label: `Show Reference in Tree ${formatShortcutHint(['CmdOrCtrl', 'Shift'], 'T')}` });
        handlers.showReferenceInTree = onShowReferenceInTree;
      }
      if (!pendingPropagationSource) {
        items.push({ id: 'startPropagation', label: `Start propagation ${formatShortcutHint(['CmdOrCtrl'], 'P')}` });
        handlers.startPropagation = onStartPropagation;
      } else if (pendingPropagationSource.nodeId !== node.nodeId) {
        items.push({ id: 'endPropagation', label: `End propagation to ${formatShortcutHint(['CmdOrCtrl', 'Shift'], 'P')}` });
        handlers.endPropagation = onEndPropagation;
      }
      if (onCopyMalfunction) {
        items.push({ id: 'copyMalfunction', label: `Copy Malfunction ${formatShortcutHint(['CmdOrCtrl'], 'M')}` });
        handlers.copyMalfunction = onCopyMalfunction;
      }
      items.push({ id: 'delete', label: 'Delete' });
      handlers.delete = onDelete;
    }
    if (isSafetyNote) {
      if (onShowInTree) {
        items.push({ id: 'showInTree', label: `Show in Tree ${formatShortcutHint(['CmdOrCtrl'], 'T')}` });
        handlers.showInTree = onShowInTree;
      }
      if (onShowReferenceInTree) {
        items.push({ id: 'showReferenceInTree', label: `Show Reference in Tree ${formatShortcutHint(['CmdOrCtrl', 'Shift'], 'T')}` });
        handlers.showReferenceInTree = onShowReferenceInTree;
      }
      items.push({ id: 'deleteSafetyNote', label: 'Delete' });
      handlers.deleteSafetyNote = onDeleteSafetyNote;
    }
    if (isTag) {
      items.push({ id: 'deleteTag', label: 'Delete' });
      handlers.deleteTag = onDeleteTag;
    }

    const isSafetyTask = node.concept === 'safety_task';

    if (isSafetyTask) {
      items.push({ id: 'deleteSafetyTask', label: 'Delete' });
      handlers.deleteSafetyTask = onDeleteSafetyTask;
    }

    const isRiskRating = node.concept === 'risk_rating';

    if (isRiskRating) {
      items.push({ id: 'deleteRiskRating', label: 'Delete' });
      handlers.deleteRiskRating = onDeleteRiskRating;
    }

    const isReviewItem = node.concept === 'review_item';

    if (isReviewItem) {
      items.push({ id: 'deleteReviewItem', label: 'Delete' });
      handlers.deleteReviewItem = onDeleteReviewItem;
    }

    const isRequirement = node.concept === 'safety_requirement';

    if (isRequirement) {
      items.push({ id: 'deleteRequirement', label: 'Delete' });
      handlers.deleteRequirement = onDeleteRequirement;
    }

    if (items.length === 0) {
      onClose();
      return;
    }

    api.contextMenu.show(items).then((clickedId) => {
      if (clickedId) {
        handlers[clickedId]?.();
      }
      onClose();
    });
  }, [node, safetyNamespace, nodeMetamodel, activeSafetyMetamodel, onClose, onAddMalfunction, onDelete, onDeleteSafetyNote, onDeleteTag, onDeleteSafetyTask, onDeleteRiskRating, onDeleteReviewItem, onDeleteRequirement, onShowInTree, onShowReferenceInTree, pendingPropagationSource, onStartPropagation, onEndPropagation, onCopyMalfunction, onPasteMalfunction, hasCopiedMalfunction, onOpenInTableView, onReconnectOrphanedMalfunction]);

  // Native menu — nothing to render in the DOM
  return null;
}
