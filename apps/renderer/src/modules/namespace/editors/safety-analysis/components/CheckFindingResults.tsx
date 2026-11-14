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
import { lazy, Suspense, useState } from 'react';
import { Alert, Button, Drawer, Empty, Space, Spin, Tag, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CheckElementReference, CheckFinding, CheckFindingCategory, CheckRunSummary, CheckViolation } from '@riacore/app-contracts';
import { DataTable } from '../../../../../components/data-table';
import { api } from '../../../../../api/riacore';

const ModelViewCanvas = lazy(() => import('../../model-view/ModelViewCanvas').then(module => ({ default: module.ModelViewCanvas })));
const labels: Record<CheckFindingCategory, string> = {
  mismatch: 'ASIL mismatch', analysis: 'Missing / invalid analysis', unsupported: 'Not supported', unresolved: 'Unresolved connection',
};
const colors: Record<CheckFindingCategory, string> = { mismatch: 'error', analysis: 'warning', unsupported: 'default', unresolved: 'processing' };
const pair = (finding: CheckFinding) => finding.endpoints.map(endpoint => endpoint.label).join(finding.category === 'mismatch' ? ' → ' : ' ↔ ') || 'Unresolved connection';

/** Inspect captured check evidence and open source models without a tree reveal. */
export function CheckFindingResults({ rows, counts, safetyNamespace, workspaceKey, loading }: {
  rows: CheckViolation[];
  counts: CheckRunSummary['findingCounts'];
  safetyNamespace: string;
  workspaceKey: string | null;
  loading?: boolean;
}) {
  const { token } = theme.useToken();
  const [selected, setSelected] = useState<CheckViolation>();
  const [modelTarget, setModelTarget] = useState<CheckElementReference>();
  const [navigationError, setNavigationError] = useState<string>();
  const showDetails = (row: CheckViolation) => { setSelected(row); setModelTarget(undefined); setNavigationError(undefined); };
  const showInTree = async (target: CheckElementReference) => {
    setNavigationError(undefined);
    try {
      await api.window.showInTree({ homeTarget: { nodeId: target.nodeId, namespace: target.namespace, concept: target.concept }, requestKind: 'home', safetyNamespace });
    } catch (error) { setNavigationError(`Could not show this element in the tree: ${String(error)}`); }
  };
  const columns: ColumnsType<CheckViolation> = [
    { title: 'Affected connection', key: 'affected', width: 360, render: (_, row) => {
      const first = row.findings?.[0];
      return <div style={{ overflowWrap: 'anywhere' }}>
        <Button type="link" style={{ padding: 0, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => showDetails(row)}>
          {first ? pair(first) : row.attributeValues.check_affected || 'Unresolved connection'}
        </Button>
        {(row.findings?.length ?? 0) > 1 && <div><Typography.Text type="secondary">{row.findings!.length} connection assessments · open details to inspect each</Typography.Text></div>}
      </div>;
    } },
    { title: 'Assessment', key: 'assessment', width: 190, render: (_, row) => <Space wrap size={[0, 4]}>
      {[...new Set(row.findings?.map(finding => finding.category) ?? [])].map(category => <Tag key={category} color={colors[category]}>{labels[category]}</Tag>)}
    </Space> },
    { title: 'Explanation', key: 'explanation', width: 460, render: (_, row) => <div style={{ color: token.colorText, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{row.findings?.[0]?.message ?? row.attributeValues.check_message}</div> },
    { title: '', key: 'details', width: 105, render: (_, row) => <Button size="middle" onClick={() => showDetails(row)}>View details</Button> },
  ];
  return <>
    <Space wrap style={{ marginBottom: 12 }} aria-label="Assessment counts for all result pages">
      {(['mismatch', 'analysis', 'unsupported', 'unresolved'] as const).filter(category => counts?.[category]).map(category =>
        <Tag key={category} color={colors[category]}>{labels[category]}: {counts![category]}</Tag>)}
    </Space>
    <DataTable<CheckViolation> columns={columns} dataSource={rows} rowKey="nodeId" size="middle" pagination={false} loading={loading}
      scroll={{ x: 1120 }} onRow={row => ({ onDoubleClick: () => showDetails(row) })} />
    <Drawer open={!!selected} title={modelTarget ? "Affected model" : "Connection assessment"} size="min(1100px, 96vw)"
      onClose={() => { setSelected(undefined); setModelTarget(undefined); }} destroyOnHidden>
      <div hidden={!!modelTarget}>
      {selected?.findings?.length ? selected.findings.map((finding, index) => <section key={`${finding.connection.namespace}:${finding.connection.nodeId}:${finding.code}:${index}`}
        style={{ paddingBottom: 20, marginBottom: 20, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Typography.Title level={5} style={{ marginTop: 0, overflowWrap: 'anywhere' }}>{pair(finding)}</Typography.Title>
        <Tag color={colors[finding.category]}>{labels[finding.category]}</Tag>
        <p>{finding.message}</p>
        <Typography.Paragraph><strong>Next step: </strong>{finding.nextStep}</Typography.Paragraph>
        {finding.endpoints.map((endpoint, endpointIndex) => <div key={endpointIndex} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', overflowWrap: 'anywhere' }}>
            <strong>{endpoint.label}</strong>
            <Tag>{endpoint.analysisStatus === 'known' ? `ASIL ${endpoint.asil}` : endpoint.analysisStatus === 'missing' ? 'No port analysis' : endpoint.analysisStatus === 'invalid' ? 'Invalid ASIL' : 'Port unresolved'}</Tag>
          </div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 4, overflowWrap: 'anywhere' }}>{endpoint.path}</Typography.Paragraph>
          <Space wrap>
            {(endpoint.owner || endpoint.port) && <Button size="middle" onClick={() => setModelTarget(endpoint.owner ?? endpoint.port)}>Open in Model</Button>}
            {endpoint.port && <Button type="link" size="middle" onClick={() => { void showInTree(endpoint.port!); }}>Show port in tree</Button>}
            {endpoint.owner && <Button type="link" size="middle" onClick={() => { void showInTree(endpoint.owner!); }}>Show owner in tree</Button>}
          </Space>
        </div>)}
        {!finding.endpoints.some(endpoint => endpoint.owner || endpoint.port) && (finding.context
          ? <Button onClick={() => setModelTarget(finding.context)}>Open owning context in Model</Button>
          : <Alert type="info" showIcon title="No endpoint or owning model context could be resolved from the imported connection." />)}
        <details style={{ marginTop: 16, color: token.colorTextSecondary }}>
          <summary>Connection source details</summary>
          <div style={{ overflowWrap: 'anywhere' }}>{finding.connection.label}</div>
          <div>{finding.connection.concept} · {finding.connection.namespace} · node {finding.connection.nodeId}</div>
          {finding.endpoints.filter(endpoint => endpoint.port).map((endpoint, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>Port declaration: {endpoint.port!.label}</div>)}
        </details>
      </section>) : <Empty description="No captured assessment details are available. Rerun this check." />}
      </div>
      {navigationError && <Alert type="error" showIcon title={navigationError} style={{ marginBottom: 12 }} />}
      {modelTarget && <section aria-label="Affected model" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 150px)', minHeight: 300, border: `1px solid ${token.colorBorderSecondary}` }}>
        <div style={{ padding: 8 }}><Button autoFocus onClick={() => setModelTarget(undefined)}>Back to assessment</Button></div>
        <div style={{ padding: 8, overflowWrap: 'anywhere' }}><strong>{modelTarget.label}</strong></div>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <Suspense fallback={<Spin />}><ModelViewCanvas key={`${workspaceKey}:${modelTarget.namespace}:${modelTarget.nodeId}`}
            namespace={modelTarget.namespace} nodeId={modelTarget.nodeId} workspaceKey={workspaceKey} safetyNamespace={safetyNamespace}
            onNavigateToNode={(nodeId, namespace, concept) => { void showInTree({ nodeId, namespace, concept, label: '' }); }} />
          </Suspense>
        </div>
      </section>}
    </Drawer>
  </>;
}
