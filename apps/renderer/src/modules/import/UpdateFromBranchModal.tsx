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
 * UpdateFromBranchModal — pick a git branch or tag to re-run an import from.
 *
 * This modal is a branch/tag SELECTOR only. When the user confirms, it hands the
 * resolved repository root and selected ref back to the parent via `onRun`, which
 * runs the import through the same mutation + post-import flow as the regular Run
 * button (impact analysis, orphan reconnection, auto-persist). "Run update from
 * branch" therefore behaves exactly like clicking Run after pointing the source
 * at the branch files — the only difference is where the files come from.
 *
 * The git repository is auto-detected from the import source's project_dir:
 *  - If project_dir is not inside any git repo → immediate error, no selector.
 *  - If project_dir is inside a git repo → show repo name + list its branches.
 * This allows source data from a different repo than the RIA workspace.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import {
  BranchesOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { BranchInfo, TagInfo } from '@riacore/git-service';
import type { ImportSourceInfo } from '@riacore/app-contracts';
import { api } from '../../api/riacore.js';

const { useToken } = theme;
const { Text } = Typography;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the last path component as a human-readable repo name. */
function repoNameFromPath(repoRoot: string): string {
  // Handle both forward and backward slashes
  const parts = repoRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? repoRoot;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** State of the source-repo auto-detection step (runs on modal open). */
type RepoDetection =
  | { status: 'loading' }
  | { status: 'no_project_dir' }
  | { status: 'not_in_repo'; projectDir: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; repoRoot: string; repoName: string };

export interface UpdateFromBranchModalProps {
  source: ImportSourceInfo;
  open: boolean;
  onClose: () => void;
  /**
   * Called when the user confirms a ref. The parent runs the import (via
   * useRunImportSourceAtRefMutation) and shows the impact analysis, exactly like
   * the Run button. `repoDir` is the auto-detected repository root of the source.
   */
  onRun: (repoDir: string, ref: string) => void;
}

interface RefOption {
  label: string;
  value: string;
  type: 'branch' | 'tag';
  current?: boolean;
  imported?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function UpdateFromBranchModal({
  source,
  open,
  onClose,
  onRun,
}: UpdateFromBranchModalProps) {
  const { token } = useToken();

  const [selectedRef, setSelectedRef] = useState<string | undefined>(undefined);

  // ── Repo detection — resolves on every modal open ────────────────────────
  const [repoDetection, setRepoDetection] = useState<RepoDetection>({ status: 'loading' });

  // Detect the source data repo when the modal opens
  useEffect(() => {
    if (!open) return;
    setRepoDetection({ status: 'loading' });
    setSelectedRef(source.lastImportBranch ?? undefined);
    let cancelled = false;

    (async () => {
      try {
        const configView = await api.imports.getConfig(source.sourceId);
        if (cancelled) return;
        // Use the backend-resolved absolute path: the stored project_dir may be
        // workspace-relative and the renderer has no working directory to anchor it.
        const projectDir = configView.projectDirAbsolute || configView.projectDir;
        if (!projectDir) {
          setRepoDetection({ status: 'no_project_dir' });
          return;
        }
        const repoRoot = await api.git.getRepoRoot(projectDir);
        if (cancelled) return;
        if (!repoRoot) {
          setRepoDetection({ status: 'not_in_repo', projectDir });
          return;
        }
        setRepoDetection({ status: 'ready', repoRoot, repoName: repoNameFromPath(repoRoot) });
      } catch (err) {
        if (!cancelled) {
          setRepoDetection({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [open, source.sourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const repoDir = repoDetection.status === 'ready' ? repoDetection.repoRoot : '';

  // Query branches — only when repo is detected
  const branchesQuery = useQuery({
    queryKey: ['git', 'branches', repoDir],
    queryFn: () => api.git.listBranches(repoDir),
    enabled: open && repoDetection.status === 'ready' && !!repoDir,
  });

  // Query tags — only when repo is detected
  const tagsQuery = useQuery({
    queryKey: ['git', 'tags', repoDir],
    queryFn: () => api.git.listTags(repoDir),
    enabled: open && repoDetection.status === 'ready' && !!repoDir,
  });

  // ── Build select options ─────────────────────────────────────────────────
  const options: RefOption[] = [
    ...(branchesQuery.data ?? []).map((b: BranchInfo): RefOption => ({
      label: b.name,
      value: b.name,
      type: 'branch',
      // `current` is the repo's checked-out branch (from BranchInfo.current).
      // Keep an `imported` flag to indicate the branch previously used to
      // import the data for this source (source.lastImportBranch).
      current: !!b.current,
      imported: b.name === source.lastImportBranch,
    })),
    ...(tagsQuery.data ?? []).map((t: TagInfo): RefOption => ({
      label: t.name,
      value: t.name,
      type: 'tag',
    })),
  ];

  // ── Confirm ────────────────────────────────────────────────────────────────
  const handleConfirm = () => {
    if (!selectedRef || repoDetection.status !== 'ready') return;
    onRun(repoDetection.repoRoot, selectedRef);
    onClose();
  };

  // ── Computed modal state ─────────────────────────────────────────────────
  const isLoadingRefs = branchesQuery.isLoading || tagsQuery.isLoading;
  const isRepoReady = repoDetection.status === 'ready';

  const repoName = repoDetection.status === 'ready' ? repoDetection.repoName : null;
  const titleText = repoName ? `Run update from branch — ${repoName}` : 'Run update from branch';

  // ── Footer ───────────────────────────────────────────────────────────────
  const renderFooter = () => (
    <Space>
      <Button onClick={onClose}>Cancel</Button>
      <Button
        type="primary"
        disabled={!selectedRef || !isRepoReady}
        onClick={handleConfirm}
      >
        Run update from branch
      </Button>
    </Space>
  );

  // ── Body ─────────────────────────────────────────────────────────────────
  const renderBody = () => {
    // Repo detection states (shown before anything else)
    if (repoDetection.status === 'loading') {
      return (
        <Space direction="vertical" align="center" style={{ width: '100%', padding: '24px 0' }}>
          <Spin size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>Detecting source repository…</Text>
        </Space>
      );
    }

    if (repoDetection.status === 'no_project_dir') {
      return (
        <Alert
          type="error"
          showIcon
          message="No source path configured"
          description="This import source has no project_dir configured. Configure the source path before using branch-based updates."
        />
      );
    }

    if (repoDetection.status === 'not_in_repo') {
      return (
        <Alert
          type="error"
          showIcon
          message="Source data is not in a git repository"
          description={
            <>
              The import source data at <Text code style={{ fontSize: 11 }}>{repoDetection.projectDir}</Text> is not
              managed in a git repository. Branch-based updates require the source data to be tracked in git.
            </>
          }
        />
      );
    }

    if (repoDetection.status === 'error') {
      return (
        <Alert
          type="error"
          showIcon
          message="Failed to detect source repository"
          description={repoDetection.message}
        />
      );
    }

    return renderRefSelector();
  };

  const renderRefSelector = () => (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Text style={{ fontSize: 13 }}>
        Select a branch or tag to load input data from:
      </Text>
      {isLoadingRefs ? (
        <Spin size="small" />
      ) : branchesQuery.isError || tagsQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="Failed to load branches and tags"
          description={String(branchesQuery.error ?? tagsQuery.error ?? 'Unknown error')}
        />
      ) : (
        <Select
          showSearch
          placeholder="Search branches and tags…"
          style={{ width: '100%' }}
          value={selectedRef}
          onChange={(v) => setSelectedRef(v)}
          optionFilterProp="searchValue"
          autoFocus
          filterOption={(input, option) => {
            const searchValue = (option?.searchValue as string)?.toLowerCase() || '';
            return searchValue.includes(input.toLowerCase());
          }}
          options={[
            ...(options.filter(o => o.type === 'branch').length > 0 ? [{
              label: <span style={{ fontSize: 11, color: token.colorTextTertiary }}>Branches</span>,
              options: options.filter(o => o.type === 'branch').map(o => ({
                label: (
                  <Space size={4}>
                    <BranchesOutlined style={{ color: token.colorPrimary, fontSize: 12 }} />
                    <span style={{ fontSize: 12 }}>{o.label}</span>
                    {o.current && <Tag color="blue" style={{ fontSize: 10, padding: '0 4px' }}>current</Tag>}
                    {o.imported && !o.current && (
                      <Tag color="default" style={{ fontSize: 10, padding: '0 4px' }}>imported</Tag>
                    )}
                  </Space>
                ),
                value: o.value,
                searchValue: o.label,
              })),
            }] : []),
            ...(options.filter(o => o.type === 'tag').length > 0 ? [{
              label: <span style={{ fontSize: 11, color: token.colorTextTertiary }}>Tags</span>,
              options: options.filter(o => o.type === 'tag').map(o => ({
                label: (
                  <Space size={4}>
                    <TagOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />
                    <span style={{ fontSize: 12 }}>{o.label}</span>
                  </Space>
                ),
                value: o.value,
                searchValue: o.label,
              })),
            }] : []),
          ] as any}
          notFoundContent={
            <Text type="secondary" style={{ fontSize: 12 }}>No branches or tags found</Text>
          }
        />
      )}
      <Text type="secondary" style={{ fontSize: 11 }}>
        Source: <strong>{source.name}</strong> → namespace <strong>{source.targetNamespace}</strong>
      </Text>
      <Text type="secondary" style={{ fontSize: 11 }}>
        Runs the importer against the selected ref and shows the same impact
        analysis as a normal import run.
      </Text>
    </Space>
  );

  return (
    <Modal
      title={titleText}
      open={open}
      onCancel={onClose}
      maskClosable={false}
      width={480}
      footer={renderFooter()}
      destroyOnClose
    >
      {renderBody()}
    </Modal>
  );
}
