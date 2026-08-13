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
import { Alert, App, Button, Card, Dropdown, Empty, Input, Popconfirm, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import type { InputRef, MenuProps } from 'antd';
import { CheckOutlined, CloseOutlined, CopyOutlined, DeleteOutlined, DisconnectOutlined, FileTextOutlined, MoreOutlined, PlusOutlined, WarningOutlined, TagOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConceptInstanceData, ReviewItemData, PropagationMalfunctionData } from '@riacore/app-contracts';
import {
  useAllSafetyTasks,
  useMalfunction,
  useMalfunctionForReviewItem,
  useMalfunctionForRiskRating,
  useMalfunctions,
  useMalfunctionsForRequirement,
  useInstance,
  useNoteParent,
  useNotesForElement,
  useNotesForFm,
  useRequirements,
  usePropagations,
  useRequirementsForFm,
  useDirectRequirementsForFm,
  useReviewItems,
  useRiskRating,
  useSafetyTasks,
} from '../hooks/useSafetyQueries';
import {
  useCreateNoteForElement,
  useCreateNoteForFm,
  useCreateRequirement,
  useCreateReviewItem,
  useCreateRiskRating,
  useCreateSafetyTask,
  useDeleteRequirement,
  useDeleteReviewItem,
  useDeleteRiskRating,
  useDeleteSafetyNote,
  useDeleteTag,
  useLinkSafetyTaskToFm,
  useLinkRequirementToFm,
  usePropagationMutation,
  useUnlinkRequirementFromFm,
  useUnlinkSafetyTaskFromFm,
  useUnlinkDirectRequirementFromFm,
  useUpdateMalfunction,
  useUpdateRequirement,
  useUpdateReviewItem,
  useUpdateRiskRating,
  useUpdateSafetyNote,
  useUpdateSafetyTask,
  usePasteMalfunction,
} from '../hooks/useSafetyMutations';
import { getAsilColor, getAsilHexColor, buildAsilOptionGroups } from '../config/asilColors';
import type { AsilSelectEntry } from '../config/asilColors';
import { canHostCrossNSSafetyElements } from '../config/conceptHosting';
import { DeleteWithPreview } from './DeleteWithPreview';
import { TagChip } from './TagChip';
import { ImportedRequirementPicker } from './ImportedRequirementPicker';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import type { SelectedTreeElement } from '../types';
import { useTagsForImportedElement, useTags } from '../../../../../hooks/useTags';
import { ReviewInstructionsModal } from './ReviewInstructionsModal';
import { useTagMutations } from '../../../../../hooks/useTagMutations';
import { useQueryClient } from '@tanstack/react-query';
import { treeChildrenQueryKey } from '../hooks/useTreeQueries';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';
import { PortConnectorDiagram } from './PortConnectorDiagram';
import { FailurePropagationDiagram } from './FailurePropagationDiagram';
import { ScopedPropagationDiagram } from './ScopedPropagationDiagram';
import { MalfunctionTableView } from './MalfunctionTableView';
import {
  RiskRatingSection as RiskRatingSectionExtracted,
  SafetyTaskSection,
  RequirementsSection,
  ReviewSection as ReviewSectionExtracted,
} from './MalfunctionSections';
import { PORT_CONCEPTS, SWC_CONCEPTS } from './diagramModel';
import { ElementHeader } from './ElementHeader';
import { ElementTabs } from './ElementTabs';
import type { TabDefinition } from './ElementTabs';
import { PropertyRow } from './PropertyRow';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';

function CopyableValue({ value, mono }: { value: string; mono?: boolean }) {
  const { token } = theme.useToken();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <Typography.Text
        style={{
          fontSize: 11,
          fontFamily: mono ? token.fontFamilyCode : undefined,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Typography.Text>
      <Tooltip title={copied ? 'Copied!' : 'Copy'}>
        <Button
          type="text"
          size="small"
          icon={copied ? <CheckOutlined style={{ color: token.colorSuccess }} /> : <CopyOutlined />}
          onClick={handleCopy}
          style={{ padding: '0 2px', height: 16, minWidth: 16, flexShrink: 0 }}
        />
      </Tooltip>
    </span>
  );
}

interface CenterPanelProps {
  namespace: string;
  selectedTreeElement: SelectedTreeElement | null;
  onRenameSelectedTreeElement?: (name: string) => void;
  addNoteRequested?: boolean;
  onAddNoteHandled?: () => void;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
  /**
   * On-demand "Show Reference in Tree" for the selected element. Unlike
   * onNavigateToReference (which needs pre-resolved host coords), this resolves
   * the occurs_at target at click time, so it works on the first click even
   * before the malfunction detail query is warm.
   */
  onShowReferenceInTree?: (node: SelectedTreeElement) => void;
  /** Called after a mutation that adds elements under a structural parent, so the tree can deterministically refresh + expand that parent. */
  onTreeMutation?: (node?: SelectedTreeElement) => void;
  /** Workspace key for tree.children query invalidation. */
  workspaceKey?: string | null;
  /** Trigger auto-save of the authored namespace after element mutations. */
  triggerAutoSave?: () => void;
  /** Start a propagation gesture from the selected malfunction. */
  onStartPropagation?: (node: SelectedTreeElement) => void;
  /** Complete a propagation gesture to the selected malfunction. */
  onEndPropagation?: (node: SelectedTreeElement) => void;
  /**
   * When false, the "create tag" action is suppressed in the tag picker —
   * only linking existing tags is allowed. Defaults to true.
   * Set to false when the CenterPanel is used in a read-only browser context
   * (e.g. GenericModelBrowserModal) where the namespace prop is the imported
   * namespace and creating a tag there would violate the cross-NS constraint.
   */
  allowCreateTag?: boolean;
  /**
   * When false, the "Add tag" button is hidden entirely. Existing tag chips
   * remain visible. Defaults to true.
   */
  allowAddTag?: boolean;
}

const MALFUNCTION_TABS: TabDefinition[] = [
  { key: 'overview',     label: 'Overview' },
  { key: 'risk-rating',  label: 'Risk Rating' },
  { key: 'propagation',  label: 'Propagation' },
  { key: 'safety-tasks', label: 'Safety Tasks' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'review',       label: 'Review' },
];

const ELEMENT_TABS: TabDefinition[] = [
  { key: 'overview', label: 'Overview' },
];

const DETAIL_PRIORITY_KEYS = [
  'title',
  'id',
  'type',
  'type_name',
  'docname',
  'section_name',
  'status',
  'lineno',
  'doctype',
  'tags',
  'sections',
  'implements',
  'satisfies',
  'refines',
  'verifies',
] as const;

interface DetailItem {
  key: string;
  label: string;
  value: string;
  isMultiline: boolean;
}

function toDetailLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatDetailValue(value: unknown): { text: string; isMultiline: boolean } | null {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    const cleaned = value
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    if (cleaned.length === 0) return null;
    return { text: cleaned.join(', '), isMultiline: cleaned.length > 5 };
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return null;
    return { text: JSON.stringify(value), isMultiline: true };
  }

  const text = String(value).trim();
  if (!text) return null;
  return { text, isMultiline: text.includes('\n') || text.length > 140 };
}

function collectDetailItems(attributes: Record<string, unknown>): DetailItem[] {
  const result: DetailItem[] = [];
  const seen = new Set<string>();

  for (const key of DETAIL_PRIORITY_KEYS) {
    const formatted = formatDetailValue(attributes[key]);
    if (!formatted) continue;
    result.push({ key, label: toDetailLabel(key), value: formatted.text, isMultiline: formatted.isMultiline });
    seen.add(key);
  }

  for (const [key, raw] of Object.entries(attributes)) {
    if (seen.has(key) || key === 'content' || key === 'ar_path' || key === 'stable_path' || key === 'uuid' || key === 'short_name') continue;
    const formatted = formatDetailValue(raw);
    if (!formatted) continue;
    result.push({ key, label: toDetailLabel(key), value: formatted.text, isMultiline: formatted.isMultiline });
  }

  return result;
}

/** Auto-save feedback: returns markSaved() and a boolean that stays true for 1.5 s. */
function useSavedFeedback() {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const markSaved = useCallback(() => setSavedAt(Date.now()), []);
  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => setSavedAt(null), 1500);
    return () => clearTimeout(timer);
  }, [savedAt]);
  return { isSaved: savedAt !== null, markSaved };
}

/** Auto-opens a DeleteWithPreview modal on mount. Used by CenterPanel's tag delete flow. */
function _AutoOpenTagPreview({ onMount }: { onMount: () => void }) {
  useEffect(() => { onMount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Faint "✓ Saved" badge shown briefly after a successful auto-save. */
function SavedBadge({ visible }: { visible: boolean }) {
  const { token } = theme.useToken();
  if (!visible) return null;
  return (
    <span style={{ fontSize: 11, color: token.colorSuccess, display: 'inline-flex', alignItems: 'center', gap: 3, transition: 'opacity 0.3s' }}>
      <CheckOutlined style={{ fontSize: 10 }} /> Saved
    </span>
  );
}

/** Section header row — title left, count badge + optional action right. */
function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        paddingBottom: 10,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        marginBottom: 12,
      }}
    >
      <Space size={8} align="center">
        <Typography.Text strong style={{ fontSize: 13 }}>{title}</Typography.Text>
        <Tag style={{ fontSize: 11, lineHeight: '18px' }}>
          {count === 0 ? 'None' : `${count}`}
        </Tag>
      </Space>
      {action}
    </div>
  );
}

/**
 * Inline notes section — styled like the Concept G design.
 * Shows a section label row (SAFETY NOTES · count · + Add note) followed by
 * note cards with a left blue border, content text, and an author/time footer.
 */
function InlineNotesSection({
  notes,
  loading,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  openAddForm,
  onAddFormOpened,
}: {
  notes: ConceptInstanceData[];
  loading: boolean;
  onAddNote: (text: string) => Promise<void>;
  onUpdateNote: (nodeId: number, text: string) => Promise<void>;
  onDeleteNote: (nodeId: number) => Promise<void>;
  openAddForm?: boolean;
  onAddFormOpened?: () => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [addingNote, setAddingNote] = useState(false);
  const [newNoteText, setNewNoteText] = useState('');

  useEffect(() => {
    if (openAddForm) {
      setAddingNote(true);
      onAddFormOpened?.();
    }
  }, [openAddForm, onAddFormOpened]);
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    if (!newNoteText.trim()) return;
    setSubmitting(true);
    try {
      await onAddNote(newNoteText.trim());
      setNewNoteText('');
      setAddingNote(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create note'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      {/* Section label row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <Typography.Text
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: token.colorTextTertiary,
          }}
        >
          Notes
        </Typography.Text>
        {notes.length > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: token.fontFamilyCode,
              fontWeight: 600,
              padding: '1px 6px',
              background: token.colorFillSecondary,
              color: token.colorTextSecondary,
              borderRadius: 10,
              lineHeight: '16px',
            }}
          >
            {notes.length}
          </span>
        )}
        <div style={{ flex: 1, height: 1, background: token.colorBorderSecondary }} />
        {!addingNote && (
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setAddingNote(true)}
            style={{ fontSize: 11, color: token.colorTextSecondary, padding: '0 4px' }}
          >
            Add note
          </Button>
        )}
      </div>

      {/* Add note input */}
      {addingNote && (
        <div
          style={{
            marginBottom: 10,
            borderLeft: `3px solid ${token.colorPrimary}`,
            paddingLeft: 12,
          }}
        >
          <Input.TextArea
            autoFocus
            rows={3}
            placeholder="Write a note…"
            value={newNoteText}
            onChange={(e) => setNewNoteText(e.target.value)}
            style={{ marginBottom: 8, fontSize: 13 }}
          />
          <Space size={8}>
            <Button
              size="small"
              type="primary"
              onClick={handleCreate}
              loading={submitting}
              disabled={!newNoteText.trim()}
            >
              Save
            </Button>
            <Button
              size="small"
              onClick={() => { setAddingNote(false); setNewNoteText(''); }}
            >
              Cancel
            </Button>
          </Space>
        </div>
      )}

      {/* Note cards */}
      {loading ? (
        <div style={{ padding: '8px 0' }}><Spin size="small" /></div>
      ) : notes.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {notes.map((note) => (
            <InlineNoteCard
              key={note.node_id}
              note={note}
              onUpdate={onUpdateNote}
              onDelete={onDeleteNote}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InlineNoteCard({
  note,
  onUpdate,
  onDelete,
}: {
  note: ConceptInstanceData;
  onUpdate: (nodeId: number, text: string) => Promise<void>;
  onDelete: (nodeId: number) => Promise<void>;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(note.attributes?.note_text ?? ''));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setText(String(note.attributes?.note_text ?? ''));
  }, [note]);

  const noteText = String(note.attributes?.note_text ?? '');
  const authorRaw = String(note.attributes?.author ?? note.attributes?.created_by ?? '');
  const author = authorRaw ? authorRaw.toUpperCase() : '';
  const createdAt = String(note.attributes?.created_at ?? note.attributes?.modified_at ?? '');

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await onUpdate(note.node_id, text.trim());
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update note'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(note.node_id);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to delete note'));
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        borderLeft: `3px solid ${token.colorPrimary}`,
        paddingLeft: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input.TextArea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ fontSize: 13 }}
          />
          <Space size={8}>
            <Button size="small" type="primary" onClick={handleSave} loading={saving} disabled={!text.trim()}>
              Save
            </Button>
            <Button size="small" onClick={() => { setEditing(false); setText(noteText); }}>
              Cancel
            </Button>
          </Space>
        </div>
      ) : (
        <div
          style={{ cursor: 'text' }}
          onClick={() => setEditing(true)}
        >
          <Typography.Text
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              display: 'block',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {noteText || <span style={{ color: token.colorTextQuaternary }}>Empty note — click to edit</span>}
          </Typography.Text>
        </div>
      )}

      {/* Footer: author · time · delete */}
      {!editing && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
          }}
        >
          {author && (
            <Typography.Text
              style={{
                fontSize: 10,
                fontFamily: token.fontFamilyCode,
                fontWeight: 600,
                letterSpacing: '0.05em',
                color: token.colorTextTertiary,
              }}
            >
              {author}
            </Typography.Text>
          )}
          {author && createdAt && (
            <span style={{ fontSize: 10, color: token.colorTextQuaternary }}>·</span>
          )}
          {createdAt && (
            <Typography.Text
              style={{
                fontSize: 10,
                fontFamily: token.fontFamilyCode,
                color: token.colorTextTertiary,
                letterSpacing: '0.03em',
              }}
            >
              {createdAt}
            </Typography.Text>
          )}
          <div style={{ flex: 1 }} />
          <Button
            type="text"
            size="small"
            danger
            icon={<CloseOutlined style={{ fontSize: 10 }} />}
            loading={deleting}
            onClick={handleDelete}
            style={{ padding: '0 4px', height: 18, minWidth: 18, opacity: 0.6 }}
          />
        </div>
      )}
    </div>
  );
}

