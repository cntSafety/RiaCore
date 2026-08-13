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
import { Alert, Button, Checkbox, Collapse, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import {
  CheckCircleFilled, CheckCircleOutlined, ClockCircleOutlined,
  DownloadOutlined, ExclamationCircleFilled,
  MenuFoldOutlined, MenuUnfoldOutlined,
  PlayCircleOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import { useWorkspaceStore } from '../../../../store/workspaceStore';
import type {
  ApplicableCheck,
  CheckRunSummary,
  CheckViolation,
} from '@riacore/app-contracts';
// resolveAttributeKey / resolveAttributeLabel are intentionally defined locally
// rather than imported from @riacore/app-contracts because the dist/index.js uses
// CJS __exportStar which Rollup cannot statically analyze for named exports.
import type { CheckAttributeEntry } from '@riacore/app-contracts';
function resolveAttributeKey(entry: CheckAttributeEntry): string {
  if (typeof entry === 'string') return entry;
  return Object.keys(entry)[0] ?? '';
}
function resolveAttributeLabel(entry: CheckAttributeEntry): string {
  if (typeof entry === 'string') return entry;
  const key = Object.keys(entry)[0] ?? '';
  const alias = (entry as Record<string, string>)[key];
  return alias && alias.length > 0 ? alias : key;
}
import { useRunCheck, useLoadApplicableChecks, useCheckPage, useLoadCheckSelection, useSaveCheckSelection, useSaveCheckSummary } from '../../../../hooks/useChecks';
import { DataTable } from '../../../../components/data-table';
import { ShowInTreeTrigger } from '../../../../components/ShowInTreeTrigger';
import { api } from '../../../../api/riacore';
import './safety-editor.css';

const { Text } = Typography;

function conceptColor(concept: string): string {
  switch (concept) {
    case 'malfunction': return 'red';
    case 'safety_task': return 'orange';
    case 'requirement': return 'blue';
    case 'safety_note': return 'purple';
    case 'review_item': return 'cyan';
    case 'application_swc': return 'geekblue';
    case 'ecu_abstraction_swc': return 'geekblue';
    case 'cdd_swc': return 'geekblue';
    case 'r_port': return 'green';
    case 'p_port': return 'lime';
    default: return 'default';
  }
}

function uniqueFilters<T>(items: T[], field: keyof T): { text: string; value: string }[] {
  const seen = new Set<string>();
  for (const item of items) {
    const val = item[field];
    if (typeof val === 'string' && val) seen.add(val);
  }
  return Array.from(seen).sort().map(v => ({ text: v, value: v }));
}


function asilTagColor(asil: string | undefined): string {
  if (!asil) return 'default';
  const u = asil.toUpperCase();
  if (u.includes('D')) return 'red';
  if (u.includes('C')) return 'volcano';
  if (u.includes('B')) return 'orange';
  if (u.includes('A')) return 'gold';
  return 'default';
}


// -- CheckSelectionSplash ------------------------------------------------------

function severityColor(severity: string): string {
  if (severity === 'Error') return 'red';
  if (severity === 'Warning') return 'orange';
  return 'blue';
}

/**
 * Shown when no check has been run yet. Loads applicable checks from the
 * server, groups them by category, and lets the user select which to run.
 */
function CheckSelectionSplash({
  namespace,
  onRunSelected,
  isRunning,
  initialSelectedIds,
}: {
  namespace: string;
  onRunSelected: (selectedIds: string[]) => void;
  isRunning: boolean;
  initialSelectedIds?: string[];
}) {
  const { token } = theme.useToken();
  const { data: applicableChecks, isLoading, isError } = useLoadApplicableChecks(namespace);

  // Group by category (empty category string ? 'General')
  const grouped = useMemo(() => {
    const map = new Map<string, ApplicableCheck[]>();
    for (const c of applicableChecks ?? []) {
      const cat = c.category || 'General';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(c);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [applicableChecks]);

  const allIds = useMemo(() => (applicableChecks ?? []).map(c => c.id), [applicableChecks]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Initialise selection once checks have loaded. On first load, honour the
  // persisted selection but auto-include any new checks that weren't in the
  // saved selection (so newly added built-in checks are selected by default).
  // On subsequent reloads (rare), fall back to all applicable IDs.
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (allIds.length === 0) return;
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      if (initialSelectedIds && initialSelectedIds.length > 0) {
        const savedSet = new Set(initialSelectedIds);
        // Start from the saved selection (preserves explicit deselections), then
        // add any check IDs that are new (not present in the saved set at all).
        // This ensures newly added built-in checks are selected by default.
        const savedAndApplicable = allIds.filter(id => savedSet.has(id));
        const brandNew = allIds.filter(id => !savedSet.has(id));
        setSelectedIds(new Set([...savedAndApplicable, ...brandNew]));
      } else {
        setSelectedIds(new Set(allIds));
      }
    } else {
      // Checks reloaded — reset to all
      setSelectedIds(new Set(allIds));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allIds]); // intentionally excludes initialSelectedIds — only used for first init

  const toggleId = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((catIds: string[], checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of catIds) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, background: token.colorBgLayout }}>
        <Spin /> <Typography.Text type="secondary">Loading checks�</Typography.Text>
      </div>
    );
  }

  if (isError || !applicableChecks) {
    return (
      <div style={{ flex: 1, padding: 24, background: token.colorBgLayout }}>
        <Alert type="error" message="Failed to load checks for this namespace." showIcon />
      </div>
    );
  }

  if (applicableChecks.length === 0) {
    return (
      <div style={{ flex: 1, padding: 24, background: token.colorBgLayout }}>
        <Alert type="info" message="No checks are configured for this namespace. Add checks to ria-data/checks.json." showIcon />
      </div>
    );
  }

  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: '48px 24px',
      background: token.colorBgLayout,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    }}>
      <div style={{ maxWidth: 680, width: '100%' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14,
          background: token.colorPrimaryBg, color: token.colorPrimary,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 26, marginBottom: 20,
        }}>
          <SafetyCertificateOutlined />
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, color: token.colorText, letterSpacing: '-0.015em' }}>
          Run model checks
        </div>
        <div style={{ fontSize: 14, color: token.colorTextSecondary, marginTop: 8, lineHeight: 1.55, maxWidth: 560 }}>
          Select which checks to run. Each check queries the namespace and lists violations.
        </div>

        <div style={{ marginTop: 28 }}>
          <Collapse
            defaultActiveKey={[]}
            style={{ background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 12 }}
          >
            {grouped.map(([cat, checks]) => {
              const catIds = checks.map(c => c.id);
              const allCatSelected = catIds.every(id => selectedIds.has(id));
              const someCatSelected = catIds.some(id => selectedIds.has(id));
              const activatedCount = checks.filter(c => selectedIds.has(c.id)).length;
              return (
                <Collapse.Panel
                  key={cat}
                  header={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                      <Checkbox
                        checked={allCatSelected}
                        indeterminate={!allCatSelected && someCatSelected}
                        onClick={e => e.stopPropagation()}
                        onChange={e => toggleCategory(catIds, e.target.checked)}
                      />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{cat}</span>
                      <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{`(${activatedCount}/${checks.length})`}</span>
                    </span>
                  }
                >
                  {checks.map(c => (
                    <div key={c.id} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      padding: '10px 4px',
                    }}>
                      <Checkbox
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleId(c.id)}
                        style={{ marginTop: 2 }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: token.colorText }}>{c.name}</div>
                        {c.description && (
                          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 3, lineHeight: 1.5 }}>{c.description}</div>
                        )}
                      </div>
                      <Tag color={severityColor(c.severity)} style={{ margin: 0, fontSize: 11 }}>{c.severity}</Tag>
                    </div>
                  ))}
                </Collapse.Panel>
              );
            })}
          </Collapse>
        </div>

        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            type="primary"
            size="large"
            icon={<PlayCircleOutlined />}
            loading={isRunning}
            disabled={selectedIds.size === 0}
            onClick={() => onRunSelected(Array.from(selectedIds))}
          >
            Run {selectedIds.size} check{selectedIds.size !== 1 ? 's' : ''}
          </Button>
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {selectedIds.size} of {applicableChecks.length} selected
          </span>
        </div>
      </div>
    </div>
  );
}

