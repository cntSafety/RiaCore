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
import { useState, useCallback, useEffect } from 'react';
import { api } from '../api/riacore';
import type { NamespaceDeleteImpactPreview, NamespaceCrossNsConnectionInfo } from '@riacore/app-contracts';

const { useToken } = theme;

interface NamespaceDeleteWithPreviewProps {
  namespace: string;
  role: 'imported' | 'authored';
  sourceId?: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  /** When true, auto-opens the preview modal on mount (no children needed). */
  autoOpen?: boolean;
  children?: (openPreview: () => void) => React.ReactNode;
}

export function NamespaceDeleteWithPreview({
  namespace,
  role,
  onConfirm,
  onCancel,
  autoOpen,
  children,
}: NamespaceDeleteWithPreviewProps) {
  const { token } = useToken();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<NamespaceDeleteImpactPreview | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const openPreview = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    setFetchError(null);
    setPreview(null);
    try {
      const data = await api.namespaces.previewDeleteImpact(namespace);
      setPreview(data);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [namespace]);

  // Auto-open on mount when requested
  useEffect(() => {
    if (autoOpen) {
      void openPreview();
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOk = async () => {
    setConfirming(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setConfirming(false);
    }
  };

  // Group cross-NS connections by otherNamespace
  const grouped = preview
    ? preview.crossNsConnections.reduce<Record<string, NamespaceCrossNsConnectionInfo[]>>(
        (acc, c) => ({ ...acc, [c.otherNamespace]: [...(acc[c.otherNamespace] ?? []), c] }),
        {},
      )
    : {};

  return (
    <>
      {children?.(openPreview)}
      <Modal
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: '#faad14' }} />
            Delete Namespace — Impact Preview
          </Space>
        }
        open={open}
        onOk={handleOk}
        onCancel={() => { setOpen(false); onCancel?.(); }}
        confirmLoading={confirming}
        okText="Delete"
        okButtonProps={{ danger: true, disabled: loading || fetchError !== null }}
        cancelText="Cancel"
        width={520}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : fetchError !== null ? (
          <div style={{ color: token.colorError, fontSize: 12 }}>
            Failed to load impact preview: {fetchError}
          </div>
        ) : preview ? (
          <div style={{ fontSize: 12 }}>
            <p>
              Deleting{' '}
              <Tag>{role === 'authored' ? 'AUTHORED' : 'IMPORTED'}</Tag>
              namespace <strong>"{preview.namespace}"</strong>
            </p>
            <p>
              <strong>{preview.nodeCount.toLocaleString()}</strong>{' '}
              node{preview.nodeCount !== 1 ? 's' : ''} will be removed from the graph.
            </p>
            {preview.crossNsConnections.length > 0 ? (
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  Cross-namespace connections that will be severed ({preview.crossNsConnections.length}):
                </div>
                {Object.entries(grouped).map(([ns, conns]) => (
                  <div key={ns} style={{ marginBottom: 8 }}>
                    <div style={{ color: token.colorTextSecondary, marginBottom: 2 }}>
                      Namespace: <Tag>{ns}</Tag>
                    </div>
                    {conns.map((c, i) => (
                      <div key={i} style={{ paddingLeft: 12, color: token.colorTextSecondary }}>
                        <Tag style={{ fontSize: 11 }}>{c.relationship}</Tag>
                        <Tag color="blue" style={{ fontSize: 11 }}>{c.otherConcept}</Tag>
                        {c.otherNodeName}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: token.colorTextSecondary }}>
                No cross-namespace connections will be affected.
              </p>
            )}
            <p style={{ color: token.colorWarning, marginTop: 12, marginBottom: 0, fontWeight: 500 }}>
              This action is irreversible.
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