export function CenterPanel({ namespace, selectedTreeElement, onRenameSelectedTreeElement, addNoteRequested, onAddNoteHandled, onNavigateToNode, onNavigateToReference, onShowReferenceInTree, onTreeMutation, workspaceKey, triggerAutoSave, onStartPropagation, onEndPropagation, allowCreateTag = true, allowAddTag = true }: CenterPanelProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const profile = useSafetyProfileMetadata();

  // ── Lens toggle state — persisted in Zustand as a session-level UI preference ──
  const lensValue = useWorkspaceStore((s) => s.elementLensView);
  const setLensValue = useWorkspaceStore((s) => s.setElementLensView);

  // ── Tab state ─────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<string>('overview');

  const isDiagramConcept = selectedTreeElement
    ? PORT_CONCEPTS.has(selectedTreeElement.concept) || SWC_CONCEPTS.has(selectedTreeElement.concept)
    : false;

  const isRiskRating = selectedTreeElement?.concept === 'risk_rating';
  const isReviewItem = selectedTreeElement?.concept === 'review_item';
  const isMalfunction = selectedTreeElement?.concept === 'malfunction';

  // Reset active tab whenever the selected element changes
  const prevNodeIdRef = useRef<number | undefined>(undefined);
  if (selectedTreeElement?.nodeId !== prevNodeIdRef.current) {
    prevNodeIdRef.current = selectedTreeElement?.nodeId;
    // Keep the current tab if the new element supports it; otherwise fall back to 'overview'
    const newIsMalfunction = selectedTreeElement?.concept === 'malfunction';
    const availableTabs = newIsMalfunction ? MALFUNCTION_TABS : ELEMENT_TABS;
    const tabStillValid = availableTabs.some((t) => t.key === activeTab);
    if (!tabStillValid && activeTab !== 'overview') setActiveTab('overview');
  }

  const handleShowDetails = useCallback(() => {
    setLensValue('details');
  }, []);

  // ── Tag queries at CenterPanel level (lifted from ElementWorkspace) ──
  const tagsQuery = useTagsForImportedElement(selectedTreeElement?.nodeId);
  const allTagsQuery = useTags(namespace);
  const { createTag, linkTagCrossNs, unlinkTagCrossNs } = useTagMutations();

  // State for tag delete impact preview (triggered from ElementHeader kebab menu)
  const [pendingDeleteTagNodeId, setPendingDeleteTagNodeId] = useState<number | null>(null);
  const deleteTagFromHeader = useDeleteTag(namespace, workspaceKey ?? null, triggerAutoSave);

  // Tag mutation callbacks for ElementHeader
  const handleAddTag = useCallback(async (tagNodeId: number) => {
    if (!selectedTreeElement) return;
    await linkTagCrossNs.mutateAsync({ tagNodeId, importedElementNodeId: selectedTreeElement.nodeId });
    qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
    qc.invalidateQueries({ queryKey: ['tags'] });
    if (workspaceKey) qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, selectedTreeElement.namespace, selectedTreeElement.nodeId) });
    // Cross-NS tag edges change the imported namespace's hash section. Trigger
    // an auto-save so the persistor re-exports the affected namespace and updates
    // both the manifest hash and the DB content_hash, preventing a spurious
    // "files_corrupted" / "db_stale" detection on the next workspace open.
    triggerAutoSave?.();
  }, [selectedTreeElement, linkTagCrossNs, qc, workspaceKey, triggerAutoSave]);

  const handleRemoveTag = useCallback(async (tagNodeId: number) => {
    if (!selectedTreeElement) return;
    await unlinkTagCrossNs.mutateAsync({ tagNodeId, importedElementNodeId: selectedTreeElement.nodeId });
    qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
    qc.invalidateQueries({ queryKey: ['tags'] });
    if (workspaceKey) qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, selectedTreeElement.namespace, selectedTreeElement.nodeId) });
    triggerAutoSave?.();
  }, [selectedTreeElement, unlinkTagCrossNs, qc, workspaceKey, triggerAutoSave]);

  const handleCreateAndAddTag = useCallback(async (name: string) => {
    if (!selectedTreeElement) return;
    const created = await createTag.mutateAsync({ namespace, name });
    await linkTagCrossNs.mutateAsync({ tagNodeId: created.node_id, importedElementNodeId: selectedTreeElement.nodeId });
    qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
    qc.invalidateQueries({ queryKey: ['tags'] });
    if (workspaceKey) qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, selectedTreeElement.namespace, selectedTreeElement.nodeId) });
    triggerAutoSave?.();
  }, [selectedTreeElement, namespace, createTag, linkTagCrossNs, qc, workspaceKey, triggerAutoSave]);

  // ── Queries for display name derivation ───────────────────────────
  // Malfunction query — only enabled for malfunction elements
  const fmQuery = useMalfunction(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  // Instance query — enabled for non-malfunction elements
  const instanceQuery = useInstance(!isMalfunction ? selectedTreeElement?.nodeId : undefined);

  // ── Malfunction-specific queries (lifted from MalfunctionWorkspace) ──
  const riskRatingQuery = useRiskRating(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const tasksQuery = useSafetyTasks(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const requirementsQuery = useRequirementsForFm(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const directRequirementsQuery = useDirectRequirementsForFm(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const notesForFmQuery = useNotesForFm(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const propagationsQuery = usePropagations(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const reviewItemsQuery = useReviewItems(isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const updateMalfunction = useUpdateMalfunction(namespace, workspaceKey ?? null, triggerAutoSave);
  const pasteMalfunctionMutation = usePasteMalfunction(workspaceKey ?? null, triggerAutoSave);

  // ── Clipboard state ───────────────────────────────────────────────
  const copiedMalfunction = useWorkspaceStore((s) => s.copiedMalfunction);
  const setCopiedMalfunction = useWorkspaceStore((s) => s.setCopiedMalfunction);

  // ── Non-malfunction element queries ────────────────────────────────
  const notesForElementQuery = useNotesForElement(!isMalfunction ? selectedTreeElement?.nodeId : undefined);
  const rrParentMalfunctionQuery = useMalfunctionForRiskRating(isRiskRating ? selectedTreeElement?.nodeId : undefined);

  // Note parent query — resolves the element a safety_note is attached to (for "Show in Tree")
  const isSafetyNote = selectedTreeElement?.concept === 'safety_note';
  const noteParentQuery = useNoteParent(isSafetyNote ? selectedTreeElement?.nodeId : undefined);

  // State for note delete (triggered from ElementHeader kebab menu)
  const [pendingDeleteNoteNodeId, setPendingDeleteNoteNodeId] = useState<number | null>(null);
  const deleteNoteFromHeader = useDeleteSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);
  const reviewParentMalfunctionQuery = useMalfunctionForReviewItem(isReviewItem ? selectedTreeElement?.nodeId : undefined);
  const referenceMalfunctionNodeId = isMalfunction
    ? selectedTreeElement?.nodeId
    : isRiskRating
      ? rrParentMalfunctionQuery.data?.node_id
      : isReviewItem
        ? reviewParentMalfunctionQuery.data?.node_id
        : undefined;
  const referenceMalfunctionQuery = useMalfunction(referenceMalfunctionNodeId);

  const referenceInTreeTarget = useMemo(() => {
    const occursAtTarget = referenceMalfunctionQuery.data?.occursAtTarget;
    if (!occursAtTarget) return null;

    if (isMalfunction && selectedTreeElement) {
      return {
        refNodeId: selectedTreeElement.nodeId,
        refNamespace: selectedTreeElement.namespace,
        refConcept: selectedTreeElement.concept,
        hostNodeId: occursAtTarget.node_id,
        hostNamespace: occursAtTarget.namespace,
      };
    }

    if (referenceMalfunctionQuery.data) {
      return {
        refNodeId: referenceMalfunctionQuery.data.node_id,
        refNamespace: referenceMalfunctionQuery.data.namespace,
        refConcept: referenceMalfunctionQuery.data.concept,
        hostNodeId: occursAtTarget.node_id,
        hostNamespace: occursAtTarget.namespace,
      };
    }

    return null;
  }, [isMalfunction, selectedTreeElement, referenceMalfunctionQuery.data]);

  // ── Compute element tab count badges ──────────────────────────────
  const elementTabsWithCounts = useMemo((): TabDefinition[] => {
    return ELEMENT_TABS.map((tab) => tab); // Overview only — no count badges needed
  }, []);

  // ── Malfunction section shortcuts (Ctrl+T, Ctrl+N) ───────────────
  const taskGhostRef = useRef<InputRef>(null);
  const noteGhostRef = useRef<InputRef>(null);
  void taskGhostRef; void noteGhostRef; // kept for ref passing to MalfunctionWorkspace

  // ── Malfunction local state for description/ASIL save-on-blur ─────
  const [fmDescription, setFmDescription] = useState('');
  const [fmAsil, setFmAsil] = useState<string | undefined>();
  const { isSaved: fmHeaderSaved, markSaved: markFmHeaderSaved } = useSavedFeedback();

  useEffect(() => {
    const failureMode = fmQuery.data;
    if (!failureMode) return;
    setFmDescription(String(failureMode.attributes?.malfunction_description ?? ''));
    const asilValue = String(failureMode.attributes?.malfunction_asil ?? '');
    setFmAsil(asilValue || undefined);
  }, [fmQuery.data]);

  const asilOptions = useMemo<AsilSelectEntry[]>(
    () => buildAsilOptionGroups(profile.asilGroups),
    [profile.asilGroups],
  );

  const saveFmField = useCallback(async (updates: Record<string, string>) => {
    if (!fmQuery.data) return;
    // Optimistically update the tree node title before the mutation so the
    // user sees the change immediately — the subsequent tree.children refetch
    // (triggered by the mutation's onSuccess) will confirm the new name.
    if ('has_name' in updates) onRenameSelectedTreeElement?.(updates.has_name);
    try {
      await updateMalfunction.mutateAsync({
        nodeId: fmQuery.data.node_id,
        updates: {
          has_name: String(fmQuery.data.attributes?.has_name ?? '').trim(),
          malfunction_description: fmDescription.trim(),
          malfunction_asil: fmAsil ?? '',
          ...updates,
        },
      });
      markFmHeaderSaved();
    } catch (err: unknown) {
      // Revert the optimistic tree title on failure
      if ('has_name' in updates) {
        const originalName = String(fmQuery.data.attributes?.has_name ?? '');
        onRenameSelectedTreeElement?.(originalName);
      }
      message.error(String((err as Error)?.message ?? 'Failed to update malfunction'));
    }
  }, [fmQuery.data, updateMalfunction, fmDescription, fmAsil, onRenameSelectedTreeElement, markFmHeaderSaved]);

  // ── Note mutations for malfunction (passed to MalfunctionTabContent) ──
  const createNoteForFm = useCreateNoteForFm(namespace, workspaceKey ?? null, triggerAutoSave);
  const updateNoteForFm = useUpdateSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);
  const deleteNoteForFm = useDeleteSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);

  const handleFmAddNote = useCallback(async (text: string) => {
    if (!selectedTreeElement) return;
    await createNoteForFm.mutateAsync({ failureModeNodeId: selectedTreeElement.nodeId, noteText: text });
  }, [selectedTreeElement, createNoteForFm]);

  const handleFmUpdateNote = useCallback(async (nodeId: number, text: string) => {
    await updateNoteForFm.mutateAsync({ nodeId, updates: { note_text: text } });
  }, [updateNoteForFm]);

  const handleFmDeleteNote = useCallback(async (nodeId: number) => {
    await deleteNoteForFm.mutateAsync({ nodeId, parentNodeId: selectedTreeElement?.nodeId });
  }, [deleteNoteForFm, selectedTreeElement]);

  // ── Note mutations for non-malfunction elements ────────────────────
  const createNoteForElement = useCreateNoteForElement(namespace, workspaceKey ?? null, triggerAutoSave);
  const updateNoteForElement = useUpdateSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);
  const deleteNoteForElement = useDeleteSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);

  const handleElementAddNote = useCallback(async (text: string) => {
    if (!selectedTreeElement) return;
    await createNoteForElement.mutateAsync({
      elementNodeId: selectedTreeElement.nodeId,
      elementNamespace: selectedTreeElement.namespace,
      noteText: text,
    });
  }, [selectedTreeElement, createNoteForElement]);

  const handleElementUpdateNote = useCallback(async (nodeId: number, text: string) => {
    await updateNoteForElement.mutateAsync({ nodeId, updates: { note_text: text } });
  }, [updateNoteForElement]);

  const handleElementDeleteNote = useCallback(async (nodeId: number) => {
    await deleteNoteForElement.mutateAsync({
      nodeId,
      parentNodeId: selectedTreeElement?.nodeId,
      parentNamespace: selectedTreeElement?.namespace,
    });
  }, [deleteNoteForElement, selectedTreeElement]);

  // ── Compute malfunction tab count badges ──────────────────────────
  const malfunctionTabsWithCounts = useMemo((): TabDefinition[] => {
    if (!isMalfunction) return MALFUNCTION_TABS;
    return MALFUNCTION_TABS.map((tab) => {
      switch (tab.key) {
        case 'risk-rating':
          return { ...tab, count: riskRatingQuery.data ? 1 : 0 };
        case 'safety-tasks':
          return { ...tab, count: tasksQuery.data?.length ?? 0 };
        case 'requirements':
          return { ...tab, count: (requirementsQuery.data?.length ?? 0) + (directRequirementsQuery.data?.length ?? 0) };
        case 'propagation':
          return { ...tab, count: (propagationsQuery.data?.propagatesTo.length ?? 0) + (propagationsQuery.data?.propagatesFrom.length ?? 0) };
        case 'review':
          return { ...tab, count: reviewItemsQuery.data?.length ?? 0 };
        default:
          return tab; // Overview and Risk Rating have no count badges
      }
    });
  }, [isMalfunction, riskRatingQuery.data, tasksQuery.data, requirementsQuery.data, directRequirementsQuery.data, propagationsQuery.data, reviewItemsQuery.data]);

  // Derive display name from fresh query data (never from selectedTreeElement.name)
  const displayName = useMemo(() => {
    if (!selectedTreeElement) return '';
    if (isMalfunction) {
      return String(fmQuery.data?.attributes?.has_name ?? `Malfunction ${selectedTreeElement.nodeId}`);
    }
    const attrs = instanceQuery.data?.attributes as Record<string, unknown> | undefined;
    return String(
      attrs?.has_name ?? attrs?.short_name ?? attrs?.title ?? selectedTreeElement.name ?? `Node ${selectedTreeElement.nodeId}`,
    );
  }, [selectedTreeElement, isMalfunction, fmQuery.data, instanceQuery.data]);

  // Sync fresh display name back to tree + history when it differs from the
  // stale name captured at selection time (fixes history showing "(concept)"
  // for elements whose name wasn't available when the tree first loaded).
  useEffect(() => {
    if (!selectedTreeElement || !displayName) return;
    if (displayName !== selectedTreeElement.name && !displayName.startsWith('Malfunction ') && !displayName.startsWith('Node ')) {
      onRenameSelectedTreeElement?.(displayName);
    }
  }, [displayName, selectedTreeElement, onRenameSelectedTreeElement]);

  // ── Copy / Paste malfunction callbacks ────────────────────────────
  const isHostElement = !isMalfunction && canHostCrossNSSafetyElements(selectedTreeElement?.concept ?? '');

  const handleCopyMalfunction = useCallback(() => {
    if (!isMalfunction || !selectedTreeElement || !fmQuery.data) return;
    const fm = fmQuery.data;
    const rr = riskRatingQuery.data;
    setCopiedMalfunction({
      sourceNodeId: selectedTreeElement.nodeId,
      sourceNamespace: namespace,
      name: displayName,
      description: String(fm.attributes?.malfunction_description ?? ''),
      asil: String(fm.attributes?.malfunction_asil ?? '') || undefined,
      riskRating: rr ? {
        severity: String(rr.attributes?.has_severity ?? '') || undefined,
        occurrence: String(rr.attributes?.has_occurrence_level ?? '') || undefined,
        detection: String(rr.attributes?.has_detection_level ?? '') || undefined,
        note: String(rr.attributes?.risk_rating_note ?? '') || undefined,
      } : null,
      safetyTaskNodeIds: (tasksQuery.data ?? []).map((t) => t.node_id),
      requirementNodeIds: (requirementsQuery.data ?? []).map((r) => r.node_id),
      directRequirementNodeIds: (directRequirementsQuery.data ?? []).map((r) => r.node_id),
    });
    void message.success(`"${displayName}" copied to clipboard`);
  }, [isMalfunction, selectedTreeElement, fmQuery.data, riskRatingQuery.data, tasksQuery.data, requirementsQuery.data, directRequirementsQuery.data, displayName, namespace, setCopiedMalfunction]);

  const handlePasteMalfunction = useCallback(async () => {
    if (!copiedMalfunction || !selectedTreeElement || !isHostElement) return;
    try {
      await pasteMalfunctionMutation.mutateAsync({
        copied: copiedMalfunction,
        safetyNamespace: namespace,
        occursAtNodeId: selectedTreeElement.nodeId,
        occursAtNamespace: selectedTreeElement.namespace,
      });
      // Deterministically refresh + expand the host structural node so the pasted
      // malfunction's reference child appears immediately, even if the host was
      // never expanded (e.g. a port that previously had no malfunctions). Cache
      // invalidation alone silently skips never-expanded structural parents.
      onTreeMutation?.(selectedTreeElement);
      void message.success(`"${copiedMalfunction.name} COPY" created`);
    } catch (err) {
      void message.error(String((err as Error)?.message ?? 'Failed to paste malfunction'));
    }
  }, [copiedMalfunction, selectedTreeElement, isHostElement, pasteMalfunctionMutation, namespace, onTreeMutation]);

  return (
    <div style={{ flex: 1, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', background: token.colorBgLayout, minWidth: 480 }}>
      {/* ── ElementHeader — fixed, non-scrolling ─────────────────────── */}
      {selectedTreeElement && (
        <div style={{ flexShrink: 0 }}>
          <ElementHeader
            selectedTreeElement={selectedTreeElement}
            displayName={displayName}
            nodeId={selectedTreeElement.nodeId}
            stablePath={(() => {
              const attrs = isMalfunction
                ? (fmQuery.data?.attributes as Record<string, unknown> | undefined)
                : (instanceQuery.data?.attributes as Record<string, unknown> | undefined);
              return typeof attrs?.stable_path === 'string' ? attrs.stable_path : undefined;
            })()}
            uuid={(() => {
              const attrs = isMalfunction
                ? (fmQuery.data?.attributes as Record<string, unknown> | undefined)
                : (instanceQuery.data?.attributes as Record<string, unknown> | undefined);
              return typeof attrs?.uuid === 'string' ? attrs.uuid : undefined;
            })()}
            shortName={(() => {
              const attrs = isMalfunction
                ? (fmQuery.data?.attributes as Record<string, unknown> | undefined)
                : (instanceQuery.data?.attributes as Record<string, unknown> | undefined);
              return typeof attrs?.short_name === 'string' ? attrs.short_name : undefined;
            })()}
            tags={tagsQuery.data ?? []}
            allTags={allTagsQuery.data ?? []}
            isDiagramConcept={isDiagramConcept}
            lensValue={lensValue}
            onLensChange={(v) => setLensValue(v)}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onCreateAndAddTag={allowCreateTag ? handleCreateAndAddTag : undefined}
            allowAddTag={allowAddTag}
            onNavigateToNode={onNavigateToNode}
            onNavigateToReference={onNavigateToReference}
            onShowReferenceInTree={onShowReferenceInTree && selectedTreeElement
              ? () => onShowReferenceInTree(selectedTreeElement)
              : undefined}
            referenceInTreeTarget={referenceInTreeTarget}
            onRename={isMalfunction ? (newName) => saveFmField({ has_name: newName }) : undefined}
            safetyNamespace={isMalfunction ? namespace : undefined}
            onStartPropagation={isMalfunction ? onStartPropagation : undefined}
            onEndPropagation={isMalfunction ? onEndPropagation : undefined}
            onCopyMalfunction={isMalfunction ? handleCopyMalfunction : undefined}
            onPasteMalfunction={isHostElement && copiedMalfunction ? handlePasteMalfunction : undefined}
            onDeleteTag={selectedTreeElement?.concept === 'tag' ? () => setPendingDeleteTagNodeId(selectedTreeElement.nodeId) : undefined}
            onDeleteNote={isSafetyNote ? () => setPendingDeleteNoteNodeId(selectedTreeElement!.nodeId) : undefined}
            onShowNoteReferenceInTree={isSafetyNote && noteParentQuery.data && onNavigateToReference && selectedTreeElement
              ? () => onNavigateToReference(
                  selectedTreeElement.nodeId,
                  selectedTreeElement.namespace,
                  'safety_note',
                  noteParentQuery.data!.node_id,
                  noteParentQuery.data!.namespace,
                )
              : undefined}
            supportsTagging={canHostCrossNSSafetyElements(selectedTreeElement.concept)}
          />
        </div>
      )}

      {/* ── ElementTabs — fixed, non-scrolling (malfunction) ──────── */}
      {selectedTreeElement && isMalfunction && !(isDiagramConcept && (lensValue === 'diagram' || lensValue === 'propagation' || lensValue === 'table')) && (
        <div style={{ flexShrink: 0, background: token.colorBgContainer }}>
          <ElementTabs
            tabs={malfunctionTabsWithCounts}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>
      )}

      {/* ── ElementTabs — fixed, non-scrolling (non-malfunction / diagram details) ── */}
      {selectedTreeElement && !isMalfunction && !(isDiagramConcept && (lensValue === 'diagram' || lensValue === 'propagation' || lensValue === 'table')) && (
        <div style={{ flexShrink: 0, background: token.colorBgContainer }}>
          <ElementTabs
            tabs={elementTabsWithCounts}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>
      )}

      {/* ── Content area — scrollable ────────────────────────────────── */}
      <div style={
        (isMalfunction && activeTab === 'propagation') || (isDiagramConcept && (lensValue === 'diagram' || lensValue === 'propagation' || lensValue === 'table'))
          ? { flex: 1, display: 'flex', minHeight: 0, background: token.colorBgLayout }
          : { flex: 1, overflow: 'auto', background: token.colorBgLayout, padding: 16 }
      }>
        {!selectedTreeElement ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Select an element in the model tree. Right-click supported elements to add a malfunction."
            style={{ marginTop: 96 }}
          />
        ) : isDiagramConcept && lensValue === 'diagram' ? (
          <PortConnectorDiagram
            selectedTreeElement={selectedTreeElement}
            workspaceKey={workspaceKey ?? null}
            safetyNamespace={namespace}
            onNavigateToNode={onNavigateToNode}
            onNavigateToReference={onNavigateToReference}
            onShowDetails={handleShowDetails}
          />
        ) : isDiagramConcept && lensValue === 'propagation' ? (
          <ScopedPropagationDiagram
            structuralNodeId={selectedTreeElement.nodeId}
            namespace={namespace}
            workspaceKey={workspaceKey ?? null}
            onNavigateToNode={onNavigateToNode}
            onNavigateToReference={onNavigateToReference}
          />
        ) : isDiagramConcept && lensValue === 'table' ? (
          <MalfunctionTableView
            scopeNodeId={selectedTreeElement.nodeId}
            namespace={namespace}
            workspaceKey={workspaceKey ?? null}
            onNavigateToNode={onNavigateToNode}
            onNavigateToReference={onNavigateToReference}
            onStartPropagation={onStartPropagation}
            onEndPropagation={onEndPropagation}
            triggerAutoSave={triggerAutoSave}
            onTreeMutation={(node) => { onTreeMutation?.(node); }}
          />
        ) : isMalfunction ? (
          <>
            {fmQuery.data && fmQuery.data.namespace !== namespace && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`Malfunction is in imported namespace "${fmQuery.data.namespace}"`}
                description="This malfunction was not created in the authored safety namespace. Risk ratings, tasks, requirements and notes can only be added to malfunctions in the safety namespace."
              />
            )}
          <MalfunctionTabContent
            activeTab={activeTab}
            namespace={namespace}
            selectedTreeElement={selectedTreeElement}
            fmQuery={fmQuery}
            riskRatingQuery={riskRatingQuery}
            tasksQuery={tasksQuery}
            requirementsQuery={requirementsQuery}
            directRequirementsQuery={directRequirementsQuery}
            notesQuery={notesForFmQuery}
            propagationsQuery={propagationsQuery}
            reviewItemsQuery={reviewItemsQuery}
            fmDescription={fmDescription}
            setFmDescription={setFmDescription}
            fmAsil={fmAsil}
            setFmAsil={setFmAsil}
            asilOptions={asilOptions}
            saveFmField={saveFmField}
            fmHeaderSaved={fmHeaderSaved}
            taskGhostRef={taskGhostRef}
            noteGhostRef={noteGhostRef}
            onNavigateToNode={onNavigateToNode}
            onNavigateToReference={onNavigateToReference}
            workspaceKey={workspaceKey}
            onAddNote={handleFmAddNote}
            onUpdateNote={handleFmUpdateNote}
            onDeleteNote={handleFmDeleteNote}
            triggerAutoSave={triggerAutoSave}
          />
          </>
        ) : (
          <ElementTabContent
            activeTab={activeTab}
            namespace={namespace}
            selectedTreeElement={selectedTreeElement}
            instanceQuery={instanceQuery}
            notesQuery={notesForElementQuery}
            addNoteRequested={addNoteRequested}
            onAddNoteHandled={onAddNoteHandled}
            workspaceKey={workspaceKey}
            onAddNote={handleElementAddNote}
            onUpdateNote={handleElementUpdateNote}
            onDeleteNote={handleElementDeleteNote}
            onNavigateToNode={onNavigateToNode}
            triggerAutoSave={triggerAutoSave}
          />
        )}
      </div>

      {/* Tag delete impact preview — triggered from ElementHeader kebab menu */}
      {pendingDeleteTagNodeId !== null && (
        <DeleteWithPreview
          nodeId={pendingDeleteTagNodeId}
          onCancel={() => setPendingDeleteTagNodeId(null)}
          onConfirm={async () => {
            await deleteTagFromHeader.mutateAsync({ nodeId: pendingDeleteTagNodeId });
            setPendingDeleteTagNodeId(null);
          }}
        >
          {(openPreview) => <_AutoOpenTagPreview onMount={openPreview} />}
        </DeleteWithPreview>
      )}

      {/* Note delete — triggered from ElementHeader kebab menu */}
      {pendingDeleteNoteNodeId !== null && (
        <DeleteWithPreview
          nodeId={pendingDeleteNoteNodeId}
          onCancel={() => setPendingDeleteNoteNodeId(null)}
          onConfirm={async () => {
            await deleteNoteFromHeader.mutateAsync({
              nodeId: pendingDeleteNoteNodeId,
              parentNodeId: noteParentQuery.data?.node_id,
              parentNamespace: noteParentQuery.data?.namespace,
            });
            setPendingDeleteNoteNodeId(null);
          }}
        >
          {(openPreview) => <_AutoOpenTagPreview onMount={openPreview} />}
        </DeleteWithPreview>
      )}
    </div>
  );
}

/** Renders the active tab content for a malfunction element. */
function MalfunctionTabContent({
  activeTab,
  namespace,
  selectedTreeElement,
  fmQuery,
  riskRatingQuery,
  tasksQuery,
  requirementsQuery,
  directRequirementsQuery,
  notesQuery,
  propagationsQuery,
  reviewItemsQuery,
  fmDescription,
  setFmDescription,
  fmAsil,
  setFmAsil,
  asilOptions,
  saveFmField,
  fmHeaderSaved,
  taskGhostRef,
  noteGhostRef,
  onNavigateToNode,
  onNavigateToReference,
  workspaceKey,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  triggerAutoSave,
}: {
  activeTab: string;
  namespace: string;
  selectedTreeElement: SelectedTreeElement;
  fmQuery: ReturnType<typeof useMalfunction>;
  riskRatingQuery: ReturnType<typeof useRiskRating>;
  tasksQuery: ReturnType<typeof useSafetyTasks>;
  requirementsQuery: ReturnType<typeof useRequirementsForFm>;
  directRequirementsQuery: ReturnType<typeof useDirectRequirementsForFm>;
  notesQuery: ReturnType<typeof useNotesForFm>;
  propagationsQuery: ReturnType<typeof usePropagations>;
  reviewItemsQuery: ReturnType<typeof useReviewItems>;
  fmDescription: string;
  setFmDescription: (v: string) => void;
  fmAsil: string | undefined;
  setFmAsil: (v: string | undefined) => void;
  asilOptions: AsilSelectEntry[];
  saveFmField: (updates: Record<string, string>) => Promise<void>;
  fmHeaderSaved: boolean;
  taskGhostRef: React.RefObject<InputRef | null>;
  noteGhostRef: React.RefObject<InputRef | null>;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
  workspaceKey?: string | null;
  onAddNote: (text: string) => Promise<void>;
  onUpdateNote: (nodeId: number, text: string) => Promise<void>;
  onDeleteNote: (nodeId: number) => Promise<void>;
  triggerAutoSave?: () => void;
}) {
  if (fmQuery.isLoading) {
    return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (!fmQuery.data) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Malfunction not found" style={{ marginTop: 96 }} />;
  }

  const failureMode = fmQuery.data;
  const attrs = (failureMode.attributes ?? {}) as Record<string, unknown>;
  const stablePath = typeof attrs.stable_path === 'string' ? attrs.stable_path : undefined;
  const uuid = typeof attrs.uuid === 'string' ? attrs.uuid : undefined;
  const shortName = typeof attrs.short_name === 'string' ? attrs.short_name : (typeof attrs.has_name === 'string' ? attrs.has_name : undefined);

  switch (activeTab) {
    case 'overview':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Description — save-on-blur */}
          <div>
            <Typography.Text strong>Description</Typography.Text>
            <Input.TextArea
              rows={4}
              value={fmDescription}
              onChange={(event) => setFmDescription(event.target.value)}
              placeholder="Describe the malfunction"
              style={{ marginTop: 6, fontSize: 13 }}
              onBlur={() => saveFmField({ malfunction_description: fmDescription.trim() })}
            />
          </div>

          {/* ASIL — save-on-change */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text strong style={{ flexShrink: 0 }}>ASIL</Typography.Text>
            <div style={{
              borderLeft: `3px solid ${fmAsil ? getAsilHexColor(fmAsil) : 'transparent'}`,
              borderRadius: 2,
              transition: 'border-color 0.2s',
            }}>
              <Select
                allowClear
                size="small"
                value={fmAsil}
                onChange={(value) => { setFmAsil(value); saveFmField({ malfunction_asil: value ?? '' }); }}
                options={asilOptions}
                placeholder="—"
                style={{ width: 110 }}
                optionRender={(option) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: (option.data as any).color ?? '#8c8c8c',
                    }} />
                    {option.label}
                  </div>
                )}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 22 }}>
            <SavedBadge visible={fmHeaderSaved} />
          </div>

          {/* Notes — inline at bottom of overview */}
          <InlineNotesSection
            notes={notesQuery.data ?? []}
            loading={notesQuery.isLoading}
            onAddNote={onAddNote}
            onUpdateNote={onUpdateNote}
            onDeleteNote={onDeleteNote}
          />
        </div>
      );

    case 'risk-rating':
      return (
        <RiskRatingSectionExtracted
          fmNodeId={selectedTreeElement.nodeId}
          namespace={namespace}
          workspaceKey={workspaceKey ?? null}
          triggerAutoSave={triggerAutoSave}
        />
      );

    case 'propagation':
      return (
        <FailurePropagationDiagram
          entryNodeId={selectedTreeElement.nodeId}
          namespace={namespace}
          workspaceKey={workspaceKey ?? null}
          onNavigateToNode={onNavigateToNode}
          onNavigateToReference={onNavigateToReference}
        />
      );

    case 'safety-tasks':
      return (
        <SafetyTaskSection
          fmNodeId={selectedTreeElement.nodeId}
          namespace={namespace}
          workspaceKey={workspaceKey ?? null}
          triggerAutoSave={triggerAutoSave}
        />
      );

    case 'requirements':
      return (
        <RequirementsSection
          fmNodeId={selectedTreeElement.nodeId}
          namespace={namespace}
          workspaceKey={workspaceKey ?? null}
          onNavigateToNode={onNavigateToNode}
          triggerAutoSave={triggerAutoSave}
        />
      );

    case 'review':
      return (
        <ReviewSectionExtracted
          fmNodeId={selectedTreeElement.nodeId}
          namespace={namespace}
          workspaceKey={workspaceKey ?? null}
          triggerAutoSave={triggerAutoSave}
        />
      );

    default:
      return null;
  }
}

