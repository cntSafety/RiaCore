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
import { Tag, Space, Button, Spin, Tooltip, Select, Input, App } from 'antd';
import { PlusOutlined, SafetyOutlined, CheckSquareOutlined, SwapOutlined, CloseOutlined, CheckOutlined, FileTextOutlined, BookOutlined, TagOutlined } from '@ant-design/icons';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useRiskRating, useSafetyTasks, usePropagations, useMalfunctions, useRequirementsForFm, useRequirements, useNotesForFm, useDirectRequirementsForFm } from '../hooks/useSafetyQueries';
import { useCreateRiskRating, useCreateSafetyTask, usePropagationMutation, useLinkRequirementToFm, useCreateRequirement, useCreateNoteForFm, useDeleteRiskRating, useDeleteSafetyTask, useDeleteSafetyNote, useUnlinkDirectRequirementFromFm } from '../hooks/useSafetyMutations';
import { ImportedRequirementPicker } from './ImportedRequirementPicker';
import { DeleteWithPreview } from './DeleteWithPreview';
import { api } from '../../../../../api/riacore';
import { useQueryClient } from '@tanstack/react-query';
import { getAsilColor, buildAsilOptionGroups } from '../config/asilColors';
import { useTagsForElement } from '../../../../../hooks/useTags';
import { useTags } from '../../../../../hooks/useTags';
import { useTagMutations } from '../../../../../hooks/useTagMutations';
import { TagChip } from './TagChip';
import { ActionPriorityTag } from './ActionPriorityTag';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';

interface MalfunctionExpandedRowProps {
  fmNodeId: number;
  namespace: string;
  onSelectElement: (nodeId: number, concept: string) => void;
}

