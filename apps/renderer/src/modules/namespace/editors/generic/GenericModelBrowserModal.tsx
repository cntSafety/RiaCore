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
import { Modal, Empty, Typography, Button, Select, Space, theme } from 'antd';
import { TableOutlined } from '@ant-design/icons';
import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import { useWorkspaceState } from '../../../../hooks/useWorkspaceState';
import { NamespaceTreePanel } from '../safety-analysis/components/NamespaceTreePanel';
import type { NamespaceTreePanelHandle } from '../safety-analysis/components/NamespaceTreePanel';
import { CenterPanel } from '../safety-analysis/components/CenterPanel';
import type { SelectedTreeElement, ScopedTreeNavigator } from '../safety-analysis/types';
import './model-browser.css';

const { Text } = Typography;
const { useToken } = theme;

// ── GenericModelBrowserModal ──────────────────────────────────────────────────

interface GenericModelBrowserModalProps {
  open: boolean;
  onClose: () => void;
  /** The specific imported namespace to browse. */
  namespace: string;
  /** Adds selection controls around the same tree/search used by View. */
  selection?: {
    targetLabel: string;
    namespaces: { value: string; label: string }[];
    onNamespaceChange: (namespace: string) => void;
    disabledReason: (element: SelectedTreeElement) => string | undefined;
    onConfirm: (element: SelectedTreeElement) => void;
    isLinked: (element: SelectedTreeElement) => boolean;
    pending: boolean;
  };
}

export function GenericModelBrowserModal({ open, onClose, namespace, selection }: GenericModelBrowserModalProps) {
  const { token } = useToken();
  const [selected, setSelected] = useState<SelectedTreeElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const treePanelRef = useRef<NamespaceTreePanelHandle>(null);

  // The modal itself stays mounted permanently (only `open` toggles), so
  // `selected` would otherwise survive a close/reopen and show stale content
  // before the user clicks anything. Reset it — but only when the namespace
  // being browsed has actually changed; reopening on the same namespace keeps
  // whatever the user had selected. Runs synchronously before paint so there's
  // no flicker of the old selection.
  const lastShownNamespaceRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    if (lastShownNamespaceRef.current !== namespace) {
      setSelected(null);
      treePanelRef.current?.clearSelection();
    }
    lastShownNamespaceRef.current = namespace;
  }, [open, namespace]);

  // Derived the same way NamespaceTreePanel derives it. CenterPanel needs it to
  // key its queries — without it every query that takes a workspaceKey stays
  // disabled, which silently removes the diagram lens from this modal.
  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;

  const handleSelect = useCallback((element: SelectedTreeElement | null) => {
    setSelected(element);
  }, []);

  const handleElementDeleted = useCallback((nodeId: number) => {
    if (selectedRef.current?.nodeId !== nodeId) return;
    setSelected(null);
    treePanelRef.current?.clearSelection();
  }, []);

  const handleNavigateToNode = useCallback((nodeId: number, ns: string, concept: string, usageContext?: SelectedTreeElement) => {
    void treePanelRef.current?.navigateToNode(nodeId, ns, concept, usageContext);
  }, []);

  const handleShowRelationshipInTree: ScopedTreeNavigator = useCallback(async (target) => {
    const tree = treePanelRef.current;
    if (!tree) return { status: 'unavailable', message: 'The model tree is not available. Please try again.' };
    return tree.navigateToNodeInScope(target);
  }, []);

  const currentSelection = selected?.namespace === namespace ? selected : null;
  const disabledReason = currentSelection ? selection?.disabledReason(currentSelection) : 'Select a requirement in the tree.';

  return (
    <Modal
      open={open}
      onCancel={() => { if (!selection?.pending) onClose(); }}
      closable={!selection?.pending}
      keyboard={!selection?.pending}
      footer={selection ? (
        <div className="requirement-browser-footer">
          <Text type="secondary" role="status">{disabledReason ?? `Selected: ${currentSelection?.name ?? currentSelection?.concept}`}</Text>
          <Space>
            <Button onClick={onClose} disabled={selection.pending}>Cancel</Button>
            <Button type="primary" loading={selection.pending} disabled={!currentSelection || !!disabledReason} onClick={() => {
              if (currentSelection && !selection.pending && !selection.disabledReason(currentSelection)) selection.onConfirm(currentSelection);
            }}>Link selected requirement</Button>
          </Space>
        </div>
      ) : null}
      width="90vw"
      style={{ top: 16, maxWidth: 1400 }}
      styles={{ body: { padding: 0 } }}
      title={selection ? 'Link imported requirement' : `Model Browser — ${namespace}`}
      destroyOnHidden
    >
      {selection && (
        <div className="requirement-browser-toolbar">
          <Text>Link to: <Text strong>{selection.targetLabel}</Text></Text>
          <label className="requirement-browser-source">Imported source
            <Select
              aria-label="Imported source"
              value={namespace || undefined}
              options={selection.namespaces}
              onChange={selection.onNamespaceChange}
              disabled={selection.pending}
              placeholder="No available imported sources"
              style={{ minWidth: 200 }}
            />
          </label>
        </div>
      )}
      <div
        className={selection ? 'requirement-browser-body' : undefined}
        style={{
          display: 'flex',
          height: selection ? '68vh' : '80vh',
          overflow: 'hidden',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {/* Left: NamespaceTreePanel in browse mode (filtered to this namespace) */}
        <div
          className={selection ? 'requirement-browser-tree' : undefined}
          style={{
            width: 380,
            flexShrink: 0,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {namespace ? <NamespaceTreePanel
            key={selection ? namespace : undefined}
            ref={treePanelRef}
            onSelect={handleSelect}
            safetyNamespace=""
            browseNamespace={namespace}
            selectionOnly={!!selection}
            renderNodeSuffix={selection ? (element) => selection.isLinked(element)
              ? <Text type="secondary" style={{ marginLeft: 8 }}>Linked</Text>
              : null : undefined}
          /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No available imported sources. Check Settings → Imported Requirement Linking." />}
        </div>

        {/* Right: CenterPanel — rich element details from the analysis view */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <CenterPanel
            onShowRelationshipInTree={handleShowRelationshipInTree}
            namespace={namespace}
            selectedTreeElement={selection ? currentSelection : selected}
            onElementDeleted={handleElementDeleted}
            onNavigateToNode={handleNavigateToNode}
            workspaceKey={workspaceKey}
            allowCreateTag={false}
            allowAddTag={false}
            allowEditNotes={false}
            previewOnly={!!selection}
          />
        </div>
      </div>
    </Modal>
  );
}

// ── GenericModelBrowserView ───────────────────────────────────────────────────
// Mounted by NamespaceRouter as the fallback view for imported namespaces that
// have no dedicated editor. Auto-opens the model browser modal.

interface GenericModelBrowserViewProps {
  ns: NamespaceContext;
}

export function GenericModelBrowserView({ ns }: GenericModelBrowserViewProps) {
  const [open, setOpen] = useState(true);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 32,
      }}
    >
      <Empty
        image={<TableOutlined style={{ fontSize: 40 }} />}
        description={
          <span>
            <Text style={{ fontSize: 13 }}>{ns.name}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              Imported namespace{ns.metamodel ? ` · ${ns.metamodel}` : ''}
            </Text>
          </span>
        }
      />
      <Button type="primary" onClick={() => setOpen(true)}>
        Browse Model
      </Button>
      <GenericModelBrowserModal open={open} onClose={() => setOpen(false)} namespace={ns.name} />
    </div>
  );
}
