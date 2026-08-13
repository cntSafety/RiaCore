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
import { useState, useCallback, useRef } from 'react';
import type { NamespaceContext } from '../../../../store/workspaceStore';
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