export function MalfunctionExpandedRow({ fmNodeId, namespace, onSelectElement }: MalfunctionExpandedRowProps) {
  const { data: riskRating, isLoading: rrLoading } = useRiskRating(fmNodeId);
  const { data: tasks, isLoading: tasksLoading } = useSafetyTasks(fmNodeId);
  const { data: propagations, isLoading: propLoading } = usePropagations(fmNodeId);
  const { data: requirements, isLoading: reqLoading } = useRequirementsForFm(fmNodeId);
  const { data: directRequirements, isLoading: directReqLoading } = useDirectRequirementsForFm(fmNodeId);
  const { data: notes, isLoading: notesLoading } = useNotesForFm(fmNodeId);

  const deleteRR = useDeleteRiskRating(fmNodeId);
  const deleteTask = useDeleteSafetyTask(namespace);
  const deleteNote = useDeleteSafetyNote(namespace);
  const { remove: removeProp } = usePropagationMutation(namespace);
  const unlinkDirectReq = useUnlinkDirectRequirementFromFm();

  const isLoading = rrLoading || tasksLoading || propLoading || reqLoading || directReqLoading || notesLoading;

  if (isLoading) {
    return <div style={{ padding: '8px 16px' }}><Spin size="small" /></div>;
  }

  const rrAttrs = riskRating?.attributes;
  const taskList = tasks ?? [];
  const propTo = propagations?.propagatesTo ?? [];
  const propFrom = propagations?.propagatesFrom ?? [];
  const reqList = requirements ?? [];
  const directReqList = directRequirements ?? [];
  const noteList = notes ?? [];
  const directReqLinkedIds = new Set(directReqList.map((r: ConceptInstanceData) => r.node_id));

  return (
    <div style={{ padding: '6px 16px 10px 48px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}
      onClick={(e) => e.stopPropagation()}>
      {/* Risk Rating row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <SafetyOutlined style={{ color: '#cf1322', fontSize: 11 }} />
        <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Risk Rating</span>
        {riskRating ? (
          <EditableRiskRating riskRating={riskRating} fmNodeId={fmNodeId} onDelete={() => deleteRR.mutateAsync(riskRating.node_id)} />
        ) : (
          <InlineAddRiskRating fmNodeId={fmNodeId} />
        )}
      </div>

      {/* Safety Tasks row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <CheckSquareOutlined style={{ color: '#52c41a', fontSize: 11 }} />
        <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Tasks</span>
        {taskList.length > 0 ? (
          <Space size={4} wrap>
            {taskList.map((t: ConceptInstanceData) => (
              <EditableTaskTag key={t.node_id} task={t} fmNodeId={fmNodeId} namespace={namespace}
                onDelete={() => deleteTask.mutateAsync({ nodeId: t.node_id, fmNodeId })} />
            ))}
          </Space>
        ) : null}
        <InlineAddTask fmNodeId={fmNodeId} namespace={namespace} />
      </div>

      {/* Propagation row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <SwapOutlined style={{ color: '#d46b08', fontSize: 11 }} />
        <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Propagation</span>
        {(propTo.length > 0 || propFrom.length > 0) ? (
          <Space size={4} wrap>
            {propTo.map((p: ConceptInstanceData) => (
              <Tag key={p.node_id} color="volcano" closable
                onClose={(e) => { e.preventDefault(); removeProp.mutate({ sourceFmNodeId: fmNodeId, targetFmNodeId: p.node_id }); }}
                style={{ fontSize: 11, margin: 0, cursor: 'pointer' }}
                onClick={() => onSelectElement(p.node_id, 'malfunction')}>
                → {String(p.attributes?.has_name ?? '—')}
              </Tag>
            ))}
            {propFrom.map((p: ConceptInstanceData) => (
              <Tag key={p.node_id} color="gold" closable
                onClose={(e) => { e.preventDefault(); removeProp.mutate({ sourceFmNodeId: p.node_id, targetFmNodeId: fmNodeId }); }}
                style={{ fontSize: 11, margin: 0, cursor: 'pointer' }}
                onClick={() => onSelectElement(p.node_id, 'malfunction')}>
                ← {String(p.attributes?.has_name ?? '—')}
              </Tag>
            ))}
          </Space>
        ) : null}
        <InlineAddPropagation fmNodeId={fmNodeId} namespace={namespace} />
      </div>

      {/* Requirements row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <BookOutlined style={{ color: '#1677ff', fontSize: 11 }} />
        <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Requirements</span>
        {reqList.length > 0 ? (
          <Space size={4} wrap>
            {reqList.map((r: ConceptInstanceData) => (
              <EditableRequirementTag key={r.node_id} req={r} namespace={namespace} fmNodeId={fmNodeId} />
            ))}
          </Space>
        ) : null}
        <InlineAddRequirement fmNodeId={fmNodeId} namespace={namespace} />
      </div>

      {/* Imported requirements row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <BookOutlined style={{ color: '#722ed1', fontSize: 11 }} />
        <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Imported</span>
        {directReqList.length > 0 ? (
          <Space size={4} wrap>
            {directReqList.map((r: ConceptInstanceData) => {
              const attrs = r.attributes as Record<string, unknown>;
              const elementId = String(attrs.id ?? attrs.elementId ?? '');
              const label = String(attrs.title ?? attrs.name ?? attrs.has_name ?? elementId ?? r.node_id);
              const badgeColor = r.concept.startsWith('need_') ? 'blue' : 'purple';
              const badgeText = r.concept.startsWith('need_') ? 'sn' : 'sysml';
              return (
                <Tag
                  key={r.node_id}
                  color="default"
                  closable
                  onClose={(e) => {
                    e.preventDefault();
                    unlinkDirectReq.mutate({ failureModeNodeId: fmNodeId, requirementNodeId: r.node_id });
                  }}
                  style={{ fontSize: 11, margin: 0 }}
                >
                  <Tag color={badgeColor} style={{ fontSize: 10, margin: '0 4px 0 0', padding: '0 4px' }}>{badgeText}</Tag>
                  {elementId ? `${elementId}: ${label}` : label}
                </Tag>
              );
            })}
          </Space>
        ) : null}
        <ImportedRequirementPicker fmNodeId={fmNodeId} linkedNodeIds={directReqLinkedIds} malfunctionNamespace={namespace} />
      </div>

      {/* Safety Notes row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <FileTextOutlined style={{ color: '#8c8c8c', fontSize: 11 }} />
        <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Notes</span>
        {noteList.length > 0 ? (
          <Space size={4} wrap>
            {noteList.map((n: ConceptInstanceData) => (
              <EditableNoteTag key={n.node_id} note={n} namespace={namespace} fmNodeId={fmNodeId}
                onDelete={() => deleteNote.mutateAsync({ nodeId: n.node_id, parentNodeId: fmNodeId })} />
            ))}
          </Space>
        ) : null}
        <InlineAddNote fmNodeId={fmNodeId} namespace={namespace} />
      </div>

      {/* Tags row */}
      <TagsRow fmNodeId={fmNodeId} namespace={namespace} />
    </div>
  );
}

// ── Editable Risk Rating (click tags to edit) ───────────────────────────────

function EditableRiskRating({ riskRating, fmNodeId, onDelete }: { riskRating: ConceptInstanceData; fmNodeId: number; onDelete: () => void }) {
  const { message } = App.useApp();
  const attrs = riskRating.attributes;
  const profile = useSafetyProfileMetadata();
  const qc = useQueryClient();
  const [editField, setEditField] = useState<string | null>(null);
  const savingRef = useRef(false);

  const save = useCallback(async (key: string, value: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await api.safety.updateRiskRating(riskRating.node_id, { [key]: value });
      qc.invalidateQueries({ queryKey: ['safety.riskRating', fmNodeId] });
      qc.invalidateQueries({ queryKey: ['safety.malfunction', fmNodeId] });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Update failed'));
    } finally {
      savingRef.current = false;
    }
    setEditField(null);
  }, [riskRating.node_id, fmNodeId, qc, message]);

  const renderSelect = (key: string, options: { value: string; label: string }[], color: string) => {
    const val = String(attrs?.[key] ?? '');
    if (editField === key) {
      return <Select size="small" defaultValue={val} onChange={(v) => save(key, v)} onBlur={() => setEditField(null)}
        options={options} style={{ width: 110, fontSize: 11 }} autoFocus open />;
    }
    return (
      <Tooltip title={key.replace(/_/g, ' ')}>
        <Tag color={color} style={{ fontSize: 11, margin: 0, cursor: 'pointer' }} onClick={() => setEditField(key)}>
          {val || '—'}
        </Tag>
      </Tooltip>
    );
  };

  const noteVal = String(attrs?.risk_rating_note ?? '');
  const [noteEdit, setNoteEdit] = useState(noteVal);

  return (
    <Space size={4} wrap>
      {renderSelect('has_severity', profile.severityOptions, 'red')}
      {renderSelect('has_occurrence_level', profile.occurrenceOptions, 'orange')}
      {renderSelect('has_detection_level', profile.detectionOptions, 'blue')}
      <Tag style={{ fontSize: 11, margin: 0, fontWeight: 600 }}>RPN {String(attrs?.risk_priority_number ?? '—')}</Tag>
      <ActionPriorityTag
        actionPriority={profile.actionPriority}
        severity={String(attrs?.has_severity ?? '')}
        occurrence={String(attrs?.has_occurrence_level ?? '')}
        detection={String(attrs?.has_detection_level ?? '')}
      />
      {editField === 'risk_rating_note' ? (
        <Input size="small" defaultValue={noteVal} style={{ width: 160, fontSize: 11 }} autoFocus
          onBlur={(e) => save('risk_rating_note', e.target.value)}
          onPressEnter={(e) => save('risk_rating_note', (e.target as HTMLInputElement).value)} />
      ) : (
        <span style={{ color: '#595959', fontStyle: 'italic', cursor: 'pointer' }}
          onClick={() => { setNoteEdit(noteVal); setEditField('risk_rating_note'); }}>
          {noteVal || '(add note)'}
        </span>
      )}
      <DeleteWithPreview nodeId={riskRating.node_id} onConfirm={onDelete}>
        {(openPreview) => (
          <CloseOutlined onClick={openPreview} style={{ fontSize: 10, color: '#ff4d4f', cursor: 'pointer', marginLeft: 2 }} />
        )}
      </DeleteWithPreview>
    </Space>
  );
}

// ── Editable Task Tag (click to edit name/status) ───────────────────────────

function EditableTaskTag({ task, fmNodeId, namespace, onDelete }: { task: ConceptInstanceData; fmNodeId: number; namespace: string; onDelete: () => void }) {
  const { message } = App.useApp();
  const attrs = task.attributes;
  const profile = useSafetyProfileMetadata();
  const status = String(attrs?.task_status ?? '');
  const name = String(attrs?.has_name ?? '—');
  const desc = String(attrs?.task_description ?? '');
  const qc = useQueryClient();
  const [editField, setEditField] = useState<string | null>(null);
  const savingRef = useRef(false);

  const color = status === 'Done' || status === 'Confirmed' ? 'green'
    : status === 'In Progress' || status === 'started' ? 'blue' : 'default';

  const save = useCallback(async (key: string, value: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await api.safety.updateSafetyTask(task.node_id, { [key]: value });
      qc.invalidateQueries({ queryKey: ['safety.safetyTasks', fmNodeId] });
      qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Update failed'));
    } finally {
      savingRef.current = false;
    }
    setEditField(null);
  }, [task.node_id, fmNodeId, namespace, qc, message]);

  if (editField === 'has_name') {
    return (
      <Input size="small" defaultValue={name} style={{ width: 160, fontSize: 11 }} autoFocus
        onBlur={(e) => save('has_name', e.target.value)}
        onPressEnter={(e) => save('has_name', (e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditField(null); }} />
    );
  }
  if (editField === 'task_status') {
    return (
      <Select size="small" defaultValue={status} onChange={(v) => save('task_status', v)} onBlur={() => setEditField(null)}
        options={profile.taskStatusOptions} style={{ width: 120, fontSize: 11 }} autoFocus open />
    );
  }
  if (editField === 'task_description') {
    return (
      <Input size="small" defaultValue={desc} style={{ width: 260, fontSize: 11 }} autoFocus
        onBlur={(e) => save('task_description', e.target.value)}
        onPressEnter={(e) => save('task_description', (e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditField(null); }} />
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <Tag color={color} style={{ fontSize: 11, margin: 0, cursor: 'pointer' }} onClick={() => setEditField('has_name')}>
        {name}
      </Tag>
      <Tag style={{ fontSize: 10, margin: 0, cursor: 'pointer', padding: '0 4px' }} onClick={() => setEditField('task_status')}>
        {status}
      </Tag>
      <span style={{ color: '#595959', fontStyle: 'italic', cursor: 'pointer', fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onClick={() => setEditField('task_description')}>
        {desc || '(add description)'}
      </span>
      <DeleteWithPreview nodeId={task.node_id} onConfirm={onDelete}>
        {(openPreview) => (
          <CloseOutlined onClick={openPreview} style={{ fontSize: 9, color: '#ff4d4f', cursor: 'pointer' }} />
        )}
      </DeleteWithPreview>
    </span>
  );
}

// ── Editable Note Tag (click to edit text) ──────────────────────────────────

function EditableNoteTag({ note, namespace, fmNodeId, onDelete }: { note: ConceptInstanceData; namespace: string; fmNodeId: number; onDelete: () => void }) {
  const { message } = App.useApp();
  const text = String(note.attributes?.note_text ?? '');
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const savingRef = useRef(false);

  const save = useCallback(async (value: string) => {
    if (savingRef.current) return;
    if (value === text) { setEditing(false); return; }
    savingRef.current = true;
    try {
      await api.safety.updateSafetyNote(note.node_id, { note_text: value });
      qc.invalidateQueries({ queryKey: ['safety.notesForFm', fmNodeId] });
      qc.invalidateQueries({ queryKey: ['safety.safetyNotes', namespace] });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Update failed'));
    } finally {
      savingRef.current = false;
    }
    setEditing(false);
  }, [note.node_id, text, namespace, fmNodeId, qc, message]);

  if (editing) {
    return (
      <Input size="small" defaultValue={text} style={{ width: 260, fontSize: 11 }} autoFocus
        onBlur={(e) => save(e.target.value)}
        onPressEnter={(e) => save((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} />
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <Tag style={{ fontSize: 11, margin: 0, cursor: 'pointer', maxWidth: 200 }} onClick={() => setEditing(true)}>
        {text.slice(0, 40)}{text.length > 40 ? '…' : ''}
      </Tag>
      <DeleteWithPreview nodeId={note.node_id} onConfirm={onDelete}>
        {(openPreview) => (
          <CloseOutlined onClick={openPreview} style={{ fontSize: 9, color: '#ff4d4f', cursor: 'pointer' }} />
        )}
      </DeleteWithPreview>
    </span>
  );
}

// ── Editable Requirement Tag (click to edit req_id/name) ────────────────────

function EditableRequirementTag({ req, namespace, fmNodeId }: { req: ConceptInstanceData; namespace: string; fmNodeId: number }) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const asilOptions = buildAsilOptionGroups(profile.asilGroups);
  const attrs = req.attributes ?? {};
  const reqId = String(attrs.req_id ?? '');
  const reqName = String(attrs.req_name ?? attrs.has_name ?? '');
  const reqText = String(attrs.req_text ?? '');
  const reqAsil = String(attrs.req_asil ?? '');
  const reqLink = String(attrs.req_linked_to ?? '');
  const qc = useQueryClient();
  const [editField, setEditField] = useState<string | null>(null);
  const savingRef = useRef(false);

  const save = useCallback(async (key: string, value: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await api.safety.updateRequirement(req.node_id, { [key]: value });
      qc.invalidateQueries({ queryKey: ['safety.requirementsForFm', fmNodeId] });
      qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Update failed'));
    } finally {
      savingRef.current = false;
    }
    setEditField(null);
  }, [req.node_id, fmNodeId, namespace, qc, message]);

  const renderField = (key: string, value: string, width: number, placeholder: string) => {
    if (editField === key) {
      if (key === 'req_asil') {
        return <Select size="small" defaultValue={value || undefined} onChange={(v) => save(key, v ?? '')} onBlur={() => setEditField(null)}
          options={asilOptions} loading={profile.isLoading} disabled={!!profile.error} allowClear placeholder="ASIL" style={{ width: 110, fontSize: 11 }} autoFocus open />;
      }
      return (
        <Input size="small" defaultValue={value} style={{ width, fontSize: 11 }} autoFocus placeholder={placeholder}
          onBlur={(e) => save(key, e.target.value)}
          onPressEnter={(e) => save(key, (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditField(null); }} />
      );
    }
    if (key === 'req_asil' && value) {
      return <Tag color={getAsilColor(value)} style={{ fontSize: 11, margin: 0, cursor: 'pointer', padding: '0 4px' }}
        onClick={() => setEditField(key)}>{value}</Tag>;
    }
    return (
      <Tag color={key === 'req_linked_to' ? 'cyan' : 'blue'}
        style={{ fontSize: 11, margin: 0, cursor: 'pointer', padding: '0 4px', maxWidth: key === 'req_text' ? 180 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onClick={() => setEditField(key)}>
        {value || placeholder}
      </Tag>
    );
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      {renderField('req_id', reqId, 80, 'ID')}
      {renderField('req_name', reqName, 140, 'Name')}
      {renderField('req_text', reqText, 180, 'Text')}
      {renderField('req_asil', reqAsil, 80, 'ASIL')}
      {renderField('req_linked_to', reqLink, 160, 'Link')}
      <DeleteWithPreview nodeId={req.node_id} onConfirm={async () => {
        await api.safety.deleteRequirement(req.node_id);
        qc.invalidateQueries({ queryKey: ['safety.requirementsForFm', fmNodeId] });
        qc.invalidateQueries({ queryKey: ['safety.requirements', namespace] });
      }}>
        {(openPreview) => (
          <CloseOutlined onClick={openPreview} style={{ fontSize: 9, color: '#ff4d4f', cursor: 'pointer' }} />
        )}
      </DeleteWithPreview>
    </span>
  );
}

// ── Inline Add Risk Rating ──────────────────────────────────────────────────

function InlineAddRiskRating({ fmNodeId }: { fmNodeId: number }) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const [editing, setEditing] = useState(false);
  const [severity, setSeverity] = useState<string>('');
  const [occurrence, setOccurrence] = useState<string>('');
  const [detection, setDetection] = useState<string>('');
  const [note, setNote] = useState('');
  const createRR = useCreateRiskRating();
  const defaultsReady = Boolean(
    profile.riskDefaults.severity &&
    profile.riskDefaults.occurrence &&
    profile.riskDefaults.detection,
  );

  useEffect(() => {
    setSeverity((current) => current || profile.riskDefaults.severity);
    setOccurrence((current) => current || profile.riskDefaults.occurrence);
    setDetection((current) => current || profile.riskDefaults.detection);
  }, [profile.riskDefaults]);

  const handleSave = async () => {
    if (!defaultsReady) {
      message.error('Safety profile defaults are unavailable');
      return;
    }
    try {
      await createRR.mutateAsync({
        failureModeNodeId: fmNodeId,
        severity,
        occurrence,
        detection,
        note: note.trim() || undefined,
      });
      setEditing(false);
      setNote('');
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create risk rating'));
    }
  };

  if (!editing) {
    return (
      <Button size="small" type="dashed" icon={<PlusOutlined />}
        style={{ fontSize: 11, height: 22 }} disabled={!defaultsReady || profile.isLoading || !!profile.error} onClick={() => setEditing(true)}>
        Add Risk Rating
      </Button>
    );
  }

  return (
    <Space size={4} wrap>
      <Select size="small" value={severity} onChange={setSeverity} style={{ width: 110, fontSize: 11 }}
        options={profile.severityOptions} />
      <Select size="small" value={occurrence} onChange={setOccurrence} style={{ width: 80, fontSize: 11 }}
        options={profile.occurrenceOptions} />
      <Select size="small" value={detection} onChange={setDetection} style={{ width: 80, fontSize: 11 }}
        options={profile.detectionOptions} />
      <Input size="small" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)}
        onPressEnter={handleSave} style={{ width: 160, fontSize: 11 }} />
      <Button size="small" type="primary" icon={<CheckOutlined />} loading={createRR.isPending}
        onClick={handleSave} disabled={!defaultsReady} style={{ height: 22 }} />
      <Button size="small" icon={<CloseOutlined />} onClick={() => { setEditing(false); setNote(''); }}
        style={{ height: 22 }} />
    </Space>
  );
}

// ── Inline Add Task ─────────────────────────────────────────────────────────

function InlineAddTask({ fmNodeId, namespace }: { fmNodeId: number; namespace: string }) {
  const { message } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const createTask = useCreateSafetyTask(namespace);
  const defaultsReady = Boolean(profile.taskDefaults.status && profile.taskDefaults.type);

  const handleSave = async () => {
    if (!name.trim() || !defaultsReady) return;
    try {
      await createTask.mutateAsync({
        failureModeNodeId: fmNodeId,
        name: name.trim(),
        description: desc.trim() || name.trim(),
        status: profile.taskDefaults.status,
        type: profile.taskDefaults.type,
      });
      setName('');
      setDesc('');
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create task'));
    }
  };

  if (!editing) {
    return (
      <Button size="small" type="dashed" icon={<PlusOutlined />}
        style={{ fontSize: 11, height: 22 }} disabled={!defaultsReady || profile.isLoading || !!profile.error} onClick={() => setEditing(true)}>
        Add Task
      </Button>
    );
  }

  return (
    <Space size={4} wrap>
      <Input size="small" placeholder="Task name" value={name} onChange={e => setName(e.target.value)}
        style={{ width: 160, fontSize: 11 }} autoFocus />
      <Input size="small" placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)}
        onPressEnter={handleSave} style={{ width: 200, fontSize: 11 }} />
      <Button size="small" type="primary" icon={<CheckOutlined />} loading={createTask.isPending}
        onClick={handleSave} disabled={!name.trim() || !defaultsReady} style={{ height: 22 }} />
      <Button size="small" icon={<CloseOutlined />} onClick={() => { setEditing(false); setName(''); setDesc(''); }}
        style={{ height: 22 }} />
    </Space>
  );
}

// ── Inline Add Propagation ──────────────────────────────────────────────────

function InlineAddPropagation({ fmNodeId, namespace }: { fmNodeId: number; namespace: string }) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [targetId, setTargetId] = useState<number | undefined>();
  const { data: allFms } = useMalfunctions(namespace);
  const { add } = usePropagationMutation(namespace);

  const handleSave = async () => {
    if (targetId === undefined) return;
    try {
      await add.mutateAsync({ sourceFmNodeId: fmNodeId, targetFmNodeId: targetId });
      setTargetId(undefined);
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to add propagation'));
    }
  };

  // Filter out self from the dropdown
  const options = (allFms ?? [])
    .filter((fm: ConceptInstanceData) => fm.node_id !== fmNodeId)
    .map((fm: ConceptInstanceData) => ({
      value: fm.node_id,
      label: String(fm.attributes?.has_name ?? `FM ${fm.node_id}`),
    }));

  if (!editing) {
    return (
      <Button size="small" type="dashed" icon={<PlusOutlined />}
        style={{ fontSize: 11, height: 22 }} onClick={() => setEditing(true)}>
        Add Propagation
      </Button>
    );
  }

  return (
    <Space size={4}>
      <Select size="small" placeholder="Target FM" value={targetId} onChange={setTargetId}
        options={options} style={{ width: 180, fontSize: 11 }} showSearch
        filterOption={(input: string, option: { label: string } | undefined) =>
          (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
        } />
      <Button size="small" type="primary" icon={<CheckOutlined />} loading={add.isPending}
        onClick={handleSave} disabled={targetId === undefined} style={{ height: 22 }} />
      <Button size="small" icon={<CloseOutlined />} onClick={() => { setEditing(false); setTargetId(undefined); }}
        style={{ height: 22 }} />
    </Space>
  );
}

// ── Inline Add Requirement ──────────────────────────────────────────────────

function InlineAddRequirement({ fmNodeId, namespace }: { fmNodeId: number; namespace: string }) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [reqId, setReqId] = useState('');
  const [reqName, setReqName] = useState('');
  const [reqText, setReqText] = useState('');
  const createReq = useCreateRequirement(namespace);
  const linkReq = useLinkRequirementToFm(namespace);

  const handleSave = async () => {
    if (!reqName.trim() || !reqId.trim()) return;
    try {
      const result = await createReq.mutateAsync({
        name: reqName.trim(),
        reqId: reqId.trim(),
        reqText: reqText.trim() || reqName.trim(),
      });
      await linkReq.mutateAsync({ failureModeNodeId: fmNodeId, requirementNodeId: result.node_id });
      setReqId(''); setReqName(''); setReqText('');
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create requirement'));
    }
  };

  if (!editing) {
    return (
      <Button size="small" type="dashed" icon={<PlusOutlined />}
        style={{ fontSize: 11, height: 22 }} onClick={() => setEditing(true)}>
        Add Requirement
      </Button>
    );
  }

  return (
    <Space size={4} wrap>
      <Input size="small" placeholder="Req ID" value={reqId} onChange={e => setReqId(e.target.value)}
        style={{ width: 80, fontSize: 11 }} autoFocus />
      <Input size="small" placeholder="Name" value={reqName} onChange={e => setReqName(e.target.value)}
        style={{ width: 120, fontSize: 11 }} />
      <Input size="small" placeholder="Text" value={reqText} onChange={e => setReqText(e.target.value)}
        onPressEnter={handleSave} style={{ width: 160, fontSize: 11 }} />
      <Button size="small" type="primary" icon={<CheckOutlined />}
        loading={createReq.isPending || linkReq.isPending}
        onClick={handleSave} disabled={!reqName.trim() || !reqId.trim()} style={{ height: 22 }} />
      <Button size="small" icon={<CloseOutlined />} onClick={() => {
        setEditing(false); setReqId(''); setReqName(''); setReqText('');
      }} style={{ height: 22 }} />
    </Space>
  );
}

// ── Inline Add Note ─────────────────────────────────────────────────────────

function InlineAddNote({ fmNodeId, namespace }: { fmNodeId: number; namespace: string }) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [noteText, setNoteText] = useState('');
  const createNote = useCreateNoteForFm(namespace);

  const handleSave = async () => {
    if (!noteText.trim()) return;
    try {
      await createNote.mutateAsync({ failureModeNodeId: fmNodeId, noteText: noteText.trim() });
      setNoteText('');
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create note'));
    }
  };

  if (!editing) {
    return (
      <Button size="small" type="dashed" icon={<PlusOutlined />}
        style={{ fontSize: 11, height: 22 }} onClick={() => setEditing(true)}>
        Add Note
      </Button>
    );
  }

  return (
    <Space size={4} wrap>
      <Input size="small" placeholder="Note text" value={noteText} onChange={e => setNoteText(e.target.value)}
        onPressEnter={handleSave} style={{ width: 300, fontSize: 11 }} autoFocus />
      <Button size="small" type="primary" icon={<CheckOutlined />} loading={createNote.isPending}
        onClick={handleSave} disabled={!noteText.trim()} style={{ height: 22 }} />
      <Button size="small" icon={<CloseOutlined />} onClick={() => { setEditing(false); setNoteText(''); }}
        style={{ height: 22 }} />
    </Space>
  );
}

// ── Tags Row ────────────────────────────────────────────────────────────────

function TagsRow({ fmNodeId, namespace }: { fmNodeId: number; namespace: string }) {
  const { message } = App.useApp();
  const { data: tags } = useTagsForElement(fmNodeId);
  const { unlinkTag } = useTagMutations();
  const qc = useQueryClient();
  const tagList = tags ?? [];

  const handleUnlink = async (tagNodeId: number) => {
    try {
      await unlinkTag.mutateAsync({ elementNodeId: fmNodeId, tagNodeId });
      qc.invalidateQueries({ queryKey: ['tagsForElement'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to remove tag'));
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <TagOutlined style={{ color: '#722ed1', fontSize: 11 }} />
      <span style={{ color: '#8c8c8c', width: 80, flexShrink: 0 }}>Tags</span>
      {tagList.length > 0 ? (
        <Space size={4} wrap>
          {tagList.map((t: ConceptInstanceData) => (
            <TagChip key={t.node_id} color={String(t.attributes?.tag_color || 'purple')} closable
              onClose={(e) => { e.preventDefault(); handleUnlink(t.node_id); }}
              style={{ fontSize: 11, margin: 0 }}>
              {String(t.attributes?.has_name ?? '—')}
            </TagChip>
          ))}
        </Space>
      ) : null}
      <InlineAddTag fmNodeId={fmNodeId} namespace={namespace} />
    </div>
  );
}

// ── Inline Add Tag ──────────────────────────────────────────────────────────

function InlineAddTag({ fmNodeId, namespace }: { fmNodeId: number; namespace: string }) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<number | undefined>();
  const { data: allTags } = useTags(namespace);
  const { data: currentTags } = useTagsForElement(fmNodeId);
  const { createTag, linkTag } = useTagMutations();
  const qc = useQueryClient();

  const linkedTagIds = new Set((currentTags ?? []).map((t) => t.node_id));
  const options = (allTags ?? [])
    .filter((t: ConceptInstanceData) => !linkedTagIds.has(t.node_id))
    .map((t: ConceptInstanceData) => ({
      value: t.node_id,
      label: String(t.attributes?.has_name ?? `Tag ${t.node_id}`),
    }));

  const handleSelect = async (value: number | string) => {
    try {
      if (typeof value === 'string') {
        // Create new tag then link
        const created = await createTag.mutateAsync({ namespace, name: value });
        await linkTag.mutateAsync({ elementNodeId: fmNodeId, tagNodeId: created.node_id });
      } else {
        await linkTag.mutateAsync({ elementNodeId: fmNodeId, tagNodeId: value });
      }
      qc.invalidateQueries({ queryKey: ['tagsForElement'] });
      qc.invalidateQueries({ queryKey: ['tags'] });
      setSelectedTagId(undefined);
      setEditing(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to add tag'));
    }
  };

  if (!editing) {
    return (
      <Button size="small" type="dashed" icon={<PlusOutlined />}
        style={{ fontSize: 11, height: 22 }} onClick={() => setEditing(true)}>
        Add Tag
      </Button>
    );
  }

  return (
    <Space size={4}>
      <Select
        size="small"
        placeholder="Select or type new tag"
        value={selectedTagId}
        onChange={(v) => handleSelect(v)}
        options={options}
        style={{ width: 180, fontSize: 11 }}
        showSearch
        filterOption={(input: string, option: { label: string } | undefined) =>
          (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
        }
        onSearch={() => {}}
        notFoundContent={null}
        onInputKeyDown={(e) => {
          if (e.key === 'Enter') {
            const input = (e.target as HTMLInputElement).value?.trim();
            if (input && !options.some((o) => o.label.toLowerCase() === input.toLowerCase())) {
              e.preventDefault();
              e.stopPropagation();
              handleSelect(input);
            }
          }
        }}
        autoFocus
        open
      />
      <Button size="small" icon={<CloseOutlined />} onClick={() => { setEditing(false); setSelectedTagId(undefined); }}
        style={{ height: 22 }} />
    </Space>
  );
}
