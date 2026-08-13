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
import React, { useState } from 'react';
import { List, Button, Typography, Space, Spin, Alert, Input, Modal } from 'antd';
import { PlusOutlined, DeleteOutlined, CloudDownloadOutlined, CloudUploadOutlined } from '@ant-design/icons';
import { useGitRemotes, useGitFetch, useGitPull, useGitPush } from '../../api/git-hooks.js';
import type { RemoteInfo } from '@riacore/git-service';
import { api } from '../../api/riacore.js';

const { Text } = Typography;

interface RemotesTabProps {
  repoDir: string;
}

export const RemotesTab: React.FC<RemotesTabProps> = ({ repoDir }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('origin');
  const [newUrl, setNewUrl] = useState('');
  const [addError, setAddError] = useState('');

  const remotesQuery = useGitRemotes(repoDir);
  const fetchMutation = useGitFetch(repoDir);
  const pullMutation = useGitPull(repoDir);
  const pushMutation = useGitPush(repoDir);

  if (remotesQuery.isLoading) return <Spin style={{ margin: 16 }} />;
  if (remotesQuery.isError) {
    return <Alert type="error" message={String(remotesQuery.error)} style={{ margin: 8 }} />;
  }

  const remotes: RemoteInfo[] = remotesQuery.data ?? [];

  const handleAdd = async () => {
    try {
      setAddError('');
      await api.git.addRemote(repoDir, newName, newUrl);
      await remotesQuery.refetch();
      setShowAdd(false);
      setNewName('origin');
      setNewUrl('');
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (name: string) => {
    await api.git.removeRemote(repoDir, name);
    await remotesQuery.refetch();
  };

  return (
    <div>
      <div style={{ padding: '4px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Button
            size="small"
            icon={<CloudDownloadOutlined />}
            loading={fetchMutation.isPending}
            onClick={() => void fetchMutation.mutateAsync({})}
          >
            Fetch all
          </Button>
          <Button
            size="small"
            icon={<CloudDownloadOutlined />}
            loading={pullMutation.isPending}
            onClick={() => void pullMutation.mutateAsync({})}
          >
            Pull
          </Button>
          <Button
            size="small"
            icon={<CloudUploadOutlined />}
            loading={pushMutation.isPending}
            onClick={() => void pushMutation.mutateAsync({})}
          >
            Push
          </Button>
        </Space>
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setShowAdd(true)}
        >
          Add Remote
        </Button>
      </div>

      {(fetchMutation.isError || pullMutation.isError || pushMutation.isError) && (
        <Alert
          type="error"
          message={String(fetchMutation.error ?? pullMutation.error ?? pushMutation.error)}
          style={{ margin: 8 }}
          showIcon
        />
      )}

      <List
        size="small"
        dataSource={remotes}
        locale={{ emptyText: <Text type="secondary" style={{ fontSize: 12, paddingInline: 8 }}>No remotes configured</Text> }}
        renderItem={(remote) => (
          <List.Item
            style={{ paddingInline: 8, paddingBlock: 4 }}
            actions={[
              <Button
                key="remove"
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => void handleRemove(remote.name)}
              />,
            ]}
          >
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Text strong style={{ fontSize: 12 }}>{remote.name}</Text>
              {remote.fetchUrl && <Text type="secondary" style={{ fontSize: 11 }} ellipsis>{remote.fetchUrl}</Text>}
            </Space>
          </List.Item>
        )}
      />

      <Modal
        title="Add Remote"
        open={showAdd}
        onOk={() => void handleAdd()}
        onCancel={() => setShowAdd(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Text style={{ fontSize: 12 }}>Remote name</Text>
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="origin"
              autoFocus
            />
          </div>
          <div>
            <Text style={{ fontSize: 12 }}>URL</Text>
            <Input
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </div>
          {addError && <Alert type="error" message={addError} showIcon />}
        </Space>
      </Modal>
    </div>
  );
};
