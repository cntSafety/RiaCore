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
import { Modal, Spin, Tag, Space, theme } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { useState, useCallback } from 'react';
import { api } from '../../../../../api/riacore';
import type { DeleteImpactPreview } from '@riacore/app-contracts';

interface DeleteWithPreviewProps {
  nodeId: number;
  onConfirm: () => void | Promise<void>;
  /** Called when the user dismisses the modal without confirming (Cancel / mask / Esc). */
  onCancel?: () => void;
  children: (openPreview: () => void) => React.ReactNode;
}

export function DeleteWithPreview({ nodeId, onConfirm, onCancel, children }: DeleteWithPreviewProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<DeleteImpactPreview | null>(null);
  const [confirming, setConfirming] = useState(false);

  const openPreview = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    try {
      const data = await api.safety.previewDeleteImpact(nodeId);
      setPreview(data);
    } catch {
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  const handleOk = async () => {
    setConfirming(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      {children(openPreview)}
      <Modal
        title={<Space><ExclamationCircleOutlined style={{ color: '#faad14' }} />Delete Impact Preview</Space>}
        open={open}
        onOk={handleOk}
        onCancel={() => { setOpen(false); onCancel?.(); }}
        confirmLoading={confirming}
        okText="Delete"
        okButtonProps={{ danger: true }}
        width={480}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : preview ? (
          <div style={{ fontSize: 12 }}>
            <p>Deleting <Tag>{preview.element.concept}</Tag> "{preview.element.name}"</p>
            {preview.ownedChildren.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Owned elements that will also be deleted:</div>
                {preview.ownedChildren.map(c => (
                  <div key={c.node_id} style={{ paddingLeft: 12, color: token.colorTextSecondary }}>
                    <Tag color="red" style={{ fontSize: 11 }}>{c.concept}</Tag> {c.name}
                  </div>
                ))}
              </div>
            )}
            {preview.reviewItems.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Review items that will be removed:</div>
                {preview.reviewItems.map(r => (
                  <div key={r.node_id} style={{ paddingLeft: 12, color: token.colorTextSecondary }}>{r.name}</div>
                ))}
              </div>
            )}
            {preview.relationships.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Relationships that will be removed:</div>
                {preview.relationships.map(r => (
                  <div key={r.edge_id} style={{ paddingLeft: 12, color: token.colorTextSecondary }}>
                    <Tag style={{ fontSize: 11 }}>{r.relationship}</Tag>
                    <span style={{ color: token.colorTextTertiary }}>({r.type})</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, padding: '8px 12px', background: token.colorWarningBg, borderRadius: token.borderRadius, color: token.colorText }}>
              Total: {preview.totalElements} element{preview.totalElements !== 1 ? 's' : ''} and {preview.totalRelationships} relationship{preview.totalRelationships !== 1 ? 's' : ''} will be removed.
            </div>
          </div>
        ) : (
          <p>Unable to load impact preview. The element will be deleted with all owned children.</p>
        )}
      </Modal>
    </>
  );
}