/** Renders the active tab content for a non-malfunction element (or diagram concept in Details lens). */
function ElementTabContent({
  activeTab,
  namespace,
  selectedTreeElement,
  instanceQuery,
  notesQuery,
  addNoteRequested,
  onAddNoteHandled,
  workspaceKey,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onNavigateToNode,
  triggerAutoSave,
}: {
  activeTab: string;
  namespace: string;
  selectedTreeElement: SelectedTreeElement;
  instanceQuery: ReturnType<typeof useInstance>;
  notesQuery: ReturnType<typeof useNotesForElement>;
  addNoteRequested?: boolean;
  onAddNoteHandled?: () => void;
  workspaceKey?: string | null;
  onAddNote: (text: string) => Promise<void>;
  onUpdateNote: (nodeId: number, text: string) => Promise<void>;
  onDeleteNote: (nodeId: number) => Promise<void>;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  triggerAutoSave?: () => void;
}) {
  const { token } = theme.useToken();
  const linkedMalfunctionsQuery = useMalfunctionsForRequirement(selectedTreeElement.nodeId);

  if (instanceQuery.isLoading) {
    return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  const instance = instanceQuery.data;
  const attributes = (instance?.attributes ?? {}) as Record<string, unknown>;
  const contentText = typeof attributes.content === 'string' ? attributes.content.trim() : '';
  const detailItems = collectDetailItems(attributes);
  const stablePath = typeof attributes.stable_path === 'string' ? attributes.stable_path : undefined;
  const uuid = typeof attributes.uuid === 'string' ? attributes.uuid : undefined;
  const shortName = typeof attributes.short_name === 'string' ? attributes.short_name : undefined;

  switch (activeTab) {
    case 'overview':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {selectedTreeElement.concept === 'safety_note' && (
            <LinkedElementBanner noteNodeId={selectedTreeElement.nodeId} />
          )}

          {/* Element Details section */}
          {(contentText || detailItems.length > 0) && (
            <div style={{ borderLeft: `3px solid ${token.colorPrimary}`, paddingLeft: 16 }}>
              <SectionHeader title="Element Details" count={(contentText ? 1 : 0) + detailItems.length} />
              {contentText ? (
                <div style={{ marginBottom: 14 }}>
                  <Typography.Text strong style={{ fontSize: 12 }}>Content</Typography.Text>
                  <div
                    style={{
                      marginTop: 6,
                      padding: 12,
                      borderRadius: 6,
                      background: token.colorFillQuaternary,
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.6,
                      fontSize: 13,
                    }}
                  >
                    {contentText}
                  </div>
                </div>
              ) : null}

              {detailItems.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {detailItems.map((item) => (
                    <div
                      key={item.key}
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: '8px 0',
                        borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        alignItems: item.isMultiline ? 'flex-start' : 'baseline',
                      }}
                    >
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11, width: 100, flexShrink: 0 }}
                      >
                        {item.label}
                      </Typography.Text>
                      <Typography.Text
                        style={{
                          fontSize: 12,
                          whiteSpace: item.isMultiline ? 'pre-wrap' : 'normal',
                          wordBreak: 'break-word',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {item.value}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Linked Malfunctions — back-references from malfunctions that link to this element */}
          {linkedMalfunctionsQuery.isLoading && (
            <div style={{ borderLeft: `3px solid ${token.colorWarning}`, paddingLeft: 16 }}>
              <SectionHeader title="Linked Malfunctions" count={0} />
              <Spin size="small" />
            </div>
          )}
          {(linkedMalfunctionsQuery.data?.length ?? 0) > 0 && (
            <div style={{ borderLeft: `3px solid ${token.colorWarning}`, paddingLeft: 16 }}>
              <SectionHeader title="Linked Malfunctions" count={linkedMalfunctionsQuery.data!.length} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {linkedMalfunctionsQuery.data!.map((fm) => {
                  const fmAttrs = fm.attributes as Record<string, unknown>;
                  const fmName = String(fmAttrs.has_name ?? fmAttrs.short_name ?? fmAttrs.title ?? `Malfunction ${fm.node_id}`);
                  const fmAsil = fmAttrs.malfunction_asil ?? fmAttrs.asil;
                  return (
                    <ShowInTreeTrigger
                      key={fm.node_id}
                      homeTarget={{ nodeId: fm.node_id, namespace: fm.namespace, concept: fm.concept }}
                      onNavigate={onNavigateToNode}
                      wrapperStyle={{ width: '100%' }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          border: `1px solid ${token.colorBorderSecondary}`,
                          borderRadius: token.borderRadiusSM,
                          background: token.colorFillQuaternary,
                          cursor: 'context-menu',
                        }}
                      >
                        <WarningOutlined style={{ color: token.colorWarning, fontSize: 14, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {fmName}
                        </span>
                        {fmAsil ? <Tag color={getAsilColor(String(fmAsil))} style={{ fontSize: 10, margin: 0 }}>ASIL {String(fmAsil)}</Tag> : null}
                        <Tag style={{ fontSize: 10, margin: 0, flexShrink: 0 }} color="default">{fm.namespace}</Tag>
                      </div>
                    </ShowInTreeTrigger>
                  );
                })}
              </div>
            </div>
          )}

          {/* Notes — only for imported elements (not for safety-authored concepts) */}
          {canHostCrossNSSafetyElements(selectedTreeElement.concept) && (
            <InlineNotesSection
              notes={notesQuery.data ?? []}
              loading={notesQuery.isLoading}
              onAddNote={onAddNote}
              onUpdateNote={onUpdateNote}
              onDeleteNote={onDeleteNote}
              openAddForm={addNoteRequested}
              onAddFormOpened={onAddNoteHandled}
            />
          )}
        </div>
      );

    default:
      return null;
  }
}

function LinkedElementBanner({ noteNodeId }: { noteNodeId: number }) {
  const { token } = theme.useToken();
  const parentQuery = useNoteParent(noteNodeId);
  const instance = parentQuery.data;
  const attrs = (instance?.attributes ?? {}) as Record<string, unknown>;
  const name = String(attrs.short_name ?? attrs.has_name ?? attrs.title ?? instance?.concept ?? '');
  const path = typeof attrs.stable_path === 'string' ? attrs.stable_path : '';

  if (parentQuery.isLoading) return <Spin size="small" />;
  if (!instance) return null;

  return (
    <Card size="small" styles={{ body: { padding: '10px 16px' } }} style={{ borderLeft: `3px solid ${token.colorPrimary}` }}>
      <Space size={8} wrap>
        <Typography.Text strong style={{ fontSize: 12 }}>Linked to:</Typography.Text>
        <Tag color="blue">{instance.concept}</Tag>
        <Typography.Text>{name}</Typography.Text>
        {path && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{path}</Typography.Text>}
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>· {instance.namespace} · node {instance.node_id}</Typography.Text>
      </Space>
    </Card>
  );
}

function ElementWorkspace({ namespace, selectedTreeElement, addNoteRequested, onAddNoteHandled, onTreeMutation, workspaceKey }: { namespace: string; selectedTreeElement: SelectedTreeElement; addNoteRequested?: boolean; onAddNoteHandled?: () => void; onTreeMutation?: () => void; workspaceKey?: string | null }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const instanceQuery = useInstance(selectedTreeElement.nodeId);
  const notesQuery = useNotesForElement(selectedTreeElement.nodeId);
  const tagsQuery = useTagsForImportedElement(selectedTreeElement.nodeId);
  const allTagsQuery = useTags(namespace);
  const { createTag, linkTagCrossNs, unlinkTagCrossNs } = useTagMutations();
  const qc = useQueryClient();
  const createNote = useCreateNoteForElement(namespace, workspaceKey ?? null);
  const updateNote = useUpdateSafetyNote(namespace, workspaceKey ?? null);
  const deleteNote = useDeleteSafetyNote(namespace, workspaceKey ?? null);
  const [addingNote, setAddingNote] = useState(false);
  const [newNoteText, setNewNoteText] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<number | undefined>();

  useEffect(() => {
    if (addNoteRequested) {
      setAddingNote(true);
      onAddNoteHandled?.();
    }
  }, [addNoteRequested, onAddNoteHandled]);

  const instance = instanceQuery.data;
  const attributes = (instance?.attributes ?? {}) as Record<string, unknown>;
  const contentText = typeof attributes.content === 'string' ? attributes.content.trim() : '';
  const detailItems = useMemo(() => collectDetailItems(attributes), [attributes]);

  if (instanceQuery.isLoading) {
    return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  const notes = notesQuery.data ?? [];
  const tags = tagsQuery.data ?? [];
  const title = selectedTreeElement.name ?? String(instance?.attributes?.has_name ?? `Node ${selectedTreeElement.nodeId}`);

  // Extract identity fields for the header strip
  const stablePath = typeof attributes.stable_path === 'string' ? attributes.stable_path : undefined;
  const uuid = typeof attributes.uuid === 'string' ? attributes.uuid : undefined;
  const shortName = typeof attributes.short_name === 'string' ? attributes.short_name : undefined;
  const identityFields = [
    stablePath && { label: 'Path', value: stablePath },
    uuid && { label: 'UUID', value: uuid },
    shortName && { label: 'Short Name', value: shortName },
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  const handleCreateNote = async () => {
    if (!newNoteText.trim()) return;
    try {
      await createNote.mutateAsync({
        elementNodeId: selectedTreeElement.nodeId,
        elementNamespace: selectedTreeElement.namespace,
        noteText: newNoteText.trim(),
      });
      setNewNoteText('');
      setAddingNote(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create note'));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ── Element Header ──────────────────────────────────────────────── */}
      <Card
        size="small"
        styles={{ body: { padding: 0 } }}
        style={{ marginBottom: 24 }}
      >
        {/* Top tier: name + concept badge */}
        <div style={{ padding: '16px 20px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Typography.Title level={4} style={{ margin: 0, flex: 1, minWidth: 0 }}>{title}</Typography.Title>
            <Tag color="processing" style={{ flexShrink: 0 }}>{selectedTreeElement.concept}</Tag>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
            node {selectedTreeElement.nodeId}
          </Typography.Text>
        </div>

        {/* Bottom tier: identity key-value strip */}
        {identityFields.length > 0 && (
          <div
            style={{
              padding: '10px 20px',
              background: token.colorFillQuaternary,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {identityFields.map((field) => (
              <div key={field.label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, width: 80, flexShrink: 0 }}
                >
                  {field.label}
                </Typography.Text>
                <CopyableValue value={field.value} mono />
              </div>
            ))}
          </div>
        )}

        {/* Tags strip — lightweight, no card wrapper */}
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
          {tags.length === 0 && !addingTag ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>No tags</Typography.Text>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
              {tags.map((tag) => (
                <TagChip
                  key={tag.node_id}
                  color={String(tag.attributes?.tag_color || 'purple')}
                  closable
                  style={{ fontSize: 13, lineHeight: '22px' }}
                  onClose={async (e) => {
                    e.preventDefault();
                    try {
                      await unlinkTagCrossNs.mutateAsync({ tagNodeId: tag.node_id, importedElementNodeId: selectedTreeElement.nodeId });
                      qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
                      qc.invalidateQueries({ queryKey: ['tags'] });
                      if (workspaceKey) qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, selectedTreeElement.namespace, selectedTreeElement.nodeId) });
                    } catch (err: unknown) {
                      message.error(String((err as Error)?.message ?? 'Failed to remove tag'));
                    }
                  }}
                >
                  {String(tag.attributes?.has_name ?? '—')}
                </TagChip>
              ))}
            </div>
          )}
          <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
            {addingTag ? (
              <Space size={4}>
                <Select
                  showSearch
                  size="small"
                  placeholder="Select or type new tag"
                  value={selectedTagId}
                  onChange={async (value: number) => {
                    try {
                      await linkTagCrossNs.mutateAsync({ tagNodeId: value, importedElementNodeId: selectedTreeElement.nodeId });
                      qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
                      qc.invalidateQueries({ queryKey: ['tags'] });
                      if (workspaceKey) qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, selectedTreeElement.namespace, selectedTreeElement.nodeId) });
                      setSelectedTagId(undefined);
                      setAddingTag(false);
                    } catch (err: unknown) {
                      message.error(String((err as Error)?.message ?? 'Failed to link tag'));
                    }
                  }}
                  options={(allTagsQuery.data ?? [])
                    .filter((t) => !tags.some((et) => et.node_id === t.node_id))
                    .map((t) => ({
                      value: t.node_id,
                      label: String(t.attributes?.has_name ?? `Tag ${t.node_id}`),
                    }))}
                  style={{ width: 180 }}
                  filterOption={(input, option) =>
                    (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                  onInputKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      const input = (e.target as HTMLInputElement).value?.trim();
                      const existingOptions = (allTagsQuery.data ?? [])
                        .filter((t) => !tags.some((et) => et.node_id === t.node_id));
                      if (input && !existingOptions.some((o) => String(o.attributes?.has_name ?? '').toLowerCase() === input.toLowerCase())) {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                          const created = await createTag.mutateAsync({ namespace, name: input });
                          await linkTagCrossNs.mutateAsync({ tagNodeId: created.node_id, importedElementNodeId: selectedTreeElement.nodeId });
                          qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
                          qc.invalidateQueries({ queryKey: ['tags'] });
                          if (workspaceKey) qc.invalidateQueries({ queryKey: treeChildrenQueryKey(workspaceKey, selectedTreeElement.namespace, selectedTreeElement.nodeId) });
                          setSelectedTagId(undefined);
                          setAddingTag(false);
                        } catch (err: unknown) {
                          message.error(String((err as Error)?.message ?? 'Failed to create tag'));
                        }
                      }
                    }
                  }}
                />
                <Button size="small" onClick={() => { setAddingTag(false); setSelectedTagId(undefined); }}>Cancel</Button>
              </Space>
            ) : (
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setAddingTag(true)} style={{ fontSize: 11 }}>
                Add Tag
              </Button>
            )}
          </div>
        </div>
      </Card>

      {selectedTreeElement.concept === 'safety_note' && (
        <div style={{ marginBottom: 16 }}>
          <LinkedElementBanner noteNodeId={selectedTreeElement.nodeId} />
        </div>
      )}

      {/* ── Element Details ─────────────────────────────────────────────── */}
      {(contentText || detailItems.length > 0) && (
      <div style={{ borderLeft: `3px solid ${token.colorPrimary}`, paddingLeft: 16, marginBottom: 16 }}>
        <SectionHeader title="Element Details" count={(contentText ? 1 : 0) + detailItems.length} />
        {contentText ? (
          <div style={{ marginBottom: 14 }}>
            <Typography.Text strong style={{ fontSize: 12 }}>Content</Typography.Text>
            <div
              style={{
                marginTop: 6,
                padding: 12,
                borderRadius: 6,
                background: token.colorFillQuaternary,
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                fontSize: 13,
              }}
            >
              {contentText}
            </div>
          </div>
        ) : null}

        {detailItems.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {detailItems.map((item) => (
              <div
                key={item.key}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  alignItems: item.isMultiline ? 'flex-start' : 'baseline',
                }}
              >
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, width: 100, flexShrink: 0 }}
                >
                  {item.label}
                </Typography.Text>
                <Typography.Text
                  style={{
                    fontSize: 12,
                    whiteSpace: item.isMultiline ? 'pre-wrap' : 'normal',
                    wordBreak: 'break-word',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {item.value}
                </Typography.Text>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ── Safety Notes ────────────────────────────────────────────────── */}
      <div style={{ borderLeft: `3px solid ${token.colorPrimary}`, paddingLeft: 16, marginBottom: 16 }}>
        <SectionHeader
          title="Safety Notes"
          count={notes.length}
          action={
            addingNote ? undefined : (
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setAddingNote(true)} style={{ fontSize: 11 }}>
                Add Note
              </Button>
            )
          }
        />

        {addingNote && (
          <div style={{ marginBottom: 12 }}>
            <Input.TextArea
              rows={2}
              placeholder="Note text"
              value={newNoteText}
              onChange={(e) => setNewNoteText(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <Space size={8}>
              <Button size="small" type="primary" onClick={handleCreateNote} loading={createNote.isPending} disabled={!newNoteText.trim()}>Create</Button>
              <Button size="small" onClick={() => { setAddingNote(false); setNewNoteText(''); }}>Cancel</Button>
            </Space>
          </div>
        )}

        {notes.length === 0 && !addingNote ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No safety notes linked to this element" style={{ margin: '12px 0' }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {notes.map((note) => (
              <Card key={note.node_id} size="small" styles={{ body: { padding: 12 } }}>
                <ElementNoteEditorCard note={note} parentNodeId={selectedTreeElement.nodeId} updateNote={updateNote} deleteNote={deleteNote} />
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MalfunctionWorkspace({
  namespace,
  selectedTreeElement,
  onRenameSelectedTreeElement,
  onNavigateToNode,
  onNavigateToReference,
  onTreeMutation,
  workspaceKey,
}: CenterPanelProps & { selectedTreeElement: SelectedTreeElement }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const fmQuery = useMalfunction(selectedTreeElement.nodeId);
  const riskRatingQuery = useRiskRating(selectedTreeElement.nodeId);
  const tasksQuery = useSafetyTasks(selectedTreeElement.nodeId);
  const requirementsQuery = useRequirementsForFm(selectedTreeElement.nodeId);
  const directRequirementsQuery = useDirectRequirementsForFm(selectedTreeElement.nodeId);
  const notesQuery = useNotesForFm(selectedTreeElement.nodeId);
  const propagationsQuery = usePropagations(selectedTreeElement.nodeId);
  const taskGhostRef = useRef<InputRef>(null);
  const noteGhostRef = useRef<InputRef>(null);
  void taskGhostRef; void noteGhostRef; // kept for ref passing to sections
  const reviewItemsQuery = useReviewItems(selectedTreeElement.nodeId);
  const updateMalfunction = useUpdateMalfunction(namespace, workspaceKey ?? null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [asil, setAsil] = useState<string | undefined>();
  const { isSaved: headerSaved, markSaved: markHeaderSaved } = useSavedFeedback();

  useEffect(() => {
    const failureMode = fmQuery.data;
    if (!failureMode) return;
    setName(String(failureMode.attributes?.has_name ?? ''));
    setDescription(String(failureMode.attributes?.malfunction_description ?? ''));
    const asilValue = String(failureMode.attributes?.malfunction_asil ?? '');
    setAsil(asilValue || undefined);
  }, [fmQuery.data]);

  const asilOptions = useMemo<AsilSelectEntry[]>(
    () => buildAsilOptionGroups(profile.asilGroups),
    [profile.asilGroups],
  );

  if (fmQuery.isLoading || profile.isLoading) {
    return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (!fmQuery.data) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Malfunction not found" style={{ marginTop: 96 }} />;
  }

  const failureMode = fmQuery.data;
  // Always derive the display name from the fresh query data, not from the
  // selectedTreeElement.name which is set at click time and goes stale after renames.
  const sourceName = String(failureMode.attributes?.has_name ?? `Malfunction ${failureMode.node_id}`);

  const saveField = async (updates: Record<string, string>) => {
    if ('has_name' in updates) onRenameSelectedTreeElement?.(updates.has_name);
    try {
      await updateMalfunction.mutateAsync({
        nodeId: failureMode.node_id,
        updates: {
          has_name: name.trim(),
          malfunction_description: description.trim(),
          malfunction_asil: asil ?? '',
          ...updates,
        },
      });
      markHeaderSaved();
    } catch (err: unknown) {
      if ('has_name' in updates) {
        const originalName = String(failureMode.attributes?.has_name ?? '');
        onRenameSelectedTreeElement?.(originalName);
      }
      message.error(String((err as Error)?.message ?? 'Failed to update malfunction'));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" styles={{ body: { padding: 20 } }}>
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div>
              <Space size={10} align="center">
                <WarningOutlined style={{ fontSize: 22, color: token.colorWarning }} />
                <ShowInTreeTrigger
                  homeTarget={{ nodeId: failureMode.node_id, namespace, concept: failureMode.concept }}
                  referenceTarget={failureMode.occursAtTarget
                    ? { nodeId: failureMode.occursAtTarget.node_id, namespace: failureMode.occursAtTarget.namespace, concept: failureMode.occursAtTarget.concept }
                    : undefined}
                  onNavigate={onNavigateToNode}
                  onNavigateReference={failureMode.occursAtTarget && onNavigateToReference
                    ? () => onNavigateToReference(
                        failureMode.node_id, namespace, failureMode.concept,
                        failureMode.occursAtTarget!.node_id, failureMode.occursAtTarget!.namespace,
                      )
                    : undefined}
                >
                  <Typography.Title level={3} style={{ margin: 0, cursor: 'context-menu' }}>
                    {sourceName}
                  </Typography.Title>
                </ShowInTreeTrigger>
              </Space>
              <Space size={8} style={{ marginTop: 8, marginLeft: 32 }} wrap>
                <Tag color="warning">malfunction</Tag>
                <Typography.Text type="secondary">node {failureMode.node_id}</Typography.Text>
              </Space>
            </div>
            {failureMode.occursAtTarget ? (
              <ShowInTreeTrigger
                homeTarget={{
                  nodeId: failureMode.occursAtTarget.node_id,
                  namespace: failureMode.occursAtTarget.namespace,
                  concept: failureMode.occursAtTarget.concept,
                }}
                onNavigate={onNavigateToNode}
              >
                <Tag color="geekblue" style={{ cursor: 'context-menu' }}>
                  Attached To {failureMode.occursAtTarget.concept}
                </Tag>
              </ShowInTreeTrigger>
            ) : null}
          </div>

          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div>
              <Typography.Text strong>Name</Typography.Text>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Malfunction name"
                style={{ marginTop: 6 }}
                onBlur={() => { if (name.trim()) saveField({ has_name: name.trim() }); }}
                onPressEnter={() => { if (name.trim()) saveField({ has_name: name.trim() }); }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Typography.Text strong style={{ flexShrink: 0 }}>ASIL</Typography.Text>
              <div style={{
                borderLeft: `3px solid ${asil ? getAsilHexColor(asil) : 'transparent'}`,
                borderRadius: 2,
                transition: 'border-color 0.2s',
              }}>
                <Select
                  allowClear
                  size="small"
                  value={asil}
                  onChange={(value) => { setAsil(value); saveField({ malfunction_asil: value ?? '' }); }}
                  options={asilOptions}
                  placeholder="—"
                  style={{ width: 110 }}
                  optionRender={(option) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: (option.data as any).color ?? '#8c8c8c',
                      }} />
                      {option.label}
                    </div>
                  )}
                />
              </div>
            </div>
          </div>

          <div>
            <Typography.Text strong>Description</Typography.Text>
            <Input.TextArea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe the malfunction"
              style={{ marginTop: 6 }}
              onBlur={() => saveField({ malfunction_description: description.trim() })}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 22 }}>
            <SavedBadge visible={headerSaved} />
          </div>
        </Space>
      </Card>

      <div style={{ borderLeft: `3px solid ${token.colorWarning}`, paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SectionCard title="Risk Rating" count={riskRatingQuery.data ? 1 : 0}>
          <RiskRatingSection fmNodeId={selectedTreeElement.nodeId} riskRating={riskRatingQuery.data} loading={riskRatingQuery.isLoading} />
        </SectionCard>

        <SectionCard title="Safety Tasks" count={tasksQuery.data?.length ?? 0} shortcut="Ctrl+T">
          <TaskSection
            namespace={namespace}
            fmNodeId={selectedTreeElement.nodeId}
            tasks={tasksQuery.data ?? []}
            loading={tasksQuery.isLoading}
            ghostRef={taskGhostRef}
            workspaceKey={workspaceKey}
          />
        </SectionCard>

        <SectionCard title="Requirements" count={(requirementsQuery.data?.length ?? 0) + (directRequirementsQuery.data?.length ?? 0)}>
          <RequirementSection
            namespace={namespace}
            fmNodeId={selectedTreeElement.nodeId}
            requirements={requirementsQuery.data ?? []}
            directRequirements={directRequirementsQuery.data ?? []}
            loading={requirementsQuery.isLoading || directRequirementsQuery.isLoading}
            workspaceKey={workspaceKey}
            onNavigateToNode={onNavigateToNode}
          />
        </SectionCard>

        <SectionCard title="Notes" count={notesQuery.data?.length ?? 0} shortcut="Ctrl+N">
          <NoteSection
            namespace={namespace}
            fmNodeId={selectedTreeElement.nodeId}
            notes={notesQuery.data ?? []}
            loading={notesQuery.isLoading}
            ghostRef={noteGhostRef}
            workspaceKey={workspaceKey}
          />
        </SectionCard>

        <SectionCard title="Propagation" count={(propagationsQuery.data?.propagatesTo.length ?? 0) + (propagationsQuery.data?.propagatesFrom.length ?? 0)}>
          <PropagationSection namespace={namespace} fmNodeId={selectedTreeElement.nodeId} propagations={propagationsQuery.data} loading={propagationsQuery.isLoading} onNavigateToNode={onNavigateToNode} onNavigateToReference={onNavigateToReference} />
        </SectionCard>

        <SectionCard title="Review Items" count={reviewItemsQuery.data?.length ?? 0}>
          <ReviewSection namespace={namespace} reviewedElementId={selectedTreeElement.nodeId} reviewItems={reviewItemsQuery.data ?? []} loading={reviewItemsQuery.isLoading} workspaceKey={workspaceKey} />
        </SectionCard>
      </div>
    </div>
  );
}

function SectionCard({ title, count, shortcut, children }: { title: string; count: number; shortcut?: string; children: React.ReactNode }) {
  return (
    <Card size="small" styles={{ body: { padding: 18 } }}>
      <SectionHeader title={title} count={count} action={shortcut ? (
        <Typography.Text type="secondary" style={{ fontSize: 10, fontFamily: 'monospace', border: '1px solid', borderColor: 'inherit', borderRadius: 3, padding: '1px 4px', opacity: 0.5 }}>
          {shortcut}
        </Typography.Text>
      ) : undefined} />
      {children}
    </Card>
  );
}

function RiskRatingSection({
  fmNodeId,
  riskRating,
  loading,
  triggerAutoSave,
}: {
  fmNodeId: number;
  riskRating: ConceptInstanceData | null | undefined;
  loading: boolean;
  triggerAutoSave?: () => void;
}) {
  const { token: rrt } = theme.useToken();
  const { message } = App.useApp();
  const createRiskRating = useCreateRiskRating(triggerAutoSave);
  const updateRiskRating = useUpdateRiskRating(fmNodeId, triggerAutoSave);
  const deleteRiskRating = useDeleteRiskRating(fmNodeId, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const [severity, setSeverity] = useState('');
  const [occurrence, setOccurrence] = useState('');
  const [detection, setDetection] = useState('');
  const [note, setNote] = useState('');
  const { isSaved, markSaved } = useSavedFeedback();
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  useEffect(() => {
    setSeverity(String(riskRating?.attributes?.has_severity ?? profile.riskDefaults.severity));
    setOccurrence(String(riskRating?.attributes?.has_occurrence_level ?? profile.riskDefaults.occurrence));
    setDetection(String(riskRating?.attributes?.has_detection_level ?? profile.riskDefaults.detection));
    setNote(String(riskRating?.attributes?.risk_rating_note ?? ''));
  }, [riskRating, profile.riskDefaults]);

  const saveField = useCallback(async (updates: Record<string, string>) => {
    if (!riskRating) return;
    try {
      await updateRiskRating.mutateAsync({ nodeId: riskRating.node_id, updates });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update risk rating'));
    }
  }, [riskRating, updateRiskRating, markSaved]);

  const handleCreate = async () => {
    try {
      await createRiskRating.mutateAsync({
        failureModeNodeId: fmNodeId,
        severity: profile.riskDefaults.severity,
        occurrence: profile.riskDefaults.occurrence,
        detection: profile.riskDefaults.detection,
      });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create risk rating'));
    }
  };

  if (loading || profile.isLoading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (profile.error) {
    return <Alert type="error" showIcon message="Could not load safety profile metadata" description={profile.error.message} />;
  }

  if (!riskRating) {
    return (
      <div
        tabIndex={0}
        role="button"
        style={{
          border: `1px solid ${rrt.colorBorder}`,
          borderRadius: rrt.borderRadiusSM,
          padding: '6px 10px',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: rrt.colorText,
          background: rrt.colorBgContainer,
          outline: 'none',
        }}
        onClick={handleCreate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleCreate(); } }}
        onFocus={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = rrt.colorBorder; }}
        onBlur={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = rrt.colorBorderSecondary; }}
      >
        {createRiskRating.isPending ? <Spin size="small" /> : <PlusOutlined style={{ fontSize: 11, color: rrt.colorPrimary }} />}
        <span>Add Risk Rating</span>
      </div>
    );
  }

  const labelStyle: React.CSSProperties = { width: 90, flexShrink: 0, fontSize: 12, color: 'inherit', fontWeight: 600 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Property rows */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>Severity</span>
        <Select
          size="small"
          value={severity}
          options={profile.severityOptions}
          onChange={(v) => { setSeverity(v); saveField({ has_severity: v }); }}
          style={{ flex: 1, maxWidth: 300 }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>Occurrence</span>
        <Select
          size="small"
          value={occurrence}
          options={profile.occurrenceOptions}
          onChange={(v) => { setOccurrence(v); saveField({ has_occurrence_level: v }); }}
          style={{ flex: 1, maxWidth: 300 }}
          optionRender={(option) => (
            <div>
              <div>{option.label}</div>
              {(option.data as any).desc && <div style={{ fontSize: 11, color: rrt.colorTextTertiary, whiteSpace: 'normal', lineHeight: '1.3' }}>{(option.data as any).desc}</div>}
            </div>
          )}
          popupMatchSelectWidth={360}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>Detection</span>
        <Select
          size="small"
          value={detection}
          options={profile.detectionOptions}
          onChange={(v) => { setDetection(v); saveField({ has_detection_level: v }); }}
          style={{ flex: 1, maxWidth: 300 }}
          optionRender={(option) => (
            <div>
              <div>{option.label}</div>
              {(option.data as any).desc && <div style={{ fontSize: 11, color: rrt.colorTextTertiary, whiteSpace: 'normal', lineHeight: '1.3' }}>{(option.data as any).desc}</div>}
            </div>
          )}
          popupMatchSelectWidth={360}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ ...labelStyle, paddingTop: 6 }}>Note</span>
        <Input.TextArea
          size="small"
          autoSize={{ minRows: 2 }}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => saveField({ risk_rating_note: note })}
          placeholder="Rationale…"
          style={{ flex: 1, fontSize: 13 }}
        />
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
        <Space size={8}>
          <Tag color="purple" style={{ fontSize: 12 }}>RPN {String(riskRating.attributes?.risk_priority_number ?? 'N/A')}</Tag>
          <SavedBadge visible={isSaved} />
        </Space>
        <Space size={8}>
          <Button size="small" icon={<FileTextOutlined />} onClick={() => setInstructionsOpen(true)}>Review Instructions</Button>
          <DeleteWithPreview nodeId={riskRating.node_id} onConfirm={() => deleteRiskRating.mutateAsync(riskRating.node_id)}>
            {(openPreview) => (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={openPreview}>Delete</Button>
            )}
          </DeleteWithPreview>
        </Space>
      </div>
      <ReviewInstructionsModal open={instructionsOpen} onClose={() => setInstructionsOpen(false)} />
    </div>
  );
}

function TaskSection({
  namespace,
  fmNodeId,
  tasks,
  loading,
  ghostRef,
  workspaceKey,
  triggerAutoSave,
}: {
  namespace: string;
  fmNodeId: number;
  tasks: ConceptInstanceData[];
  loading: boolean;
  ghostRef?: React.RefObject<InputRef | null>;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
}) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const createTask = useCreateSafetyTask(namespace, workspaceKey ?? null, triggerAutoSave);
  const linkTask = useLinkSafetyTaskToFm(namespace, triggerAutoSave);
  const allTasksQuery = useAllSafetyTasks(namespace);
  const [linkingExisting, setLinkingExisting] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | undefined>();

  const linkedTaskIds = useMemo(() => new Set(tasks.map((task) => task.node_id)), [tasks]);
  const availableTasks = useMemo(
    () => (allTasksQuery.data ?? []).filter((task) => !linkedTaskIds.has(task.node_id)),
    [allTasksQuery.data, linkedTaskIds],
  );

  const handleCreate = async (name: string) => {
    try {
      await createTask.mutateAsync({
        failureModeNodeId: fmNodeId,
        name,
        description: name,
        status: profile.taskDefaults.status,
        type: profile.taskDefaults.type,
      });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create safety task'));
    }
  };

  const handleLinkExisting = async () => {
    if (selectedTaskId === undefined) return;
    try {
      await linkTask.mutateAsync({ failureModeNodeId: fmNodeId, safetyTaskNodeId: selectedTaskId });
      setSelectedTaskId(undefined);
      setLinkingExisting(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to link safety task'));
    }
  };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Link existing row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {linkingExisting ? (
          <Space wrap>
            <Select
              showSearch
              placeholder={availableTasks.length === 0 ? 'No reusable tasks available' : 'Link existing task'}
              value={selectedTaskId}
              onChange={setSelectedTaskId}
              options={availableTasks.map((task) => ({
                value: task.node_id,
                label: String(task.attributes?.has_name ?? `Safety Task ${task.node_id}`),
              }))}
              loading={allTasksQuery.isLoading}
              disabled={availableTasks.length === 0}
              style={{ width: 280 }}
              optionFilterProp="label"
            />
            <Button type="primary" onClick={handleLinkExisting} loading={linkTask.isPending} disabled={selectedTaskId === undefined}>Link</Button>
            <Button onClick={() => { setLinkingExisting(false); setSelectedTaskId(undefined); }}>Cancel</Button>
          </Space>
        ) : (
          <Button
            size="small"
            type="text"
            onClick={() => setLinkingExisting(true)}
            disabled={allTasksQuery.isLoading || availableTasks.length === 0}
          >
            Link Existing Task
          </Button>
        )}
      </div>

      {tasks.map((task) => (
        <Card key={task.node_id} size="small" styles={{ body: { padding: 14 } }}>
          <TaskEditorCard namespace={namespace} fmNodeId={fmNodeId} task={task} workspaceKey={workspaceKey} triggerAutoSave={triggerAutoSave} />
        </Card>
      ))}
      <GhostInputRow
        placeholder="Add task name…"
        onSubmit={handleCreate}
        loading={createTask.isPending}
        inputRef={ghostRef}
      />
    </div>
  );
}

function RequirementSection({
  namespace,
  fmNodeId,
  requirements,
  directRequirements,
  loading,
  workspaceKey,
  onNavigateToNode,
  triggerAutoSave,
}: {
  namespace: string;
  fmNodeId: number;
  requirements: ConceptInstanceData[];
  directRequirements: ConceptInstanceData[];
  loading: boolean;
  workspaceKey?: string | null;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  triggerAutoSave?: () => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const createRequirement = useCreateRequirement(namespace, workspaceKey ?? null, triggerAutoSave);
  const linkRequirement = useLinkRequirementToFm(namespace, triggerAutoSave);
  const unlinkDirectReq = useUnlinkDirectRequirementFromFm(triggerAutoSave);
  const allRequirementsQuery = useRequirements(namespace);
  const [linkingExisting, setLinkingExisting] = useState(false);
  const [ghostActive, setGhostActive] = useState(false);
  const [ghostReqId, setGhostReqId] = useState('');
  const [ghostName, setGhostName] = useState('');
  const [selectedRequirementId, setSelectedRequirementId] = useState<number | undefined>();

  const linkedRequirementIds = useMemo(() => new Set(requirements.map((r) => r.node_id)), [requirements]);
  const directRequirementIds = useMemo(() => new Set(directRequirements.map((r) => r.node_id)), [directRequirements]);
  const availableRequirements = useMemo(
    () => (allRequirementsQuery.data ?? []).filter((r) => !linkedRequirementIds.has(r.node_id)),
    [allRequirementsQuery.data, linkedRequirementIds],
  );

  const handleCreate = async () => {    if (!ghostReqId.trim() || !ghostName.trim()) return;
    try {
      const created = await createRequirement.mutateAsync({
        name: ghostName.trim(),
        reqId: ghostReqId.trim(),
        reqText: ghostName.trim(),
      });
      await linkRequirement.mutateAsync({ failureModeNodeId: fmNodeId, requirementNodeId: created.node_id });
      setGhostReqId('');
      setGhostName('');
      setGhostActive(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create requirement'));
    }
  };

  const handleLinkExisting = async () => {
    if (selectedRequirementId === undefined) return;
    try {
      await linkRequirement.mutateAsync({ failureModeNodeId: fmNodeId, requirementNodeId: selectedRequirementId });
      setSelectedRequirementId(undefined);
      setLinkingExisting(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to link requirement'));
    }
  };

  const resetGhost = () => { setGhostActive(false); setGhostReqId(''); setGhostName(''); };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Link existing row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
        <ImportedRequirementPicker fmNodeId={fmNodeId} linkedNodeIds={directRequirementIds} />
        {linkingExisting ? (
          <Space wrap>
            <Select
              showSearch
              placeholder={availableRequirements.length === 0 ? 'No reusable requirements available' : 'Link safety-internal requirement'}
              value={selectedRequirementId}
              onChange={setSelectedRequirementId}
              options={availableRequirements.map((r) => ({
                value: r.node_id,
                label: String(r.attributes?.req_id ?? r.attributes?.req_name ?? r.attributes?.has_name ?? `Requirement ${r.node_id}`),
              }))}
              loading={allRequirementsQuery.isLoading}
              disabled={availableRequirements.length === 0}
              style={{ width: 320 }}
              optionFilterProp="label"
            />
            <Button type="primary" onClick={handleLinkExisting} loading={linkRequirement.isPending} disabled={selectedRequirementId === undefined}>Link</Button>
            <Button onClick={() => { setLinkingExisting(false); setSelectedRequirementId(undefined); }}>Cancel</Button>
          </Space>
        ) : (
          <Button
            size="small"
            type="text"
            onClick={() => setLinkingExisting(true)}
            disabled={allRequirementsQuery.isLoading || availableRequirements.length === 0}
          >
            Link Safety Internal
          </Button>
        )}
      </div>

      {requirements.map((requirement) => (
        <Card key={requirement.node_id} size="small" styles={{ body: { padding: 14 } }}>
          <RequirementEditorCard namespace={namespace} fmNodeId={fmNodeId} requirement={requirement} workspaceKey={workspaceKey} triggerAutoSave={triggerAutoSave} />
        </Card>
      ))}

      {/* Multi-field ghost row for requirements */}
      {ghostActive ? (
        <div
          style={{
            border: `1px dashed ${token.colorBorder}`,
            borderRadius: token.borderRadiusSM,
            padding: '6px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: token.colorFillQuaternary,
          }}
        >
          <Input
            size="small"
            placeholder="Req ID"
            value={ghostReqId}
            onChange={(e) => setGhostReqId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') resetGhost(); }}
            autoFocus
            style={{ width: 90, fontSize: 12 }}
          />
          <Input
            size="small"
            placeholder="Name"
            value={ghostName}
            onChange={(e) => setGhostName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { void handleCreate(); }
              if (e.key === 'Escape') resetGhost();
            }}
            onBlur={() => { if (!ghostReqId.trim() && !ghostName.trim()) resetGhost(); }}
            style={{ flex: 1, fontSize: 12 }}
          />
          <Button
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            loading={createRequirement.isPending || linkRequirement.isPending}
            disabled={!ghostReqId.trim() || !ghostName.trim()}
            onMouseDown={(e) => { e.preventDefault(); void handleCreate(); }}
            style={{ height: 22 }}
          />
          <Button size="small" icon={<CloseOutlined />} onMouseDown={(e) => { e.preventDefault(); resetGhost(); }} style={{ height: 22 }} />
        </div>
      ) : (
        <div
          tabIndex={0}
          role="button"
          style={{
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadiusSM,
            padding: '6px 10px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: token.colorBgContainer,
            outline: 'none',
          }}
          onClick={() => setGhostActive(true)}
          onFocus={() => setGhostActive(true)}
        >
          <PlusOutlined style={{ fontSize: 11, color: token.colorPrimary }} />
          <span style={{ fontSize: 12, color: token.colorText }}>Add requirement…</span>
        </div>
      )}

      {/* Imported (cross-namespace) requirements */}
      {directRequirements.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Imported
          </Typography.Text>
          {directRequirements.map((r) => {
            const attrs = r.attributes as Record<string, unknown>;
            const elementId = String(attrs.id ?? attrs.elementId ?? '');
            const label = String(attrs.title ?? attrs.name ?? attrs.has_name ?? elementId ?? r.node_id);
            const badgeColor = r.concept.startsWith('need_') ? 'blue' : 'purple';
            const badgeText = r.concept.startsWith('need_') ? 'sphinx-needs' : 'sysml-v2';
            const asil = attrs.asil ?? attrs.Asil ?? attrs.ASIL;
            const status = attrs.status ?? attrs.Status;
            const typeName = attrs.type_name ?? attrs.typeName ?? attrs.Type_Name;
            return (
              <ShowInTreeTrigger
                key={r.node_id}
                homeTarget={{ nodeId: r.node_id, namespace: r.namespace, concept: r.concept }}
                onNavigate={onNavigateToNode}
                wrapperStyle={{ width: '100%' }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '8px 10px',
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadiusSM,
                    background: token.colorFillQuaternary,
                  }}
                >
                  {/* Header row: badge, ID, title, remove button */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color={badgeColor} style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>{badgeText}</Tag>
                    <span style={{ fontSize: 12, fontWeight: 500, flexShrink: 0 }}>{elementId}</span>
                    <span style={{ fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {label}
                    </span>
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<CloseOutlined style={{ fontSize: 10 }} />}
                      style={{ height: 20, width: 20, padding: 0, flexShrink: 0 }}
                      loading={unlinkDirectReq.isPending}
                      onClick={() => unlinkDirectReq.mutate({ failureModeNodeId: fmNodeId, requirementNodeId: r.node_id })}
                    />
                  </div>
                  {/* Attribute chips row */}
                  {(asil || status || typeName) ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingLeft: 2 }}>
                      {asil ? <Tag style={{ fontSize: 10, margin: 0 }} color="volcano">ASIL {String(asil)}</Tag> : null}
                      {status ? <Tag style={{ fontSize: 10, margin: 0 }}>{String(status)}</Tag> : null}
                      {typeName ? <Tag style={{ fontSize: 10, margin: 0 }} color="geekblue">{String(typeName)}</Tag> : null}
                    </div>
                  ) : null}
                </div>
              </ShowInTreeTrigger>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NoteSection({
  namespace,
  fmNodeId,
  notes,
  loading,
  ghostRef,
  workspaceKey,
  triggerAutoSave,
}: {
  namespace: string;
  fmNodeId: number;
  notes: ConceptInstanceData[];
  loading: boolean;
  ghostRef?: React.RefObject<InputRef | null>;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
}) {
  const { message } = App.useApp();
  const createNote = useCreateNoteForFm(namespace, workspaceKey ?? null, triggerAutoSave);

  const handleCreate = async (text: string) => {
    try {
      await createNote.mutateAsync({ failureModeNodeId: fmNodeId, noteText: text });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create note'));
    }
  };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {notes.map((note) => (
        <Card key={note.node_id} size="small" styles={{ body: { padding: 14 } }}>
          <NoteEditorCard namespace={namespace} note={note} parentNodeId={fmNodeId} workspaceKey={workspaceKey} triggerAutoSave={triggerAutoSave} />
        </Card>
      ))}
      <GhostInputRow
        placeholder="Add a note…"
        onSubmit={handleCreate}
        loading={createNote.isPending}
        inputRef={ghostRef}
      />
    </div>
  );
}

function PropagationSection({
  namespace,
  fmNodeId,
  propagations,
  loading,
  onNavigateToNode,
  onNavigateToReference,
}: {
  namespace: string;
  fmNodeId: number;
  propagations: { propagatesTo: PropagationMalfunctionData[]; propagatesFrom: PropagationMalfunctionData[] } | undefined;
  loading: boolean;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const allMalfunctionsQuery = useMalfunctions(namespace);
  const { add, remove } = usePropagationMutation(namespace);
  const [editing, setEditing] = useState(false);
  const [targetId, setTargetId] = useState<number | undefined>();
  const outgoing = propagations?.propagatesTo ?? [];
  const incoming = propagations?.propagatesFrom ?? [];

  const options = (allMalfunctionsQuery.data ?? [])
    .filter((malfunction) => malfunction.node_id !== fmNodeId)
    .map((malfunction) => ({
      value: malfunction.node_id,
      label: String(malfunction.attributes?.has_name ?? `Malfunction ${malfunction.node_id}`),
    }));

  const handleCreate = async () => {
    if (targetId === undefined) return;
    try {
      await add.mutateAsync({ sourceFmNodeId: fmNodeId, targetFmNodeId: targetId });
      setTargetId(undefined);
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to add propagation'));
    }
  };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (outgoing.length === 0 && incoming.length === 0) {
    return (
      <Space direction="vertical" size={12}>
        <Typography.Text type="secondary">No propagation links configured.</Typography.Text>
        {editing ? (
          <Space wrap>
            <Select showSearch optionFilterProp="label" value={targetId} onChange={setTargetId} options={options} style={{ width: 260 }} placeholder="Select target malfunction" />
            <Button type="primary" onClick={handleCreate} loading={add.isPending} disabled={targetId === undefined}>Create</Button>
            <Button icon={<CloseOutlined />} onClick={() => { setEditing(false); setTargetId(undefined); }}>Cancel</Button>
          </Space>
        ) : (
          <Button icon={<PlusOutlined />} onClick={() => setEditing(true)}>Add Propagation To…</Button>
        )}
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {editing ? (
          <Space wrap>
            <Select showSearch optionFilterProp="label" value={targetId} onChange={setTargetId} options={options} style={{ width: 260 }} placeholder="Select target malfunction" />
            <Button type="primary" onClick={handleCreate} loading={add.isPending} disabled={targetId === undefined}>Create</Button>
            <Button icon={<CloseOutlined />} onClick={() => { setEditing(false); setTargetId(undefined); }}>Cancel</Button>
          </Space>
        ) : (
          <Button icon={<PlusOutlined />} onClick={() => setEditing(true)}>Add Propagation To…</Button>
        )}
      </div>
      {outgoing.length > 0 ? (
        <div>
          <Typography.Text strong>Propagates To</Typography.Text>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {outgoing.map((failureMode) => {
              const name = String(failureMode.attributes?.has_name ?? `Malfunction ${failureMode.node_id}`);
              const asil = String(failureMode.attributes?.malfunction_asil ?? '');
              const refNavigate = failureMode.occursAtTarget && onNavigateToReference
                ? () => onNavigateToReference(
                    failureMode.node_id, failureMode.namespace, failureMode.concept,
                    failureMode.occursAtTarget!.node_id, failureMode.occursAtTarget!.namespace,
                  )
                : undefined;
              return (
                <ShowInTreeTrigger
                  key={failureMode.node_id}
                  homeTarget={{ nodeId: failureMode.node_id, namespace: failureMode.namespace, concept: failureMode.concept }}
                  referenceTarget={failureMode.occursAtTarget
                    ? { nodeId: failureMode.node_id, namespace: failureMode.namespace, concept: failureMode.concept }
                    : undefined}
                  onNavigate={onNavigateToNode}
                  onNavigateReference={refNavigate}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorFillQuaternary,
                    padding: '6px 10px',
                    borderRadius: token.borderRadiusSM,
                  }}>
                    <WarningOutlined style={{ color: token.colorError }} />
                    <span style={{ flex: 1 }}>{name}</span>
                    <span>node {failureMode.node_id}</span>
                    {asil && (
                      <Tag color={getAsilColor(asil)} style={{ margin: 0, fontSize: token.fontSizeSM }}>{asil}</Tag>
                    )}
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={() => remove.mutate({ sourceFmNodeId: fmNodeId, targetFmNodeId: failureMode.node_id })}
                    />
                  </div>
                </ShowInTreeTrigger>
              );
            })}
          </div>
        </div>
      ) : null}
      {incoming.length > 0 ? (
        <div>
          <Typography.Text strong>Propagates From</Typography.Text>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {incoming.map((failureMode) => {
              const name = String(failureMode.attributes?.has_name ?? `Malfunction ${failureMode.node_id}`);
              const asil = String(failureMode.attributes?.malfunction_asil ?? '');
              const refNavigate = failureMode.occursAtTarget && onNavigateToReference
                ? () => onNavigateToReference(
                    failureMode.node_id, failureMode.namespace, failureMode.concept,
                    failureMode.occursAtTarget!.node_id, failureMode.occursAtTarget!.namespace,
                  )
                : undefined;
              return (
                <ShowInTreeTrigger
                  key={failureMode.node_id}
                  homeTarget={{ nodeId: failureMode.node_id, namespace: failureMode.namespace, concept: failureMode.concept }}
                  referenceTarget={failureMode.occursAtTarget
                    ? { nodeId: failureMode.node_id, namespace: failureMode.namespace, concept: failureMode.concept }
                    : undefined}
                  onNavigate={onNavigateToNode}
                  onNavigateReference={refNavigate}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorFillQuaternary,
                    padding: '6px 10px',
                    borderRadius: token.borderRadiusSM,
                  }}>
                    <WarningOutlined style={{ color: token.colorWarning }} />
                    <span style={{ flex: 1 }}>{name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>node {failureMode.node_id}</Typography.Text>
                    {asil && (
                      <Tag color={getAsilColor(asil)} style={{ margin: 0, fontSize: token.fontSizeSM }}>{asil}</Tag>
                    )}
                  </div>
                </ShowInTreeTrigger>
              );
            })}
          </div>
        </div>
      ) : null}
    </Space>
  );
}

function ReviewSection({
  namespace,
  reviewedElementId,
  reviewItems,
  loading,
  workspaceKey,
  triggerAutoSave,
}: {
  namespace: string;
  reviewedElementId: number;
  reviewItems: ReviewItemData[];
  loading: boolean;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
}) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const createReviewItem = useCreateReviewItem(namespace, workspaceKey ?? null, triggerAutoSave);
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  const v = (verdict: string) => (r: ReviewItemData) => r.attributes?.reviewer_verdict === verdict;
  const s = (status: string) => (r: ReviewItemData) =>
    (r.attributes?.author_status ?? profile.authorStatusDefault) === status;
  const verdictTags = profile.verdicts.flatMap((verdict) => {
    if (!verdict.showAuthorStatusBreakdown) {
      return [{
        count: reviewItems.filter(v(verdict.value)).length,
        label: verdict.label,
        color: verdict.tag ?? verdict.color ?? 'default',
      }];
    }
    return profile.authorStatuses.map((status) => ({
      count: reviewItems.filter((item) => v(verdict.value)(item) && s(status.value)(item)).length,
      label: `${verdict.label} ${status.label.toLowerCase()}`,
      color: status.tag ?? status.color ?? 'default',
    }));
  });
  const statTags: { count: number; label: string; color: string }[] = [
    { count: reviewItems.filter(r => !r.attributes?.reviewer_verdict).length, label: 'Awaiting verdict', color: 'default' },
    ...verdictTags,
  ].filter(st => st.count > 0);

  const handleCreate = async () => {
    try {
      await createReviewItem.mutateAsync({ reviewerComment: '', reviewedElementId });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create review item'));
    }
  };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => { void handleCreate(); }}
          loading={createReviewItem.isPending}
        >
          Add review
        </Button>
        {statTags.map(s => (
          <Tag key={s.label} color={s.color} style={{ margin: 0 }}>{s.count} {s.label}</Tag>
        ))}
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<FileTextOutlined />}
          onClick={() => setInstructionsOpen(true)}
        >
          Review instructions
        </Button>
      </div>

      {reviewItems.map((reviewItem) => (
        <Card key={reviewItem.node_id} size="small" styles={{ body: { padding: 14 } }}>
          <ReviewItemEditorCard namespace={namespace} reviewedElementId={reviewedElementId} reviewItem={reviewItem} workspaceKey={workspaceKey} triggerAutoSave={triggerAutoSave} />
        </Card>
      ))}
      <ReviewInstructionsModal open={instructionsOpen} onClose={() => setInstructionsOpen(false)} />
    </div>
  );
}

/**
 * A ghost row that sits at the bottom of a section list. Clicking or pressing
 * Tab into it reveals an input field. Enter / blur-with-value commits; Escape cancels.
 */
function GhostInputRow({
  placeholder,
  onSubmit,
  loading,
  inputRef,
}: {
  placeholder: string;
  onSubmit: (value: string) => Promise<void>;
  loading?: boolean;
  inputRef?: React.RefObject<InputRef | null>;
}) {
  const { token } = theme.useToken();
  const [active, setActive] = useState(false);
  const [value, setValue] = useState('');

  const handleSubmit = async () => {
    if (!value.trim()) { setActive(false); return; }
    await onSubmit(value.trim());
    setValue('');
    setActive(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void handleSubmit(); }
    if (e.key === 'Escape') { setValue(''); setActive(false); }
  };

  return (
    <div
      tabIndex={active ? -1 : 0}
      style={{
        border: `1px solid ${active ? token.colorBorder : token.colorBorder}`,
        borderRadius: token.borderRadiusSM,
        padding: '6px 10px',
        cursor: active ? 'text' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        transition: 'border-color 0.15s',
        background: active ? token.colorFillQuaternary : token.colorBgContainer,
        outline: 'none',
      }}
      onClick={() => !active && setActive(true)}
      onFocus={() => !active && setActive(true)}
    >
      <PlusOutlined style={{ fontSize: 11, color: token.colorPrimary, flexShrink: 0 }} />
      {active ? (
        <>
          <Input
            ref={inputRef}
            size="small"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => { void handleSubmit(); }}
            autoFocus
            variant="borderless"
            style={{ padding: 0, fontSize: 12, flex: 1 }}
          />
          {value.trim() && (
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={loading}
              onMouseDown={(e) => { e.preventDefault(); void handleSubmit(); }}
              style={{ height: 20, fontSize: 11, flexShrink: 0 }}
            />
          )}
        </>
      ) : (
        <span style={{ fontSize: 12, color: token.colorText }}>{placeholder}</span>
      )}
    </div>
  );
}


function TaskEditorCard({ namespace, fmNodeId, task, workspaceKey, triggerAutoSave }: { namespace: string; fmNodeId: number; task: ConceptInstanceData; workspaceKey?: string | null; triggerAutoSave?: () => void }) {
  const { message } = App.useApp();
  const updateTask = useUpdateSafetyTask(namespace, workspaceKey ?? null, triggerAutoSave);
  const unlinkTask = useUnlinkSafetyTaskFromFm(namespace, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const [name, setName] = useState(String(task.attributes?.has_name ?? ''));
  const [description, setDescription] = useState(String(task.attributes?.task_description ?? ''));
  const [status, setStatus] = useState(String(task.attributes?.task_status ?? ''));
  const [type, setType] = useState(String(task.attributes?.task_type ?? ''));
  const [responsible, setResponsible] = useState(String(task.attributes?.task_responsible ?? ''));
  const [reference, setReference] = useState(String(task.attributes?.task_reference ?? ''));
  const { isSaved, markSaved } = useSavedFeedback();

  useEffect(() => {
    setName(String(task.attributes?.has_name ?? ''));
    setDescription(String(task.attributes?.task_description ?? ''));
    setStatus(String(task.attributes?.task_status ?? profile.taskDefaults.status));
    setType(String(task.attributes?.task_type ?? profile.taskDefaults.type));
    setResponsible(String(task.attributes?.task_responsible ?? ''));
    setReference(String(task.attributes?.task_reference ?? ''));
  }, [task, profile.taskDefaults]);

  const saveField = useCallback(async (updates: Record<string, string>) => {
    try {
      await updateTask.mutateAsync({ nodeId: task.node_id, fmNodeId, updates });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update safety task'));
    }
  }, [updateTask, task.node_id, fmNodeId, markSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div>
          <Typography.Text strong>Name</Typography.Text>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => saveField({ has_name: name })}
            onPressEnter={() => saveField({ has_name: name })}
            style={{ marginTop: 6 }}
          />
        </div>
        <div>
          <Typography.Text strong>Status</Typography.Text>
          <Select
            value={status}
            options={profile.taskStatusOptions}
            onChange={(v) => { setStatus(v); saveField({ task_status: v }); }}
            style={{ width: '100%', marginTop: 6 }}
          />
        </div>
        <div>
          <Typography.Text strong>Type</Typography.Text>
          <Select
            value={type}
            options={profile.taskTypeOptions}
            onChange={(v) => { setType(v); saveField({ task_type: v }); }}
            style={{ width: '100%', marginTop: 6 }}
          />
        </div>
      </div>
      <div>
        <Typography.Text strong>Description</Typography.Text>
        <Input.TextArea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => saveField({ task_description: description })}
          style={{ marginTop: 6 }}
        />
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div>
          <Typography.Text strong>Responsible</Typography.Text>
          <Input
            value={responsible}
            onChange={(e) => setResponsible(e.target.value)}
            onBlur={() => saveField({ task_responsible: responsible })}
            onPressEnter={() => saveField({ task_responsible: responsible })}
            style={{ marginTop: 6 }}
          />
        </div>
        <div>
          <Typography.Text strong>Reference</Typography.Text>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            onBlur={() => saveField({ task_reference: reference })}
            onPressEnter={() => saveField({ task_reference: reference })}
            style={{ marginTop: 6 }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SavedBadge visible={isSaved} />
        <Button
          danger
          icon={<DeleteOutlined />}
          onClick={() => {
            void unlinkTask.mutateAsync({ failureModeNodeId: fmNodeId, safetyTaskNodeId: task.node_id })
              .catch((err: unknown) => message.error(String((err as Error)?.message ?? 'Failed to unlink safety task')));
          }}
          loading={unlinkTask.isPending}
        >
          Unlink From Malfunction
        </Button>
      </div>
    </div>
  );
}

function RequirementEditorCard({ namespace, fmNodeId, requirement, workspaceKey, triggerAutoSave }: { namespace: string; fmNodeId: number; requirement: ConceptInstanceData; workspaceKey?: string | null; triggerAutoSave?: () => void }) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const updateRequirement = useUpdateRequirement(namespace, workspaceKey ?? null, triggerAutoSave);
  const unlinkRequirement = useUnlinkRequirementFromFm(namespace, triggerAutoSave);
  const deleteRequirement = useDeleteRequirement(namespace, workspaceKey ?? null, triggerAutoSave);
  const [reqId, setReqId] = useState(String(requirement.attributes?.req_id ?? ''));
  const [name, setName] = useState(String(requirement.attributes?.req_name ?? requirement.attributes?.has_name ?? ''));
  const [text, setText] = useState(String(requirement.attributes?.req_text ?? ''));
  const [asil, setAsil] = useState<string | undefined>(String(requirement.attributes?.req_asil ?? '') || undefined);
  const [link, setLink] = useState(String(requirement.attributes?.req_linked_to ?? ''));
  const { isSaved, markSaved } = useSavedFeedback();

  useEffect(() => {
    setReqId(String(requirement.attributes?.req_id ?? ''));
    setName(String(requirement.attributes?.req_name ?? requirement.attributes?.has_name ?? ''));
    setText(String(requirement.attributes?.req_text ?? ''));
    const asilValue = String(requirement.attributes?.req_asil ?? '');
    setAsil(asilValue || undefined);
    setLink(String(requirement.attributes?.req_linked_to ?? ''));
  }, [requirement]);

  const saveField = useCallback(async (updates: Record<string, string>) => {
    try {
      await updateRequirement.mutateAsync({ nodeId: requirement.node_id, updates });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update requirement'));
    }
  }, [updateRequirement, requirement.node_id, markSaved]);

  const asilOptions = useMemo<AsilSelectEntry[]>(
    () => buildAsilOptionGroups(profile.asilGroups),
    [profile.asilGroups],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div>
          <Typography.Text strong>Req ID</Typography.Text>
          <Input
            value={reqId}
            onChange={(e) => setReqId(e.target.value)}
            onBlur={() => saveField({ req_id: reqId })}
            onPressEnter={() => saveField({ req_id: reqId })}
            style={{ marginTop: 6 }}
          />
        </div>
        <div>
          <Typography.Text strong>Name</Typography.Text>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => saveField({ req_name: name })}
            onPressEnter={() => saveField({ req_name: name })}
            style={{ marginTop: 6 }}
          />
        </div>
        <div>
          <Typography.Text strong>ASIL</Typography.Text>
          <div style={{
            marginTop: 6,
            borderLeft: `3px solid ${asil ? getAsilHexColor(asil) : 'transparent'}`,
            borderRadius: 2,
            transition: 'border-color 0.2s',
          }}>
            <Select
              allowClear
              size="small"
              value={asil}
              onChange={(v) => { setAsil(v); saveField({ req_asil: v ?? '' }); }}
              options={asilOptions}
              placeholder="—"
              style={{ width: 110 }}
              optionRender={(option) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: (option.data as any).color ?? '#8c8c8c',
                  }} />
                  {option.label}
                </div>
              )}
            />
          </div>
        </div>
      </div>
      <div>
        <Typography.Text strong>Requirement Text</Typography.Text>
        <Input.TextArea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => saveField({ req_text: text })}
          style={{ marginTop: 6 }}
        />
      </div>
      <div>
        <Typography.Text strong>External Link</Typography.Text>
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onBlur={() => saveField({ req_linked_to: link })}
          onPressEnter={() => saveField({ req_linked_to: link })}
          style={{ marginTop: 6 }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SavedBadge visible={isSaved} />
        <Space>
          <Popconfirm
            title="Delete requirement?"
            description="This will permanently delete the requirement and unlink it from all malfunctions."
            onConfirm={() => {
              void deleteRequirement.mutateAsync(requirement.node_id)
                .catch((err: unknown) => message.error(String((err as Error)?.message ?? 'Failed to delete requirement')));
            }}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={deleteRequirement.isPending}
            >
              Delete
            </Button>
          </Popconfirm>
          <Button
            danger
            type="default"
            icon={<DisconnectOutlined />}
            onClick={() => {
              void unlinkRequirement.mutateAsync({ failureModeNodeId: fmNodeId, requirementNodeId: requirement.node_id })
                .catch((err: unknown) => message.error(String((err as Error)?.message ?? 'Failed to unlink requirement')));
            }}
            loading={unlinkRequirement.isPending}
          >
            Unlink From Malfunction
          </Button>
        </Space>
      </div>
    </div>
  );
}

