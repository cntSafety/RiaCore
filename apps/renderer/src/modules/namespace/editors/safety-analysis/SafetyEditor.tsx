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
import { App, Layout, theme, Button, Tooltip } from 'antd';
import { MenuUnfoldOutlined } from '@ant-design/icons';
import { useState, useCallback, useRef, useEffect } from 'react';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import { useWorkspaceStore } from '../../../../store/workspaceStore';
import { useResizablePanel } from './hooks/useResizablePanel';
import { NamespaceTreePanel } from './components/NamespaceTreePanel';
import type { NamespaceTreePanelHandle } from './components/NamespaceTreePanel';
import { CenterPanel } from './components/CenterPanel';
import type { SelectedTreeElement } from './types';
import { useWorkspaceState } from '../../../../hooks/useWorkspaceState';
import { useAutoSave } from '../../../../hooks/useAutoSave';
import { useAutoSaveStatusStore } from '../../../../store/autoSaveStatusStore';
import { usePropagationMutation, usePasteMalfunction } from './hooks/useSafetyMutations';
import { canHostCrossNSSafetyElements } from './config/conceptHosting';
import { api } from '../../../../api/riacore';
import { useQueryClient } from '@tanstack/react-query';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useSectionShortcuts } from './hooks/useSectionShortcuts';
import './safety-editor.css';

const { useToken } = theme;

interface SafetyEditorProps {
  ns: NamespaceContext;
}

