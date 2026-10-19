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

/**
 * Renders the changed scope as chips so the user can see exactly what moved.
 *
 * Every carrier the drift check compares needs a chip here. A carrier with no
 * chip produces the worst possible version of this dialog: a drift warning that
 * names nothing at all, because its own change list is the only non-empty one.
 * That is exactly what `sourcemasterChanged` did before it was added — a branch
 * switch touching only importer configuration lands with `changedNamespaces`
 * empty and `universeChanged` false.
 *
 * `meta_hash` has no chip on purpose: `detectDrift` deliberately excludes it, so
 * it can never be the reason this dialog is up.
 */
function ChangedScope({ drift }: { drift: SnapshotDriftInfo }) {
  return (
    <Space size={[4, 4]} wrap>
      {drift.changedNamespaces.map((ns) => (
        <Tag key={ns} color="orange">{ns}</Tag>
      ))}
      {drift.universeChanged && (
        <Tag color="orange">Connections, layout &amp; views</Tag>
      )}
      {/* The serialized import-source and import-run records. Worded to match
          `describeDrift`'s "import source configuration" rather than inventing a
          second name for the same layer — the CLI drift summary and the refusal
          message the user may have already seen both use that phrase. */}
      {drift.crossNamespaceChanged && (
        <Tag color="orange">Cross-namespace relations</Tag>
      )}
      {drift.sourcemasterChanged && (
        <Tag color="orange">Import source configuration</Tag>
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
 *
 * ## The unreadable-manifest path is not the same decision
 *
 * `drift.manifestUnreadable` means `ria-data/manifest.json` is present but does
 * not parse. Nothing on disk was compared, so every change list is empty — and
 * an empty change list reads as "nothing changed", the opposite of what
 * happened. More importantly the choice itself collapses: Load and
 * `repairManifest` both read the same unparseable file and throw, leaving Store
 * with `allowSnapshotMismatch` (which `storeImpl` already treats as
 * `forceFullReExport`, rewriting the manifest wholesale from the database) as
 * the only recovery that runs.
 *
 * So this path gets its own title, opening sentence, action descriptions and
 * emphasis, aligned with `describeDrift`'s dedicated backend message rather than
 * phrased a second way. `SnapshotDriftDiagram` makes the matching switch to its
 * single-sided shape.
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
      await loadMutation.mutateAsync({ acceptFileChanges: true });
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
  /**
   * `ria-data/manifest.json` is present but does not parse, so nothing on disk
   * was compared with anything. Every change list is empty, and the three-way
   * choice below collapses to one working answer. See `SnapshotDriftInfo`.
   */
  const unreadableManifest =
    drift.manifestUnreadable || drift.pendingDecision?.reason === 'manifest_unusable';
  /**
   * Domains the last workspace open could not resolve on its own — an S3 (the
   * files were edited without `manifest.json` being updated) or an S5 (manifest,
   * files and database all disagree).
   *
   * Routed through this dialog rather than a new one because it ends in the same
   * user choice. The questions differ: `drifted` asks "did the files move during
   * this session?", and this asks "did this database come from these files?" —
   * which is why the pending-decision case arrives with every change list empty
   * and `drifted` set only by the decision itself.
   *
   * `manifest_unusable` is excluded: it is already the unreadable-manifest panel
   * above, which says the same thing properly and offers the one recovery that
   * works.
   */
  const pendingDomains =
    drift.pendingDecision && drift.pendingDecision.reason !== 'manifest_unusable'
      ? drift.pendingDecision.domains
      : [];

  /*
   * Which button carries the emphasis — and what happens when the two rules
   * governing that disagree.
   *
   * Ordinary drift: Load, because a deliberate branch switch is overwhelmingly
   * the way in and adopting the files is what the user came for.
   *
   * Unsaved work: neither (§4.4). Load discards those namespaces, so
   * emphasising it nudges towards data loss; Store is the only lossless action,
   * but promoting it silently makes the default jump around for a reason the
   * user cannot see from the dialog.
   *
   * Unreadable manifest: Store, and this one overrides the unsaved-work rule
   * rather than being overridden by it. The two rules only appear to conflict:
   * the unsaved-work rule withholds emphasis from Store because the reason for
   * it would be invisible, and because Load is a live alternative that must not
   * be made to look wrong by comparison. Neither holds here. The reason is
   * stated outright in the copy below, and Load is not an alternative at all —
   * it parses the same unreadable file and throws, so it writes nothing and
   * discards nothing. Store is simultaneously the only action that runs and the
   * only one that keeps unsaved work, so the two rules in fact point the same
   * way once the "invisible reason" premise is removed.
   */
  const storeIsPrimary = unreadableManifest;
  const loadIsPrimary = !unreadableManifest && !hasUnsaved;

  const closeButton = (
    <Button key="close" loading={busy === 'close'} disabled={busy !== null} onClick={handleClose}>
      Close workspace
    </Button>
  );
  const storeButton = (
    <Button
      key="store"
      type={storeIsPrimary ? 'primary' : 'default'}
      loading={busy === 'store'}
      disabled={busy !== null}
      onClick={handleStore}
    >
      Store to ria-data
    </Button>
  );
  const loadButton = (
    <Button
      key="load"
      type={loadIsPrimary ? 'primary' : 'default'}
      danger={hasUnsaved}
      loading={busy === 'load'}
      disabled={busy !== null}
      onClick={handleLoad}
    >
      Load from ria-data
    </Button>
  );

  return (
    <Modal
      title={
        <Space>
          <ExclamationCircleOutlined
            style={{ color: unreadableManifest ? '#cf1322' : '#d46b08' }}
          />
          {/* Not "have changed" on the unreadable path: nothing is known to have
              changed, and claiming it would be the same falsehood the diagram
              refuses to draw. */}
          {unreadableManifest
            ? 'The analysis files on disk cannot be checked'
            : 'The analysis files on disk have changed'}
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
      aria-label={
        unreadableManifest
          ? 'The manifest in ria-data cannot be read. Store to ria-data is the only recovery'
          : 'Decide whether to store to or load from ria-data'
      }
      /*
       * Rightmost carries the emphasis, so the button order follows whichever
       * action is primary (see `storeIsPrimary` / `loadIsPrimary` above).
       *
       * Ordinarily that is Load, because the overwhelmingly common way to reach
       * this dialog is a deliberate branch switch: the user changed what is
       * checked out and wants to work on it. Store is the minority intent —
       * porting this session's analysis onto a different branch — and it was
       * previously the primary purely because it is listed first in the spec,
       * which is not a reason.
       *
       * On the unreadable-manifest path the two swap: Load cannot run at all, so
       * leaving it in the emphasised position would point the user at the one
       * action guaranteed to fail.
       *
       * Load keeps its button on that path rather than being removed or
       * disabled. It is honest about the shape of the situation — the same three
       * recoveries exist, one of them just does not work here, and the copy says
       * so — and a user who presses it gets the parser's own error, which is the
       * most direct description available of what is wrong with the file.
       */
      footer={
        <Space>
          {unreadableManifest
            ? [closeButton, loadButton, storeButton]
            : [closeButton, storeButton, loadButton]}
        </Space>
      }
    >
      {/* Three openings, not two with a clause bolted on — matching
          `describeDrift`, which special-cases the unreadable manifest for the
          same reason: the ordinary sentence ("the files have changed") states
          something that is neither true nor knowable here. */}
      {unreadableManifest ? (
        <Paragraph>
          RiaCore cannot read <Text code>ria-data/manifest.json</Text>. The file is there but does
          not parse — typically half-written, truncated, or left with conflict markers by a merge —
          so there is no way to tell whether the files on disk still match the analysis you have
          open.
        </Paragraph>
      ) : branchesKnown ? (
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
        /* Switches the diagram to its single-sided shape: with an unreadable
           manifest nothing was compared, so the two-sided comparison would
           assert an event that did not happen. */
        manifestUnreadable={drift.manifestUnreadable}
      />

      {/* Suppressed entirely when the manifest is unreadable. Every change list
          is empty there, so the chips would render as a "Changed:" heading over
          nothing — an empty row reads as "changed: no idea", which is a worse
          statement than the one the opening paragraph already made properly. */}
      {!unreadableManifest && (
        <>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text type="secondary">Changed:</Text>
          </Paragraph>
          <Paragraph>
            <ChangedScope drift={drift} />
          </Paragraph>
        </>
      )}

      {/* The open-time evaluation's findings, listed beside the changed-scope
          chips rather than instead of them: both can be present, and they are
          different facts. Each line names the domain and the state that put it
          there, because "sourcemaster/RIA_SRC_ImportRun.json (S3)" is something
          a user can act on and "something is out of sync" is not. */}
      {pendingDomains.length > 0 && (
        <>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text type="secondary">
              {drift.pendingDecision?.reason === 'three_way'
                ? 'Opening this workspace found that manifest.json, the files on disk and the database all disagree for:'
                : 'Opening this workspace found that the database did not come from these files:'}
            </Text>
          </Paragraph>
          <Paragraph>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {pendingDomains.map((d) => (
                <li key={`${d.kind}:${d.id}`}>
                  <Text code>{d.id}</Text> <Text type="secondary">({d.kind}, {d.state})</Text>
                </li>
              ))}
            </ul>
          </Paragraph>
        </>
      )}

      <Paragraph>
        Nothing has been overwritten. Saving stays paused until you choose, so this needs an answer
        before you carry on working.
      </Paragraph>

      {unreadableManifest ? (
        /*
         * The ordinary three paragraphs describe a Store / Load / Close trade in
         * which all three are available. Showing them here would offer two dead
         * ends as peers of the one action that works, so this path gets its own
         * set — same three headings, so the dialog still maps onto the buttons,
         * but each says what it actually does in this situation.
         *
         * Ordered Store first: that is the recommended answer here, and the
         * footer order follows the same emphasis.
         */
        <>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text strong>Store to ria-data</Text> — the only one of the three that can run. It
            rewrites <Text code>manifest.json</Text> from the database and re-exports every file,
            so the analysis you have open becomes what is on disk. Choose it once you are satisfied
            this session holds the content you want to keep. The change is left uncommitted for you
            to review.
          </Paragraph>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text strong>Load from ria-data</Text> — will not work. It reads the same unreadable{' '}
            <Text code>manifest.json</Text> and fails. Repairing the manifest will not work either:
            it recomputes hashes inside the file it cannot parse.
          </Paragraph>
          <Paragraph>
            <Text strong>Close workspace</Text> — nothing is written either way. Use this if you
            would rather put <Text code>manifest.json</Text> right outside RiaCore first, for
            example with <Text code>git checkout -- ria-data/manifest.json</Text>, and reopen
            afterwards.
          </Paragraph>
        </>
      ) : (
        /* Listed in the same order as the footer buttons, likeliest first. */
        <>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text strong>Load from ria-data</Text> — replace what you have open with the files on
            disk. Use this if the change was expected and you just want to continue from it.
          </Paragraph>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text strong>Store to ria-data</Text> — write the analysis you have open now over the
            files on disk. Use this to carry your work across to what is currently checked out. The
            change is left uncommitted for you to review.
          </Paragraph>
          <Paragraph>
            <Text strong>Close workspace</Text> — decide later. Nothing is written either way;
            reopening the workspace picks up whatever is on disk at that point.
          </Paragraph>
        </>
      )}

      {hasUnsaved && (
        <Alert
          type="warning"
          showIcon
          message="You have unsaved changes"
          description={
            <>
              Not yet written to disk: <Text strong>{drift.dirtyNamespaces.join(', ')}</Text>.{' '}
              {unreadableManifest ? (
                /* Load discards nothing here — it throws before writing — so the
                   ordinary "Load and Close both discard them" would be wrong. */
                <>
                  <Text strong>Store to ria-data</Text> keeps them, and it is also the only action
                  that can run. Load fails without writing anything; Close discards them.
                </>
              ) : (
                <>
                  Only <Text strong>Store to ria-data</Text> keeps them — Load and Close both
                  discard them.
                </>
              )}
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
