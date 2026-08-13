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
import React, { useState, useEffect } from 'react';
import { Modal, Button, Input, Alert, Space, Typography, Badge, Spin, Tag } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useGitStatus, gitKeys } from '../../api/git-hooks.js';
import { api } from '../../api/riacore.js';

const { TextArea } = Input;
const { Text } = Typography;

/** Patterns that are staged automatically when the user commits from this modal. */
const BASE_STAGE_PATTERNS = ['ria-data/', 'ria-config/'];

/**
 * Compute stage patterns relative to the git repo root.
 *
 * When the RIA workspace (workingDir) lives inside the git repo but is not at
 * the repo root (repoDir), the patterns must be prefixed with the relative
 * offset so `git add` — which runs from repoDir — locates the correct paths.
 *
 * Uses forward slashes for cross-platform git compatibility.
 * Returns the patterns unchanged when workingDir equals repoDir.
 */
function buildStagePatterns(workingDir: string, repoDir: string): string[] {
  if (!workingDir || !repoDir) return BASE_STAGE_PATTERNS;
  // Normalise to forward slashes and strip trailing separator
  const wd = workingDir.replace(/\\/g, '/').replace(/\/$/, '');
  const rd = repoDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (wd === rd) return BASE_STAGE_PATTERNS;
  // Check if workingDir is inside repoDir
  if (!wd.startsWith(rd + '/')) return BASE_STAGE_PATTERNS;
  const prefix = wd.slice(rd.length + 1); // e.g. 'project/ria'
  return BASE_STAGE_PATTERNS.map(p => `${prefix}/${p}`);
}

interface GitCommitModalProps {
  repoDir: string;
  /** Workspace working directory — used to compute repo-relative stage paths. */
  workingDir: string;
  open: boolean;
  onClose: () => void;
}

type Phase = 'idle' | 'staging' | 'committing' | 'done';

export const GitCommitModal: React.FC<GitCommitModalProps> = ({ repoDir, workingDir, open, onClose }) => {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);

  const qc = useQueryClient();
  const statusQuery = useGitStatus(repoDir, open);
  const status = statusQuery.data;

  // Stage patterns are relative to repoDir; workingDir may be a subdirectory
  const stagePatterns = buildStagePatterns(workingDir, repoDir);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setMessage('');
      setPhase('idle');
      setError(null);
      setCommitHash(null);
    }
  }, [open]);

  const totalChanges = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : 0;

  const handleCommit = async () => {
    if (!message.trim()) return;
    setError(null);
    try {
      setPhase('staging');
      await api.git.stageFiles(repoDir, stagePatterns);

      setPhase('committing');
      const result = await api.git.commit({ repoDir, message: message.trim() });
      setCommitHash(result.shortHash);
      setPhase('done');
      void qc.invalidateQueries({ queryKey: gitKeys.status(repoDir) });
      void qc.invalidateQueries({ queryKey: gitKeys.log(repoDir) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const isBusy = phase === 'staging' || phase === 'committing';

  return (
    <Modal
      title="Commit RIA Data"
      open={open}
      onCancel={onClose}
      width={480}
      footer={
        phase === 'done' ? (
          <Button type="primary" onClick={onClose}>Close</Button>
        ) : (
          <Space>
            <Button onClick={onClose} disabled={isBusy}>Cancel</Button>
            <Button
              type="primary"
              loading={isBusy}
              disabled={!message.trim() || isBusy}
              onClick={() => void handleCommit()}
            >
              {phase === 'staging' ? 'Staging…' : phase === 'committing' ? 'Committing…' : 'Stage & Commit'}
            </Button>
          </Space>
        )
      }
    >
      {phase === 'done' ? (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert
            type="success"
            icon={<CheckCircleOutlined />}
            showIcon
            message={`Committed successfully (${commitHash})`}
            description={`Message: "${message}"`}
          />
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {statusQuery.isLoading && <Spin size="small" />}
          {status && (
            <Space wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>Repository status:</Text>
              {status.staged.length > 0 && (
                <Badge count={status.staged.length} color="green" size="small">
                  <Tag color="green" style={{ fontSize: 11 }}>staged</Tag>
                </Badge>
              )}
              {status.unstaged.length > 0 && (
                <Badge count={status.unstaged.length} color="orange" size="small">
                  <Tag color="orange" style={{ fontSize: 11 }}>modified</Tag>
                </Badge>
              )}
              {status.untracked.length > 0 && (
                <Badge count={status.untracked.length} color="blue" size="small">
                  <Tag color="blue" style={{ fontSize: 11 }}>untracked</Tag>
                </Badge>
              )}
              {totalChanges === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>No changes detected</Text>
              )}
            </Space>
          )}
          <div>
            <Text style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              The following paths will be staged automatically:
            </Text>
            <Space>
              {stagePatterns.map((p) => (
                <Tag key={p} style={{ fontFamily: 'monospace', fontSize: 11 }}>{p}</Tag>
              ))}
            </Space>
          </div>
          <TextArea
            placeholder="Commit message…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            disabled={isBusy}
            autoFocus
          />
          {error && <Alert type="error" message={error} showIcon />}
        </Space>
      )}
    </Modal>
  );
};
