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
import { useState, useEffect, useRef } from 'react';
import { App as AntdApp, Modal, Button, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './theme/ThemeProvider';
import { AppShell } from './shell/AppShell';
import { WorkspaceCanvas } from './shell/WorkspaceCanvas';
import { NamespaceRouter } from './modules/namespace/NamespaceRouter';
import { ImportManager } from './modules/import/ImportManager';
import { DiffPanel } from './modules/diff/DiffPanel';
import { GitCommitModal } from './components/git/GitCommitModal';
import { EmptyDirConfirmDialog } from './shell/EmptyDirConfirmDialog';
import { useWorkspaceStore, type NamespaceContext } from './store/workspaceStore';
import { useKeepImportSourcesSynced } from './hooks/useKeepImportSourcesSynced';
import { api } from './api/riacore';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { useWorkspaceGitConfig } from './api/git-hooks';
import { appQueryClient } from './appQueryClient';
import { useOpenWorkspaceMutation } from './hooks/useOpenWorkspaceMutation';
import { useCreateWorkspaceMutation } from './hooks/useCreateWorkspaceMutation';
import { useCloseWorkspaceMutation } from './hooks/useCloseWorkspaceMutation';
import { useFullWorkspaceSaveMutation } from './hooks/useFullWorkspaceSaveMutation';
import { useExportSphinxNeeds } from './hooks/useExportSphinxNeeds';
import { useExportSettings } from './hooks/useExportSettings';
import { useExportSafetyXlsx } from './hooks/useExportSafetyXlsx';
import { SettingsDialog } from './modules/settings/SettingsDialog';
import { useAppSettingsDialogStore } from './store/appSettingsDialogStore';
import { LlmReviewModal } from './modules/llm-review/LlmReviewModal';
import { useLlmReviewModalStore } from './store/llmReviewModalStore';
import { AboutModal } from './components/AboutModal';

const queryClient = appQueryClient;

// ── View types ────────────────────────────────────────────────────────────────

type View =
  | { type: 'canvas' }
  | { type: 'namespace'; ns: NamespaceContext }
  | { type: 'imports' }
  | { type: 'diff' };

// ── Root app — view router ────────────────────────────────────────────────────

function RootApp() {
  const { message, modal } = AntdApp.useApp();
  const [view, setView] = useState<View>({ type: 'canvas' });
  const { setActiveNamespace } = useWorkspaceStore();
  const activeNamespace = useWorkspaceStore((s) => s.activeNamespace);
  const wsState = useWorkspaceState();

  // Keep import sources polling alive across all views so long-running imports
  // (e.g. ARXML) sync their status back to importRunStore even when
  // WorkspaceCanvas is unmounted.
  useKeepImportSourcesSynced();

  // ── Workspace open / create / save ────────────────────────────────────────
  const openWorkspaceMutation = useOpenWorkspaceMutation();
  const createWorkspaceMutation = useCreateWorkspaceMutation();
  const closeWorkspaceMutation = useCloseWorkspaceMutation();
  const saveWorkspaceMutation = useFullWorkspaceSaveMutation();

  // ── Sphinx-Needs export mutation ──────────────────────────────────────────
  const exportSphinxNeedsMutation = useExportSphinxNeeds();

  // Report-export preferences (Settings → Report Export). Read here because the
  // export runs in the worker, which cannot reach the main-process settings store.
  const exportSettingsQuery = useExportSettings();

  // ── Excel (.xlsx) export mutation ─────────────────────────────────────────
  const exportSafetyXlsxMutation = useExportSafetyXlsx();

  // ── Export result modal state ─────────────────────────────────────────────
  type ExportModalState =
    | { open: false }
    | { open: true; kind: 'success'; fileCount: number; outputDir: string }
    | { open: true; kind: 'success-file'; filePath: string }
    | { open: true; kind: 'error'; message: string };
  const [exportModal, setExportModal] = useState<ExportModalState>({ open: false });

  // ── Git commit modal — lifted here so the Git menu works from any view ────
  const [gitCommitOpen, setGitCommitOpen] = useState(false);
  const gitWsConfigQuery = useWorkspaceGitConfig();
  const workingDirForGit = wsState.phase !== 'no_workspace' ? wsState.workingDir : '';
  const resolvedRepoDir = gitWsConfigQuery.data?.repoDir || workingDirForGit;

  // ── App Settings dialog — top-level, opened from the native File → Settings… menu ─
  const appSettingsOpen = useAppSettingsDialogStore((s) => s.open);
  const openAppSettings = useAppSettingsDialogStore((s) => s.openDialog);
  const closeAppSettings = useAppSettingsDialogStore((s) => s.closeDialog);

  // ── LLM Review modal — top-level, opened from the namespace tree's
  //    "Initial LLM review" context-menu entry (task 10.6, Requirement 4.6) ─
  const llmReviewTarget = useLlmReviewModalStore((s) => s.target);
  const closeLlmReview = useLlmReviewModalStore((s) => s.closeModal);

  // ── Empty-dir confirmation dialog state ──────────────────────────────────
  const [pendingOpenDir, setPendingOpenDir] = useState<string | null>(null);

  // ── About modal ───────────────────────────────────────────────────────────
  const [aboutOpen, setAboutOpen] = useState(false);

  // Stable refs so the native menu subscription doesn't re-subscribe on every render
  const handleOpenWorkspaceRef = useRef<() => void>(() => {});
  const handleCreateWorkspaceRef = useRef<() => void>(() => {});
  const handleCloseWorkspaceRef = useRef<() => void>(() => {});
  const handleGitCommitRef = useRef<() => void>(() => {});
  const handleExportSphinxNeedsRef = useRef<() => void>(() => {});
  const handleExportXlsxRef = useRef<() => void>(() => {});
  const handleShowStatusCardsRef = useRef<() => void>(() => {});
  const handleOpenRecentRef = useRef<(workingDir: string) => void>(() => {});

  // Subscribe to native File menu actions (Open Workspace, Create Workspace, Save)
  useEffect(() => {
    const unsubscribe = api.menu.onFileAction((action) => {
      if (action === 'open-workspace') handleOpenWorkspaceRef.current();
      else if (action === 'create-workspace') handleCreateWorkspaceRef.current();
      else if (action === 'close-workspace') handleCloseWorkspaceRef.current();
      else if (action === 'save') {
        // Block Save when ria-data files are corrupted — saving would overwrite
        // the on-disk JSON with the old DB state, discarding any external changes.
        // The user must Repair Manifest first (or use Load to restore from files).
        const isFilesCorrupted = wsState.phase === 'db_open' && wsState.filesCorrupted === true;
        if (!isFilesCorrupted) saveWorkspaceMutation.mutate();
      }
      else if (action.startsWith('open-recent:')) {
        const workingDir = action.slice('open-recent:'.length);
        handleOpenRecentRef.current(workingDir);
      }
      else if (action === 'open-settings') {
        // Zustand actions are stable, so calling directly is safe and needs no ref.
        openAppSettings();
      }
    });
    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsState]);

  // Subscribe to native Git menu actions
  useEffect(() => {
    const unsubscribe = api.menu.onGitAction((action) => {
      if (action === 'commit') handleGitCommitRef.current();
      else if (action === 'namespace-diff') openDiff();
    });
    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to native Report menu actions
  useEffect(() => {
    const unsubscribe = api.menu.onReportAction((action) => {
      if (action === 'export-sphinx-needs') handleExportSphinxNeedsRef.current();
      else if (action === 'export-xlsx') handleExportXlsxRef.current();
      else if (action === 'show-status-cards') handleShowStatusCardsRef.current();
    });
    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to Help menu actions
  useEffect(() => {
    const unsubscribe = api.menu.onHelpAction((action) => {
      if (action === 'about') setAboutOpen(true);
    });
    return unsubscribe;
  }, []);

  // Notify main process whenever the active namespace changes so the menu item
  // is enabled only when a safety-core namespace is active.
  useEffect(() => {
    api.menu.setSafetyNamespaceState({ active: activeNamespace?.owningApplication === 'Safety-Analysis' });
  }, [activeNamespace]);

  const doOpenWorkspace = (dir: string) => {
    openWorkspaceMutation.mutate(dir, {
      onSuccess: () => {
        void api.workspace.addRecent(dir);
        navigateHome();
      },
      onError: (err) => {
        void message.error(
          `Failed to open workspace: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  };

  const openOrConfirm = async (dir: string) => {
    try {
      const probe = await api.workspace.probe(dir);
      if (!probe.hasDb && !probe.hasRiaData) {
        // No existing workspace — ask before creating one
        setPendingOpenDir(dir);
        return;
      }
    } catch {
      // Probe failed (e.g. permission error) — fall through and let open() surface the error
    }
    doOpenWorkspace(dir);
  };

  const handleOpenWorkspace = async () => {
    const dir = await api.dialog.openDirectory();
    if (!dir) return;
    await openOrConfirm(dir);
  };

  const handleCreateWorkspace = async () => {
    const dir = await api.dialog.openDirectory();
    if (!dir) return;
    createWorkspaceMutation.mutate(dir, {
      onSuccess: () => {
        void api.workspace.addRecent(dir);
        navigateHome();
      },
      onError: (err) => {
        void message.error(
          `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  };

  const handleOpenRecent = (workingDir: string) => {
    void openOrConfirm(workingDir);
  };

  const handleCloseWorkspace = () => {
    // Only meaningful when a workspace is open.
    if (wsState.phase === 'no_workspace') return;
    modal.confirm({
      title: 'Close workspace?',
      content:
        'The workspace will be closed. Your changes are saved automatically, so nothing will be lost.',
      okText: 'Close workspace',
      cancelText: 'Cancel',
      onOk: () => {
        closeWorkspaceMutation.mutate(undefined, {
          onSuccess: () => navigateHome(),
        });
      },
    });
  };

  // Keep refs current so the menu subscription always calls the latest closures
  handleOpenWorkspaceRef.current = () => void handleOpenWorkspace();
  handleCreateWorkspaceRef.current = () => void handleCreateWorkspace();
  handleCloseWorkspaceRef.current = () => handleCloseWorkspace();
  handleGitCommitRef.current = () => setGitCommitOpen(true);
  handleOpenRecentRef.current = handleOpenRecent;

  const handleExportSphinxNeeds = async () => {
    // Ignore unless a Safety-Analysis namespace is active (any safety profile)
    if (activeNamespace?.owningApplication !== 'Safety-Analysis') return;

    // Let the user pick an output folder
    const outputDir = await api.dialog.openDirectory();
    if (!outputDir) return;

    // Show a persistent loading toast while the export runs
    const loadingKey = 'sphinx-needs-export-loading';
    void message.loading({ content: 'Exporting safety report…', key: loadingKey, duration: 0 });

    try {
      const result = await exportSphinxNeedsMutation.mutateAsync({
        namespace: activeNamespace.name,
        outputDir,
        includeRiskRatings: exportSettingsQuery.data?.includeRiskRatings ?? true,
      });
      message.destroy(loadingKey);
      setExportModal({ open: true, kind: 'success', fileCount: result.exportedFiles.length, outputDir: result.outputDir });
    } catch (err) {
      message.destroy(loadingKey);
      setExportModal({ open: true, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  handleExportSphinxNeedsRef.current = () => void handleExportSphinxNeeds();

  const handleExportXlsx = async () => {
    // Ignore unless a Safety-Analysis namespace is active (any safety profile)
    if (activeNamespace?.owningApplication !== 'Safety-Analysis') return;

    // Let the user pick the destination file
    const defaultName = `${activeNamespace.name}-safety-analysis.xlsx`;
    const outputPath = await api.dialog.saveFile({
      title: 'Export Safety Report',
      defaultPath: defaultName,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (!outputPath) return;

    // Show a persistent loading toast while the export runs
    const loadingKey = 'safety-xlsx-export-loading';
    void message.loading({ content: 'Exporting safety report…', key: loadingKey, duration: 0 });

    try {
      const result = await exportSafetyXlsxMutation.mutateAsync({
        namespace: activeNamespace.name,
        outputPath,
      });
      message.destroy(loadingKey);
      setExportModal({ open: true, kind: 'success-file', filePath: result.outputPath });
    } catch (err) {
      message.destroy(loadingKey);
      setExportModal({ open: true, kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  handleExportXlsxRef.current = () => void handleExportXlsx();

  handleShowStatusCardsRef.current = () => {
    if (activeNamespace?.owningApplication !== 'Safety-Analysis') return;
    useWorkspaceStore.getState().setEditorOverride(activeNamespace.namespaceId, 'Status-Cards');
    setView({ type: 'namespace', ns: activeNamespace });
  };

  // ── Navigation ────────────────────────────────────────────────────────────

  const navigateHome = () => {
    setView({ type: 'canvas' });
    setActiveNamespace(null);
  };

  const openNamespace = (ns: NamespaceContext) => {
    setActiveNamespace(ns);
    setView({ type: 'namespace', ns });
  };

  const openNamespaceWithCheck = (ns: NamespaceContext) => {
    useWorkspaceStore.getState().setEditorOverride(ns.namespaceId, 'Model-Check');
    useWorkspaceStore.getState().setPendingCheckAutoRun(ns.namespaceId, true);
    openNamespace(ns);
  };

  const openImports = () => setView({ type: 'imports' });

  const openAppLogs = async () => {
    try {
      await api.app.openLogsDirectory();
    } catch (error) {
      message.error(`Failed to open app logs: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openWorkspaceLogs = async () => {
    if (wsState.phase === 'no_workspace') {
      message.info('Open a workspace first to access workspace operation logs.');
      return;
    }
    try {
      await api.workspace.openLogsDirectory(wsState.workingDir);
    } catch (error) {
      message.error(`Failed to open workspace logs: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openGraphCore = () => {
    api.window.openGraphCore().catch((err) => {
      message.error(`Failed to open Graph-Core window: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const openDiff = () => setView({ type: 'diff' });

  return (
    <AppShell
      showTopBar={view.type !== 'canvas'}
      showSidebar={view.type === 'namespace' && view.ns.owningApplication !== 'Safety-Analysis'}
      onSelectNamespace={openNamespace}
      onNavigateHome={navigateHome}
      onOpenAppLogs={openAppLogs}
      onOpenWorkspaceLogs={openWorkspaceLogs}
    >
      {view.type === 'canvas' && (
        <WorkspaceCanvas
          onEditNamespace={openNamespace}
          onCheckNamespace={openNamespaceWithCheck}
          onRunImporter={openImports}
        />
      )}

      {view.type === 'namespace' && (
        <NamespaceRouter ns={view.ns} />
      )}

      {view.type === 'imports' && (
        <ImportManager />
      )}

      {view.type === 'diff' && (
        <DiffPanel onBack={navigateHome} />
      )}

      {/* Git Commit modal — available from any view via Git menu */}
      <GitCommitModal
        repoDir={resolvedRepoDir}
        workingDir={workingDirForGit}
        open={gitCommitOpen}
        onClose={() => setGitCommitOpen(false)}
      />

      {/* Empty-dir confirmation — shown when user opens a folder with no existing workspace */}
      <EmptyDirConfirmDialog
        dirPath={pendingOpenDir ?? ''}
        open={pendingOpenDir !== null}
        onConfirm={() => {
          const dir = pendingOpenDir!;
          setPendingOpenDir(null);
          doOpenWorkspace(dir);
        }}
        onCancel={() => setPendingOpenDir(null)}
      />

      {/* Global application Settings dialog — top-level, opened from the native
          File → Settings… menu. State is held in `appSettingsDialogStore`. */}
      <SettingsDialog open={appSettingsOpen} onClose={closeAppSettings} />

      {/* LLM Review modal — top-level, opened from the namespace tree's
          "Initial LLM review" context-menu entry. State is held in
          `llmReviewModalStore` (task 10.6 of the llm-component-review spec). */}
      {llmReviewTarget && (
        <LlmReviewModal
          open
          onClose={closeLlmReview}
          nodeId={llmReviewTarget.nodeId}
          namespace={llmReviewTarget.namespace}
          initialElementName={llmReviewTarget.displayName}
          reviewMetamodel={llmReviewTarget.reviewMetamodel}
        />
      )}

      {/* About modal — themed Ant Design replacement for native app.showAboutPanel() */}
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* Sphinx-Needs export result modal */}
      <Modal
        title={
          exportModal.open
            ? exportModal.kind === 'error'
              ? <span><CloseCircleOutlined style={{ color: 'var(--ant-color-error, #ff4d4f)', marginRight: 8 }} />Export failed</span>
              : <span><CheckCircleOutlined style={{ color: 'var(--ant-color-success, #52c41a)', marginRight: 8 }} />Export complete</span>
            : null
        }
        open={exportModal.open}
        onCancel={() => setExportModal({ open: false })}
        footer={
          <Button type="primary" onClick={() => setExportModal({ open: false })}>
            OK
          </Button>
        }
        width={520}
        destroyOnClose
      >
        {exportModal.open && exportModal.kind === 'success' && (
          <Typography.Text>
            {exportModal.fileCount} file{exportModal.fileCount !== 1 ? 's' : ''} written to:
            <br />
            <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
              {exportModal.outputDir}
            </Typography.Text>
          </Typography.Text>
        )}
        {exportModal.open && exportModal.kind === 'success-file' && (
          <Typography.Text>
            Workbook written to:
            <br />
            <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
              {exportModal.filePath}
            </Typography.Text>
          </Typography.Text>
        )}
        {exportModal.open && exportModal.kind === 'error' && (
          <Typography.Text type="danger" style={{ wordBreak: 'break-all' }}>
            {exportModal.message}
          </Typography.Text>
        )}
      </Modal>
    </AppShell>
  );
}

// ── Providers wrapper ─────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RootApp />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
