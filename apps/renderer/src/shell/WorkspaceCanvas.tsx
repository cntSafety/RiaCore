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
import { Button, Card, Space, Tooltip, Alert, Modal, theme, Dropdown, message, Empty, App as AntdApp } from 'antd';
import {
  PlusOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  WarningOutlined,
  EyeOutlined,
  MoreOutlined,
  SafetyCertificateOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  ClockCircleOutlined,
  LoadingOutlined,
  ApartmentOutlined,
  ImportOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { useRef, useState, useCallback, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  ReactFlow,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useNodesInitialized,
  useUpdateNodeInternals,
  Panel,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  type FinalConnectionState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const GenericModelBrowserModal = lazy(() =>
  import('../modules/namespace/editors/generic/GenericModelBrowserModal').then((m) => ({ default: m.GenericModelBrowserModal })),
);
const GenericImportViewerModal = lazy(() =>
  import('../modules/import/generic-viewer/GenericImportViewerModal').then((m) => ({
    default: m.GenericImportViewerModal,
  })),
);
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaceStore, type NamespaceContext } from '../store/workspaceStore';
import { computeElkLayout } from '../modules/namespace/editors/safety-analysis/utils/elkLayout';
import { resolveNodePosition } from './resolveNodePosition';
import { buildAutoLayoutRecords } from './autoLayoutRecords';
import { declaredDimensions } from './nodeDimensions';
import { reconcileCanvasNodes, type ReconcilableNode } from './canvasNodeReconcile';
import { decideViewportFit, VIEWPORT_FIT_DEADLINE_MS } from './viewportFitGate';
import {
  createUnmeasuredWatchState,
  tickUnmeasuredWatch,
  MEASUREMENT_GRACE_PERIOD_MS,
  type UnmeasuredWatchState,
} from './unmeasuredNodeWatch';
import {
  createFallbackPlacementCache,
  ensureFallbackPosition,
  findFreePosition,
  setFallbackPosition,
  NEW_ELEMENT_SIZE,
} from './fallbackPlacement';
import { buildPlacementRecord } from './placementRecord';
import {
  useNamespaceConnections,
  useConnectMutation,
  useDisconnectMutation,
  countDependents,
} from '../hooks/useNamespaceConnections';
import { useWorkspaceState, isDbOpen } from '../hooks/useWorkspaceState';
import { useDiagramLayout } from '../hooks/useDiagramLayout';
import { useLayoutPersistMutation } from '../hooks/useLayoutPersistMutation';
import { useImportSources } from '../hooks/useImportSources';
import { useImportSourcesReadiness } from '../hooks/useImportSourcesReadiness';
import { useActiveImport } from '../hooks/useActiveImport';
import { useNamespaceStats } from '../hooks/useNamespaceStats';
import type { NamespaceStats } from '@riacore/app-contracts';
import {
  useRunImportSourceMutation,
  useRunImportSourceAtRefMutation,
  useDeleteImportSourceMutation,
  useDeleteNamespaceMutation,
} from '../hooks/useRiacoreMutations';
import { useFullWorkspaceSaveMutation } from '../hooks/useFullWorkspaceSaveMutation';
import { AddImporterModal } from './AddImporterModal';
import { AddAnalysisModal } from './AddAnalysisModal';
import { ImporterConfigModal } from './ImporterConfigModal';
import { NamespaceDeleteWithPreview } from './NamespaceDeleteWithPreview';
import { api } from '../api/riacore';
import { useNamespaces } from '../hooks/useNamespaces';
import { useAutoSaveStatusStore } from '../store/autoSaveStatusStore';
import { useCanvasAutoSave } from '../hooks/useCanvasAutoSave';
import { ImpactReportPanel } from '../modules/import/ImpactReportPanel';
import { useImportRunStore, type ImportImpactResult } from '../store/importRunStore';
import { UpdateFromBranchModal } from '../modules/import/UpdateFromBranchModal';
import { useWorkspaceGitConfig } from '../api/git-hooks';
import { MergeFromBranchModal } from './MergeFromBranchModal';
import { SupervisedMergeFromBranchModal } from './SupervisedMergeFromBranchModal';
import type { ImportSourceInfo, NamespaceInfo, NamespaceCheckSummary } from '@riacore/app-contracts';
import { useLoadCheckSummary } from '../hooks/useChecks';
import { getNamespaceDecorationBySourceType, getNamespaceDecorationByMetamodel } from '../lib/namespaceTypeDecoration';
import { logOpEvent } from '../lib/opTrace';
import { invalidateAfterContentChange } from '../hooks/workspaceCacheReset';

const { useToken } = theme;

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthoredNsCardData {
  id: string;
  name: string;
  standard: string;
  owningApplication: string;
  role: 'authored';
  isDraft?: boolean;
}

// ── Import source type icon ───────────────────────────────────────────────────
// Maps a SourceMaster sourceType to a distinct icon + label so the different
// kinds of imports (ARXML, SW Requirements, SysML, TS symbols) are visually
// distinguishable on the canvas. Delegates to the shared namespaceTypeDecoration
// module so the same icon/color show up for the same namespace kind in the
// safety-analysis tree (see NamespaceTreePanel.tsx).
function getSourceTypeIcon(sourceType: string): { icon: React.ReactNode; label: string; accent: string } {
  const decoration = getNamespaceDecorationBySourceType(sourceType);
  const IconComponent = decoration.icon;
  return { icon: <IconComponent />, label: decoration.label, accent: decoration.color };
}

/** Parse a #rrggbb hex string into an `rgba(...)` string at `alpha`. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const int = parseInt(h, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Shared tile chrome ───────────────────────────────────────────────────────
// Both importer and analysis tiles use the same visual language: a small
// colored icon chip identifying the tile's type, a thin accent strip on the
// left edge for at-a-glance scanning, and a status/role chip sized to match
// the footer action buttons (rather than a header Tag that eats into the
// name's available width).

function TypeIconChip({ icon, accent }: { icon: React.ReactNode; accent: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 6,
        background: hexToRgba(accent, 0.14),
        color: accent,
        fontSize: 14,
        flexShrink: 0,
      }}
    >
      {icon}
    </span>
  );
}

// Solid, circular badge used for Analysis tiles — deliberately distinct from
// the tinted square chip used for Import tiles. Filled + round reads as "an
// owned workspace you open into", vs. the tinted square's "incoming data".
function SolidIconBadge({ icon, accent }: { icon: React.ReactNode; accent: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: accent,
        color: '#fff',
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      {icon}
    </span>
  );
}

function AccentStrip({ accent, radius }: { accent: string; radius: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 3,
        borderRadius: `${radius}px 0 0 ${radius}px`,
        background: accent,
        pointerEvents: 'none',
      }}
    />
  );
}

function StatusChip({
  icon,
  label,
  color,
}: {
  icon?: React.ReactNode;
  label: string;
  color: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 24,
        padding: '0 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        lineHeight: 1,
        color,
        border: `1px solid ${color}`,
        background: hexToRgba(color, 0.06),
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {icon}
      {label}
    </span>
  );
}

// ── Importer card ─────────────────────────────────────────────────────────────

/**
 * Git branch provenance line on an import source card.
 *
 * Truncation is left to CSS rather than a character count: a fixed
 * `slice(0, 22)` cut names short even when the card had room for more, and it
 * cut mid-glyph regardless of the actual font metrics. The full name stays
 * reachable through the tooltip and the copy button.
 */
function BranchLabel({ branch }: { branch: string }) {
  const { token } = useToken();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(branch).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // The card is a React Flow node, so a bare click would also select it and
  // begin a drag.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    copy();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    copy();
  };

  // Revealed on focus as well as hover: the button stays in the tab order, so
  // hiding it from a keyboard user who has focused it would be a trap.
  const revealed = hovered || focused || copied;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        fontSize: 10,
        color: token.colorPrimary,
        marginBottom: 6,
      }}
    >
      <span style={{ flexShrink: 0 }}>Branch:</span>
      <Tooltip title={branch}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {branch}
        </span>
      </Tooltip>
      <Tooltip title={copied ? 'Copied' : 'Copy branch name'}>
        <CopyOutlined
          role="button"
          tabIndex={0}
          aria-label={`Copy branch name ${branch}`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flexShrink: 0,
            cursor: 'pointer',
            color: copied ? token.colorSuccess : token.colorTextTertiary,
            // Kept mounted and faded rather than conditionally rendered:
            // appearing on hover would change the name's available width and
            // re-truncate it under the cursor.
            opacity: revealed ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
        />
      </Tooltip>
    </div>
  );
}

function ImporterCardItem({
  source,
  onConfig,
  onRun,
  onView,
  onViewImportTree,
  isRunning,
  anyRunning,
  dbOpen,
  onDelete,
  onUpdateFromBranch,
  onUpdateFromRepo,
  namespaceStats,
  isConfigured,
}: {
  source: ImportSourceInfo;
  onConfig: () => void;
  onRun: (id: string) => void;
  onView?: () => void;
  /** Opens the compact import-structure browser (GenericImportViewerModal). */
  onViewImportTree?: () => void;
  isRunning?: boolean;
  anyRunning?: boolean;
  dbOpen?: boolean;
  onDelete?: () => void;
  onUpdateFromBranch?: () => void;
  onUpdateFromRepo?: () => void;
  namespaceStats?: NamespaceStats;
  /** undefined = config not yet loaded (treat as runnable). false = mandatory fields missing. */
  isConfigured?: boolean;
}) {
  const { token } = useToken();

  // Backend activeImport is the authority for running state.
  const hasCompletedImport = source.lastRunStatus === 'completed';
  const status = isRunning
    ? 'running'
    : source.lastRunStatus === 'failed'
      ? 'failed'
      : (source.configDirty && hasCompletedImport)
        ? 'dirty'
        : hasCompletedImport
          ? 'completed'
          : 'idle';

  const statusColor: Record<string, string> = {
    completed: token.colorSuccess,
    running:   token.colorPrimary,
    failed:    token.colorError,
    dirty:     token.colorWarning,
    idle:      token.colorTextTertiary,
  };

  const statusLabel: Record<string, string> = {
    completed: 'SYNCED',
    running:   'RUNNING',
    failed:    'ERROR',
    dirty:     'DIRTY',
    idle:      'NOT SYNCED',
  };

  const StatusIcon =
    status === 'completed' ? <CheckCircleOutlined /> :
    status === 'running'   ? <SyncOutlined spin /> :
    status === 'failed'    ? <CloseCircleOutlined /> :
    status === 'dirty'     ? <WarningOutlined /> :
    <CloseCircleOutlined />;

  const typeIcon = getSourceTypeIcon(source.sourceType);

  const canView = source.lastRunStatus === 'completed';
  // A source is runnable when its mandatory config fields are filled. While the
  // config hasn't loaded yet (isConfigured === undefined) we don't block — we'd
  // rather let the backend surface a helpful error than silently prevent a run.
  const notConfigured = isConfigured === false;

  return (
    <div>
      <Card
        size="small"
        className="riacore-card"
        style={{ width: 270, position: 'relative', overflow: 'hidden' }}
        styles={{ body: { padding: '10px 12px 10px 14px' } }}
        title={
          <Space size={8} style={{ minWidth: 0, overflow: 'hidden' }}>
            <TypeIconChip icon={typeIcon.icon} accent={typeIcon.accent} />
            <span style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'inline-block',
            }}>
              {source.targetNamespace}
            </span>
          </Space>
        }
        extra={
          dbOpen && (
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'view-import-tree',
                    label: 'Browse Import Tree',
                    icon: <EyeOutlined />,
                    disabled: !canView,
                  },
                  { type: 'divider' },
                  {
                    key: 'update-from-branch',
                    label: 'Run update from branch',
                    disabled: !source.lastRunStatus || source.lastRunStatus === 'running',
                  },
                  { type: 'divider' },
                  { key: 'config', label: 'Config', icon: <SettingOutlined /> },
                  { type: 'divider' },
                  { key: 'delete', label: 'Delete', danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'config') onConfig();
                  if (key === 'delete') onDelete?.();
                  if (key === 'view-import-tree') onViewImportTree?.();
                  if (key === 'update-from-branch') onUpdateFromBranch?.();
                },
              }}
              trigger={['click']}
              disabled={anyRunning}
            >
              <Button
                size="small"
                type="text"
                icon={<MoreOutlined />}
                disabled={anyRunning}
                style={{ padding: '0 2px' }}
              />
            </Dropdown>
          )
        }
      >
        <AccentStrip accent={typeIcon.accent} radius={token.borderRadiusSM} />
        <Tooltip title={typeIcon.label}>
          <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 2 }}>
            {source.name}
          </div>
        </Tooltip>
        {namespaceStats && (
          <div style={{ fontSize: 10, color: token.colorTextTertiary, marginBottom: 2 }}>
            {namespaceStats.node_count.toLocaleString()} nodes · {namespaceStats.edge_count.toLocaleString()} edges
          </div>
        )}
        {source.lastImportBranch && <BranchLabel branch={source.lastImportBranch} />}
        {!source.lastImportBranch && <div style={{ marginBottom: 6 }} />}
        <Space size={4} style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <StatusChip icon={StatusIcon} label={statusLabel[status]} color={statusColor[status]} />
          <Space size={4} wrap>
            {canView && (
              <Button size="small" icon={<EyeOutlined />} onClick={onView} style={{ fontSize: 11 }} disabled={!!anyRunning}>
                View
              </Button>
            )}
            <Tooltip title={notConfigured ? 'Configure mandatory fields before running (click ⋯ → Config)' : undefined}>
              <Button size="small" type={status === 'running' ? 'default' : 'primary'}
                icon={<PlayCircleOutlined />} onClick={() => onRun(source.sourceId)}
                disabled={!!anyRunning || notConfigured} style={{ fontSize: 11 }}>
                Run
              </Button>
            </Tooltip>
          </Space>
        </Space>
      </Card>
    </div>
  );
}

// ── MergeFromFilesConfirm ─────────────────────────────────────────────────────
// Inline component handling UC-13: sync check → warning → union merge from files.

