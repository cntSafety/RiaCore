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
 * LlmSettingsDialog — multi-provider LLM configuration modal.
 *
 * Provider selector drives which credential fields are shown:
 *
 *   AWS Bedrock      → Region, Model, Access Key ID, Secret Access Key, Session Token
 *   Anthropic        → Model, API Key
 *   OpenAI           → Model, API Key, Base URL (optional)
 *   Google Vertex    → Project, Location, Model, Service Account JSON
 *
 * Credential fields for the active provider show "(stored — leave blank to keep)"
 * when credentials are already saved. Switching providers shows the new
 * provider's fields immediately; stored credentials for other providers are
 * preserved on disk and restored when the user switches back.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import { MODEL_OPTIONS } from './llmModelOptions';
import { ModelFieldLabel } from './ModelFieldLabel';
import { ConnectionTestResult } from './ConnectionTestResult';
import { ReloadOutlined } from '@ant-design/icons';
import type { LlmProvider, LlmSaveSettingsInput, LlmSettings } from '@riacore/app-contracts';
import { useLlmSettings } from '../../hooks/useLlmSettings';
import { useSaveLlmSettings } from '../../hooks/useSaveLlmSettings';
import { api } from '../../api/riacore';

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

// ── Provider metadata ─────────────────────────────────────────────────────────

const PROVIDER_OPTIONS: { value: LlmProvider; label: string }[] = [
  { value: 'bedrock',        label: 'AWS Bedrock' },
  { value: 'anthropic',      label: 'Anthropic' },
  { value: 'openai',         label: 'OpenAI' },
  { value: 'google-vertex',  label: 'Google Vertex AI' },
  { value: 'ollama',         label: 'Ollama (local)' },
];


const STORED = '(stored — leave blank to keep)';

// ── Form shape ────────────────────────────────────────────────────────────────

interface FormValues {
  provider: LlmProvider;
  model_id: string;
  // Bedrock
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  // Anthropic / OpenAI
  api_key: string;
  // OpenAI extra
  base_url: string;
  // Google Vertex
  project: string;
  location: string;
  service_account_json: string;
  // Ollama
  max_output_tokens: string;
}

