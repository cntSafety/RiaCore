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
import { Modal, Form, Input, Switch, Space, Button, Spin, Alert, Typography, Tooltip, theme, App } from 'antd';
import {
  SaveOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  CheckCircleFilled,
  FolderOpenOutlined,
  RightOutlined,
  DownOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ImportConfigView, ImportSourceInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import { useSaveImportConfigMutation } from '../hooks/useRiacoreMutations';
import { useActiveImport } from '../hooks/useActiveImport';

const { Text } = Typography;
const { useToken } = theme;

const ELEMENT_LABELS: Record<string, string> = {
  swc_types:       'SW-Component Types',
  ports:           'Ports',
  port_interfaces: 'Port Interfaces',
  data_types:      'Data Types',
  swc_behavior:    'SWC Behavior',
  bsw_modules:     'BSW Modules',
  connectors:      'Connectors',
  communication:   'Communication',
  system:          'System',
  ecuc:            'ECU Configuration',
};

const isArxmlSource = (sourceType?: string) => sourceType === 'arxml_file' || sourceType === 'arxml';
const isSysmlSource = (sourceType?: string) => sourceType === 'sysml_v2_json' || sourceType === 'sysml_v2';
const isSphinxNeedsSource = (sourceType?: string) => sourceType === 'sphinx_needs_json' || sourceType === 'sphinx_needs';
const isSysmlTextualSource = (sourceType?: string) => sourceType === 'sysml_v2_textual';

// `projectDirAbsolute` is derived from `projectDir` by the backend and is not
// editable, so it must stay out of the dirty comparison.
type ComparableImportConfig = Omit<ImportConfigView, 'sourceId' | 'projectDirAbsolute'>;

function normalizeConfigForCompare(values: Partial<ImportConfigView> | undefined): ComparableImportConfig {
  const elements = values?.elements && typeof values.elements === 'object' ? values.elements : {};
  const sortedElements = Object.fromEntries(
    Object.keys(elements)
      .sort()
      .map((key) => [key, Boolean(elements[key])]),
  );

  return {
    sourceType: values?.sourceType ?? '',
    namespace: values?.namespace ?? '',
    sourceName: values?.sourceName ?? '',
    projectDir: values?.projectDir ?? '',
    scanResultDir: values?.scanResultDir,
    needsFile: values?.needsFile,
    filesInclude: Array.isArray(values?.filesInclude) ? values.filesInclude.map(String) : [],
    filesExclude: Array.isArray(values?.filesExclude) ? values.filesExclude.map(String) : [],
    elements: sortedElements,
    configPath: values?.configPath,
  };
}

function configsMatch(
  left: Partial<ImportConfigView> | undefined,
  right: Partial<ImportConfigView> | undefined,
): boolean {
  return JSON.stringify(normalizeConfigForCompare(left)) === JSON.stringify(normalizeConfigForCompare(right));
}

interface Props {
  source: ImportSourceInfo | null;
  workingDir: string;
  /**
   * When true the modal is being opened immediately after provisioning a new
   * import source (the "add" flow). The footer shows "Save — Place on Canvas"
   * instead of "Close": clicking it saves the config (user-initiated) and then
   * proceeds to canvas placement. The X / cancel button never saves.
   */
  isNewSource?: boolean;
  /**
   * Called when the modal closes. `committed` is `true` only when the user
   * finished via "Save — Place on Canvas" (config saved, proceed to placement).
   * It is `false` for X / cancel / discard — for a brand-new source the caller
   * treats that as a cancellation and rolls back the provisioned source.
   */
  onClose: (committed: boolean) => void;
}

export function ImporterConfigModal({ source, workingDir, isNewSource = false, onClose }: Props) {
  const { token } = useToken();
  // Instance-based modal API so confirm dialogs inherit the active Ant Design
  // theme (dark mode). The static `Modal.confirm` export renders outside the
  // <App> provider and always falls back to the light theme.
  const { modal } = App.useApp();
  const [form] = Form.useForm<ImportConfigView>();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [localDirty, setLocalDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [persistedConfigDirty, setPersistedConfigDirty] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Path fields whose backslashes were just auto-converted to forward slashes.
  // Drives a per-field info notice so the user knows their pasted Windows path
  // was rewritten. Cleared on reset and on Browse (which yields a clean value).
  const [convertedPathFields, setConvertedPathFields] = useState<Record<string, boolean>>({});
  const savedConfigBaseline = useRef<Partial<ImportConfigView> | null>(null);

  const { data: activeImport } = useActiveImport();
  const sourceId = source?.sourceId ?? null;
  const anyRunning = activeImport !== null && activeImport !== undefined;
  const watchedSourceType = Form.useWatch('sourceType', form) ?? source?.sourceType ?? '';
  const showArxmlConfig = isArxmlSource(watchedSourceType);
  const showSysmlConfig = isSysmlSource(watchedSourceType);
  const showSphinxNeedsConfig = isSphinxNeedsSource(watchedSourceType);
  const showSysmlTextualConfig = isSysmlTextualSource(watchedSourceType);

  const { data: config, isLoading, error: loadError } = useQuery<ImportConfigView>({
    queryKey: ['imports.getConfig', workingDir || 'no-workspace', sourceId],
    queryFn: () => {
      if (!sourceId) throw new Error('No import source selected');
      return api.imports.getConfig(sourceId);
    },
    enabled: !!sourceId,
  });

  useEffect(() => {
    form.resetFields();
    setSaveError(null);
    setSaveSuccess(false);
    setLocalDirty(false);
    savedConfigBaseline.current = null;
    setPersistedConfigDirty(Boolean(source?.configDirty));
    setDetailsOpen(false);
    setConvertedPathFields({});
  }, [form, sourceId, workingDir]);

  useEffect(() => {
    setPersistedConfigDirty(Boolean(source?.configDirty));
  }, [sourceId, source?.configDirty]);

  useEffect(() => {
    if (config) {
      const normalizedConfig = {
        ...config,
        filesInclude: config.filesInclude ?? [],
        filesExclude: config.filesExclude ?? [],
        elements: config.elements ?? {},
      };
      savedConfigBaseline.current = normalizedConfig;
      form.setFieldsValue(normalizedConfig);
      setLocalDirty(false);
    }
  }, [config, form]);

  // Pass the real workspace root (not the 'no-workspace' query-key sentinel) so
  // the backend can anchor relative path values.
  const saveMutation = useSaveImportConfigMutation(workingDir);

  const markUnsaved = (_changedValues?: unknown, allValues?: ImportConfigView) => {
    if (!sourceId) return;
    const currentValues = allValues ?? form.getFieldsValue(true);
    const isDirty = !configsMatch(currentValues, savedConfigBaseline.current ?? undefined);
    setLocalDirty(isDirty);
    if (isDirty) {
      setSaveSuccess(false);
    }
  };

  /**
   * Explains the two rules for every path field in this dialog: what a relative
   * path is anchored at, and that Browse always produces one. Shown per field
   * via an info icon.
   */
  const pathAnchorHelp = (
    <span style={{ fontSize: 12 }}>
      <strong>Browse</strong> always fills in a <strong>relative</strong> path, resolved against the
      workspace root{workingDir ? <> (<code>{workingDir}</code>)</> : null} — for example{' '}
      <code>../4-sw-arch-arxml</code> for a folder next to the workspace. Relative paths keep the
      project portable: move or clone it, and the import still finds its sources.
      <br />
      <br />
      To pin a source that does <em>not</em> travel with the workspace, type an{' '}
      <strong>absolute</strong> path instead. Whatever you type is stored exactly as entered.
      <br />
      <br />
      Paths use <strong>forward slashes</strong> (<code>/</code>) so they work on Windows, macOS and
      Linux alike — a backslash path is unusable on macOS and Linux. If you paste a Windows path,
      any backslashes are converted to forward slashes automatically.
    </span>
  );

  const pathFieldLabel = (text: string) => (
    <Space size={4}>
      {text}
      <Tooltip title={pathAnchorHelp} styles={{ root: { maxWidth: 380 } }}>
        <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
      </Tooltip>
    </Space>
  );

  /**
   * Normalise backslashes to forward slashes in a path field as it is typed or
   * pasted. A `C:\sources\arxml` value resolves only on Windows and silently
   * breaks the workspace for anyone on macOS or Linux; `C:/sources/arxml` works
   * everywhere. Windows users routinely paste Explorer paths, so rather than
   * blocking the save we rewrite the separators for them and surface a small
   * info notice (see `pathConversionNotice`). Wired via `getValueFromEvent`, so
   * the value stored in the form — and later saved — never contains a backslash.
   */
  const normalizePathValue =
    (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const normalized = raw.replace(/\\/g, '/');
      if (normalized !== raw) {
        setConvertedPathFields((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
      }
      return normalized;
    };

  /**
   * Per-field info notice shown once a path field's backslashes were converted,
   * so the change is not silent. Stays visible until the modal resets or Browse
   * replaces the value.
   */
  const pathConversionNotice = (field: string) =>
    convertedPathFields[field] ? (
      <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>
        <InfoCircleOutlined style={{ color: token.colorInfo, marginRight: 4 }} />
        Backslashes were converted to forward slashes (/) for cross-platform portability.
      </Text>
    ) : null;

  const browseForDirectory = async (field: 'projectDir') => {
    if (anyRunning || saveMutation.isPending) return;
    // Start in the workspace, and anchor there so the dialog returns a relative
    // path. The field then shows exactly what will be stored.
    const dir = await api.dialog.openDirectory({
      title: 'Select the import source folder',
      ...(workingDir ? { defaultPath: workingDir, relativeTo: workingDir } : {}),
    });
    if (dir) {
      form.setFieldValue(field, dir);
      setConvertedPathFields((prev) => (prev[field] ? { ...prev, [field]: false } : prev));
      markUnsaved(undefined, { ...form.getFieldsValue(true), [field]: dir } as ImportConfigView);
    }
  };

  const handleSaveConfig = async () => {
    if (!sourceId) {
      setSaveError('No import source selected. Please reopen the importer configuration.');
      return false;
    }

    setSaveError(null);
    try {
      const values = await form.validateFields();
      await saveMutation.mutateAsync({ values, sourceId });
      savedConfigBaseline.current = values;
      setLocalDirty(false);
      setSaveSuccess(true);
      if (hasCompletedImport) setPersistedConfigDirty(true);
      return true;
    } catch (err) {
      if (err instanceof Error) {
        setSaveError(err.message);
      }
      return false;
    }
  };

  // User-initiated "Save — Place on Canvas": persists the config (same save as
  // the "Save Config" button) and, only if the save succeeds, closes the modal
  // so the caller can enter canvas placement. This is NOT an auto-save-on-close:
  // the X / cancel button (handleCloseRequest) still discards unsaved changes.
  const handleSaveAndPlace = async () => {
    const saved = await handleSaveConfig();
    if (saved) onClose(true);
  };

  const handleCloseRequest = () => {
    // A brand-new source has already been provisioned (DB row + config YAML) at
    // "Add" time but is not yet placed on the canvas. Closing it via X / cancel
    // is a cancellation: warn the user, then let the caller roll it back.
    if (isNewSource) {
      modal.confirm({
        title: 'Discard new import source?',
        icon: <ExclamationCircleOutlined />,
        content: 'This import source has not been placed on the canvas. Closing will discard it and remove its saved configuration.',
        okText: 'Discard',
        cancelText: 'Keep Editing',
        okButtonProps: { danger: true },
        onOk: () => onClose(false),
      });
      return;
    }

    if (!localDirty) {
      onClose(false);
      return;
    }

    modal.confirm({
      title: 'Discard unsaved configuration changes?',
      icon: <ExclamationCircleOutlined />,
      content: 'Your changes have not been saved. Closing this dialog will discard them.',
      okText: 'Discard Changes',
      cancelText: 'Keep Editing',
      okButtonProps: { danger: true },
      onOk: () => onClose(false),
    });
  };

  const hasCompletedImport = source?.lastRunStatus === 'completed';
  const showUnsavedNotice = !saveError && localDirty;
  const showDirtyNotice = !saveError && !localDirty && hasCompletedImport && persistedConfigDirty;
  const showSyncedNotice = !saveError && !localDirty && hasCompletedImport && !showDirtyNotice;

  const title = source ? `Configure — ${source.name}` : 'Configure Importer';
  const formDisabled = anyRunning || saveMutation.isPending;

  const sectionStyle: CSSProperties = {
    margin: '16px 0 10px',
    paddingTop: 12,
    borderTop: `1px solid ${token.colorBorderSecondary}`,
  };

  const sectionTitleStyle: CSSProperties = {
    margin: 0,
    color: token.colorText,
    fontSize: 12,
    fontWeight: 650,
    lineHeight: 1.3,
  };

  const sectionDescriptionStyle: CSSProperties = {
    display: 'block',
    marginTop: 2,
    color: token.colorTextTertiary,
    fontSize: 11,
    lineHeight: 1.35,
  };

  const noticeStyle: CSSProperties = {
    marginBottom: 14,
    borderRadius: token.borderRadiusLG,
  };

  const footerStatus =
    saveSuccess && !localDirty
      ? {
          tone: 'success' as const,
          icon: <CheckCircleFilled />,
          label: 'Saved',
          message: hasCompletedImport
            ? 'Run the import from its canvas tile to update namespace data.'
            : 'Configuration changes are stored.',
        }
      : showUnsavedNotice
        ? {
            tone: 'warning' as const,
            icon: <ExclamationCircleFilled />,
            label: 'Unsaved changes',
            message: 'Save your changes before closing.',
          }
        : showDirtyNotice
          ? {
              tone: 'warning' as const,
              icon: <ExclamationCircleFilled />,
              label: 'Re-import needed',
              message: 'Configuration changed after the last import.',
            }
          : showSyncedNotice
            ? {
                tone: 'success' as const,
                icon: <CheckCircleFilled />,
                label: 'Synced',
                message: 'Config matches the imported namespace.',
              }
            : isNewSource
              ? {
                  tone: 'info' as const,
                  icon: <InfoCircleOutlined />,
                  label: 'New source',
                  message: 'Configure it, then save to place it on the canvas.',
                }
              : null;

  const footerStatusStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    maxWidth: '100%',
    minHeight: 24,
    padding: 0,
    border: 'none',
    borderRadius: 0,
    background: 'transparent',
  };

  const footerStatusIconColor =
    footerStatus?.tone === 'success'
      ? token.colorSuccess
      : footerStatus?.tone === 'warning'
        ? token.colorWarning
        : token.colorInfo;

  const fieldGroupStyle: CSSProperties = {
    display: 'grid',
    gap: 10,
  };

  const twoColumnGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: '10px 16px',
  };

  const categoryGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '0 18px',
  };

  const categoryRowStyle: CSSProperties = {
    minHeight: 30,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '4px 0',
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: 0,
    background: 'transparent',
  };

  const browseIconStyle: CSSProperties = {
    color: token.colorTextSecondary,
    cursor: formDisabled ? 'not-allowed' : 'pointer',
    fontSize: 15,
  };

  /**
   * Paths and glob patterns are code, not prose. In the proportional UI font
   * `.`, `/` and `*` are the narrowest glyphs in the set, so the characters that
   * carry the most meaning — the `../` walk-up in a path, the double-star
   * recursion in a glob — render as faint specks. A monospace font gives every
   * separator a full cell, which makes the anchor and the segment boundaries
   * readable at a glance.
   *
   * Both target a semantic slot rather than the `style` prop: Ant Design applies
   * `style` to the outermost element — the group wrapper for a field with an
   * `addonAfter`, the count wrapper for a TextArea — and `.ant-input` sets its
   * own `font-family`, so the inner control never inherits it. The slot is
   * named `input` on Input and `textarea` on Input.TextArea.
   */
  const codeFontStyle: CSSProperties = { fontFamily: token.fontFamilyCode };
  const pathInputStyles: { input: CSSProperties } = { input: codeFontStyle };
  const patternTextAreaStyles: { textarea: CSSProperties } = { textarea: codeFontStyle };

  const renderSection = (titleText: string, description?: ReactNode) => (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{titleText}</h3>
      {description && <Text style={sectionDescriptionStyle}>{description}</Text>}
    </div>
  );

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 260, flex: '1 1 320px' }}>
        {footerStatus && (
          <div style={footerStatusStyle} role="status" aria-live="polite">
            <span style={{ color: footerStatusIconColor, fontSize: 13, display: 'inline-flex', flex: '0 0 auto' }}>
              {footerStatus.icon}
            </span>
            <Text strong style={{ fontSize: 11, color: token.colorText, whiteSpace: 'nowrap' }}>
              {footerStatus.label}
            </Text>
            <Text style={{ fontSize: 11, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {footerStatus.message}
            </Text>
          </div>
        )}
      </div>
      <Space align="center">
        {!isNewSource && (
          <Button
            size="small"
            type="default"
            icon={saveMutation.isPending ? <SyncOutlined spin /> : <SaveOutlined />}
            onClick={() => void handleSaveConfig()}
            disabled={anyRunning || saveMutation.isPending || !config || !localDirty}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save Config'}
          </Button>
        )}
        {isNewSource ? (
          <Button
            size="small"
            onClick={() => void handleSaveAndPlace()}
            disabled={anyRunning || saveMutation.isPending || !config}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save — Place on Canvas'}
          </Button>
        ) : (
          <Button size="small" onClick={handleCloseRequest}>
            Close
          </Button>
        )}
      </Space>
    </div>
  );

  return (
    <Modal
      title={title}
      open={!!source}
      onCancel={handleCloseRequest}
      width={900}
      className="importer-config-modal"
      destroyOnClose
      footer={footer}
      styles={{
        mask: {
          backgroundColor: 'rgba(15, 23, 42, 0.48)',
          backdropFilter: 'blur(1px)',
        },
        header: {
          margin: 0,
          padding: '14px 24px 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        },
        body: {
          maxHeight: 'calc(84vh - 104px)',
          overflowY: 'auto',
          padding: '14px 24px 18px',
          background: token.colorBgContainer,
        },
        footer: {
          marginTop: 0,
          padding: '8px 24px',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
        },
      }}
    >
      {isLoading && <Spin style={{ display: 'block', margin: '40px auto' }} />}
      {loadError && <Alert type="error" message={String(loadError)} />}
      {saveError && (
        <Alert type="error" message={saveError} style={noticeStyle}
          closable onClose={() => setSaveError(null)} />
      )}
      {config && (
        <>
        <Form
          form={form}
          layout="vertical"
          size="small"
          onValuesChange={markUnsaved}
          disabled={formDisabled}
          style={{ marginTop: saveError ? 6 : 0 }}
        >
          <Form.Item name="sourceType" hidden><Input /></Form.Item>
          <Form.Item name="configPath" hidden><Input /></Form.Item>

          {renderSection('Identity', 'Name the source clearly; the namespace stays fixed after import creation.')}
          <div style={twoColumnGridStyle}>
            <Form.Item
              name="namespace"
              label={
                <Space size={4}>
                  Namespace
                  <Tooltip title="Fixed at import time and cannot be changed.">
                    <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
                  </Tooltip>
                </Space>
              }
            >
              <Input disabled />
            </Form.Item>
            <Form.Item label="Display Name" name="sourceName"><Input autoFocus /></Form.Item>
          </div>

          {showArxmlConfig && (
            <>
              {renderSection('Source Files', 'Choose the folder holding the ARXML files and control which of them are scanned.')}
              <div style={fieldGroupStyle}>
                <Form.Item label={pathFieldLabel('Source Directory')} name="projectDir" getValueFromEvent={normalizePathValue('projectDir')} rules={[{ required: true, message: 'Select the directory holding the ARXML source files' }]} extra={pathConversionNotice('projectDir')}>
                  <Input placeholder="../sources/arxml or an absolute path"
                    styles={pathInputStyles}
                    addonAfter={
                      <Tooltip title="Browse for folder">
                        <FolderOpenOutlined style={browseIconStyle} onClick={() => void browseForDirectory('projectDir')} />
                      </Tooltip>
                    }
                  />
                </Form.Item>
                <Form.Item
                  label="Include Patterns"
                  name="filesInclude"
                  getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                  getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
                >
                  <Input.TextArea rows={2} placeholder="**/*.arxml" styles={patternTextAreaStyles} />
                </Form.Item>
                <Form.Item
                  label="Exclude Patterns"
                  name="filesExclude"
                  getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                  getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
                >
                  <Input.TextArea rows={2} placeholder="ECUC/**" styles={patternTextAreaStyles} />
                </Form.Item>
              </div>
              {renderSection('Element Categories', 'Select the model content included in this import.')}
              <Form.Item name="elements" noStyle>
                <div style={categoryGridStyle}>
                  {Object.keys(ELEMENT_LABELS).map((key) => (
                    <div key={key} style={categoryRowStyle}>
                      <Text style={{ fontSize: 12 }}>{ELEMENT_LABELS[key]}</Text>
                      <Form.Item name={['elements', key]} valuePropName="checked" noStyle>
                        <Switch size="small" />
                      </Form.Item>
                    </div>
                  ))}
                </div>
              </Form.Item>
            </>
          )}

          {showSysmlConfig && (
            <>
              {renderSection('Source Files', 'Choose the SysML JSON export folder and scan patterns.')}
              <Form.Item
                label={pathFieldLabel('Source Directory')}
                name="projectDir"
                getValueFromEvent={normalizePathValue('projectDir')}
                rules={[{ required: true, message: 'Select the folder containing SysML JSON files' }]}
                extra={<>
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Folder containing exported SysML v2 JSON files. Absolute, or relative to the workspace root.</Text>
                  {pathConversionNotice('projectDir') && <><br />{pathConversionNotice('projectDir')}</>}
                </>}
              >
                <Input
                  placeholder="../sources/sysml or an absolute path"
                  styles={pathInputStyles}
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={browseIconStyle} onClick={() => void browseForDirectory('projectDir')} />
                    </Tooltip>
                  }
                />
              </Form.Item>
              <Form.Item
                label="Include Patterns"
                name="filesInclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/*.json" styles={patternTextAreaStyles} />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/node_modules/**" styles={patternTextAreaStyles} />
              </Form.Item>
            </>
          )}

          {showSphinxNeedsConfig && (
            <>
              {renderSection('Needs Source', 'Configure direct or pattern-based discovery for Sphinx Needs data.')}
              <Form.Item
                label={pathFieldLabel('Needs File')}
                name="needsFile"
                getValueFromEvent={normalizePathValue('needsFile')}
                extra={<>
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Path to <code>needs.json</code> (absolute, or relative to the workspace root). Leave blank to discover via glob patterns below.</Text>
                  {pathConversionNotice('needsFile') && <><br />{pathConversionNotice('needsFile')}</>}
                </>}
              >
                <Input placeholder="../docs/_build/needs.json" styles={pathInputStyles} />
              </Form.Item>
              <Form.Item
                label={pathFieldLabel('Source Directory')}
                name="projectDir"
                getValueFromEvent={normalizePathValue('projectDir')}
                extra={<>
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Base folder for glob-based <code>needs.json</code> discovery (used when Needs File is blank). Absolute, or relative to the workspace root.</Text>
                  {pathConversionNotice('projectDir') && <><br />{pathConversionNotice('projectDir')}</>}
                </>}
              >
                <Input
                  placeholder="../docs/_build or an absolute path"
                  styles={pathInputStyles}
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={browseIconStyle} onClick={() => void browseForDirectory('projectDir')} />
                    </Tooltip>
                  }
                />
              </Form.Item>
              <Form.Item
                label="Include Patterns"
                name="filesInclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/needs.json" styles={patternTextAreaStyles} />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/node_modules/**" styles={patternTextAreaStyles} />
              </Form.Item>
            </>
          )}

          {showSysmlTextualConfig && (
            <>
              {renderSection('Source Files', 'Choose the folder holding the .sysml files and control the recursive scan.')}
              <Form.Item
                label={pathFieldLabel('Source Directory')}
                name="projectDir"
                getValueFromEvent={normalizePathValue('projectDir')}
                rules={[{ required: true, message: 'Select the folder containing .sysml files' }]}
                extra={<>
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Folder scanned recursively for <code>*.sysml</code> files. Absolute, or relative to the workspace root.</Text>
                  {pathConversionNotice('projectDir') && <><br />{pathConversionNotice('projectDir')}</>}
                </>}
              >
                <Input
                  placeholder="../sources/sysml or an absolute path"
                  styles={pathInputStyles}
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={browseIconStyle} onClick={() => void browseForDirectory('projectDir')} />
                    </Tooltip>
                  }
                />
              </Form.Item>
              <Form.Item
                label="Include Patterns"
                name="filesInclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/*.sysml" styles={patternTextAreaStyles} />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/node_modules/**" styles={patternTextAreaStyles} />
              </Form.Item>
              {renderSection('Element Categories', 'Select the SysML element groups included in this import.')}
              <Form.Item name="elements" noStyle>
                <div style={categoryGridStyle}>
                  {([
                    ['structure',   'Structural Elements'],
                    ['behavior',    'Behavior / Actions'],
                    ['features',    'Features'],
                    ['memberships', 'Memberships'],
                    ['imports',     'Imports'],
                  ] as [string, string][]).map(([key, label]) => (
                    <div key={key} style={categoryRowStyle}>
                      <Text style={{ fontSize: 12 }}>{label}</Text>
                      <Form.Item name={['elements', key]} valuePropName="checked" noStyle>
                        <Switch size="small" />
                      </Form.Item>
                    </div>
                  ))}
                </div>
              </Form.Item>
            </>
          )}

          {!showArxmlConfig && !showSysmlConfig && !showSphinxNeedsConfig && !showSysmlTextualConfig && (
            <Alert
              type="info"
              showIcon
              message="Generic importer configuration"
              description="This importer exposes only the shared identity fields in the current UI."
            />
          )}
        </Form>

        {/* Read-only provenance — collapsed by default so it stays out of the
            way of the fields the user actually edits. Rendered outside the
            <Form> so the toggle keeps working while an import is running. */}
        <div style={{ marginTop: 16 }}>
          <Button
            type="text"
            size="small"
            onClick={() => setDetailsOpen((v) => !v)}
            icon={detailsOpen
              ? <DownOutlined style={{ fontSize: 10 }} />
              : <RightOutlined style={{ fontSize: 10 }} />}
            style={{ paddingInline: 0, fontSize: 12, color: token.colorTextTertiary }}
            aria-expanded={detailsOpen}
          >
            Details
          </Button>
          {detailsOpen && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr)',
                columnGap: 16,
                rowGap: 6,
                marginTop: 6,
                paddingInlineStart: 2,
              }}
            >
              <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Source Type</Text>
              <Text style={{ fontSize: 12, color: token.colorTextSecondary }}>
                {watchedSourceType || 'unknown'}
              </Text>
              {config.configPath && (
                <>
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Config File</Text>
                  <Text
                    style={{ fontSize: 12, color: token.colorTextSecondary }}
                    ellipsis={{ tooltip: config.configPath }}
                    copyable={{ text: config.configPath, tooltips: ['Copy path', 'Copied'] }}
                  >
                    {config.configPath}
                  </Text>
                </>
              )}
            </div>
          )}
        </div>
        </>
      )}
    </Modal>
  );
}
