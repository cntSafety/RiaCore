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
import React from 'react';
import { List, Typography, Space, Spin, Alert, Tag } from 'antd';
import { TagOutlined } from '@ant-design/icons';
import { useGitLog } from '../../api/git-hooks.js';
import type { CommitEntry } from '@riacore/git-service';

const { Text } = Typography;

interface HistoryTabProps {
  repoDir: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const HistoryTab: React.FC<HistoryTabProps> = ({ repoDir }) => {
  const logQuery = useGitLog(repoDir, { maxCount: 50 });

  if (logQuery.isLoading) return <Spin style={{ margin: 16 }} />;
  if (logQuery.isError) {
    return <Alert type="error" message={String(logQuery.error)} style={{ margin: 8 }} />;
  }

  const commits: CommitEntry[] = logQuery.data?.entries ?? [];

  return (
    <List
      size="small"
      dataSource={commits}
      locale={{ emptyText: <Text type="secondary" style={{ fontSize: 12 }}>No commits yet</Text> }}
      renderItem={(commit) => (
        <List.Item style={{ paddingInline: 8, paddingBlock: 4, alignItems: 'flex-start' }}>
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            <Text style={{ fontSize: 12 }} ellipsis title={commit.message}>
              {commit.message.split('\n')[0]}
            </Text>
            <Space size={8} style={{ fontSize: 11 }}>
              <Text type="secondary">
                <TagOutlined style={{ marginRight: 2 }} />
                {commit.shortHash}
              </Text>
              <Text type="secondary">{commit.author}</Text>
              <Text type="secondary">{formatDate(commit.date)}</Text>
            </Space>
          </Space>
        </List.Item>
      )}
    />
  );
};
