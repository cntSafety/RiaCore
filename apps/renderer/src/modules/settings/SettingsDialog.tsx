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
/**
 * SettingsDialog — the global application Settings dialog, opened from the
 * native File → Settings… menu item.
 *
 * Layout is built for growth: a left-positioned `Tabs` list acts as the
 * settings-category navigation, and each tab's body is an isolated section.
 * Adding a new settings category is a matter of appending one entry to the
 * `SETTINGS_SECTIONS` array — no structural changes required.
 *
 * Current sections:
 *   - "SysML v2 Tree View" — toggles hidden elements in the namespace tree.
 *   - "Imported Requirement Linking" — how the Imported Requirement picker
 *     handles a match whose namespace isn't connected yet.
 *   - "Report Export" — what the generated safety report contains.
 *   - "LLM" — multi-provider LLM configuration (provider, model, credentials).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Typography,
  theme,
} from 'antd';
import { MODEL_OPTIONS } from './llmModelOptions';
import { ModelFieldLabel } from './ModelFieldLabel';
import { ConnectionTestResult } from './ConnectionTestResult';
import { ReloadOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { LlmProvider, LlmSaveSettingsInput, LlmSettings, CrossNsLinkUnconnectedMode } from '@riacore/app-contracts';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useAppSettingsDialogStore } from '../../store/appSettingsDialogStore';
import { useLlmSettings } from '../../hooks/useLlmSettings';
import { useSaveLlmSettings } from '../../hooks/useSaveLlmSettings';
import { useCrossNsLinkSettings } from '../../hooks/useCrossNsLinkSettings';
import { useSaveCrossNsLinkSettings } from '../../hooks/useSaveCrossNsLinkSettings';
import { useExportSettings } from '../../hooks/useExportSettings';
import { useSaveExportSettings } from '../../hooks/useSaveExportSettings';
import { api } from '../../api/riacore';
import './settings.css';

const { Text, Title } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

// ── SysML v2 Tree View section ───────────────────────────────────────────────

function SysmlTreeViewSection() {
  const { token } = theme.useToken();
  const showAllTreeElements = useWorkspaceStore((s) => s.showAllTreeElements);
  const setShowAllTreeElements = useWorkspaceStore((s) => s.setShowAllTreeElements);

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        SysML v2 Tree View
      </Title>
      <Space align="start" size={12} style={{ width: '100%' }}>
        <Switch
          checked={showAllTreeElements}
          onChange={(checked) => setShowAllTreeElements(checked)}
        />
        <div style={{ flex: 1 }}>
          <Text strong>Show all elements</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Show structural/relationship elements that are hidden by default
              (memberships, features, multiplicities, …).
            </Text>
          </div>
        </div>
      </Space>
      <div style={{ marginTop: 12, color: token.colorTextTertiary, fontSize: 12 }}>
        Changes apply immediately.
      </div>
    </div>
  );
}

// ── Imported Requirement Linking section ─────────────────────────────────────

function CrossNsLinkingSection() {
  const { token } = theme.useToken();
  const { message } = AntdApp.useApp();
  const settingsQuery = useCrossNsLinkSettings();
  const saveMutation = useSaveCrossNsLinkSettings();
  const mode: CrossNsLinkUnconnectedMode = settingsQuery.data?.unconnectedNamespaceMode ?? 'prompt';

  const handleChange = (next: CrossNsLinkUnconnectedMode) => {
    saveMutation.mutate({ unconnectedNamespaceMode: next }, {
      onError: (err) => message.error(String(err?.message ?? 'Failed to save setting')),
    });
  };

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        Imported Requirement Linking
      </Title>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Choose what happens when linking a malfunction to an imported requirement
        whose namespace isn't connected to the current analysis yet.
      </Text>
      <Radio.Group
        value={mode}
        onChange={(e) => handleChange(e.target.value)}
        disabled={settingsQuery.isLoading || saveMutation.isPending}
        style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <Radio value="prompt" style={{ whiteSpace: 'normal' }}>
          <Text strong>Ask to connect (recommended)</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The search shows every matching requirement. Selecting one from an
              unconnected namespace asks whether to connect the namespaces and
              create the link together — declining creates neither.
            </Text>
          </div>
        </Radio>
        <Radio value="restrict" style={{ whiteSpace: 'normal' }}>
          <Text strong>Only show already-linkable requirements</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The search only shows requirements from namespaces already
              connected to the current analysis, so every visible result links
              immediately without prompting.
            </Text>
          </div>
        </Radio>
      </Radio.Group>
      <div style={{ marginTop: 12, color: token.colorTextTertiary, fontSize: 12 }}>
        Changes apply immediately.
      </div>
    </div>
  );
}

// ── Report Export section ────────────────────────────────────────────────────

function ReportExportSection() {
  const { token } = theme.useToken();
  const { message } = AntdApp.useApp();
  const settingsQuery = useExportSettings();
  const saveMutation = useSaveExportSettings();
  const includeRiskRatings = settingsQuery.data?.includeRiskRatings ?? true;

  const handleChange = (checked: boolean) => {
    saveMutation.mutate({ includeRiskRatings: checked }, {
      onError: (err) => message.error(String(err?.message ?? 'Failed to save setting')),
    });
  };

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        Report Export
      </Title>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Controls what the generated safety report (.rst / Sphinx-Needs) contains.
      </Text>
      <Space align="start" size={12} style={{ width: '100%', marginTop: 12 }}>
        <Switch
          checked={includeRiskRatings}
          disabled={settingsQuery.isLoading || saveMutation.isPending}
          onChange={handleChange}
        />
        <div style={{ flex: 1 }}>
          <Text strong>Include ratings in export</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Write the semi-quantitative risk rating — Severity, Occurrence,
              Detection and RPN — into the exported report. Switch this off for
              projects that do not maintain those values: the malfunction Risk
              Rating line, the "Max Risk Rating" column of the status table and
              the risk-rating rows of the per-component statistics are then all
              omitted. A malfunction's risk-rating note is still exported.
            </Text>
          </div>
        </div>
      </Space>
      <div style={{ marginTop: 12, color: token.colorTextTertiary, fontSize: 12 }}>
        Applies to the next export.
      </div>
    </div>
  );
}

// ── LLM settings section ─────────────────────────────────────────────────────

const PROVIDER_OPTIONS: { value: LlmProvider; label: string }[] = [
  { value: 'bedrock',       label: 'AWS Bedrock' },
  { value: 'anthropic',     label: 'Anthropic' },
  { value: 'openai',        label: 'OpenAI' },
  { value: 'google-vertex', label: 'Google Vertex AI' },
  { value: 'ollama',        label: 'Ollama (local)' },
];


const STORED = '(stored — leave blank to keep)';

interface LlmFormValues {
  provider: LlmProvider;
  model_id: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  api_key: string;
  base_url: string;
  project: string;
  location: string;
  service_account_json: string;
  max_output_tokens: string;
}

function buildLlmInitialValues(settings: LlmSettings | undefined): LlmFormValues {
  return {
    provider:             (settings?.provider ?? 'bedrock') as LlmProvider,
    model_id:             settings?.model_id ?? 'eu.anthropic.claude-sonnet-4-6',
    region:               settings?.region ?? 'eu-west-1',
    access_key_id:        '',
    secret_access_key:    '',
    session_token:        '',
    api_key:              '',
    base_url:             settings?.base_url ?? '',
    project:              settings?.project ?? '',
    location:             settings?.region ?? 'us-central1',
    service_account_json: '',
    max_output_tokens:    settings?.max_output_tokens ? String(settings.max_output_tokens) : '',
  };
}

export function LlmSection() {
  const { token } = theme.useToken();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<LlmFormValues>();
  const settingsQuery = useLlmSettings();
  const saveMutation = useSaveLlmSettings();
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<LlmProvider>(
    settingsQuery.data?.provider ?? 'bedrock',
  );
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);

  const settings = settingsQuery.data;
  const hasCredentials = settings?.has_credentials === true;

  const fetchOllamaModels = async (baseUrl?: string) => {
    setOllamaModelsLoading(true);
    try {
      const url = (baseUrl?.trim() || 'http://localhost:11434').replace(/\/v1\/?$/, '');
      const res = await fetch(`${url}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name).sort();
      setOllamaModels(names);
      if (names.length > 0) {
        const current = form.getFieldValue('model_id') as string;
        if (!names.includes(current)) form.setFieldValue('model_id', names[0]);
      }
    } catch {
      setOllamaModels([]);
    } finally {
      setOllamaModelsLoading(false);
    }
  };

  // Seed form when settings load.
  useEffect(() => {
    if (settings) {
      form.setFieldsValue(buildLlmInitialValues(settings));
      setDirty(false);
      setSelectedProvider(settings.provider);
      setTestResult(null);
      if (settings.provider === 'ollama') void fetchOllamaModels(settings.base_url);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, form]);

  const handleProviderChange = (provider: LlmProvider) => {
    setSelectedProvider(provider);
    setTestResult(null);
    form.setFieldValue('model_id', MODEL_OPTIONS[provider]?.[0]?.value ?? '');
    if (provider === 'ollama') {
      const baseUrl = form.getFieldValue('base_url') as string | undefined;
      void fetchOllamaModels(baseUrl);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.llm.testConnection();
      setTestResult({ ok: result.ok, error: result.error });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    let values: LlmFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    const payload: LlmSaveSettingsInput = {
      provider: values.provider,
      model_id: values.model_id.trim(),
    };

    switch (values.provider) {
      case 'bedrock':
        payload.region = values.region.trim();
        payload.access_key_id = values.access_key_id.trim();
        payload.secret_access_key = values.secret_access_key;
        payload.session_token = values.session_token.length > 0 ? values.session_token : undefined;
        break;
      case 'anthropic':
        payload.api_key = values.api_key;
        break;
      case 'openai':
        payload.api_key = values.api_key;
        if (values.base_url.trim()) payload.base_url = values.base_url.trim();
        break;
      case 'google-vertex':
        payload.project = values.project.trim();
        payload.region = values.location.trim();
        payload.service_account_json = values.service_account_json;
        break;
      case 'ollama':
        if (values.base_url.trim()) payload.base_url = values.base_url.trim();
        if (values.max_output_tokens.trim()) {
          const n = parseInt(values.max_output_tokens, 10);
          if (!isNaN(n) && n > 0) payload.max_output_tokens = n;
        }
        break;
    }

    try {
      await saveMutation.mutateAsync(payload);
      setDirty(false);
      setSaved(true);
      setTestResult(null);
      void message.success('LLM settings saved');
    } catch (err) {
      void message.error(
        `Failed to save LLM settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const storedPlaceholder = hasCredentials ? STORED : '';

  const credentialFields = () => {
    switch (selectedProvider) {
      case 'bedrock':
        return (
          <>
            <Form.Item label="Region" name="region" rules={[{ required: true, message: 'Enter an AWS region, e.g. eu-west-1' }]}>
              <Input placeholder="eu-west-1" />
            </Form.Item>
            <Form.Item label="Access Key ID" name="access_key_id" extra={hasCredentials ? 'Leave blank to keep the stored Access Key ID.' : undefined}>
              <Input placeholder={hasCredentials ? STORED : 'AKIA…'} autoComplete="off" />
            </Form.Item>
            <Form.Item label="Secret Access Key" name="secret_access_key">
              <Input.Password placeholder={storedPlaceholder} autoComplete="new-password" />
            </Form.Item>
            <Form.Item label="Session Token" name="session_token" extra="Optional — only required for temporary STS credentials.">
              <Input.Password placeholder={storedPlaceholder} autoComplete="new-password" />
            </Form.Item>
          </>
        );
      case 'anthropic':
        return (
          <Form.Item label="API Key" name="api_key" extra={hasCredentials ? 'Leave blank to keep the stored API key.' : undefined}>
            <Input.Password placeholder={hasCredentials ? STORED : 'sk-ant-…'} autoComplete="new-password" />
          </Form.Item>
        );
      case 'openai':
        return (
          <>
            <Form.Item label="API Key" name="api_key" extra={hasCredentials ? 'Leave blank to keep the stored API key.' : undefined}>
              <Input.Password placeholder={hasCredentials ? STORED : 'sk-…'} autoComplete="new-password" />
            </Form.Item>
            <Form.Item label="Base URL" name="base_url" extra="Optional — override for Azure OpenAI or compatible endpoints.">
              <Input placeholder="https://api.openai.com/v1" autoComplete="off" />
            </Form.Item>
          </>
        );
      case 'google-vertex':
        return (
          <>
            <Form.Item label="Project ID" name="project" rules={[{ required: true, message: 'Enter your Google Cloud project ID' }]}>
              <Input placeholder="my-gcp-project" autoComplete="off" />
            </Form.Item>
            <Form.Item label="Location" name="location" rules={[{ required: true, message: 'Enter a GCP location, e.g. us-central1' }]}>
              <Input placeholder="us-central1" />
            </Form.Item>
            <Form.Item label="Service Account JSON" name="service_account_json" extra={hasCredentials ? 'Leave blank to keep the stored service account.' : 'Paste the full contents of your service account key JSON file.'}>
              <Input.Password placeholder={hasCredentials ? STORED : '{ "type": "service_account", … }'} autoComplete="new-password" />
            </Form.Item>
          </>
        );
      case 'ollama':
        return (
          <>
            <Form.Item label="Server URL" name="base_url" extra="The base URL of your Ollama server. Defaults to http://localhost:11434/v1">
              <Input placeholder="http://localhost:11434/v1" autoComplete="off" onBlur={(e) => void fetchOllamaModels(e.target.value)} />
            </Form.Item>
            <Form.Item label="Max output tokens" name="max_output_tokens" extra="Limit response length to speed up local inference. Leave blank for no limit.">
              <Input type="number" placeholder="e.g. 800" min={100} max={8192} autoComplete="off" />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
              No credentials required — Ollama runs locally. Make sure Ollama is running and the model is pulled before starting a review.
            </Text>
          </>
        );
    }
  };

  if (settingsQuery.isLoading) return <Spin size="small" />;
  if (settingsQuery.error) return (
    <Alert
      type="error"
      message="Could not load LLM settings"
      description={settingsQuery.error instanceof Error ? settingsQuery.error.message : String(settingsQuery.error)}
      showIcon
    />
  );

  return (
    <div className="llm-settings-section">
      <Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>LLM Configuration</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
        Choose a provider and model, then save and test your connection.
      </Text>
      <Form
        form={form}
        layout="vertical"
        size="middle"
        disabled={saveMutation.isPending || testing}
        onValuesChange={() => { setDirty(true); setSaved(false); setTestResult(null); }}
        initialValues={buildLlmInitialValues(settings)}
        autoComplete="off"
      >
        <Form.Item label="Provider" name="provider" rules={[{ required: true }]}>
          <Select options={PROVIDER_OPTIONS} onChange={(v) => handleProviderChange(v as LlmProvider)} />
        </Form.Item>

        <Form.Item label={<ModelFieldLabel provider={selectedProvider} />} name="model_id" rules={[{ required: true, message: 'Enter a model id' }]}>
          {selectedProvider === 'ollama' ? (
            <Select
              showSearch
              loading={ollamaModelsLoading}
              placeholder={ollamaModelsLoading ? 'Loading models…' : 'Select a pulled model'}
              options={ollamaModels.map((m) => ({ value: m, label: m }))}
              notFoundContent={
                ollamaModelsLoading ? <Spin size="small" /> : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    No models found. Make sure Ollama is running and pull a model first.
                  </Text>
                )
              }
              suffixIcon={
                <ReloadOutlined
                  spin={ollamaModelsLoading}
                  onClick={(e) => {
                    e.stopPropagation();
                    const baseUrl = form.getFieldValue('base_url') as string | undefined;
                    void fetchOllamaModels(baseUrl);
                  }}
                  style={{ cursor: 'pointer' }}
                  title="Refresh model list"
                />
              }
              filterOption={(input, option) =>
                String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          ) : (
            <AutoComplete
              options={MODEL_OPTIONS[selectedProvider] ?? []}
              placeholder={MODEL_OPTIONS[selectedProvider]?.[0]?.value ?? ''}
              filterOption={(input, option) =>
                String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          )}
        </Form.Item>

        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 12 }}>Connection details</Text>
          {credentialFields()}
        </div>

        <div role="group" aria-label="LLM configuration actions" style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 16 }}>
          <Space wrap>
            <Button
              type="primary"
              onClick={() => void handleSave()}
              loading={saveMutation.isPending}
              disabled={testing}
            >
              Save
            </Button>
            <Button
              onClick={() => void handleTestConnection()}
              loading={testing}
              disabled={dirty || saveMutation.isPending || (selectedProvider !== 'ollama' && !hasCredentials && !saved)}
            >
              Test Connection
            </Button>
          </Space>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }} role="status">
            {dirty ? 'Unsaved changes — save before testing.' : saved ? 'Changes saved. Ready to test.' : 'Test Connection uses saved settings.'}
          </Text>
        </div>

        {testResult && <ConnectionTestResult result={testResult} />}
      </Form>
    </div>
  );
}

// ── Section registry ─────────────────────────────────────────────────────────
// Append new categories here — the Tabs layout scales automatically.

interface SettingsSection {
  key: string;
  label: string;
  content: (onClose: () => void) => ReactNode;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'sysml-tree-view',
    label: 'SysML v2 Tree View',
    content: () => <SysmlTreeViewSection />,
  },
  {
    key: 'cross-ns-linking',
    label: 'Imported Requirement Linking',
    content: () => <CrossNsLinkingSection />,
  },
  {
    key: 'report-export',
    label: 'Report Export',
    content: () => <ReportExportSection />,
  },
  {
    key: 'llm',
    label: 'LLM',
    content: () => <LlmSection />,
  },
];

// ── Component ────────────────────────────────────────────────────────────────

export function SettingsDialog({ open, onClose }: Props) {
  const { token } = theme.useToken();
  const activeTabFromStore = useAppSettingsDialogStore((s) => s.activeTab);
  const setActiveTab = useAppSettingsDialogStore((s) => s.setActiveTab);

  // Track the active tab locally; sync from the store when the dialog opens.
  const [activeKey, setActiveKey] = useState(SETTINGS_SECTIONS[0].key);
  const prevOpen = useRef(false);

  useEffect(() => {
    if (open && !prevOpen.current) {
      // Dialog just opened — jump to the requested tab if any.
      setActiveKey(activeTabFromStore ?? SETTINGS_SECTIONS[0].key);
    }
    prevOpen.current = open;
  }, [open, activeTabFromStore]);

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setActiveTab(key);
  };

  return (
    <Modal
      className="riacore-settings-dialog"
      title="Settings"
      open={open}
      onCancel={onClose}
      styles={{ footer: { borderTop: `1px solid ${token.colorBorderSecondary}`, marginTop: 20, paddingTop: 12 } }}
      footer={[
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
      ]}
      width={900}
      destroyOnHidden
    >
      <Tabs
        tabPosition="left"
        activeKey={activeKey}
        onChange={handleTabChange}
        items={SETTINGS_SECTIONS.map((section) => ({
          key: section.key,
          label: section.label,
          children: (
            <div style={{ maxHeight: 'min(620px, 68vh)', overflowY: 'auto', paddingRight: 12, paddingLeft: 8 }}>
              {section.content(onClose)}
            </div>
          ),
        }))}
        style={{ minHeight: 320 }}
      />
    </Modal>
  );
}
