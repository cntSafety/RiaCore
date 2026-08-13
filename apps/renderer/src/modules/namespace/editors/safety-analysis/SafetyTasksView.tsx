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
import { App, Button, Empty, Input, Modal, Select, Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { CheckOutlined, CheckSquareOutlined, DeleteOutlined, EditOutlined, PlusOutlined, WarningOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useAllSafetyTasks } from './hooks/useSafetyQueries';
import { useDeleteSafetyTask, useUpdateSafetyTask } from './hooks/useSafetyMutations';
import { api } from '../../../../api/riacore';
import { DataTable } from '../../../../components/data-table';
import { InlineSelectCell, InlineTextCell } from '../../../../components/inline-edit';
import { ShowInTreeTrigger } from '../../../../components/ShowInTreeTrigger';
import { useWorkspaceState } from '../../../../hooks/useWorkspaceState';
import { useAutoSave } from '../../../../hooks/useAutoSave';
import { useSafetyProfileMetadata } from './hooks/useSafetyProfileMetadata';

interface SafetyTaskRow {
  nodeId: number;
  task: ConceptInstanceData;
  name: string;
  status: string;
  type: string;
  responsible: string;
  reference: string;
  description: string;
  detail?: { fmNodeId: number; fmNamespace: string; fmName: string };
}

function statusColor(status: string): string {
  if (status === 'Done' || status === 'finished') return 'green';
  if (status === 'In Progress' || status === 'started' || status === 'In Review') return 'blue';
  if (status === 'Confirmed') return 'cyan';
  if (status === 'open' || status === 'To Do') return 'default';
  return 'default';
}

/**
 * Resolve the malfunction each task is linked to. Only the malfunction identity
 * is fetched — the malfunction's `occurs_at` host element is deliberately NOT
 * resolved, since the overview shows the malfunction name alone.
 */
function useTaskDetails(tasks: ConceptInstanceData[]) {
  return useQuery({
    queryKey: ['tasks.details', tasks.map(t => t.node_id).join(',')],
    queryFn: async () => {
      const details: Map<number, { fmNodeId: number; fmNamespace: string; fmName: string }> = new Map();
      for (const task of tasks) {
        try {
          const fm = await api.safety.getMalfunctionForTask(task.node_id);
          if (fm) {
            details.set(task.node_id, {
              fmNodeId: fm.node_id,
              fmNamespace: fm.namespace,
              fmName: String(fm.attributes?.has_name ?? `FM ${fm.node_id}`),
            });
          }
        } catch { /* skip */ }
      }
      return details;
    },
    enabled: tasks.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

interface CreateTaskModalProps {
  open: boolean;
  namespace: string;
  onClose: () => void;
}

function CreateTaskModal({ open, namespace, onClose }: CreateTaskModalProps) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const profile = useSafetyProfileMetadata();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [responsible, setResponsible] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    setStatus((current) => current || profile.taskDefaults.status);
    setType((current) => current || profile.taskDefaults.type);
  }, [profile.taskDefaults]);

  const reset = () => {
    setName(''); setDesc(''); setStatus(profile.taskDefaults.status); setType(profile.taskDefaults.type);
    setResponsible(''); setReference('');
  };

  const handleClose = () => { reset(); onClose(); };

  const handleCreate = async () => {
    if (!name.trim()) { message.warning('Name is required'); return; }
    setSaving(true);
    try {
      await api.safety.createSafetyTask(namespace, name.trim(), desc.trim(), status, type, responsible.trim() || undefined, reference.trim() || undefined);
      await qc.invalidateQueries({ queryKey: ['safety.allSafetyTasks', namespace] });
      message.success('Task created');
      handleClose();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create task'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Add Safety Task"
      onCancel={handleClose}
      footer={[
        <Button key="cancel" onClick={handleClose}>Cancel</Button>,
        <Button key="create" type="primary" icon={<PlusOutlined />} onClick={handleCreate} loading={saving} disabled={!name.trim()}>Add</Button>,
      ]}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 8 }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div>
            <Typography.Text strong>Status</Typography.Text>
            <Select value={status} options={profile.taskStatusOptions} onChange={setStatus} style={{ width: '100%', marginTop: 4 }} />
          </div>
          <div>
            <Typography.Text strong>Type</Typography.Text>
            <Select value={type || undefined} options={profile.taskTypeOptions} onChange={setType} allowClear placeholder="Select type" style={{ width: '100%', marginTop: 4 }} />
          </div>
        </div>
        <div>
          <Typography.Text strong>Name <Typography.Text type="danger">*</Typography.Text></Typography.Text>
          <Input autoFocus value={name} onChange={e => setName(e.target.value)} style={{ marginTop: 4 }} placeholder="Task name" />
        </div>
        <div>
          <Typography.Text strong>Description</Typography.Text>
          <Input.TextArea rows={3} value={desc} onChange={e => setDesc(e.target.value)} style={{ marginTop: 4 }} placeholder="Task description" />
        </div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div>
            <Typography.Text strong>Responsible</Typography.Text>
            <Input value={responsible} onChange={e => setResponsible(e.target.value)} style={{ marginTop: 4 }} />
          </div>
          <div>
            <Typography.Text strong>Reference</Typography.Text>
            <Input value={reference} onChange={e => setReference(e.target.value)} style={{ marginTop: 4 }} />
          </div>
        </div>
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

interface EditTaskModalProps {
  record: SafetyTaskRow | null;
  namespace: string;
  workspaceKey: string | null;
  triggerAutoSave: () => void;
  onClose: () => void;
}

function EditTaskModal({ record, namespace, workspaceKey, triggerAutoSave, onClose }: EditTaskModalProps) {
  const { message } = App.useApp();
  const updateTask = useUpdateSafetyTask(namespace, workspaceKey, triggerAutoSave);
  const profile = useSafetyProfileMetadata();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [responsible, setResponsible] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (!record) return;
    const t = record.task;
    setName(String(t.attributes?.has_name ?? ''));
    setDesc(String(t.attributes?.task_description ?? ''));
    setStatus(String(t.attributes?.task_status ?? profile.taskDefaults.status));
    setType(String(t.attributes?.task_type ?? profile.taskDefaults.type));
    setResponsible(String(t.attributes?.task_responsible ?? ''));
    setReference(String(t.attributes?.task_reference ?? ''));
  }, [record, profile.taskDefaults]);

  if (!record) return null;
  const task = record.task;

  const isDirty =
    name !== String(task.attributes?.has_name ?? '') ||
    desc !== String(task.attributes?.task_description ?? '') ||
    status !== String(task.attributes?.task_status ?? profile.taskDefaults.status) ||
    type !== String(task.attributes?.task_type ?? profile.taskDefaults.type) ||
    responsible !== String(task.attributes?.task_responsible ?? '') ||
    reference !== String(task.attributes?.task_reference ?? '');

  const handleSave = async () => {
    try {
      await updateTask.mutateAsync({
        nodeId: task.node_id,
        fmNodeId: 0,
        updates: { has_name: name, task_description: desc, task_status: status, task_type: type, task_responsible: responsible, task_reference: reference },
      });
      message.success('Task updated');
      onClose();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update task'));
    }
  };

  return (
    <Modal
      open={true}
      title="Edit Safety Task"
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>Cancel</Button>,
        <Button key="save" type="primary" icon={<CheckOutlined />} onClick={handleSave} loading={updateTask.isPending} disabled={!isDirty}>Save</Button>,
      ]}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 8 }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div>
            <Typography.Text strong>Name</Typography.Text>
              <Input autoFocus value={name} onChange={e => setName(e.target.value)} style={{ marginTop: 4 }} />
          </div>
          <div>
            <Typography.Text strong>Status</Typography.Text>
            <Select value={status} options={profile.taskStatusOptions} onChange={setStatus} style={{ width: '100%', marginTop: 4 }} />
          </div>
          <div>
            <Typography.Text strong>Type</Typography.Text>
            <Select value={type} options={profile.taskTypeOptions} onChange={setType} style={{ width: '100%', marginTop: 4 }} />
          </div>
        </div>
        <div>
          <Typography.Text strong>Description</Typography.Text>
          <Input.TextArea rows={3} value={desc} onChange={e => setDesc(e.target.value)} style={{ marginTop: 4 }} />
        </div>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div>
            <Typography.Text strong>Responsible</Typography.Text>
            <Input value={responsible} onChange={e => setResponsible(e.target.value)} style={{ marginTop: 4 }} />
          </div>
          <div>
            <Typography.Text strong>Reference</Typography.Text>
            <Input value={reference} onChange={e => setReference(e.target.value)} style={{ marginTop: 4 }} />
          </div>
        </div>
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function SafetyTasksView({ ns }: { ns: NamespaceContext }) {
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const profile = useSafetyProfileMetadata();
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;
  const { triggerAutoSave } = useAutoSave(ns.name);
  const tasksQuery = useAllSafetyTasks(ns.name);
  const tasks = tasksQuery.data ?? [];
  const detailsQuery = useTaskDetails(tasks);
  const updateTask = useUpdateSafetyTask(ns.name, workspaceKey, triggerAutoSave);
  const deleteTask = useDeleteSafetyTask(ns.name, workspaceKey, triggerAutoSave);
  const navigatingRef = useRef(false);

  const [editingRecord, setEditingRecord] = useState<SafetyTaskRow | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const statusStats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      const s = String(t.attributes?.task_status ?? 'unknown');
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [tasks]);

  const rows = useMemo<SafetyTaskRow[]>(() => {
    const details = detailsQuery.data;
    return tasks.map((task) => ({
      nodeId: task.node_id,
      task,
      name: String(task.attributes?.has_name ?? ''),
      status: String(task.attributes?.task_status ?? ''),
      type: String(task.attributes?.task_type ?? ''),
      responsible: String(task.attributes?.task_responsible ?? ''),
      reference: String(task.attributes?.task_reference ?? ''),
      description: String(task.attributes?.task_description ?? ''),
      detail: details?.get(task.node_id),
    }));
  }, [tasks, detailsQuery.data]);

  const responsibleFilters = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.responsible).filter((v) => v !== '')))
        .sort()
        .map((v) => ({ text: v, value: v })),
    [rows],
  );

  const referenceFilters = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.reference).filter((v) => v !== '')))
        .sort()
        .map((v) => ({ text: v, value: v })),
    [rows],
  );

  const linkedMalfunctionFilters = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.detail?.fmName ?? '').filter((v) => v !== '')),
      )
        .sort()
        .map((v) => ({ text: v, value: v })),
    [rows],
  );

  /**
   * Persist a single attribute edited inline in the table. Throws so the
   * inline cell can roll its displayed value back on failure.
   */
  const commitField = useCallback(
    async (record: SafetyTaskRow, attribute: string, value: string) => {
      try {
        await updateTask.mutateAsync({ nodeId: record.nodeId, updates: { [attribute]: value } });
      } catch (err: unknown) {
        message.error(String((err as Error)?.message ?? 'Failed to update task'));
        throw err;
      }
    },
    [updateTask, message],
  );

  const confirmDelete = useCallback(
    (record: SafetyTaskRow) => {
      modal.confirm({
        title: 'Delete this safety task?',
        content: 'This cannot be undone. Only loading the model from git can restore it.',
        okText: 'Delete',
        okButtonProps: { danger: true },
        cancelText: 'Cancel',
        onOk: async () => {
          try {
            await deleteTask.mutateAsync({ nodeId: record.nodeId });
            message.success('Task deleted');
          } catch (err: unknown) {
            message.error(String((err as Error)?.message ?? 'Failed to delete task'));
          }
        },
      });
    },
    [deleteTask, message, modal],
  );

  const handleNameContextMenu = async (e: React.MouseEvent, record: SafetyTaskRow) => {
    e.preventDefault();
    e.stopPropagation();
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    try {
      const selectedId = await api.contextMenu.show([
        { id: 'showInTree', label: 'Show in Tree' },
        { id: 'edit', label: 'Edit' },
        { id: 'delete', label: 'Delete' },
      ]);
      if (selectedId === 'showInTree') {
        await api.window.showInTree({
          homeTarget: { nodeId: record.nodeId, namespace: ns.name, concept: 'safety_task' },
          requestKind: 'home',
          safetyNamespace: ns.name,
        });
      } else if (selectedId === 'edit') {
        setEditingRecord(record);
      } else if (selectedId === 'delete') {
        confirmDelete(record);
      }
    } finally {
      navigatingRef.current = false;
    }
  };

  const columns = useMemo<ColumnsType<SafetyTaskRow>>(() => [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 280,
      sorter: (a, b) => a.name.localeCompare(b.name),
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="Search name…"
            value={selectedKeys[0] as string}
            onChange={e => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            onPressEnter={() => confirm()}
            style={{ width: 200, marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button type="primary" size="small" onClick={() => confirm()} style={{ width: 90 }}>Filter</Button>
            <Button size="small" onClick={() => { clearFilters?.(); confirm(); }} style={{ width: 90 }}>Reset</Button>
          </Space>
        </div>
      ),
      onFilter: (value, record) => record.name.toLowerCase().includes(String(value).toLowerCase()),
      render: (value: string, record) => (
        <span
          style={{ display: 'block', minWidth: 0 }}
          onContextMenu={(e) => void handleNameContextMenu(e, record)}
        >
          <InlineTextCell
            value={value}
            strong
            multiline
            placeholder="Unnamed"
            onCommit={(next) => commitField(record, 'has_name', next)}
          />
        </span>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      filters: profile.taskStatusOptions.map(({ value, label }) => ({ text: label, value })),
      onFilter: (value, record) => record.status === value,
      render: (value: string, record) => (
        <InlineSelectCell
          value={value}
          options={profile.taskStatusOptions}
          width={140}
          renderDisplay={(v) =>
            v
              ? <Tag color={statusColor(v)} style={{ margin: 0 }}>{v}</Tag>
              : <Tag style={{ margin: 0, borderStyle: 'dashed' }}>set status</Tag>
          }
          onCommit={(next) => commitField(record, 'task_status', next)}
        />
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 160,
      filters: profile.taskTypeOptions.map(({ value, label }) => ({ text: label, value })),
      onFilter: (value, record) => record.type === value,
      render: (value: string, record) => (
        <InlineSelectCell
          value={value}
          options={profile.taskTypeOptions}
          allowClear
          placeholder="Select type"
          width={160}
          renderDisplay={(v) =>
            v
              ? <Tag style={{ margin: 0 }}>{v}</Tag>
              : <Tag style={{ margin: 0, borderStyle: 'dashed' }}>set type</Tag>
          }
          onCommit={(next) => commitField(record, 'task_type', next)}
        />
      ),
    },
    {
      title: 'Responsible',
      dataIndex: 'responsible',
      key: 'responsible',
      width: 150,
      sorter: (a, b) => a.responsible.localeCompare(b.responsible),
      filters: responsibleFilters,
      filterSearch: true,
      onFilter: (value, record) => record.responsible === String(value),
      render: (value: string, record) => (
        <InlineTextCell
          value={value}
          onCommit={(next) => commitField(record, 'task_responsible', next)}
        />
      ),
    },
    {
      title: 'Reference',
      dataIndex: 'reference',
      key: 'reference',
      width: 150,
      sorter: (a, b) => a.reference.localeCompare(b.reference),
      filters: referenceFilters,
      filterSearch: true,
      onFilter: (value, record) => record.reference === String(value),
      render: (value: string, record) => (
        <InlineTextCell
          value={value}
          onCommit={(next) => commitField(record, 'task_reference', next)}
        />
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      width: 240,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="Search description…"
            value={selectedKeys[0] as string}
            onChange={e => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            onPressEnter={() => confirm()}
            style={{ width: 200, marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button type="primary" size="small" onClick={() => confirm()} style={{ width: 90 }}>Filter</Button>
            <Button size="small" onClick={() => { clearFilters?.(); confirm(); }} style={{ width: 90 }}>Reset</Button>
          </Space>
        </div>
      ),
      onFilter: (value, record) => record.description.toLowerCase().includes(String(value).toLowerCase()),
      render: (value: string, record) => (
        <InlineTextCell
          value={value}
          multiline
          secondary
          fontSize={12}
          onCommit={(next) => commitField(record, 'task_description', next)}
        />
      ),
    },
    {
      title: 'Linked malfunction',
      key: 'linkedMalfunction',
      width: 240,
      sorter: (a, b) =>
        (a.detail?.fmName ?? '').localeCompare(b.detail?.fmName ?? ''),
      filters: linkedMalfunctionFilters,
      filterSearch: true,
      onFilter: (value, record) => (record.detail?.fmName ?? '') === String(value),
      render: (_, record) => {
        if (!record.detail) return null;
        const { fmNodeId, fmNamespace, fmName } = record.detail;
        return (
          <ShowInTreeTrigger
            homeTarget={{ nodeId: fmNodeId, namespace: fmNamespace, concept: 'malfunction' }}
            safetyNamespace={ns.name}
          >
            <span style={{ cursor: 'context-menu' }}>
              <WarningOutlined style={{ color: '#faad14', marginRight: 4 }} />
              {fmName}
            </span>
          </ShowInTreeTrigger>
        );
      },
    },
    {
      title: '',
      key: 'actions',
      width: 72,
      render: (_, record) => (
        <Space size={0}>
          <Tooltip title="Edit all fields">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              aria-label={`Edit ${record.name || 'task'}`}
              onClick={() => setEditingRecord(record)}
            />
          </Tooltip>
          <Tooltip title="Delete task">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label={`Delete ${record.name || 'task'}`}
              onClick={() => confirmDelete(record)}
            />
          </Tooltip>
        </Space>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [responsibleFilters, referenceFilters, linkedMalfunctionFilters, ns.name, commitField, confirmDelete, profile.taskStatusOptions, profile.taskTypeOptions]);

  if (tasksQuery.isLoading || profile.isLoading) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>;
  }

  if (profile.error) {
    return <Empty description={`Could not load safety profile metadata: ${profile.error.message}`} style={{ marginTop: 64 }} />;
  }

  if (tasks.length === 0) {
    return (
      <div style={{ height: '100%', overflow: 'auto', padding: 16, background: token.colorBgLayout }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            Add Task
          </Button>
        </div>
        <Empty description="No safety tasks in this namespace" style={{ marginTop: 64 }} />
        <CreateTaskModal
          open={createModalOpen}
          namespace={ns.name}
          onClose={() => setCreateModalOpen(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, background: token.colorBgLayout, minWidth: 480 }}>
      <Space direction="vertical" size={12} style={{ width: '100%', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
          <CheckSquareOutlined style={{ color: '#52c41a', marginRight: 8 }} />
          Safety Tasks ({tasks.length})
        </Typography.Title>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          {statusStats.map(([status, count]) => (
            <Tag key={status} color={statusColor(status)}>{status}: {count}</Tag>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            Add Task
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Enter saves · Esc cancels
          </Typography.Text>
          {(detailsQuery.isLoading || updateTask.isPending) && <Spin size="small" />}
        </div>
      </Space>

      <DataTable<SafetyTaskRow>
        columns={columns}
        dataSource={rows}
        rowKey="nodeId"
      />

      <EditTaskModal
        record={editingRecord}
        namespace={ns.name}
        workspaceKey={workspaceKey}
        triggerAutoSave={triggerAutoSave}
        onClose={() => setEditingRecord(null)}
      />

      <CreateTaskModal
        open={createModalOpen}
        namespace={ns.name}
        onClose={() => setCreateModalOpen(false)}
      />
    </div>
  );
}