// Page size shared between the run call and the ViolationTable component so the
// backend returns the correct first page and hasMore is accurate.
const CHECK_PAGE_SIZE = 100;

// -- ViolationTable ------------------------------------------------------------

/**
 * Generic table rendering violations for a single completed check run.
 * Columns are derived from the check's `attributes` list plus a fixed `concept` column.
 * Handles pagination by calling `checks.getPage`.
 *
 * Navigation:
 *  - Double-click any row ? navigate to the violation element in the model tree.
 *  - Right-click any row ? context menu with "Show in Tree" item ? same navigation.
 */
function ViolationTable({
  summary,
  check,
  onRerun,
  isRerunning,
}: {
  summary: CheckRunSummary;
  check: ApplicableCheck;
  onRerun: () => void;
  isRerunning: boolean;
}) {
  const { token } = theme.useToken();
  const PAGE_SIZE = CHECK_PAGE_SIZE;
  const [currentPage, setCurrentPage] = useState(0);

  const isFirstPage = currentPage === 0;

  // Use first page from summary, subsequent pages from the getPage hook
  const pageQuery = useCheckPage(isFirstPage ? null : summary.runId, currentPage, PAGE_SIZE);
  const pageData = isFirstPage ? summary.firstPage : pageQuery.data;
  const violations: CheckViolation[] = pageData?.violations ?? [];

  // -- Navigation helpers ----------------------------------------------------

  const navigateViolation = useCallback(async (violation: CheckViolation) => {
    try {
      await api.window.showInTree({
        homeTarget: {
          nodeId: violation.nodeId,
          namespace: violation.namespace,
          concept: violation.concept,
        },
        requestKind: 'home',
      });
    } catch (err) {
      console.warn('[ViolationTable] showInTree dispatch failed', err);
    }
  }, []);

  // -- Columns ---------------------------------------------------------------

  const columns: ColumnsType<CheckViolation> = useMemo(() => {
    const fixedCols: ColumnsType<CheckViolation> = [
      {
        title: 'Concept',
        dataIndex: 'concept',
        key: 'concept',
        width: 140,
        sorter: (a, b) => (a.concept ?? '').localeCompare(b.concept ?? ''),
        render: (concept: string, record: CheckViolation) => concept
          ? (
            <ShowInTreeTrigger
              homeTarget={{ nodeId: record.nodeId, namespace: record.namespace, concept: record.concept }}
            >
              <Tag color="default" style={{ fontSize: 11, margin: 0, cursor: 'context-menu' }}>{concept}</Tag>
            </ShowInTreeTrigger>
          )
          : <Typography.Text type="secondary">—</Typography.Text>,
      },
    ];

    const attrCols: ColumnsType<CheckViolation> = check.attributes.map(attr => {
      const attrKey = resolveAttributeKey(attr);
      const attrLabel = resolveAttributeLabel(attr);
      return {
        title: attrLabel,
        key: attrKey,
        width: 180,
        ellipsis: true,
        sorter: (a: CheckViolation, b: CheckViolation) => String(a.attributeValues?.[attrKey] ?? '').localeCompare(String(b.attributeValues?.[attrKey] ?? '')),
        render: (_: unknown, record: CheckViolation) => {
          const val = record.attributeValues[attrKey];
          return val || <Typography.Text type="secondary">�</Typography.Text>;
        },
      };
    });

    return [...fixedCols, ...attrCols];
  }, [check.attributes]);

  const issueCount = summary.totalViolations;
  const isOk = issueCount === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <CheckHeader
        title={check.name}
        subtitle={check.description || ''}
        issueCount={issueCount}
        allOkCopy="No violations found"
        issueCopy="violations"
        onRun={onRerun}
        isRunning={isRerunning}
        severity={check.severity}
      />
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', background: token.colorBgLayout }}>
        {isOk ? (
          <div style={{ padding: '16px', fontSize: 13, color: token.colorTextSecondary }}>
            <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 8 }} />
            No violations found for this check.
          </div>
        ) : (
          <>
            <DataTable<CheckViolation>
              columns={columns}
              dataSource={violations}
              rowKey="nodeId"
              scroll={{ x: 'max-content' }}
              style={{ fontSize: 12 }}
              pagination={false}
              onRow={(record) => ({
                onDoubleClick: () => { void navigateViolation(record); },
                style: { cursor: 'pointer' },
              })}
            />
            {(pageData?.hasMore || currentPage > 0) && (
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                  Page {currentPage + 1} · {issueCount} total violations
                </span>
                <Button
                  disabled={currentPage === 0}
                  onClick={() => setCurrentPage(p => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  disabled={!pageData?.hasMore}
                  onClick={() => setCurrentPage(p => p + 1)}
                  loading={pageQuery.isFetching}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CheckErrorPane({ check, error, onRerun, isRerunning }: { check: ApplicableCheck; error?: string; onRerun: () => void; isRerunning: boolean }) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        padding: '20px 24px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        display: 'flex', gap: 16, alignItems: 'flex-start',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10,
          background: 'rgba(250,140,22,0.10)', color: '#fa8c16',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
        }}>
          <ExclamationCircleFilled />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: token.colorText }}>{check.name}</div>
          <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 4 }}>{check.description}</div>
          <div style={{ marginTop: 12 }}>
            <Alert type="error" message={error ? `Failed to run check: ${error}` : 'Failed to run check (unknown error)'} showIcon />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={isRerunning} onClick={onRerun}>Re-run check</Button>
        </div>
      </div>
      <div style={{ flex: 1, padding: '20px 24px', background: token.colorBgLayout }}>
        <div style={{ color: token.colorTextSecondary }}>This check returned an error when executed. Select Re-run to try again, or inspect the check definition.</div>
      </div>
    </div>
  );
}

