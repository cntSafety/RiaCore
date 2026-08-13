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
import { Card, Button, Typography, Space, Alert, Input } from 'antd';
import { BranchesOutlined, PlusOutlined } from '@ant-design/icons';
import { useGitInit, useEnsureGitignore } from '../../api/git-hooks.js';

const { Title, Text } = Typography;

interface InitRepoViewProps {
  workingDir: string;
}

export const InitRepoView: React.FC<InitRepoViewProps> = ({ workingDir }) => {
  const [initialBranch, setInitialBranch] = useState('main');
  const initMutation = useGitInit();
  const ensureGitignoreMutation = useEnsureGitignore(workingDir);

  const handleInit = async () => {
    try {
      await initMutation.mutateAsync({ dir: workingDir, initialBranch });
      await ensureGitignoreMutation.mutateAsync();
    } catch (_err) {
      // Error shown via mutation state
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <BranchesOutlined />
          <Text strong>Git</Text>
        </Space>
      }
    >
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Title level={5}>No Git repository found</Title>
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          This workspace is not under version control. Initialize a Git repository to track changes.
        </Text>

        <Space direction="vertical" style={{ width: '100%', maxWidth: 320 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>Default branch name</Text>
            <Input
              value={initialBranch}
              onChange={e => setInitialBranch(e.target.value)}
              size="small"
              placeholder="main"
            />
          </div>

          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={initMutation.isPending || ensureGitignoreMutation.isPending}
            onClick={() => void handleInit()}
            block
          >
            Initialize Repository
          </Button>

          {(initMutation.isError || ensureGitignoreMutation.isError) && (
            <Alert
              type="error"
              message={String(initMutation.error ?? ensureGitignoreMutation.error)}
              showIcon
            />
          )}
        </Space>
      </div>
    </Card>
  );
};
