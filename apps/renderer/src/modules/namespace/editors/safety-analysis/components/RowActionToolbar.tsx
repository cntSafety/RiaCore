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
 * RowActionToolbar — five always-visible action icons per malfunction row,
 * plus a kebab (overflow) menu that holds the "Copy Malfunction" and
 * "Delete Malfunction" actions.
 *
 * Icon layout:
 *   1. Risk Rating    (WarningOutlined)     — badge: riskRating present → 1, absent → 0
 *   2. Safety Task    (CheckSquareOutlined) — badge: safetyTasks.length
 *   3. Requirements   (FileTextOutlined)    — badge: requirementsForFm.length + directRequirementsForFm.length
 *   4. Review         (AuditOutlined)       — badge: reviewItems.length
 *   5. Propagation    (NodeIndexOutlined)   — badge: propagatesTo.length + propagatesFrom.length
 *                                             start / end / cancel propagation gesture
 *
 * Kebab menu (MoreOutlined):
 *   - "Copy Malfunction" → calls onCopy.
 *   - "Delete Malfunction" (danger) → confirmation modal → useDeleteMalfunction.
 * Paste is intentionally NOT here — it is offered on the owning element/port
 * kebab (MalfunctionTableRow column 1), because paste targets an element.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 6.1, 7.1, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4
 */

