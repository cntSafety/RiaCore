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
 * MalfunctionTableRow — single row in the MalfunctionTableView.
 *
 * Renders five data columns:
 *   1. Element_Name  — two-line cell: owner component name (bold); optional port
 *      name + concept icon on a second line when occursAt is a port type.
 *   2. Malfunction Name — WarningOutlined icon + inline-editable malfunction name.
 *      → useUpdateMalfunction with { has_name }
 *   3. Malfunction Description — inline Input (save on blur / Enter).
 *      → useUpdateMalfunction with { malfunction_description }
 *   4. ASIL          — inline-editable colored badge pill.
 *      → useUpdateMalfunction with { malfunction_asil }
 *
 * On inline-edit failure: message.error + revert to last committed cache value.
 *
 * Also renders RowActionToolbar with eight always-visible action icons.
 *
 * Requirements: 2.3, 2.4, 4.1, 4.2, 4.3, 4.4
 */

import { useCallback, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { App, Button, Dropdown, Input, Select, Tag, Tooltip, Typography, theme } from 'antd';
import { MoreOutlined, PlusOutlined, SnippetsOutlined, WarningOutlined } from '@ant-design/icons';

import { useUpdateMalfunction } from '../hooks/useSafetyMutations';
import { getAsilColor, buildAsilOptionGroups } from '../config/asilColors';
import { getNodeDecoration } from '../config/nodeTypeConfig';
import type { MalfunctionRow } from '../utils/malfunctionTableHelpers';
import type { SelectedTreeElement } from '../types';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import { RowActionToolbar } from './RowActionToolbar';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';

// ---------------------------------------------------------------------------
// Port concept detection
// Port types that trigger the two-line Element_Name rendering.
// ---------------------------------------------------------------------------
const PORT_CONCEPTS = new Set(['r_port', 'p_port']);

function isPortConcept(concept: string): boolean {
  return PORT_CONCEPTS.has(concept);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MalfunctionTableRowProps {
  /** The normalised row model derived from PropagationMalfunctionData. */
  row: MalfunctionRow;
  /** Authored safety namespace (for mutations + invalidation). */
  namespace: string;
  /** Workspace key for tree.children invalidation. */
  workspaceKey: string | null;
  /** Trigger modal opening in the parent (MalfunctionTableView). */
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
  /** Begin a propagation linking gesture. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete a propagation linking gesture. */
  onEndPropagation?: (node: SelectedTreeElement) => void | Promise<void>;
  /** Trigger authored-namespace auto-save after a mutation. */
  triggerAutoSave?: () => void;
  // ── Placeholder props wired in task 5.1 (copy/paste) ──────────────────────
  /** Copy this row's malfunction to the shared clipboard (malfunction kebab action). */
  onCopy?: () => void;
  /** Paste the shared clipboard malfunction onto this row's owning element/port (element kebab action). */
  onPaste?: () => void;
  /** True when the shared clipboard holds a malfunction (controls the element-kebab Paste item). */
  copiedMalfunctionIsSet?: boolean;
  /** Right-click "Add Malfunction" on the owner element or scope element. */
  onAddMalfunctionToElement?: (target: SelectedTreeElement) => void;
  /**
   * Shared CSS grid column template, supplied by MalfunctionTableView so all rows
   * and the header stay aligned while columns are resized. Falls back to the
   * default fixed template when omitted (e.g. standalone usage / tests).
   */
  gridTemplateColumns?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MalfunctionTableRow({
  row,
  namespace,
  workspaceKey,
  onOpenModal,
  onNavigateToNode,
  onNavigateToReference,
  onStartPropagation,
  onEndPropagation,
  triggerAutoSave,
  onCopy,
  onPaste,
  copiedMalfunctionIsSet,
  onAddMalfunctionToElement,
  gridTemplateColumns,
}: MalfunctionTableRowProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const asilOptions = buildAsilOptionGroups(profile.asilGroups);

  // ── Mutation hook ─────────────────────────────────────────────────────────
  const updateMalfunction = useUpdateMalfunction(namespace, workspaceKey, triggerAutoSave);

  // ── Name inline edit ─────────────────────────────────────────────────────
  const [nameValue, setNameValue] = useState(row.name);
  const committedNameRef = useRef(row.name);
  if (committedNameRef.current !== row.name && nameValue === committedNameRef.current) {
    committedNameRef.current = row.name;
    setNameValue(row.name);
  }
  const [nameEditing, setNameEditing] = useState(false);

  const handleNameCommit = useCallback(
    async (value: string) => {
      setNameEditing(false);
      if (value === committedNameRef.current) return;
      const previous = committedNameRef.current;
      setNameValue(value);
      try {
        await updateMalfunction.mutateAsync({
          nodeId: row.fmNodeId,
          updates: { has_name: value },
        });
        committedNameRef.current = value;
      } catch (err) {
        void message.error(
          String((err as Error)?.message ?? 'Failed to update name'),
        );
        setNameValue(previous);
      }
    },
    [row.fmNodeId, updateMalfunction, message],
  );

  // ── Description inline edit ───────────────────────────────────────────────
  // Local state: tracks the currently displayed value (optimistic) and whether editing.
  const [descValue, setDescValue] = useState(row.description);
  // committedDesc is the last value successfully persisted; used to revert on failure.
  const committedDescRef = useRef(row.description);
  // Keep refs in sync when parent data changes (e.g. after a re-fetch).
  if (committedDescRef.current !== row.description && descValue === committedDescRef.current) {
    // Cache refreshed while not editing — adopt the new value.
    committedDescRef.current = row.description;
    setDescValue(row.description);
  }
  const [descEditing, setDescEditing] = useState(false);

  const handleDescCommit = useCallback(
    async (value: string) => {
      setDescEditing(false);
      if (value === committedDescRef.current) return; // no change
      const previous = committedDescRef.current;
      // Optimistically update the displayed value.
      setDescValue(value);
      try {
        await updateMalfunction.mutateAsync({
          nodeId: row.fmNodeId,
          updates: { malfunction_description: value },
        });
        committedDescRef.current = value;
      } catch (err) {
        // Revert to last committed value on failure.
        void message.error(
          String((err as Error)?.message ?? 'Failed to update description'),
        );
        setDescValue(previous);
      }
    },
    [row.fmNodeId, updateMalfunction, message],
  );

  // ── ASIL inline edit ──────────────────────────────────────────────────────
  const [asilValue, setAsilValue] = useState(row.asil);
  const committedAsilRef = useRef(row.asil);
  if (committedAsilRef.current !== row.asil && asilValue === committedAsilRef.current) {
    committedAsilRef.current = row.asil;
    setAsilValue(row.asil);
  }
  const [asilEditing, setAsilEditing] = useState(false);

  const handleAsilCommit = useCallback(
    async (value: string) => {
      setAsilEditing(false);
      if (value === committedAsilRef.current) return;
      const previous = committedAsilRef.current;
      setAsilValue(value);
      try {
        await updateMalfunction.mutateAsync({
          nodeId: row.fmNodeId,
          updates: { malfunction_asil: value },
        });
        committedAsilRef.current = value;
      } catch (err) {
        void message.error(
          String((err as Error)?.message ?? 'Failed to update ASIL'),
        );
        setAsilValue(previous);
      }
    },
    [row.fmNodeId, updateMalfunction, message],
  );

  // ── Derived owner display values ──────────────────────────────────────────
  const owner = row.owner;
  const ownerName = owner?.name ?? '—';
  const ownerConcept = owner?.concept ?? '';
  const showPortLine = owner !== null && isPortConcept(ownerConcept);

  // When the owner is a port, column 1 top line = component name, second line = port name.
  // row.componentName holds the parent component name (populated by toRows from structuralNodes).
  const topLineName = showPortLine && row.componentName ? row.componentName : ownerName;
  const portLineName = ownerName; // The port name itself

  // Concept icon for port types
  const portDecoration = showPortLine ? getNodeDecoration(ownerConcept) : null;
  const PortIcon = portDecoration?.icon as ComponentType<{ style?: React.CSSProperties }> | null;

  // ── Row styles ─────────────────────────────────────────────────────────────
  const rowStyle: React.CSSProperties = {
    display: 'grid',
    // Column widths: Element_Name | Malfunction Name | Description | ASIL | Actions
    // When MalfunctionTableView supplies a shared (resizable) template we use it so
    // every row stays aligned with the draggable header. The fixed minmax template
    // below is the fallback for standalone usage / tests.
    gridTemplateColumns:
      gridTemplateColumns ??
      'minmax(200px, 240px) minmax(180px, 220px) minmax(200px, 1fr) minmax(80px, 100px) auto',
    alignItems: 'flex-start',  // rows grow with content; align tops
    gap: 0,
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    background: row.isEmptyPort ? token.colorFillQuaternary : token.colorBgContainer,
    minHeight: 48,
    opacity: row.isEmptyPort ? 0.7 : 1,
  };

  const cellStyle: React.CSSProperties = {
    padding: '8px 12px',
    overflow: 'hidden',
    alignSelf: 'flex-start',
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={rowStyle} data-testid={`malfunction-row-${row.fmNodeId}`}>

      {/* ── Column 1: Element_Name with kebab menu ───────────────────────── */}
      <div style={{ ...cellStyle, display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
        {owner ? (
          <>
            {/* Name + subtitle */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography.Text
                strong
                style={{
                  fontSize: 13,
                  lineHeight: '18px',
                  overflow: 'hidden',
                  wordBreak: 'break-word',
                  whiteSpace: 'normal',
                  display: 'block',
                }}
                title={topLineName}
              >
                {topLineName}
              </Typography.Text>
              {showPortLine && (
                <span
                  className="portName"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 3,
                    fontSize: 11,
                    color: token.colorTextSecondary,
                    lineHeight: '16px',
                  }}
                >
                  {PortIcon && (
                    <PortIcon
                      style={{ fontSize: 10, color: portDecoration?.color ?? token.colorTextSecondary, marginTop: 3, flexShrink: 0 }}
                    />
                  )}
                  <span style={{ overflow: 'hidden', wordBreak: 'break-word', whiteSpace: 'normal' }} title={portLineName}>
                    {portLineName}
                  </span>
                </span>
              )}
            </div>

            {/* Kebab menu — always visible, consolidates all element actions */}
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'addMalfunction',
                    icon: <PlusOutlined />,
                    label: 'Add Malfunction',
                    onClick: () => onAddMalfunctionToElement?.({
                      nodeId: owner.nodeId,
                      namespace: owner.namespace,
                      concept: owner.concept,
                      name: owner.name,
                    }),
                  },
                  // Paste a copied malfunction onto this element/port. Only shown
                  // when the shared clipboard holds a malfunction.
                  copiedMalfunctionIsSet ? {
                    key: 'pasteMalfunction',
                    icon: <SnippetsOutlined />,
                    label: 'Paste Malfunction',
                    onClick: () => onPaste?.(),
                  } : null,
                  { type: 'divider' },
                  onNavigateToNode ? {
                    key: 'showInTree',
                    label: 'Show in Tree',
                    onClick: () => onNavigateToNode(owner.nodeId, owner.namespace, owner.concept),
                  } : null,
                  // "Show Reference in Tree" only makes sense for rows with a real malfunction.
                  !row.isEmptyPort && onNavigateToReference && owner ? {
                    key: 'showRefInTree',
                    label: 'Show Reference in Tree',
                    onClick: () => onNavigateToReference(
                      row.fmNodeId, row.namespace, 'malfunction',
                      owner.nodeId, owner.namespace,
                    ),
                  } : null,
                ].filter(Boolean) as import('antd').MenuProps['items'],
              }}
            >
              <Button
                type="text"
                size="small"
                icon={<MoreOutlined />}
                style={{ padding: '0 2px', height: 22, width: 22, flexShrink: 0, color: token.colorTextSecondary }}
              />
            </Dropdown>
          </>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>
        )}
      </div>

      {/* ── Column 2: Malfunction Name (inline editable) ─────────────────── */}
      <div style={{ ...cellStyle, minWidth: 0 }}>
        {row.isEmptyPort ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>No malfunction</Typography.Text>
        ) : (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
          <ShowInTreeTrigger
            homeTarget={{
              nodeId: row.fmNodeId,
              namespace: row.namespace,
              concept: 'malfunction',
            }}
            onNavigate={onNavigateToNode}
            onNavigateReference={
              onNavigateToReference && owner
                ? (rNodeId, rNs, rConcept) =>
                    onNavigateToReference(rNodeId, rNs, rConcept, owner.nodeId, owner.namespace)
                : undefined
            }
            hideKebab
          >
            <WarningOutlined style={{ color: token.colorWarning, fontSize: 13, flexShrink: 0, cursor: 'context-menu' }} />
          </ShowInTreeTrigger>
          {nameEditing ? (
            <Input.TextArea
              autoFocus
              autoSize={{ minRows: 1 }}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={(e) => void handleNameCommit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleNameCommit(nameValue);
                }
                if (e.key === 'Escape') {
                  setNameValue(committedNameRef.current);
                  setNameEditing(false);
                }
              }}
              style={{ fontSize: 13, fontWeight: 600, flex: 1, resize: 'none' }}
            />
          ) : (
            <Tooltip title="Click to edit name" mouseEnterDelay={0.6}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setNameEditing(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setNameEditing(true);
                }}
                style={{
                  cursor: 'text',
                  fontSize: 13,
                  fontWeight: 600,
                  color: nameValue ? token.colorText : token.colorTextQuaternary,
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  lineHeight: 1.5,
                  flex: 1,
                  minWidth: 0,
                  userSelect: 'none',
                }}
              >
                {nameValue || <span style={{ fontWeight: 400 }}>Unnamed</span>}
              </div>
            </Tooltip>
          )}
        </div>
        )}
      </div>

      {/* ── Column 3: Malfunction Description ────────────────────────────── */}
      <div style={{ ...cellStyle, minWidth: 0 }}>
        {row.isEmptyPort ? null : descEditing ? (
          <Input.TextArea
            autoFocus
            autoSize={{ minRows: 1 }}
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={(e) => void handleDescCommit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleDescCommit(descValue);
              }
              if (e.key === 'Escape') {
                setDescValue(committedDescRef.current);
                setDescEditing(false);
              }
            }}
            style={{ fontSize: 13, width: '100%', resize: 'none' }}
          />
        ) : (
          <Tooltip title="Click to edit description" mouseEnterDelay={0.6}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setDescEditing(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setDescEditing(true);
              }}
              style={{
                cursor: 'text',
                fontSize: 13,
                color: descValue ? token.colorText : token.colorTextQuaternary,
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                lineHeight: 1.5,
                minHeight: 24,
                userSelect: 'none',
              }}
            >
              {descValue || 'Click to add a description...'}
            </div>
          </Tooltip>
        )}
      </div>

      {/* ── Column 4: ASIL ───────────────────────────────────────────────── */}
      <div style={cellStyle}>
        {row.isEmptyPort ? null : asilEditing ? (
          <Select
            autoFocus
            open
            size="small"
            value={asilValue || undefined}
            placeholder="ASIL"
            options={asilOptions}
            allowClear
            style={{ width: 78, fontSize: 12 }}
            onChange={(value: string | undefined) =>
              void handleAsilCommit(value ?? '')
            }
            onBlur={() => {
              // When the user clicks away without selecting a new value, close the
              // editor and revert to last committed value.
              setAsilValue(committedAsilRef.current);
              setAsilEditing(false);
            }}
          />
        ) : (
          <Tooltip title="Click to edit ASIL" mouseEnterDelay={0.6}>
            <Tag
              color={asilValue ? getAsilColor(asilValue) : 'default'}
              onClick={() => setAsilEditing(true)}
              style={{
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                margin: 0,
                minWidth: 32,
                textAlign: 'center',
                letterSpacing: '0.02em',
              }}
            >
              {asilValue || '—'}
            </Tag>
          </Tooltip>
        )}
      </div>

      {/* ── Column 5: Actions ────────────────────────────────────────────── */}
      <div style={{ ...cellStyle, paddingRight: 8 }}>
        {!row.isEmptyPort && (
        <RowActionToolbar
          fmNodeId={row.fmNodeId}
          name={row.name}
          namespace={namespace}
          workspaceKey={workspaceKey}
          triggerAutoSave={triggerAutoSave}
          onOpenModal={onOpenModal}
          onNavigateToNode={onNavigateToNode}
          onNavigateToReference={onNavigateToReference}
          onStartPropagation={onStartPropagation}
          onEndPropagation={onEndPropagation}
          onCopy={onCopy}
        />
        )}
      </div>
    </div>
  );
}
