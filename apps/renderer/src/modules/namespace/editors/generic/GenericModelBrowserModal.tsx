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
import { Modal, Empty, Typography, Button, theme } from 'antd';
import { TableOutlined } from '@ant-design/icons';
import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import { useWorkspaceState } from '../../../../hooks/useWorkspaceState';
import { NamespaceTreePanel } from '../safety-analysis/components/NamespaceTreePanel';
import type { NamespaceTreePanelHandle } from '../safety-analysis/components/NamespaceTreePanel';
import { CenterPanel } from '../safety-analysis/components/CenterPanel';
import type { SelectedTreeElement } from '../safety-analysis/types';

const { Text } = Typography;
const { useToken } = theme;

// ── GenericModelBrowserModal ──────────────────────────────────────────────────

interface GenericModelBrowserModalProps {
  open: boolean;
  onClose: () => void;
  /** The specific imported namespace to browse. */
  namespace: string;
}

export function GenericModelBrowserModal({ open, onClose, namespace }: GenericModelBrowserModalProps) {
  const { token } = useToken();
  const [selected, setSelected] = useState<SelectedTreeElement | null>(null);
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

  const handleNavigateToNode = useCallback((nodeId: number, ns: string, concept: string) => {
    void treePanelRef.current?.navigateToNode(nodeId, ns, concept);
  }, []);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="90vw"
      style={{ top: 16, maxWidth: 1400 }}
      styles={{ body: { padding: 0 } }}
      title={`Model Browser — ${namespace}`}
      destroyOnHidden
    >
      <div
        style={{
          display: 'flex',
          height: '80vh',
          overflow: 'hidden',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {/* Left: NamespaceTreePanel in browse mode (filtered to this namespace) */}
        <div
          style={{
            width: 380,
            flexShrink: 0,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <NamespaceTreePanel
            ref={treePanelRef}
            onSelect={handleSelect}
            safetyNamespace=""
            browseNamespace={namespace}
          />
        </div>

        {/* Right: CenterPanel — rich element details from the analysis view */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <CenterPanel
            namespace={namespace}
            selectedTreeElement={selected}
            onNavigateToNode={handleNavigateToNode}
            workspaceKey={workspaceKey}
            allowCreateTag={false}
            allowAddTag={false}
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