export function SafetyEditor({ ns }: SafetyEditorProps) {
  const { token } = useToken();
  const { message } = App.useApp();
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;

  const { triggerAutoSave, flushAutoSave } = useAutoSave(ns.name);

  // Reset the shared Auto_Save Save_Status to `idle` on entering this
  // namespace's editor, so the footer doesn't show a stale status left over
  // from the Overview_Canvas or a previously authored namespace.
  useEffect(() => {
    useAutoSaveStatusStore.getState().reset();
  }, [ns.name]);

  const qc = useQueryClient();

  // Restore persisted selection from the workspace store
  const savedSnapshot = useWorkspaceStore((s) => s.safetyTreeState[ns.name]);
  const [selectedTreeElement, setSelectedTreeElement] = useState<SelectedTreeElement | null>(
    savedSnapshot?.selectedElement ?? null,
  );
  const [addNoteRequested, setAddNoteRequested] = useState(false);
  const treePanelRef = useRef<NamespaceTreePanelHandle>(null);

  // Ctrl+N → open "Add Malfunction" modal for the currently selected architecture node
  useSectionShortcuts({
    onAddMalfunction: useCallback(() => {
      treePanelRef.current?.openAddMalfunctionModal();
    }, []),
  });

  // Propagation gesture state
  const pendingSource = useWorkspaceStore((s) => s.pendingPropagationSource[ns.name] ?? null);
  const setPendingSource = useWorkspaceStore((s) => s.setPendingPropagationSource);
  const { add: addPropagation } = usePropagationMutation(ns.name, triggerAutoSave);

  const handleStartPropagation = useCallback((node: SelectedTreeElement) => {
    if (!node.name) return;
    setPendingSource(ns.name, { nodeId: node.nodeId, name: node.name, namespace: node.namespace, concept: 'malfunction' });
  }, [ns.name, setPendingSource]);

  const handleEndPropagation = useCallback(async (node: SelectedTreeElement) => {
    const pending = useWorkspaceStore.getState().pendingPropagationSource[ns.name] ?? null;
    if (!pending) return;

    // Duplicate check: look up the cached propagations for the source malfunction.
    // getPropagations returns { propagatesTo, propagatesFrom } — check propagatesTo
    // for an existing edge to the target. Falls back to a live fetch if not cached.
    type PropagationsData = {
      propagatesTo: (ConceptInstanceData & { occursAtTarget?: { node_id: number; namespace: string; concept: string } | null })[];
      propagatesFrom: (ConceptInstanceData & { occursAtTarget?: { node_id: number; namespace: string; concept: string } | null })[];
    };
    const cached = qc.getQueryData<PropagationsData>(['safety.propagations', pending.nodeId]);
    const existingEdge = cached?.propagatesTo.some((p) => p.node_id === node.nodeId);
    if (existingEdge) {
      message.warning(`A propagation from "${pending.name}" to "${node.name ?? node.nodeId}" already exists.`);
      setPendingSource(ns.name, null);
      return;
    }

    try {
      await addPropagation.mutateAsync({ sourceFmNodeId: pending.nodeId, targetFmNodeId: node.nodeId });
      setPendingSource(ns.name, null);
    } catch (err) {
      message.error(String((err as Error)?.message ?? 'Failed to create propagation'));
    }
  }, [ns.name, addPropagation, setPendingSource, qc]);

  // ── Copy / Paste malfunction (tree right-click) ───────────────────
  const copiedMalfunction = useWorkspaceStore((s) => s.copiedMalfunction);
  const setCopiedMalfunction = useWorkspaceStore((s) => s.setCopiedMalfunction);
  const pasteMalfunctionFromTree = usePasteMalfunction(workspaceKey, triggerAutoSave);
  // Re-entrancy guard: a paste is not atomic (it creates the malfunction, then
  // links tasks/requirements over several write transactions). A double
  // right-click, or the context-menu and Edit-menu shortcut firing together,
  // could otherwise start a second paste before the first finishes and create
  // duplicate copies. A ref guards synchronously, before React state updates.
  const pasteInFlightRef = useRef(false);

  const handleCopyMalfunctionFromTree = useCallback(async (node: SelectedTreeElement) => {
    try {
      const [fm, rr, tasks, reqs, directReqs] = await Promise.all([
        api.safety.getMalfunction(node.nodeId),
        api.safety.getRiskRating(node.nodeId),
        api.safety.getSafetyTasks(node.nodeId),
        api.safety.getRequirementsForFm(node.nodeId),
        api.safety.getDirectRequirementsForFm(node.nodeId),
      ]);
      const name = String(fm.attributes?.has_name ?? node.name ?? `Malfunction ${node.nodeId}`);
      setCopiedMalfunction({
        sourceNodeId: node.nodeId,
        sourceNamespace: ns.name,
        name,
        description: String(fm.attributes?.malfunction_description ?? ''),
        asil: String(fm.attributes?.malfunction_asil ?? '') || undefined,
        riskRating: rr ? {
          severity: String(rr.attributes?.has_severity ?? '') || undefined,
          occurrence: String(rr.attributes?.has_occurrence_level ?? '') || undefined,
          detection: String(rr.attributes?.has_detection_level ?? '') || undefined,
          note: String(rr.attributes?.risk_rating_note ?? '') || undefined,
        } : null,
        safetyTaskNodeIds: tasks.map((t) => t.node_id),
        requirementNodeIds: reqs.map((r) => r.node_id),
        directRequirementNodeIds: directReqs.map((r) => r.node_id),
      });
      void message.success(`"${name}" copied to clipboard`);
    } catch (err) {
      void message.error(String((err as Error)?.message ?? 'Failed to copy malfunction'));
    }
  }, [setCopiedMalfunction, ns.name]);

  const handlePasteMalfunctionFromTree = useCallback(async (node: SelectedTreeElement) => {
    const clipboard = useWorkspaceStore.getState().copiedMalfunction;
    if (!clipboard) return;
    if (pasteInFlightRef.current) return;
    pasteInFlightRef.current = true;
    try {
      await pasteMalfunctionFromTree.mutateAsync({
        copied: clipboard,
        safetyNamespace: ns.name,
        occursAtNodeId: node.nodeId,
        occursAtNamespace: node.namespace,
      });
      // Deterministically refresh + expand the host structural node so the pasted
      // malfunction's reference child appears immediately. The cache-invalidation
      // subscription silently skips structural parents that were never expanded
      // (e.g. a port that previously had no malfunctions), so we must refresh it
      // explicitly here — mirroring the "Add Malfunction" path.
      await treePanelRef.current?.refreshStructuralParent(node);
      void message.success(`"${clipboard.name} COPY" created`);
    } catch (err) {
      void message.error(String((err as Error)?.message ?? 'Failed to paste malfunction'));
    } finally {
      pasteInFlightRef.current = false;
    }
  }, [pasteMalfunctionFromTree, ns.name]);

  // Show in Tree handlers
  const handleShowInTree = useCallback((node: SelectedTreeElement) => {
    treePanelRef.current?.navigateToNode(node.nodeId, node.namespace, node.concept);
  }, []);

  const handleShowReferenceInTree = useCallback((node: SelectedTreeElement) => {
    // Delegate to the tree panel so the keyboard shortcut resolves and navigates
    // exactly like the right-click "Show Reference in Tree" menu: a directly
    // selected reference child uses its host coordinates; a malfunction uses its
    // occurs_at target; a safety note uses its structural parent. Resolution
    // happens here at key-press time (not latched at selection time), so it is
    // unaffected by query-cache warmth.
    void treePanelRef.current?.navigateToSelectedReference(node);
  }, []);

  // Open Table View for the right-clicked architecture scope element.
  // Selects the node as the scope (if not already selected) and switches the lens.
  const handleOpenInTableView = useCallback((node: SelectedTreeElement) => {
    setSelectedTreeElement(node);
    useWorkspaceStore.getState().setElementLensView('table');
  }, []);

  // Stable refs so menu event handlers always access the latest values
  const selectedTreeElementRef = useRef(selectedTreeElement);
  selectedTreeElementRef.current = selectedTreeElement;
  const handleStartPropagationRef = useRef(handleStartPropagation);
  handleStartPropagationRef.current = handleStartPropagation;
  const handleEndPropagationRef = useRef(handleEndPropagation);
  handleEndPropagationRef.current = handleEndPropagation;
  const handleCopyMalfunctionFromTreeRef = useRef(handleCopyMalfunctionFromTree);
  handleCopyMalfunctionFromTreeRef.current = handleCopyMalfunctionFromTree;
  const handlePasteMalfunctionFromTreeRef = useRef(handlePasteMalfunctionFromTree);
  handlePasteMalfunctionFromTreeRef.current = handlePasteMalfunctionFromTree;
  const handleShowInTreeRef = useRef(handleShowInTree);
  handleShowInTreeRef.current = handleShowInTree;
  const handleShowReferenceInTreeRef = useRef(handleShowReferenceInTree);
  handleShowReferenceInTreeRef.current = handleShowReferenceInTree;

  // Keep the Edit menu item enabled states in sync with UI state
  useEffect(() => {
    const isMalfunctionSelected = selectedTreeElement?.concept === 'malfunction';
    const propagationStarted = pendingSource !== null;
    const propagationEndAvailable =
      propagationStarted &&
      isMalfunctionSelected &&
      selectedTreeElement?.nodeId !== pendingSource?.nodeId;
    api.menu.setPropagationState({ malfunctionSelected: isMalfunctionSelected, propagationStarted, propagationEndAvailable });
  }, [selectedTreeElement, pendingSource]);

  // Sync Copy/Paste Malfunction menu item enabled states
  useEffect(() => {
    const canCopy = selectedTreeElement?.concept === 'malfunction';
    const canPaste = !!copiedMalfunction &&
      !!selectedTreeElement &&
      canHostCrossNSSafetyElements(selectedTreeElement.concept);
    api.menu.setMalfunctionClipboardState({ canCopy, canPaste });
  }, [selectedTreeElement, copiedMalfunction]);

  // Sync Show-in-Tree menu item enabled states
  useEffect(() => {
    const showInTreeAvailable = selectedTreeElement?.concept === 'malfunction' ||
      selectedTreeElement?.concept === 'safety_note';
    // Reference navigation is resolved at key-press time by the tree panel
    // (navigateToSelectedReference), so enable it for any malfunction or safety
    // note rather than gating on the malfunction detail cache here — gating on a
    // possibly-cold cache is what made Ctrl+Shift+T work only intermittently.
    // The panel no-ops when there is genuinely no reference target (e.g. a
    // malfunction without an occurs_at).
    const showReferenceInTreeAvailable = showInTreeAvailable;
    api.menu.setShowInTreeState({ showInTreeAvailable, showReferenceInTreeAvailable });
  }, [selectedTreeElement]);

  // Sync Add Malfunction menu item enabled state: only architecture nodes can host malfunctions
  useEffect(() => {
    const canAddMalfunction = !!selectedTreeElement && canHostCrossNSSafetyElements(selectedTreeElement.concept);
    api.menu.setAddMalfunctionState({ canAddMalfunction });
  }, [selectedTreeElement]);

  // Sync Delete Malfunction menu item enabled state: only malfunction nodes can be deleted this way
  useEffect(() => {
    const canDeleteMalfunction = selectedTreeElement?.concept === 'malfunction';
    api.menu.setDeleteMalfunctionState({ canDeleteMalfunction });
  }, [selectedTreeElement]);

  // Register Edit-menu event listeners once; access latest state via refs
  useEffect(() => {
    const unsubStart = api.menu.onStartPropagation(() => {
      const el = selectedTreeElementRef.current;
      if (el?.concept === 'malfunction' && el.name) {
        handleStartPropagationRef.current(el);
      }
    });
    const unsubEnd = api.menu.onEndPropagation(() => {
      const el = selectedTreeElementRef.current;
      if (el?.concept === 'malfunction') {
        void handleEndPropagationRef.current(el);
      }
    });
    const unsubCancel = api.menu.onCancelPropagation(() => {
      setPendingSource(ns.name, null);
    });
    const unsubCopy = api.menu.onCopyMalfunction(() => {
      const el = selectedTreeElementRef.current;
      if (el?.concept === 'malfunction') {
        void handleCopyMalfunctionFromTreeRef.current(el);
      }
    });
    const unsubPaste = api.menu.onPasteMalfunction(() => {
      const el = selectedTreeElementRef.current;
      if (el && canHostCrossNSSafetyElements(el.concept)) {
        void handlePasteMalfunctionFromTreeRef.current(el);
      }
    });
    const unsubShowInTree = api.menu.onShowInTree(() => {
      const el = selectedTreeElementRef.current;
      if (el?.concept === 'malfunction' || el?.concept === 'safety_note') {
        handleShowInTreeRef.current(el);
      }
    });
    const unsubShowReferenceInTree = api.menu.onShowReferenceInTree(() => {
      const el = selectedTreeElementRef.current;
      if (el?.concept === 'malfunction' || el?.concept === 'safety_note') {
        handleShowReferenceInTreeRef.current(el);
      }
    });
    const unsubAddMalfunction = api.menu.onAddMalfunction(() => {
      treePanelRef.current?.openAddMalfunctionModal();
    });
    const unsubDeleteMalfunction = api.menu.onDeleteMalfunction(() => {
      treePanelRef.current?.openDeleteMalfunctionModal();
    });
    return () => { unsubStart(); unsubEnd(); unsubCancel(); unsubCopy(); unsubPaste(); unsubShowInTree(); unsubShowReferenceInTree(); unsubAddMalfunction(); unsubDeleteMalfunction(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns.name, setPendingSource]);

  // When the tree signals it's ready (roots loaded), navigate to the saved element
  const savedElementRef = useRef(savedSnapshot?.selectedElement ?? null);
  const handleTreeReady = useCallback(() => {
    const el = savedElementRef.current;
    if (!el) return;
    // Clear so we don't re-navigate on subsequent onReady calls
    savedElementRef.current = null;
    if (el.hostNodeId !== undefined && el.hostNamespace !== undefined) {
      // Restore a cross-namespace reference selection
      treePanelRef.current?.navigateToReference(el.nodeId, el.namespace, el.concept, el.hostNodeId, el.hostNamespace);
    } else {
      treePanelRef.current?.navigateToNode(el.nodeId, el.namespace, el.concept);
    }
  }, []);

  const leftPanel = useResizablePanel({
    default: 300,
    min: 200,
    max: 600,
    collapseThreshold: 100,
    storageKey: 'safety-editor-tree-width',
  });

  const handleNavigateToNode = useCallback(
    (nodeId: number, namespace: string, concept: string) => {
      treePanelRef.current?.navigateToNode(nodeId, namespace, concept);
    },
    [],
  );

  // Clear showDetailsFor when the tree selection changes (user navigated away)
  const handleTreeSelect = useCallback((element: SelectedTreeElement | null) => {
    setSelectedTreeElement(element);
    triggerAutoSave();
  }, [triggerAutoSave]);

  const handleNavigateToReference = useCallback(
    (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => {
      console.log('[SafetyEditor] handleNavigateToReference called:', { refNodeId, refNamespace, refConcept, hostNodeId, hostNamespace });
      treePanelRef.current?.navigateToReference(refNodeId, refNamespace, refConcept, hostNodeId, hostNamespace);
    },
    [],
  );

  const handleTreeElementRename = useCallback((name: string) => {
    // Update the selected element state
    setSelectedTreeElement((current) => {
      if (!current) return current;
      return { ...current, name };
    });
    // Dispatch rename to the tree panel imperatively. We read the current
    // selectedTreeElement from the ref-stable closure — this avoids putting
    // a side effect inside the state updater (which React 19 may call twice).
    if (selectedTreeElement) {
      treePanelRef.current?.renameNode(selectedTreeElement.nodeId, selectedTreeElement.namespace, name);
    }
  }, [selectedTreeElement]);

  return (
    <Layout className="ria-scope" style={{ height: '100%', overflow: 'hidden', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'row', minHeight: 0, minWidth: 0 }}>
      {leftPanel.collapsed ? (
        /* Collapsed rail — slim bar with an icon to re-open the tree */
        <div
          style={{
            width: 36,
            minWidth: 36,
            maxWidth: 36,
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 8,
            flexShrink: 0,
          }}
        >
          <Tooltip title="Show tree" placement="right">
            <Button
              type="text"
              size="small"
              icon={<MenuUnfoldOutlined />}
              onClick={leftPanel.expand}
              aria-label="Show tree"
            />
          </Tooltip>
        </div>
      ) : (
        <>
      {/* Left: Imported Tree Panel */}
      <div
        style={{
          width: leftPanel.width,
          minWidth: leftPanel.width,
          maxWidth: leftPanel.width,
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <NamespaceTreePanel
            ref={treePanelRef}
            onSelect={handleTreeSelect}
            safetyNamespace={ns.name}
            onRequestAddNote={() => setAddNoteRequested(true)}
            onReady={handleTreeReady}
            onNavigateToNode={handleNavigateToNode}
            onNavigateToReference={handleNavigateToReference}
            triggerAutoSave={flushAutoSave}
            onStartPropagation={handleStartPropagation}
            onEndPropagation={handleEndPropagation}
            onCopyMalfunction={handleCopyMalfunctionFromTree}
            onPasteMalfunction={handlePasteMalfunctionFromTree}
            hasCopiedMalfunction={!!copiedMalfunction}
            onOpenInTableView={handleOpenInTableView}
          />
        </div>
      </div>

      {/* Left resizer */}
      <div
        onMouseDown={leftPanel.onMouseDown}
        style={{
          width: 4,
          cursor: 'col-resize',
          background: 'transparent',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { (e.target as HTMLDivElement).style.background = token.colorBorderSecondary; }}
        onMouseLeave={(e) => { (e.target as HTMLDivElement).style.background = 'transparent'; }}
      />
        </>
      )}

      {/* Center: Editor Header + Tabbed Panel */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Editor Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 16px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 11, color: token.colorTextSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>Namespace</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: token.colorText, whiteSpace: 'nowrap' }}>{ns.name}</span>
          </div>
        </div>
        <CenterPanel
          namespace={ns.name}
          selectedTreeElement={selectedTreeElement}
          onRenameSelectedTreeElement={handleTreeElementRename}
          addNoteRequested={addNoteRequested}
          onAddNoteHandled={() => setAddNoteRequested(false)}
          onNavigateToNode={handleNavigateToNode}
          onNavigateToReference={handleNavigateToReference}
          onShowReferenceInTree={handleShowReferenceInTree}
          onTreeMutation={(node) => { if (node) void treePanelRef.current?.refreshStructuralParent(node); }}
          workspaceKey={workspaceKey}
          triggerAutoSave={triggerAutoSave}
          onStartPropagation={handleStartPropagation}
          onEndPropagation={handleEndPropagation}
        />
      </div>
    </div>
    </Layout>
  );
}
