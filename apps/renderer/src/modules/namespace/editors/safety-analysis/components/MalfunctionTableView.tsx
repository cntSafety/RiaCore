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
 * MalfunctionTableView — tabular view of all malfunctions under a selected scope subtree.
 *
 * Data wrapper: fetches the scoped propagation result via `usePropagationsForComponent`,
 * normalises internal nodes into `MalfunctionRow[]` via `toRows`, and renders one
 * `MalfunctionTableRow` per row.
 *
 * Responsibilities:
 *   - Data fetching (loading / error / empty states)
 *   - Header bar with breadcrumb, malfunction count, text filter, ASIL filter, and
 *     "Add Malfunction" button (Req 12)
 *   - Client-side filtering by name/description text and ASIL value
 *   - Modal state machine for risk-rating, safety-task, requirements, review modals
 *   - Row list rendering
 *
 * Boundary nodes from the propagation result are intentionally excluded from rows —
 * they are external to the selected scope. Their propagation edges are reflected in
 * the per-row propagation badge via `usePropagations`.
 *
 * Requirements: 1.2, 2.5, 10.2, 10.3, 12.1–12.4
 */

import { useCallback, useMemo, useState } from 'react';
import { Alert, App, Empty, Input, Modal, Select, Space, Spin, Tag, theme } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { usePropagationsForComponent } from '../hooks/useSafetyQueries';
import { usePasteMalfunction } from '../hooks/useSafetyMutations';
import { toRows } from '../utils/malfunctionTableHelpers';
import { getAsilColor } from '../config/asilColors';
import type { SelectedTreeElement } from '../types';
import type { MalfunctionRow } from '../utils/malfunctionTableHelpers';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import type { CopiedMalfunctionData } from '../../../../../store/workspaceStore';
import { CreateMalfunctionModal } from './CreateMalfunctionModal';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';

// ---------------------------------------------------------------------------
// MalfunctionTableRow — real implementation (task 3.1)
// ---------------------------------------------------------------------------
import { MalfunctionTableRow } from './MalfunctionTableRow';
import {
  ResizableColumnsHeader,
  useResizableColumns,
  type ResizableColumn,
} from './ResizableColumnsHeader';

// ---------------------------------------------------------------------------
// Resizable column definitions (Element | Malfunction | Description | ASIL)
// The trailing "Actions" column is non-resizable (auto width).
// ---------------------------------------------------------------------------
const TABLE_COLUMNS: ResizableColumn[] = [
  { key: 'element', title: 'Element', min: 140, default: 220 },
  { key: 'name', title: 'Malfunction', min: 140, default: 220 },
  { key: 'description', title: 'Description', min: 200, default: 360 },
  { key: 'asil', title: 'ASIL', min: 70, default: 100 },
];

const COLUMN_WIDTHS_STORAGE_KEY = 'riacore.malfunctionTable.columnWidths';

// ---------------------------------------------------------------------------
// Modal section components (task 4.1)
// ---------------------------------------------------------------------------
import {
  RiskRatingSection,
  SafetyTaskSection,
  RequirementsSection,
  ReviewSection,
} from './MalfunctionSections';

// ---------------------------------------------------------------------------
// Modal state machine
// ---------------------------------------------------------------------------

type ModalKind = 'risk-rating' | 'safety-task' | 'requirements' | 'review';

interface ModalState {
  kind: ModalKind | null;
  fmNodeId: number | null;
}

