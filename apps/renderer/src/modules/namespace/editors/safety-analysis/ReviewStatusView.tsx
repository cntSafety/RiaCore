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
import { Button, Empty, Input, Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { AuditOutlined, WarningOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ColumnsType } from 'antd/es/table';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import type { ConceptInstanceData, ProfileReviewOption } from '@riacore/app-contracts';
import { useAllReviewItems, useMalfunctions } from './hooks/useSafetyQueries';
import { useSafetyProfileMetadata } from './hooks/useSafetyProfileMetadata';
import { api } from '../../../../api/riacore';
import { DataTable } from '../../../../components/data-table';
import { ShowInTreeTrigger } from '../../../../components/ShowInTreeTrigger';

interface ReviewDetail {
  fmNodeId: number;
  fmNamespace: string;
  fmName: string;
  elementName: string;
  elementConcept: string;
  stablePath: string;
}

interface ReviewStatusRow {
  nodeId: number;
  reviewItem: ConceptInstanceData;
  reviewerComment: string;
  verdict: string;
  authorComment: string;
  authorStatus: string;
  detail?: ReviewDetail;
}

// ---------------------------------------------------------------------------
// Details query — resolves the malfunction + its occurs-at element for each
// review item (reuses api.safety.getMalfunctionForReviewItem / getMalfunction /
// getInstance, the same chain SafetyTasksView uses for linked malfunctions).
// ---------------------------------------------------------------------------

function useReviewDetails(reviewItems: ConceptInstanceData[]) {
  return useQuery({
    queryKey: ['review.details', reviewItems.map((r) => r.node_id).join(',')],
    queryFn: async () => {
      const details = new Map<number, ReviewDetail>();
      for (const ri of reviewItems) {
        try {
          const fm = await api.safety.getMalfunctionForReviewItem(ri.node_id);
          if (!fm) continue;
          const fmData = await api.safety.getMalfunction(fm.node_id);
          const target = fmData.occursAtTarget;
          let elementName = '';
          let elementConcept = '';
          let stablePath = '';
          if (target) {
            elementConcept = target.concept ?? '';
            const inst = await api.safety.getInstance(target.node_id);
            elementName = String(
              inst.attributes?.has_name ?? inst.attributes?.element_name ?? target.name ?? target.concept,
            );
            stablePath = String(inst.attributes?.stable_path ?? '');
          }
          details.set(ri.node_id, {
            fmNodeId: fm.node_id,
            fmNamespace: fm.namespace,
            fmName: String(fm.attributes?.has_name ?? `FM ${fm.node_id}`),
            elementName,
            elementConcept,
            stablePath,
          });
        } catch {
          /* skip individual failures */
        }
      }
      return details;
    },
    enabled: reviewItems.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Small reusable text-search filter dropdown (matches SafetyTasksView columns).
// ---------------------------------------------------------------------------

function textFilterDropdown(placeholder: string) {
  return ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: {
    setSelectedKeys: (keys: React.Key[]) => void;
    selectedKeys: React.Key[];
    confirm: () => void;
    clearFilters?: () => void;
  }) => (
    <div style={{ padding: 8 }}>
      <Input
        placeholder={placeholder}
        value={selectedKeys[0] as string}
        onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
        onPressEnter={() => confirm()}
        style={{ width: 220, marginBottom: 8, display: 'block' }}
      />
      <Space>
        <Button type="primary" size="small" onClick={() => confirm()} style={{ width: 90 }}>Filter</Button>
        <Button size="small" onClick={() => { clearFilters?.(); confirm(); }} style={{ width: 90 }}>Reset</Button>
      </Space>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statistics strip
// ---------------------------------------------------------------------------

function StatBox({ label, value, hint, color, footer }: { label: string; value: string; hint?: string; color?: string; footer?: React.ReactNode }) {
  const { token } = theme.useToken();
  const box = (
    <div
      style={{
        minWidth: 120,
        padding: '8px 14px',
        borderRadius: 8,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ fontSize: 11, color: token.colorTextSecondary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: color ?? token.colorText, lineHeight: 1.2 }}>{value}</div>
      {footer}
    </div>
  );
  return hint ? <Tooltip title={hint}>{box}</Tooltip> : box;
}

/** A compact colored-dot + "label count" item that reads well in light and dark mode. */
function DotStat({ color, label, count }: { color: string; label: string; count: number }) {
  const { token } = theme.useToken();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextSecondary }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: color, display: 'inline-block' }} />
      {label}
      <span style={{ color: token.colorText, fontWeight: 600 }}>{count}</span>
    </span>
  );
}

/** Author-resolution breakdown rendered inside a verdict card footer (Not OK / Note). */
function resolutionFooter(
  statusCounts: Record<string, number> | undefined,
  total: number,
  authorStatuses: ProfileReviewOption[],
): React.ReactNode {
  if (!statusCounts || total <= 0) return undefined;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6 }}>
      {authorStatuses.map((status) => (
        <DotStat
          key={status.value}
          color={status.color ?? '#8c8c8c'}
          label={status.label}
          count={statusCounts[status.value] ?? 0}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function ReviewStatusView({ ns }: { ns: NamespaceContext }) {
  const { token } = theme.useToken();
  const profile = useSafetyProfileMetadata();
  const verdictMeta = useMemo(
    () => Object.fromEntries(profile.verdicts.map((option) => [option.value, option])),
    [profile.verdicts],
  );
  const authorStatusMeta = useMemo(
    () => Object.fromEntries(profile.authorStatuses.map((option) => [option.value, option])),
    [profile.authorStatuses],
  );
  const reviewItemsQuery = useAllReviewItems(ns.name);
  const malfunctionsQuery = useMalfunctions(ns.name);
  const reviewItems = useMemo(() => reviewItemsQuery.data ?? [], [reviewItemsQuery.data]);
  const malfunctions = malfunctionsQuery.data ?? [];
  const detailsQuery = useReviewDetails(reviewItems);

  const rows = useMemo<ReviewStatusRow[]>(() => {
    const details = detailsQuery.data;
    return reviewItems.map((ri) => ({
      nodeId: ri.node_id,
      reviewItem: ri,
      reviewerComment: String(ri.attributes?.reviewer_comment ?? ''),
      verdict: String(ri.attributes?.reviewer_verdict ?? ''),
      authorComment: String(ri.attributes?.author_comment ?? ''),
      authorStatus: String(ri.attributes?.author_status ?? ''),
      detail: details?.get(ri.node_id),
    }));
  }, [reviewItems, detailsQuery.data]);

  // ── Statistics ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const totalMalfunctions = malfunctions.length;

    // Reviewed malfunctions = unique malfunctions that have at least one review item.
    const reviewedFmIds = new Set<number>();
    for (const row of rows) {
      if (row.detail) reviewedFmIds.add(row.detail.fmNodeId);
    }
    const reviewedCount = reviewedFmIds.size;
    const reviewedPct = totalMalfunctions > 0 ? Math.round((reviewedCount / totalMalfunctions) * 100) : 0;

    // Verdict and author-status breakdowns follow profile declaration order.
    const verdictCounts: Record<string, number> = Object.fromEntries(
      profile.verdicts.map((verdict) => [verdict.value, 0]),
    );
    let awaitingVerdict = 0;
    const emptyStatus = (): Record<string, number> => Object.fromEntries(
      profile.authorStatuses.map((status) => [status.value, 0]),
    );
    const statusByVerdict: Record<string, Record<string, number>> = Object.fromEntries(
      profile.verdicts.map((verdict) => [verdict.value, emptyStatus()]),
    );

    for (const row of rows) {
      if (!row.verdict) {
        awaitingVerdict += 1;
        continue;
      }
      verdictCounts[row.verdict] = (verdictCounts[row.verdict] ?? 0) + 1;
      const status = row.authorStatus || profile.authorStatusDefault;
      if (statusByVerdict[row.verdict]) {
        statusByVerdict[row.verdict][status] = (statusByVerdict[row.verdict][status] ?? 0) + 1;
      }
    }

    return {
      totalMalfunctions,
      reviewedCount,
      reviewedPct,
      verdictCounts,
      awaitingVerdict,
      statusByVerdict,
    };
  }, [malfunctions, rows, profile.verdicts, profile.authorStatuses, profile.authorStatusDefault]);

  // ── Column filter option lists ──────────────────────────────────────────
  const malfunctionFilters = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.detail?.fmName ?? '').filter((v) => v !== '')))
        .sort()
        .map((v) => ({ text: v, value: v })),
    [rows],
  );

  const elementFilters = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.detail?.elementName ?? '').filter((v) => v !== '')))
        .sort()
        .map((v) => ({ text: v, value: v })),
    [rows],
  );

  const columns = useMemo<ColumnsType<ReviewStatusRow>>(() => [
    {
      title: 'Malfunction',
      key: 'malfunction',
      width: 240,
      ellipsis: true,
      sorter: (a, b) => (a.detail?.fmName ?? '').localeCompare(b.detail?.fmName ?? ''),
      filters: malfunctionFilters,
      filterSearch: true,
      onFilter: (value, record) => (record.detail?.fmName ?? '') === String(value),
      render: (_, record) => {
        if (!record.detail) return <Typography.Text type="secondary">—</Typography.Text>;
        const { fmNodeId, fmNamespace, fmName } = record.detail;
        return (
          <ShowInTreeTrigger
            homeTarget={{ nodeId: fmNodeId, namespace: fmNamespace, concept: 'malfunction' }}
            safetyNamespace={ns.name}
          >
            <span style={{ cursor: 'context-menu' }}>
              <WarningOutlined style={{ color: '#faad14', marginRight: 6 }} />
              <Typography.Text strong>{fmName}</Typography.Text>
            </span>
          </ShowInTreeTrigger>
        );
      },
    },
    {
      title: 'Occurs at',
      key: 'element',
      width: 200,
      ellipsis: true,
      sorter: (a, b) => (a.detail?.elementName ?? '').localeCompare(b.detail?.elementName ?? ''),
      filters: elementFilters,
      filterSearch: true,
      onFilter: (value, record) => (record.detail?.elementName ?? '') === String(value),
      render: (_, record) => {
        const d = record.detail;
        if (!d || !d.elementName) return <Typography.Text type="secondary">(not attached)</Typography.Text>;
        return (
          <span>
            {d.elementName}
            {d.elementConcept ? (
              <Tag style={{ marginLeft: 6 }}>{d.elementConcept}</Tag>
            ) : null}
          </span>
        );
      },
    },
    {
      title: 'Stable path',
      key: 'stablePath',
      width: 240,
      ellipsis: true,
      sorter: (a, b) => (a.detail?.stablePath ?? '').localeCompare(b.detail?.stablePath ?? ''),
      filterDropdown: textFilterDropdown('Search path…'),
      onFilter: (value, record) =>
        (record.detail?.stablePath ?? '').toLowerCase().includes(String(value).toLowerCase()),
      render: (_, record) => {
        const path = record.detail?.stablePath ?? '';
        return path ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
            {path}
          </Typography.Text>
        ) : null;
      },
    },
    {
      title: 'Review comment',
      dataIndex: 'reviewerComment',
      key: 'reviewerComment',
      width: 260,
      ellipsis: true,
      filterDropdown: textFilterDropdown('Search comment…'),
      onFilter: (value, record) =>
        record.reviewerComment.toLowerCase().includes(String(value).toLowerCase()),
      render: (value: string) => (value ? <Typography.Text>{value}</Typography.Text> : null),
    },
    {
      title: 'Verdict',
      dataIndex: 'verdict',
      key: 'verdict',
      width: 120,
      filters: [
        ...profile.verdicts.map((verdict) => ({ text: verdict.label, value: verdict.value })),
        { text: 'Awaiting verdict', value: '' },
      ],
      onFilter: (value, record) => record.verdict === String(value),
      render: (value: string) => {
        const meta = verdictMeta[value];
        if (!meta) return <Tag>Awaiting verdict</Tag>;
        return <Tag color={meta.tag ?? meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: 'Author response',
      dataIndex: 'authorComment',
      key: 'authorComment',
      width: 260,
      ellipsis: true,
      filterDropdown: textFilterDropdown('Search response…'),
      onFilter: (value, record) =>
        record.authorComment.toLowerCase().includes(String(value).toLowerCase()),
      render: (value: string) =>
        value ? <Typography.Text>{value}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Author status',
      dataIndex: 'authorStatus',
      key: 'authorStatus',
      width: 130,
      filters: profile.authorStatuses.map((status) => ({ text: status.label, value: status.value })),
      onFilter: (value, record) => (record.authorStatus || profile.authorStatusDefault) === String(value),
      render: (value: string, record) => {
        if (!record.verdict) return null;
        const meta = authorStatusMeta[value || profile.authorStatusDefault];
        return meta ? <Tag color={meta.tag ?? meta.color}>{meta.label}</Tag> : null;
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [malfunctionFilters, elementFilters, ns.name, profile.verdicts, profile.authorStatuses, profile.authorStatusDefault, verdictMeta, authorStatusMeta]);

  if (reviewItemsQuery.isLoading || malfunctionsQuery.isLoading || profile.isLoading) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>;
  }

  if (profile.error) {
    return <Empty description={`Could not load safety profile metadata: ${profile.error.message}`} style={{ marginTop: 64 }} />;
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, background: token.colorBgLayout, minWidth: 560 }}>
      <Space direction="vertical" size={12} style={{ width: '100%', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          <AuditOutlined style={{ color: token.colorPrimary, marginRight: 8 }} />
          Review Status — {ns.name}
        </Typography.Title>

        {/* Coverage + verdict statistics */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <StatBox label="Malfunctions" value={String(stats.totalMalfunctions)} hint="Total malfunctions in this namespace (100%)" />
          <StatBox
            label="Reviewed"
            value={`${stats.reviewedCount} (${stats.reviewedPct}%)`}
            hint="Malfunctions with at least one review item"
            color={token.colorPrimary}
          />
          {profile.verdicts.map((verdict) => {
            const count = stats.verdictCounts[verdict.value] ?? 0;
            return (
              <StatBox
                key={verdict.value}
                label={verdict.label}
                value={String(count)}
                color={verdict.color}
                hint={verdict.description}
                footer={verdict.showAuthorStatusBreakdown
                  ? resolutionFooter(stats.statusByVerdict[verdict.value], count, profile.authorStatuses)
                  : undefined}
              />
            );
          })}
          {stats.awaitingVerdict > 0 && (
            <StatBox label="Awaiting verdict" value={String(stats.awaitingVerdict)} hint="Review items without a reviewer verdict yet" />
          )}
        </div>

        {detailsQuery.isLoading && <Spin size="small" />}
      </Space>

      {reviewItems.length === 0 ? (
        <Empty description="No review items in this namespace" style={{ marginTop: 64 }} />
      ) : (
        <DataTable<ReviewStatusRow>
          columns={columns}
          dataSource={rows}
          rowKey="nodeId"
        />
      )}
    </div>
  );
}