function buildInitialValues(settings: LlmSettings | undefined): FormValues {
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

// ── Component ─────────────────────────────────────────────────────────────────

export function LlmSettingsDialog({ open, onClose }: Props) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const settingsQuery = useLlmSettings();
  const saveMutation = useSaveLlmSettings();
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // Track the selected provider so we can show/hide the right fields.
  const [selectedProvider, setSelectedProvider] = useState<LlmProvider>(
    settingsQuery.data?.provider ?? 'bedrock',
  );

  // Ollama: live model list fetched from the local server.
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);

  const fetchOllamaModels = async (baseUrl?: string) => {
    setOllamaModelsLoading(true);
    try {
      const url = (baseUrl?.trim() || 'http://localhost:11434').replace(/\/v1\/?$/, '');
      const res = await fetch(`${url}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name).sort();
      setOllamaModels(names);
      // Auto-select the first model if the current value isn't in the list.
      if (names.length > 0) {
        const current = form.getFieldValue('model_id') as string;
        if (!names.includes(current)) {
          form.setFieldValue('model_id', names[0]);
        }
      }
    } catch {
      setOllamaModels([]);
    } finally {
      setOllamaModelsLoading(false);
    }
  };

  const settings = settingsQuery.data;
  const hasCredentials = settings?.has_credentials === true;

  // A save refetches settings while the dialog stays open. Reset the success
  // message only when opening it, otherwise that refetch erases confirmation.
  useEffect(() => {
    if (open) setSaved(false);
  }, [open]);

  // Re-seed the form whenever the dialog opens or settings change.
  useEffect(() => {
    if (open && settings) {
      const vals = buildInitialValues(settings);
      form.setFieldsValue(vals);
      setDirty(false);
      setSelectedProvider(settings.provider);
      setTestResult(null);
      if (settings.provider === 'ollama') {
        void fetchOllamaModels(settings.base_url);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings, form]);

  const handleProviderChange = (provider: LlmProvider) => {
    setSelectedProvider(provider);
    setTestResult(null);
    // Reset model to the first option for the new provider.
    const firstModel = MODEL_OPTIONS[provider]?.[0]?.value ?? '';
    form.setFieldValue('model_id', firstModel);
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
    let values: FormValues;
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
      setTestResult(null);
      setDirty(false);
      setSaved(true);
      void message.success('LLM settings saved');
    } catch (err) {
      void message.error(
        `Failed to save LLM settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleCancel = () => {
    if (saveMutation.isPending) return;
    onClose();
  };

  // ── Credential field helpers ────────────────────────────────────────────────

  const storedPlaceholder = hasCredentials ? STORED : '';

  const credentialFields = () => {
    switch (selectedProvider) {
      case 'bedrock':
        return (
          <>
            <Form.Item
              label="Region"
              name="region"
              rules={[{ required: true, message: 'Enter an AWS region, e.g. eu-west-1' }]}
            >
              <Input placeholder="eu-west-1" />
            </Form.Item>

            <Form.Item
              label="Access Key ID"
              name="access_key_id"
              extra={hasCredentials ? 'Leave blank to keep the stored Access Key ID.' : undefined}
            >
              <Input placeholder={hasCredentials ? STORED : 'AKIA…'} autoComplete="off" />
            </Form.Item>

            <Form.Item label="Secret Access Key" name="secret_access_key">
              <Input.Password placeholder={storedPlaceholder} autoComplete="new-password" />
            </Form.Item>

            <Form.Item
              label="Session Token"
              name="session_token"
              extra="Optional — only required for temporary STS credentials."
            >
              <Input.Password placeholder={storedPlaceholder} autoComplete="new-password" />
            </Form.Item>
          </>
        );

      case 'anthropic':
        return (
          <Form.Item
            label="API Key"
            name="api_key"
            extra={hasCredentials ? 'Leave blank to keep the stored API key.' : undefined}
          >
            <Input.Password placeholder={hasCredentials ? STORED : 'sk-ant-…'} autoComplete="new-password" />
          </Form.Item>
        );

      case 'openai':
        return (
          <>
            <Form.Item
              label="API Key"
              name="api_key"
              extra={hasCredentials ? 'Leave blank to keep the stored API key.' : undefined}
            >
              <Input.Password placeholder={hasCredentials ? STORED : 'sk-…'} autoComplete="new-password" />
            </Form.Item>

            <Form.Item
              label="Base URL"
              name="base_url"
              extra="Optional — override for Azure OpenAI or compatible endpoints."
            >
              <Input placeholder="https://api.openai.com/v1" autoComplete="off" />
            </Form.Item>
          </>
        );

      case 'google-vertex':
        return (
          <>
            <Form.Item
              label="Project ID"
              name="project"
              rules={[{ required: true, message: 'Enter your Google Cloud project ID' }]}
            >
              <Input placeholder="my-gcp-project" autoComplete="off" />
            </Form.Item>

            <Form.Item
              label="Location"
              name="location"
              rules={[{ required: true, message: 'Enter a GCP location, e.g. us-central1' }]}
            >
              <Input placeholder="us-central1" />
            </Form.Item>

            <Form.Item
              label="Service Account JSON"
              name="service_account_json"
              extra={
                hasCredentials
                  ? 'Leave blank to keep the stored service account.'
                  : 'Paste the full contents of your service account key JSON file.'
              }
            >
              <Input.Password
                placeholder={hasCredentials ? STORED : '{ "type": "service_account", … }'}
                autoComplete="new-password"
              />
            </Form.Item>
          </>
        );

      case 'ollama':
        return (
          <>
            <Form.Item
              label="Server URL"
              name="base_url"
              extra="The base URL of your Ollama server. Defaults to http://localhost:11434/v1"
            >
              <Input
                placeholder="http://localhost:11434/v1"
                autoComplete="off"
                onBlur={(e) => void fetchOllamaModels(e.target.value)}
              />
            </Form.Item>
            <Form.Item
              label="Max output tokens"
              name="max_output_tokens"
              extra="Limit response length to speed up local inference. Leave blank for no limit."
            >
              <Input
                type="number"
                placeholder="e.g. 800"
                min={100}
                max={8192}
                autoComplete="off"
              />
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
              No credentials required — Ollama runs locally. Make sure Ollama is running and
              the model is pulled before starting a review.
            </Text>
          </>
        );
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal
      title="LLM Settings"
      open={open}
      onOk={() => void handleSave()}
      onCancel={handleCancel}
      okText="Save"
      cancelText="Close"
      confirmLoading={saveMutation.isPending}
      okButtonProps={{ disabled: testing }}
      destroyOnHidden
      mask={{ closable: !saveMutation.isPending }}
      width={520}
    >
      {settingsQuery.isLoading ? (
        <Spin size="small" />
      ) : settingsQuery.error ? (
        <Alert
          type="error"
          message="Could not load LLM settings"
          description={
            settingsQuery.error instanceof Error
              ? settingsQuery.error.message
              : String(settingsQuery.error)
          }
          showIcon
          style={{ marginBottom: 12 }}
        />
      ) : (
        <Form
          form={form}
          layout="vertical"
          size="middle"
          disabled={saveMutation.isPending || testing}
          onValuesChange={() => { setDirty(true); setSaved(false); setTestResult(null); }}
          initialValues={buildInitialValues(settings)}
          autoComplete="off"
        >
          {/* Provider selector */}
          <Form.Item
            label="Provider"
            name="provider"
            rules={[{ required: true }]}
          >
            <Select
              options={PROVIDER_OPTIONS}
              onChange={(v) => handleProviderChange(v as LlmProvider)}
            />
          </Form.Item>

          {/* Model selector — live list for Ollama, static suggestions for cloud providers */}
          <Form.Item
            label={<ModelFieldLabel provider={selectedProvider} />}
            name="model_id"
            rules={[{ required: true, message: 'Enter a model id' }]}
          >
            {selectedProvider === 'ollama' ? (
              <Select
                showSearch
                loading={ollamaModelsLoading}
                placeholder={ollamaModelsLoading ? 'Loading models…' : 'Select a pulled model'}
                options={ollamaModels.map((m) => ({ value: m, label: m }))}
                notFoundContent={
                  ollamaModelsLoading ? (
                    <Spin size="small" />
                  ) : (
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

          {/* Provider-specific credential fields */}
          {credentialFields()}

          {/* Test connection */}
          <Form.Item style={{ marginBottom: 0 }}>
            <Space align="center">
              <Button
                onClick={() => void handleTestConnection()}
                loading={testing}
                disabled={dirty || saveMutation.isPending || (selectedProvider !== 'ollama' && !hasCredentials && !saved)}
              >
                Test Connection
              </Button>
              {(dirty || saved || (selectedProvider !== 'ollama' && !hasCredentials)) && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {dirty ? 'Save changes before testing' : saved ? 'Changes saved' : 'Save credentials first'}
                </Text>
              )}
            </Space>
          </Form.Item>

          {testResult && <ConnectionTestResult result={testResult} />}
        </Form>
      )}
    </Modal>
  );
}
