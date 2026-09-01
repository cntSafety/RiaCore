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
 * SotifSections.tsx
 *
 * SOTIF-specific malfunction tab bodies: Functional Insufficiencies and
 * Triggering Conditions. Both are catalog-backed, SHARED concepts: a single
 * node (e.g. "Heavy rain") can be linked to many malfunctions (1-to-n).
 *
 * The picker is deliberately simple: one "Add from catalog" list that merges the
 * profile's predefined entries with any entries already created in this
 * namespace (including custom ones), deduplicated by name. Selecting an entry
 * reuses the existing shared node if one with that name exists, otherwise
 * creates it — the user never has to think about "existing vs predefined".
 * A custom entry is created as a shared node and then shows up in the same list
 * for other malfunctions. Removing a chip unlinks it from THIS malfunction; the
 * shared node (and its links to other malfunctions) is kept.
 *
 * Rendered only for a SOTIF_ANALYSIS namespace (see CenterPanel tab gating).
 */

import { App, Button, Card, Dropdown, Empty, Input, Modal, Select, Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { DeleteOutlined, DownOutlined, EditOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';
import {
  useAllFunctionalInsufficiencies,
  useAllTriggeringConditions,
  useFunctionalInsufficiencies,
  useTriggeringConditions,
} from '../hooks/useSafetyQueries';
import {
  useAddFunctionalInsufficiency,
  useAddTriggeringCondition,
  useDeleteFunctionalInsufficiency,
  useDeleteTriggeringCondition,
  useUnlinkFunctionalInsufficiencyFromFm,
  useUnlinkTriggeringConditionFromFm,
  useUpdateFunctionalInsufficiency,
  useUpdateTriggeringCondition,
} from '../hooks/useSafetyMutations';
import { DeleteWithPreview } from './DeleteWithPreview';

/** Auto-opens a DeleteWithPreview modal as soon as it mounts (controlled delete). */
function AutoOpenPreview({ onMount }: { onMount: () => void }) {
  useEffect(() => { onMount(); }, [onMount]);
  return null;
}

interface SotifSectionProps {
  fmNodeId: number;
  namespace: string;
  workspaceKey: string | null;
  triggerAutoSave?: () => void;
}

type CatalogKind = 'fi' | 'tc';

interface CatalogEntry {
  name: string;
  description: string;
  source: string; // 'catalog' | 'custom'
}

const KIND_CONFIG: Record<CatalogKind, {
  catalogId: string;
  descriptionAttr: string;
  sourceAttr: string;
  hint: string;
  customPlaceholder: string;
  emptyText: string;
}> = {
  fi: {
    catalogId: 'functionalInsufficiencies',
    descriptionAttr: 'fi_description',
    sourceAttr: 'fi_source',
    hint: 'How the intended function falls short even with no fault (sensor / algorithm / specification / integration limitations). Pick from the catalog or add your own. The same insufficiency can be shared across malfunctions.',
    customPlaceholder: 'e.g. Incomplete night-operation spec',
    emptyText: 'No functional insufficiencies linked yet.',
  },
  tc: {
    catalogId: 'triggeringConditions',
    descriptionAttr: 'tc_description',
    sourceAttr: 'tc_source',
    hint: 'Conditions in the operating environment that can trigger the insufficiency. Pick from the catalog (e.g. Heavy rain) or add a project-specific one (e.g. Sensor misalignment). The same condition can be shared across malfunctions.',
    customPlaceholder: 'e.g. Sensor misalignment',
    emptyText: 'No triggering conditions linked yet.',
  },
};

function CatalogConceptSection({ kind, fmNodeId, namespace, workspaceKey, triggerAutoSave }: SotifSectionProps & { kind: CatalogKind }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const cfg = KIND_CONFIG[kind];
  const isFi = kind === 'fi';

  const profile = useSafetyProfileMetadata();

  // Linked-to-this-malfunction items (chips).
  const fiLinked = useFunctionalInsufficiencies(isFi ? fmNodeId : undefined);
  const tcLinked = useTriggeringConditions(!isFi ? fmNodeId : undefined);
  const linkedQuery = isFi ? fiLinked : tcLinked;
  const linked: ConceptInstanceData[] = linkedQuery.data ?? [];

  // All items already created in the namespace (shared pool).
  const fiAll = useAllFunctionalInsufficiencies(namespace, isFi);
  const tcAll = useAllTriggeringConditions(namespace, !isFi);
  const allQuery = isFi ? fiAll : tcAll;
  const all: ConceptInstanceData[] = allQuery.data ?? [];

  const addFi = useAddFunctionalInsufficiency(namespace, workspaceKey, triggerAutoSave);
  const addTc = useAddTriggeringCondition(namespace, workspaceKey, triggerAutoSave);
  const addMutation = isFi ? addFi : addTc;

  const unlinkFi = useUnlinkFunctionalInsufficiencyFromFm(namespace, workspaceKey, triggerAutoSave);
  const unlinkTc = useUnlinkTriggeringConditionFromFm(namespace, workspaceKey, triggerAutoSave);

  const updateFi = useUpdateFunctionalInsufficiency(namespace, workspaceKey, triggerAutoSave);
  const updateTc = useUpdateTriggeringCondition(namespace, workspaceKey, triggerAutoSave);
  const updateMutation = isFi ? updateFi : updateTc;

  const deleteFi = useDeleteFunctionalInsufficiency(namespace, workspaceKey, triggerAutoSave);
  const deleteTc = useDeleteTriggeringCondition(namespace, workspaceKey, triggerAutoSave);
  const deleteMutation = isFi ? deleteFi : deleteTc;

  const [selectedName, setSelectedName] = useState<string | undefined>();
  const [customName, setCustomName] = useState('');
  // Edit modal state (rename + description of a shared node).
  const [editNode, setEditNode] = useState<ConceptInstanceData | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  // Controlled delete-with-preview state (shared node deleted everywhere).
  const [pendingDeleteNodeId, setPendingDeleteNodeId] = useState<number | null>(null);

  const predefined = useMemo(() => {
    const group = profile.review?.instructions?.catalogs?.find((c) => c.id === cfg.catalogId);
    return group?.items ?? [];
  }, [profile.review, cfg.catalogId]);

  const linkedNames = useMemo(
    () => new Set(linked.map((it) => String(it.attributes?.has_name ?? '').trim().toLowerCase())),
    [linked],
  );

  // Unified catalog: predefined entries + entries already created in the
  // namespace (custom or previously materialized), keyed and deduped by name.
  // Predefined descriptions take precedence; already-created custom entries add
  // their own names to the list so they are reusable across malfunctions.
  const unified = useMemo(() => {
    const map = new Map<string, CatalogEntry>();
    for (const c of predefined) {
      map.set(c.name.trim().toLowerCase(), { name: c.name, description: c.description, source: 'catalog' });
    }
    for (const n of all) {
      const nm = String(n.attributes?.has_name ?? '').trim();
      if (!nm) continue;
      const key = nm.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          name: nm,
          description: String(n.attributes?.[cfg.descriptionAttr] ?? ''),
          source: String(n.attributes?.[cfg.sourceAttr] ?? 'custom'),
        });
      }
    }
    return map;
  }, [predefined, all, cfg.descriptionAttr, cfg.sourceAttr]);

  // Options = unified catalog minus what's already linked to this malfunction.
  const catalogOptions = useMemo(
    () => [...unified.values()]
      .filter((e) => !linkedNames.has(e.name.trim().toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ value: e.name, label: e.name, desc: e.description, source: e.source })),
    [unified, linkedNames],
  );

  const addFromCatalog = async () => {
    const entry = selectedName ? unified.get(selectedName.trim().toLowerCase()) : undefined;
    if (!entry) return;
    try {
      // Reuse-or-create by name, then link. Handles both predefined entries not
      // yet materialized and existing shared nodes uniformly.
      await addMutation.mutateAsync({ failureModeNodeId: fmNodeId, name: entry.name, description: entry.description, source: entry.source });
      setSelectedName(undefined);
    } catch (err) {
      message.error(String((err as Error)?.message ?? 'Failed to add entry'));
    }
  };

  const addCustom = async () => {
    const name = customName.trim();
    if (!name) return;
    try {
      await addMutation.mutateAsync({ failureModeNodeId: fmNodeId, name, description: '', source: 'custom' });
      setCustomName('');
    } catch (err) {
      message.error(String((err as Error)?.message ?? 'Failed to add entry'));
    }
  };

  const unlinkEntry = async (nodeId: number) => {
    try {
      if (isFi) {
        await unlinkFi.mutateAsync({ failureModeNodeId: fmNodeId, functionalInsufficiencyNodeId: nodeId });
      } else {
        await unlinkTc.mutateAsync({ failureModeNodeId: fmNodeId, triggeringConditionNodeId: nodeId });
      }
    } catch (err) {
      message.error(String((err as Error)?.message ?? 'Failed to unlink entry'));
    }
  };

  const openEdit = (node: ConceptInstanceData) => {
    setEditNode(node);
    setEditName(String(node.attributes?.has_name ?? ''));
    setEditDescription(String(node.attributes?.[cfg.descriptionAttr] ?? ''));
  };

  const saveEdit = async () => {
    if (!editNode) return;
    const name = editName.trim();
    if (!name) return;
    try {
      await updateMutation.mutateAsync({
        nodeId: editNode.node_id,
        updates: { has_name: name, [cfg.descriptionAttr]: editDescription },
        fmNodeId,
      });
      setEditNode(null);
    } catch (err) {
      message.error(String((err as Error)?.message ?? 'Failed to save changes'));
    }
  };

  if (linkedQuery.isLoading || profile.isLoading) {
    return <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /></div>;
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 500, color: token.colorTextTertiary,
    marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  return (
    <Card size="small" styles={{ body: { padding: 14 } }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
        {cfg.hint}
      </Typography.Paragraph>

      {/* Linked entries as chips (close = unlink from this malfunction) */}
      {linked.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={cfg.emptyText} style={{ margin: '8px 0' }} />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {linked.map((it) => {
            const source = String(it.attributes?.[cfg.sourceAttr] ?? 'custom');
            const desc = String(it.attributes?.[cfg.descriptionAttr] ?? '');
            const name = String(it.attributes?.has_name ?? `#${it.node_id}`);
            return (
              <Dropdown
                key={it.node_id}
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'edit', icon: <EditOutlined />, label: 'Edit name / description…', onClick: () => openEdit(it) },
                    { key: 'unlink', icon: <LinkOutlined />, label: 'Unlink from this malfunction', onClick: () => void unlinkEntry(it.node_id) },
                    { type: 'divider' },
                    { key: 'delete', icon: <DeleteOutlined />, danger: true, label: 'Delete everywhere…', onClick: () => setPendingDeleteNodeId(it.node_id) },
                  ],
                }}
              >
                <Tooltip title={desc || undefined}>
                  <Tag
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', margin: 0, fontSize: 12, cursor: 'pointer' }}
                  >
                    <Tag
                      color={source === 'catalog' ? 'cyan' : 'purple'}
                      style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 5px', textTransform: 'uppercase' }}
                    >
                      {source}
                    </Tag>
                    {name}
                    <DownOutlined style={{ fontSize: 9, color: token.colorTextTertiary }} />
                  </Tag>
                </Tooltip>
              </Dropdown>
            );
          })}
        </div>
      )}

      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Add from catalog (predefined + already-created shared entries) */}
        <div>
          <div style={labelStyle}>Add from catalog</div>
          <Space.Compact style={{ width: '100%', maxWidth: 520 }}>
            <Select
              size="small"
              style={{ flex: 1 }}
              showSearch
              optionFilterProp="label"
              placeholder={catalogOptions.length ? 'Select an entry…' : 'All catalog entries linked'}
              value={selectedName}
              onChange={setSelectedName}
              options={catalogOptions}
              disabled={catalogOptions.length === 0 || addMutation.isPending}
              popupMatchSelectWidth={480}
              optionRender={(option) => (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <Tag
                    color={(option.data as { source?: string }).source === 'catalog' ? 'cyan' : 'purple'}
                    style={{ margin: '2px 0 0', fontSize: 9, lineHeight: '14px', padding: '0 5px', textTransform: 'uppercase' }}
                  >
                    {(option.data as { source?: string }).source}
                  </Tag>
                  <div>
                    <div>{option.label}</div>
                    {(option.data as { desc?: string }).desc && (
                      <div style={{ fontSize: 11, color: token.colorTextTertiary, whiteSpace: 'normal', lineHeight: '1.3' }}>
                        {(option.data as { desc?: string }).desc}
                      </div>
                    )}
                  </div>
                </div>
              )}
            />
            <Button size="small" type="primary" icon={<PlusOutlined />} loading={addMutation.isPending} disabled={!selectedName} onClick={() => void addFromCatalog()}>
              Add
            </Button>
          </Space.Compact>
        </div>

        {/* Add custom — becomes a shared entry available in the catalog list */}
        <div>
          <div style={labelStyle}>Add custom (user-defined)</div>
          <Space.Compact style={{ width: '100%', maxWidth: 520 }}>
            <Input
              size="small"
              placeholder={cfg.customPlaceholder}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onPressEnter={() => void addCustom()}
            />
            <Button size="small" icon={<PlusOutlined />} loading={addMutation.isPending} disabled={!customName.trim()} onClick={() => void addCustom()}>
              Add custom
            </Button>
          </Space.Compact>
        </div>
      </div>

      {/* Edit (rename + description) of the shared node — affects every malfunction it's linked to */}
      <Modal
        open={editNode !== null}
        title="Edit entry"
        okText="Save"
        onOk={() => void saveEdit()}
        onCancel={() => setEditNode(null)}
        confirmLoading={updateMutation.isPending}
        okButtonProps={{ disabled: !editName.trim() }}
        width={480}
      >
        <div style={{ marginBottom: 8, color: token.colorTextTertiary, fontSize: 12 }}>
          This is a shared entry — changes apply to every malfunction it is linked to.
        </div>
        <div style={{ ...labelStyle, marginTop: 8 }}>Name</div>
        <Input value={editName} onChange={(e) => setEditName(e.target.value)} onPressEnter={() => void saveEdit()} />
        <div style={{ ...labelStyle, marginTop: 12 }}>Description</div>
        <Input.TextArea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} autoSize={{ minRows: 3 }} />
      </Modal>

      {/* Delete the shared node everywhere, with an impact preview of affected malfunctions */}
      {pendingDeleteNodeId !== null && (
        <DeleteWithPreview
          nodeId={pendingDeleteNodeId}
          onCancel={() => setPendingDeleteNodeId(null)}
          onConfirm={async () => {
            await deleteMutation.mutateAsync({ nodeId: pendingDeleteNodeId, fmNodeId });
            setPendingDeleteNodeId(null);
          }}
        >
          {(openPreview) => <AutoOpenPreview onMount={openPreview} />}
        </DeleteWithPreview>
      )}
    </Card>
  );
}

export function FunctionalInsufficiencySection(props: SotifSectionProps) {
  return <CatalogConceptSection kind="fi" {...props} />;
}

export function TriggeringConditionSection(props: SotifSectionProps) {
  return <CatalogConceptSection kind="tc" {...props} />;
}
