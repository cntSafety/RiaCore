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
/**
 * MergeFromBranchModal — UC-14: merge an authored namespace from a git branch.
 *
 * Flow:
 *  1. Lists branches of `repoDir`.
 *  2. User selects a branch.
 *  3. On confirm: sync check → (optional warning) → union merge from branch.
 */

import { useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  message,
} from 'antd';
import { BranchesOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BranchInfo, TagInfo } from '@riacore/git-service';
import { api } from '../api/riacore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { invalidateAfterContentChange } from '../hooks/workspaceCacheReset';

interface AuthoredNsCardData {
  id: string;
  name: string;
  owningApplication: string;
  standard: string;
}

interface Props {
  ns: AuthoredNsCardData;
  workingDir: string;
  repoDir: string;
  open: boolean;
  onClose: () => void;
}

type Phase = 'select' | 'confirm-unsaved' | 'merging' | 'done' | 'error';

export function MergeFromBranchModal({ ns, workingDir, repoDir, open, onClose }: Props) {
  const [messageApi, contextHolder] = message.useMessage();
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [errorMsg, setErrorMsg] = useState('');
  const queryClient = useQueryClient();

  const branchesQuery = useQuery<BranchInfo[]>({
    queryKey: ['git.listBranches', repoDir],
    queryFn: () => api.git.listBranches(repoDir),
    enabled: open && !!repoDir,
  });

  const tagsQuery = useQuery<TagInfo[]>({
    queryKey: ['git.listTags', repoDir],
    queryFn: () => api.git.listTags(repoDir),
    enabled: open && !!repoDir,
  });

  const branches: BranchInfo[] = branchesQuery.data ?? [];
  const tags: TagInfo[] = tagsQuery.data ?? [];
  const isLoadingRefs = branchesQuery.isLoading || tagsQuery.isLoading;
  const refsError = branchesQuery.error ?? tagsQuery.error;

  const handleConfirmMerge = async (ref: string) => {
    setPhase('merging');
    try {
      const result = await api.namespaces.applyUnionMergeFromBranch(ns.id, workingDir, repoDir, ref);
      // Merged content reassigns node IDs across the target namespace — refresh
      // every DB-content cache (see hooks/workspaceCacheReset.ts).
      await invalidateAfterContentChange(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Git status so uncommitted changes from the store() call are reflected
      // immediately in the git panel.
      void queryClient.invalidateQueries({ queryKey: ['git', 'status', repoDir] });
      // Clear all node-ID-bearing Zustand state — merged content reassigns node
      // IDs so any persisted selectedElement or navigation entry is now stale.
      useWorkspaceStore.getState().resetWorkspaceState();
      void messageApi.success(
        `Merge complete for '${ns.name}' from '${ref}': +${result.nodesAdded} nodes, +${result.edgesAdded} edges updated`,
      );
      onClose();
    } catch (err) {
      setErrorMsg(String(err));
      setPhase('error');
    }
  };

  const handleMerge = async () => {
    if (!selectedRef) return;
    try {
      const status = await api.namespaces.getSyncStatus(ns.id, workingDir);
      if (status.inSync) {
        await handleConfirmMerge(selectedRef);
      } else {
        setPhase('confirm-unsaved');
      }
    } catch (err) {
      setErrorMsg(String(err));
      setPhase('error');
    }
  };

  const handleReset = () => {
    setPhase('select');
    setErrorMsg('');
  };

  const refOptions = [
    ...branches.map((b) => ({
      label: (
        <Space size={4}>
          <BranchesOutlined />
          <span style={{ fontSize: 12 }}>{b.name}</span>
          {b.current && <Tag color="blue" style={{ fontSize: 10, padding: '0 4px' }}>current</Tag>}
        </Space>
      ),
      value: b.name,
    })),
    ...tags.map((t) => ({
      label: (
        <Space size={4}>
          <span style={{ fontSize: 11, opacity: 0.7 }}>tag</span>
          {t.name}
        </Space>
      ),
      value: t.name,
    })),
  ];

  const footer = (
    <Space>
      <Button onClick={onClose} disabled={phase === 'merging'}>
        Cancel
      </Button>
      {phase === 'select' && (
        <Button
          type="primary"
          disabled={!selectedRef || isLoadingRefs}
          onClick={() => void handleMerge()}
        >
          Merge
        </Button>
      )}
      {phase === 'confirm-unsaved' && (
        <>
          <Button onClick={handleReset}>Back</Button>
          <Button
            type="primary"
            onClick={() => void handleConfirmMerge(selectedRef!)}
            loading={false}
          >
            Continue Anyway
          </Button>
        </>
      )}
      {phase === 'error' && <Button onClick={handleReset}>Back</Button>}
    </Space>
  );

  return (
    <>
      {contextHolder}
      <Modal
        open={open}
        title={`Merge from Branch — ${ns.name}`}
        onCancel={onClose}
        footer={footer}
        closable={phase !== 'merging'}
        maskClosable={false}
        destroyOnClose
        width={500}
        afterClose={handleReset}
      >
        {refsError && (
          <Alert
            type="error"
            message="Could not list branches"
            description={String(refsError)}
            showIcon
            style={{ marginBottom: 12 }}
          />
        )}

        {phase === 'select' && (
          <>
            <div style={{ marginBottom: 8, fontSize: 12 }}>
              Select a branch or tag to merge into <strong>{ns.name}</strong>:
            </div>
            {isLoadingRefs ? (
              <Spin size="small" />
            ) : (
              <Select
                showSearch
                placeholder="Select branch or tag…"
                style={{ width: '100%' }}
                options={refOptions}
                value={selectedRef ?? undefined}
                onChange={(v) => setSelectedRef(v)}
                filterOption={(input, option) =>
                  String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                }
                autoFocus
              />
            )}
          </>
        )}

        {phase === 'confirm-unsaved' && (
          <Alert
            type="warning"
            message="Unsaved Changes Detected"
            description={`The live database content for namespace '${ns.name}' differs from the files on disk. This may mean you have unsaved changes in the current session. Merging will incorporate the branch content into the live database. Do you want to continue?`}
            showIcon
          />
        )}

        {phase === 'merging' && (
          <Space>
            <Spin size="small" />
            <span>Applying union merge from '{selectedRef}'…</span>
          </Space>
        )}

        {phase === 'error' && (
          <Alert
            type="error"
            message="Merge failed"
            description={errorMsg.replace(/^Error invoking remote method '[^']+': (Error: )?/i, '').replace(/^Error:\s*/i, '')}
            showIcon
          />
        )}
      </Modal>
    </>
  );
}
