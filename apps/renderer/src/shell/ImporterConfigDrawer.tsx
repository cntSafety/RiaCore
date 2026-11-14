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
﻿import { Drawer, Form, Input, Switch, Space, Button, Spin, Alert, Divider, Typography, Tooltip, theme } from 'antd';
import { PlayCircleOutlined, SyncOutlined, InfoCircleOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import type { ImportConfigView, ImportSourceInfo } from '@riacore/app-contracts';
import { api } from '../api/riacore';
import {
  useRunImportSourceMutation,
  useSaveImportConfigMutation,
} from '../hooks/useRiacoreMutations';
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
const isCgraphSource = (sourceType?: string) => sourceType === 'cgraph_graph' || sourceType === 'cgraph';

/**
 * CGraph element groups, in the order they build on each other: structure, then
 * the symbols inside it, then the facts about those symbols.
 *
 * Each label is paired with why a user would turn it off, because the groups are
 * not equally cheap — the type layer dominates the graph on a real corpus, and
 * parameters multiply node count for signature detail that most questions do not
 * need. Turning a group off also removes the relationships that depend on it.
 */
const CGRAPH_ELEMENT_FIELDS: Array<[string, string, string]> = [
  ['structure',    'Components & Files',   'Directory groupings, files and their include graph.'],
  ['symbols',      'Functions & Variables', 'Definitions, declarations, and symbols defined outside the analysed corpus.'],
  ['call_graph',   'Call Graph',            'Calls, out-of-corpus calls, function addresses taken without calling, and argument bindings.'],
  ['data_access',  'Data Access',           'Reads, writes and read-modify-writes of the objects an expression names.'],
  ['types',        'Named Types',           'Records, enums, typedefs and builtins. The change-impact layer, and the bulk of the graph.'],
  ['parameters',   'Parameters & Returns',  'Function ports: one node per parameter and return value. Endpoints of argument bindings and data flow.'],
  ['members',      'Record Members',        'One node per struct or union field. Needs Named Types. What a dereference through a field is attributed to.'],
  ['registration', 'Registration',          'Callback addresses and object references stored in initialisers.'],
  ['asm_sites',    'Inline Assembly',       'Statements whose effects static analysis cannot see.'],
  ['indirect_calls', 'Indirect Call Sites', 'One node per call through a function pointer, and where the pointer is read from.'],
  ['value_analysis', 'Value Analysis',      'May-read, may-write, dispatch targets, data flow and hardware regions from the value analysis. Off gives an AST-only graph.'],
];

interface Props {
  source: ImportSourceInfo | null;
  workingDir: string;
  onClose: () => void;
  onImportComplete?: (runId: string) => void;
}

export function ImporterConfigDrawer({ source, workingDir, onClose, onImportComplete }: Props) {
  const { token } = useToken();
  const [form] = Form.useForm<ImportConfigView>();
  const [runError, setRunError] = useState<string | null>(null);
  const [runSuccess, setRunSuccess] = useState(false);
  const [localDirty, setLocalDirty] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: activeImport } = useActiveImport();
  const sourceId = source?.sourceId ?? null;
  const sourceName = source?.name ?? '';
  const running = sourceId !== null && activeImport?.sourceId === sourceId;
  const anyRunning = activeImport !== null && activeImport !== undefined;
  const watchedSourceType = Form.useWatch('sourceType', form) ?? source?.sourceType ?? '';
  const showArxmlConfig = isArxmlSource(watchedSourceType);
  const showSysmlConfig = isSysmlSource(watchedSourceType);
  const showSphinxNeedsConfig = isSphinxNeedsSource(watchedSourceType);
  const showSysmlTextualConfig = isSysmlTextualSource(watchedSourceType);
  const showCgraphConfig = isCgraphSource(watchedSourceType);

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
    setRunError(null);
    setRunSuccess(false);
    setLocalDirty(false);
  }, [form, sourceId, workingDir]);

  useEffect(() => {
    setLocalDirty(Boolean(source?.configDirty));
  }, [sourceId, source?.configDirty]);

  useEffect(() => {
    if (config) {
      form.setFieldsValue({
        ...config,
        filesInclude: config.filesInclude ?? [],
        filesExclude: config.filesExclude ?? [],
        elements: config.elements ?? {},
      });
    }
  }, [config, form]);

  useEffect(() => {
    if (!sourceId && saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [sourceId]);

  const saveMutation = useSaveImportConfigMutation(workingDir || 'no-workspace');

  const browseForDirectory = async (field: 'projectDir' | 'scanResultDir') => {
    const dir = await api.dialog.openDirectory();
    if (dir) {
      form.setFieldValue(field, dir);
      scheduleAutoSave();
    }
  };

  const scheduleAutoSave = () => {
    if (!sourceId) return;
    setLocalDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      form.validateFields({ validateOnly: true })
        .then(() => {
          if (!sourceId) return;
          saveMutation.mutate({ values: form.getFieldsValue() as ImportConfigView, sourceId });
        })
        .catch(() => {});
    }, 600);
  };

  const runMutation = useRunImportSourceMutation(workingDir);

  const handleRun = () => {
    if (!sourceId) {
      setRunError('No import source selected. Please reopen the importer drawer.');
      return;
    }

    if (saveTimer.current) clearTimeout(saveTimer.current);
    setRunError(null);
    setRunSuccess(false);
    form.validateFields()
      .then(async (values) => {
        try {
          await saveMutation.mutateAsync({ values, sourceId });
          const result = await runMutation.mutateAsync({ sourceId, sourceName });
          setLocalDirty(false);
          setRunSuccess(true);
          onImportComplete?.(result.runId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setRunError(msg);
          setRunSuccess(false);
        }
      })
      .catch(() => {});
  };

  const hasCompletedImport = source?.lastRunStatus === 'completed';
  const showDirtyNotice = !runError && hasCompletedImport && (localDirty || source?.configDirty);
  const showSyncedNotice = !runError && hasCompletedImport && !showDirtyNotice;

  return (
    <Drawer
      title={source ? `Configure — ${source.name}` : 'Configure Importer'}
      placement="right"
      width={480}
      open={!!source}
      onClose={onClose}
      styles={{ body: { padding: '16px 20px' } }}
      extra={
        <Space>
          <Tooltip title="Changes are saved directly to the DB and marked dirty until you run the import again.">
            <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 14, cursor: 'default' }} />
          </Tooltip>
          <Button size="small" type="primary"
            icon={running ? <SyncOutlined spin /> : <PlayCircleOutlined />}
            onClick={handleRun} disabled={anyRunning}
          >
            {running ? 'Running...' : anyRunning ? 'Import in progress' : 'Run Import'}
          </Button>
        </Space>
      }
    >
      {isLoading && <Spin style={{ display: 'block', margin: '40px auto' }} />}
      {loadError && <Alert type="error" message={String(loadError)} />}
      {runError && (
        <Alert type="error" message={runError} style={{ marginBottom: 12 }}
          closable onClose={() => setRunError(null)} />
      )}
      {showDirtyNotice && (
        <Alert
          type="warning"
          showIcon
          message={saveMutation.isPending
            ? 'Saving changes to the DB. Re-import will be required to apply them to the namespace data.'
            : 'Configuration changed in the DB. Re-import is required to apply it to the namespace data.'}
          style={{ marginBottom: 12 }}
        />
      )}
      {showSyncedNotice && (
        <Alert
          type="success"
          showIcon
          message="Config and imported namespace are in sync."
          style={{ marginBottom: 12 }}
        />
      )}
      {runSuccess && (
        <Alert type="success" message="Import completed successfully."
          style={{ marginBottom: 12 }} closable onClose={() => setRunSuccess(false)} />
      )}
      {config && (
        <Form form={form} layout="vertical" size="small" onValuesChange={scheduleAutoSave} disabled={anyRunning}>
          <Form.Item name="sourceType" hidden><Input /></Form.Item>
          <Form.Item name="configPath" hidden><Input /></Form.Item>

          <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Identity</Divider>
          <Form.Item label="Namespace" name="namespace"
            extra={<Text style={{ fontSize: 11, color: token.colorTextTertiary }}>The namespace is fixed at import time and cannot be changed.</Text>}
          >
            <Input disabled />
          </Form.Item>
          <Form.Item label="Display Name" name="sourceName"><Input /></Form.Item>
          <Form.Item label="Source Type">
            <Text style={{ fontSize: 12, color: token.colorTextSecondary }}>{watchedSourceType || 'unknown'}</Text>
          </Form.Item>
          {config.configPath && (
            <Form.Item label="Config File">
              <Text style={{ fontSize: 12, color: token.colorTextSecondary, wordBreak: 'break-all' }}>{config.configPath}</Text>
            </Form.Item>
          )}

          {showArxmlConfig && (
            <>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Source Files</Divider>
              <Form.Item label="Project Directory" name="projectDir" rules={[{ required: true, message: 'Select the source project directory' }]}>
                <Input placeholder="Absolute path to source files"
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={{ cursor: 'pointer' }} onClick={() => void browseForDirectory('projectDir')} />
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
                <Input.TextArea rows={2} placeholder="**/*.arxml" />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="ECUC/**" />
              </Form.Item>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Element Categories</Divider>
              <Form.Item name="elements" noStyle>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                  {Object.keys(ELEMENT_LABELS).map((key) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Source Files</Divider>
              <Form.Item
                label="Project Directory"
                name="projectDir"
                rules={[{ required: true, message: 'Select the folder containing SysML JSON files' }]}
                extra={<Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Folder containing exported SysML v2 JSON files.</Text>}
              >
                <Input
                  placeholder="Absolute path to SysML JSON files"
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={{ cursor: 'pointer' }} onClick={() => void browseForDirectory('projectDir')} />
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
                <Input.TextArea rows={2} placeholder="**/*.json" />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/node_modules/**" />
              </Form.Item>
            </>
          )}

          {showSphinxNeedsConfig && (
            <>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Needs Source</Divider>
              <Form.Item
                label="Needs File"
                name="needsFile"
                extra={<Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Path to <code>needs.json</code> (absolute or relative to config file). Leave blank to discover via glob patterns below.</Text>}
              >
                <Input placeholder="./needs.json" />
              </Form.Item>
              <Form.Item
                label="Project Directory"
                name="projectDir"
                extra={<Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Base folder for glob-based <code>needs.json</code> discovery (used when Needs File is blank).</Text>}
              >
                <Input
                  placeholder="Absolute path to project root"
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={{ cursor: 'pointer' }} onClick={() => void browseForDirectory('projectDir')} />
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
                <Input.TextArea rows={2} placeholder="**/needs.json" />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/node_modules/**" />
              </Form.Item>
            </>
          )}

          {showSysmlTextualConfig && (
            <>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Source Files</Divider>
              <Form.Item
                label="SysML Root Directory"
                name="projectDir"
                rules={[{ required: true, message: 'Select the folder containing .sysml files' }]}
                extra={<Text style={{ fontSize: 11, color: token.colorTextTertiary }}>Folder scanned recursively for <code>*.sysml</code> files.</Text>}
              >
                <Input
                  placeholder="Absolute path to SysML project root"
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={{ cursor: 'pointer' }} onClick={() => void browseForDirectory('projectDir')} />
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
                <Input.TextArea rows={2} placeholder="**/*.sysml" />
              </Form.Item>
              <Form.Item
                label="Exclude Patterns"
                name="filesExclude"
                getValueFromEvent={(e: React.ChangeEvent<HTMLTextAreaElement>) => e.target.value.split('\n').filter(Boolean)}
                getValueProps={(v: string[]) => ({ value: Array.isArray(v) ? v.join('\n') : '' })}
              >
                <Input.TextArea rows={2} placeholder="**/node_modules/**" />
              </Form.Item>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Element Categories</Divider>
              <Form.Item name="elements" noStyle>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                  {([ 
                    ['structure',  'Structural Elements'],
                    ['behavior',   'Behavior / Actions'],
                    ['features',   'Features'],
                    ['memberships','Memberships'],
                    ['imports',    'Imports'],
                  ] as [string, string][]).map(([key, label]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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

          {showCgraphConfig && (
            <>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Generator Output</Divider>
              <Form.Item
                label="CGraph Output Directory"
                name="scanResultDir"
                rules={[{ required: true, message: 'Select the CGraph generator output directory' }]}
                extra={(
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>
                    Folder holding <code>manifest.json</code>, <code>nodes/</code> and <code>edges/</code>.
                    The generator runs outside RiaCore; this importer reads what it produced.
                  </Text>
                )}
              >
                <Input
                  placeholder="Path to the generator output directory"
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={{ cursor: 'pointer' }} onClick={() => void browseForDirectory('scanResultDir')} />
                    </Tooltip>
                  }
                />
              </Form.Item>
              <Form.Item
                label="Repository Root"
                name="projectDir"
                extra={(
                  <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>
                    Optional. The root the generator&apos;s paths are relative to — used to open a
                    file from a node, not to find the input.
                  </Text>
                )}
              >
                <Input
                  placeholder="Path to the C repository root"
                  addonAfter={
                    <Tooltip title="Browse for folder">
                      <FolderOpenOutlined style={{ cursor: 'pointer' }} onClick={() => void browseForDirectory('projectDir')} />
                    </Tooltip>
                  }
                />
              </Form.Item>
              <Divider orientationMargin={0} style={{ fontSize: 11, color: token.colorTextTertiary }}>Element Groups</Divider>
              <Form.Item name="elements" noStyle>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {CGRAPH_ELEMENT_FIELDS.map(([key, label, hint]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <Text style={{ fontSize: 12, display: 'block' }}>{label}</Text>
                        <Text style={{ fontSize: 11, color: token.colorTextTertiary }}>{hint}</Text>
                      </div>
                      <Form.Item name={['elements', key]} valuePropName="checked" noStyle>
                        <Switch size="small" />
                      </Form.Item>
                    </div>
                  ))}
                </div>
              </Form.Item>
            </>
          )}

          {!showArxmlConfig && !showSysmlConfig && !showSphinxNeedsConfig && !showSysmlTextualConfig && !showCgraphConfig && (
            <Alert
              type="info"
              showIcon
              message="Generic importer configuration"
              description="This importer exposes only the shared identity fields in the current UI."
            />
          )}
        </Form>
      )}
    </Drawer>
  );
}
