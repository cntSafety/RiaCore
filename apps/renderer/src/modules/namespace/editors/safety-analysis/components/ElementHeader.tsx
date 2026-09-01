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
import { App, Button, Dropdown, Select, Space, Tag, Tooltip, Typography, theme, type MenuProps } from 'antd';
import { ApartmentOutlined, CopyOutlined, EditOutlined, MoreOutlined, NodeIndexOutlined, PlusOutlined, TagOutlined, NodeCollapseOutlined, NodeExpandOutlined, SnippetsOutlined } from '@ant-design/icons';
import { createElement, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import type { SelectedTreeElement } from '../types';
import type { TabDefinition } from '../config/elementTabs';
import { getNodeDecoration } from '../config/nodeTypeConfig';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import { useQueryClient } from '@tanstack/react-query';
import { TagChip } from './TagChip';
import { ElementLensSelector } from './ElementLensSelector';

export interface ElementHeaderProps {
  /** The selected tree element metadata. */
  selectedTreeElement: SelectedTreeElement;
  /** Fresh display name from TanStack Query data (not selectedTreeElement.name). */
  displayName: string;
  /** Node ID — shown in the identity popover with an ephemeral note. */
  nodeId: number;
  /** Identity fields shown in the popover (database internals). */
  stablePath?: string;
  uuid?: string;
  shortName?: string;
  /** Tags linked to this element. */
  tags: ConceptInstanceData[];
  /** All available tags for the "Add tag" picker. */
  allTags: ConceptInstanceData[];
  /**
   * Options for the view selector, in display order — the
   * Model/Propagation/Malfunctions/Notes/Details lenses for a model element,
   * or the Overview/Risk Rating/… tabs for a malfunction. Both use the same
   * control. Omit (or pass an empty array) to hide it entirely.
   */
  lensOptions?: TabDefinition[];
  /** Current value of the lens selector. Required when `lensOptions` is set. */
  lensValue?: string;
  /** Callback when the lens selector changes. Required when `lensOptions` is set. */
  onLensChange?: (value: string) => void;
  /** Tag mutation callbacks. */
  onAddTag: (tagNodeId: number) => Promise<void>;
  onRemoveTag: (tagNodeId: number) => Promise<void>;
  /**
   * When provided, typing a new tag name and pressing Enter will create the tag
   * and link it. When omitted (e.g. in read-only model browser contexts), tag
   * creation is suppressed — only linking existing tags is allowed.
   */
  onCreateAndAddTag?: (name: string) => Promise<void>;
  /**
   * "Show in Tree" navigation — when provided, the kebab menu includes
   * "Show in Tree" action.
   */
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /**
   * "Show Reference in Tree" navigation — used for malfunctions that have an
   * occursAtTarget (i.e. they appear as a reference child under a structural node).
   */
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
  /**
   * On-demand "Show Reference in Tree" for the current element (used for
   * malfunctions). Resolves the occurs_at target at click time, so it works on
   * the first click even before the malfunction detail query (which supplies
   * `referenceInTreeTarget`) is warm.
   */
  onShowReferenceInTree?: () => void;
  /**
   * Reference navigation context used by "Show Reference in Tree".
   * ref* identifies the reference child to select; host* identifies the parent
   * tree node under which that reference is shown.
   */
  referenceInTreeTarget?: {
    refNodeId: number;
    refNamespace: string;
    refConcept: string;
    hostNodeId: number;
    hostNamespace: string;
  } | null;
  /**
   * Callback to rename the element. When provided, the title becomes inline-editable
   * and "Rename" appears in the kebab menu.
   */
  onRename?: (newName: string) => void;
  /**
   * Safety namespace — required for propagation menu items (to read pending state).
   * Only needed when the element is a malfunction.
   */
  safetyNamespace?: string;
  /** Start a propagation gesture from this malfunction. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete a propagation gesture to this malfunction. */
  onEndPropagation?: (node: SelectedTreeElement) => void;
  /** Copy this malfunction to the clipboard (only for malfunction concept). */
  onCopyMalfunction?: () => void;
  /** Paste the copied malfunction here (only for host elements when clipboard is non-empty). */
  onPasteMalfunction?: () => void;
  /** Delete this tag (only for tag concept) — opens impact preview. */
  onDeleteTag?: () => void;
  /** Delete this note (only for safety_note concept). */
  onDeleteNote?: () => void;
  /**
   * Generic "delete this concept instance" action with a custom label (e.g. a
   * SOTIF functional_insufficiency / triggering_condition). Opens impact preview.
   */
  onDeleteConcept?: { label: string; onDelete: () => void };
  /** Navigate to the note's reference child position in the tree (only for safety_note concept). */
  onShowNoteReferenceInTree?: () => void;
  /**
   * Whether this element supports tagging. When false the tags row is hidden.
   * Structural/imported concepts (SWC, port, etc.) support tags.
   * Safety-authored concepts (malfunction, risk_rating, safety_task, etc.) do not.
   */
  supportsTagging: boolean;
  /**
   * When false the "Add tag" button is hidden. Existing tag chips remain
   * visible. Use this in read-only browser contexts (e.g. model browser opened
   * from an import tile) where users should not be able to tag elements.
   * Defaults to true.
   */
  allowAddTag?: boolean;
}

/**
 * Element header block displayed at the top of the CenterPanel when an element
 * is selected. Shows the element icon, editable name, type chip, a ⋮ kebab menu
 * for actions, an ⓘ identity popover, and tag pills with add/remove controls.
 */
export function ElementHeader({
  selectedTreeElement,
  displayName,
  nodeId,
  stablePath,
  uuid,
  shortName,
  tags,
  allTags,
  lensOptions,
  lensValue,
  onLensChange,
  onAddTag,
  onRemoveTag,
  onCreateAndAddTag,
  onNavigateToNode,
  onNavigateToReference,
  onShowReferenceInTree,
  referenceInTreeTarget,
  onRename,
  safetyNamespace,
  onStartPropagation,
  onEndPropagation,
  onCopyMalfunction,
  onPasteMalfunction,
  onDeleteTag,
  onDeleteNote,
  onDeleteConcept,
  onShowNoteReferenceInTree,
  supportsTagging,
  allowAddTag = true,
}: ElementHeaderProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [addingTag, setAddingTag] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<number | undefined>();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  // Read pending propagation source for this namespace (only relevant for malfunctions)
  const pendingPropagation = useWorkspaceStore((s) =>
    safetyNamespace ? (s.pendingPropagationSource[safetyNamespace] ?? null) : null,
  );

  // Check if a propagation edge already exists from the pending source to this element.
  // Uses the TanStack Query cache — no extra network request.
  const qc = useQueryClient();
  const propagationAlreadyExists = useMemo(() => {
    if (!pendingPropagation || selectedTreeElement.concept !== 'malfunction') return false;
    type PropagationsData = {
      propagatesTo: (ConceptInstanceData & { occursAtTarget?: unknown })[];
      propagatesFrom: (ConceptInstanceData & { occursAtTarget?: unknown })[];
    };
    const cached = qc.getQueryData<PropagationsData>(['safety.propagations', pendingPropagation.nodeId]);
    return cached?.propagatesTo.some((p) => p.node_id === selectedTreeElement.nodeId) ?? false;
  }, [pendingPropagation, selectedTreeElement, qc]);

  // Sync editValue when displayName changes externally
  useEffect(() => {
    if (!editing) setEditValue(displayName);
  }, [displayName, editing]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!onRename) return;
    // Capture the current rendered width so the input matches exactly
    if (titleRef.current) {
      titleRef.current.style.minWidth = `${titleRef.current.offsetWidth}px`;
    }
    setEditValue(displayName);
    setEditing(true);
  }, [onRename, displayName]);

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== displayName && onRename) {
      onRename(trimmed);
    }
    setEditing(false);
    // Release the fixed width
    if (titleRef.current) {
      titleRef.current.style.minWidth = '';
    }
  }, [editValue, displayName, onRename]);

  const cancelEdit = useCallback(() => {
    setEditValue(displayName);
    setEditing(false);
    if (titleRef.current) {
      titleRef.current.style.minWidth = '';
    }
  }, [displayName]);

  const decoration = getNodeDecoration(selectedTreeElement.concept);

  const handleAddTag = useCallback(async (tagNodeId: number) => {
    try {
      await onAddTag(tagNodeId);
      setSelectedTagId(undefined);
      setAddingTag(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to link tag'));
    }
  }, [onAddTag]);

  const handleCreateAndAddTag = useCallback(async (name: string) => {
    if (!onCreateAndAddTag) return;
    try {
      await onCreateAndAddTag(name);
      setSelectedTagId(undefined);
      setAddingTag(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create tag'));
    }
  }, [onCreateAndAddTag]);

  const handleRemoveTag = useCallback(async (tagNodeId: number) => {
    try {
      await onRemoveTag(tagNodeId);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to remove tag'));
    }
  }, [onRemoveTag]);

  // Filter out tags already linked to this element
  const availableTagOptions = allTags
    .filter((t) => !tags.some((et) => et.node_id === t.node_id))
    .map((t) => ({
      value: t.node_id,
      label: String(t.attributes?.has_name ?? `Tag ${t.node_id}`),
    }));

  // ── Kebab menu items ──────────────────────────────────────────────
  const kebabMenuItems = useMemo((): NonNullable<MenuProps['items']> => {
    const items: NonNullable<MenuProps['items']> = [];

    // Type chip at top — non-actionable info row
    items.push({
      key: 'type-info',
      label: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>Type</span>
          <Tag color="processing" style={{ margin: 0, fontSize: 13, padding: '2px 10px', lineHeight: '20px' }}>{selectedTreeElement.concept}</Tag>
        </span>
      ),
      disabled: true,
    });

    items.push({ type: 'divider' });

    if (onRename) {
      items.push({
        key: 'rename',
        label: 'Rename',
        icon: <EditOutlined />,
        onClick: () => startEditing(),
      });
    }

    if (onNavigateToNode) {
      items.push({
        key: 'show-in-tree',
        label: 'Show in Tree',
        icon: <NodeIndexOutlined />,
        onClick: () => onNavigateToNode(
          selectedTreeElement.nodeId,
          selectedTreeElement.namespace,
          selectedTreeElement.concept,
        ),
      });
    }

    // "Show Reference in Tree". For a malfunction, use the on-demand resolver
    // (onShowReferenceInTree) so it works on the FIRST click — even before the
    // malfunction detail query that supplies occursAtTarget is warm; the resolver
    // fetches the occurs_at target at click time. For other reference-capable
    // elements (risk rating / review item that map to a parent malfunction) fall
    // back to the pre-resolved referenceInTreeTarget.
    if (selectedTreeElement.concept === 'malfunction' && onShowReferenceInTree) {
      items.push({
        key: 'show-reference-in-tree',
        label: 'Show Reference in Tree',
        icon: <ApartmentOutlined />,
        onClick: () => onShowReferenceInTree(),
      });
    } else if (referenceInTreeTarget && onNavigateToReference) {
      items.push({
        key: 'show-reference-in-tree',
        label: 'Show Reference in Tree',
        icon: <ApartmentOutlined />,
        onClick: () => onNavigateToReference(
          referenceInTreeTarget.refNodeId,
          referenceInTreeTarget.refNamespace,
          referenceInTreeTarget.refConcept,
          referenceInTreeTarget.hostNodeId,
          referenceInTreeTarget.hostNamespace,
        ),
      });
    }

    // Propagation items — only for malfunctions
    const isMalfunction = selectedTreeElement.concept === 'malfunction';
    if (isMalfunction && onStartPropagation && !pendingPropagation) {
      items.push({
        key: 'start-propagation',
        label: 'Start Propagation',
        icon: <NodeCollapseOutlined />,
        onClick: () => onStartPropagation(selectedTreeElement),
      });
    }
    if (isMalfunction && onEndPropagation && pendingPropagation && pendingPropagation.nodeId !== selectedTreeElement.nodeId) {
      items.push({
        key: 'end-propagation',
        label: propagationAlreadyExists
          ? `Propagation to ${displayName} already exists`
          : `End Propagation to ${displayName}`,
        icon: <NodeExpandOutlined />,
        onClick: () => {
          if (!propagationAlreadyExists) onEndPropagation(selectedTreeElement);
        },
        disabled: propagationAlreadyExists,
      });
    }

    items.push({
      key: 'copy-name',
      label: 'Copy Name',
      icon: <CopyOutlined />,
      onClick: () => {
        void navigator.clipboard.writeText(displayName);
        void message.success('Name copied');
      },
    });

    if (onCopyMalfunction) {
      items.push({
        key: 'copy-malfunction',
        label: 'Copy Malfunction',
        icon: <CopyOutlined />,
        onClick: onCopyMalfunction,
      });
    }

    if (onPasteMalfunction) {
      items.push({
        key: 'paste-malfunction',
        label: 'Paste Malfunction',
        icon: <SnippetsOutlined />,
        onClick: onPasteMalfunction,
      });
    }

    if (onDeleteTag && selectedTreeElement.concept === 'tag') {
      items.push({ type: 'divider' });
      items.push({
        key: 'delete-tag',
        label: 'Delete Tag',
        danger: true,
        onClick: onDeleteTag,
      });
    }

    if (onDeleteConcept) {
      items.push({ type: 'divider' });
      items.push({
        key: 'delete-concept',
        label: onDeleteConcept.label,
        danger: true,
        onClick: onDeleteConcept.onDelete,
      });
    }

    if (selectedTreeElement.concept === 'safety_note') {
      if (onShowNoteReferenceInTree) {
        items.push({ type: 'divider' });
        items.push({
          key: 'show-note-reference-in-tree',
          label: 'Show Reference in Tree',
          icon: <ApartmentOutlined />,
          onClick: onShowNoteReferenceInTree,
        });
      }
      if (onDeleteNote) {
        if (!onShowNoteReferenceInTree) items.push({ type: 'divider' });
        items.push({
          key: 'delete-note',
          label: 'Delete Note',
          danger: true,
          onClick: onDeleteNote,
        });
      }
    }

    // Technical details section
    const techChildren: NonNullable<MenuProps['items']> = [];
    techChildren.push({
      key: 'tech-node-id',
      label: (
        <span style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 11, color: token.colorTextSecondary, minWidth: 76, flexShrink: 0 }}>Node ID</span>
          <span style={{ fontSize: 11, fontFamily: 'monospace' }}>{nodeId}</span>
        </span>
      ),
      disabled: true,
    });
    if (stablePath) {
      techChildren.push({
        key: 'tech-path',
        label: (
          <span style={{ display: 'flex', gap: 8, maxWidth: 260 }}>
            <span style={{ fontSize: 11, color: token.colorTextSecondary, minWidth: 76, flexShrink: 0 }}>Path</span>
            <span style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>{stablePath}</span>
          </span>
        ),
        disabled: true,
      });
    }
    if (uuid) {
      techChildren.push({
        key: 'tech-uuid',
        label: (
          <span style={{ display: 'flex', gap: 8, maxWidth: 260 }}>
            <span style={{ fontSize: 11, color: token.colorTextSecondary, minWidth: 76, flexShrink: 0 }}>UUID</span>
            <span style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>{uuid}</span>
          </span>
        ),
        disabled: true,
      });
    }
    if (shortName) {
      techChildren.push({
        key: 'tech-short-name',
        label: (
          <span style={{ display: 'flex', gap: 8 }}>
            <span style={{ fontSize: 11, color: token.colorTextSecondary, minWidth: 76, flexShrink: 0 }}>Short Name</span>
            <span style={{ fontSize: 11, fontFamily: 'monospace' }}>{shortName}</span>
          </span>
        ),
        disabled: true,
      });
    }

    items.push({ type: 'divider' });
    items.push({
      type: 'group',
      label: (
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: token.colorTextTertiary }}>
          Technical Details
        </span>
      ),
      children: techChildren,
    });

    return items;
  }, [onRename, onNavigateToNode, onNavigateToReference, onShowReferenceInTree, referenceInTreeTarget, selectedTreeElement, displayName, onStartPropagation, onEndPropagation, pendingPropagation, propagationAlreadyExists, token, nodeId, stablePath, uuid, shortName, onCopyMalfunction, onPasteMalfunction, onDeleteTag, onDeleteNote, onDeleteConcept, onShowNoteReferenceInTree]);

  return (
    <div style={{ background: token.colorBgContainer }}>
      {/* Row 1: icon + name + kebab + optional LensToggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          // The selector carries six options with icons and labels; on a narrow
          // panel it drops to its own line rather than overflowing the header.
          flexWrap: 'wrap',
          padding: '16px 20px 4px',
        }}
      >
        <Tooltip title={selectedTreeElement.concept} placement="right">
          {createElement(decoration.icon, {
            style: { color: decoration.color, fontSize: 20, flexShrink: 0, cursor: 'default' },
          } as Record<string, unknown>)}
        </Tooltip>

        {/* Editable title */}
        <div ref={titleRef} style={{ minWidth: 0, flex: '0 1 auto', maxWidth: '75%' }}>
          {editing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') cancelEdit();
              }}
              style={{
                fontSize: token.fontSizeHeading4,
                fontWeight: 600,
                lineHeight: token.lineHeightHeading4,
                fontFamily: 'inherit',
                color: token.colorText,
                background: 'transparent',
                border: `1px solid ${token.colorPrimary}`,
                borderRadius: token.borderRadiusSM,
                outline: 'none',
                padding: '0 4px',
                margin: 0,
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
          ) : (
            <Typography.Title
              level={4}
              style={{
                margin: 0,
                minWidth: 0,
                cursor: onRename ? 'text' : undefined,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              onClick={onRename ? startEditing : undefined}
            >
              {displayName}
            </Typography.Title>
          )}
        </div>

        {/* Kebab menu — always visible */}
        <Dropdown
          menu={{ items: kebabMenuItems }}
          trigger={['click']}
          placement="bottomRight"
        >
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined style={{ fontSize: 16 }} />}
            style={{ flexShrink: 0, width: 28, height: 28 }}
          />
        </Dropdown>

        {lensOptions && lensOptions.length > 0 && (
          <ElementLensSelector
            options={lensOptions}
            value={lensValue ?? lensOptions[0].key}
            onChange={(v) => onLensChange?.(v)}
          />
        )}
      </div>

      {/* Row 2: separator + tags — only for elements that support tagging */}
      {supportsTagging && (
      <div
        style={{
          padding: '10px 20px',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 40,
        }}
      >
        <TagOutlined style={{ fontSize: 13, color: token.colorTextQuaternary, flexShrink: 0 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: 1, minWidth: 0 }}>
          {tags.length === 0 && !addingTag && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>No tags</Typography.Text>
          )}
          {tags.map((tag) => (
            <TagChip
              key={tag.node_id}
              color={String(tag.attributes?.tag_color || 'purple')}
              closable
              style={{ fontSize: 13, lineHeight: '22px' }}
              onClose={(e) => {
                e.preventDefault();
                void handleRemoveTag(tag.node_id);
              }}
            >
              {String(tag.attributes?.has_name ?? '—')}
            </TagChip>
          ))}
          {allowAddTag && (
            addingTag ? (
              <Space size={4}>
                <Select
                  showSearch
                  size="small"
                  placeholder="Select or type new tag"
                  value={selectedTagId}
                  onChange={(value: number) => {
                    void handleAddTag(value);
                  }}
                  options={availableTagOptions}
                  style={{ width: 180 }}
                  filterOption={(input, option) =>
                    (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                  onInputKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const input = (e.target as HTMLInputElement).value?.trim();
                      if (
                        input &&
                        onCreateAndAddTag &&
                        !availableTagOptions.some(
                          (o) => String(o.label).toLowerCase() === input.toLowerCase(),
                        )
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleCreateAndAddTag(input);
                      }
                    }
                  }}
                />
                <Button
                  size="small"
                  onClick={() => {
                    setAddingTag(false);
                    setSelectedTagId(undefined);
                  }}
                >
                  Cancel
                </Button>
              </Space>
            ) : (
              <Button
                size="small"
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => setAddingTag(true)}
                style={{ fontSize: 11 }}
              >
                Add tag
              </Button>
            )
          )}
        </div>
      </div>
      )}
    </div>
  );
}