function MergeFromFilesConfirm({
  ns,
  workingDir,
  onClose,
}: {
  ns: AuthoredNsCardData;
  workingDir: string;
  onClose: () => void;
}) {
  const [messageApi, contextHolder] = message.useMessage();
  const [phase, setPhase] = useState<'checking' | 'confirm-unsaved' | 'merging' | 'done' | 'error'>('checking');
  const [errorMsg, setErrorMsg] = useState('');
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.namespaces.getSyncStatus(ns.id, workingDir);
        if (cancelled) return;
        if (status.inSync) {
          setPhase('merging');
          await api.namespaces.applyUnionMergeFromFiles(ns.id, workingDir);
          if (!cancelled) {
            // Union merge reassigns node IDs — refresh every DB-content cache
            // (see hooks/workspaceCacheReset.ts) and drop node-ID-bearing state.
            await invalidateAfterContentChange(queryClient);
            void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
            useWorkspaceStore.getState().resetWorkspaceState();
            void messageApi.success(`Merge from files complete for '${ns.name}'`);
            onClose();
          }
        } else {
          setPhase('confirm-unsaved');
        }
      } catch (err) {
        if (!cancelled) { setErrorMsg(String(err)); setPhase('error'); }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirmMerge = async () => {
    setPhase('merging');
    try {
      await api.namespaces.applyUnionMergeFromFiles(ns.id, workingDir);
      // Union merge reassigns node IDs — refresh every DB-content cache (see
      // hooks/workspaceCacheReset.ts) and drop node-ID-bearing state.
      await invalidateAfterContentChange(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
      useWorkspaceStore.getState().resetWorkspaceState();
      void messageApi.success(`Merge from files complete for '${ns.name}'`);
      onClose();
    } catch (err) {
      setErrorMsg(String(err));
      setPhase('error');
    }
  };

  return (
    <>
      {contextHolder}
      <Modal
        open
        title="Merge from Files"
        onCancel={onClose}
        footer={
          phase === 'confirm-unsaved' ? (
            <Space>
              <Button onClick={onClose}>Cancel</Button>
              <Button type="primary" onClick={() => void handleConfirmMerge()} loading={false}>
                Continue
              </Button>
            </Space>
          ) : null
        }
        closable={phase !== 'merging'}
        maskClosable={false}
      >
        {phase === 'checking' && <div>Checking sync status…</div>}
        {phase === 'merging' && <div>Applying union merge…</div>}
        {phase === 'confirm-unsaved' && (
          <Alert
            type="warning"
            message="Unsaved Changes Detected"
            description={`The live database content for namespace '${ns.name}' differs from the files on disk. This may mean you have unsaved changes in the current session. Merging will incorporate the on-disk content into the live database. Do you want to continue?`}
            showIcon
          />
        )}
        {phase === 'error' && (
          <Alert type="error" message="Merge failed" description={friendlyErrorMessage(errorMsg)} showIcon />
        )}
      </Modal>
    </>
  );
}

// ── CheckSummaryBadges ────────────────────────────────────────────────────────

function CheckSummaryBadges({ summary }: { summary: NamespaceCheckSummary | null | undefined }) {
  const { token } = useToken();

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginBottom: 8,
    minHeight: 20,
    flexWrap: 'wrap',
  };

  // No data yet: show dash placeholders
  if (summary === null || summary === undefined) {
    return (
      <div style={containerStyle}>
        {(['Error', 'Warning', 'Hint'] as const).map((sev) => (
          <Tooltip key={sev} title={`No check results (${sev})`}>
            <span style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 4,
              background: token.colorFillTertiary, color: token.colorTextDisabled,
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              {sev === 'Error' && <ExclamationCircleFilled />}
              {sev === 'Warning' && <WarningOutlined />}
              {sev === 'Hint' && <InfoCircleOutlined />}
              –
            </span>
          </Tooltip>
        ))}
      </div>
    );
  }

  const isOutdated = summary.isOutdated;
  const allPassed = summary.errors === 0 && summary.warnings === 0 && summary.hints === 0;

  if (allPassed) {
    return (
      <div style={containerStyle}>
        <Tooltip title={isOutdated ? 'All checks passed (results may be outdated)' : 'All checks passed'}>
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 4,
            background: isOutdated ? token.colorFillSecondary : 'rgba(82,196,26,0.12)',
            color: isOutdated ? token.colorTextDisabled : '#52c41a',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <CheckCircleFilled />
            All passed
            {isOutdated && <ClockCircleOutlined style={{ marginLeft: 2 }} />}
          </span>
        </Tooltip>
      </div>
    );
  }

  const badges: { label: string; count: number; color: string; bg: string; icon: React.ReactNode }[] = [
    {
      label: 'Errors',
      count: summary.errors,
      color: isOutdated ? token.colorTextDisabled : token.colorError,
      bg: isOutdated ? token.colorFillTertiary : 'rgba(245,34,45,0.10)',
      icon: <ExclamationCircleFilled />,
    },
    {
      label: 'Warnings',
      count: summary.warnings,
      color: isOutdated ? token.colorTextDisabled : token.colorWarning,
      bg: isOutdated ? token.colorFillTertiary : 'rgba(250,140,22,0.10)',
      icon: <WarningOutlined />,
    },
    {
      label: 'Hints',
      count: summary.hints,
      color: isOutdated ? token.colorTextDisabled : token.colorInfo,
      bg: isOutdated ? token.colorFillTertiary : 'rgba(24,144,255,0.10)',
      icon: <InfoCircleOutlined />,
    },
  ];

  return (
    <div style={containerStyle}>
      {badges.map(({ label, count, color, bg, icon }) => (
        <Tooltip key={label} title={isOutdated ? `${label}: ${count} (results may be outdated)` : `${label}: ${count}`}>
          <span style={{
            fontSize: 10, padding: '1px 5px', borderRadius: 4,
            background: bg, color,
            display: 'inline-flex', alignItems: 'center', gap: 3,
          }}>
            {icon}
            {count}
          </span>
        </Tooltip>
      ))}
      {isOutdated && (
        <Tooltip title="Results are outdated — data has changed since last check run">
          <ClockCircleOutlined style={{ fontSize: 10, color: token.colorTextDisabled }} />
        </Tooltip>
      )}
    </div>
  );
}

function AuthoredNamespaceCardItem({
  ns,
  onOpen,
  onCheck,
  dbOpen,
  onDelete,
  anyRunning,
  onMergeFromFiles,
  onMergeFromBranch,
  onSupervisedMergeFromBranch,
  hasRepoDir,
  filesCorrupted,
}: {
  ns: AuthoredNsCardData;
  onOpen?: () => void;
  onCheck?: () => void;
  dbOpen?: boolean;
  onDelete?: () => void;
  anyRunning?: boolean;
  onMergeFromFiles?: () => void;
  onMergeFromBranch?: () => void;
  onSupervisedMergeFromBranch?: () => void;
  hasRepoDir?: boolean;
  filesCorrupted?: boolean;
}) {
  const { token } = useToken();
  // Safety-Analysis: warm orange, distinct from the green Sphinx-Needs import
  // tiles. Security-Analysis: an amber/gold accent, distinct from both Safety
  // (orange) and Import tiles (blue/green/purple), paired with a scan-style
  // icon instead of Safety's certificate shield. Resolved from the shared
  // namespaceTypeDecoration module so this matches the safety-analysis tree.
  const analysisDecoration = getNamespaceDecorationByMetamodel(ns.standard);
  const accent = analysisDecoration?.color ?? token.colorWarning;
  const AnalysisIcon = analysisDecoration?.icon ?? SafetyCertificateOutlined;
  const checkSummaryQuery = useLoadCheckSummary(ns.name);

  return (
    <div>
      <Card
        size="small"
        className="riacore-card riacore-analysis-card"
        style={{
          width: 270,
          position: 'relative',
          overflow: 'hidden',
          // Consumed by the .riacore-analysis-card rule in global.css, which
          // needs !important to win over the base .riacore-card border.
          ['--tile-accent' as string]: accent,
        }}
        styles={{
          // Extra padding around the header gives the solid accent badge
          // clear white space against the card's full accent-colored border —
          // without it the badge's fill and the border stroke visually merge
          // into one shape since they're the same color.
          header: { padding: '14px' },
          body: { padding: '10px 14px' },
        }}
        title={
          <Space size={8} style={{ minWidth: 0, overflow: 'hidden' }}>
            <SolidIconBadge icon={<AnalysisIcon />} accent={accent} />
            <span style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {ns.name}
            </span>
          </Space>
        }
        extra={
          dbOpen && (
            <Dropdown
              menu={{
                items: [
                  { key: 'merge-from-files', label: 'Merge from Files' },
                  { key: 'merge-from-branch', label: 'Merge from Branch' },
                  { key: 'supervised-merge-from-branch', label: 'Supervised Merge from Branch', disabled: !hasRepoDir, title: !hasRepoDir ? 'A git repository is required' : undefined },
                  { type: 'divider' },
                  { key: 'delete', label: 'Delete', danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'merge-from-files') onMergeFromFiles?.();
                  else if (key === 'merge-from-branch') onMergeFromBranch?.();
                  else if (key === 'supervised-merge-from-branch') onSupervisedMergeFromBranch?.();
                  else if (key === 'delete') onDelete?.();
                },
              }}
              trigger={['click']}
              disabled={anyRunning}
            >
              <Button
                size="small"
                type="text"
                icon={<MoreOutlined />}
                disabled={anyRunning}
                style={{ padding: '0 2px' }}
              />
            </Dropdown>
          )
        }
      >
        <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 6 }}>
          {analysisDecoration?.label ?? ns.owningApplication}
        </div>
        <CheckSummaryBadges summary={checkSummaryQuery.data} />
        <Space size={6} wrap style={{ width: '100%', justifyContent: 'flex-end', marginTop: 4 }}>
          <Tooltip title={filesCorrupted ? 'Repair the manifest before opening the analysis workspace' : undefined}>
            <Button size="small" icon={<SafetyCertificateOutlined />} onClick={onCheck} disabled={!onCheck || filesCorrupted} style={{ fontSize: 11 }}>
              Check
            </Button>
          </Tooltip>
          <Tooltip title={filesCorrupted ? 'Repair the manifest before opening the analysis workspace' : undefined}>
            <Button size="small" type="primary" icon={<EyeOutlined />} onClick={onOpen} disabled={!onOpen || filesCorrupted} style={{ fontSize: 11 }}>
              Open
            </Button>
          </Tooltip>
        </Space>
      </Card>
    </div>
  );
}

// ── Error message helpers ─────────────────────────────────────────────────────

/**
 * Converts a raw IPC/backend error message into a short, user-friendly string.
 * Strips Electron's "Error invoking remote method '...': " prefix and translates
 * known technical errors (e.g. KuzuDB file lock) into plain language.
 */
function friendlyErrorMessage(raw: string): string {
  // Strip Electron IPC prefix
  let msg = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/i, '');

  // KuzuDB file lock — database is open in another process
  if (/could not set lock on file/i.test(msg)) {
    return 'The database is already open in another process. Close any other RIACore windows or processes that may be using this workspace, then try again.';
  }

  // Strip leading "Error: " prefix that sometimes remains
  msg = msg.replace(/^Error:\s*/i, '');

  // Truncate very long messages (e.g. full stack traces)
  if (msg.length > 400) {
    msg = msg.slice(0, 400) + '…';
  }

  return msg;
}

// ── React Flow custom nodes ────────────────────────────────────────────────
// One node type per namespace role. Imported nodes expose a source
// Connection_Handle (right); analysis nodes expose a target Connection_Handle
// (left). The inner card bodies reuse ImporterCardItem / AuthoredNamespaceCardItem
// so every existing per-role action and modal keeps working unchanged.

const CONNECTION_HANDLE_ID = 'namespace-connection';

// Monotonic counter behind the sentinel fingerprint used when a per-element
// fingerprint lookup misses (see `fingerprintFor` in the build effect). A miss
// must produce a value that DIFFERS from the previous one so the node object is
// rebuilt; a constant fallback would make every miss compare equal and leave a
// stale card on screen — the exact failure mode Decision 4 exists to prevent.
let fingerprintMissSeq = 0;

interface ImporterNodeData extends Record<string, unknown> {
  /** Per-Canvas_Element fingerprint (Decision 4) — the object-reuse test in
   *  `reconcileCanvasNodes`. Covers every field that affects how THIS card
   *  renders, so a changed card can never be reused unchanged. */
  fingerprint: string;
  source: ImportSourceInfo;
  isRunning: boolean;
  anyRunning: boolean;
  dbOpen: boolean;
  isConfigured: boolean | undefined;  // undefined = config not yet loaded
  onConfig: (source: ImportSourceInfo) => void;
  onRun: (sourceId: string) => void;
  onView: (source: ImportSourceInfo) => void;
  onViewImportTree: (source: ImportSourceInfo) => void;
  onDelete: (source: ImportSourceInfo) => void;
  onUpdateFromBranch: (source: ImportSourceInfo) => void;
  onUpdateFromRepo: (source: ImportSourceInfo) => void;
  namespaceStats?: NamespaceStats;
}

type ImporterFlowNode = Node<ImporterNodeData, 'importerNode'>;

function ImporterNode({ data }: NodeProps<ImporterFlowNode>) {
  const { token } = useToken();
  const { source } = data;
  return (
    <>
      <ImporterCardItem
        source={source}
        onConfig={() => data.onConfig(source)}
        onRun={data.onRun}
        onView={() => data.onView(source)}
        onViewImportTree={() => data.onViewImportTree(source)}
        isRunning={data.isRunning}
        anyRunning={data.anyRunning}
        dbOpen={data.dbOpen}
        isConfigured={data.isConfigured}
        onDelete={() => data.onDelete(source)}
        onUpdateFromBranch={() => data.onUpdateFromBranch(source)}
        onUpdateFromRepo={() => data.onUpdateFromRepo(source)}
        namespaceStats={data.namespaceStats}
      />
      {/* Connection_Handle — source (imported → analysis). Behavior wired in 11.3. */}
      <Handle
        type="source"
        position={Position.Right}
        id={CONNECTION_HANDLE_ID}
        style={{ background: token.colorPrimary, width: 11, height: 11, border: `2px solid ${token.colorBgContainer}` }}
      />
    </>
  );
}

interface AnalysisNodeData extends Record<string, unknown> {
  /** Per-Canvas_Element fingerprint (Decision 4) — see `ImporterNodeData`. */
  fingerprint: string;
  ns: AuthoredNsCardData;
  dbOpen: boolean;
  anyRunning: boolean;
  hasRepoDir: boolean;
  filesCorrupted: boolean;
  onOpen?: (ns: AuthoredNsCardData) => void;
  onCheck?: (ns: AuthoredNsCardData) => void;
  onDelete: (ns: AuthoredNsCardData) => void;
  onMergeFromFiles: (ns: AuthoredNsCardData) => void;
  onMergeFromBranch: (ns: AuthoredNsCardData) => void;
  onSupervisedMergeFromBranch: (ns: AuthoredNsCardData) => void;
}

type AnalysisFlowNode = Node<AnalysisNodeData, 'analysisNode'>;

