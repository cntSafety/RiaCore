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
import { Card, Tabs, Spin, Empty, Button, Typography, Space, Alert } from 'antd';
import { BranchesOutlined, HistoryOutlined, CloudOutlined, SettingOutlined, CodeOutlined } from '@ant-design/icons';
import { useWorkspaceStore } from '../../store/workspaceStore.js';
import { useGitIsRepo, useGitStatus } from '../../api/git-hooks.js';
import { ChangesTab } from './ChangesTab.js';
import { HistoryTab } from './HistoryTab.js';
import { BranchesTab } from './BranchesTab.js';
import { RemotesTab } from './RemotesTab.js';
import { InitRepoView } from './InitRepoView.js';
import { GitSettingsTab } from './GitSettingsTab.js';

const { Text } = Typography;

interface GitPanelProps {
  onClose?: () => void;
}

export const GitPanel: React.FC<GitPanelProps> = ({ onClose }) => {
  const workingDir = useWorkspaceStore(s => s.workingDir ?? '');
  const [activeTab, setActiveTab] = useState('changes');

  const isRepoQuery = useGitIsRepo(workingDir);
  const statusQuery = useGitStatus(workingDir, isRepoQuery.data === true);

  if (!workingDir) {
    return (
      <Card size="small" title="Git" extra={onClose && <Button size="small" type="text" onClick={onClose}>✕</Button>}>
        <Empty description="No workspace open" />
      </Card>
    );
  }

  if (isRepoQuery.isLoading) {
    return (
      <Card size="small" title="Git">
        <Spin />
      </Card>
    );
  }

  if (isRepoQuery.isError) {
    return (
      <Card size="small" title="Git">
        <Alert type="error" message="Failed to check git status" description={String(isRepoQuery.error)} />
      </Card>
    );
  }

  if (!isRepoQuery.data) {
    return <InitRepoView workingDir={workingDir} />;
  }

  const status = statusQuery.data;
  const pendingChanges = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : 0;

  const tabItems = [
    {
      key: 'changes',
      label: (
        <Space size={4}>
          <CodeOutlined />
          <span>Changes{pendingChanges > 0 ? ` (${pendingChanges})` : ''}</span>
        </Space>
      ),
      children: <ChangesTab repoDir={workingDir} />,
    },
    {
      key: 'history',
      label: (
        <Space size={4}>
          <HistoryOutlined />
          <span>History</span>
        </Space>
      ),
      children: <HistoryTab repoDir={workingDir} />,
    },
    {
      key: 'branches',
      label: (
        <Space size={4}>
          <BranchesOutlined />
          <span>Branches</span>
        </Space>
      ),
      children: <BranchesTab repoDir={workingDir} />,
    },
    {
      key: 'remotes',
      label: (
        <Space size={4}>
          <CloudOutlined />
          <span>Remotes</span>
        </Space>
      ),
      children: <RemotesTab repoDir={workingDir} />,
    },
    {
      key: 'settings',
      label: (
        <Space size={4}>
          <SettingOutlined />
          <span>Settings</span>
        </Space>
      ),
      children: <GitSettingsTab workingDir={workingDir} repoDir={workingDir} />,
    },
  ];

  const branch = status?.branch ?? '(unknown)';
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  return (
    <Card
      size="small"
      title={
        <Space>
          <BranchesOutlined />
          <Text strong>Git</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {branch}
            {ahead > 0 && ` ↑${ahead}`}
            {behind > 0 && ` ↓${behind}`}
          </Text>
        </Space>
      }
      extra={onClose && <Button size="small" type="text" onClick={onClose}>✕</Button>}
      bodyStyle={{ padding: 0 }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        size="small"
        style={{ paddingInline: 8 }}
      />
    </Card>
  );
};
