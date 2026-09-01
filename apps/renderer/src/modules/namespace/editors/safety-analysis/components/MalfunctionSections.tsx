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
 * MalfunctionSections.tsx
 *
 * Self-contained section components extracted from CenterPanel tab bodies.
 * Each component owns its own data-fetching via the same hooks the tab bodies
 * already use, and accepts a minimal prop set:
 *
 *   { fmNodeId: number; namespace: string; workspaceKey: string | null; triggerAutoSave?: () => void }
 *
 * This allows the components to be used both inside CenterPanel's tab bodies
 * (as before) and inside MalfunctionTableView's modal overlay.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import {
  App,
  Button,
  Card,
  Dropdown,
  Input,
  Popover,
  Select,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { InputRef } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  LinkOutlined,
  MoreOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConceptInstanceData, ReviewItemData } from '@riacore/app-contracts';
import {
  useAllSafetyTasks,
  useDirectRequirementsForFm,
  useRequirementsForFm,
  useReviewItems,
  useRiskRating,
  useSafetyTasks,
} from '../hooks/useSafetyQueries';
import {
  useCreateRequirement,
  useCreateReviewItem,
  useCreateRiskRating,
  useCreateSafetyTask,
  useDeleteRiskRating,
  useLinkRequirementToFm,
  useLinkSafetyTaskToFm,
  useUnlinkDirectRequirementFromFm,
  useUpdateRequirement,
  useUpdateReviewItem,
  useUpdateRiskRating,
  useUpdateSafetyTask,
  useDeleteRequirement,
  useDeleteReviewItem,
  useUnlinkRequirementFromFm,
  useUnlinkSafetyTaskFromFm,
} from '../hooks/useSafetyMutations';
import { useRequirements } from '../hooks/useSafetyQueries';
import { getAsilColor, getAsilHexColor, ASIL_UNSET_LABEL, ASIL_UNSET_VALUE } from '../config/asilColors';
import { DeleteWithPreview } from './DeleteWithPreview';
import { ImportedRequirementPicker } from './ImportedRequirementPicker';
import { ShowInTreeTrigger } from '../../../../../components/ShowInTreeTrigger';
import { ReviewInstructionsModal } from './ReviewInstructionsModal';
import { ActionPriorityTag } from './ActionPriorityTag';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';
import { useSafetyMetamodel } from '../hooks/safetyMetamodelContext';

// ─────────────────────────────────────────────────────────────────────────────
// Shared prop interface
// ─────────────────────────────────────────────────────────────────────────────

