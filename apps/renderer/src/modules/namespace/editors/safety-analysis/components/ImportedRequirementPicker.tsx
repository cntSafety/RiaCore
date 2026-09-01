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
import { useState, useCallback, useRef, useMemo } from 'react';
import { Input, Popover, Button, List, Tag, Spin, Empty, Typography, theme, App } from 'antd';
import type { InputRef } from 'antd';
import { SearchOutlined, LinkOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useSearchRequirementsAcrossNamespaces } from '../hooks/useSafetyQueries';
import { useLinkDirectRequirementToFm } from '../hooks/useSafetyMutations';
import { useNamespaceConnections, useConnectMutation } from '../../../../../hooks/useNamespaceConnections';
import { useCrossNsLinkSettings } from '../../../../../hooks/useCrossNsLinkSettings';

interface ImportedRequirementPickerProps {
  fmNodeId: number;
  linkedNodeIds: Set<number>;
  /**
   * Namespace the malfunction itself lives in. This is the connection
   * *target* (authored side) for any match whose namespace isn't connected
   * yet — see `CrossNsLinkSettings`.
   */
  malfunctionNamespace: string;
}

function getLabel(req: ConceptInstanceData): string {
  const a = req.attributes as Record<string, unknown>;
  return String(a.title ?? a.name ?? a.has_name ?? a.id ?? a.elementId ?? req.node_id);
}

function getElementId(req: ConceptInstanceData): string {
  const a = req.attributes as Record<string, unknown>;
  return String(a.id ?? a.elementId ?? '');
}

function getNamespaceBadgeColor(concept: string): string {
  if (concept.startsWith('need_')) return 'blue';
  if (concept === 'RequirementUsage' || concept === 'RequirementDefinition') return 'purple';
  return 'default';
}

function getNamespaceBadgeText(req: ConceptInstanceData): string {
  if (req.concept.startsWith('need_')) return 'sphinx-needs';
  if (req.concept === 'RequirementUsage' || req.concept === 'RequirementDefinition') return 'sysml-v2';
  return req.namespace;
}

