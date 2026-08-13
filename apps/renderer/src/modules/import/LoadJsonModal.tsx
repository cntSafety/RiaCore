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
import { Modal, Alert, Spin, Descriptions, Tag, Button, Space, theme, Divider, Statistic, Row, Col } from 'antd';
import {
  CheckCircleOutlined,
  SyncOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import type { LoadResult, DbStats } from '@riacore/app-contracts';
import { api } from '../../api/riacore';

const { useToken } = theme;

interface LoadJsonModalProps {
  open: boolean;
  loading: boolean;
  result: LoadResult | null;
  error: string | null;
  workingDir: string | null;
  dbStats: DbStats | null;
  onClose: () => void;
}

export function LoadJsonModal({
  open,
  loading,
  result,
  error,
  workingDir,
  dbStats,
  onClose,
}: LoadJsonModalProps) {
  const { token } = useToken();

  const isUpToDate =
    result !== null &&
    result.namespaces_imported.length === 0 &&
    result.namespaces_skipped.length > 0;

  const openLog = () => {
    if (result?.log_file) {
      void api.shell.openPath(result.log_file);
    }
  };

  return (
    <Modal
      title="Load Serialised JSON"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          {result?.log_file && (
            <Button size="small" icon={<FileTextOutlined />} onClick={openLog} style={{ fontSize: 11 }}>
              Open Log
            </Button>
          )}
          <Button type="primary" onClick={onClose} size="small">Close</Button>
        </Space>
      }
      width={500}
    >
      {/* Source directory */}
      <div style={{
        fontSize: 11,
        color: token.colorTextTertiary,
        fontFamily: 'monospace',
        wordBreak: 'break-all',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <FolderOpenOutlined style={{ flexShrink: 0 }} />
        {workingDir ?? '—'}
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', gap: 12 }}>
          <Spin size="large" />
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>Loading namespaces…</span>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <>
          <Alert
            type="error"
            message="Load failed"
            description={error}
            showIcon
            style={{ marginBottom: 12 }}
          />
          <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
            Make sure you selected the <strong>workspace root</strong> — the folder that contains the <code>ria-data/</code> subdirectory.
          </div>
        </>
      )}

      {/* Success */}
      {!loading && result && (
        <>
          {/* Status banner */}
          {isUpToDate ? (
            <Alert
              type="info"
              icon={<SyncOutlined />}
              message="Already up to date"
              description="The database already contains this data — all namespaces were skipped because their hashes have not changed."
              showIcon
              style={{ marginBottom: 12 }}
            />
          ) : (
            <Alert
              type="success"
              icon={<CheckCircleOutlined />}
              message={`Load complete — ${result.total_records_imported.toLocaleString()} records imported`}
              showIcon
              style={{ marginBottom: 12 }}
            />
          )}

          {/* Stats table */}
          <Descriptions
            column={1}
            size="small"
            bordered
            labelStyle={{ fontSize: 11, width: 160 }}
            contentStyle={{ fontSize: 12 }}
          >
            <Descriptions.Item label="Records">
              {result.total_records_imported.toLocaleString()}
            </Descriptions.Item>

            <Descriptions.Item label="Namespaces imported">
              {result.namespaces_imported.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {result.namespaces_imported.map((ns) => (
                    <Tag key={ns} color="blue" style={{ fontSize: 11, margin: 0 }}>{ns}</Tag>
                  ))}
                </div>
              ) : (
                <span style={{ color: token.colorTextTertiary }}>none</span>
              )}
            </Descriptions.Item>

            <Descriptions.Item label="Namespaces skipped">
              {result.namespaces_skipped.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {result.namespaces_skipped.map((ns) => (
                    <Tag key={ns} style={{ fontSize: 11, margin: 0 }}>{ns}</Tag>
                  ))}
                </div>
              ) : (
                <span style={{ color: token.colorTextTertiary }}>none</span>
              )}
            </Descriptions.Item>

            {result.log_file && (
              <Descriptions.Item label="Log file">
                <span
                  style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', cursor: 'pointer', color: token.colorPrimary }}
                  onClick={openLog}
                  title="Click to open in default viewer"
                >
                  {result.log_file}
                </span>
              </Descriptions.Item>
            )}
          </Descriptions>

          {/* DB stats */}
          {dbStats && (
            <>
              <Divider style={{ margin: '12px 0 8px' }}>
                <Space size={4} style={{ fontSize: 11, color: token.colorTextSecondary }}>
                  <DatabaseOutlined />
                  Database
                </Space>
              </Divider>
              <Row gutter={16} justify="space-around">
                <Col>
                  <Statistic
                    title={<span style={{ fontSize: 11 }}>Namespaces</span>}
                    value={dbStats.namespace_count}
                    valueStyle={{ fontSize: 20 }}
                  />
                </Col>
                <Col>
                  <Statistic
                    title={<span style={{ fontSize: 11 }}>Nodes</span>}
                    value={dbStats.node_count}
                    valueStyle={{ fontSize: 20 }}
                  />
                </Col>
                <Col>
                  <Statistic
                    title={<span style={{ fontSize: 11 }}>Edges</span>}
                    value={dbStats.edge_count}
                    valueStyle={{ fontSize: 20 }}
                  />
                </Col>
              </Row>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
