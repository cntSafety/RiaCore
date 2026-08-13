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
import { Alert, Form, Input, Modal, Select, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { CreatedNamespaceInfo, ProfileInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useCreateAuthoredNamespaceMutation } from '../hooks/useRiacoreMutations';

const { Text } = Typography;

interface Props {
  open: boolean;
  workingDir: string;
  onClose: () => void;
  onCreated: (info: CreatedNamespaceInfo) => void;
}

interface FormValues {
  profileId: string;
  namespace: string;
}

export function AddAnalysisModal({ open, workingDir, onClose, onCreated }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [error, setError] = useState<string | null>(null);

  const { data: profiles = [], isLoading } = useQuery<ProfileInfo[]>({
    queryKey: ['profiles.listAvailable'],
    queryFn: () => api.profiles.listAvailable(),
    enabled: open,
  });

  const createMutation = useCreateAuthoredNamespaceMutation(workingDir);

  const handleOk = async () => {
    setError(null);
    try {
      const values = await form.validateFields();
      const info = await createMutation.mutateAsync(values);
      form.resetFields();
      onCreated(info);
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
      title="Add Analysis"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Create"
      confirmLoading={createMutation.isPending}
      width={440}
      destroyOnClose
    >
      {error && (
        <Alert
          type="error"
          message={error}
          style={{ marginBottom: 12 }}
          closable
          onClose={() => setError(null)}
        />
      )}

      <Form form={form} layout="vertical" size="small">
        <Form.Item
          label="Analysis Profile"
          name="profileId"
          rules={[{ required: true, message: 'Select a profile' }]}
        >
          <Select
            loading={isLoading}
            placeholder="Select profile…"
            autoFocus
            options={profiles
              .filter((profile) => profile.profileId !== 'security-core')
              .map((profile) => ({
                value: profile.profileId,
                label: (
                  <span>
                    {profile.label}
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                      v{profile.version}
                    </Text>
                  </span>
                ),
              }))}
          />
        </Form.Item>

        <Form.Item
          label="Namespace"
          name="namespace"
          rules={[{ required: true, message: 'Enter a namespace name' }]}
          extra="Creates an empty authored namespace from the selected profile."
        >
          <Input placeholder="e.g. VehicleSafetyAnalysis" onPressEnter={() => void handleOk()} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
