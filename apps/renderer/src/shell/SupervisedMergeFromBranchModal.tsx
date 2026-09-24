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
 * SupervisedMergeFromBranchModal — UC-15: preview-first merge from a git branch.
 *
 * Flow:
 *  1. User selects a branch or tag from the repository.
 *  2. Modal calls supervisedMergeFromBranchPrepare — checks out ria-data/ to a
 *     temp dir, computes a semantic diff, and returns a DiffSummary.
 *  3. User reviews the full diff (DiffSummaryBar + DiffResultView), optionally
 *     cherry-picks individual changes.
 *  4. Accept → diff.applyMerge is called with the selected changes; temp dir is
 *     cleaned up; caches are invalidated.
 *  5. Cancel / close → temp dir is cleaned up; diff store is reset.
 *
 * In-flight deduplication: a module-level Map prevents React StrictMode
 * double-invocation from firing two IPC calls for the same (namespace, branchRef).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
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
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  MergeCellsOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiffSummary, MergeResult, SupervisedMergePrepareResult } from '@riacore/app-contracts';
import type { BranchInfo, TagInfo } from '@riacore/git-service';
import { api } from '../api/riacore';
import { useDiffStore } from '../store/diffStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useDiffResult, useExportDiffHtml } from '../hooks/useDiffMutations';
import { DiffSummaryBar } from '../modules/diff/DiffSummaryBar';
import { DiffResultView } from '../modules/diff/DiffResultView';
import { invalidateAfterContentChange } from '../hooks/workspaceCacheReset';

const { useToken } = theme;
const { Text } = Typography;

// ── Module-level in-flight cache ──────────────────────────────────────────────
// Prevents React StrictMode double-invocation from firing two IPC calls for the
// same (namespace + branchRef) key. The second invocation subscribes to the
// existing in-flight promise rather than starting a new one.
const inFlightPrepare = new Map<string, Promise<SupervisedMergePrepareResult>>();

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | { kind: 'branch_select' }
  | { kind: 'loading' }
  | { kind: 'up_to_date'; resolvedShortHash: string }
  | { kind: 'diff_ready'; diffSummary: DiffSummary; resolvedCommitHash: string; resolvedShortHash: string; tempDir: string; syncWarning?: string }
  | { kind: 'applying' }
  | { kind: 'done'; mergeResult: MergeResult }
  | { kind: 'error'; message: string };

interface AuthoredNsCardData {
  id: string;
  name: string;
  standard: string;
  owningApplication: string;
}

