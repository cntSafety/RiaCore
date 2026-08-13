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
 * SafetyAnalysisSpawnApp — root component for the Safety Analysis Spawn window.
 *
 * This window is loaded with ?view=safety-analysis-spawn. It:
 * 1. Mounts its own QueryClientProvider (using spawnQueryClient).
 * 2. Subscribes to `window.showInTree.dispatch` messages from the main process.
 * 3. Sends `window.spawnReady` once mounted and the handler is registered.
 * 4. Writes the navigation target into the (per-window) workspace store so
 *    `SafetyEditor`'s built-in saved-selection replay picks it up on first
 *    tree-ready signal.
 * 5. Renders the SafetyEditor inside an `AppShell` (without sidebar) so the
 *    user gets the same status bar (DB/workspace/logs) as the main window.
 *
 * Requirements: 3.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4,
 *               8.1, 8.2, 8.6, 10.1, 10.2, 11.1
 */

import { useEffect, useState } from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { App, theme } from 'antd';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { StatusBar } from '../../shell/StatusBar';
import { spawnQueryClient } from './spawnQueryClient';
import { spawnNavStore, useSpawnNavStore } from './spawnNavStore';
import { api } from '../../api/riacore';
import { useWorkspaceState, isDbOpen } from '../../hooks/useWorkspaceState';
import { useWorkspaceStatus } from '../../hooks/useWorkspaceStatus';
import { SafetyEditor } from '../namespace/editors/safety-analysis/SafetyEditor';
import { SafetyMetamodelContext } from '../namespace/editors/safety-analysis/hooks/safetyMetamodelContext';
import {
  useWorkspaceStore,
  type NamespaceContext,
  type SafetyTreeSnapshot,
} from '../../store/workspaceStore';

// ---------------------------------------------------------------------------
// Inner component (has access to QueryClient context)
// ---------------------------------------------------------------------------

