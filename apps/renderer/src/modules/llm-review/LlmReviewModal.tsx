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
 * `LlmReviewModal` — top-level modal that hosts a single LLM safety
 * Review_Run for one Eligible_Element_Node.
 *
 * Responsibilities (task 10.4 of the `llm-component-review` spec):
 *
 * - Reads the Selected_Element name from a *fresh* `useSafetyInstance(nodeId)`
 *   query — never from cached tree-click state. The title shows the name
 *   plus the namespace (Requirement 4.7).
 * - Subtitle is derived from `metadata.review_profile`:
 *   - `sw_arxml`     → "Software safety review"
 *   - `system_sysml` → "SysML safety review"
 *   When the run has not started yet (`metadata` is `null`) the subtitle is
 *   omitted (Requirement 4.7).
 * - Renders the streamed text buffer as plain text. Shows a Cancel button
 *   while `status` is `'starting' | 'streaming'` (Requirement 8.9, 9.1).
 * - Pre-flight gate: when `useLlmSettings().data?.has_credentials === false`,
 *   renders "No LLM credentials configured" plus an "Open Settings" button
 *   instead of the Start button (Requirement 4.8).
 * - Error banner (red) when `status === 'error'`. Adds an "Open Settings"
 *   shortcut when `errorCode === 'no_credentials'` (Requirement 10.8).
 * - "Review cancelled" indicator when `errorCode === 'cancelled'` — the
 *   already-streamed text remains visible up to the cancel point
 *   (Requirement 9.4).
 * - Wires Start / Cancel to {@link useLlmReview}; never invalidates any
 *   TanStack Query key (Requirement 8.12).
 */

import { useState, useEffect, useRef } from 'react';
import { Modal, Alert, Button, Space, Spin, Typography, theme, Tooltip } from 'antd';
import { SettingOutlined, BugOutlined, DownloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LlmDryRunResult, LlmReviewProfile } from '@riacore/app-contracts';
import { useLlmReview } from '../../hooks/useLlmReview';
import { useLlmSettings } from '../../hooks/useLlmSettings';
import { useSafetyInstance } from '../../hooks/useSafetyInstance';
import { useLlmSettingsDialogStore } from '../../store/llmSettingsDialogStore';
import { api } from '../../api/riacore';

const { Text, Title } = Typography;
const { useToken } = theme;

export interface LlmReviewModalProps {
  /** Whether the modal is visible. */
  open: boolean;
  /** Called when the user dismisses the modal (Cancel button on antd Modal, X icon, or programmatic close). */
  onClose: () => void;
  /** `node_id` of the Selected_Element (Eligible_Element_Node). */
  nodeId: number;
  /** Namespace of the Selected_Element. */
  namespace: string;
  /** Optional display name captured at launch time, used until the fresh query resolves. */
  initialElementName?: string;
  /**
   * Active authored safety-analysis metamodel the review was launched from.
   * Selects the review checklist injected into the system prompt.
   */
  reviewMetamodel?: string;
}

function truncateReviewTargetName(name: string, maxLength = 12): string {
  if (name.length <= maxLength) {
    return name;
  }
  if (maxLength <= 3) {
    return name.slice(0, maxLength);
  }
  return `${name.slice(0, maxLength - 3)}...`;
}

/** Map a Review_Profile to the human-readable subtitle shown in the header. */
function subtitleForProfile(profile: LlmReviewProfile): string {
  return profile === 'sw_arxml' ? 'Software safety review' : 'SysML safety review';
}