interface Props {
  ns: AuthoredNsCardData;
  workingDir: string;
  repoDir: string;
  open: boolean;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SupervisedMergeFromBranchModal({ ns, workingDir, repoDir, open, onClose }: Props) {
  const { token } = useToken();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const exportHtml = useExportDiffHtml();

  const {
    setLeftNs,
    setRightNs,
    setActiveSummary,
    setMode,
    setMergeDirection,
    selectedChangeIds,
    selectAllChanges,
    reset: resetDiffStore,
  } = useDiffStore();

  const [phase, setPhase] = useState<Phase>({ kind: 'branch_select' });
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  // Track tempDir so cleanup can happen even if phase state is stale
  const tempDirRef = useRef<string | null>(null);

  // ── Branch / tag queries ───────────────────────────────────────────────────

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

  const currentBranchQuery = useQuery<string | null>({
    queryKey: ['git.getCurrentBranch', repoDir],
    queryFn: () => api.git.getCurrentBranch(repoDir),
    enabled: open && !!repoDir,
  });

  // Pre-select the current branch once it loads
  useEffect(() => {
    if (currentBranchQuery.data && !selectedRef) {
      setSelectedRef(currentBranchQuery.data);
    }
  }, [currentBranchQuery.data, selectedRef]);

  const branches: BranchInfo[] = branchesQuery.data ?? [];
  const tags: TagInfo[] = tagsQuery.data ?? [];
  const isLoadingRefs = branchesQuery.isLoading || tagsQuery.isLoading;
  const refsError = branchesQuery.error ?? tagsQuery.error;

  // ── Loading phase — in-flight deduplication ────────────────────────────────

  useEffect(() => {
    if (phase.kind !== 'loading') return;
    if (!selectedRef) return;

    const cacheKey = ns.id + ':' + selectedRef;

    let callPromise = inFlightPrepare.get(cacheKey);
    if (!callPromise) {
      callPromise = api.namespaces.supervisedMergeFromBranchPrepare(
        ns.id,
        repoDir,
        selectedRef,
        workingDir,
      );
      inFlightPrepare.set(cacheKey, callPromise);
      callPromise.finally(() => inFlightPrepare.delete(cacheKey));
    }

    let cancelled = false;
    resetDiffStore();

    callPromise
      .then((result) => {
        if (cancelled) {
          // Modal was closed while in-flight — clean up the temp dir
          api.namespaces.supervisedMergeCleanup(result.tempDir).catch(console.warn);
          return;
        }
        tempDirRef.current = result.tempDir;

        // If the branch is identical to the live namespace, show an "up to date"
        // message instead of an empty diff review screen.
        const totalChanges =
          result.diffSummary.addedNodesCount +
          result.diffSummary.deletedNodesCount +
          result.diffSummary.modifiedNodesCount +
          result.diffSummary.addedEdgesCount +
          result.diffSummary.deletedEdgesCount +
          result.diffSummary.modifiedEdgesCount;

        if (totalChanges === 0) {
          // Nothing to merge — clean up the temp dir and go straight to up_to_date.
          api.namespaces.supervisedMergeCleanup(result.tempDir).catch(console.warn);
          tempDirRef.current = null;
          setPhase({ kind: 'up_to_date', resolvedShortHash: result.resolvedShortHash });
          return;
        }

        // Pre-populate the diff store so DiffSummaryBar / DiffResultView work
        setMode('two-way');
        setLeftNs(ns.id);
        setRightNs(result.tempDir);
        setMergeDirection('right-into-left');
        setActiveSummary(result.diffSummary);

        setPhase({
          kind: 'diff_ready',
          diffSummary: result.diffSummary,
          resolvedCommitHash: result.resolvedCommitHash,
          resolvedShortHash: result.resolvedShortHash,
          tempDir: result.tempDir,
          syncWarning: result.syncWarning,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setPhase({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, selectedRef]);

  // ── Pre-select all changes once the full diff result is available ───────────

  const diffId = phase.kind === 'diff_ready' ? phase.diffSummary.diffId : null;
  const { data: fullDiffResult } = useDiffResult(diffId);

  useEffect(() => {
    if (!fullDiffResult) return;
    // Collect all stableIds from every change category
    // Edge keys must use '::' separator to match the backend's merge-service format
    const allIds: string[] = [
      ...fullDiffResult.addedNodes.map(n => n.stableId),
      ...fullDiffResult.deletedNodes.map(n => n.stableId),
      ...fullDiffResult.modifiedNodes.map(n => n.stableId),
      ...fullDiffResult.addedEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
      ...fullDiffResult.deletedEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
      ...fullDiffResult.modifiedEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
      ...fullDiffResult.addedCrossNsEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
      ...fullDiffResult.deletedCrossNsEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
      ...fullDiffResult.modifiedCrossNsEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
    ];
    if (allIds.length > 0 && selectedChangeIds.size === 0) {
      selectAllChanges(allIds);
    }
  }, [fullDiffResult, selectAllChanges, selectedChangeIds.size]);

  // ── Cleanup helper ─────────────────────────────────────────────────────────

  const cleanup = async (tempDir: string) => {
    try {
      await api.namespaces.supervisedMergeCleanup(tempDir);
    } catch (err) {
      console.warn('[SupervisedMergeFromBranchModal] cleanup failed:', err);
    }
    tempDirRef.current = null;
  };

  // ── Accept changes ─────────────────────────────────────────────────────────

  const handleAccept = async () => {
    if (phase.kind !== 'diff_ready') return;
    const { diffSummary, tempDir } = phase;

    setPhase({ kind: 'applying' });
    try {
      // Send selected IDs to apply only checked items.
      // Empty selection after pre-selecting all means user unchecked everything — apply nothing.
      const selectedIds = Array.from(selectedChangeIds);
      if (selectedIds.length === 0) {
        setPhase({ kind: 'diff_ready', diffSummary, resolvedCommitHash: phase.resolvedCommitHash, resolvedShortHash: phase.resolvedShortHash, tempDir, syncWarning: phase.syncWarning });
        return;
      }

      const mergeResult = await api.diff.applyMerge(
        diffSummary.diffId,
        ns.id,
        'right-into-left',
        workingDir,
        selectedIds,
      );

      await cleanup(tempDir);
      // Merged content reassigns node IDs — refresh every DB-content cache
      // (see hooks/workspaceCacheReset.ts).
      await invalidateAfterContentChange(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      // Clear all node-ID-bearing Zustand state — merged content reassigns node
      // IDs so any persisted selectedElement or navigation entry is now stale.
      useWorkspaceStore.getState().resetWorkspaceState();

      setPhase({ kind: 'done', mergeResult });
    } catch (err) {
      // Still clean up even on error
      await cleanup(tempDir);
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ── Cancel / close ─────────────────────────────────────────────────────────

  const handleCancel = async () => {
    const tempDir = tempDirRef.current;
    if (tempDir) await cleanup(tempDir);
    resetDiffStore();
    onClose();
  };

  const handleClose = () => {
    resetDiffStore();
    onClose();
  };

  // ── Export the change set as an archivable HTML document ───────────────────

  const handleExportHtml = async () => {
    if (phase.kind !== 'diff_ready') return;

    // Filename carries the namespace, branch and date so archived reports stay
    // distinguishable without opening them.
    const stamp = new Date().toISOString().slice(0, 10);
    const safeRef = (selectedRef ?? 'branch').replace(/[^\w.-]+/g, '-');
    const defaultName = `${ns.name}-changes-${safeRef}-${stamp}.html`;

    const outputPath = await api.dialog.saveFile({
      title: 'Export Change Set',
      defaultPath: defaultName,
      filters: [{ name: 'HTML document', extensions: ['html'] }],
    });
    if (!outputPath) return; // user cancelled

    try {
      const result = await exportHtml.mutateAsync({
        diffId: phase.diffSummary.diffId,
        outputPath,
        targetNamespace: ns.name,
        sourceRef: selectedRef ?? undefined,
        sourceCommit: phase.resolvedShortHash,
        selectedChangeIds: Array.from(selectedChangeIds),
      });
      message.success(`Change set exported to ${result.outputPath}`);
    } catch (err) {
      message.error(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // ── Preview Changes ────────────────────────────────────────────────────────

  const handlePreviewChanges = () => {
    if (!selectedRef) return;
    setPhase({ kind: 'loading' });
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  const isWorking = phase.kind === 'loading' || phase.kind === 'applying';

  const branchOptions = branches.map((b) => ({
    label: (
      <Space size={4}>
        <BranchesOutlined />
        {b.name}
        {b.current && <span style={{ opacity: 0.5 }}>(current)</span>}
      </Space>
    ),
    value: b.name,
  }));

  const tagOptions = tags.map((t) => ({
    label: (
      <Space size={4}>
        <TagOutlined />
        {t.name}
      </Space>
    ),
    value: t.name,
  }));

  const selectOptions = [
    ...(branchOptions.length > 0
      ? [{ label: <span><BranchesOutlined /> Branches</span>, options: branchOptions }]
      : []),
    ...(tagOptions.length > 0
      ? [{ label: <span><TagOutlined /> Tags</span>, options: tagOptions }]
      : []),
  ];

  const title = (
    <Space size={8}>
      <MergeCellsOutlined style={{ color: token.colorPrimary }} />
      <span>Supervised Merge from Branch — {ns.name}</span>
    </Space>
  );

  return (
    <Modal
      open={open}
      title={title}
      width="90vw"
      style={{ top: 20 }}
      styles={{
        body: {
          height: 'calc(90vh - 120px)',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
        },
      }}
      closable={!isWorking}
      maskClosable={false}
      onCancel={handleCancel}
      footer={null}
      destroyOnClose
    >
      {/* ── Branch select phase ──────────────────────────────────────────── */}
      {phase.kind === 'branch_select' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 13 }}>
            Select a branch or tag to preview merging into <strong>{ns.name}</strong>:
          </div>

          {refsError && (
            <Alert
              type="error"
              showIcon
              message="Could not load branches and tags"
              description={String(refsError)}
            />
          )}

          {isLoadingRefs ? (
            <Spin size="small" />
          ) : (
            <Select
              showSearch
              placeholder="Select branch or tag…"
              style={{ width: '100%' }}
              options={selectOptions}
              value={selectedRef ?? undefined}
              onChange={(v) => setSelectedRef(v)}
              filterOption={(input, option) =>
                String((option as { value?: string })?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              disabled={!!refsError}
              autoFocus
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
            <Space>
              <Button onClick={handleClose}>Cancel</Button>
              <Button
                type="primary"
                disabled={!selectedRef || isLoadingRefs || !!refsError}
                onClick={handlePreviewChanges}
              >
                Preview Changes
              </Button>
            </Space>
          </div>
        </div>
      )}

      {/* ── Loading phase ────────────────────────────────────────────────── */}
      {phase.kind === 'loading' && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: 40,
          }}
        >
          <Spin size="large" />
          <Text type="secondary" style={{ fontSize: 14 }}>
            Checking out branch and computing diff…
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Branch: <strong>{selectedRef}</strong> → <em>{ns.name}</em>
          </Text>
        </div>
      )}

      {/* ── Up-to-date phase ─────────────────────────────────────────────── */}
      {phase.kind === 'up_to_date' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="Already up to date"
            description={
              <span>
                <strong>{ns.name}</strong> already contains all changes from branch{' '}
                <strong>{selectedRef}</strong>{' '}
                <span style={{ opacity: 0.6 }}>@ {phase.resolvedShortHash}</span>.
                Nothing to merge.
              </span>
            }
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="primary" onClick={handleClose}>Close</Button>
          </div>
        </div>
      )}

      {/* ── Error phase ──────────────────────────────────────────────────── */}
      {phase.kind === 'error' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Alert
            type="error"
            showIcon
            icon={<CloseCircleOutlined />}
            message="Could Not Load Branch Data"
            description={phase.message}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              onClick={() => {
                setPhase({ kind: 'branch_select' });
              }}
            >
              Try Another Branch
            </Button>
            <Button onClick={handleClose}>Close</Button>
          </div>
        </div>
      )}

      {/* ── Done phase ───────────────────────────────────────────────────── */}
      {phase.kind === 'done' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="Merge Applied"
            description={
              <span>
                Changes from <strong>{selectedRef}</strong> have been merged into{' '}
                <strong>{ns.name}</strong>.{' '}
                Nodes added: {phase.mergeResult.nodesAdded},{' '}
                nodes modified: {phase.mergeResult.nodesModified},{' '}
                edges added: {phase.mergeResult.edgesAdded},{' '}
                edges modified: {phase.mergeResult.edgesModified}.
              </span>
            }
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              type="primary"
              onClick={() => {
                resetDiffStore();
                onClose();
              }}
            >
              Close
            </Button>
          </div>
        </div>
      )}

      {/* ── Diff review phase (diff_ready + applying) ────────────────────── */}
      {(phase.kind === 'diff_ready' || phase.kind === 'applying') && (
        <>
          {/* Review header */}
          <div
            style={{
              padding: '10px 16px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexShrink: 0,
              flexWrap: 'wrap',
            }}
          >
            <Text strong style={{ fontSize: 13 }}>Reviewing:</Text>
            <Space size={8}>
              <Tag color="blue" style={{ fontSize: 12 }}>
                Target: {ns.name}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>←</Text>
              <Tag color="gold" style={{ fontSize: 12 }}>
                Branch: {selectedRef}
                {phase.kind === 'diff_ready' && (
                  <span style={{ opacity: 0.7, marginLeft: 4 }}>
                    @ {phase.resolvedShortHash}
                  </span>
                )}
              </Tag>
            </Space>
          </div>

          {/* Sync warning */}
          {phase.kind === 'diff_ready' && phase.syncWarning && (
            <div
              style={{
                padding: '8px 16px',
                flexShrink: 0,
              }}
            >
              <Alert
                type="warning"
                showIcon
                message="Unsaved Changes Detected"
                description={phase.syncWarning}
                banner={false}
              />
            </div>
          )}

          {/* Summary bar */}
          {phase.kind === 'diff_ready' && (
            <div
              style={{
                padding: '8px 16px',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                flexShrink: 0,
              }}
            >
              <DiffSummaryBar summary={phase.diffSummary} />
            </div>
          )}

          {/* Main diff result area. minHeight: 0 lets this shrink to the space
              the fixed header/summary/footer leave over, so a long change list
              scrolls inside the list body instead of overflowing the modal body
              and being clipped. */}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {phase.kind === 'applying' ? (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                }}
              >
                <Spin />
                <Text type="secondary">Applying changes to {ns.name}…</Text>
              </div>
            ) : (
              <DiffResultView />
            )}
          </div>

          {/* Cherry-pick info — shown when user has deselected edges */}
          {phase.kind === 'diff_ready' && fullDiffResult && (() => {
            const allEdgeKeys = [
              ...fullDiffResult.addedEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
              ...fullDiffResult.deletedEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
              ...fullDiffResult.modifiedEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
              ...fullDiffResult.addedCrossNsEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
              ...fullDiffResult.deletedCrossNsEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
              ...fullDiffResult.modifiedCrossNsEdges.map(e => `${e.sourceStableId}::${e.targetStableId}::${e.relationshipType}`),
            ];
            const hasDeselectedEdges = allEdgeKeys.some(k => !selectedChangeIds.has(k));
            if (!hasDeselectedEdges) return null;
            return (
              <Alert
                type="info"
                showIcon
                banner
                style={{ flexShrink: 0, fontSize: 12 }}
                message="Some edges are deselected — this may leave nodes without relationships."
                description="Valid use cases: • A new malfunction should be merged but not yet linked to a structural element (occurs_at). • Task attribute changes are accepted but the new mapping of that task to a different risk rating is rejected. • A cross-namespace binding (e.g. propagates_to) is not yet agreed upon and should be reviewed separately."
              />
            );
          })()}

          {/* Footer */}
          {phase.kind === 'diff_ready' && (
            <div
              style={{
                padding: '12px 16px',
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                {(() => {
                  const total = phase.diffSummary.addedNodesCount + phase.diffSummary.deletedNodesCount + phase.diffSummary.modifiedNodesCount
                    + phase.diffSummary.addedEdgesCount + phase.diffSummary.deletedEdgesCount + phase.diffSummary.modifiedEdgesCount;
                  if (selectedChangeIds.size === 0) return 'No items selected — nothing will be merged. Check items to include them.';
                  if (selectedChangeIds.size >= total) return `All ${total} change(s) selected — everything will be merged. Uncheck items to exclude them.`;
                  return `${selectedChangeIds.size} of ${total} change(s) selected — only checked items will be merged.`;
                })()}
              </Text>
              <Space>
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => void handleExportHtml()}
                  loading={exportHtml.isPending}
                  disabled={phase.kind !== 'diff_ready'}
                  title="Save this change set as a standalone HTML document for archiving"
                >
                  Export HTML…
                </Button>
                <Button
                  icon={<CloseCircleOutlined />}
                  onClick={handleCancel}
                  disabled={phase.kind !== 'diff_ready'}
                >
                  Cancel
                </Button>
                <Button
                  type="primary"
                  icon={<MergeCellsOutlined />}
                  onClick={() => void handleAccept()}
                  disabled={phase.kind !== 'diff_ready' || selectedChangeIds.size === 0}
                >
                  Accept Changes → {ns.name}
                </Button>
              </Space>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