export function ImportedRequirementPicker({ fmNodeId, linkedNodeIds, malfunctionNamespace }: ImportedRequirementPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<InputRef>(null);
  const link = useLinkDirectRequirementToFm();
  const connect = useConnectMutation();
  const { message, modal } = App.useApp();
  const { token } = theme.useToken();

  const { data: results, isFetching, isError, error } = useSearchRequirementsAcrossNamespaces(query);
  const { data: connectionGraph } = useNamespaceConnections();
  const { data: linkSettings } = useCrossNsLinkSettings();
  const unconnectedMode = linkSettings?.unconnectedNamespaceMode ?? 'prompt';

  // Namespaces already connected (imported -> this malfunction's authored namespace).
  const connectedNamespaces = useMemo(() => {
    const names = (connectionGraph?.connections ?? [])
      .filter((c) => c.target === malfunctionNamespace)
      .map((c) => c.source);
    return new Set(names);
  }, [connectionGraph, malfunctionNamespace]);

  const isConnected = useCallback(
    (req: ConceptInstanceData) => connectedNamespaces.has(req.namespace),
    [connectedNamespaces],
  );

  // In "restrict" mode, only ever show matches that can be linked immediately.
  const visibleResults = useMemo(() => {
    if (!results || unconnectedMode !== 'restrict') return results;
    return results.filter(isConnected);
  }, [results, unconnectedMode, isConnected]);

  const handleOpen = useCallback((visible: boolean) => {
    setOpen(visible);
    if (visible) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, []);

  const performLink = useCallback(async (req: ConceptInstanceData) => {
    await link.mutateAsync({ failureModeNodeId: fmNodeId, requirementNodeId: req.node_id });
    setOpen(false);
    setQuery('');
  }, [link, fmNodeId]);

  const handleSelect = (req: ConceptInstanceData) => {
    if (linkedNodeIds.has(req.node_id)) return;

    if (isConnected(req)) {
      performLink(req).catch((err: unknown) => {
        message.error(String((err as Error)?.message ?? 'Failed to link requirement'));
      });
      return;
    }

    // Unreachable in "restrict" mode (unconnected matches are filtered out),
    // but guard anyway in case settings change mid-search.
    if (unconnectedMode === 'restrict') return;

    modal.confirm({
      title: 'Connect namespaces?',
      content: `"${req.namespace}" isn't connected to this analysis yet. Connect it and link the requirement? Declining creates neither the connection nor the link.`,
      okText: 'Connect & Link',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await connect.mutateAsync({ sourceNamespace: req.namespace, targetNamespace: malfunctionNamespace });
          await performLink(req);
        } catch (err) {
          message.error(String((err as Error)?.message ?? 'Failed to connect and link requirement'));
        }
      },
    });
  };

  const content = (
    <div style={{ width: 380 }}>
      <Input
        ref={inputRef}
        size="small"
        prefix={<SearchOutlined style={{ color: '#8c8c8c' }} />}
        placeholder="Search by ID or name (min 2 chars)"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{ marginBottom: 8 }}
        allowClear
      />
      {isFetching ? (
        <div style={{ textAlign: 'center', padding: '12px 0' }}><Spin size="small" /></div>
      ) : isError ? (
        <Typography.Text type="danger" style={{ fontSize: 12, padding: '8px 0', display: 'block' }}>
          Search failed: {error instanceof Error ? error.message : 'Unknown error'}
        </Typography.Text>
      ) : query.trim().length < 2 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, padding: '8px 0', display: 'block' }}>
          Type to search across imported namespaces
        </Typography.Text>
      ) : !visibleResults || visibleResults.length === 0 ? (
        results && results.length > 0 ? (
          <Empty
            description="Matches exist, but their namespaces aren't connected to this analysis yet. Change this in Settings → Imported Requirement Linking."
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ margin: '8px 0' }}
          />
        ) : (
          <Empty description="No requirements found" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '8px 0' }} />
        )
      ) : (
        <List
          size="small"
          dataSource={visibleResults}
          style={{ maxHeight: 280, overflowY: 'auto' }}
          renderItem={(req) => {
            const already = linkedNodeIds.has(req.node_id);
            const connected = isConnected(req);
            return (
              <List.Item
                style={{
                  cursor: already ? 'default' : 'pointer',
                  opacity: already ? 0.5 : 1,
                  padding: '4px 8px',
                  borderRadius: 4,
                }}
                onClick={() => !already && handleSelect(req)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Tag color={getNamespaceBadgeColor(req.concept)} style={{ fontSize: 10, margin: 0 }}>
                    {getNamespaceBadgeText(req)}
                  </Tag>
                  <span style={{ fontSize: 12, fontWeight: 500, flexShrink: 0 }}>{getElementId(req)}</span>
                  <span style={{ fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getLabel(req)}
                  </span>
                  {already && <Tag style={{ marginLeft: 'auto', fontSize: 10 }}>Linked</Tag>}
                  {!already && !connected && (
                    <Tag color="orange" style={{ marginLeft: 'auto', fontSize: 10 }}>Not connected</Tag>
                  )}
                </div>
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={handleOpen}
      content={content}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Link Imported Requirement
          <Popover
            trigger="hover"
            placement="topLeft"
            content={
              <div style={{ fontSize: 12, lineHeight: '20px', maxWidth: 300 }}>
                <Typography.Text style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
                  Searches requirement-type elements across imported namespaces:
                </Typography.Text>
                <div style={{ marginBottom: 3 }}>
                  <Tag color="blue" style={{ fontSize: 10, margin: '0 4px 0 0' }}>sphinx-needs</Tag>
                  all need types (need_req, need_spec, need_impl, …)
                </div>
                <div style={{ marginBottom: 8 }}>
                  <Tag color="purple" style={{ fontSize: 10, margin: '0 4px 0 0' }}>sysml-v2</Tag>
                  RequirementUsage, RequirementDefinition
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Does not include safety-authored surrogate requirements.
                </Typography.Text>
              </div>
            }
          >
            <InfoCircleOutlined style={{ fontSize: 12, color: token.colorTextQuaternary, cursor: 'help' }} />
          </Popover>
        </span>
      }
      trigger="click"
      placement="bottomLeft"
    >
      <Button size="small" type="dashed" icon={<LinkOutlined />} style={{ fontSize: 11, height: 22 }}>
        Link Imported
      </Button>
    </Popover>
  );
}