// ── CategoryNav ───────────────────────────────────────────────────────────────

interface CategoryItem {
  key: string;
  label: string;
  issues: number;
  severity: string;
  /** If present the check failed to run and this contains the error message */
  error?: string;
}

function CategoryNav({
  categories, activeKey, onSelect, checkedAt, hideSuccessful, onToggleHideSuccessful,
}: {
  categories: CategoryItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  checkedAt: string;
  hideSuccessful: boolean;
  onToggleHideSuccessful: (v: boolean) => void;
}) {
  const { token } = theme.useToken();
  const [collapsed, setCollapsed] = useState(false);
  const totalChecks = categories.length;
  const formattedDate = new Date(checkedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div style={{
      width: collapsed ? 48 : 220,
      flexShrink: 0,
      background: token.colorBgContainer,
      borderRight: `1px solid ${token.colorBorderSecondary}`,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      transition: 'width 0.2s ease',
    }}>
      <div style={{
        padding: collapsed ? '10px 0' : '14px 16px 10px',
        display: 'flex', alignItems: 'flex-start',
        justifyContent: collapsed ? 'center' : 'space-between',
      }}>
        {!collapsed && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              Checks
            </div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
              {totalChecks} check{totalChecks !== 1 ? 's' : ''}
            </div>
            <div style={{ marginTop: 8 }}>
              <Checkbox
                checked={hideSuccessful}
                onChange={e => onToggleHideSuccessful(e.target.checked)}
                style={{ fontSize: 12, color: token.colorTextSecondary }}
              >
                Hide successful
              </Checkbox>
            </div>
          </div>
        )}
        <Button
          type="text"
          size="small"
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => setCollapsed(c => !c)}
          style={{ color: token.colorTextSecondary, flexShrink: 0 }}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: collapsed ? '4px 4px 8px' : '4px 8px 8px' }}>
        {categories.map((cat) => {
          const isActive = cat.key === activeKey;
          const isError = Boolean(cat.error);
          const dot = isError ? '#fa8c16' : (cat.issues === 0 ? '#52c41a' : severityColor(cat.severity));
          const issueColor = severityColor(cat.severity);
          const countEl = isError
            ? <span style={{ color: '#fa8c16' }}>ERROR</span>
            : cat.issues === 0
              ? <span style={{ color: '#52c41a' }}>OK</span>
              : <span style={{ color: issueColor }}>{cat.issues}</span>;

          if (collapsed) {
            return (
              <Tooltip
                key={cat.key}
                title={`${cat.label}${isError ? ' � ERROR' : (cat.issues > 0 ? ` � ${cat.issues}` : ' � OK')}`}
                placement="right"
              >
                <div
                  className={'ria-navitem' + (isActive ? ' is-active' : '')}
                  onClick={() => onSelect(cat.key)}
                  style={{ justifyContent: 'center', padding: '8px 0', gap: 4 }}
                >
                  <span className="ria-navitem__dot" style={{ background: dot }} />
                  <span className="ria-navitem__count">{countEl}</span>
                </div>
              </Tooltip>
            );
          }

          return (
            <div
              key={cat.key}
              className={'ria-navitem' + (isActive ? ' is-active' : '')}
              onClick={() => onSelect(cat.key)}
            >
              <span className="ria-navitem__dot" style={{ background: dot }} />
              <span className="ria-navitem__label">{cat.label}</span>
              <span className="ria-navitem__count">{countEl}</span>
            </div>
          );
        })}
      </div>

      {!collapsed && (
        <div style={{
          padding: '12px 16px',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          fontSize: 11, color: token.colorTextSecondary,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <ClockCircleOutlined /> Last run
          </div>
          <div className="mono" style={{ color: token.colorText }}>
            {formattedDate}
          </div>
        </div>
      )}
    </div>
  );
}