function SpawnWindowView() {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const wsState = useWorkspaceState();
  const wsStatusQuery = useWorkspaceStatus();
  const isWorkspaceLoading = wsStatusQuery.isLoading;

  const [activeNs, setActiveNs] = useState<NamespaceContext | null>(null);
  // Increments on every successful navigation, used as part of the SafetyEditor
  // key to force a remount (and thus re-read the persisted selectedElement
  // from the workspace store) when a new request arrives for the same namespace.
  const [navCounter, setNavCounter] = useState(0);
  const setActiveNamespace = useWorkspaceStore((s) => s.setActiveNamespace);
  const setSafetyTreeState = useWorkspaceStore((s) => s.setSafetyTreeState);
  const safetyTreeState = useWorkspaceStore((s) => s.safetyTreeState);
  const { pending } = useSpawnNavStore();

  // Fetch the list of namespaces so we can resolve a namespace name to a full
  // NamespaceContext (which includes namespaceId, role, metamodel, workingDir).
  const { data: namespaceList, isLoading: isNamespacesLoading } = useQuery({
    queryKey: ['namespaces.list'],
    queryFn: () => api.namespaces.list(),
    enabled: isDbOpen(wsState),
  });

  // Open logs handlers (mirroring App.tsx)
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

  // Register the navigation handler and signal readiness to the main process.
  // Requirements: 5.2, 6.1
  useEffect(() => {
    const unsubscribe = api.window.onShowInTreeRequest((req) => {
      spawnNavStore.enqueue(req);
    });

    // Signal to the main process that this renderer is ready to receive requests.
    // Requirements: 5.2
    api.window.spawnReady();

    return () => {
      unsubscribe();
    };
  }, []);

  // React to incoming navigation requests.
  // Wait for both workspace status and namespaces list to load before consuming
  // the request — otherwise we'd race the initial query resolution and lose
  // the request with a spurious warning.
  // Requirements: 6.1, 6.2, 6.3, 6.4, 10.1, 10.2
  useEffect(() => {
    if (pending === null) return;

    if (isWorkspaceLoading) return;

    if (!isDbOpen(wsState)) {
      const dropped = spawnNavStore.consume();
      if (dropped) {
        void message.warning('No workspace is open. Open a workspace in the main window first.');
      }
      return;
    }

    if (isNamespacesLoading || namespaceList === undefined) return;

    const req = spawnNavStore.consume();
    if (!req) return;

    // Resolve the safety namespace — this is the authored namespace that
    // SafetyEditor operates in (where notes, tags, malfunctions live).
    // Resolution order:
    //   1. the explicit safetyNamespace from the payload;
    //   2. the home target's own namespace, when that namespace is itself an
    //      authored Safety-Analysis namespace (the target is a safety concept,
    //      so it lives in its authored analysis — this keeps the correct
    //      analysis/profile when several authored safety namespaces exist and a
    //      dispatcher omitted safetyNamespace);
    //   3. the first authored Safety-Analysis namespace in the list.
    const isAuthoredSafety = (name: string | undefined) =>
      !!name && namespaceList.some(
        (ns) => ns.name === name && ns.owningApplication === 'Safety-Analysis' && ns.role === 'authored',
      );
    const safetyNsName = req.safetyNamespace
      ?? (isAuthoredSafety(req.homeTarget?.namespace) ? req.homeTarget.namespace : undefined)
      ?? namespaceList.find((ns) => ns.owningApplication === 'Safety-Analysis' && ns.role === 'authored')?.name;

    if (!safetyNsName) {
      void message.warning('No safety namespace found in the current workspace.');
      return;
    }

    const safetyNsInfo = namespaceList.find((ns) => ns.name === safetyNsName);
    if (!safetyNsInfo) {
      void message.warning(`Safety namespace "${safetyNsName}" is not available in the current workspace.`);
      return;
    }

    const workingDir = wsState.workingDir;

    // Determine the navigation target.
    // For requestKind = 'reference', SafetyEditor expects the reference target
    // with hostNodeId/hostNamespace pointing to the structural parent. Without
    // a host, fall back to the home target (Requirement 10.5).
    const useReference =
      req.requestKind === 'reference' &&
      req.referenceTarget !== undefined;

    const selectedElement: SafetyTreeSnapshot['selectedElement'] = useReference
      ? {
          nodeId: req.referenceTarget!.nodeId,
          namespace: req.referenceTarget!.namespace,
          concept: req.referenceTarget!.concept,
          // The reference target may live in the same namespace as the home
          // target. We pass the home target as the host so that
          // navigateToReference expands the structural parent path.
          hostNodeId: req.homeTarget.nodeId,
          hostNamespace: req.homeTarget.namespace,
        }
      : {
          nodeId: req.homeTarget.nodeId,
          namespace: req.homeTarget.namespace,
          concept: req.homeTarget.concept,
        };

    // Write the navigation target into the per-window workspace store BEFORE
    // mounting SafetyEditor. SafetyEditor reads `safetyTreeState[ns.name].selectedElement`
    // on mount and replays it via `treePanelRef.current?.navigateToNode(...)` once
    // the tree signals onReady. Requirements: 6.1, 6.2, 6.5, 6.6
    const existingSnapshot = safetyTreeState[safetyNsName];
    setSafetyTreeState(safetyNsName, {
      expandedKeys: existingSnapshot?.expandedKeys ?? [],
      selectedKey: existingSnapshot?.selectedKey ?? null,
      selectedElement,
    });

    // Build the NamespaceContext — always use the safety namespace for SafetyEditor.
    const nextNs: NamespaceContext = {
      namespaceId: safetyNsInfo.namespaceId,
      name: safetyNsInfo.name,
      role: safetyNsInfo.role === 'supervised_update_temp' ? 'imported' : safetyNsInfo.role,
      owningApplication: safetyNsInfo.owningApplication,
      metamodel: safetyNsInfo.metamodel,
      workingDir,
    };

    // Update both the per-window active namespace (for StatusBar's NS indicator
    // and the editor) and the local component state (which gates rendering of
    // SafetyEditor).
    setActiveNamespace(nextNs);
    setActiveNs(nextNs);
    // Bump the nav counter so SafetyEditor remounts and re-reads the persisted
    // selectedElement, even when the namespace is unchanged.
    setNavCounter((c) => c + 1);
  }, [
    pending,
    wsState,
    activeNs,
    namespaceList,
    isWorkspaceLoading,
    isNamespacesLoading,
    safetyTreeState,
    setSafetyTreeState,
    setActiveNamespace,
    message,
  ]);

  // Body content depending on state.
  let body: React.ReactNode;
  if (isWorkspaceLoading) {
    body = (
      <div style={{ padding: 24, color: '#888' }}>Loading workspace…</div>
    );
  } else if (wsState.phase === 'no_workspace') {
    body = (
      <div style={{ padding: 24, color: '#888' }}>
        No workspace open. Open a workspace in the main window first.
      </div>
    );
  } else if (activeNs === null) {
    body = (
      <div style={{ padding: 24, color: '#888' }}>Waiting for navigation request…</div>
    );
  } else {
    // Use a key on SafetyEditor so it remounts when the namespace changes (or
    // when a new navigation request arrives for the same namespace), which
    // re-reads the persisted selectedElement and replays it on tree-ready.
    body = (
      <SafetyMetamodelContext.Provider value={activeNs.metamodel}>
        <SafetyEditor
          key={`${activeNs.name}:${activeNs.namespaceId}:${navCounter}`}
          ns={activeNs}
        />
      </SafetyMetamodelContext.Provider>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        padding: '4px 12px',
        fontSize: 11,
        color: token.colorInfoText,
        background: token.colorInfoBg,
        borderBottom: `1px solid ${token.colorInfoBorder}`,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 13 }}>🔍</span>
        <span>Return to main window for navigation</span>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {body}
      </div>
      <StatusBar onOpenAppLogs={openAppLogs} onOpenWorkspaceLogs={openWorkspaceLogs} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component with providers
// ---------------------------------------------------------------------------

export default function SafetyAnalysisSpawnApp() {
  return (
    <QueryClientProvider client={spawnQueryClient}>
      <ThemeProvider>
        <SpawnWindowView />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