function AnalysisNode({ data }: NodeProps<AnalysisFlowNode>) {
  const { token } = useToken();
  const { ns } = data;
  const onOpen = data.onOpen;
  const onCheck = data.onCheck;
  return (
    <>
      {/* Connection_Handle — target (imported → analysis). Behavior wired in 11.3. */}
      <Handle
        type="target"
        position={Position.Left}
        id={CONNECTION_HANDLE_ID}
        // This handle is rendered before the card. Keep it above the card so
        // the visible target remains pointer-interactive; otherwise the card
        // intercepts clicks and connection drops at the handle's centre.
        style={{ background: token.colorSuccess, width: 11, height: 11, border: `2px solid ${token.colorBgContainer}`, zIndex: 1 }}
      />
      <AuthoredNamespaceCardItem
        ns={ns}
        onOpen={onOpen ? () => onOpen(ns) : undefined}
        onCheck={onCheck ? () => onCheck(ns) : undefined}
        dbOpen={data.dbOpen}
        anyRunning={data.anyRunning}
        onDelete={() => data.onDelete(ns)}
        onMergeFromFiles={() => data.onMergeFromFiles(ns)}
        onMergeFromBranch={() => data.onMergeFromBranch(ns)}
        onSupervisedMergeFromBranch={() => data.onSupervisedMergeFromBranch(ns)}
        hasRepoDir={data.hasRepoDir}
        filesCorrupted={data.filesCorrupted}
      />
    </>
  );
}

// Defined outside the component so React Flow does not re-register node types
// on every render.
const nodeTypes = { importerNode: ImporterNode, analysisNode: AnalysisNode };

// ── Layout_Key → layout_id encoding ────────────────────────────────────────
// A Canvas_Element is identified by its Layout_Key (Element_Kind, Element_Key).
// The stored Diagram_Layout (useDiagramLayout) is keyed by the same composite
// `layout_id` string used by the persistence layer: `${kind}\u0000${key}`. The
// NUL separator can never appear in an identifier-like kind/key, so the encoding
// is injective. The renderer only depends on `@riacore/app-contracts`, so this
// mirrors `encodeLayoutId` from app-core rather than importing the backend module.
const LAYOUT_ID_SEPARATOR = '\u0000';
function encodeLayoutId(elementKind: string, elementKey: string): string {
  return `${elementKind}${LAYOUT_ID_SEPARATOR}${elementKey}`;
}
// The two Element_Kinds positioned today: imported namespace nodes are keyed by
// their `targetNamespace`, analysis namespace nodes by their `name`.
const IMPORTED_ELEMENT_KIND = 'imported';
const ANALYSIS_ELEMENT_KIND = 'analysis';

// Deterministic graph-level ELK options for the Auto_Layout_Button — the ONLY
// code path that runs ELK. Imported nodes (partition 0) end up left of analysis
// nodes (partition 1), and identical input graphs produce identical positions
// (Req 4.2, 4.5).
const ELK_LAYOUT_OPTIONS: Record<string, string> = {
  // Activate partitioned layout so imported (partition 0) is placed left of
  // analysis (partition 1) even when there are no connecting edges.
  'org.eclipse.elk.partitioning.activate': 'true',
  // Partitioning is only honored when connected components are laid out
  // together; with the default (separate components) ELK packs each unconnected
  // node independently and ignores the partition, leaving imported/analysis
  // interleaved instead of split left/right.
  'org.eclipse.elk.separateConnectedComponents': 'false',
  // Override the shared INTERACTIVE cycle-breaking default: INTERACTIVE needs
  // seeded node coordinates and crashes elkjs when combined with partitioning +
  // edges, which would drop us into the grid fallback (overlapping,
  // unpartitioned). GREEDY is safe here.
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
};

// Builds the partitioned ELK node/edge graph for the Overview_Canvas from the
// live imported/analysis namespaces and their connections. Imported nodes go in
// partition 0 (left), analysis nodes in partition 1 (right); only edges whose
// endpoints are both present as nodes are kept. The Auto_Layout_Button consumes
// both lists; the node-build effect reuses only `elkEdges` to render the canvas
// edges (it never runs ELK).
function buildElkGraph(
  importSources: ImportSourceInfo[],
  authoredNamespaces: { name: string }[],
  connections: { source: string; target: string }[],
): {
  elkNodes: { id: string; width: number; height: number; layoutOptions?: Record<string, string> }[];
  elkEdges: { id: string; source: string; target: string }[];
} {
  const importerNodeIds = new Set(importSources.map((s) => s.targetNamespace));
  const analysisNodeIds = new Set(authoredNamespaces.map((n) => n.name));

  // Declared_Dimensions per Element_Kind, from the one table that also supplies
  // React Flow's pre-measurement box for these same cards (`nodeDimensions.ts`).
  // Deriving both from it is what stops ELK's idea of a card's footprint and the
  // rendered card's from drifting apart (Req 4.5). Resolved once per kind rather
  // than per node: the table is static.
  const importerSize = declaredDimensions(IMPORTED_ELEMENT_KIND);
  const analysisSize = declaredDimensions(ANALYSIS_ELEMENT_KIND);

  const elkNodes = [
    ...importSources.map((s) => ({
      id: s.targetNamespace,
      width: importerSize.width,
      height: importerSize.height,
      // Partition 0 → forced into the left layer(s).
      layoutOptions: { 'org.eclipse.elk.partitioning.partition': '0' },
    })),
    ...authoredNamespaces.map((n) => ({
      id: n.name,
      width: analysisSize.width,
      height: analysisSize.height,
      // Partition 1 → forced into the right layer(s).
      layoutOptions: { 'org.eclipse.elk.partitioning.partition': '1' },
    })),
  ];

  // Edges from the connection graph: source = imported name, target = analysis
  // name. Only keep edges whose endpoints are both present as nodes.
  const elkEdges = connections
    .filter((c) => importerNodeIds.has(c.source) && analysisNodeIds.has(c.target))
    .map((c) => ({ id: `conn:${c.source}->${c.target}`, source: c.source, target: c.target }));

  return { elkNodes, elkEdges };
}

// Monotonic-where-available clock for the Fit_Deadline (same guarded pattern as
// `lib/opTrace.ts`: jsdom and older embedders may not expose `performance.now`).
function fitClockNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// Fits the viewport to the graph whenever the node set changes AND all nodes
// have been measured by React Flow. Using useNodesInitialized() avoids the
// race condition where fitView fires before React Flow has measured node
// dimensions, which causes edge paths to be routed from unmeasured (0,0)
// coordinates and appear visually disconnected from their handles.
// `useNodesInitialized` returns true only after every currently-rendered node
// has a known width/height — the still-preferred moment to reposition the
// viewport.
//
// Why the wait for that signal is BOUNDED (Decision 6, Req 3.3):
// `useNodesInitialized` stays false for as long as ANY rendered node lacks
// `measured`, and a dropped resize-observation notification means that
// measurement may never arrive — so the old `if (!nodesInitialized) return;`
// could suppress the fit for a pending Graph_Structure_Change forever, leaving a
// freshly imported element outside the visible viewport with no way for the user
// to find it. Abandoning the wait is safe because every node now carries
// Declared_Dimensions from its first frame (Decision 1), so `getNodesBounds` has
// usable geometry with no measurement at all: a deadline-triggered fit computes
// correct bounds rather than a degenerate box. The Fit_Deadline therefore changes
// only WHEN the fit runs, never whether it is correct.
//
// The decision itself lives in `viewportFitGate.ts` (pure, property-tested);
// this component owns only the `lastFittedKey` bookkeeping, the elapsed-time
// measurement, and the timer that lets the deadline fire without a further
// render.
function GraphFitter({ signal, placementActive }: { signal: string; placementActive: boolean }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  // Track the last signal value for which we already ran fitView, so we
  // re-fit exactly once per structural change.
  const fittedForRef = useRef<string | null>(null);
  // The signal whose change time is recorded below. Starts at a value no real
  // structure key can equal, so the first effect pass records a timestamp.
  const timedSignalRef = useRef<string | null>(null);
  const signalChangedAtRef = useRef(fitClockNow());
  // Bumped by the deadline timer to re-run the effect when nothing else will:
  // `nodesInitialized` flipping causes a render, but if it never flips, only
  // this makes the gate re-evaluate once the deadline has elapsed.
  const [deadlineTick, setDeadlineTick] = useState(0);

  useEffect(() => {
    if (timedSignalRef.current !== signal) {
      timedSignalRef.current = signal;
      signalChangedAtRef.current = fitClockNow();
    }
    const elapsed = fitClockNow() - signalChangedAtRef.current;

    if (
      decideViewportFit({
        structureKey: signal,
        lastFittedKey: fittedForRef.current,
        nodesInitialized,
        msSinceStructureKeyChanged: elapsed,
        placementActive,
      }).fit
    ) {
      fittedForRef.current = signal;
      void fitView({ padding: 0.2, duration: 200 });
      return;
    }

    // Not fitting. Of the three ways to be refused, only "the deadline has not
    // elapsed yet" resolves on its own: an already-fitted key and active
    // placement both need a real change (a new key, placement completing), and
    // both of those re-render. So arm a timer for the remaining wait only in
    // that one case — a single timeout per pending fit, no polling.
    const waitingOnDeadline =
      fittedForRef.current !== signal && !placementActive && !nodesInitialized;
    if (!waitingOnDeadline) return;

    const remaining = Math.max(0, VIEWPORT_FIT_DEADLINE_MS - elapsed);
    const timer = window.setTimeout(() => setDeadlineTick((t) => t + 1), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [signal, nodesInitialized, placementActive, fitView, deadlineTick]);

  return null;
}

// Captures the React Flow instance into a ref owned by WorkspaceCanvas so the
// parent's pane handlers can call `screenToFlowPosition` (needed to convert a
// primary-click's screen coordinate into an Overview_Canvas flow coordinate
// during Placement_Mode, Req 9.3). Rendered inside <ReactFlow> so the React
// Flow context is available to `useReactFlow`.
// Also exposes `window.__riaFitView` so Playwright tests can call fitView()
// without needing a Controls component in the DOM.
function RfInstanceCapture({
  instanceRef,
}: {
  instanceRef: React.MutableRefObject<ReturnType<typeof useReactFlow> | null>;
}) {
  const rf = useReactFlow();
  instanceRef.current = rf;
  // Dev/test only: expose a deterministic viewport fit for Playwright.
  //
  // This helper forces nothing. Measurement after a Node_Array_Rebuild is
  // guaranteed on the production path by `NodeMeasurementKick`, and every node
  // carries Declared_Dimensions from its first frame, so `getNodesBounds`
  // returns a usable box whether or not `measured` has landed yet (Reqs 5.1,
  // 5.2). What remains is purely a deterministic viewport fit: resolve the
  // nodes, fit their bounds, and return only once the transform has settled
  // (Req 5.3).
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>)['__riaFitView'] = async (nodeIds?: string[]) => {
      const requestedIds = new Set(nodeIds ?? []);

      // GraphFitter animates the whole canvas over 200 ms when it fits for a new
      // structure key. Wait for that transform to settle so it cannot overwrite
      // the endpoint fit below.
      const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
      if (viewport) {
        let previous = viewport.style.transform;
        let stableSamples = 0;
        const deadline = performance.now() + 1_500;
        while (performance.now() < deadline) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
          const current = viewport.style.transform;
          stableSamples = current === previous ? stableSamples + 1 : 0;
          previous = current;
          if (stableSamples >= 4) break;
        }
      }

      const allNodes = rf.getNodes();
      const nodes = requestedIds.size > 0
        ? allNodes.filter((node) => requestedIds.has(node.id))
        : allNodes;
      if (nodes.length === 0 || (requestedIds.size > 0 && nodes.length !== requestedIds.size)) {
        return false;
      }
      // Generous padding keeps connection handles outside React Flow's edge
      // auto-pan activation zone, so coordinates remain stable during a drag.
      return rf.fitBounds(rf.getNodesBounds(nodes), { padding: 0.45, duration: 0 });
    };
  }
  return null;
}

// Asks React Flow to measure the nodes it has not measured yet, once per
// Node_Array_Rebuild (Decision 5, Reqs 1.6, 5.1, 5.2).
//
// Declared_Dimensions make a node VISIBLE from frame one, but not MEASURED:
// exact edge geometry still wants the real box, and `useNodesInitialized`
// (GraphFitter's gate) only releases once every node carries `measured`. A
// controlled-node rebuild can discard those measurements, and Chromium may
// never emit another ResizeObserver event for an unchanged off-screen element —
// so rather than waiting for an observation that may never be delivered, we ask
// React Flow to re-measure through its supported entry point. This kick used to
// live only inside `window.__riaFitView`; it now sits on the path every user
// takes, which is why the helper no longer forces anything (Req 5.1).
//
// Two guards keep the kick from becoming its own measurement loop: it targets
// ONLY ids that lack `measured` (a measured node is never re-measured), and it
// runs at most once per rebuild generation. Note that writing `measured` back
// onto a node cannot re-arm this effect either — `graphFingerprint` folds in
// position, status and stats, never `measured`, so a measurement result is not
// a Rebuild_Trigger.
//
// Lives inside <ReactFlow> because `useUpdateNodeInternals` needs the React
// Flow context, which the WorkspaceCanvas body (outside <ReactFlow>) does not
// have — same reason as GraphFitter and RfInstanceCapture.
function NodeMeasurementKick({ generation }: { generation: number }) {
  const { getNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  // Last generation actually kicked, so a re-run for the same generation is a
  // no-op (same pattern as GraphFitter's `fittedForRef`). Set at the moment the
  // work runs rather than on effect entry: under StrictMode the first pass is
  // torn down before its frames fire, and a guard set on entry would suppress
  // the surviving pass.
  const kickedForRef = useRef<number | null>(null);

  useEffect(() => {
    // Generation 0 means no rebuild has committed yet, and a rebuild that
    // empties the canvas has nothing to measure.
    if (generation === 0) return;
    if (kickedForRef.current === generation) return;

    // Two frames: React Flow can only measure a DOM node React has committed,
    // and the commit carrying this generation's nodes lands on the next frame.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        kickedForRef.current = generation;
        const unmeasured = getNodes()
          .filter((node) => node.measured?.width === undefined || node.measured?.height === undefined)
          .map((node) => node.id);
        if (unmeasured.length === 0) return;
        try {
          updateNodeInternals(unmeasured);
        } catch (err) {
          // Rendering never depends on the kick succeeding — every node already
          // has Declared_Dimensions. A throw is a diagnostic, not an error path.
          logOpEvent(
            'canvas.measurementKick',
            'frontend',
            'updateNodeInternals threw',
            { generation, unmeasuredCount: unmeasured.length, error: String(err) },
            'warn',
          );
        }
      });
    });

    // Cancel both frames so a kick cannot fire after unmount.
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [generation, getNodes, updateNodeInternals]);

  return null;
}

// How often the unmeasured-element watch samples the Node_Array. Deliberately
// coarse relative to the 2000 ms Measurement_Grace_Period: the watch only needs
// to notice that a deadline has passed, not when. One sample per second costs a
// `getNodes()` walk and bounds the reporting lag to ~1 s.
const UNMEASURED_WATCH_INTERVAL_MS = 1000;

