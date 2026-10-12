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
import { useState } from 'react';
import { App, Alert, Button, Modal, Space, Tag, Typography } from 'antd';
import { BranchesOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import type { SnapshotDriftInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useWorkspaceState, isDbOpen } from '../hooks/useWorkspaceState';
import { usePersistorLoadMutation } from '../hooks/useRiacoreMutations';
import { useSnapshotDrift, useRefreshSnapshotDrift } from '../hooks/useSnapshotDrift';
import { SnapshotDriftDiagram } from './SnapshotDriftDiagram';
import { useCloseWorkspaceMutation } from '../hooks/useCloseWorkspaceMutation';
import { useLifecycleHudStore } from '../store/lifecycleHudStore';
import { useAutoSaveStatusStore } from '../store/autoSaveStatusStore';

const { Paragraph, Text } = Typography;

/** Renders the changed scope as chips so the user can see exactly what moved. */
function ChangedScope({ drift }: { drift: SnapshotDriftInfo }) {
  return (
    <Space size={[4, 4]} wrap>
      {drift.changedNamespaces.map((ns) => (
        <Tag key={ns} color="orange">{ns}</Tag>
      ))}
      {drift.universeChanged && (
        <Tag color="orange">Connections, layout &amp; views</Tag>
      )}
    </Space>
  );
}

/**
 * The Store-or-Load decision shown when `ria-data/` has changed underneath an
 * open workspace — typically a git branch switch, but equally a pull, a reset, a
 * restore from backup, or a store from another window or the CLI.
 *
 * Both answers are legitimate (docs/coreSpecs/RiaDataChangeDetection.md §4.4):
 * the user may have switched branch deliberately in order to port this analysis
 * across, or may simply have forgotten the app was open.
 *
 * Driven reactively off the drift query rather than fired once on a transition,
 * so in a second RiaCore window it self-resolves: the first window's decision
 * rewrites `ria-data/` and re-stamps the baseline, so the next poll here reports
 * no drift and the dialog closes on its own. No cross-window coordination.
 *
 * The decision cannot be postponed while the workspace is open, because every
 * save is refused until it is answered — so a "decide later" button produced a
 * stream of refused saves rather than a usable app. "Close workspace" is the
 * escape hatch: it writes nothing, and the next open reconciles via Case D.
 */
export function SnapshotDriftDialog() {
  const { message } = App.useApp();
  const state = useWorkspaceState();
  const workingDir = state.phase !== 'no_workspace' ? state.workingDir : null;

  const { data: drift } = useSnapshotDrift();
  const refreshDrift = useRefreshSnapshotDrift();
  const loadMutation = usePersistorLoadMutation(workingDir);

  const closeWorkspace = useCloseWorkspaceMutation();
  const [busy, setBusy] = useState<null | 'store' | 'load' | 'close'>(null);

  if (!drift?.drifted || !workingDir) return null;

  const open = isDbOpen(state);

  const logActivity = (text: string, kind: 'success' | 'error') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    useLifecycleHudStore.getState().logActivity(`${ts} · ${text}`, kind, workingDir);
  };

  /** Port this session's content onto whatever is checked out now. */
  const handleStore = async () => {
    setBusy('store');
    try {
      await api.persistor.store({ workingDir, allowSnapshotMismatch: true });
      useAutoSaveStatusStore.getState().setStatus('saved');
      logActivity('Stored this session to ria-data (overwrote the changed files)', 'success');
      message.success('Saved this session to ria-data');
      // The store re-stamped the baseline, so the next poll reports no drift.
      await refreshDrift();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity(`Could not store to ria-data: ${msg}`, 'error');
      message.error(`Could not store to ria-data: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  /** Discard DB-only content and adopt the files currently on disk. */
  const handleLoad = async () => {
    setBusy('load');
    try {
      await loadMutation.mutateAsync();
      useAutoSaveStatusStore.getState().reset();
      logActivity('Loaded ria-data from disk', 'success');
      message.success('Loaded the analysis from ria-data');
      await refreshDrift();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity(`Could not load from ria-data: ${msg}`, 'error');
      message.error(`Could not load from ria-data: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * The neutral exit. Writes nothing and adopts nothing; on the next open, Case D
   * reconciles the workspace against whatever is on disk.
   *
   * This replaces an earlier "Decide later" button, which looked harmless and was
   * not: deferring left the workspace open with saving refused, so every
   * subsequent edit produced another refused store. The decision cannot be
   * postponed while the workspace stays open — but it can be sidestepped by
   * closing it, which is a consistent state rather than a broken one.
   */
  const handleClose = async () => {
    setBusy('close');
    try {
      await closeWorkspace.mutateAsync();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`Could not close the workspace: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const branchesKnown = drift.dbBranch && drift.diskBranch && drift.dbBranch !== drift.diskBranch;
  const hasUnsaved = drift.dirtyNamespaces.length > 0;

  return (
    <Modal
      title={
        <Space>
          <ExclamationCircleOutlined style={{ color: '#d46b08' }} />
          The analysis files on disk have changed
        </Space>
      }
      open={open}
      // No dismissal: while the workspace is open and drifted, every save is
      // refused, so letting the dialog be waved away only produces a stream of
      // refused saves. "Close workspace" is the escape hatch instead.
      closable={false}
      maskClosable={false}
      keyboard={false}
      width={680}
      aria-label="Decide whether to store to or load from ria-data"
      /*
       * Load sits rightmost and carries the emphasis, because the overwhelmingly
       * common way to reach this dialog is a deliberate branch switch: the user
       * changed what is checked out and wants to work on it. Store is the
       * minority intent — porting this session's analysis onto a different
       * branch — and it was previously the primary purely because it is listed
       * first in the spec, which is not a reason.
       *
       * Except when there is unsaved work, where nothing is pre-selected
       * (§4.4). Load discards those namespaces, so emphasising it would be
       * nudging the user towards data loss; Store is the only action that keeps
       * them, but silently promoting it would make the default jump around for
       * reasons the user cannot see. Neither is primary, the Alert below
       * explains the trade, and the choice is left deliberate.
       */
      footer={
        <Space>
          <Button loading={busy === 'close'} disabled={busy !== null} onClick={handleClose}>
            Close workspace
          </Button>
          <Button
            loading={busy === 'store'}
            disabled={busy !== null}
            onClick={handleStore}
          >
            Store to ria-data
          </Button>
          <Button
            type={hasUnsaved ? 'default' : 'primary'}
            danger={hasUnsaved}
            loading={busy === 'load'}
            disabled={busy !== null}
            onClick={handleLoad}
          >
            Load from ria-data
          </Button>
        </Space>
      }
    >
      {branchesKnown ? (
        <Paragraph>
          <Space size={6}>
            <BranchesOutlined />
            <span>
              RiaCore has the analysis from <Text strong>{drift.dbBranch}</Text> open, but{' '}
              <Text strong>{drift.diskBranch}</Text> is now checked out.
            </span>
          </Space>
        </Paragraph>
      ) : (
        <Paragraph>
          The files in <Text code>ria-data/</Text> have changed since RiaCore loaded them — for
          example by a git checkout, pull or reset, by undoing uncommitted changes, or by another
          tool writing to the folder.
        </Paragraph>
      )}

      <SnapshotDriftDiagram
        dbBranch={drift.dbBranch}
        diskBranch={drift.diskBranch}
        dbCommit={drift.dbCommit}
        diskCommit={drift.diskCommit}
        openedAt={drift.openedAt}
        syncedAt={drift.syncedAt}
        syncedReason={drift.syncedReason}
        filesChangedAt={drift.filesChangedAt}
      />

      <Paragraph style={{ marginBottom: 4 }}>
        <Text type="secondary">Changed:</Text>
      </Paragraph>
      <Paragraph>
        <ChangedScope drift={drift} />
      </Paragraph>

      <Paragraph>
        Nothing has been overwritten. Saving stays paused until you choose, so this needs an answer
        before you carry on working.
      </Paragraph>

      {/* Listed in the same order as the footer buttons, likeliest first. */}
      <Paragraph style={{ marginBottom: 4 }}>
        <Text strong>Load from ria-data</Text> — replace what you have open with the files on disk.
        Use this if the change was expected and you just want to continue from it.
      </Paragraph>
      <Paragraph style={{ marginBottom: 4 }}>
        <Text strong>Store to ria-data</Text> — write the analysis you have open now over the files
        on disk. Use this to carry your work across to what is currently checked out. The change is
        left uncommitted for you to review.
      </Paragraph>
      <Paragraph>
        <Text strong>Close workspace</Text> — decide later. Nothing is written either way; reopening
        the workspace picks up whatever is on disk at that point.
      </Paragraph>

      {hasUnsaved && (
        <Alert
          type="warning"
          showIcon
          message="You have unsaved changes"
          description={
            <>
              Not yet written to disk:{' '}
              <Text strong>{drift.dirtyNamespaces.join(', ')}</Text>. Only{' '}
              <Text strong>Store to ria-data</Text> keeps them — Load and Close both discard them.
            </>
          }
        />
      )}

      <Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          See Help / Data Management for how ria-data and the database relate.
        </Text>
      </Paragraph>
    </Modal>
  );
}
