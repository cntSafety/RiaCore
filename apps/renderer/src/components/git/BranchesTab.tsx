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
import { List, Button, Typography, Space, Spin, Alert, Input, Modal, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined, BranchesOutlined } from '@ant-design/icons';
import { useGitBranches, useGitStatus, useGitCreateBranch, useGitCheckoutBranch, useGitDeleteBranch } from '../../api/git-hooks.js';
import type { BranchInfo } from '@riacore/git-service';

const { Text } = Typography;

interface BranchesTabProps {
  repoDir: string;
}

export const BranchesTab: React.FC<BranchesTabProps> = ({ repoDir }) => {
  const [newBranchName, setNewBranchName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const branchesQuery = useGitBranches(repoDir);
  const statusQuery = useGitStatus(repoDir);
  const createMutation = useGitCreateBranch(repoDir);
  const checkoutMutation = useGitCheckoutBranch(repoDir);
  const deleteMutation = useGitDeleteBranch(repoDir);

  const currentBranch = statusQuery.data?.branch;

  if (branchesQuery.isLoading) return <Spin style={{ margin: 16 }} />;
  if (branchesQuery.isError) {
    return <Alert type="error" message={String(branchesQuery.error)} style={{ margin: 8 }} />;
  }

  const branches: BranchInfo[] = branchesQuery.data ?? [];

  const handleCreate = async () => {
    if (!newBranchName.trim()) return;
    await createMutation.mutateAsync({ name: newBranchName.trim() });
    setNewBranchName('');
    setShowCreate(false);
  };

  return (
    <div>
      <div style={{ padding: '4px 8px', display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setShowCreate(true)}
        >
          New Branch
        </Button>
      </div>

      <List
        size="small"
        dataSource={branches}
        renderItem={(branch) => (
          <List.Item
            style={{ paddingInline: 8, paddingBlock: 4 }}
            actions={[
              branch.name !== currentBranch && (
                <Button
                  key="checkout"
                  size="small"
                  type="text"
                  loading={checkoutMutation.isPending && checkoutMutation.variables === branch.name}
                  onClick={() => void checkoutMutation.mutateAsync(branch.name)}
                >
                  Checkout
                </Button>
              ),
              branch.name !== currentBranch && (
                <Button
                  key="delete"
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  loading={deleteMutation.isPending}
                  onClick={() => void deleteMutation.mutateAsync({ name: branch.name })}
                />
              ),
            ].filter(Boolean)}
          >
            <Space size={4}>
              <BranchesOutlined />
              <Text style={{ fontSize: 12 }}>{branch.name}</Text>
              {branch.name === currentBranch && <Tag color="blue" style={{ fontSize: 10 }}>current</Tag>}
              {branch.isRemote && <Tag color="default" style={{ fontSize: 10 }}>remote</Tag>}
              {branch.ahead > 0 && <Text type="secondary" style={{ fontSize: 11 }}>↑{branch.ahead}</Text>}
              {branch.behind > 0 && <Text type="secondary" style={{ fontSize: 11 }}>↓{branch.behind}</Text>}
            </Space>
          </List.Item>
        )}
      />

      <Modal
        title="Create Branch"
        open={showCreate}
        onOk={() => void handleCreate()}
        onCancel={() => setShowCreate(false)}
        confirmLoading={createMutation.isPending}
      >
        <Input
          value={newBranchName}
          onChange={e => setNewBranchName(e.target.value)}
          placeholder="branch-name"
          onPressEnter={() => void handleCreate()}
          autoFocus
        />
        {createMutation.isError && (
          <Alert type="error" message={String(createMutation.error)} showIcon style={{ marginTop: 8 }} />
        )}
      </Modal>
    </div>
  );
};