// -- CheckHeader ---------------------------------------------------------------

function CheckHeader({
  title, subtitle, issueCount, allOkCopy, issueCopy, onRun, isRunning, severity,
}: {
  title: string; subtitle: string; issueCount: number;
  allOkCopy: string; issueCopy: string; onRun: () => void; isRunning: boolean;
  severity?: string;
}) {
  const { token } = theme.useToken();
  const isOk = issueCount === 0;
  const issueColor = severityColor(severity ?? 'Error');
  const issueBg = severity === 'Warning' ? 'rgba(250,140,22,0.10)'
    : severity === 'Hint' ? 'rgba(24,144,255,0.10)'
    : 'rgba(245,34,45,0.10)';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 16,
      padding: '20px 24px',
      borderBottom: `1px solid ${token.colorBorderSecondary}`,
      background: token.colorBgContainer,
      flexShrink: 0,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: isOk ? 'rgba(82,196,26,0.12)' : issueBg,
        color: isOk ? '#52c41a' : issueColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, flexShrink: 0,
      }}>
        {isOk ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: token.colorText, letterSpacing: '-0.01em' }}>{title}</div>
        <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 2, lineHeight: 1.5 }}>{subtitle}</div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 16, fontSize: 12 }}>
          {isOk ? (
            <span className="ria-fg-ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CheckCircleFilled /> {allOkCopy}
            </span>
          ) : (
            <>
              <span style={{ color: token.colorTextSecondary }}>
                <span className="mono" style={{ color: issueColor, fontWeight: 600 }}>{issueCount}</span> {issueCopy}
              </span>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <Tooltip title="Export results to CSV">
          <Button icon={<DownloadOutlined />} size="middle">Export</Button>
        </Tooltip>
        <Button type="primary" icon={<PlayCircleOutlined />} loading={isRunning} onClick={onRun}>Re-run check</Button>
      </div>
    </div>
  );
}

