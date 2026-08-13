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
import { App, Button, Empty, Input, Modal, Select, Space, Spin, Tag, Typography, theme } from 'antd';
import { CheckOutlined, FileTextOutlined, PlusOutlined, WarningOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useRequirements } from './hooks/useSafetyQueries';
import { useDeleteRequirement, useUpdateRequirement, useCreateRequirement } from './hooks/useSafetyMutations';
import { api } from '../../../../api/riacore';
import { DataTable } from '../../../../components/data-table';
import { ShowInTreeTrigger } from '../../../../components/ShowInTreeTrigger';
import { getAsilColor } from './config/asilColors';
import { useSafetyProfileMetadata } from './hooks/useSafetyProfileMetadata';

interface RequirementRow {
  nodeId: number;
  reqId: string;
  reqName: string;
  reqText: string;
  reqAsil: string;
  reqLink: string;
  failureModes: Array<{ fm: ConceptInstanceData; componentName: string; componentPath: string }>;
}

/**
 * For each requirement, fetch the failure modes linked via has_safety_requirements,
 * then for each FM resolve its occurs_at target to show the component name/path.
 */
function useRequirementDetails(requirements: ConceptInstanceData[]) {
  return useQuery({
    queryKey: ['requirements.details', requirements.map(r => r.node_id).join(',')],
    queryFn: async () => {
      const details: Map<number, { failureModes: Array<{ fm: ConceptInstanceData; componentName: string; componentPath: string }> }> = new Map();

      for (const req of requirements) {
        const fms = await api.safety.getMalfunctionsForRequirement(req.node_id);
        const fmDetails: Array<{ fm: ConceptInstanceData; componentName: string; componentPath: string }> = [];

        for (const fm of fms) {
          try {
            const fmData = await api.safety.getMalfunction(fm.node_id);
            const target = fmData.occursAtTarget;
            if (target) {
              const targetInstance = await api.safety.getInstance(target.node_id);
              const arPath = String(targetInstance.attributes?.ar_path ?? '');
              const name = String(targetInstance.attributes?.has_name ?? targetInstance.attributes?.element_name ?? target.concept);
              fmDetails.push({ fm, componentName: name, componentPath: arPath });
            } else {
              fmDetails.push({ fm, componentName: '(not attached)', componentPath: '' });
            }
          } catch {
            fmDetails.push({ fm, componentName: '(unknown)', componentPath: '' });
          }
        }

        details.set(req.node_id, { failureModes: fmDetails });
      }

      return details;
    },
    enabled: requirements.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

interface CreateRequirementModalProps {
  open: boolean;
  namespace: string;
  onClose: () => void;
}

function CreateRequirementModal({ open, namespace, onClose }: CreateRequirementModalProps) {
  const { message } = App.useApp();
  const createRequirement = useCreateRequirement(namespace);
  const profile = useSafetyProfileMetadata();
  const [reqId, setReqId] = useState('');
  const [reqName, setReqName] = useState('');
  const [reqText, setReqText] = useState('');
  const [reqAsil, setReqAsil] = useState<string | undefined>(undefined);
  const [reqLink, setReqLink] = useState('');

  const reset = () => {
    setReqId('');
    setReqName('');
    setReqText('');
    setReqAsil(undefined);
    setReqLink('');
  };

  const handleClose = () => { reset(); onClose(); };

  const handleCreate = async () => {
    if (!reqName.trim()) { message.warning('Name is required'); return; }
    try {
      await createRequirement.mutateAsync({
        name: reqName.trim(),
        reqId: reqId.trim(),
        reqText: reqText.trim(),
        asil: reqAsil,
        linkedToUrl: reqLink.trim() || undefined,
      });
      message.success('Requirement created');
      handleClose();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create requirement'));
    }
  };

  return (
    <Modal
      open={open}
      title="Add Requirement"
      onCancel={handleClose}
      footer={[
        <Button key="cancel" onClick={handleClose}>Cancel</Button>,
        <Button key="create" type="primary" icon={<PlusOutlined />} onClick={handleCreate} loading={createRequirement.isPending} disabled={!reqName.trim()}>Add</Button>,
      ]}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 8 }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <div>
            <Typography.Text strong>Req ID</Typography.Text>
            <Input autoFocus value={reqId} onChange={e => setReqId(e.target.value)} style={{ marginTop: 4 }} placeholder="e.g. REQ-001" />
          </div>
          <div>
            <Typography.Text strong>ASIL</Typography.Text>
            <Select
              value={reqAsil}
              onChange={setReqAsil}
              allowClear
              placeholder="Select ASIL"
              style={{ width: '100%', marginTop: 4 }}
              options={profile.asilGroups.map((g) => ({
                label: g.label,
                options: g.options.map((v) => ({
                  value: v,
                  label: <Tag color={getAsilColor(v)} style={{ margin: 0 }}>{v}</Tag>,
                })),
              }))}
            />
          </div>
        </div>
        <div>
          <Typography.Text strong>Name <Typography.Text type="danger">*</Typography.Text></Typography.Text>
          <Input value={reqName} onChange={e => setReqName(e.target.value)} style={{ marginTop: 4 }} placeholder="Requirement name" />
        </div>
        <div>
          <Typography.Text strong>Description</Typography.Text>
          <Input.TextArea rows={3} value={reqText} onChange={e => setReqText(e.target.value)} style={{ marginTop: 4 }} placeholder="Requirement text" />
        </div>
        <div>
          <Typography.Text strong>Link</Typography.Text>
          <Input value={reqLink} onChange={e => setReqLink(e.target.value)} style={{ marginTop: 4 }} placeholder="https://..." />
        </div>
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

interface EditRequirementModalProps {
  record: RequirementRow | null;
  namespace: string;
  onClose: () => void;
}

function EditRequirementModal({ record, namespace, onClose }: EditRequirementModalProps) {
  const { message } = App.useApp();
  const updateRequirement = useUpdateRequirement(namespace);
  const profile = useSafetyProfileMetadata();
  const [reqId, setReqId] = useState('');
  const [reqName, setReqName] = useState('');
  const [reqText, setReqText] = useState('');
  const [reqAsil, setReqAsil] = useState('');
  const [reqLink, setReqLink] = useState('');

  useEffect(() => {
    if (!record) return;
    setReqId(record.reqId);
    setReqName(record.reqName);
    setReqText(record.reqText);
    setReqAsil(record.reqAsil);
    setReqLink(record.reqLink);
  }, [record]);

  if (!record) return null;

  const isDirty =
    reqId !== record.reqId ||
    reqName !== record.reqName ||
    reqText !== record.reqText ||
    reqAsil !== record.reqAsil ||
    reqLink !== record.reqLink;

  const handleSave = async () => {
    try {
      await updateRequirement.mutateAsync({
        nodeId: record.nodeId,
        updates: { req_id: reqId, req_name: reqName, req_text: reqText, req_asil: reqAsil, req_linked_to: reqLink },
      });
      message.success('Requirement updated');
      onClose();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to update requirement'));
    }
  };

  return (
    <Modal
      open={true}
      title="Edit Requirement"
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>Cancel</Button>,
        <Button key="save" type="primary" icon={<CheckOutlined />} onClick={handleSave} loading={updateRequirement.isPending} disabled={!isDirty}>Save</Button>,
      ]}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 8 }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          <div>
            <Typography.Text strong>Req ID</Typography.Text>
            <Input autoFocus value={reqId} onChange={e => setReqId(e.target.value)} style={{ marginTop: 4 }} />
          </div>
          <div>
            <Typography.Text strong>ASIL</Typography.Text>
            <Select
              value={reqAsil || undefined}
              onChange={setReqAsil}
              allowClear
              placeholder="Select ASIL"
              style={{ width: '100%', marginTop: 4 }}
              options={profile.asilGroups.map((g) => ({
                label: g.label,
                options: g.options.map((v) => ({
                  value: v,
                  label: <Tag color={getAsilColor(v)} style={{ margin: 0 }}>{v}</Tag>,
                })),
              }))}
            />
          </div>
        </div>
        <div>
          <Typography.Text strong>Name</Typography.Text>
          <Input value={reqName} onChange={e => setReqName(e.target.value)} style={{ marginTop: 4 }} />
        </div>
        <div>
          <Typography.Text strong>Description</Typography.Text>
          <Input.TextArea rows={3} value={reqText} onChange={e => setReqText(e.target.value)} style={{ marginTop: 4 }} />
        </div>
        <div>
          <Typography.Text strong>Link</Typography.Text>
          <Input value={reqLink} onChange={e => setReqLink(e.target.value)} style={{ marginTop: 4 }} />
        </div>
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function RequirementsView({ ns }: { ns: NamespaceContext }) {
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const requirementsQuery = useRequirements(ns.name);
  const deleteRequirement = useDeleteRequirement(ns.name);
  const requirements = requirementsQuery.data ?? [];
  const detailsQuery = useRequirementDetails(requirements);
  const navigatingRef = useRef(false);

  const [editingRecord, setEditingRecord] = useState<RequirementRow | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const rows = useMemo<RequirementRow[]>(() => {
    const details = detailsQuery.data;
    return requirements.map((req) => {
      const reqDetails = details?.get(req.node_id);
      return {
        nodeId: req.node_id,
        reqId: String(req.attributes?.req_id ?? ''),
        reqName: String(req.attributes?.req_name ?? req.attributes?.has_name ?? ''),
        reqText: String(req.attributes?.req_text ?? ''),
        reqAsil: String(req.attributes?.req_asil ?? ''),
        reqLink: String(req.attributes?.req_linked_to ?? ''),
        failureModes: reqDetails?.failureModes ?? [],
      };
    });
  }, [requirements, detailsQuery.data]);

  const asilFilters = useMemo(() => {
    const unique = Array.from(new Set(rows.map((r) => r.reqAsil).filter((a) => a !== '')));
    unique.sort();
    return unique.map((a) => ({ text: a, value: a }));
  }, [rows]);

  const linkedMalfunctionFilters = useMemo(
    () =>
      Array.from(
        new Set(
          rows.flatMap((r) =>
            r.failureModes.map((f) => String(f.fm.attributes?.has_name ?? '')),
          ).filter((v) => v !== ''),
        ),
      )
        .sort()
        .map((v) => ({ text: v, value: v })),
    [rows],
  );

  const handleNameContextMenu = async (e: React.MouseEvent, record: RequirementRow) => {
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
          homeTarget: { nodeId: record.nodeId, namespace: ns.name, concept: 'requirement' },
          requestKind: 'home',
          safetyNamespace: ns.name,
        });
      } else if (selectedId === 'edit') {
        setEditingRecord(record);
      } else if (selectedId === 'delete') {
        modal.confirm({
          title: 'Delete requirement?',
          content: 'This will permanently delete the requirement and unlink it from all malfunctions.',
          okText: 'Delete',
          okButtonProps: { danger: true },
          cancelText: 'Cancel',
          onOk: async () => {
            try {
              await deleteRequirement.mutateAsync(record.nodeId);
              message.success('Requirement deleted');
            } catch (err: unknown) {
              message.error(String((err as Error)?.message ?? 'Failed to delete requirement'));
            }
          },
        });
      }
    } finally {
      navigatingRef.current = false;
    }
  };

  const columns = useMemo<ColumnsType<RequirementRow>>(() => [
    {
      title: 'Req ID',
      dataIndex: 'reqId',
      key: 'reqId',
      width: 120,
      sorter: (a, b) => a.reqId.localeCompare(b.reqId),
      render: (value: string) => <Tag color="purple" style={{ margin: 0 }}>{value || 'No ID'}</Tag>,
    },
    {
      title: 'Name',
      dataIndex: 'reqName',
      key: 'reqName',
      width: 280,
      ellipsis: true,
      sorter: (a, b) => a.reqName.localeCompare(b.reqName),
      render: (value: string, record) => (
        <span
          style={{ cursor: 'context-menu' }}
          onContextMenu={(e) => void handleNameContextMenu(e, record)}
        >
          <Typography.Text strong>{value}</Typography.Text>
        </span>
      ),
    },
    {
      title: 'ASIL',
      dataIndex: 'reqAsil',
      key: 'reqAsil',
      width: 100,
      filters: asilFilters,
      onFilter: (value, record) => record.reqAsil === value,
      render: (value: string) => (value ? <Tag color={getAsilColor(value)}>{value}</Tag> : null),
    },
    {
      title: 'Description',
      dataIndex: 'reqText',
      key: 'reqText',
      width: 200,
      ellipsis: true,
      render: (value: string) => value ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value}</Typography.Text>
      ) : null,
    },
    {
      title: 'Linked malfunctions',
      key: 'linkedMalfunctions',
      width: 280,
      filters: linkedMalfunctionFilters,
      filterSearch: true,
      onFilter: (value, record) =>
        record.failureModes.some((f) => String(f.fm.attributes?.has_name ?? '') === String(value)),
      sorter: (a, b) => a.failureModes.length - b.failureModes.length,
      render: (_, record) => {
        if (record.failureModes.length === 0) return null;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {record.failureModes.map(({ fm, componentName, componentPath }) => (
              <ShowInTreeTrigger
                key={fm.node_id}
                homeTarget={{ nodeId: fm.node_id, namespace: fm.namespace, concept: 'malfunction' }}
                safetyNamespace={ns.name}
                hideKebab
              >
                <span style={{ cursor: 'context-menu', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <WarningOutlined style={{ color: '#faad14', flexShrink: 0 }} />
                  <Typography.Text style={{ fontSize: 12 }}>
                    {String(fm.attributes?.has_name ?? `FM ${fm.node_id}`)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    → {componentName}{componentPath ? ` (${componentPath})` : ''}
                  </Typography.Text>
                </span>
              </ShowInTreeTrigger>
            ))}
          </div>
        );
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [asilFilters, linkedMalfunctionFilters, ns.name]);

  if (requirementsQuery.isLoading) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>;
  }

  if (requirements.length === 0) {
    return (
      <div style={{ height: '100%', overflow: 'auto', padding: 16, background: token.colorBgLayout }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            Add Requirement
          </Button>
        </div>
        <Empty description="No requirements in this namespace" style={{ marginTop: 64 }} />
        <CreateRequirementModal
          open={createModalOpen}
          namespace={ns.name}
          onClose={() => setCreateModalOpen(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, background: token.colorBgLayout, minWidth: 480 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
          <FileTextOutlined style={{ color: '#722ed1', marginRight: 8 }} />
          Requirements ({requirements.length})
        </Typography.Title>
        {detailsQuery.isLoading && <Spin size="small" />}
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
          Add Requirement
        </Button>
      </div>

      <DataTable<RequirementRow>
        columns={columns}
        dataSource={rows}
        rowKey="nodeId"
      />

      <EditRequirementModal
        record={editingRecord}
        namespace={ns.name}
        onClose={() => setEditingRecord(null)}
      />

      <CreateRequirementModal
        open={createModalOpen}
        namespace={ns.name}
        onClose={() => setCreateModalOpen(false)}
      />
    </div>
  );
}