import { App, Badge, Button, Dropdown, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
import {
  AuditOutlined,
  CheckSquareOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileTextOutlined,
  MoreOutlined,
  NodeIndexOutlined,
  WarningOutlined,
} from '@ant-design/icons';

import {
  useDirectRequirementsForFm,
  usePropagations,
  useRequirementsForFm,
  useReviewItems,
  useRiskRating,
  useSafetyTasks,
} from '../hooks/useSafetyQueries';
import { useDeleteMalfunction } from '../hooks/useSafetyMutations';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import { DeleteWithPreview } from './DeleteWithPreview';
import type { SelectedTreeElement } from '../types';

// ---------------------------------------------------------------------------
// Helper: auto-opens the DeleteWithPreview modal on mount, so clicking the
// kebab "Delete Malfunction" item shows the impact preview without an extra
// click. Mirrors the pattern used in NamespaceTreePanel.
// ---------------------------------------------------------------------------
function _AutoOpenPreview({ onMount }: { onMount: () => void }) {
  useEffect(() => { onMount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RowActionToolbarProps {
  /** The malfunction's node ID (used to load badge counts). */
  fmNodeId: number;
  /** The malfunction's display name (used for propagation gesture). */
  name: string;
  /** Authored safety namespace. */
  namespace: string;
  /** Workspace key for tree invalidation. */
  workspaceKey: string | null;
  /** Trigger authored-namespace auto-save after a mutation. */
  triggerAutoSave?: () => void;
  /** Open a modal for the given kind and malfunction. */
  onOpenModal: (kind: 'risk-rating' | 'safety-task' | 'requirements' | 'review', fmNodeId: number) => void;
  /** Navigate to a node in the namespace tree. */
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /** Navigate to a reference in the namespace tree. */
  onNavigateToReference?: (
    refNodeId: number,
    refNamespace: string,
    refConcept: string,
    hostNodeId: number,
    hostNamespace: string,
  ) => void;
  /** Begin a propagation linking gesture from this row's malfunction. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete a propagation linking gesture onto this row's malfunction. */
  onEndPropagation?: (node: SelectedTreeElement) => void | Promise<void>;
  /** Copy this row's malfunction to the shared clipboard (kebab menu action). */
  onCopy?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RowActionToolbar({
  fmNodeId,
  name,
  namespace,
  workspaceKey,
  triggerAutoSave,
  onOpenModal,
  onStartPropagation,
  onEndPropagation,
  onCopy,
}: RowActionToolbarProps) {
  const { message } = App.useApp();

  // ── Badge data queries ────────────────────────────────────────────────────
  const { data: riskRating } = useRiskRating(fmNodeId);
  const { data: safetyTasks } = useSafetyTasks(fmNodeId);
  const { data: requirementsForFm } = useRequirementsForFm(fmNodeId);
  const { data: directRequirementsForFm } = useDirectRequirementsForFm(fmNodeId);
  const { data: reviewItems } = useReviewItems(fmNodeId);
  const { data: propagations } = usePropagations(fmNodeId);

  // ── Badge counts (pure projections of cached data — Req 3.3, 3.4) ─────────
  const riskRatingBadge = riskRating != null ? 1 : 0;
  const safetyTaskBadge = safetyTasks?.length ?? 0;
  const requirementsBadge =
    (requirementsForFm?.length ?? 0) + (directRequirementsForFm?.length ?? 0);
  const reviewBadge = reviewItems?.length ?? 0;
  const propagationBadge =
    (propagations?.propagatesTo?.length ?? 0) +
    (propagations?.propagatesFrom?.length ?? 0);

  // ── Propagation gesture state ─────────────────────────────────────────────
  // pendingPropagationSource is keyed by namespace name.
  const pendingPropagationSource = useWorkspaceStore(
    (s) => s.pendingPropagationSource[namespace] ?? null,
  );
  const setPendingPropagationSource = useWorkspaceStore(
    (s) => s.setPendingPropagationSource,
  );

  const isThisPropagationSource = pendingPropagationSource?.nodeId === fmNodeId;
  const isPropagationPending = pendingPropagationSource !== null;

  let propagationLabel: string;
  let propagationHandler: (() => void) | undefined;

  if (!isPropagationPending) {
    // No pending source — offer "Start Propagation"
    propagationLabel = 'Start Propagation';
    propagationHandler = onStartPropagation
      ? () => onStartPropagation({ nodeId: fmNodeId, name, namespace, concept: 'malfunction' })
      : undefined;
  } else if (isThisPropagationSource) {
    // This row IS the pending source — offer "Cancel Propagation"
    propagationLabel = 'Cancel Propagation';
    propagationHandler = () => setPendingPropagationSource(namespace, null);
  } else {
    // Pending source is another row — offer "End Propagation Here"
    propagationLabel = 'End Propagation Here';
    propagationHandler = onEndPropagation
      ? () => void onEndPropagation({ nodeId: fmNodeId, name, namespace, concept: 'malfunction' })
      : undefined;
  }

  // ── Delete mutation ───────────────────────────────────────────────────────
  const deleteMutation = useDeleteMalfunction(namespace, workspaceKey, triggerAutoSave);
  // Drives the DeleteWithPreview impact modal (auto-opened when requested).
  const [deleteRequested, setDeleteRequested] = useState(false);

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(fmNodeId);
    } catch (err) {
      void message.error(
        String((err as Error)?.message ?? 'Failed to delete malfunction'),
      );
    }
  };

  // ── Shared button style ───────────────────────────────────────────────────
  const btnStyle: React.CSSProperties = { padding: '0 4px', height: 28, minWidth: 28 };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'nowrap',
      }}
      data-testid={`row-action-toolbar-${fmNodeId}`}
    >
      {/* 1. Risk Rating */}
      <Tooltip title="Risk Rating" mouseEnterDelay={0.5}>
        <Badge count={riskRatingBadge} size="small" offset={[-2, 2]} color="#1677ff">
          <Button
            type="text"
            size="small"
            icon={<WarningOutlined />}
            style={btnStyle}
            onClick={() => onOpenModal('risk-rating', fmNodeId)}
            aria-label="Risk Rating"
          />
        </Badge>
      </Tooltip>

      {/* 2. Safety Task */}
      <Tooltip title="Safety Tasks" mouseEnterDelay={0.5}>
        <Badge count={safetyTaskBadge} size="small" offset={[-2, 2]} color="#1677ff">
          <Button
            type="text"
            size="small"
            icon={<CheckSquareOutlined />}
            style={btnStyle}
            onClick={() => onOpenModal('safety-task', fmNodeId)}
            aria-label="Safety Tasks"
          />
        </Badge>
      </Tooltip>

      {/* 3. Requirements */}
      <Tooltip title="Requirements" mouseEnterDelay={0.5}>
        <Badge count={requirementsBadge} size="small" offset={[-2, 2]} color="#1677ff">
          <Button
            type="text"
            size="small"
            icon={<FileTextOutlined />}
            style={btnStyle}
            onClick={() => onOpenModal('requirements', fmNodeId)}
            aria-label="Requirements"
          />
        </Badge>
      </Tooltip>

      {/* 4. Review */}
      <Tooltip title="Review Items" mouseEnterDelay={0.5}>
        <Badge count={reviewBadge} size="small" offset={[-2, 2]} color="#1677ff">
          <Button
            type="text"
            size="small"
            icon={<AuditOutlined />}
            style={btnStyle}
            onClick={() => onOpenModal('review', fmNodeId)}
            aria-label="Review Items"
          />
        </Badge>
      </Tooltip>

      {/* 5. Propagation — start / end / cancel gesture */}
      <Tooltip title={propagationLabel} mouseEnterDelay={0.5}>
        <Badge count={propagationBadge} size="small" offset={[-2, 2]} color="#1677ff">
          <Button
            type={isThisPropagationSource ? 'primary' : 'text'}
            size="small"
            icon={<NodeIndexOutlined />}
            style={btnStyle}
            onClick={propagationHandler}
            disabled={propagationHandler === undefined}
            aria-label={propagationLabel}
          />
        </Badge>
      </Tooltip>

      {/* Kebab (overflow) menu — holds "Copy Malfunction" and "Delete Malfunction".
          Paste lives on the element/port kebab (column 1), since paste targets
          an element, not a malfunction. Delete is here because it is used
          infrequently and is destructive. */}
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              key: 'copyMalfunction',
              icon: <CopyOutlined />,
              label: 'Copy Malfunction',
              onClick: () => onCopy?.(),
            },
            { type: 'divider' },
            {
              key: 'deleteMalfunction',
              icon: <DeleteOutlined />,
              label: 'Delete Malfunction',
              danger: true,
              onClick: () => setDeleteRequested(true),
            },
          ],
        }}
      >
        <Tooltip title="More actions" mouseEnterDelay={0.5}>
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined />}
            style={btnStyle}
            loading={deleteMutation.isPending}
            aria-label="More actions"
          />
        </Tooltip>
      </Dropdown>

      {/* Delete Malfunction → impact preview modal (auto-opened on request).
          Shows the owned risk rating plus linked safety tasks, requirements
          and review items that will be removed before confirming. */}
      {deleteRequested && (
        <DeleteWithPreview
          nodeId={fmNodeId}
          onCancel={() => setDeleteRequested(false)}
          onConfirm={async () => {
            await handleDelete();
            setDeleteRequested(false);
          }}
        >
          {(openPreview) => <_AutoOpenPreview onMount={openPreview} />}
        </DeleteWithPreview>
      )}
    </div>
  );
}