// -- ModelCheckView (export) ---------------------------------------------------

// -- ModelCheckView (export) ---------------------------------------------------

export function ModelCheckView({ ns }: { ns: NamespaceContext }) {
  const { token } = theme.useToken();

  // -- State for the new dynamic check system -------------------------------
  // Map of checkId ? result (summary OR error)
  const [runResults, setRunResults] = useState<Map<string, { summary?: CheckRunSummary; check: ApplicableCheck; error?: string }>>(new Map());
  const [activeCheckId, setActiveCheckId] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [hideSuccessful, setHideSuccessful] = useState<boolean>(false);

  const runCheck = useRunCheck();
  const { data: applicableChecks, isLoading: checksLoading } = useLoadApplicableChecks(ns.name);
  const selectionQuery = useLoadCheckSelection(ns.name);
  const saveSelection = useSaveCheckSelection();
  const saveSummary = useSaveCheckSummary();

  // -- Auto-run support -----------------------------------------------------
  // The workspace canvas "Check" button sets this flag in the store before
  // navigating, causing this view to auto-run as soon as data is available.
  const pendingAutoRun = useWorkspaceStore(s => s.pendingCheckAutoRun[ns.namespaceId] ?? false);

  const handleRunSelected = useCallback(async (selectedIds: string[]) => {
    const checks = applicableChecks ?? [];
    const newResults = new Map<string, { summary?: CheckRunSummary; check: ApplicableCheck; error?: string }>();
    let firstId: string | null = null;
    for (const id of selectedIds) {
      const checkDef = checks.find(c => c.id === id);
      if (!checkDef) continue;
      if (!firstId) firstId = id;
      try {
        const summary = await runCheck.mutateAsync({ checkId: id, namespace: ns.name, pageSize: CHECK_PAGE_SIZE });
        newResults.set(id, { summary, check: checkDef });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Check "${id}" failed:`, err);
        newResults.set(id, { check: checkDef, error: msg });
      }
    }
    setRunResults(newResults);
    setActiveCheckId(firstId);
    setCheckedAt(new Date().toISOString());
    // Aggregate and persist the check summary for display on the workspace canvas
    let errors = 0, warnings = 0, hints = 0, checksRun = 0;
    for (const entry of newResults.values()) {
      if (entry.summary) {
        checksRun++;
        const sev = entry.check.severity;
        if (sev === 'Error') errors += entry.summary.totalViolations;
        else if (sev === 'Warning') warnings += entry.summary.totalViolations;
        else hints += entry.summary.totalViolations;
      }
    }
    saveSummary.mutate({ namespace: ns.name, errors, warnings, hints, checksRun });
  }, [applicableChecks, runCheck, ns.name, saveSummary]);

  // User-triggered run from the splash: save the selection first, then run.
  const handleUserRunSelected = useCallback(async (ids: string[]) => {
    // Fire-and-forget save; don't block the run on it
    saveSelection.mutate({ namespace: ns.name, selectedIds: ids });
    await handleRunSelected(ids);
  }, [saveSelection, handleRunSelected, ns.name]);

  // Consume the pending auto-run flag as soon as checks and selection are both loaded.
  useEffect(() => {
    if (!pendingAutoRun) return;
    if (checksLoading || selectionQuery.isLoading) return;

    // Clear flag immediately to prevent re-triggering
    useWorkspaceStore.getState().setPendingCheckAutoRun(ns.namespaceId, false);

    if (!applicableChecks || applicableChecks.length === 0) return;

    const allApplicableIds = applicableChecks.map(c => c.id);
    const savedIds = selectionQuery.data;

    let effectiveIds: string[];
    if (savedIds && savedIds.length > 0) {
      const applicableSet = new Set(allApplicableIds);
      const intersection = savedIds.filter(id => applicableSet.has(id));
      effectiveIds = intersection.length > 0 ? intersection : allApplicableIds;
    } else {
      effectiveIds = allApplicableIds;
    }

    if (effectiveIds.length > 0) {
      void handleRunSelected(effectiveIds);
    }
  }, [pendingAutoRun, checksLoading, applicableChecks, selectionQuery.isLoading, selectionQuery.data, ns.namespaceId, handleRunSelected]);

  const handleRerunSingle = useCallback(async (checkId: string) => {
    const checkDef = applicableChecks?.find(c => c.id === checkId);
    if (!checkDef) return;
    try {
      const summary = await runCheck.mutateAsync({ checkId, namespace: ns.name, pageSize: CHECK_PAGE_SIZE });
      setRunResults(prev => new Map(prev).set(checkId, { summary, check: checkDef }));
      setCheckedAt(new Date().toISOString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Re-run check "${checkId}" failed:`, err);
      setRunResults(prev => new Map(prev).set(checkId, { check: checkDef, error: msg }));
    }
  }, [applicableChecks, runCheck, ns.name]);

  // -- Loading state --------------------------------------------------------
  // Show spinner when:
  //  - checks are actively running (runCheck.isPending), OR
  //  - an auto-run is queued (pendingAutoRun) but data hasn't loaded yet.
  // This prevents the CheckSelectionSplash from flashing before the auto-run fires.
  if ((pendingAutoRun || runCheck.isPending) && runResults.size === 0) {
    return (
      <div className="ria-scope" style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: token.colorBgLayout, gap: 12,
      }}>
        <Spin />
        <Text type="secondary">Running checks�</Text>
      </div>
    );
  }

  // -- Splash: no results yet -----------------------------------------------
  if (runResults.size === 0) {
    // Compute the persisted selection filtered to applicable IDs for pre-population
    const savedIds = selectionQuery.data;
    const allApplicableIds = (applicableChecks ?? []).map(c => c.id);
    let initialSelectedIds: string[] | undefined;
    if (savedIds && savedIds.length > 0 && allApplicableIds.length > 0) {
      const applicableSet = new Set(allApplicableIds);
      const intersection = savedIds.filter(id => applicableSet.has(id));
      initialSelectedIds = intersection.length > 0 ? intersection : undefined;
    }

    return (
      <div className="ria-scope" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <CheckSelectionSplash
          namespace={ns.name}
          onRunSelected={handleUserRunSelected}
          isRunning={runCheck.isPending}
          initialSelectedIds={initialSelectedIds}
        />
      </div>
    );
  }

  // -- Results --------------------------------------------------------------
  const categoriesAll: CategoryItem[] = Array.from(runResults.values()).map((entry) => ({
    key: entry.check.id,
    label: entry.check.name,
    issues: entry.summary ? entry.summary.totalViolations : 0,
    severity: entry.check.severity,
    error: entry.error,
  }));

  const categories: CategoryItem[] = hideSuccessful ? categoriesAll.filter(c => c.issues > 0 || c.error) : categoriesAll;

  const resolvedKey = (activeCheckId && runResults.has(activeCheckId) && ( !hideSuccessful || categories.some(c => c.key === activeCheckId) ))
    ? activeCheckId
    : (categories[0]?.key ?? categoriesAll[0]?.key ?? '');

  const activeEntry = runResults.get(resolvedKey);

  return (
    <div className="ria-scope" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <CategoryNav
        categories={categories}
        activeKey={resolvedKey}
        onSelect={setActiveCheckId}
        checkedAt={checkedAt ?? new Date().toISOString()}
        hideSuccessful={hideSuccessful}
        onToggleHideSuccessful={setHideSuccessful}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        {activeEntry ? (
          activeEntry.summary ? (
            <ViolationTable
              key={resolvedKey}
              summary={activeEntry.summary}
              check={activeEntry.check}
              onRerun={() => handleRerunSingle(resolvedKey)}
              isRerunning={runCheck.isPending}
            />
          ) : (
            <CheckErrorPane
              check={activeEntry.check}
              error={activeEntry.error}
              onRerun={() => handleRerunSingle(resolvedKey)}
              isRerunning={runCheck.isPending}
            />
          )
        ) : null}
      </div>
    </div>
  );
}