const MODAL_CLOSED: ModalState = { kind: null, fmNodeId: null };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MalfunctionTableViewProps {
  /** Root scope node whose subtree is walked for malfunctions. */
  scopeNodeId: number;
  /** Authored safety namespace (for mutations + invalidation). */
  namespace: string;
  /** Workspace key for tree.children invalidation. May be null before a workspace is open. */
  workspaceKey: string | null;
  /** Navigate to a node in the tree (threaded from CenterPanel → SafetyEditor). */
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (
    refNodeId: number,
    refNamespace: string,
    refConcept: string,
    hostNodeId: number,
    hostNamespace: string,
  ) => void;
  /** Begin a propagation gesture from a row's malfunction. Reuses existing SafetyEditor callback. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete a propagation gesture onto a row's malfunction. Reuses existing SafetyEditor callback. */
  onEndPropagation?: (node: SelectedTreeElement) => void | Promise<void>;
  /** Trigger authored-namespace auto-save after a mutation. */
  triggerAutoSave?: () => void;
  /**
   * Called after a malfunction is created so the tree panel can deterministically
   * refresh + expand the structural parent (port/SWC) where the new malfunction
   * appears as a reference child.
   */
  onTreeMutation?: (node: SelectedTreeElement) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MalfunctionTableView({
  scopeNodeId,
  namespace,
  workspaceKey,
  onNavigateToNode: _onNavigateToNode,
  onNavigateToReference: _onNavigateToReference,
  onStartPropagation: _onStartPropagation,
  onEndPropagation: _onEndPropagation,
  triggerAutoSave,
  onTreeMutation,
}: MalfunctionTableViewProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const asilFilterOptions = useMemo(
    () => [
      { value: '', label: 'All ASIL' },
      ...profile.asilGroups.flatMap((group) =>
        group.options.map((value) => ({ value, label: value })),
      ),
    ],
    [profile.asilGroups],
  );

  // ── Resizable columns (shared template for header + every row) ─────────────
  const { gridTemplateColumns, totalMinWidth, widths, startResize } = useResizableColumns(
    TABLE_COLUMNS,
    COLUMN_WIDTHS_STORAGE_KEY,
  );

  // ── Data fetching ─────────────────────────────────────────────────────────
  const { data, isLoading, isError, error } = usePropagationsForComponent(scopeNodeId, namespace);

  // Only internal nodes are shown as rows; boundary nodes are excluded (they are external).
  const rows = useMemo(() => toRows(data?.internalNodes ?? [], data?.structuralNodes ?? []), [data]);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [filterText, setFilterText] = useState('');
  const [filterAsil, setFilterAsil] = useState('');

  // ── Client-side filtering ─────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    let result = rows;

    if (filterText.trim()) {
      const lower = filterText.trim().toLowerCase();
      result = result.filter(
        (row) =>
          row.isEmptyPort
            ? (row.owner?.name ?? '').toLowerCase().includes(lower)
            : row.name.toLowerCase().includes(lower) ||
              row.description.toLowerCase().includes(lower),
      );
    }

    if (filterAsil) {
      // When filtering by ASIL, only show rows that have that ASIL (empty ports have no ASIL).
      result = result.filter((row) => !row.isEmptyPort && row.asil === filterAsil);
    }

    return result;
  }, [rows, filterText, filterAsil]);

  // ── Modal state machine ───────────────────────────────────────────────────
  const [modalState, setModalState] = useState<ModalState>(MODAL_CLOSED);

  const openModal = useCallback((kind: ModalKind, fmNodeId: number) => {
    setModalState({ kind, fmNodeId });
  }, []);

  const closeModal = useCallback(() => {
    setModalState(MODAL_CLOSED);
  }, []);

  // ── Create malfunction modal (right-click on element / scope) ─────────────
  const [createTarget, setCreateTarget] = useState<SelectedTreeElement | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const openCreateModal = useCallback((target: SelectedTreeElement) => {
    setCreateTarget(target);
    setCreateModalOpen(true);
  }, []);

  // Exposed so MalfunctionTableRow can open the modal directly
  const handleAddMalfunctionToElement = openCreateModal;

  // ── Copy / paste ──────────────────────────────────────────────────────────
  const qc = useQueryClient();
  const copiedMalfunction = useWorkspaceStore((s) => s.copiedMalfunction);
  const setCopiedMalfunction = useWorkspaceStore((s) => s.setCopiedMalfunction);
  const pasteMalfunction = usePasteMalfunction(workspaceKey, triggerAutoSave);

  const handleCopyRow = useCallback(
    (row: MalfunctionRow) => {
      // Optionally read cached risk rating data — no-op if not in cache.
      const rr = qc.getQueryData<{ attributes?: Record<string, unknown> }>([
        'safety.riskRating',
        row.fmNodeId,
      ]);

      const payload: CopiedMalfunctionData = {
        sourceNodeId: row.fmNodeId,
        sourceNamespace: row.namespace,
        name: row.name,
        description: row.description,
        asil: row.asil || undefined,
        riskRating: rr
          ? {
              severity: String(rr.attributes?.has_severity ?? '') || undefined,
              occurrence: String(rr.attributes?.has_occurrence_level ?? '') || undefined,
              detection: String(rr.attributes?.has_detection_level ?? '') || undefined,
              note: String(rr.attributes?.risk_rating_note ?? '') || undefined,
            }
          : null,
        // Tasks / requirements are not cached in table context — omit for now.
        safetyTaskNodeIds: [],
        requirementNodeIds: [],
        directRequirementNodeIds: [],
      };

      setCopiedMalfunction(payload);
      void message.success(`"${row.name}" copied to clipboard`);
    },
    [qc, setCopiedMalfunction, message],
  );

  const handlePasteToRow = useCallback(
    async (row: MalfunctionRow) => {
      if (copiedMalfunction === null || row.owner === null) return;
      try {
        await pasteMalfunction.mutateAsync({
          copied: copiedMalfunction,
          safetyNamespace: namespace,
          occursAtNodeId: row.owner.nodeId,
          occursAtNamespace: row.owner.namespace,
        });
        // Deterministically refresh + expand the structural parent (port/SWC) in
        // the tree so the pasted malfunction reference appears immediately. The
        // create path does this via CreateMalfunctionModal.onCreated; the paste
        // path must do it explicitly too. Cache invalidation alone silently skips
        // never-expanded structural parents, which is why the tree previously only
        // updated after a manual UI reload.
        onTreeMutation?.(row.owner);
        void message.success(`"${copiedMalfunction.name} COPY" created`);
      } catch (err) {
        void message.error(String((err as Error)?.message ?? 'Failed to paste malfunction'));
      }
    },
    [copiedMalfunction, pasteMalfunction, namespace, message, onTreeMutation],
  );

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading || profile.isLoading) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        }}
      >
        <Spin tip="Loading malfunctions…" />
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (isError || profile.error) {
    const loadError = profile.error ?? error;
    return (
      <div style={{ padding: 16 }}>
        <Alert
          type="error"
          message="Failed to load malfunctions"
          description={(loadError as Error)?.message ?? 'An unexpected error occurred.'}
          showIcon
        />
      </div>
    );
  }

  // ── Header bar ────────────────────────────────────────────────────────────
  const headerBar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
      }}
    >
      <Space size={8} style={{ flexShrink: 0 }}>
        <Input.Search
          placeholder="Filter malfunctions…"
          allowClear
          size="small"
          style={{ width: 200 }}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          onSearch={(value) => setFilterText(value)}
        />

        <Select
          size="small"
          style={{ width: 110 }}
          value={filterAsil}
          onChange={(value) => setFilterAsil(value)}
          options={asilFilterOptions}
          optionRender={(option) => {
            if (!option.value) return <span>{option.label}</span>;
            return (
              <Space size={4}>
                <Tag color={getAsilColor(String(option.value))} style={{ margin: 0, fontSize: 11 }}>
                  {option.label}
                </Tag>
              </Space>
            );
          }}
        />
      </Space>
    </div>
  );

  // ── Empty state ───────────────────────────────────────────────────────────
  if (rows.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {headerBar}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Empty description="No malfunctions found under this scope." />
        </div>
      </div>
    );
  }

  // ── Filtered empty state ──────────────────────────────────────────────────
  if (filteredRows.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {headerBar}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Empty description="No malfunctions match the current filter." />
        </div>
      </div>
    );
  }

  // ── Row list ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {headerBar}

      {/* Scrollable row list — full width, horizontal scrollbar when needed.
          minHeight: 0 is required so this flex child can shrink below its content height
          and show the scrollbar instead of overflowing behind the footer. */}
      <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'auto' }}>
        <div style={{ minWidth: totalMinWidth, paddingBottom: 8 }}>
          <ResizableColumnsHeader
            columns={TABLE_COLUMNS}
            widths={widths}
            startResize={startResize}
          />
          {filteredRows.map((row) => (
            <MalfunctionTableRow
              key={row.fmNodeId}
              row={row}
              namespace={namespace}
              workspaceKey={workspaceKey}
              onOpenModal={openModal}
              onNavigateToNode={_onNavigateToNode}
              onNavigateToReference={_onNavigateToReference}
              onStartPropagation={_onStartPropagation}
              onEndPropagation={_onEndPropagation}
              triggerAutoSave={triggerAutoSave}
              onCopy={() => handleCopyRow(row)}
              onPaste={() => void handlePasteToRow(row)}
              copiedMalfunctionIsSet={copiedMalfunction !== null}
              onAddMalfunctionToElement={handleAddMalfunctionToElement}
              gridTemplateColumns={gridTemplateColumns}
            />
          ))}
        </div>
      </div>

      {/* Modal overlay — renders the appropriate section based on modalState.kind */}
      {modalState.kind !== null && modalState.fmNodeId !== null && (
        <>
          {modalState.kind === 'risk-rating' && (
            <Modal
              open
              onCancel={closeModal}
              footer={null}
              title="Risk Rating"
              destroyOnHidden
            >
              <RiskRatingSection
                key={modalState.fmNodeId}
                fmNodeId={modalState.fmNodeId}
                namespace={namespace}
                workspaceKey={workspaceKey}
                triggerAutoSave={triggerAutoSave}
              />
            </Modal>
          )}
          {modalState.kind === 'safety-task' && (
            <Modal
              open
              onCancel={closeModal}
              footer={null}
              title="Safety Tasks"
              destroyOnHidden
            >
              <SafetyTaskSection
                key={modalState.fmNodeId}
                fmNodeId={modalState.fmNodeId}
                namespace={namespace}
                workspaceKey={workspaceKey}
                triggerAutoSave={triggerAutoSave}
              />
            </Modal>
          )}
          {modalState.kind === 'requirements' && (
            <Modal
              open
              onCancel={closeModal}
              footer={null}
              title="Requirements"
              destroyOnHidden
            >
              <RequirementsSection
                key={modalState.fmNodeId}
                fmNodeId={modalState.fmNodeId}
                namespace={namespace}
                workspaceKey={workspaceKey}
                triggerAutoSave={triggerAutoSave}
                onNavigateToNode={_onNavigateToNode}
              />
            </Modal>
          )}
          {modalState.kind === 'review' && (
            <Modal
              open
              onCancel={closeModal}
              footer={null}
              title="Review Items"
              destroyOnHidden
            >
              <ReviewSection
                key={modalState.fmNodeId}
                fmNodeId={modalState.fmNodeId}
                namespace={namespace}
                workspaceKey={workspaceKey}
                triggerAutoSave={triggerAutoSave}
              />
            </Modal>
          )}
        </>
      )}
      {/* Create malfunction modal — triggered by right-click on element/scope */}
      <CreateMalfunctionModal
        open={createModalOpen}
        namespace={namespace}
        selectedTreeElement={createTarget}
        workspaceKey={workspaceKey}
        occursAtNamespace={createTarget?.namespace}
        triggerAutoSave={triggerAutoSave}
        onClose={() => { setCreateModalOpen(false); setCreateTarget(null); }}
        onCreated={createTarget ? () => {
          // Deterministically refresh + expand the structural parent (SWC/port) in
          // the tree so the new malfunction reference appears immediately — mirrors
          // NamespaceTreePanel.handleFailureModeCreated → refreshNode.
          onTreeMutation?.(createTarget);
        } : undefined}
      />
    </div>
  );
}