export interface MalfunctionSectionProps {
  fmNodeId: number;
  namespace: string;
  workspaceKey: string | null;
  triggerAutoSave?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (mirrored from CenterPanel)
// ─────────────────────────────────────────────────────────────────────────────

function useSavedFeedback() {
  const [isSaved, setIsSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markSaved = useCallback(() => {
    setIsSaved(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsSaved(false), 2000);
  }, []);

  return { isSaved, markSaved };
}

function SavedBadge({ visible }: { visible: boolean }) {
  return (
    <Typography.Text
      type="secondary"
      style={{
        fontSize: 11,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.3s',
        pointerEvents: 'none',
      }}
    >
      Saved ✓
    </Typography.Text>
  );
}

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

  if (!active) {
    return (
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
        onClick={() => setActive(true)}
        onFocus={() => setActive(true)}
      >
        {loading ? <Spin size="small" /> : <PlusOutlined style={{ fontSize: 11, color: token.colorPrimary }} />}
        <span style={{ fontSize: 12, color: token.colorText }}>{placeholder}</span>
      </div>
    );
  }

  return (
    <Input
      ref={inputRef}
      autoFocus
      size="small"
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPressEnter={() => { void handleSubmit(); }}
      onBlur={() => { void handleSubmit(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { setValue(''); setActive(false); } }}
      suffix={loading ? <Spin size="small" /> : null}
      style={{ fontSize: 12 }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RiskRatingSection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Self-contained Risk Rating section.
 * Calls `useRiskRating(fmNodeId)` internally; requires only
 * `{ fmNodeId, namespace, workspaceKey, triggerAutoSave }`.
 *
 * Requirements: 5.4
 */
export function RiskRatingSection({ fmNodeId, workspaceKey: _workspaceKey, triggerAutoSave }: MalfunctionSectionProps) {
  const { token: rrt } = theme.useToken();
  const { message } = App.useApp();
  const riskRatingQuery = useRiskRating(fmNodeId);
  const riskRating = riskRatingQuery.data;
  const loading = riskRatingQuery.isLoading;

  const createRiskRating = useCreateRiskRating(triggerAutoSave);
  const updateRiskRating = useUpdateRiskRating(fmNodeId, triggerAutoSave);
  const deleteRiskRating = useDeleteRiskRating(fmNodeId, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  // SOTIF reduces the risk rating to a free-text residual-risk argument: no
  // Severity/Occurrence/Detection and no RPN (an ordinal score is not a SOTIF
  // acceptance argument). Keyed off the active metamodel so the same section
  // component serves both worlds.
  const isSotif = useSafetyMetamodel() === 'SOTIF_ANALYSIS';

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
  }, [riskRating, updateRiskRating, markSaved, message]);

  const handleCreate = async () => {
    try {
      // SOTIF: create a note-only risk rating — no Severity/Occurrence/Detection,
      // so no S/O/D or RPN is persisted or exported.
      await createRiskRating.mutateAsync(
        isSotif
          ? { failureModeNodeId: fmNodeId }
          : {
              failureModeNodeId: fmNodeId,
              severity: profile.riskDefaults.severity,
              occurrence: profile.riskDefaults.occurrence,
              detection: profile.riskDefaults.detection,
            },
      );
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create risk rating'));
    }
  };

  if (loading || profile.isLoading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  if (profile.error) {
    return <Typography.Text type="danger">Could not load safety profile metadata: {profile.error.message}</Typography.Text>;
  }

  if (!riskRating) {
    return (
      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        loading={createRiskRating.isPending}
        onClick={() => void handleCreate()}
        style={{ fontSize: 11, height: 22 }}
      >
        {isSotif ? 'Add Risk Rating Note' : 'Add Risk Rating'}
      </Button>
    );
  }

  const gridLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: rrt.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' };

  // SOTIF: note-only view — the residual-risk argument that points at the
  // scenario-based validation evidence. No Severity/Occurrence/Detection/RPN.
  if (isSotif) {
    return (
      <>
        <Card size="small" styles={{ body: { padding: 14 } }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={gridLabelStyle}>Risk Rating Note — residual-risk argument</div>
            <Input.TextArea
              size="small"
              autoSize={{ minRows: 4 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => saveField({ risk_rating_note: note })}
              placeholder="Summarize why the residual risk is sufficiently reduced and point to the validation evidence (scenario catalog, simulation / real-world results, runtime measures)…"
              style={{ fontSize: 13 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 8 }}>
              For SOTIF, Severity / Occurrence / Detection and the RPN are not used — an ordinal score is not a SOTIF acceptance argument. Only this free-text argument is kept.
            </Typography.Text>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${rrt.colorBorderSecondary}` }}>
              <SavedBadge visible={isSaved} />
              <DeleteWithPreview nodeId={riskRating.node_id} onConfirm={() => deleteRiskRating.mutateAsync(riskRating.node_id)}>
                {(openPreview) => (
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={openPreview}>Delete</Button>
                )}
              </DeleteWithPreview>
            </div>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      {/* Card matches the SafetyTaskSection / RequirementsSection row style:
          same padding, uppercase field labels, and a bordered-top action footer. */}
      <Card size="small" styles={{ body: { padding: 14 } }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Metadata grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px 12px' }}>
            <div>
              <div style={gridLabelStyle}>Severity</div>
              <Select
                size="small"
                value={severity}
                options={profile.severityOptions}
                onChange={(v) => { setSeverity(v); saveField({ has_severity: v }); }}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div style={gridLabelStyle}>Occurrence</div>
              <Select
                size="small"
                value={occurrence}
                options={profile.occurrenceOptions}
                onChange={(v) => { setOccurrence(v); saveField({ has_occurrence_level: v }); }}
                style={{ width: '100%' }}
                optionRender={(option) => (
                  <div>
                    <div>{option.label}</div>
                    {(option.data as any).desc && <div style={{ fontSize: 11, color: rrt.colorTextTertiary, whiteSpace: 'normal', lineHeight: '1.3' }}>{(option.data as any).desc}</div>}
                  </div>
                )}
                popupMatchSelectWidth={360}
              />
            </div>
            <div>
              <div style={gridLabelStyle}>Detection</div>
              <Select
                size="small"
                value={detection}
                options={profile.detectionOptions}
                onChange={(v) => { setDetection(v); saveField({ has_detection_level: v }); }}
                style={{ width: '100%' }}
                optionRender={(option) => (
                  <div>
                    <div>{option.label}</div>
                    {(option.data as any).desc && <div style={{ fontSize: 11, color: rrt.colorTextTertiary, whiteSpace: 'normal', lineHeight: '1.3' }}>{(option.data as any).desc}</div>}
                  </div>
                )}
                popupMatchSelectWidth={360}
              />
            </div>
          </div>

          {/* Note — full width below grid */}
          <div style={{ marginTop: 10 }}>
            <div style={gridLabelStyle}>Note</div>
            <Input.TextArea
              size="small"
              autoSize={{ minRows: 2 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => saveField({ risk_rating_note: note })}
              placeholder="Rationale…"
              style={{ fontSize: 13 }}
            />
          </div>

          {/* Actions — bordered-top footer matching the Safety Task / Requirement rows */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${rrt.colorBorderSecondary}` }}>
            <Space size={8}>
              <Tag color="purple" style={{ fontSize: 12, margin: 0 }}>RPN {String(riskRating.attributes?.risk_priority_number ?? 'N/A')}</Tag>
              <ActionPriorityTag
                actionPriority={profile.actionPriority}
                severity={severity}
                occurrence={occurrence}
                detection={detection}
              />
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
        </div>
      </Card>
      <ReviewInstructionsModal open={instructionsOpen} onClose={() => setInstructionsOpen(false)} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SafetyTaskSection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Self-contained Safety Task section.
 * Layout mirrors RequirementsSection: toolbar top-right, Card list, ghost add-row.
 *
 * Requirements: 5.1
 */
export function SafetyTaskSection({ fmNodeId, namespace, workspaceKey, triggerAutoSave }: MalfunctionSectionProps) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const tasksQuery = useSafetyTasks(fmNodeId);
  const tasks = tasksQuery.data ?? [];
  const loading = tasksQuery.isLoading;

  const createTask = useCreateSafetyTask(namespace, workspaceKey, triggerAutoSave);
  const linkTask = useLinkSafetyTaskToFm(namespace, triggerAutoSave);
  const allTasksQuery = useAllSafetyTasks(namespace);
  const [linkingExisting, setLinkingExisting] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | undefined>();

  // ── Ghost add-row state ───────────────────────────────────────────────────
  const [ghostActive, setGhostActive] = useState(false);
  const [ghostName, setGhostName] = useState('');
  const [ghostType, setGhostType] = useState('');
  const [ghostStatus, setGhostStatus] = useState('');
  const [ghostResponsible, setGhostResponsible] = useState('');
  const [ghostDescription, setGhostDescription] = useState('');
  const [ghostReference, setGhostReference] = useState('');

  useEffect(() => {
    setGhostType((current) => current || profile.taskDefaults.type);
    setGhostStatus((current) => current || profile.taskDefaults.status);
  }, [profile.taskDefaults]);

  const linkedTaskIds = useMemo(() => new Set(tasks.map((task) => task.node_id)), [tasks]);
  const availableTasks = useMemo(
    () => (allTasksQuery.data ?? []).filter((task) => !linkedTaskIds.has(task.node_id)),
    [allTasksQuery.data, linkedTaskIds],
  );

  const resetGhost = () => {
    setGhostActive(false);
    setGhostName('');
    setGhostType(profile.taskDefaults.type);
    setGhostStatus(profile.taskDefaults.status);
    setGhostResponsible('');
    setGhostDescription('');
    setGhostReference('');
  };

  const handleCreate = async () => {
    if (!ghostName.trim()) return;
    try {
      await createTask.mutateAsync({
        failureModeNodeId: fmNodeId,
        name: ghostName.trim(),
        description: ghostDescription.trim() || ghostName.trim(),
        status: ghostStatus,
        type: ghostType,
        responsible: ghostResponsible.trim() || undefined,
        reference: ghostReference.trim() || undefined,
      } as Parameters<typeof createTask.mutateAsync>[0]);
      resetGhost();
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
      {/* ── Toolbar: add + link actions top-right (matches RequirementsSection) ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => setGhostActive(true)}
          disabled={ghostActive}
          style={{ fontSize: 11, height: 22 }}
        >
          Add Task
        </Button>
        {linkingExisting ? (
          <Space wrap>
            <Select
              showSearch
              placeholder={availableTasks.length === 0 ? 'No reusable tasks available' : 'Search existing tasks…'}
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
            <Button size="small" type="primary" onClick={() => void handleLinkExisting()} loading={linkTask.isPending} disabled={selectedTaskId === undefined}>Link</Button>
            <Button size="small" onClick={() => { setLinkingExisting(false); setSelectedTaskId(undefined); }}>Cancel</Button>
          </Space>
        ) : (
          <Button
            size="small"
            type="dashed"
            icon={<LinkOutlined />}
            onClick={() => setLinkingExisting(true)}
            disabled={allTasksQuery.isLoading || availableTasks.length === 0}
            style={{ fontSize: 11, height: 22 }}
          >
            Link Existing Task
          </Button>
        )}
      </div>

      {/* ── Task list ─────────────────────────────────────────────────────── */}
      {tasks.map((task) => (
        <Card key={task.node_id} size="small" styles={{ body: { padding: 14 } }}>
          <TaskListRow
            namespace={namespace}
            fmNodeId={fmNodeId}
            task={task}
            workspaceKey={workspaceKey}
            triggerAutoSave={triggerAutoSave}
          />
        </Card>
      ))}

      {/* ── Ghost add-row ─────────────────────────────────────────────────── */}
      {ghostActive ? (
        <div
          style={{
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
            background: token.colorBgContainer,
            boxShadow: `0 1px 4px ${token.colorBorder}44`,
          }}
        >
          {/* Name — borderless title input (required — the Save button stays
              disabled until this has text, since a task must have a name). */}
          <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Task name <span style={{ color: token.colorError }}>*</span>
          </div>
          <Input.TextArea
            autoFocus
            size="small"
            placeholder="Add task name"
            value={ghostName}
            onChange={(e) => setGhostName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') resetGhost();
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (ghostName.trim()) void handleCreate(); }
            }}
            autoSize={{ minRows: 1 }}
            style={{ fontSize: 13, fontWeight: 600, resize: 'none', border: 'none', borderBottom: `1px solid ${token.colorBorderSecondary}`, borderRadius: 0, padding: '0 0 8px 0', boxShadow: 'none', background: 'transparent' }}
          />

          {/* Metadata grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', paddingTop: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Type</div>
              <Select
                size="small"
                value={ghostType}
                options={profile.taskTypeOptions}
                onChange={setGhostType}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</div>
              <Select
                size="small"
                value={ghostStatus}
                options={profile.taskStatusOptions}
                onChange={setGhostStatus}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Responsible</div>
              <Input
                size="small"
                placeholder="—"
                value={ghostResponsible}
                onChange={(e) => setGhostResponsible(e.target.value)}
                style={{ fontSize: 13 }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reference</div>
              <Input
                size="small"
                placeholder="—"
                value={ghostReference}
                onChange={(e) => setGhostReference(e.target.value)}
                onPressEnter={() => { if (ghostName.trim()) void handleCreate(); }}
                style={{ fontSize: 13 }}
              />
            </div>
          </div>

          {/* Description — full width */}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description</div>
            <Input.TextArea
              size="small"
              placeholder="Optional — describe the task intent, scope, or acceptance criteria."
              value={ghostDescription}
              onChange={(e) => setGhostDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') resetGhost(); }}
              autoSize={{ minRows: 2 }}
              style={{ fontSize: 13 }}
            />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
            <Button size="small" onClick={() => resetGhost()}>Cancel</Button>
            <Tooltip title={ghostName.trim() ? undefined : 'Enter a task name to save'}>
              <Button
                size="small"
                type="primary"
                loading={createTask.isPending}
                disabled={!ghostName.trim()}
                onMouseDown={(e) => { e.preventDefault(); void handleCreate(); }}
              >
                Save
              </Button>
            </Tooltip>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RequirementsSection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Self-contained Requirements section.
 * Calls `useRequirementsForFm` and `useDirectRequirementsForFm` internally.
 *
 * Requirements: 5.2
 */
export function RequirementsSection({
  fmNodeId,
  namespace,
  workspaceKey,
  triggerAutoSave,
  onNavigateToNode,
}: MalfunctionSectionProps & {
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const requirementsQuery = useRequirementsForFm(fmNodeId);
  const directRequirementsQuery = useDirectRequirementsForFm(fmNodeId);
  const requirements = requirementsQuery.data ?? [];
  const directRequirements = directRequirementsQuery.data ?? [];
  const loading = requirementsQuery.isLoading || directRequirementsQuery.isLoading;

  const createRequirement = useCreateRequirement(namespace, workspaceKey, triggerAutoSave);
  const linkRequirement = useLinkRequirementToFm(namespace, triggerAutoSave);
  const unlinkDirectReq = useUnlinkDirectRequirementFromFm(triggerAutoSave);
  const allRequirementsQuery = useRequirements(namespace);
  const [linkingExisting, setLinkingExisting] = useState(false);
  const [ghostActive, setGhostActive] = useState(false);
  const [ghostReqId, setGhostReqId] = useState('');
  const [ghostName, setGhostName] = useState('');
  const [ghostAsil, setGhostAsil] = useState<string | undefined>(undefined);
  const [ghostDescription, setGhostDescription] = useState('');
  const [selectedRequirementId, setSelectedRequirementId] = useState<number | undefined>();

  // Grouped ASIL options with color tags — same dropdown used for malfunctions.
  const asilOptions = useMemo(
    () => [
      { label: ASIL_UNSET_LABEL, value: ASIL_UNSET_VALUE },
      ...profile.asilGroups.map((group) => ({
        label: group.label,
        options: group.options.map((value) => ({
          label: <Tag color={getAsilColor(value)} style={{ margin: 0 }}>{value}</Tag>,
          value,
        })),
      })),
    ],
    [profile.asilGroups],
  );

  const linkedRequirementIds = useMemo(() => new Set(requirements.map((r) => r.node_id)), [requirements]);
  const directRequirementIds = useMemo(() => new Set(directRequirements.map((r) => r.node_id)), [directRequirements]);
  const availableRequirements = useMemo(
    () => (allRequirementsQuery.data ?? []).filter((r) => !linkedRequirementIds.has(r.node_id)),
    [allRequirementsQuery.data, linkedRequirementIds],
  );

  const handleCreate = async () => {
    if (!ghostReqId.trim() || !ghostName.trim()) return;
    try {
      const created = await createRequirement.mutateAsync({
        name: ghostName.trim(),
        reqId: ghostReqId.trim(),
        reqText: ghostDescription.trim(),
        asil: ghostAsil,
        fmNodeId,
      });
      await linkRequirement.mutateAsync({ failureModeNodeId: fmNodeId, requirementNodeId: created.node_id });
      resetGhost();
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

  const resetGhost = () => { setGhostActive(false); setGhostReqId(''); setGhostName(''); setGhostAsil(undefined); setGhostDescription(''); };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Link existing row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
        <ImportedRequirementPicker fmNodeId={fmNodeId} linkedNodeIds={directRequirementIds} malfunctionNamespace={namespace} />
        <Popover
          open={linkingExisting}
          onOpenChange={(v) => { setLinkingExisting(v); if (!v) setSelectedRequirementId(undefined); }}
          trigger="click"
          placement="bottomRight"
          title="Link Safety-Internal Requirement"
          content={
            <div style={{ width: 340 }}>
              <Select
                showSearch
                placeholder={availableRequirements.length === 0 ? 'No reusable requirements available' : 'Select a requirement…'}
                value={selectedRequirementId}
                onChange={setSelectedRequirementId}
                options={availableRequirements.map((r) => {
                  const a = r.attributes ?? {};
                  const reqId = String(a.req_id ?? `Requirement ${r.node_id}`);
                  const name = String(a.req_name ?? a.has_name ?? '');
                  const asil = String(a.req_asil ?? '');
                  return {
                    value: r.node_id,
                    // Combined string keeps type-to-search working across all fields.
                    label: [reqId, name, asil].filter(Boolean).join('  '),
                    reqId,
                    reqName: name,
                    reqAsil: asil,
                  };
                })}
                optionRender={(option) => {
                  const reqId = String(option.data.reqId ?? '');
                  const reqName = String(option.data.reqName ?? '');
                  const reqAsil = String(option.data.reqAsil ?? '');
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, flexShrink: 0 }}>{reqId}</span>
                      <span style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: token.colorTextSecondary }}>
                        {reqName}
                      </span>
                      {reqAsil && (
                        <Tag color={getAsilColor(reqAsil)} style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>{reqAsil}</Tag>
                      )}
                    </div>
                  );
                }}
                loading={allRequirementsQuery.isLoading}
                disabled={availableRequirements.length === 0}
                style={{ width: '100%', marginBottom: 8 }}
                optionFilterProp="label"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="small" onClick={() => { setLinkingExisting(false); setSelectedRequirementId(undefined); }}>Cancel</Button>
                <Button size="small" type="primary" onClick={handleLinkExisting} loading={linkRequirement.isPending} disabled={selectedRequirementId === undefined}>Link</Button>
              </div>
            </div>
          }
        >
          <Button
            size="small"
            type="dashed"
            icon={<LinkOutlined />}
            disabled={allRequirementsQuery.isLoading || availableRequirements.length === 0}
            style={{ fontSize: 11, height: 22 }}
          >
            Link Safety Internal
          </Button>
        </Popover>
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => setGhostActive(true)}
          disabled={ghostActive}
          style={{ fontSize: 11, height: 22 }}
        >
          Add requirement
        </Button>
      </div>

      {requirements.map((requirement) => (
        <Card key={requirement.node_id} size="small" styles={{ body: { padding: 14 } }}>
          <RequirementEditorCard
            namespace={namespace}
            fmNodeId={fmNodeId}
            requirement={requirement}
            workspaceKey={workspaceKey}
            triggerAutoSave={triggerAutoSave}
            onNavigateToNode={onNavigateToNode}
          />
        </Card>
      ))}

      {/* Multi-field ghost form for creating a new requirement */}
      {ghostActive && (
        <div
          style={{
            border: `1px dashed ${token.colorBorder}`,
            borderRadius: token.borderRadiusSM,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: token.colorFillQuaternary,
          }}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Input
              size="small"
              placeholder="Req ID"
              value={ghostReqId}
              onChange={(e) => setGhostReqId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') resetGhost(); }}
              autoFocus
              style={{ width: 120, fontSize: 12 }}
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
              style={{ flex: 1, fontSize: 12 }}
            />
            <Select
              size="small"
              allowClear
              placeholder="ASIL"
              value={ghostAsil}
              onChange={(v) => setGhostAsil(v)}
              options={asilOptions}
              style={{ width: 110 }}
            />
          </div>
          <Input.TextArea
            size="small"
            placeholder="Description"
            value={ghostDescription}
            onChange={(e) => setGhostDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') resetGhost(); }}
            autoSize={{ minRows: 2, maxRows: 5 }}
            style={{ fontSize: 12 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button size="small" onClick={() => resetGhost()}>Cancel</Button>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={createRequirement.isPending || linkRequirement.isPending}
              disabled={!ghostReqId.trim() || !ghostName.trim()}
              onClick={() => void handleCreate()}
            >
              Create
            </Button>
          </div>
        </div>
      )}

      {/* Imported (cross-namespace) requirements */}
      {directRequirements.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Imported
          </Typography.Text>
          {directRequirements.map((r) => {
            const attrs = r.attributes as Record<string, unknown>;
            const elementId = String(attrs.id ?? attrs.elementId ?? attrs.req_id ?? '');
            const title: string = String(attrs.title ?? attrs.name ?? attrs.has_name ?? elementId ?? r.node_id);
            // sphinx-needs body text lives in 'content'; safety-authored requirements use 'req_text'
            const bodyText: string = String(attrs.content ?? attrs.description ?? attrs.req_text ?? '').trim();
            const badgeColor = r.concept.startsWith('need_') ? 'blue' : 'purple';
            const badgeText = r.concept.startsWith('need_') ? 'sphinx-needs' : 'sysml-v2';
            const asil = (attrs.asil ?? attrs.Asil ?? attrs.ASIL) as any;
            const status = (attrs.status ?? attrs.Status) as any;
            const typeName = (attrs.type_name ?? attrs.typeName ?? attrs.Type_Name) as any;
            return (
              <Card
                key={r.node_id}
                size="small"
                style={{ width: '100%' }}
                styles={{ body: { padding: 14 } }}
              >
                {/* Header row: source badge + ID + title + kebab (Show in Tree) + Unlink */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <Tag color={badgeColor} style={{ fontSize: 10, margin: 0, flexShrink: 0, marginTop: 1 }}>{badgeText}</Tag>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* ID above name — ID small + muted, Name on next line with emphasis */}
                    {elementId && (
                      <Typography.Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace', display: 'block' }}>
                        {elementId}
                      </Typography.Text>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Typography.Text strong style={{ fontSize: 13 }}>{String(title)}</Typography.Text>
                      {/* Kebab — Show in Tree with established shortcut hint, next to the name */}
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [
                            {
                              key: 'showInTree',
                              label: 'Show in Tree',
                              onClick: () => onNavigateToNode?.(r.node_id, r.namespace, r.concept),
                            },
                          ],
                        }}
                      >
                        <Button
                          size="small"
                          type="text"
                          icon={<MoreOutlined />}
                          style={{ padding: '0 4px', height: 20, width: 20, color: token.colorTextTertiary, flexShrink: 0 }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Dropdown>
                    </div>
                    {/* Body text */}
                    {bodyText && (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12, display: 'block', marginTop: 4, lineHeight: '1.5', wordBreak: 'break-word' }}
                      >
                        {bodyText}
                      </Typography.Text>
                    )}
                    {/* Attribute chips */}
                    {(Boolean(asil) || Boolean(status) || Boolean(typeName)) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                        {asil ? <Tag style={{ fontSize: 10, margin: 0 }} color="volcano">ASIL {String(asil)}</Tag> : null}
                        {status ? <Tag style={{ fontSize: 10, margin: 0 }}>{String(status)}</Tag> : null}
                        {typeName ? <Tag style={{ fontSize: 10, margin: 0 }} color="geekblue">{String(typeName)}</Tag> : null}
                      </div>
                    )}
                  </div>
                  {/* Unlink */}
                  <Button
                    size="small"
                    type="text"
                    danger
                    loading={unlinkDirectReq.isPending}
                    onClick={(e) => { e.stopPropagation(); unlinkDirectReq.mutate({ failureModeNodeId: fmNodeId, requirementNodeId: r.node_id }); }}
                    style={{ height: 20, padding: '0 4px', fontSize: 11, flexShrink: 0, marginTop: 1 }}
                  >
                    Unlink
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ReviewSection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Self-contained Review section.
 * Calls `useReviewItems(fmNodeId)` internally.
 *
 * Requirements: 5.3
 */
export function ReviewSection({ fmNodeId, namespace, workspaceKey, triggerAutoSave }: MalfunctionSectionProps) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const reviewItemsQuery = useReviewItems(fmNodeId);
  const reviewItems = reviewItemsQuery.data ?? [];
  const loading = reviewItemsQuery.isLoading;

  const createReviewItem = useCreateReviewItem(namespace, workspaceKey, triggerAutoSave);
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
      await createReviewItem.mutateAsync({ reviewerComment: '', reviewedElementId: fmNodeId });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create review item'));
    }
  };

  if (loading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 24 }}>
      {/* ── Toolbar: status summary on the left, add action on the right
          (matches SafetyTaskSection / RequirementsSection). ─────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {statTags.map(st => (
          <Tag key={st.label} color={st.color} style={{ margin: 0 }}>{st.count} {st.label}</Tag>
        ))}
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => { void handleCreate(); }}
          loading={createReviewItem.isPending}
          style={{ fontSize: 11, height: 22 }}
        >
          Add review
        </Button>
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
          <ReviewItemEditorCard
            namespace={namespace}
            reviewedElementId={fmNodeId}
            reviewItem={reviewItem}
            workspaceKey={workspaceKey}
            triggerAutoSave={triggerAutoSave}
          />
        </Card>
      ))}
      <ReviewInstructionsModal open={instructionsOpen} onClose={() => setInstructionsOpen(false)} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskListRow — compact read/edit row matching the mockup design
// ─────────────────────────────────────────────────────────────────────────────

/** Status → badge colour mapping */
const STATUS_COLOR: Record<string, string> = {
  'Done': '#22c55e',
  'finished': '#22c55e',
  'Confirmed': '#22c55e',
  'In Progress': '#3b82f6',
  'started': '#3b82f6',
  'In Review': '#8b5cf6',
  'open': '#6b7280',
  'To Do': '#6b7280',
  'see Ticket': '#f59e0b',
};

function getStatusColor(status: string): string {
  return STATUS_COLOR[status] ?? '#6b7280';
}

function TaskListRow({
  namespace,
  fmNodeId,
  task,
  workspaceKey,
  triggerAutoSave,
}: {
  namespace: string;
  fmNodeId: number;
  task: ConceptInstanceData;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const updateTask = useUpdateSafetyTask(namespace, workspaceKey ?? null, triggerAutoSave);
  const unlinkTask = useUnlinkSafetyTaskFromFm(namespace, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const [editing, setEditing] = useState(false);

  // ── Derived display values ────────────────────────────────────────────────
  const taskName = String(task.attributes?.has_name ?? '');
  const taskType = String(task.attributes?.task_type ?? profile.taskDefaults.type);
  const taskStatus = String(task.attributes?.task_status ?? profile.taskDefaults.status);
  const taskResponsible = String(task.attributes?.task_responsible ?? '');

  // ── Edit state ────────────────────────────────────────────────────────────
  const [editName, setEditName] = useState(taskName);
  const [editType, setEditType] = useState(taskType);
  const [editStatus, setEditStatus] = useState(taskStatus);
  const [editResponsible, setEditResponsible] = useState(taskResponsible);
  const [editDescription, setEditDescription] = useState(String(task.attributes?.task_description ?? ''));
  const [editReference, setEditReference] = useState(String(task.attributes?.task_reference ?? ''));
  const [saving, setSaving] = useState(false);

  // Sync when task data refreshes
  useEffect(() => {
    setEditName(String(task.attributes?.has_name ?? ''));
    setEditType(String(task.attributes?.task_type ?? profile.taskDefaults.type));
    setEditStatus(String(task.attributes?.task_status ?? profile.taskDefaults.status));
    setEditResponsible(String(task.attributes?.task_responsible ?? ''));
    setEditDescription(String(task.attributes?.task_description ?? ''));
    setEditReference(String(task.attributes?.task_reference ?? ''));
  }, [task, profile.taskDefaults]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateTask.mutateAsync({
        nodeId: task.node_id,
        fmNodeId,
        updates: {
          has_name: editName.trim(),
          task_type: editType,
          task_status: editStatus,
          task_responsible: editResponsible.trim(),
          task_description: editDescription.trim(),
          task_reference: editReference.trim(),
        },
      });
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update task'));
    } finally {
      setSaving(false);
    }
  };

  const taskDescription = String(task.attributes?.task_description ?? '');
  const taskReference = String(task.attributes?.task_reference ?? '');
  const statusColor = getStatusColor(taskStatus);

  // ── Collapsed (list) view ──────────────────────────────────────────────────
  if (!editing) {
    return (
      <div
        className="task-list-row"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
        // show action buttons on hover via CSS class toggling
      >
        {/* Status dot — aligned with the first line */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor,
            flexShrink: 0,
            marginTop: 5,
            boxShadow: `0 0 0 2px ${statusColor}22`,
          }}
        />

        {/* Main content area */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {/* Row 1: name */}
          <Typography.Text strong style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '18px' }}>
            {taskName || <Typography.Text type="secondary" style={{ fontWeight: 400 }}>Unnamed</Typography.Text>}
          </Typography.Text>

          {/* Row 2: description (only when present) */}
          {taskDescription && (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {taskDescription}
            </Typography.Text>
          )}

          {/* Row 3: meta tags — type / responsible / reference */}
          {(taskType || taskResponsible || taskReference) && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginTop: 1 }}>
              {taskType && (
                <Tag style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px', borderRadius: 3 }}>
                  <span style={{ color: token.colorTextQuaternary, marginRight: 3 }}>type</span>{taskType}
                </Tag>
              )}
              {taskResponsible && (
                <Tag style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px', borderRadius: 3 }}>
                  <span style={{ color: token.colorTextQuaternary, marginRight: 3 }}>owner</span>{taskResponsible}
                </Tag>
              )}
              {taskReference && (
                <Tag style={{ fontSize: 11, margin: 0, lineHeight: '18px', padding: '0 6px', borderRadius: 3 }}>
                  <span style={{ color: token.colorTextQuaternary, marginRight: 3 }}>ref</span>{taskReference}
                </Tag>
              )}
            </div>
          )}
        </div>

        {/* Status badge */}
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '1px 7px',
            borderRadius: 10,
            background: `${statusColor}1a`,
            color: statusColor,
            border: `1px solid ${statusColor}55`,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            alignSelf: 'flex-start',
            marginTop: 1,
            letterSpacing: '0.01em',
          }}
        >
          {taskStatus}
        </span>

        {/* Edit button */}
        <Button
          type="text"
          size="small"
          icon={<EditOutlined />}
          onClick={() => setEditing(true)}
          style={{ padding: '0 4px', color: token.colorTextTertiary, alignSelf: 'flex-start' }}
        />

        {/* Unlink button */}
        <Button
          type="text"
          size="small"
          danger
          onClick={() => unlinkTask.mutate({ failureModeNodeId: fmNodeId, safetyTaskNodeId: task.node_id })}
          loading={unlinkTask.isPending}
          style={{ padding: '0 4px', alignSelf: 'flex-start' }}
        >
          Unlink
        </Button>
      </div>
    );
  }

  // ── Expanded (edit) view ───────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ── Name field — full-width title input (required — the Save button
          stays disabled until this has text). ─── */}
      <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Task name <span style={{ color: token.colorError }}>*</span>
      </div>
      <Input.TextArea
        value={editName}
        onChange={(e) => setEditName(e.target.value)}
        placeholder="Task name"
        autoSize={{ minRows: 1 }}
        style={{ fontSize: 13, fontWeight: 600, resize: 'none', border: 'none', borderBottom: `1px solid ${token.colorBorderSecondary}`, borderRadius: 0, padding: '0 0 8px 0', boxShadow: 'none', background: 'transparent' }}
        autoFocus
      />

      {/* ── Metadata grid ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', paddingTop: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Type</div>
          <Select
            size="small"
            value={editType}
            options={profile.taskTypeOptions}
            onChange={setEditType}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</div>
          <Select
            size="small"
            value={editStatus}
            options={profile.taskStatusOptions}
            onChange={setEditStatus}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Responsible</div>
          <Input
            size="small"
            value={editResponsible}
            onChange={(e) => setEditResponsible(e.target.value)}
            placeholder="—"
            style={{ fontSize: 13 }}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reference</div>
          <Input
            size="small"
            value={editReference}
            onChange={(e) => setEditReference(e.target.value)}
            placeholder="—"
            style={{ fontSize: 13 }}
          />
        </div>
      </div>

      {/* ── Description — full width below grid ───────────────────────── */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: token.colorTextTertiary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description</div>
        <Input.TextArea
          size="small"
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          placeholder="Optional — describe the task intent, scope, or acceptance criteria."
          autoSize={{ minRows: 2 }}
          style={{ fontSize: 13 }}
        />
      </div>

      {/* ── Actions ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, paddingTop: 10, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
        <Button size="small" onClick={() => setEditing(false)}>Cancel</Button>
        <Tooltip title={editName.trim() ? undefined : 'Enter a task name to save'}>
          <Button size="small" type="primary" loading={saving} disabled={!editName.trim()} onClick={() => void handleSave()}>Save</Button>
        </Tooltip>
      </div>
    </div>
  );
}

function TaskEditorCard({
  namespace,
  fmNodeId,
  task,
  workspaceKey,
  triggerAutoSave,
}: {
  namespace: string;
  fmNodeId: number;
  task: ConceptInstanceData;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
}) {
  const { message } = App.useApp();
  const updateTask = useUpdateSafetyTask(namespace, workspaceKey ?? null, triggerAutoSave);
  const unlinkTask = useUnlinkSafetyTaskFromFm(namespace, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const [name, setName] = useState(String(task.attributes?.has_name ?? ''));
  const [description, setDescription] = useState(String(task.attributes?.task_description ?? ''));
  const [status, setStatus] = useState(String(task.attributes?.task_status ?? ''));
  const [type, setType] = useState(String(task.attributes?.task_type ?? ''));
  const { isSaved, markSaved } = useSavedFeedback();

  useEffect(() => {
    setName(String(task.attributes?.has_name ?? ''));
    setDescription(String(task.attributes?.task_description ?? ''));
    setStatus(String(task.attributes?.task_status ?? profile.taskDefaults.status));
    setType(String(task.attributes?.task_type ?? profile.taskDefaults.type));
  }, [task, profile.taskDefaults]);

  const saveField = async (updates: Record<string, string>) => {
    try {
      await updateTask.mutateAsync({ nodeId: task.node_id, updates });
      markSaved();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update safety task'));
    }
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          size="small"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Task name"
          style={{ flex: 1 }}
          onBlur={() => { if (name.trim()) saveField({ has_name: name.trim() }); }}
          onPressEnter={() => { if (name.trim()) saveField({ has_name: name.trim() }); }}
        />
        <SavedBadge visible={isSaved} />
        <Button
          size="small"
          type="text"
          danger
          onClick={() => unlinkTask.mutate({ failureModeNodeId: fmNodeId, safetyTaskNodeId: task.node_id })}
        >
          Unlink
        </Button>
      </div>
      <Input.TextArea
        size="small"
        autoSize={{ minRows: 2 }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => saveField({ task_description: description.trim() })}
        placeholder="Task description"
        style={{ fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Select
          size="small"
          value={status}
          options={profile.taskStatusOptions}
          onChange={(v) => { setStatus(v); saveField({ task_status: v }); }}
          style={{ flex: 1 }}
        />
        <Select
          size="small"
          value={type}
          options={profile.taskTypeOptions}
          onChange={(v) => { setType(v); saveField({ task_type: v }); }}
          style={{ flex: 1 }}
        />
      </div>
    </Space>
  );
}

function RequirementEditorCard({
  namespace,
  fmNodeId,
  requirement,
  workspaceKey,
  triggerAutoSave,
  onNavigateToNode,
}: {
  namespace: string;
  fmNodeId: number;
  requirement: ConceptInstanceData;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const updateRequirement = useUpdateRequirement(namespace, workspaceKey ?? null, triggerAutoSave);
  const unlinkRequirement = useUnlinkRequirementFromFm(namespace, triggerAutoSave);
  const deleteRequirement = useDeleteRequirement(namespace, workspaceKey ?? null, triggerAutoSave);
  const [reqId, setReqId] = useState(String(requirement.attributes?.req_id ?? ''));
  const [reqName, setReqName] = useState(String(requirement.attributes?.req_name ?? requirement.attributes?.has_name ?? ''));
  const [asil, setAsil] = useState<string | undefined>(String(requirement.attributes?.req_asil ?? '') || undefined);
  const [reqText, setReqText] = useState(String(requirement.attributes?.req_text ?? ''));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Grouped ASIL options with color tags — same dropdown used in the create form.
  const asilOptions = useMemo(
    () => [
      { label: ASIL_UNSET_LABEL, value: ASIL_UNSET_VALUE },
      ...profile.asilGroups.map((group) => ({
        label: group.label,
        options: group.options.map((value) => ({
          label: <Tag color={getAsilColor(value)} style={{ margin: 0 }}>{value}</Tag>,
          value,
        })),
      })),
    ],
    [profile.asilGroups],
  );

  useEffect(() => {
    setReqId(String(requirement.attributes?.req_id ?? ''));
    setReqName(String(requirement.attributes?.req_name ?? requirement.attributes?.has_name ?? ''));
    setAsil(String(requirement.attributes?.req_asil ?? '') || undefined);
    setReqText(String(requirement.attributes?.req_text ?? ''));
  }, [requirement]);

  const handleSave = async () => {
    if (!reqId.trim() || !reqName.trim()) return;
    setSaving(true);
    try {
      await updateRequirement.mutateAsync({
        nodeId: requirement.node_id,
        fmNodeId,
        updates: {
          req_id: reqId.trim(),
          req_name: reqName.trim(),
          req_asil: asil ?? '',
          req_text: reqText.trim(),
        },
      });
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update requirement'));
    } finally {
      setSaving(false);
    }
  };

  const displayId = String(requirement.attributes?.req_id ?? '');
  const displayName = String(requirement.attributes?.req_name ?? requirement.attributes?.has_name ?? '');
  const displayAsil = String(requirement.attributes?.req_asil ?? '');
  const displayText = String(requirement.attributes?.req_text ?? '');

  // ── Collapsed (read) view ─────────────────────────────────────────────────
  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Tag color="green" style={{ fontSize: 10, margin: 0, flexShrink: 0, marginTop: 1 }}>safety-internal</Tag>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* ID above name: ID small + muted, Name on next line with emphasis */}
          {displayId && (
            <Typography.Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace', display: 'block' }}>
              {displayId}
            </Typography.Text>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              {displayName || <Typography.Text type="secondary" style={{ fontStyle: 'italic', fontWeight: 400 }}>Unnamed</Typography.Text>}
            </Typography.Text>
            {/* Kebab — Show in Tree */}
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'showInTree',
                    label: 'Show in Tree',
                  },
                ],
                onClick: ({ key }) => {
                  if (key === 'showInTree') onNavigateToNode?.(requirement.node_id, requirement.namespace, requirement.concept);
                },
              }}
            >
              <Button
                size="small"
                type="text"
                icon={<MoreOutlined />}
                style={{ padding: '0 4px', height: 20, width: 20, color: token.colorTextTertiary, flexShrink: 0 }}
              />
            </Dropdown>
          </div>
          {displayText && (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginTop: 4, lineHeight: '1.5', wordBreak: 'break-word' }}
            >
              {displayText}
            </Typography.Text>
          )}
          {displayAsil && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <Tag color={getAsilColor(displayAsil)} style={{ fontSize: 10, margin: 0 }}>ASIL {displayAsil}</Tag>
            </div>
          )}
        </div>
        <Space size={2} style={{ flexShrink: 0, marginTop: 1 }}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined style={{ fontSize: 11 }} />}
            onClick={() => setEditing(true)}
            style={{ height: 20, width: 20, padding: 0, color: token.colorTextSecondary }}
          />
          <Button
            size="small"
            type="text"
            danger
            onClick={() => unlinkRequirement.mutate({ failureModeNodeId: fmNodeId, requirementNodeId: requirement.node_id })}
            style={{ height: 20, padding: '0 4px', fontSize: 11 }}
          >
            Unlink
          </Button>
          <DeleteWithPreview nodeId={requirement.node_id} onConfirm={() => deleteRequirement.mutateAsync(requirement.node_id)}>
            {(openPreview) => (
              <Button size="small" type="text" danger onClick={openPreview} style={{ height: 20, padding: '0 4px', fontSize: 11 }}>Delete</Button>
            )}
          </DeleteWithPreview>
        </Space>
      </div>
    );
  }

  // ── Expanded (edit) view — mirrors the create form ─────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Input
          size="small"
          value={reqId}
          onChange={(e) => setReqId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
          placeholder="Req ID"
          style={{ width: 120, fontSize: 12, fontFamily: 'monospace' }}
          autoFocus
        />
        <Input
          size="small"
          value={reqName}
          onChange={(e) => setReqName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { void handleSave(); }
            if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="Name"
          style={{ flex: 1, fontSize: 12 }}
        />
        <Select
          size="small"
          allowClear
          placeholder="ASIL"
          value={asil}
          onChange={(v) => setAsil(v)}
          options={asilOptions}
          style={{ width: 110 }}
        />
      </div>
      <Input.TextArea
        size="small"
        autoSize={{ minRows: 2, maxRows: 5 }}
        value={reqText}
        onChange={(e) => setReqText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
        placeholder="Description"
        style={{ fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button size="small" onClick={() => setEditing(false)}>Cancel</Button>
        <Button size="small" type="primary" loading={saving} disabled={!reqId.trim() || !reqName.trim()} onClick={() => void handleSave()}>Save</Button>
      </div>
    </div>
  );
}

function ReviewItemEditorCard({
  namespace,
  reviewedElementId,
  reviewItem,
  workspaceKey,
  triggerAutoSave,
}: {
  namespace: string;
  reviewedElementId: number;
  reviewItem: ReviewItemData;
  workspaceKey?: string | null;
  triggerAutoSave?: () => void;
}) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const updateReviewItem = useUpdateReviewItem(namespace, workspaceKey ?? null, triggerAutoSave);
  const deleteReviewItem = useDeleteReviewItem(namespace, workspaceKey ?? null, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const verdictSegmentedOptions = profile.verdicts.map((option) => ({
    value: option.value,
    label: <><span style={{ width: 8, height: 8, borderRadius: 4, background: option.color ?? token.colorTextTertiary, display: 'inline-block', marginRight: 6 }} />{option.label}</>,
  }));
  const authorStatusSegmentedOptions = profile.authorStatuses.map((option) => ({
    value: option.value,
    label: <><span style={{ width: 8, height: 8, borderRadius: 4, background: option.color ?? token.colorTextTertiary, display: 'inline-block', marginRight: 6 }} />{option.label}</>,
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
  }, [updateReviewItem, reviewItem.node_id, reviewedElementId, markSaved, message]);

  const reviewerHasVerdict = reviewerVerdict.trim().length > 0;
  const isResolved = resolutionStatus.length > 0 && authorStatus === resolutionStatus;
  const authorHasContent = authorComment.trim().length > 0 || authorStatus !== profile.authorStatusDefault;
  const [authorExpanded, setAuthorExpanded] = useState(authorHasContent);

  useEffect(() => {
    if (authorHasContent) setAuthorExpanded(true);
  }, [authorHasContent]);

  return (
    <DeleteWithPreview nodeId={reviewItem.node_id} onConfirm={() => deleteReviewItem.mutateAsync({ nodeId: reviewItem.node_id, reviewedElementId })}>
      {(openDeletePreview) => {
        const moreMenuItems = [
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
        ].filter(Boolean);

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
                  <Dropdown menu={{ items: moreMenuItems as import('antd').MenuProps['items'] }} trigger={['click']}>
                    <Button size="small" type="text" icon={<MoreOutlined />} style={{ padding: '0 4px' }} />
                  </Dropdown>
                </div>
                <div style={{ marginTop: 6 }}>
                  <Segmented
                    value={reviewerVerdict || undefined}
                    onChange={(v) => { setReviewerVerdict(String(v)); void saveField({ reviewer_verdict: String(v) }); }}
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

            {/* Author nested reply */}
            {reviewerHasVerdict && !authorExpanded && (
              <div style={{ marginTop: 8, marginLeft: 42, paddingLeft: 14 }}>
                <Button size="small" onClick={() => setAuthorExpanded(true)}>Comment</Button>
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
                        onChange={(v) => { setAuthorStatus(String(v)); void saveField({ author_status: String(v) }); }}
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