export function LlmReviewModal({
  open,
  onClose,
  nodeId,
  namespace,
  initialElementName,
  reviewMetamodel,
}: LlmReviewModalProps) {
  const { token } = useToken();

  // Settings query for the pre-flight gate. The `has_credentials` flag is
  // the single source of truth for whether the user can start a run.
  const settingsQuery = useLlmSettings();

  // Fresh element instance — used only for the title display name.
  // Steering rule: never read the name from cached tree-click state.
  const instanceQuery = useSafetyInstance(nodeId);
  const resolvedElementName =
    (instanceQuery.data?.attributes?.has_name as string | undefined) ??
    (instanceQuery.data?.attributes?.element_name as string | undefined) ??
    initialElementName;
  const elementName = resolvedElementName
    ? truncateReviewTargetName(resolvedElementName)
    : `node ${nodeId}`;

  // Drive the run through the React-state-only hook. Never invalidates any
  // TanStack Query cache key.
  const review = useLlmReview({ nodeId, namespace, reviewMetamodel });
  const { status, text, metadata, errorCode, errorMessage, firstTokenAt } = review;

  // Open the LlmSettingsDialog (lifted into a small Zustand slice — see
  // `store/llmSettingsDialogStore.ts`). The dialog is owned by the parent
  // chrome and becomes visible when this store flips to `open: true`.
  const openSettings = useLlmSettingsDialogStore((s) => s.openDialog);

  // ── Dry run state ─────────────────────────────────────────────────────────
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<LlmDryRunResult | null>(null);

  // ── Derived view state ────────────────────────────────────────────────────

  const hasCredentials = settingsQuery.data?.has_credentials === true;
  const settingsLoaded = settingsQuery.isSuccess;
  const isRunning = status === 'starting' || status === 'streaming';
  const isTerminal =
    status === 'done' || status === 'error' || status === 'cancelled';
  const subtitle = metadata ? subtitleForProfile(metadata.review_profile) : null;

  // ── Elapsed-time counter ──────────────────────────────────────────────────
  // Ticks every second while the run is in flight and no text has arrived yet.
  // Once the first token arrives (firstTokenAt is set) we stop ticking and
  // show the TTFT instead.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isRunning && !firstTokenAt) {
      setElapsedSeconds(0);
      elapsedRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (elapsedRef.current) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    }
    return () => {
      if (elapsedRef.current) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    };
  }, [isRunning, firstTokenAt]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleStart = (): void => {
    void review.start();
  };

  const handleCancel = (): void => {
    void review.cancel();
  };

  const handleOpenSettings = (): void => {
    // Close this modal first so the Settings dialog comes to the foreground
    // unobstructed; the user can re-open the review from the tree afterwards.
    onClose();
    openSettings();
  };

  const handleDryRun = async (): Promise<void> => {
    setDryRunning(true);
    setDryRunResult(null);
    try {
      const result = await api.llm.dryRun({ nodeId, namespace, reviewMetamodel });
      setDryRunResult(result);
    } catch (err) {
      setDryRunResult({
        profile: 'sw_arxml',
        contextElementCount: 0,
        systemPrompt: '',
        userPrompt: '',
        model_id: '',
        region: '',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDryRunning(false);
    }
  };

  const handleDownloadReview = (): void => {
    if (!text) return;
    // Use the full untruncated name for the file
    const fullName = resolvedElementName ?? `node_${nodeId}`;
    const header = `# LLM Safety Review — ${fullName}\n\n` +
      `**Namespace:** ${namespace}\n` +
      `**Model:** ${metadata?.model_id ?? 'unknown'}\n` +
      `**Region:** ${metadata?.region ?? 'unknown'}\n` +
      `**Profile:** ${metadata?.review_profile ?? 'unknown'}\n` +
      `**Date:** ${new Date().toISOString()}\n\n---\n\n`;
    const content = header + text;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llm-review-${fullName.trim().replace(/[<>:"/\\|?*…·]/g, '').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Footer ────────────────────────────────────────────────────────────────

  const footer = (() => {
    if (settingsLoaded && !hasCredentials) {
      // Pre-flight gate: no credentials configured. Render an Open Settings
      // shortcut instead of the Start button (Requirement 4.8).
      return (
        <Space>
          <Button onClick={onClose}>Close</Button>
          <Button
            type="primary"
            icon={<SettingOutlined />}
            onClick={handleOpenSettings}
          >
            Open Settings
          </Button>
        </Space>
      );
    }

    if (isRunning) {
      return (
        <Space>
          <Button danger onClick={handleCancel}>
            Cancel
          </Button>
        </Space>
      );
    }

    if (isTerminal) {
      return (
        <Space>
          <Button onClick={onClose}>Close</Button>
          {text && (
            <Button icon={<DownloadOutlined />} onClick={handleDownloadReview}>
              Download .md
            </Button>
          )}
          <Button type="primary" onClick={handleStart} disabled={!hasCredentials}>
            Run again
          </Button>
        </Space>
      );
    }

    // Idle — credentials present, run not yet started.
    return (
      <Space>
        <Button onClick={onClose}>Close</Button>
        <Button
          icon={<BugOutlined />}
          onClick={() => void handleDryRun()}
          loading={dryRunning}
          disabled={!settingsLoaded}
        >
          Dry Run
        </Button>
        <Button
          type="primary"
          onClick={handleStart}
          disabled={!hasCredentials || !settingsLoaded}
        >
          Start review
        </Button>
      </Space>
    );
  })();

  // ── Title block ───────────────────────────────────────────────────────────

  const titleNode = (
    <div>
      <Title level={5} style={{ margin: 0 }}>
        Initial LLM review — {elementName}
      </Title>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {namespace}
        {subtitle ? ` · ${subtitle}` : ''}
      </Text>
    </div>
  );

  // ── Body ──────────────────────────────────────────────────────────────────

  // Pre-flight gate body
  const renderPreflightGate = () => (
    <Alert
      type="info"
      showIcon
      message="No LLM credentials configured"
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text>
            Add your AWS Bedrock credentials in the LLM Settings dialog to run
            this review.
          </Text>
        </Space>
      }
    />
  );

  // Error banner body
  const renderErrorBanner = () => {
    const isNoCreds = errorCode === 'no_credentials';
    const isCancelled = errorCode === 'cancelled';
    return (
      <Alert
        type={isCancelled ? 'warning' : 'error'}
        showIcon
        message={
          isCancelled
            ? 'Review cancelled'
            : `Review failed${errorCode ? ` (${errorCode})` : ''}`
        }
        description={
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            {isNoCreds ? (
              <Button
                size="small"
                icon={<SettingOutlined />}
                onClick={handleOpenSettings}
              >
                Open Settings
              </Button>
            ) : null}
          </Space>
        }
      />
    );
  };

  // Streaming body — the accumulated text plus a status indicator.
  const renderStreamingBody = () => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {status === 'starting' ? (
        <Space size={8}>
          <Spin size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Contacting LLM… ({elapsedSeconds}s) — processing prompt, waiting for first token
          </Text>
        </Space>
      ) : null}
      {status === 'streaming' && !firstTokenAt ? (
        <Space size={8}>
          <Spin size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Processing prompt… ({elapsedSeconds}s)
          </Text>
        </Space>
      ) : status === 'streaming' && firstTokenAt ? (
        <Space size={8}>
          <Spin size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Streaming response…
          </Text>
        </Space>
      ) : null}
      <div
        style={{
          margin: 0,
          padding: 12,
          background: token.colorFillTertiary,
          borderRadius: token.borderRadius,
          minHeight: 240,
          maxHeight: '50vh',
          overflowY: 'auto',
          fontSize: 13,
          lineHeight: 1.6,
        }}
        data-testid="llm-review-stream-buffer"
      >
        {text ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children, ...props }) => (
                <table
                  {...props}
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                    marginBottom: 12,
                  }}
                >
                  {children}
                </table>
              ),
              th: ({ children, ...props }) => (
                <th
                  {...props}
                  style={{
                    border: `1px solid ${token.colorBorderSecondary}`,
                    padding: '6px 8px',
                    textAlign: 'left',
                    background: token.colorFillSecondary,
                    fontWeight: 600,
                    fontSize: 11,
                  }}
                >
                  {children}
                </th>
              ),
              td: ({ children, ...props }) => (
                <td
                  {...props}
                  style={{
                    border: `1px solid ${token.colorBorderSecondary}`,
                    padding: '6px 8px',
                    fontSize: 12,
                    verticalAlign: 'top',
                  }}
                >
                  {children}
                </td>
              ),
            }}
          >
            {text}
          </Markdown>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {status === 'idle'
              ? 'Click "Start review" to begin.'
              : 'Processing prompt — the model is reading the safety data before generating the first token. This is normal for large prompts.'}
          </Text>
        )}
      </div>
      {metadata && (metadata.input_tokens !== null || metadata.output_tokens !== null) ? (
        <Text type="secondary" style={{ fontSize: 11 }}>
          Tokens — input: {metadata.input_tokens ?? '—'}, output:{' '}
          {metadata.output_tokens ?? '—'}
          {firstTokenAt && metadata.started_at ? (
            <> · TTFT: {((new Date(firstTokenAt).getTime() - new Date(metadata.started_at).getTime()) / 1000).toFixed(1)}s</>
          ) : null}
        </Text>
      ) : firstTokenAt && metadata?.started_at ? (
        <Text type="secondary" style={{ fontSize: 11 }}>
          TTFT: {((new Date(firstTokenAt).getTime() - new Date(metadata.started_at).getTime()) / 1000).toFixed(1)}s
        </Text>
      ) : null}
    </Space>
  );

  // Decide which body sections to render. The pre-flight gate is shown when
  // no credentials exist *and* the run has not produced any output yet —
  // once a run is in flight or has terminated we show the stream buffer
  // (and any error banner) so the user can read the result/log.
  const showPreflightGate =
    settingsLoaded && !hasCredentials && status === 'idle';

  // Show error banner whenever the hook is in an error or cancelled state.
  // Cancellation is surfaced through the same `errorCode === 'cancelled'`
  // path (Requirement 9.4); the streamed text accumulated up to the cancel
  // point remains visible in the buffer below.
  const showErrorBanner = status === 'error' || status === 'cancelled';

  return (
    <Modal
      title={titleNode}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={760}
      maskClosable={!isRunning}
      keyboard={!isRunning}
      destroyOnClose={false}
      styles={{ body: { paddingTop: 16 } }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {showPreflightGate ? renderPreflightGate() : null}
        {showErrorBanner ? renderErrorBanner() : null}
        {dryRunResult ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="small" onClick={() => setDryRunResult(null)}>
                Close preview
              </Button>
            </div>
            {dryRunResult.error ? (
              <Alert type="error" showIcon message="Dry run failed" description={dryRunResult.error} />
            ) : (
              <>
                <Alert
                  type="success"
                  showIcon
                  message="Dry run complete"
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                      {(() => {
                        const inputChars = dryRunResult.systemPrompt.length + dryRunResult.userPrompt.length;
                        const estInputTokens = Math.ceil(inputChars / 4);
                        const estOutputTokens = 2000;
                        const isLocal = settingsQuery.data?.provider === 'ollama';
                        const inputPricePer1M = 3.0;
                        const outputPricePer1M = 15.0;
                        const estCost = (estInputTokens / 1_000_000) * inputPricePer1M + (estOutputTokens / 1_000_000) * outputPricePer1M;
                        return (
                          <>
                            <div><strong>Profile:</strong> {dryRunResult.profile} · <strong>Context elements:</strong> {dryRunResult.contextElementCount}</div>
                            <div><strong>Model:</strong> {dryRunResult.model_id}{dryRunResult.region ? ` · Region: ${dryRunResult.region}` : ''}</div>
                            <div><strong>Est. input:</strong> ~{estInputTokens.toLocaleString()} tokens ({inputChars.toLocaleString()} chars) · <strong>Est. output:</strong> ~{estOutputTokens.toLocaleString()} tokens (fixed)</div>
                            {!isLocal && (
                              <>
                                <div style={{ marginTop: 4, marginBottom: 2 }}>
                                  <strong>Cost estimation</strong>
                                  <span style={{ fontWeight: 'normal', marginLeft: 6, opacity: 0.65 }}>
                                    @ ${inputPricePer1M.toFixed(2)}/1M input · ${outputPricePer1M.toFixed(2)}/1M output
                                    <Tooltip title="Claude Sonnet list price. Tokens estimated at 1 token ≈ 4 chars. Output budget is fixed at 2,000 tokens. Actual cost depends on the selected model and provider pricing.">
                                      <InfoCircleOutlined style={{ marginLeft: 5, cursor: 'help', fontSize: 10 }} />
                                    </Tooltip>
                                  </span>
                                </div>
                                <div style={{ paddingLeft: 12 }}>
                                  <div>Input: ~{estInputTokens.toLocaleString()} tokens × ${inputPricePer1M.toFixed(2)}/1M = ${((estInputTokens / 1_000_000) * inputPricePer1M).toFixed(4)}</div>
                                  <div>Output: ~{estOutputTokens.toLocaleString()} tokens × ${outputPricePer1M.toFixed(2)}/1M = ${((estOutputTokens / 1_000_000) * outputPricePer1M).toFixed(4)}</div>
                                  <div><strong>Total: ~${estCost.toFixed(4)} (≈ {(estCost * 100).toFixed(2)}¢)</strong></div>
                                </div>
                              </>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  }
                />
                <Text strong style={{ fontSize: 12 }}>System Prompt ({dryRunResult.systemPrompt.length} chars):</Text>
                <div style={{ margin: 0, padding: 8, background: token.colorFillTertiary, borderRadius: token.borderRadius, maxHeight: 200, overflowY: 'auto', fontSize: 11, lineHeight: 1.5 }}>
                  <Markdown remarkPlugins={[remarkGfm]}>{dryRunResult.systemPrompt}</Markdown>
                </div>
                <Text strong style={{ fontSize: 12 }}>User Prompt ({dryRunResult.userPrompt.length} chars):</Text>
                <div style={{ margin: 0, padding: 8, background: token.colorFillTertiary, borderRadius: token.borderRadius, maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.4 }}>
                  <Markdown remarkPlugins={[remarkGfm]}>{dryRunResult.userPrompt}</Markdown>
                </div>
              </>
            )}
          </Space>
        ) : null}
        {!showPreflightGate && !dryRunResult ? renderStreamingBody() : null}
        {!showPreflightGate && dryRunResult && (status !== 'idle') ? renderStreamingBody() : null}
      </Space>
    </Modal>
  );
}
