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
import { Modal, Form, Input, Select, Alert, Tag } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useCreateMalfunction } from '../hooks/useSafetyMutations';
import { getAsilColor, ASIL_UNSET_LABEL, ASIL_UNSET_VALUE } from '../config/asilColors';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';
import type { SelectedTreeElement } from '../types';

interface CreateMalfunctionModalProps {
  open: boolean;
  namespace: string;
  selectedTreeElement: SelectedTreeElement | null;
  onClose: () => void;
  onCreated?: (created: { nodeId: number; name: string }) => void;
  workspaceKey?: string | null;
  /** Namespace of the structural element this malfunction occurs at (for tree invalidation). */
  occursAtNamespace?: string;
  /** Trigger auto-save of the authored namespace after creating a malfunction. */
  triggerAutoSave?: () => void;
}

export function CreateMalfunctionModal({ open, namespace, selectedTreeElement, onClose, onCreated, workspaceKey, occursAtNamespace, triggerAutoSave }: CreateMalfunctionModalProps) {
  const [form] = Form.useForm();
  const [error, setError] = useState<string | null>(null);
  const profile = useSafetyProfileMetadata();
  const createFm = useCreateMalfunction(namespace, workspaceKey ?? null, occursAtNamespace, triggerAutoSave);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setError(null);
      const created = await createFm.mutateAsync({
        namespace,
        name: values.name,
        description: values.description,
        asil: values.asil || undefined,
        occursAtNodeId: selectedTreeElement?.nodeId,
      });
      onCreated?.({ nodeId: created.node_id, name: values.name });
      form.resetFields();
      onClose();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'message' in err) {
        setError(String((err as { message: string }).message));
      }
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setError(null);
    onClose();
  };

  // Custom ASIL option rendering with color tags, plus an explicit "Not set".
  const asilOptions = [
    { label: ASIL_UNSET_LABEL, value: ASIL_UNSET_VALUE },
    ...profile.asilGroups.map((group) => ({
      label: group.label,
      options: group.options.map((v) => ({
        label: <Tag color={getAsilColor(v)} style={{ margin: 0 }}>{v}</Tag>,
        value: v,
      })),
    })),
  ];

  return (
    <Modal
      title={<span><WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />New Malfunction</span>}
      open={open}
      onOk={handleOk}
      okText="Create"
      onCancel={handleCancel}
      confirmLoading={createFm.isPending}
      destroyOnClose
      width={480}
    >
      {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, message: 'Please enter a malfunction name' }]}
        >
          <Input placeholder="e.g. Loss of braking force" autoFocus />
        </Form.Item>
        <Form.Item
          name="description"
          label="Description"
          rules={[{ required: true, message: 'Please provide a description' }]}
        >
          <Input.TextArea
            rows={3}
            placeholder="Describe the malfunction behavior and its observable effects"
          />
        </Form.Item>
        <Form.Item name="asil" label="ASIL Classification">
          <Select
            allowClear
            placeholder="Select ASIL level"
            options={asilOptions}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