function NoteEditorCard({ namespace, note, parentNodeId, workspaceKey, triggerAutoSave }: { namespace: string; note: ConceptInstanceData; parentNodeId?: number; workspaceKey?: string | null; triggerAutoSave?: () => void }) {
  const { message } = App.useApp();
  const updateNote = useUpdateSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);
  const deleteNote = useDeleteSafetyNote(namespace, workspaceKey ?? null, triggerAutoSave);
  const [text, setText] = useState(String(note.attributes?.note_text ?? ''));
  const { isSaved, markSaved } = useSavedFeedback();

  useEffect(() => {
    setText(String(note.attributes?.note_text ?? ''));
  }, [note]);

  const handleSave = async () => {
    try {
      await updateNote.mutateAsync({ nodeId: note.node_id, updates: { note_text: text } });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update note'));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Input.TextArea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleSave}
        placeholder="Note text"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SavedBadge visible={isSaved} />
        <DeleteWithPreview nodeId={note.node_id} onConfirm={() => deleteNote.mutateAsync({ nodeId: note.node_id, parentNodeId })}>
          {(openPreview) => <Button danger icon={<DeleteOutlined />} onClick={openPreview}>Delete</Button>}
        </DeleteWithPreview>
      </div>
    </div>
  );
}

function dot(color: string) {
  return <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block', marginRight: 6 }} />;
}

