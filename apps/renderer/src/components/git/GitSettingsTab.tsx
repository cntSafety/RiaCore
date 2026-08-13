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
import React, { useEffect, useState } from 'react';
import { Typography, Switch, Input, Button, Alert, Divider, Spin, Space } from 'antd';
import { useWorkspaceGitConfig, useSaveWorkspaceGitConfig, useGitConfig } from '../../api/git-hooks.js';
import { useEnsureGitignore } from '../../api/git-hooks.js';
import { DEFAULT_AUTO_COMMIT_TEMPLATE } from '@riacore/app-contracts';
import type { WorkspaceGitConfig } from '@riacore/app-contracts';

const { Text, Title } = Typography;
const { TextArea } = Input;

interface GitSettingsTabProps {
  workingDir: string;
  repoDir: string;
}

export const GitSettingsTab: React.FC<GitSettingsTabProps> = ({ workingDir, repoDir }) => {
  const configQuery = useWorkspaceGitConfig();
  const gitConfigQuery = useGitConfig(repoDir);
  const saveMutation = useSaveWorkspaceGitConfig();
  const ensureGitignoreMutation = useEnsureGitignore(repoDir);

  const [autoCommit, setAutoCommit] = useState(false);
  const [template, setTemplate] = useState(DEFAULT_AUTO_COMMIT_TEMPLATE);
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');

  useEffect(() => {
    if (configQuery.data) {
      const c = configQuery.data;
      setAutoCommit(c.autoCommitOnStore ?? false);
      setTemplate(c.autoCommitMessageTemplate ?? DEFAULT_AUTO_COMMIT_TEMPLATE);
      setAuthorName(c.commitAuthor?.name ?? '');
      setAuthorEmail(c.commitAuthor?.email ?? '');
    }
  }, [configQuery.data]);

  const handleSave = async () => {
    const config: WorkspaceGitConfig = {
      autoCommitOnStore: autoCommit,
      autoCommitMessageTemplate: template,
      commitAuthor: authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined,
    };
    await saveMutation.mutateAsync(config);
  };

  if (configQuery.isLoading) return <Spin style={{ margin: 16 }} />;

  return (
    <div style={{ padding: '8px' }}>
      <Title level={5} style={{ marginTop: 0 }}>Auto-Commit on Store</Title>

      <Space direction="vertical" style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch checked={autoCommit} onChange={setAutoCommit} size="small" />
          <Text style={{ fontSize: 12 }}>Auto-commit after persistor.store</Text>
        </div>

        {autoCommit && (
          <>
            <div>
              <Text style={{ fontSize: 12 }}>Commit message template</Text>
              <TextArea
                value={template}
                onChange={e => setTemplate(e.target.value)}
                rows={4}
                size="small"
                style={{ fontSize: 11, fontFamily: 'monospace' }}
              />
              <Text type="secondary" style={{ fontSize: 11 }}>
                Variables: {'{{date}}'}, {'{{namespaces}}'}, {'{{fileCount}}'}
              </Text>
            </div>

            <div>
              <Text style={{ fontSize: 12 }}>Override commit author (optional)</Text>
              <Input
                value={authorName}
                onChange={e => setAuthorName(e.target.value)}
                placeholder="Author name"
                size="small"
                style={{ marginBottom: 4 }}
              />
              <Input
                value={authorEmail}
                onChange={e => setAuthorEmail(e.target.value)}
                placeholder="author@example.com"
                size="small"
              />
            </div>
          </>
        )}

        <Button
          type="primary"
          size="small"
          loading={saveMutation.isPending}
          onClick={() => void handleSave()}
        >
          Save Settings
        </Button>

        {saveMutation.isSuccess && <Alert type="success" message="Settings saved" showIcon />}
        {saveMutation.isError && <Alert type="error" message={String(saveMutation.error)} showIcon />}

        <Divider style={{ margin: '8px 0' }} />

        <div>
          <Title level={5} style={{ marginTop: 0 }}>Git Config</Title>
          {gitConfigQuery.data && (
            <Space direction="vertical" size={2}>
              {gitConfigQuery.data.name && <Text style={{ fontSize: 12 }}>Name: {gitConfigQuery.data.name}</Text>}
              {gitConfigQuery.data.email && <Text style={{ fontSize: 12 }}>Email: {gitConfigQuery.data.email}</Text>}
            </Space>
          )}
        </div>

        <div>
          <Title level={5} style={{ marginTop: 0 }}>.gitignore</Title>
          <Button
            size="small"
            loading={ensureGitignoreMutation.isPending}
            onClick={() => void ensureGitignoreMutation.mutateAsync()}
          >
            Ensure RIA .gitignore entries
          </Button>
          {ensureGitignoreMutation.isSuccess && (
            <Alert
              type="success"
              message={
                ensureGitignoreMutation.data?.created
                  ? '.gitignore created'
                  : ensureGitignoreMutation.data?.updated
                  ? '.gitignore updated'
                  : '.gitignore already up to date'
              }
              showIcon
              style={{ marginTop: 4 }}
            />
          )}
        </div>
      </Space>
    </div>
  );
};
