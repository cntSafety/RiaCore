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
import { Modal, Form, Input, Select, Alert, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ImporterInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useProvisionImporterMutation } from '../hooks/useRiacoreMutations';

const { Text } = Typography;

interface Props {
  open: boolean;
  workingDir: string;
  onClose: () => void;
  /** Called with the sourceId and resolved sourceType after provisioning */
  onProvisioned: (sourceId: string, sourceType: string, namespace: string) => void;
}

interface FormValues {
  importerName: string;
  namespace: string;
}

export function AddImporterModal({ open, workingDir, onClose, onProvisioned }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [error, setError] = useState<string | null>(null);

  const { data: importers = [], isLoading } = useQuery<ImporterInfo[]>({
    queryKey: ['importers.listAvailable'],
    queryFn: () => api.importers.listAvailable(),
    enabled: open,
  });

  const provisionMutation = useProvisionImporterMutation(importers);

  const handleOk = async () => {
    setError(null);
    try {
      const values = await form.validateFields();
      const { sourceId, sourceType, namespace } = await provisionMutation.mutateAsync({
        ...values,
        workingDir,
      });
      form.resetFields();
      onProvisioned(sourceId, sourceType, namespace);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setError(null);
    onClose();
  };

  return (
    <Modal
      title="Add Import Source"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Add"
      confirmLoading={provisionMutation.isPending}
      width={420}
      destroyOnClose
    >
      {error && <Alert type="error" message={error} style={{ marginBottom: 12 }} closable onClose={() => setError(null)} />}

      <Form form={form} layout="vertical" size="small">
        <Form.Item label="Importer Type" name="importerName" rules={[{ required: true, message: 'Select an importer' }]}>
          <Select
            loading={isLoading}
            placeholder="Select importer…"
            autoFocus
            options={importers
              .filter((i) => i.hasConfigTemplate)
              .map((i) => ({
                value: i.name,
                label: (
                  <span>
                    {i.label}
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>v{i.version}</Text>
                  </span>
                ),
              }))}
          />
        </Form.Item>

        <Form.Item
          label="Namespace"
          name="namespace"
          rules={[{ required: true, message: 'Enter a namespace name' }]}
          extra="Unique identifier for this import source. Cannot be changed after creation."
        >
          <Input placeholder="e.g. MyProject" onPressEnter={() => void handleOk()} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