function ReviewItemEditorCard({ namespace, reviewedElementId, reviewItem, workspaceKey, triggerAutoSave }: { namespace: string; reviewedElementId: number; reviewItem: ReviewItemData; workspaceKey?: string | null; triggerAutoSave?: () => void }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const updateReviewItem = useUpdateReviewItem(namespace, workspaceKey ?? null, triggerAutoSave);
  const deleteReviewItem = useDeleteReviewItem(namespace, workspaceKey ?? null, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const verdictSegmentedOptions = profile.verdicts.map((option) => ({
    value: option.value,
    label: <>{dot(option.color ?? token.colorTextTertiary)}{option.label}</>,
  }));
  const authorStatusSegmentedOptions = profile.authorStatuses.map((option) => ({
    value: option.value,
    label: <>{dot(option.color ?? token.colorTextTertiary)}{option.label}</>,
  }));
  const resolutionStatus = profile.authorStatuses.find((option) => option.isResolution)?.value ?? '';
  const [reviewerVerdict, setReviewerVerdict] = useState(String(reviewItem.attributes?.reviewer_verdict ?? ''));
  const [reviewerComment, setReviewerComment] = useState(String(reviewItem.attributes?.reviewer_comment ?? ''));
  const [authorStatus, setAuthorStatus] = useState(String(reviewItem.attributes?.author_status ?? ''));
  const [authorComment, setAuthorComment] = useState(String(reviewItem.attributes?.author_comment ?? ''));
  const { isSaved, markSaved } = useSavedFeedback();

  useEffect(() => {
    setReviewerVerdict(String(reviewItem.attributes?.reviewer_verdict ?? ''));
    setReviewerComment(String(reviewItem.attributes?.reviewer_comment ?? ''));
    setAuthorStatus(String(reviewItem.attributes?.author_status ?? profile.authorStatusDefault));
    setAuthorComment(String(reviewItem.attributes?.author_comment ?? ''));
  }, [reviewItem, profile.authorStatusDefault]);

  const saveField = useCallback(async (updates: Record<string, string>) => {
    try {
      await updateReviewItem.mutateAsync({ nodeId: reviewItem.node_id, reviewedElementId, updates });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update review item'));
    }
  }, [updateReviewItem, reviewItem.node_id, reviewedElementId, markSaved]);

  const reviewerHasVerdict = reviewerVerdict.trim().length > 0;
  const isResolved = resolutionStatus.length > 0 && authorStatus === resolutionStatus;
  const authorHasContent = authorComment.trim().length > 0 || authorStatus !== profile.authorStatusDefault;
  // Start expanded if there's already author content, collapsed otherwise (PR-style)
  const [authorExpanded, setAuthorExpanded] = useState(authorHasContent);

  // If incoming data already has author content (e.g. switching items), keep expanded
  useEffect(() => {
    if (authorHasContent) setAuthorExpanded(true);
  }, [authorHasContent]);

  return (
    <DeleteWithPreview nodeId={reviewItem.node_id} onConfirm={() => deleteReviewItem.mutateAsync({ nodeId: reviewItem.node_id, reviewedElementId })}>
      {(openDeletePreview) => {
        const moreMenu: MenuProps = {
          items: [
            reviewerHasVerdict && resolutionStatus && !isResolved ? {
              key: 'resolve',
              label: 'Resolve',
              icon: <CheckOutlined />,
              onClick: () => {
                setAuthorStatus(resolutionStatus);
                void saveField({ author_status: resolutionStatus });
              },
            } : null,
            isResolved ? {
              key: 'reopen',
              label: 'Reopen',
              onClick: () => {
                setAuthorStatus(profile.authorStatusDefault);
                void saveField({ author_status: profile.authorStatusDefault });
              },
            } : null,
            { type: 'divider' as const },
            {
              key: 'delete',
              label: 'Delete',
              danger: true,
              icon: <DeleteOutlined />,
              onClick: openDeletePreview,
            },
          ].filter(Boolean) as MenuProps['items'],
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Reviewer row */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{
                width: 32, height: 32, borderRadius: 16,
                background: '#722ed1', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700, flexShrink: 0,
              }}>R</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                  <Typography.Text strong style={{ fontSize: 13 }}>Reviewer</Typography.Text>
                  {reviewItem.suspect && <Tag color="warning" style={{ margin: 0 }}>Suspect</Tag>}
                  <div style={{ flex: 1 }} />
                  <Dropdown menu={moreMenu} trigger={['click']}>
                    <Button size="small" type="text" icon={<MoreOutlined />} style={{ padding: '0 4px' }} />
                  </Dropdown>
                </div>
                <div style={{ marginTop: 6 }}>
                  <Segmented
                    value={reviewerVerdict || undefined}
                    onChange={(v: string) => { setReviewerVerdict(v); void saveField({ reviewer_verdict: v }); }}
                    options={verdictSegmentedOptions}
                  />
                </div>
                <Input.TextArea
                  autoSize={{ minRows: 1 }}
                  value={reviewerComment}
                  onChange={(e) => setReviewerComment(e.target.value)}
                  onBlur={() => void saveField({ reviewer_comment: reviewerComment })}
                  placeholder="Reviewer finding or acceptance statement"
                  style={{ marginTop: 6, fontSize: 13, resize: 'none' }}
                />
              </div>
            </div>

            {/* Author nested reply — PR-style: show "Comment" button until author engages */}
            {reviewerHasVerdict && !authorExpanded && (
              <div style={{ marginTop: 8, marginLeft: 42, paddingLeft: 14 }}>
                <Button
                  size="small"
                  onClick={() => setAuthorExpanded(true)}
                >
                  Comment
                </Button>
              </div>
            )}

            {reviewerHasVerdict && authorExpanded && (
              <div style={{
                marginTop: 10, marginLeft: 42,
                borderLeft: `2px solid ${token.colorBorderSecondary}`,
                paddingLeft: 14,
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 14,
                    background: token.colorPrimary, color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, flexShrink: 0,
                  }}>A</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                      <Typography.Text strong style={{ fontSize: 13 }}>Author</Typography.Text>
                      {authorComment.trim().length > 0 && <Tag style={{ margin: 0, fontSize: 11, letterSpacing: 0.3 }}>RESPONDED</Tag>}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <Segmented
                        value={authorStatus}
                        onChange={(v: string) => { setAuthorStatus(v); void saveField({ author_status: v }); }}
                        options={authorStatusSegmentedOptions}
                      />
                    </div>
                    <Input.TextArea
                      autoSize={{ minRows: 1 }}
                      value={authorComment}
                      onChange={(e) => setAuthorComment(e.target.value)}
                      onBlur={() => void saveField({ author_comment: authorComment })}
                      placeholder="Author response or rejection rationale"
                      style={{ marginTop: 6, fontSize: 13, resize: 'none' }}
                    />
                  </div>
                </div>
              </div>
            )}

            {isSaved && (
              <div style={{ marginTop: 8 }}>
                <SavedBadge visible={isSaved} />
              </div>
            )}
          </div>
        );
      }}
    </DeleteWithPreview>
  );
}

