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
import { List, Button, Typography, Space, Input, Checkbox, Alert, Divider, Badge, Tag, Spin } from 'antd';
import { CheckSquareOutlined, MinusSquareOutlined } from '@ant-design/icons';
import { useGitStatus, useGitStageAll, useGitUnstageAll, useGitCommit } from '../../api/git-hooks.js';

const { Text, Title } = Typography;
const { TextArea } = Input;

interface ChangesTabProps {
  repoDir: string;
}

export const ChangesTab: React.FC<ChangesTabProps> = ({ repoDir }) => {
  const [message, setMessage] = useState('');

  const statusQuery = useGitStatus(repoDir);
  const stageAllMutation = useGitStageAll(repoDir);
  const unstageAllMutation = useGitUnstageAll(repoDir);
  const commitMutation = useGitCommit(repoDir);

  const status = statusQuery.data;

  const handleCommit = async () => {
    if (!message.trim()) return;
    await commitMutation.mutateAsync({ repoDir, message: message.trim() });
    setMessage('');
  };

  if (statusQuery.isLoading) return <Spin style={{ margin: 16 }} />;
  if (statusQuery.isError) {
    return <Alert type="error" message={String(statusQuery.error)} style={{ margin: 8 }} />;
  }
  if (!status) return null;

  const { staged, unstaged, untracked } = status;

  return (
    <div style={{ padding: '4px 0' }}>
      {/* Staged files */}
      <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={4}>
          <CheckSquareOutlined />
          <Text strong style={{ fontSize: 12 }}>Staged ({staged.length})</Text>
        </Space>
        {staged.length > 0 && (
          <Button
            size="small"
            type="text"
            loading={unstageAllMutation.isPending}
            onClick={() => void unstageAllMutation.mutateAsync()}
          >
            Unstage all
          </Button>
        )}
      </div>
      <List
        size="small"
        dataSource={staged}
        locale={{ emptyText: <Text type="secondary" style={{ fontSize: 11, paddingInline: 8 }}>Nothing staged</Text> }}
        renderItem={(f) => (
          <List.Item style={{ paddingInline: 8, paddingBlock: 2 }}>
            <Space size={4} style={{ width: '100%' }}>
              <Tag color={f.status === 'added' ? 'green' : f.status === 'deleted' ? 'red' : 'blue'} style={{ fontSize: 10 }}>
                {f.status[0].toUpperCase()}
              </Tag>
              <Text style={{ fontSize: 12 }} ellipsis title={f.path}>{f.path}</Text>
            </Space>
          </List.Item>
        )}
      />

      <Divider style={{ margin: '4px 0' }} />

      {/* Unstaged / untracked files */}
      <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={4}>
          <MinusSquareOutlined />
          <Text strong style={{ fontSize: 12 }}>
            Changes ({unstaged.length + untracked.length})
          </Text>
        </Space>
        {(unstaged.length + untracked.length) > 0 && (
          <Button
            size="small"
            type="text"
            loading={stageAllMutation.isPending}
            onClick={() => void stageAllMutation.mutateAsync()}
          >
            Stage all
          </Button>
        )}
      </div>
      <List
        size="small"
        dataSource={[
          ...unstaged.map(f => ({ path: f.path, status: f.status as string })),
          ...untracked.map(p => ({ path: p, status: 'untracked' })),
        ]}
        locale={{ emptyText: <Text type="secondary" style={{ fontSize: 11, paddingInline: 8 }}>Nothing to stage</Text> }}
        renderItem={(f) => (
          <List.Item style={{ paddingInline: 8, paddingBlock: 2 }}>
            <Space size={4} style={{ width: '100%' }}>
              <Tag color={f.status === 'added' || f.status === 'untracked' ? 'green' : f.status === 'deleted' ? 'red' : 'orange'} style={{ fontSize: 10 }}>
                {f.status === 'untracked' ? 'U' : f.status[0].toUpperCase()}
              </Tag>
              <Text style={{ fontSize: 12 }} ellipsis title={f.path}>{f.path}</Text>
            </Space>
          </List.Item>
        )}
      />

      <Divider style={{ margin: '4px 0' }} />

      {/* Commit form */}
      <div style={{ padding: '4px 8px' }}>
        <TextArea
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Commit message…"
          rows={3}
          size="small"
          style={{ fontSize: 12, marginBottom: 4 }}
        />
        <Button
          type="primary"
          size="small"
          block
          loading={commitMutation.isPending}
          disabled={!message.trim() || staged.length === 0}
          onClick={() => void handleCommit()}
        >
          Commit{staged.length > 0 ? ` ${staged.length} file${staged.length > 1 ? 's' : ''}` : ''}
        </Button>
        {commitMutation.isError && (
          <Alert type="error" message={String(commitMutation.error)} showIcon style={{ marginTop: 4, fontSize: 11 }} />
        )}
        {commitMutation.isSuccess && (
          <Alert type="success" message="Committed" showIcon style={{ marginTop: 4, fontSize: 11 }} />
        )}
      </div>
    </div>
  );
};