// Reports Canvas_Elements that are still running on their Declared_Dimensions
// long after they entered the Node_Array (Decision 7, Reqs 6.1–6.4).
//
// WHY this exists: before Declared_Dimensions, a lost Measurement_Notification
// hid the card outright — the user saw a hole in their workspace, and that is
// the only reason the defect was ever found (it took a user screenshot; nothing
// in the logs said anything). Declared_Dimensions fix the visible symptom, and
// in doing so make the underlying condition completely invisible: the card sits
// in the right place, nothing throws, nothing logs, and only `measured` is
// missing — which merely leaves edge geometry approximate and keeps
// `nodesInitialized` false so the Viewport_Fit runs on its deadline rather than
// on measurement. A screenshot cannot reveal that. This log entry is the only
// way anyone will ever know it happened, which is why it goes through
// `logOpEvent` (host lifecycle log on disk) rather than the devtools console.
//
// Strictly observation-only (Req 6.4): it holds no state that feeds rendering,
// never touches the Node_Array, never surfaces a user-facing error, and
// swallows its own failures — a broken diagnostic must not break the canvas.
//
// Lives inside <ReactFlow> because it needs `useReactFlow().getNodes()` to see
// `measured`, which the WorkspaceCanvas body does not have — same reason as
// GraphFitter, RfInstanceCapture and NodeMeasurementKick.
function UnmeasuredElementWatch({ enabled }: { enabled: boolean }) {
  const { getNodes } = useReactFlow();
  // One long-lived watch state for the whole mounted lifetime: the "report once
  // per continuous unmeasured period" accounting is only meaningful if it spans
  // ticks. Cleared whenever the watch is disabled (Workspace_Phase leaving
  // `db_open`) so a reopened workspace restarts every grace period.
  const stateRef = useRef<UnmeasuredWatchState | null>(null);

  useEffect(() => {
    if (!enabled) {
      stateRef.current = null;
      return;
    }
    const state = stateRef.current ?? createUnmeasuredWatchState();
    stateRef.current = state;

    const tick = (): void => {
      try {
        const nodes = getNodes();
        const presentIds = nodes.map((node) => node.id);
        const measuredIds = new Set(
          nodes
            .filter(
              (node) =>
                node.measured?.width !== undefined && node.measured?.height !== undefined,
            )
            .map((node) => node.id),
        );

        const { overdue, recovered } = tickUnmeasuredWatch(state, {
          presentIds,
          measuredIds,
          now: fitClockNow(),
        });
        if (overdue.length === 0 && recovered.length === 0) return;

        // The node id IS the Element_Key (importer nodes are keyed by
        // `targetNamespace`, analysis nodes by `name`); the Element_Kind comes
        // from the React Flow node type.
        const elementKindOf = (id: string): string => {
          const type = nodes.find((node) => node.id === id)?.type;
          return type === 'analysisNode' ? ANALYSIS_ELEMENT_KIND
            : type === 'importerNode' ? IMPORTED_ELEMENT_KIND
            : 'unknown';
        };

        for (const id of overdue) {
          logOpEvent(
            'canvas.unmeasuredElement',
            'frontend',
            `Canvas_Element still has no measured dimensions after ${MEASUREMENT_GRACE_PERIOD_MS} ms — rendering on declared dimensions`,
            {
              elementKind: elementKindOf(id),
              elementKey: id,
              gracePeriodMs: MEASUREMENT_GRACE_PERIOD_MS,
              nodeCount: presentIds.length,
              measuredCount: measuredIds.size,
            },
            'warn',
          );
        }
        for (const id of recovered) {
          logOpEvent(
            'canvas.unmeasuredElement',
            'frontend',
            'Measured dimensions arrived for a previously reported Canvas_Element',
            {
              elementKind: elementKindOf(id),
              elementKey: id,
              nodeCount: presentIds.length,
            },
          );
        }
      } catch (err) {
        // A diagnostic that throws must stay a diagnostic.
        logOpEvent(
          'canvas.unmeasuredElement',
          'frontend',
          'unmeasured-element watch tick failed',
          { error: String(err) },
          'warn',
        );
      }
    };

    const timer = window.setInterval(tick, UNMEASURED_WATCH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, getNodes]);

  return null;
}

// ── WorkspaceCanvas ───────────────────────────────────────────────────────────

interface WorkspaceCanvasProps {
  onConfigImporter?: (id: string) => void;
  onRunImporter?: (id: string) => void;
  onAddImporter?: () => void;
  onEditNamespace?: (ns: NamespaceContext) => void;
  onCheckNamespace?: (ns: NamespaceContext) => void;
  onAddAnalysis?: () => void;
}

export function WorkspaceCanvas({
  onConfigImporter,
  onRunImporter,
  onAddImporter,
  onEditNamespace,
  onCheckNamespace,
  onAddAnalysis,
}: WorkspaceCanvasProps) {
  const { token } = useToken();
  // Use the instance-based message/modal APIs so toasts and confirms inherit
  // the active Ant Design theme (dark mode). The static antd `message` and
  // `Modal` APIs render outside the <App> provider and always use the light theme.
  const { message, modal } = AntdApp.useApp();

  // ── Workspace state machine ───────────────────────────────────────────────
  const wsState = useWorkspaceState();
  const queryClient = useQueryClient();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;

  // Resolve the git repository root from the workspace git config.
  // Falls back to workingDir when no separate repoDir is configured.
  const gitWsConfigQuery = useWorkspaceGitConfig();
  const workingDirForGit = wsState.phase !== 'no_workspace' ? wsState.workingDir : '';
  const resolvedRepoDir = gitWsConfigQuery.data?.repoDir || workingDirForGit;

  // ── Import sources from SourceMaster ─────────────────────────────────────
  const dbOpen = isDbOpen(wsState);
  const filesCorrupted = wsState.phase === 'db_open' && wsState.filesCorrupted === true;
  const workingDir = wsState.phase !== 'no_workspace' ? wsState.workingDir : '';
  const { data: importSources = [] } = useImportSources(dbOpen, workspaceKey);
  const { data: namespaces = [] } = useNamespaces(dbOpen, workspaceKey);
  const { data: namespaceStatsList = [] } = useNamespaceStats(dbOpen);
  // Fetch config for every import source (served from cache after first load,
  // staleTime: Infinity) so we can gate the Run button on mandatory fields being
  // filled. Returns Map<sourceId, boolean>; absent = config not yet loaded.
  const importSourcesReadiness = useImportSourcesReadiness(importSources, workingDir, dbOpen);
  const namespaceStatsMap = useMemo(() => {
    const map = new Map<string, NamespaceStats>();
    for (const stats of namespaceStatsList) {
      map.set(stats.name, stats);
    }
    return map;
  }, [namespaceStatsList]);
  const authoredNamespaces: AuthoredNsCardData[] = namespaces
    .filter((ns: NamespaceInfo) => ns.role === 'authored')
    .map((ns: NamespaceInfo) => ({
      id: ns.namespaceId,
      name: ns.name,
      standard: ns.metamodel,
      owningApplication: ns.owningApplication,
      role: 'authored',
    }));

  // ── Import run state — backend is the source of truth ───────────────────
  const { data: activeImport } = useActiveImport();
  const activeImportSourceId = activeImport?.sourceId ?? null;
  const anyRunning = activeImportSourceId !== null;

  // ── Namespace connection graph — drives the React Flow edges ─────────────
  // The graph exposes distinct imported/analysis names and the directed
  // (imported → authored) connections between them. Nodes are built from the
  // richer import-source / authored-namespace data above; the graph supplies
  // only the edges (source = imported name, target = analysis name). Drag-to-
  // connect / edge-removal behavior is wired in task 11.3.
  const { data: connectionGraph } = useNamespaceConnections();

  // ── Stored diagram layout (persisted Element_Positions) ──────────────────
  // While the workspace DB is open, `useDiagramLayout` returns the current
  // Diagram_Layout (one Layout_Record per Layout_Key). We index it as a
  // `Map<layout_id, {x,y}>` so the node builder can resolve each Canvas_Element
  // to its stored Element_Position when one exists (Req 2.1, 2.2); elements with
  // no record fall back to an Auto_Layout-computed position (Req 2.3).
  const { data: diagramLayout } = useDiagramLayout();
  const storedPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const record of diagramLayout ?? []) {
      map.set(encodeLayoutId(record.elementKind, record.elementKey), { x: record.x, y: record.y });
    }
    return map;
  }, [diagramLayout]);

  // ── Auto_Layout state + layout-persist mutations ─────────────────────────
  // `setAutoLayoutActive(false)` enters the Auto_Layout_Deactivated_State
  // (Req 3.1, 3.2). Two separate mutation instances are used so that
  // single-node writes (drag, placement) do NOT trigger the Auto Layout
  // button's `loading` spinner — that spinner is tied exclusively to the
  // bulk persist fired by the Auto Layout button itself.
  const setAutoLayoutActive = useWorkspaceStore((s) => s.setAutoLayoutActive);
  /** Single-node position write: drag stop and placement commit. */
  const dragPersistMutation = useLayoutPersistMutation();
  /** Bulk position write: Auto Layout button only. */
  const autoLayoutPersistMutation = useLayoutPersistMutation();

  // ── Auto_Save_Coordinator (canvas-layout-auto-save) ───────────────────────
  // Qualifying canvas mutations (drag / connect / disconnect) notify the
  // coordinator on their `onSuccess`; it debounces, coalesces, and serializes
  // universe-scoped saves and drives the Save_Status indicator (Req 1, 2, 3, 9).
  // `flushSave()` runs any pending save to completion on workspace switch,
  // shutdown, and canvas unmount (Req 7).
  const { scheduleSave: scheduleAutoSave, flushSave: flushAutoSave } =
    useCanvasAutoSave();
  const setAutoSaveStatus = useAutoSaveStatusStore((s) => s.setStatus);

  // ── Placement_Mode state (Req 9.1–9.7) ───────────────────────────────────
  // `placement !== null` means a newly created Canvas_Element (keyed by the
  // generic {elementKind, elementKey}) has not been committed to an
  // Element_Position yet; a ghost preview follows the cursor until the user
  // clicks to place it (Req 9.3) or cancels with Escape (Req 9.5). The two
  // Add_Element_Actions enter Placement_Mode; there is no per-kind branch, so a
  // future Element_Kind uses the same interaction (Req 9.6).
  const placement = useWorkspaceStore((s) => s.placement);
  const enterPlacement = useWorkspaceStore((s) => s.enterPlacement);
  const exitPlacement = useWorkspaceStore((s) => s.exitPlacement);
  // Cursor position (container-local px) used only to draw the ghost preview.
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  // React Flow instance (captured by RfInstanceCapture inside <ReactFlow>) —
  // used to convert a click's screen coordinate into a flow coordinate.
  const rfInstanceRef = useRef<ReturnType<typeof useReactFlow> | null>(null);
  // Wrapping div, used to translate cursor screen coords → container-local px
  // for the ghost preview.
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);

  // ── Delete namespace / import source ─────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{ namespace: string; role: 'imported' | 'authored'; sourceId?: string } | null>(null);
  const deleteImportSourceMutation = useDeleteImportSourceMutation();
  const deleteNamespaceMutation = useDeleteNamespaceMutation();

  // ── Selected edge (for delete-key removal, issue #55) ────────────────────
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // ── Import All aggregate results (issue #64) ──────────────────────────────
  // Import completion remounts the canvas. Publish results to the session store
  // so the replacement canvas can show them; stale workspace callbacks are ignored.
  const importSession = useImportRunStore((s) => s.session);
  const importAllResults = useImportRunStore((s) => s.importAllResults);
  const setImportAllResults = (results: ImportImpactResult[] | null) =>
    useImportRunStore.getState().setImportAllResults(results, importSession);

  // ── DB stats — fast poll during load, slow poll otherwise ────────────────
  const [opError, setOpError] = useState<string | null>(null);
  const [lastFailedOp, setLastFailedOp] = useState<'load' | null>(null);
  const lastImportRunId = useImportRunStore((s) => s.lastImportRunId);
  const setLastImportRunId = (runId: string | null) =>
    useImportRunStore.getState().setLastImportRunId(runId, importSession);
  const saveMutation = useFullWorkspaceSaveMutation();
  const runSourceMutation = useRunImportSourceMutation(() =>
    wsState.phase !== 'no_workspace' ? wsState.workingDir : null,
  );
  const runSourceAtRefMutation = useRunImportSourceAtRefMutation(() =>
    wsState.phase !== 'no_workspace' ? wsState.workingDir : null,
  );
  const isSaving = saveMutation.isPending;
  const hasWorkspace = wsState.phase !== 'no_workspace';
  const isLoadingFromRiaData = wsState.phase === 'loading_from_ria_data';

  // ── Config drawer ─────────────────────────────────────────────────────────
  const [configSource, setConfigSource] = useState<ImportSourceInfo | null>(null);
  // When set, entering placement mode for this element is deferred until after
  // the config drawer is closed (issue #49: auto-open config after provisioning).
  const [postConfigPlacement, setPostConfigPlacement] = useState<{ elementKind: string; elementKey: string } | null>(null);
  const [addImporterOpen, setAddImporterOpen] = useState(false);
  const [addAnalysisOpen, setAddAnalysisOpen] = useState(false);
  const [modelBrowserNamespace, setModelBrowserNamespace] = useState<string | null>(null);
  const [viewGenericSource, setViewGenericSource] = useState<ImportSourceInfo | null>(null);
  const [updateFromBranchSource, setUpdateFromBranchSource] = useState<ImportSourceInfo | null>(null);
  const [updatingFromRepoSourceId, setUpdatingFromRepoSourceId] = useState<string | null>(null);
  const [mergeFromFilesTarget, setMergeFromFilesTarget] = useState<{ ns: AuthoredNsCardData; workingDir: string } | null>(null);
  const [mergeFromBranchTarget, setMergeFromBranchTarget] = useState<{ ns: AuthoredNsCardData; workingDir: string } | null>(null);
  const [supervisedMergeFromBranchTarget, setSupervisedMergeFromBranchTarget] = useState<{ ns: AuthoredNsCardData; workingDir: string } | null>(null);
  const selectedConfigSource = configSource
    ? importSources.find((src) => src.sourceId === configSource.sourceId) ?? configSource
    : null;

  // Sticky fallback positions for Canvas_Elements that have no stored
  // Layout_Record. Recreated on workspace switch (below).
  const fallbackPlacementRef = useRef(createFallbackPlacementCache());

  // No workspace-switch reset effect here by design.
  //
  // This component is keyed on the content identity in App.tsx
  // (`<WorkspaceCanvas key={contentIdentity} …>`), so a workspace switch — or any
  // mutation that rebuilds DB content — remounts it and React discards all of the
  // local state above, including `fallbackPlacementRef`. The previous hand-rolled
  // effect listed ten setters by name and had to be extended whenever one was
  // added; remounting cannot fall behind in that way.
  //
  // The two side effects it also performed are covered elsewhere:
  //   - pending Auto_Save is flushed by the unmount cleanup below (Req 7.1, 7.3),
  //     which the remount triggers;
  //   - the workspace-scoped Zustand stores are reset by
  //     `useOpenWorkspaceMutation` / `useCloseWorkspaceMutation`, where lifecycle
  //     teardown belongs.
  // See hooks/useContentIdentity.ts.

  // Flush pending Auto_Save on shutdown / force-reload (`beforeunload`) and on
  // Overview_Canvas unmount, so a change made right before the transition is
  // not lost by an unflushed debounce timer (Req 7.2, 7.3).
  const flushAutoSaveRef = useRef(flushAutoSave);
  flushAutoSaveRef.current = flushAutoSave;
  useEffect(() => {
    const handleBeforeUnload = () => {
      void flushAutoSaveRef.current();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Canvas unmount: execute any pending Save_Operation (Req 7.3).
      void flushAutoSaveRef.current();
    };
  }, []);

  const handleRunSource = async (sourceId: string) => {
    const src = importSources.find((s) => s.sourceId === sourceId);
    setLastImportRunId(null);
    try {
      const result = await runSourceMutation.mutateAsync({
        sourceId,
        sourceName: src?.name ?? sourceId,
      });
      setLastImportRunId(result.runId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void message.error(friendlyErrorMessage(raw), 8);
    }
  };

  // "Run update from branch" — identical to handleRunSource but imports the
  // files at a specific git ref. Shows the same impact analysis modal (which
  // includes orphan reconnection) as a normal run.
  const handleRunFromBranch = async (sourceId: string, repoDir: string, ref: string) => {
    const src = importSources.find((s) => s.sourceId === sourceId);
    setLastImportRunId(null);
    try {
      const result = await runSourceAtRefMutation.mutateAsync({
        sourceId,
        sourceName: src?.name ?? sourceId,
        repoDir,
        ref,
      });
      setLastImportRunId(result.runId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void message.error(friendlyErrorMessage(raw), 8);
    }
  };

  // Cancel a brand-new import source that was provisioned at "Add" time but
  // never placed on the canvas (the user closed the Config modal via X). Rolls
  // back the provisioning entirely — DB rows, target namespace, and the config
  // YAML — so a cancelled add leaves nothing behind (deleteSource handler).
  const handleCancelNewSource = async (sourceId: string) => {
    try {
      await deleteImportSourceMutation.mutateAsync(sourceId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void message.error(friendlyErrorMessage(raw), 8);
    }
  };

  const importAllInProgressRef = useRef(false);

  // Import all sources sequentially, showing an aggregate summary modal when done (#64).
  const handleImportAll = async () => {
    if (importAllInProgressRef.current) return;
    const sources = importSources;
    if (sources.length === 0) return;
    // Guard against concurrent invocations (e.g. from menu while a run is in progress).
    if (anyRunning) return;

    // Skip sources whose mandatory config fields are not filled. Warn the user
    // upfront so they can configure before re-running Import All.
    const unconfigured = sources.filter((s) => importSourcesReadiness.get(s.sourceId) === false);
    const runnable = sources.filter((s) => importSourcesReadiness.get(s.sourceId) !== false);
    if (unconfigured.length > 0 && runnable.length === 0) {
      modal.warning({
        title: 'No sources are configured',
        content: (
          <div>
            <div style={{ marginBottom: 8 }}>
              All import sources are missing required configuration. Open each source's Config (⋯ → Config) and fill in the mandatory fields before using Run All Imports.
            </div>
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              {unconfigured.map((s) => <li key={s.sourceId} style={{ fontSize: 12 }}>{s.name}</li>)}
            </ul>
          </div>
        ),
        okText: 'OK',
      });
      return;
    }
    if (unconfigured.length > 0) {
      void message.warning(
        `Skipping ${unconfigured.length} unconfigured source${unconfigured.length === 1 ? '' : 's'}: ${unconfigured.map((s) => s.name).join(', ')}`,
        6,
      );
    }

    importAllInProgressRef.current = true;
    let failed = 0;
    const errors: string[] = [];
    const succeeded: { sourceName: string; runId: string }[] = [];
    try {
      for (let i = 0; i < runnable.length; i++) {
        const src = runnable[i];
        void message.loading({ content: `Importing ${src.name} (${i + 1} of ${runnable.length})…`, key: 'import-all-progress', duration: 0 });
        try {
          const result = await runSourceMutation.mutateAsync({ sourceId: src.sourceId, sourceName: src.name });
          succeeded.push({ sourceName: src.name, runId: result.runId });
        } catch (err) {
          failed++;
          errors.push(`${src.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      importAllInProgressRef.current = false;
      void message.destroy('import-all-progress');
    }
    if (failed === 0) {
      setImportAllResults(succeeded);
    } else {
      modal.warning({
        title: 'Run All Imports completed with errors',
        content: (
          <div>
            <div style={{ marginBottom: 8 }}>
              {succeeded.length} succeeded, {failed} failed.
            </div>
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              {errors.map((e, i) => <li key={i} style={{ fontSize: 12 }}>{e}</li>)}
            </ul>
          </div>
        ),
        okText: 'Close',
      });
      if (succeeded.length > 0) setImportAllResults(succeeded);
    }
  };

  const handleUpdateFromRepo = async (src: ImportSourceInfo) => {
    const workingDir = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;
    if (!workingDir) return;
    setUpdatingFromRepoSourceId(src.sourceId);
    try {
      const result = await api.imports.updateFromImportedBranch(src.sourceId, workingDir);
      if (result.upToDate) {
        void message.info(`Already up to date on branch "${result.branch}".`);
      } else {
        void message.success(`Updated from branch "${result.branch}" (${result.latestCommitId.slice(0, 7)}).`);
        // Update-from-repo re-imports the namespace and reassigns node IDs. This
        // path previously skipped the safety caches entirely.
        await invalidateAfterContentChange(queryClient);
        void queryClient.invalidateQueries({ queryKey: ['workspace.status'] });
        // Also bumps contentGeneration, which remounts this subtree — correct here,
        // because every local selection now refers to reassigned node IDs.
        useWorkspaceStore.getState().resetWorkspaceState();
      }
    } catch (err) {
      void message.error(`Update from repo failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdatingFromRepoSourceId(null);
    }
  };

  // ── React Flow graph ───────────────────────────────────────────────────────
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Live values consumed by the (fingerprint-gated) layout effect. Kept in a ref
  // so the effect always reads fresh data without listing every value as a dep.
  const graphDataRef = useRef({
    importSources,
    authoredNamespaces,
    connectionGraph,
    activeImportSourceId,
    updatingFromRepoSourceId,
    anyRunning,
    dbOpen,
    filesCorrupted,
    resolvedRepoDir,
    workingDir,
    storedPositions,
    placement,
    namespaceStatsMap,
    importSourcesReadiness,
  });
  graphDataRef.current = {
    importSources,
    authoredNamespaces,
    connectionGraph,
    activeImportSourceId,
    updatingFromRepoSourceId,
    anyRunning,
    dbOpen,
    filesCorrupted,
    resolvedRepoDir,
    workingDir,
    storedPositions,
    placement,
    namespaceStatsMap,
    importSourcesReadiness,
  };

  // Per-node action handlers, kept fresh in a ref and exposed to nodes through
  // the stable `nodeCallbacks` wrappers below (so node data identity is stable
  // and rebuilding nodes never churns just because a closure changed).
  const nodeHandlersRef = useRef({
    onConfig: (src: ImportSourceInfo) => setConfigSource(src),
    onRun: (sourceId: string) => { void handleRunSource(sourceId); },
    onView: (src: ImportSourceInfo) => {
      // All importers (AUTOSAR/ARXML, SysML-v2, Sphinx-needs, …) reuse the
      // shared safety tree via the generic model browser.
      setModelBrowserNamespace(src.targetNamespace);
    },
    onViewImportTree: (src: ImportSourceInfo) => setViewGenericSource(src),
    onDeleteImported: (src: ImportSourceInfo) =>
      setDeleteTarget({ namespace: src.targetNamespace, role: 'imported', sourceId: src.sourceId }),
    onUpdateFromBranch: (src: ImportSourceInfo) => setUpdateFromBranchSource(src),
    onUpdateFromRepo: (src: ImportSourceInfo) => { void handleUpdateFromRepo(src); },
    onOpenAnalysis: (ns: AuthoredNsCardData) =>
      onEditNamespace?.({
        namespaceId: ns.id,
        name: ns.name,
        role: 'authored',
        owningApplication: ns.owningApplication,
        metamodel: ns.standard,
        workingDir: graphDataRef.current.workingDir,
      }),
    onCheckAnalysis: (ns: AuthoredNsCardData) =>
      onCheckNamespace?.({
        namespaceId: ns.id,
        name: ns.name,
        role: 'authored',
        owningApplication: ns.owningApplication,
        metamodel: ns.standard,
        workingDir: graphDataRef.current.workingDir,
      }),
    onDeleteAnalysis: (ns: AuthoredNsCardData) =>
      setDeleteTarget({ namespace: ns.id, role: 'authored' }),
    onMergeFromFiles: (ns: AuthoredNsCardData) =>
      setMergeFromFilesTarget({ ns, workingDir: graphDataRef.current.workingDir }),
    onMergeFromBranch: (ns: AuthoredNsCardData) =>
      setMergeFromBranchTarget({ ns, workingDir: graphDataRef.current.workingDir }),
    onSupervisedMergeFromBranch: (ns: AuthoredNsCardData) =>
      setSupervisedMergeFromBranchTarget({ ns, workingDir: graphDataRef.current.workingDir }),
  });
  nodeHandlersRef.current.onRun = (sourceId: string) => { void handleRunSource(sourceId); };
  nodeHandlersRef.current.onUpdateFromRepo = (src: ImportSourceInfo) => { void handleUpdateFromRepo(src); };

  // Stable wrappers passed into node data — identity never changes.
  const nodeCallbacks = useMemo(
    () => ({
      onConfig: (src: ImportSourceInfo) => nodeHandlersRef.current.onConfig(src),
      onRun: (id: string) => nodeHandlersRef.current.onRun(id),
      onView: (src: ImportSourceInfo) => nodeHandlersRef.current.onView(src),
      onViewImportTree: (src: ImportSourceInfo) => nodeHandlersRef.current.onViewImportTree(src),
      onDeleteImported: (src: ImportSourceInfo) => nodeHandlersRef.current.onDeleteImported(src),
      onUpdateFromBranch: (src: ImportSourceInfo) => nodeHandlersRef.current.onUpdateFromBranch(src),
      onUpdateFromRepo: (src: ImportSourceInfo) => nodeHandlersRef.current.onUpdateFromRepo(src),
      onOpenAnalysis: (ns: AuthoredNsCardData) => nodeHandlersRef.current.onOpenAnalysis(ns),
      onCheckAnalysis: (ns: AuthoredNsCardData) => nodeHandlersRef.current.onCheckAnalysis(ns),
      onDeleteAnalysis: (ns: AuthoredNsCardData) => nodeHandlersRef.current.onDeleteAnalysis(ns),
      onMergeFromFiles: (ns: AuthoredNsCardData) => nodeHandlersRef.current.onMergeFromFiles(ns),
      onMergeFromBranch: (ns: AuthoredNsCardData) => nodeHandlersRef.current.onMergeFromBranch(ns),
      onSupervisedMergeFromBranch: (ns: AuthoredNsCardData) => nodeHandlersRef.current.onSupervisedMergeFromBranch(ns),
    }),
    [],
  );

  const canOpen = !!onEditNamespace;
  const canCheck = !!onCheckNamespace;

  // Node-set-only key. Used to re-fit the viewport when Canvas_Elements are
  // added or removed, without re-fitting on cosmetic status updates.
  // Connections are deliberately NOT part of this key: creating or removing a
  // Namespace_Connection never moves a node (positions come from the stored
  // Diagram_Layout), so re-fitting on an edge change would shift/zoom the
  // viewport under the user for no reason.
  const graphStructureKey = useMemo(() => {
    return [
      ...importSources.map((s) => s.targetNamespace),
      ...authoredNamespaces.map((n) => n.name),
    ]
      .sort()
      .join('\u0002');
  }, [importSources, authoredNamespaces]);

  // ── Per-Canvas_Element fingerprints (Decision 4) ───────────────────────────
  //
  // There is exactly ONE fingerprint definition. Each Canvas_Element gets a
  // fingerprint folding in every field that affects how THAT card renders, and
  // `graphFingerprint` — the rebuild trigger for the build effect below — is the
  // join of those same per-element strings plus the parts that belong to no
  // single element. The per-element reuse test (task 5.2/5.3) and the rebuild
  // trigger being the same definition is deliberate and is the point of
  // Decision 4: a field that changes a card's appearance cannot be part of the
  // rebuild trigger while being omitted from the reuse test, which is the failure
  // mode that would leave a stale card on screen.
  //
  // Canvas-wide flags (`dbOpen`, `anyRunning`, `filesCorrupted`, whether a repo
  // dir is resolved, `canOpen`, `canCheck`) are passed into EVERY card's `data`,
  // so a change to any of them changes every card; they are folded into every
  // element's fingerprint instead of being kept as a separate global part. With
  // zero Canvas_Elements they appear nowhere, which is safe: the build emits
  // empty node and edge arrays for any combination of those flags.
  //
  // Position: each element folds in ITS OWN resolved Element_Position rather than
  // the whole Diagram_Layout, so dragging one card does not invalidate the
  // object-reuse test for every other card. Resolution mirrors the build effect
  // (stored Layout_Record → sticky fallback slot), but reads the fallback cache
  // WITHOUT allocating: `ensureFallbackPosition` is sticky and hands out a grid
  // slot on first call, and a memo must never consume one. An element whose slot
  // has not been allocated yet fingerprints as `?`; the build effect allocates it
  // and the next fingerprint recomputation picks up the real coordinate.
  //
  // Control-character separators avoid field collisions: `\u0001` within an
  // element, `\u0002` between elements, `\u0003` between top-level parts.
  const { graphFingerprint, nodeFingerprints } = useMemo(() => {
    const flagsPart = [
      dbOpen ? '1' : '0',
      anyRunning ? '1' : '0',
      filesCorrupted ? '1' : '0',
      resolvedRepoDir ? '1' : '0',
      canOpen ? '1' : '0',
      canCheck ? '1' : '0',
    ].join('\u0001');

    const positionPart = (elementKind: string, elementKey: string): string => {
      const layoutId = encodeLayoutId(elementKind, elementKey);
      const point =
        storedPositions.get(layoutId) ?? fallbackPlacementRef.current.positions.get(layoutId);
      return point ? `${point.x}\u0001${point.y}` : '?';
    };

    const statsPart = (namespaceName: string): string => {
      const stats = namespaceStatsMap.get(namespaceName);
      return stats ? `${stats.node_count}\u0001${stats.edge_count}` : '';
    };

    const fingerprints = new Map<string, string>();

    for (const s of importSources) {
      fingerprints.set(
        s.targetNamespace,
        [
          IMPORTED_ELEMENT_KIND,
          s.sourceId,
          s.targetNamespace,
          s.lastRunStatus ?? '',
          s.configDirty ? 'D' : '',
          s.lastImportBranch ?? '',
          activeImportSourceId === s.sourceId || updatingFromRepoSourceId === s.sourceId ? 'R' : '',
          // Readiness: re-render the card when config loads or a mandatory field
          // is filled. `?` = config not yet loaded.
          (() => {
            const ready = importSourcesReadiness.get(s.sourceId);
            return ready === undefined ? '?' : ready ? '1' : '0';
          })(),
          statsPart(s.targetNamespace),
          positionPart(IMPORTED_ELEMENT_KIND, s.targetNamespace),
          flagsPart,
        ].join('\u0001'),
      );
    }

    for (const n of authoredNamespaces) {
      fingerprints.set(
        n.name,
        [
          ANALYSIS_ELEMENT_KIND,
          n.id,
          n.name,
          n.owningApplication,
          n.standard,
          statsPart(n.name),
          positionPart(ANALYSIS_ELEMENT_KIND, n.name),
          flagsPart,
        ].join('\u0001'),
      );
    }

    // Sorted by node id so Map insertion order cannot affect the composed value.
    const elementsPart = [...fingerprints.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, fingerprint]) => `${id}\u0001${fingerprint}`)
      .join('\u0002');

    // Edges belong to no single Canvas_Element, so the connection set stays a
    // global part of the rebuild trigger.
    const connectionPart = (connectionGraph?.connections ?? [])
      .map((c) => `${c.source}\u0001${c.target}`)
      .sort()
      .join('\u0002');

    // Placement_Mode: while an element is being placed it is EXCLUDED from the
    // committed canvas nodes (only the ghost preview follows the cursor), so a
    // change in the active placement must rebuild the graph (Req 9.1).
    const placementPart = placement
      ? `${placement.elementKind}\u0001${placement.elementKey}`
      : '';

    return {
      graphFingerprint: [elementsPart, connectionPart, placementPart].join('\u0003'),
      nodeFingerprints: fingerprints,
    };
  }, [
    importSources,
    authoredNamespaces,
    connectionGraph,
    activeImportSourceId,
    updatingFromRepoSourceId,
    dbOpen,
    anyRunning,
    filesCorrupted,
    resolvedRepoDir,
    canOpen,
    canCheck,
    storedPositions,
    placement,
    namespaceStatsMap,
    importSourcesReadiness,
  ]);

  // Mirrored into a ref so the build effect — gated on `graphFingerprint`, not on
  // this map's identity — can read the current per-element fingerprints without
  // being listed as a dependency. Consumed by task 5.2.
  const nodeFingerprintsRef = useRef(nodeFingerprints);
  nodeFingerprintsRef.current = nodeFingerprints;

  // ── Measurement kick arming (Decision 5) ─────────────────────────────────
  // Monotonic Node_Array_Rebuild counter, incremented by the build effect below
  // and mirrored into state so `NodeMeasurementKick` (inside <ReactFlow>, where
  // the React Flow context exists) can observe it. The ref holds the authority;
  // the state exists purely to trigger the dependent effect. The kick effect
  // depends on this number ALONE — never on `rfNodes` — so a measurement result
  // written back onto the node array cannot re-arm it.
  const rebuildGenerationRef = useRef(0);
  const [rebuildGeneration, setRebuildGeneration] = useState(0);

  // Build the graph whenever the fingerprint changes. Positions are RESOLVED,
  // never re-laid-out: each Canvas_Element renders at its stored Element_Position
  // when a Layout_Record exists (Req 2.2), otherwise at a sticky fallback slot
  // (Req 2.3). Auto_Layout (ELK) is deliberately NOT consulted here — it runs
  // only when the user presses the Auto_Layout_Button, so no data change
  // (connection removed, import run, stats refresh) can re-arrange the diagram
  // behind the user's back.
  useEffect(() => {
    const d = graphDataRef.current;

    // While the workspace database is not open we render zero Canvas_Elements
    // (Req 2.4).
    if (!d.dbOpen) {
      setRfNodes([]);
      setRfEdges([]);
      return;
    }

    // Edges come straight from the connection graph. The same builder is shared
    // with the Auto_Layout_Button; here only its edge list is used.
    const { elkEdges } = buildElkGraph(
      d.importSources,
      d.authoredNamespaces,
      d.connectionGraph?.connections ?? [],
    );

    {
      // A Canvas_Element currently in Placement_Mode has NOT been committed to an
      // Element_Position yet: it must NOT render as a normal node (only the ghost
      // preview follows the cursor). Exclude it here so it does not appear at a
      // fallback position while being placed (Req 9.1). Once placed, the layout
      // query invalidates, `placement` clears, and it renders at its stored
      // coordinate.
      const isPlacing = (elementKind: string, elementKey: string): boolean =>
        d.placement?.elementKind === elementKind && d.placement.elementKey === elementKey;

      // Fallback positions (keyed by node id) for elements with no stored
      // Layout_Record — legacy workspaces or elements provisioned outside the UI.
      // `ensureFallbackPosition` is sticky: an element keeps the slot it was first
      // given, so elements appearing or disappearing never move it. Imported
      // elements are visited first, so they take the left column and analysis
      // elements the right one.
      const positions = new Map<string, { x: number; y: number }>();
      for (const source of d.importSources) {
        if (isPlacing(IMPORTED_ELEMENT_KIND, source.targetNamespace)) continue;
        const layoutId = encodeLayoutId(IMPORTED_ELEMENT_KIND, source.targetNamespace);
        if (d.storedPositions.has(layoutId)) continue;
        positions.set(
          source.targetNamespace,
          ensureFallbackPosition(fallbackPlacementRef.current, IMPORTED_ELEMENT_KIND, layoutId),
        );
      }
      for (const ns of d.authoredNamespaces) {
        if (isPlacing(ANALYSIS_ELEMENT_KIND, ns.name)) continue;
        const layoutId = encodeLayoutId(ANALYSIS_ELEMENT_KIND, ns.name);
        if (d.storedPositions.has(layoutId)) continue;
        positions.set(
          ns.name,
          ensureFallbackPosition(fallbackPlacementRef.current, ANALYSIS_ELEMENT_KIND, layoutId),
        );
      }

      // Declared_Dimensions per Element_Kind, resolved once per kind (the table is
      // static). Same source as the footprint handed to Auto_Layout, so the two
      // cannot drift (Req 4.5).
      const importerSize = declaredDimensions(IMPORTED_ELEMENT_KIND);
      const analysisSize = declaredDimensions(ANALYSIS_ELEMENT_KIND);

      // Per-element fingerprints for THIS `graphFingerprint` value (Decision 4).
      // Read through the ref for the same reason the effect reads `graphDataRef`:
      // the effect is keyed on the fingerprint string, not on the map's identity.
      // The ref is assigned during the render that produced this `graphFingerprint`,
      // and the effect runs after that render, so the map read here is the one
      // computed for the value that triggered this run.
      const fingerprints = nodeFingerprintsRef.current;
      const fingerprintFor = (nodeId: string): string =>
        // A miss must never collapse to a constant: a value that compares equal to
        // the previous one would let the reconcile reuse a card whose data just
        // changed. The sentinel is unique per call, so a miss forces a rebuild.
        fingerprints.get(nodeId) ?? `!${nodeId}:${Date.now()}:${fingerprintMissSeq++}`;

      const importerNodes: Node<ImporterNodeData>[] = d.importSources
        .filter((source) => !isPlacing(IMPORTED_ELEMENT_KIND, source.targetNamespace))
        .map((source) => ({
        id: source.targetNamespace,
        type: 'importerNode',
        // Declared_Dimensions (Decision 1): consulted by React Flow ONLY while the
        // node has no `measured` box, so a node is Rendered_Visible and routable
        // from frame one without waiting for a Measurement_Notification, and the
        // real box takes over as soon as measurement lands (Reqs 1.1, 1.4, 1.5, 2.5).
        // Do NOT "simplify" these to `width` / `height`: React Flow 12 applies those
        // as authoritative inline styles, which would freeze card height and break
        // the analysis cards whose height grows with their check badges.
        initialWidth: importerSize.width,
        initialHeight: importerSize.height,
        // Stored Element_Position (Req 2.2) → sticky fallback (Req 2.3) → origin.
        position: resolveNodePosition(
          encodeLayoutId(IMPORTED_ELEMENT_KIND, source.targetNamespace),
          source.targetNamespace,
          d.storedPositions,
          positions,
        ),
        data: {
          fingerprint: fingerprintFor(source.targetNamespace),
          source,
          isRunning:
            d.activeImportSourceId === source.sourceId ||
            d.updatingFromRepoSourceId === source.sourceId,
          anyRunning: d.anyRunning,
          dbOpen: d.dbOpen,
          isConfigured: d.importSourcesReadiness.get(source.sourceId),
          onConfig: nodeCallbacks.onConfig,
          onRun: nodeCallbacks.onRun,
          onView: nodeCallbacks.onView,
          onViewImportTree: nodeCallbacks.onViewImportTree,
          onDelete: nodeCallbacks.onDeleteImported,
          onUpdateFromBranch: nodeCallbacks.onUpdateFromBranch,
          onUpdateFromRepo: nodeCallbacks.onUpdateFromRepo,
          namespaceStats: d.namespaceStatsMap.get(source.targetNamespace),
        },
      }));

      const analysisNodes: Node<AnalysisNodeData>[] = d.authoredNamespaces
        .filter((ns) => !isPlacing(ANALYSIS_ELEMENT_KIND, ns.name))
        .map((ns) => ({
        id: ns.name,
        type: 'analysisNode',
        // Declared_Dimensions (Decision 1) — see the importer node above for why
        // this is `initialWidth`/`initialHeight` and never `width`/`height`.
        initialWidth: analysisSize.width,
        initialHeight: analysisSize.height,
        // Stored Element_Position (Req 2.2) → sticky fallback (Req 2.3) → origin.
        position: resolveNodePosition(
          encodeLayoutId(ANALYSIS_ELEMENT_KIND, ns.name),
          ns.name,
          d.storedPositions,
          positions,
        ),
        data: {
          fingerprint: fingerprintFor(ns.name),
          ns,
          dbOpen: d.dbOpen,
          anyRunning: d.anyRunning,
          hasRepoDir: !!d.resolvedRepoDir,
          filesCorrupted: d.filesCorrupted,
          onOpen: canOpen ? nodeCallbacks.onOpenAnalysis : undefined,
          onCheck: canCheck ? nodeCallbacks.onCheckAnalysis : undefined,
          onDelete: nodeCallbacks.onDeleteAnalysis,
          onMergeFromFiles: nodeCallbacks.onMergeFromFiles,
          onMergeFromBranch: nodeCallbacks.onMergeFromBranch,
          onSupervisedMergeFromBranch: nodeCallbacks.onSupervisedMergeFromBranch,
        },
      }));

      // Drop any edge that touches the element being placed (a brand-new element
      // has no connections yet, but stay correct if one is ever pre-seeded).
      const renderedIds = new Set<string>([
        ...importerNodes.map((n) => n.id),
        ...analysisNodes.map((n) => n.id),
      ]);

      const built = [...importerNodes, ...analysisNodes] as Node[];

      // Reconcile rather than replace (Decision 3): carry each node's `measured`
      // box across the rebuild and hand back the PREVIOUS object for every node
      // that did not actually change, so `@xyflow/react` takes its `checkEquality`
      // branch and keeps the internal record it already built — no re-observe, no
      // re-measure, no contribution to the per-frame observation budget
      // (Reqs 4.1, 4.2, 4.3, 4.4).
      //
      // The UPDATER form is required, not cosmetic: it is the only way the
      // reconcile can read the previous array without `rfNodes` appearing in this
      // effect's dependency list. Depending on `rfNodes` would make the effect
      // self-triggering — every commit would schedule another run.
      //
      // The casts are the narrowest thing that works. `reconcileCanvasNodes` is
      // generic over `ReconcilableNode`, and React Flow's `Node` is structurally
      // compatible (`data` carries our `fingerprint`, plus `position`, `measured`,
      // `hidden`, `type`), but the generic will not infer a single `T` across
      // `Node<ImporterNodeData> | Node<AnalysisNodeData>` widened to `Node[]`,
      // whose `data` is `Record<string, unknown>` without the required
      // `fingerprint` member. Casting at the call boundary keeps `ReconcilableNode`
      // strict and the node data interfaces untouched.
      setRfNodes((prev) =>
        reconcileCanvasNodes(
          prev as unknown as ReconcilableNode[],
          built as unknown as ReconcilableNode[],
        ) as unknown as Node[],
      );
      setRfEdges(
        elkEdges
          .filter((e) => renderedIds.has(e.source) && renderedIds.has(e.target))
          .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: CONNECTION_HANDLE_ID,
          targetHandle: CONNECTION_HANDLE_ID,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        })),
      );

      // Arm the measurement kick (Decision 5, Reqs 1.6, 5.1, 5.2). Only on this
      // branch: the `!d.dbOpen` path above empties the canvas, and there is
      // nothing to measure. Reconciliation carries `measured` across, so the kick
      // will find only the nodes that genuinely need it.
      rebuildGenerationRef.current += 1;
      setRebuildGeneration(rebuildGenerationRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphFingerprint, canOpen, canCheck, nodeCallbacks, setRfNodes, setRfEdges]);

  // ── Drag-to-connect / edge-removal ─────────────────────────────────────────
  const connectMutation = useConnectMutation();
  const disconnectMutation = useDisconnectMutation();

  // Drag-to-connect: React Flow gives { source, target, sourceHandle,
  // targetHandle }. Imported nodes only expose a source handle and analysis
  // nodes only a target handle, so the only valid drop is
  // imported(source) → analysis(target). We validate the endpoints against the
  // live node sets and ignore anything else (drop elsewhere / wrong direction /
  // same role, Req 3.6). On success the connection-graph + tree keys are
  // invalidated by the mutation, so the edge appears via the query refresh
  // (Req 3.1, 3.2, 3.5) — we never add a local edge, so a rejected/duplicate
  // connection (Req 3.3, 3.4, 3.7, 7.9) leaves the canvas unchanged.
  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;

      const d = graphDataRef.current;
      const importedIds = new Set(d.importSources.map((s) => s.targetNamespace));
      const analysisIds = new Set(d.authoredNamespaces.map((n) => n.name));

      // Valid direction only: imported → analysis. Anything else is a no-op.
      if (!importedIds.has(source) || !analysisIds.has(target)) return;

      connectMutation.mutate(
        { sourceNamespace: source, targetNamespace: target },
        {
          // Connect DB write succeeded → schedule a coalesced Auto_Save (Req 2.1).
          // Creating a connection can add the derived CATEGORIZEDBY content edge,
          // which a universe-scoped store cannot persist, so save at 'full' scope
          // (see the disconnect handler for the rationale).
          onSuccess: () => scheduleAutoSave('full'),
          onError: (err) => {
            // DB write failed → do NOT schedule; surface Save_Status failed (Req 2.5).
            setAutoSaveStatus(
              'failed',
              err instanceof Error ? err.message : String(err),
            );
            void message.error(
              `Could not create connection: ${friendlyErrorMessage(
                err instanceof Error ? err.message : String(err),
              )}`,
            );
          },
        },
      );
    },
    [connectMutation, scheduleAutoSave, setAutoSaveStatus],
  );

  // Manual_Move completed (drag end): enter the Auto_Layout_Deactivated_State
  // (Req 3.1) and persist the moved Canvas_Element's post-drag Element_Position
  // (Req 1.1). The node id is the Element_Key (imported → targetNamespace,
  // analysis → name) and the node type maps back to the Element_Kind. Persisting
  // invalidates the layout query, so the node re-resolves to its now-stored
  // coordinate on the next render (Req 2.5).
  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node) => {
      setAutoLayoutActive(false);

      const elementKind =
        node.type === 'analysisNode'
          ? ANALYSIS_ELEMENT_KIND
          : node.type === 'importerNode'
            ? IMPORTED_ELEMENT_KIND
            : null;
      if (!elementKind) return;

      // Seed the position we are about to persist so a rebuild that happens
      // before the layout refetch lands renders the node where the user put it.
      setFallbackPosition(
        fallbackPlacementRef.current,
        encodeLayoutId(elementKind, node.id),
        node.position,
      );

      dragPersistMutation.mutate(
        [{ elementKind, elementKey: node.id, x: node.position.x, y: node.position.y }],
        {
          // Position DB write succeeded → schedule a coalesced Auto_Save (Req 1.1).
          onSuccess: () => scheduleAutoSave(),
          onError: (err) => {
            // DB write failed → do NOT schedule; surface Save_Status failed (Req 2.5-analog).
            setAutoSaveStatus(
              'failed',
              err instanceof Error ? err.message : String(err),
            );
            void message.error(
              `Could not save element position: ${friendlyErrorMessage(
                err instanceof Error ? err.message : String(err),
              )}`,
            );
          },
        },
      );
    },
    [dragPersistMutation, setAutoLayoutActive, scheduleAutoSave, setAutoSaveStatus],
  );

  // Removes the document-level selectstart guard installed by onConnectStart.
  // Held in a ref because the guard outlives the render that created it.
  const releaseSelectionGuard = useRef<(() => void) | null>(null);

  // The user began drawing a Namespace_Connection from a connection handle:
  // enter the Auto_Layout_Deactivated_State (Req 3.2). Actual connection
  // creation is handled by onConnect; this only flips the Auto_Layout state so a
  // subsequent data change never re-lays-out the arranged nodes.
  //
  // It also suppresses text selection for the duration of the drag. React Flow's
  // NODE drag goes through d3-drag, which installs its own selectstart guard;
  // its CONNECTION drag (XYHandle.onPointerDown) installs nothing and relies
  // solely on `.react-flow__node { user-select: none }` from its stylesheet. That
  // is a cascade accident — global.css now asserts the same rule, and this guard
  // makes the behaviour independent of CSS altogether.
  const onConnectStart = useCallback(() => {
    setAutoLayoutActive(false);

    releaseSelectionGuard.current?.();
    const block = (event: Event) => event.preventDefault();
    document.addEventListener('selectstart', block, true);
    window.getSelection()?.removeAllRanges();
    releaseSelectionGuard.current = () => {
      document.removeEventListener('selectstart', block, true);
      releaseSelectionGuard.current = null;
    };
  }, [setAutoLayoutActive]);

  // A drag can still be in flight when the canvas unmounts (workspace closed
  // mid-gesture), which would leave the document-level listener behind.
  useEffect(() => () => releaseSelectionGuard.current?.(), []);

  // When a connection drag is released on a node body (not on a handle), treat
  // it as if the user dropped on the connection handle — attempt the connection
  // if the direction is valid (issue #56).
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // Fires for every drag, including cancelled and invalid ones, so this is
      // the one place the selectstart guard is guaranteed to be lifted. Must run
      // before the early returns below.
      releaseSelectionGuard.current?.();

      // Only act when the drag ended on a node but NOT on a handle. If it ended
      // on a handle, onConnect already handled it.
      if (!connectionState.fromNode || !connectionState.toNode || connectionState.toHandle) return;

      const source = connectionState.fromNode.id as string;
      const target = connectionState.toNode.id as string;
      if (!source || !target || source === target) return;

      const d = graphDataRef.current;
      const importedIds = new Set(d.importSources.map((s) => s.targetNamespace));
      const analysisIds = new Set(d.authoredNamespaces.map((n) => n.name));

      // Valid direction only: imported → analysis.
      if (!importedIds.has(source) || !analysisIds.has(target)) return;

      connectMutation.mutate(
        { sourceNamespace: source, targetNamespace: target },
        {
          // Connect DB write succeeded → schedule a coalesced Auto_Save (Req 2.1).
          // 'full' scope so a newly created CATEGORIZEDBY content edge is
          // persisted (mirrors the onConnect handler above).
          onSuccess: () => scheduleAutoSave('full'),
          onError: (err) => {
            // DB write failed → do NOT schedule; surface Save_Status failed (Req 2.5).
            setAutoSaveStatus(
              'failed',
              err instanceof Error ? err.message : String(err),
            );
            void message.error(
              `Could not create connection: ${friendlyErrorMessage(
                err instanceof Error ? err.message : String(err),
              )}`,
            );
          },
        },
      );
    },
    [connectMutation, scheduleAutoSave, setAutoSaveStatus],
  );

  // Auto_Layout_Button pressed: re-tidy the whole canvas on demand. Recompute
  // deterministic partitioned positions (imported-left / analysis-right) for ALL
  // rendered Canvas_Elements via the shared ELK graph/options (Req 4.2, 4.5),
  // render every node at its computed position (Req 4.2), persist a Layout_Record
  // for every rendered element in one batch (Req 4.3), and enter the
  // Auto_Layout_Deactivated_State (Req 4.4). On persist failure the computed
  // positions stay on-screen (we never revert rfNodes) and an Error surfaces that
  // the layout could not be saved (Req 4.6).
  const onAutoLayout = useCallback(() => {
    const d = graphDataRef.current;
    const { elkNodes, elkEdges } = buildElkGraph(
      d.importSources,
      d.authoredNamespaces,
      d.connectionGraph?.connections ?? [],
    );

    // ELK is async, so the workspace could be switched while it runs. Capture the
    // workspace this layout was computed for and drop the result if it no longer
    // matches, so positions are never rendered or persisted against a different
    // workspace.
    const startedForWorkspace = d.workingDir;

    void (async () => {
      const { positions } = await computeElkLayout({
        nodes: elkNodes,
        edges: elkEdges,
        layoutOptions: ELK_LAYOUT_OPTIONS,
      });
      if (graphDataRef.current.workingDir !== startedForWorkspace) return;

      // Render every node at its computed position (Req 4.2). Existing node data
      // / callbacks are preserved — only the position changes.
      setRfNodes((nodes) =>
        nodes.map((n) => {
          const pos = positions.get(n.id);
          return pos ? { ...n, position: { x: pos.x, y: pos.y } } : n;
        }),
      );

      // Persist a Layout_Record for EVERY rendered element at its computed
      // position (Req 4.3). Each node's id is its Element_Key and its role maps
      // back to the Element_Kind: imported → targetNamespace, analysis → name.
      // The pure record-building logic lives in `autoLayoutRecords.ts` so it can
      // be exercised directly by property tests.
      const records = buildAutoLayoutRecords(d.importSources, d.authoredNamespaces, positions);

      if (records.length > 0) {
        autoLayoutPersistMutation.mutate(records, {
          // Bulk layout DB write succeeded → schedule a coalesced Auto_Save so the
          // re-tidied positions are flushed to disk without waiting for a later
          // drag or a manual File → Save. Auto Layout only rewrites Layout_Records
          // (universe layer), so the default universe scope is sufficient (Req 1.1).
          onSuccess: () => scheduleAutoSave(),
          onError: (err) => {
            // Keep the computed positions rendered (do NOT revert rfNodes) and
            // surface that the layout could not be saved (Req 4.6).
            setAutoSaveStatus(
              'failed',
              err instanceof Error ? err.message : String(err),
            );
            void message.error(
              `Could not save layout: ${friendlyErrorMessage(
                err instanceof Error ? err.message : String(err),
              )}`,
            );
          },
        });
      }

      // Auto_Layout has been applied once → enter Deactivated (Req 4.4).
      setAutoLayoutActive(false);
    })();
  }, [autoLayoutPersistMutation, setAutoLayoutActive, setRfNodes, scheduleAutoSave, setAutoSaveStatus]);

  // ── Placement_Mode interaction (Req 9.2, 9.3, 9.5) ────────────────────────
  // Track the cursor inside the canvas wrapper so the ghost preview can be drawn
  // at the current pointer position while placing (Req 9.2). Only active while
  // Placement_Mode is on; a no-op otherwise so normal canvas use is unaffected.
  const onCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!useWorkspaceStore.getState().placement) return;
      const rect = canvasWrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      setGhostPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    },
    [],
  );

  // Primary click on the canvas pane while placing: commit the new
  // Canvas_Element at the clicked flow coordinate, exit Placement_Mode, and enter
  // the Auto_Layout_Deactivated_State (Req 9.3). When not placing this is a
  // no-op, so ordinary pane clicks keep their existing behavior.
  // Also clears any selected edge when clicking the pane background.
  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      setSelectedEdgeId(null);
      const current = useWorkspaceStore.getState().placement;
      if (!current) return;
      const rf = rfInstanceRef.current;
      if (!rf) return;
      const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      // Seed the clicked position so a rebuild before the layout refetch lands
      // renders the element where the user clicked.
      setFallbackPosition(
        fallbackPlacementRef.current,
        encodeLayoutId(current.elementKind, current.elementKey),
        flow,
      );
      dragPersistMutation.mutate(
        [buildPlacementRecord(current, flow)],
        {
          // Placement position DB write succeeded → schedule a coalesced
          // Auto_Save so the initial placement is flushed to disk without
          // waiting for a later drag (Req 1.1).
          onSuccess: () => scheduleAutoSave(),
          onError: (err) => {
            setAutoSaveStatus(
              'failed',
              err instanceof Error ? err.message : String(err),
            );
            void message.error(
              `Could not save element position: ${friendlyErrorMessage(
                err instanceof Error ? err.message : String(err),
              )}`,
            );
          },
        },
      );
      exitPlacement();
      setAutoLayoutActive(false);
      setGhostPos(null);
    },
    [dragPersistMutation, exitPlacement, setAutoLayoutActive, scheduleAutoSave, setAutoSaveStatus],
  );

  // Cancel placement (Escape key or an equivalent control): keep the created
  // Canvas_Element, give it a position, persist a Layout_Record, and exit
  // Placement_Mode (Req 9.5). The position is near the center of the current
  // viewport — so the new element is immediately visible where the user was
  // looking — cascaded to the first spot that does not overlap an element already
  // on the canvas (cancelling three placements in a row must not stack three
  // tiles on one another and bury their connection handles). It is never an
  // Auto_Layout result: cancelling a placement may not re-arrange the rest of the
  // diagram (Req 9.4).
  const cancelPlacement = useCallback(() => {
    const current = useWorkspaceStore.getState().placement;
    if (!current) return;

    const rf = rfInstanceRef.current;
    const rect = canvasWrapperRef.current?.getBoundingClientRect();
    const viewportCenter =
      rf && rect
        ? rf.screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : { x: 0, y: 0 };
    // screenToFlowPosition yields the point itself; a node's `position` is its
    // top-left corner, so shift by half the tile to center it on that point.
    const preferred = {
      x: viewportCenter.x - NEW_ELEMENT_SIZE.width / 2,
      y: viewportCenter.y - NEW_ELEMENT_SIZE.height / 2,
    };
    const occupied = (rf?.getNodes?.() ?? []).map((n) => ({
      x: n.position.x,
      y: n.position.y,
      width: n.measured?.width ?? NEW_ELEMENT_SIZE.width,
      height: n.measured?.height ?? NEW_ELEMENT_SIZE.height,
    }));
    const pos = findFreePosition(preferred, occupied);
    // Seed the chosen position so a rebuild before the layout refetch lands
    // renders the element here — and so the NEXT cancelled placement sees this
    // element at its real coordinate when looking for a free spot.
    setFallbackPosition(
      fallbackPlacementRef.current,
      encodeLayoutId(current.elementKind, current.elementKey),
      pos,
    );

    dragPersistMutation.mutate(
      [{ elementKind: current.elementKind, elementKey: current.elementKey, x: pos.x, y: pos.y }],
      {
        // Fallback-placement DB write succeeded → schedule a coalesced Auto_Save
        // so the auto-placed position is flushed to disk immediately (Req 1.1).
        onSuccess: () => scheduleAutoSave(),
        onError: (err) => {
          setAutoSaveStatus(
            'failed',
            err instanceof Error ? err.message : String(err),
          );
          void message.error(
            `Could not save element position: ${friendlyErrorMessage(
              err instanceof Error ? err.message : String(err),
            )}`,
          );
        },
      },
    );
    exitPlacement();
    setGhostPos(null);
  }, [dragPersistMutation, exitPlacement, scheduleAutoSave, setAutoSaveStatus]);

  // Escape cancels Placement_Mode (Req 9.5). The listener is only installed
  // while placing, so it never intercepts Escape outside Placement_Mode.
  useEffect(() => {
    if (!placement) {
      setGhostPos(null);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelPlacement();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placement, cancelPlacement]);

  // Edge removal: built-in edge deletion is disabled (deleteKeyCode={null}).
  // Clicking an edge selects it (highlighted); pressing Delete/Backspace while
  // an edge is selected triggers the disconnect workflow (issue #55/#54).
  // If the edge has zero dependent cross-namespace relationships we disconnect
  // directly (Req 5.1); otherwise we show a confirm with the EXACT dependent
  // count and only disconnect with deleteDependents:true on OK (Req 5.2, 5.4),
  // leaving the edge in place on cancel (Req 5.3).
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setSelectedEdgeId((prev) => prev === edge.id ? null : edge.id);
    },
    [],
  );

  const runEdgeDisconnect = useCallback(
    (edge: Edge) => {
      const imported = edge.source;
      const authored = edge.target;
      if (!imported || !authored) return;

      const runDisconnect = (deleteDependents: boolean) => {
        // Removing a Namespace_Connection is a deliberate graph edit, exactly
        // like starting to draw one (onConnectStart) or finishing a Manual_Move
        // (onNodeDragStop): enter the Auto_Layout_Deactivated_State so a later
        // data change never re-tidies the arrangement the user just changed.
        setAutoLayoutActive(false);

        disconnectMutation.mutate(
          { importedNamespace: imported, authoredNamespace: authored, deleteDependents },
          {
            // Disconnect DB write succeeded → schedule a coalesced Auto_Save (Req 2.2).
            // Removing a connection can change namespace CONTENT (dependent
            // cross-namespace relationships and the ref-counted CATEGORIZEDBY
            // edge), which a universe-scoped store cannot persist. Connection
            // edits are infrequent, deliberate actions, so we always save at
            // 'full' scope — always correct, and the extra cost is negligible
            // outside the high-frequency drag/placement path (which stays universe).
            onSuccess: () => scheduleAutoSave('full'),
            onError: (err) => {
              // DB write failed → do NOT schedule; surface Save_Status failed (Req 2.5).
              setAutoSaveStatus(
                'failed',
                err instanceof Error ? err.message : String(err),
              );
              void message.error(
                `Could not remove connection: ${friendlyErrorMessage(
                  err instanceof Error ? err.message : String(err),
                )}`,
              );
            },
          },
        );
      };

      void (async () => {
        let count: number;
        try {
          count = await countDependents(imported, authored);
        } catch (err) {
          void message.error(
            `Could not check dependent relationships: ${friendlyErrorMessage(
              err instanceof Error ? err.message : String(err),
            )}`,
          );
          return;
        }

        // Always confirm before removing — either a lightweight "are you sure?"
        // (count === 0, Req 5.1) or a heavier warning that names the exact
        // number of dependent cross-namespace relationships that will also be
        // deleted (count > 0, Req 5.2). Cancel leaves the connection and its
        // dependents intact (Req 5.3).
        modal.confirm({
          title: 'Remove connection',
          content:
            count === 0
              ? `Remove the connection from "${imported}" to "${authored}"?`
              : `This connection has ${count} dependent cross-namespace relationship${
                  count === 1 ? '' : 's'
                } which will be deleted. Continue?`,
          okText: 'Remove connection',
          okType: 'danger',
          cancelText: 'Cancel',
          onOk: () => runDisconnect(count > 0),
        });
      })();
    },
    [disconnectMutation, scheduleAutoSave, setAutoSaveStatus, setAutoLayoutActive],
  );

  // Delete/Backspace key handler: when an edge is selected, trigger disconnect.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      // Don't intercept if focus is inside a text input / editor.
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const edgeId = selectedEdgeId;
      if (!edgeId) return;
      const edge = rfEdges.find((e) => e.id === edgeId);
      if (!edge) return;
      event.preventDefault();
      setSelectedEdgeId(null);
      runEdgeDisconnect(edge);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedEdgeId, rfEdges, runEdgeDisconnect]);

  // Sync selectedEdgeId into the React Flow edge selected state for visual highlighting.
  useEffect(() => {
    setRfEdges((edges) =>
      edges.map((e) => ({ ...e, selected: e.id === selectedEdgeId })),
    );
  }, [selectedEdgeId, setRfEdges]);

  // Subscribe to Edit → Import All native menu action (issue #64).
  useEffect(() => {
    const unsubscribe = api.menu.onImportAll(() => { void handleImportAll(); });
    return unsubscribe;
  // handleImportAll closes over importSources and anyRunning — re-subscribe when they change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importSources, anyRunning]);

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        background: token.colorBgLayout,
      }}
    >
      {/* Action row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: 8 }}>
        {/* Left: Add Import + Import All */}
        <div>
          {hasWorkspace && (
            <Space size={4}>
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => setAddImporterOpen(true)} size="small" style={{ fontSize: 12 }} disabled={anyRunning}>
                Add Import
              </Button>
              {importSources.length > 0 && (
                <Button
                  icon={<ImportOutlined />}
                  onClick={() => void handleImportAll()}
                  size="small"
                  style={{ fontSize: 12 }}
                  disabled={anyRunning}
                >
                  Run All Imports
                </Button>
              )}
            </Space>
          )}
        </div>

        {/* Center: placeholder (workspace switching is via File menu) */}
        <div />

        {/* Right: Add Analysis */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {hasWorkspace && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => (onAddAnalysis ? onAddAnalysis() : setAddAnalysisOpen(true))}
              size="small"
              style={{ fontSize: 12 }}
              disabled={anyRunning}
            >
              Add Analysis
            </Button>
          )}
        </div>
      </div>

      {/* Operation error surfaced above the graph (e.g. load failure) */}
      {opError && (
        <Alert
          type="error"
          showIcon
          message={lastFailedOp === 'load' ? 'Load failed' : 'Operation failed'}
          description={friendlyErrorMessage(opError)}
          style={{ flexShrink: 0 }}
        />
      )}

      {/* Namespace graph (React Flow + ELK auto-layout) or empty state.
          While the workspace database is not open we render zero nodes and a
          "no workspace database open" message (Req 7.5). */}
      {dbOpen ? (
        <div
          ref={canvasWrapperRef}
          onMouseMove={onCanvasMouseMove}
          style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, cursor: placement ? 'crosshair' : undefined }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            nodesConnectable
            connectionRadius={320}
            style={{ background: token.colorBgLayout }}
          >
            <GraphFitter signal={graphStructureKey} placementActive={placement !== null} />
            <RfInstanceCapture instanceRef={rfInstanceRef} />
            <NodeMeasurementKick generation={rebuildGeneration} />
            {/* Observation-only diagnostics for elements that never acquire
                Measured_Dimensions (Reqs 6.1–6.4). `enabled` is redundant with
                this subtree only mounting while dbOpen, but it keeps the "reset
                the watch when the Workspace_Phase leaves db_open" rule explicit
                and independent of where the <ReactFlow> gate happens to sit. */}
            <UnmeasuredElementWatch enabled={dbOpen} />
            {/* Auto_Layout_Button — rendered lower-right. It only appears while
                the Workspace_Phase is db_open because the whole <ReactFlow> tree
                is only mounted while dbOpen (Req 4.1). Pressing it re-tidies and
                persists the layout, then enters Deactivated (Req 4.2–4.4, 4.6). */}
            <Panel position="bottom-right">
              <Button
                size="small"
                icon={<ApartmentOutlined />}
                onClick={onAutoLayout}
                loading={autoLayoutPersistMutation.isPending}
              >
                Auto Layout
              </Button>
            </Panel>
          </ReactFlow>
          {/* Placement_Mode ghost preview — follows the cursor while placing a
              newly created Canvas_Element (Req 9.2). pointerEvents:none so the
              primary click still reaches the React Flow pane (Req 9.3). */}
          {placement && ghostPos && (
            <div
              style={{
                position: 'absolute',
                left: ghostPos.x,
                top: ghostPos.y,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                zIndex: 10,
                width: 270,
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px dashed ${token.colorPrimary}`,
                background: token.colorBgElevated,
                boxShadow: token.boxShadowSecondary,
                opacity: 0.85,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: token.colorText, marginBottom: 4 }}>
                {placement.elementKey}
              </div>
              <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                Click to place · Esc to auto-place
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          {isLoadingFromRiaData ? (
            <>
              <LoadingOutlined style={{ fontSize: 28, color: token.colorWarning }} spin />
              <span style={{ color: token.colorTextSecondary }}>Loading from ria-data…</span>
            </>
          ) : isSaving ? (
            <>
              <LoadingOutlined style={{ fontSize: 28, color: token.colorPrimary }} spin />
              <span style={{ color: token.colorTextSecondary }}>Saving…</span>
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: token.colorTextSecondary }}>No workspace database open</span>
              }
            />
          )}
        </div>
      )}

      {/* Add importer modal */}
      <AddImporterModal
        open={addImporterOpen}
        workingDir={wsState.phase !== 'no_workspace' ? wsState.workingDir : ''}
        onClose={() => setAddImporterOpen(false)}
        onProvisioned={(sourceId, sourceType, namespace) => {
          setAddImporterOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['imports.listSources'] });
          // Open the Config drawer for the newly provisioned import source so the
          // user can configure it before placement (issue #49). After the drawer is
          // closed, Placement_Mode is entered for the new element (Req 9.1).
          const stubSource: ImportSourceInfo = {
            sourceId,
            name: namespace,
            sourceType,
            targetNamespace: namespace,
            targetMetamodel: '',
            importerVersion: '',
            updatedAt: new Date().toISOString(),
            lastRunStatus: null,
            configDirty: true,
            lastRunAt: null,
          };
          setConfigSource(stubSource);
          setPostConfigPlacement({ elementKind: IMPORTED_ELEMENT_KIND, elementKey: namespace });
        }}
      />

      <AddAnalysisModal
        open={addAnalysisOpen}
        workingDir={wsState.phase !== 'no_workspace' ? wsState.workingDir : ''}
        onClose={() => setAddAnalysisOpen(false)}
        onCreated={(info) => {
          setAddAnalysisOpen(false);
          queryClient.invalidateQueries({ queryKey: ['namespaces.list'] });
          queryClient.invalidateQueries({ queryKey: ['db.stats'] });
          // Enter Placement_Mode for the new analysis Canvas_Element (Req 9.1).
          enterPlacement(ANALYSIS_ELEMENT_KIND, info.namespace);
        }}
      />

      {/* Config modal */}
      <ImporterConfigModal
        source={selectedConfigSource}
        workingDir={wsState.phase !== 'no_workspace' ? wsState.workingDir : ''}
        isNewSource={!!postConfigPlacement}
        onClose={(committed) => {
          const pending = postConfigPlacement;
          const closingSource = selectedConfigSource;
          setConfigSource(null);
          setPostConfigPlacement(null);
          // No pending placement → existing source, just close (#49).
          if (!pending) return;
          if (committed) {
            // Finished via "Save — Place on Canvas": enter Placement_Mode for
            // the newly configured element (Req 9.1).
            enterPlacement(pending.elementKind, pending.elementKey);
          } else if (closingSource) {
            // Cancelled a brand-new, unplaced source (X / discard): roll back
            // the provisioning so nothing is left on the canvas or on disk.
            void handleCancelNewSource(closingSource.sourceId);
          }
        }}
      />

      {/* Generic model browser modal — reuses the shared safety tree for all
          non-Symbols import sources (AUTOSAR/ARXML, SysML-v2, Sphinx-needs, …) */}
      <Suspense fallback={null}>
        <GenericModelBrowserModal
          open={!!modelBrowserNamespace}
          onClose={() => setModelBrowserNamespace(null)}
          namespace={modelBrowserNamespace ?? ''}
        />
      </Suspense>

      {/* Compact import-structure browser — reachable from the importer card ⋯ menu */}
      <Suspense fallback={null}>
        <GenericImportViewerModal
          sourceInfo={viewGenericSource}
          onClose={() => setViewGenericSource(null)}
        />
      </Suspense>

      {/* Run update from branch modal (UC2) — branch picker; the parent runs
          the import and shows the impact analysis, exactly like the Run button. */}
      {updateFromBranchSource && (
        <UpdateFromBranchModal
          source={updateFromBranchSource}
          open={!!updateFromBranchSource}
          onClose={() => setUpdateFromBranchSource(null)}
          onRun={(repoDir, ref) => {
            void handleRunFromBranch(updateFromBranchSource.sourceId, repoDir, ref);
          }}
        />
      )}

      {/* Git Commit modal moved to App.tsx — triggered via Git menu */}

      {/* Impact report modal — shown after a re-import completes */}
      <Modal
        title="Import Impact Analysis"
        open={!!lastImportRunId}
        onCancel={() => setLastImportRunId(null)}
        footer={
          <Button type="primary" onClick={() => setLastImportRunId(null)}>
            Close
          </Button>
        }
        width={720}
        destroyOnClose
      >
        {lastImportRunId && <ImpactReportPanel runId={lastImportRunId} />}
      </Modal>

      {/* Import All aggregate impact report modal (issue #64) */}
      {importAllResults && (
        <Modal
          title={`Run All Imports — Impact Analysis (${importAllResults.length} source${importAllResults.length === 1 ? '' : 's'})`}
          open
          onCancel={() => setImportAllResults(null)}
          footer={
            <Button type="primary" onClick={() => setImportAllResults(null)}>
              Close
            </Button>
          }
          width={800}
          destroyOnClose
        >
          {importAllResults.map(({ sourceName, runId }) => (
            <div key={runId} style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{sourceName}</div>
              <ImpactReportPanel runId={runId} />
            </div>
          ))}
        </Modal>
      )}

      {/* Merge from Files modal (UC-13) */}
      {mergeFromFilesTarget && (
        <MergeFromFilesConfirm
          ns={mergeFromFilesTarget.ns}
          workingDir={mergeFromFilesTarget.workingDir}
          onClose={() => setMergeFromFilesTarget(null)}
        />
      )}

      {/* Merge from Branch modal (UC-14) */}
      {mergeFromBranchTarget && (
        <MergeFromBranchModal
          ns={mergeFromBranchTarget.ns}
          workingDir={mergeFromBranchTarget.workingDir}
          repoDir={resolvedRepoDir}
          open={!!mergeFromBranchTarget}
          onClose={() => setMergeFromBranchTarget(null)}
        />
      )}

      {/* Supervised Merge from Branch modal (UC-15) */}
      {supervisedMergeFromBranchTarget && resolvedRepoDir && (
        <SupervisedMergeFromBranchModal
          ns={supervisedMergeFromBranchTarget.ns}
          workingDir={supervisedMergeFromBranchTarget.workingDir}
          repoDir={resolvedRepoDir}
          open={true}
          onClose={() => setSupervisedMergeFromBranchTarget(null)}
        />
      )}

      {/* Namespace delete preview modal */}
      {deleteTarget !== null && (
        <NamespaceDeleteWithPreview
          namespace={deleteTarget.namespace}
          role={deleteTarget.role}
          sourceId={deleteTarget.sourceId}
          autoOpen
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            if (deleteTarget.role === 'imported' && deleteTarget.sourceId) {
              await deleteImportSourceMutation.mutateAsync(deleteTarget.sourceId);
            } else {
              await deleteNamespaceMutation.mutateAsync(deleteTarget.namespace);
            }
            // A namespace / import-source delete changes WHICH namespaces
            // exist: it removes the namespace's nodes and its
            // RIA_UNIV_NamespaceConnection edges (DETACH DELETE). Persisting
            // this requires a FULL store — only a full store prunes the deleted
            // namespace's on-disk directory and its manifest.namespace_hashes
            // entry. A universe-scoped save would update the layout/connection
            // files (and flip the indicator to "Saved") while leaving the
            // deleted namespace on disk, so it would reappear on the next Load.
            // The coordinator coalesces this with any pending universe work and
            // saves at the joined 'full' scope.
            scheduleAutoSave('full');
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