function ElementNoteEditorCard({
  note,
  parentNodeId,
  parentNamespace,
  updateNote,
  deleteNote,
}: {
  note: ConceptInstanceData;
  parentNodeId?: number;
  parentNamespace?: string;
  updateNote: ReturnType<typeof useUpdateSafetyNote>;
  deleteNote: ReturnType<typeof useDeleteSafetyNote>;
}) {
  const { message } = App.useApp();
  const [text, setText] = useState(String(note.attributes?.note_text ?? ''));
  const [expanded, setExpanded] = useState(false);
  const { isSaved, markSaved } = useSavedFeedback();

  useEffect(() => {
    setText(String(note.attributes?.note_text ?? ''));
  }, [note]);

  const noteText = String(note.attributes?.note_text ?? '');
  const isLong = noteText.length > 200 || noteText.split('\n').length > 3;

  const handleSave = async () => {
    try {
      await updateNote.mutateAsync({ nodeId: note.node_id, updates: { note_text: text } });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update note'));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteNote.mutateAsync({ nodeId: note.node_id, parentNodeId, parentNamespace });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to delete note'));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Input.TextArea
        rows={expanded || text.length > 200 ? 5 : 2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleSave}
        style={{ resize: 'none' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SavedBadge visible={isSaved} />
          {isLong && (
            <Button type="link" size="small" onClick={() => setExpanded(!expanded)} style={{ fontSize: 11, padding: 0 }}>
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}
        </div>
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={handleDelete} loading={deleteNote.isPending} />
      </div>
    </div>
  );
}

