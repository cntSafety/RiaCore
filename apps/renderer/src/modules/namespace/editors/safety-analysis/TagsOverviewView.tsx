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
import { App, Badge, Button, Input, Space, Spin, Tag, Typography, theme } from 'antd';
import { CheckOutlined, CloseOutlined, PlusOutlined, TagOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnsType } from 'antd/es/table/interface';
import type { NamespaceContext } from '../../../../store/workspaceStore';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useTags } from '../../../../hooks/useTags';
import { useTagMutations } from '../../../../hooks/useTagMutations';
import { api } from '../../../../api/riacore';
import { DataTable } from '../../../../components/data-table';
import { TagChip } from './components/TagChip';
import { ShowInTreeTrigger } from '../../../../components/ShowInTreeTrigger';
import { useSafetyProfileMetadata } from './hooks/useSafetyProfileMetadata';
import { getAsilColor } from './config/asilColors';
import './safety-editor.css';

const TAG_PRESET_COLORS = [
  'magenta', 'red', 'volcano', 'orange', 'gold', 'lime', 'green',
  'cyan', 'blue', 'geekblue', 'purple',
] as const;

interface TagsOverviewViewProps {
  ns: NamespaceContext;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
}

interface TagWithElements {
  tag: ConceptInstanceData;
  elements: ConceptInstanceData[];
}

interface ElementWithTags {
  element: ConceptInstanceData;
  tags: ConceptInstanceData[];
}

function elementName(el: ConceptInstanceData): string {
  const a = el.attributes ?? {};
  const name = a.short_name ?? a.has_name ?? a.element_name ?? a.title;
  if (name) return String(name);

  const sp = typeof a.stable_path === 'string' ? a.stable_path : '';
  if (sp) {
    const last = sp.split('/').filter(Boolean).pop();
    if (last) return last;
  }
  return `${el.concept} ${el.node_id}`;
}

function maxAsilLevel(asils: string[], asilOrder: string[]): string {
  let maxIdx = -1;
  for (const asil of asils) {
    const idx = asilOrder.indexOf(asil.toUpperCase());
    if (idx > maxIdx) maxIdx = idx;
  }
  return maxIdx >= 0 ? asilOrder[maxIdx] : '';
}

function useTagsWithElements(namespace: string) {
  const tagsQuery = useTags(namespace);
  const tags = tagsQuery.data ?? [];

  const elementsQuery = useQuery({
    queryKey: ['tagsOverview.elements', namespace, tags.map((t) => t.node_id).join(',')],
    queryFn: async () => {
      const result = new Map<number, ConceptInstanceData[]>();
      for (const tag of tags) {
        try {
          const elements = await api.safety.getElementsForTag(tag.node_id);
          result.set(tag.node_id, elements);
        } catch {
          result.set(tag.node_id, []);
        }
      }
      return result;
    },
    enabled: tags.length > 0,
  });

  const data: TagWithElements[] = useMemo(() => {
    const elementMap = elementsQuery.data;
    if (!elementMap) return [];
    return tags.map((tag) => ({
      tag,
      elements: elementMap.get(tag.node_id) ?? [],
    }));
  }, [tags, elementsQuery.data]);

  return {
    data,
    isLoading: tagsQuery.isLoading || elementsQuery.isLoading,
    tags,
  };
}

function useMaxAsilForElements(elements: ConceptInstanceData[], asilOrder: string[]) {
  return useQuery({
    queryKey: ['tagsOverview.maxAsil', asilOrder.join(','), elements.map((e) => e.node_id).join(',')],
    queryFn: async () => {
      const result = new Map<number, string>();
      for (const el of elements) {
        try {
          const malfunctions = await api.safety.getMalfunctionsForElement(el.node_id);
          const asils = malfunctions
            .map((m) => String(m.attributes?.malfunction_asil ?? ''))
            .filter(Boolean);
          const max = maxAsilLevel(asils, asilOrder);
          if (max) result.set(el.node_id, max);
        } catch {
          // Leave missing for this element
        }
      }
      return result;
    },
    enabled: elements.length > 0,
  });
}

function TagsSplash({ namespace }: { namespace: string }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const { createTag } = useTagMutations();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await createTag.mutateAsync({ namespace, name: trimmed });
      qc.invalidateQueries({ queryKey: ['tags'] });
      qc.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
      qc.invalidateQueries({ queryKey: ['tagsForElement'] });
      qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
      setCreating(false);
      setName('');
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create tag'));
    }
  };

  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: '48px 24px',
      background: token.colorBgLayout,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    }}>
      <div style={{ maxWidth: 540, width: '100%' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14,
          background: token.colorPrimaryBg, color: token.colorPrimary,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 26, marginBottom: 20,
        }}>
          <TagOutlined />
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, color: token.colorText, letterSpacing: '-0.015em' }}>
          No tags yet
        </div>
        <div style={{ fontSize: 14, color: token.colorTextSecondary, marginTop: 8, lineHeight: 1.55 }}>
          Tags help you classify and filter safety elements across the namespace.
          Create your first tag to begin organizing model content.
        </div>
        <div style={{ marginTop: 24 }}>
          {creating ? (
            <Space size={8}>
              <Input
                size="large"
                placeholder="Tag name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onPressEnter={handleCreate}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setName('');
                  }
                }}
                style={{ width: 260 }}
                autoFocus
              />
              <Button
                type="primary"
                size="large"
                icon={<CheckOutlined />}
                onClick={handleCreate}
                loading={createTag.isPending}
                disabled={!name.trim()}
              >
                Create
              </Button>
              <Button
                size="large"
                icon={<CloseOutlined />}
                onClick={() => {
                  setCreating(false);
                  setName('');
                }}
              />
            </Space>
          ) : (
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Create Tag
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function TagsToElementsTable({
  tagElements,
  namespace,
  onNavigateToNode,
  triggerCreate = 0,
}: {
  tagElements: TagWithElements[];
  namespace: string;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  triggerCreate?: number;
}) {
  const { message } = App.useApp();
  const { createTag, updateTag, deleteTag, linkTag, unlinkTag, linkTagCrossNs, unlinkTagCrossNs } = useTagMutations();
  const qc = useQueryClient();
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [colorPickerTagId, setColorPickerTagId] = useState<number | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');

  useEffect(() => {
    if (triggerCreate > 0) {
      setCreatingTag(true);
      setNewTagName('');
    }
  }, [triggerCreate]);

  const tagNameFilters = useMemo(
    () => tagElements.map((te) => ({
      text: String(te.tag.attributes?.has_name ?? `Tag ${te.tag.node_id}`),
      value: te.tag.node_id,
    })),
    [tagElements],
  );

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['tags'] });
    qc.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
    qc.invalidateQueries({ queryKey: ['tagsForElement'] });
    qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
  };

  const handleRename = async (tagNodeId: number) => {
    if (!editName.trim()) {
      setEditingTagId(null);
      return;
    }
    try {
      await updateTag.mutateAsync({ nodeId: tagNodeId, updates: { has_name: editName.trim() } });
      invalidateAll();
      message.success('Tag renamed');
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to rename tag'));
    }
    setEditingTagId(null);
  };

  const handleDelete = async (tagNodeId: number) => {
    try {
      await deleteTag.mutateAsync(tagNodeId);
      invalidateAll();
      message.success('Tag deleted');
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to delete tag'));
    }
  };

  const handleCreate = async () => {
    if (!newTagName.trim()) {
      setCreatingTag(false);
      return;
    }
    try {
      await createTag.mutateAsync({ namespace, name: newTagName.trim() });
      invalidateAll();
      message.success('Tag created');
      setNewTagName('');
      setCreatingTag(false);
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to create tag'));
    }
  };

  const handleColorChange = async (tagNodeId: number, color: string) => {
    try {
      await updateTag.mutateAsync({ nodeId: tagNodeId, updates: { tag_color: color } });
      invalidateAll();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Failed to set color'));
    }
    setColorPickerTagId(null);
  };

  const handleRowContextMenu = async (record: TagWithElements, e: React.MouseEvent) => {
    e.preventDefault();
    const tagName = String(record.tag.attributes?.has_name ?? '');
    const hasColor = !!record.tag.attributes?.tag_color;
    const menuItems = [
      { id: 'rename', label: `Rename "${tagName}"` },
      { id: 'color', label: 'Set Color' },
      ...(hasColor ? [{ id: 'removeColor', label: 'Remove Color' }] : []),
      { id: 'delete', label: `Delete "${tagName}"` },
    ];

    const selected = await api.contextMenu.show(menuItems);
    if (selected === 'rename') {
      setEditingTagId(record.tag.node_id);
      setEditName(tagName);
    } else if (selected === 'color') {
      setColorPickerTagId(record.tag.node_id);
    } else if (selected === 'removeColor') {
      handleColorChange(record.tag.node_id, '');
    } else if (selected === 'delete') {
      handleDelete(record.tag.node_id);
    }
  };

  const handleTableContextMenu = async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('tr[data-row-key]')) return;
    e.preventDefault();
    const selected = await api.contextMenu.show([{ id: 'create', label: 'Create New Tag' }]);
    if (selected === 'create') {
      setCreatingTag(true);
    }
  };

  const handleElementContextMenu = async (el: ConceptInstanceData, currentTagNodeId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const elName = elementName(el);
    const isCrossNs = el.namespace !== namespace;

    const currentTagName = String(tagElements.find((te) => te.tag.node_id === currentTagNodeId)?.tag.attributes?.has_name ?? '');
    const otherTags = tagElements
      .filter((te) => te.tag.node_id !== currentTagNodeId)
      .filter((te) => !te.elements.some((e2) => e2.node_id === el.node_id));

    const menuItems = [
      { id: `remove:${currentTagNodeId}`, label: `Remove "${currentTagName}" from ${elName}` },
      ...otherTags.map((te) => ({
        id: `add:${te.tag.node_id}`,
        label: `Add "${String(te.tag.attributes?.has_name ?? '')}" to ${elName}`,
      })),
    ];

    const selected = await api.contextMenu.show(menuItems);
    if (!selected) return;

    const [action, tagIdStr] = selected.split(':');
    const tagNodeId = Number(tagIdStr);

    try {
      if (action === 'remove') {
        if (isCrossNs) {
          await unlinkTagCrossNs.mutateAsync({ tagNodeId, importedElementNodeId: el.node_id });
        } else {
          await unlinkTag.mutateAsync({ elementNodeId: el.node_id, tagNodeId });
        }
        message.success(`Removed tag from ${elName}`);
      } else if (action === 'add') {
        if (isCrossNs) {
          await linkTagCrossNs.mutateAsync({ tagNodeId, importedElementNodeId: el.node_id });
        } else {
          await linkTag.mutateAsync({ elementNodeId: el.node_id, tagNodeId });
        }
        message.success(`Added tag to ${elName}`);
      }
      invalidateAll();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Operation failed'));
    }
  };

  const columns: ColumnsType<TagWithElements> = [
    {
      title: 'Tag',
      dataIndex: ['tag', 'node_id'],
      key: 'tag',
      width: 200,
      filters: tagNameFilters,
      onFilter: (value, record) => record.tag.node_id === value,
      render: (_: unknown, record: TagWithElements) => {
        const name = String(record.tag.attributes?.has_name ?? '—');
        const color = String(record.tag.attributes?.tag_color ?? '');

        if (editingTagId === record.tag.node_id) {
          return (
            <Space size={4}>
              <Input
                size="small"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onPressEnter={() => handleRename(record.tag.node_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingTagId(null);
                }}
                style={{ width: 120, fontSize: 12 }}
                autoFocus
              />
              <Button
                size="small"
                type="text"
                icon={<CheckOutlined style={{ fontSize: 11, color: '#52c41a' }} />}
                onClick={() => handleRename(record.tag.node_id)}
              />
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined style={{ fontSize: 11 }} />}
                onClick={() => setEditingTagId(null)}
              />
            </Space>
          );
        }

        if (colorPickerTagId === record.tag.node_id) {
          return (
            <Space size={4} wrap>
              {TAG_PRESET_COLORS.map((c) => (
                <Tag key={c} color={c} style={{ cursor: 'pointer', fontSize: 11 }} onClick={() => handleColorChange(record.tag.node_id, c)}>
                  {c}
                </Tag>
              ))}
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined style={{ fontSize: 11 }} />}
                onClick={() => setColorPickerTagId(null)}
              />
            </Space>
          );
        }

        return (
          <ShowInTreeTrigger
            homeTarget={{ nodeId: record.tag.node_id, namespace: record.tag.namespace, concept: 'tag' }}
          >
            <TagChip color={color || 'purple'} style={{ fontSize: 13 }}>{name}</TagChip>
          </ShowInTreeTrigger>
        );
      },
    },
    {
      title: 'Elements',
      key: 'elements',
      width: 500,
      render: (_: unknown, record: TagWithElements) => {
        if (record.elements.length === 0) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }

        return (
          <Space size={4} wrap>
            {record.elements.map((el) => (
              <Tag
                key={el.node_id}
                style={{ cursor: 'pointer', fontSize: 11 }}
                onClick={() => onNavigateToNode?.(el.node_id, el.namespace, el.concept)}
                onContextMenu={(e) => handleElementContextMenu(el, record.tag.node_id, e)}
              >
                {elementName(el)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Count',
      key: 'count',
      width: 80,
      sorter: (a, b) => a.elements.length - b.elements.length,
      render: (_: unknown, record) => (
        <Badge count={record.elements.length} style={{ backgroundColor: '#722ed1' }} showZero />
      ),
    },
  ];

  return (
    <div className="ria-card" onContextMenu={handleTableContextMenu}>
      {creatingTag && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--ria-card-border)' }}>
          <Space size={4}>
            <Input
              size="small"
              placeholder="New tag name"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onPressEnter={handleCreate}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setCreatingTag(false);
                  setNewTagName('');
                }
              }}
              style={{ width: 180, fontSize: 12 }}
              autoFocus
            />
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              onClick={handleCreate}
              disabled={!newTagName.trim()}
              loading={createTag.isPending}
            />
            <Button
              size="small"
              icon={<CloseOutlined />}
              onClick={() => {
                setCreatingTag(false);
                setNewTagName('');
              }}
            />
          </Space>
        </div>
      )}
      <DataTable<TagWithElements>
        dataSource={tagElements}
        columns={columns}
        rowKey={(record) => record.tag.node_id}
        onRow={(record) => ({
          onContextMenu: (e) => handleRowContextMenu(record, e),
        })}
      />
    </div>
  );
}

function ElementsToTagsTable({
  tagElements,
  namespace,
  onNavigateToNode,
}: {
  tagElements: TagWithElements[];
  namespace: string;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
}) {
  const { message } = App.useApp();
  const { linkTag, unlinkTag, linkTagCrossNs, unlinkTagCrossNs } = useTagMutations();
  const qc = useQueryClient();
  const profile = useSafetyProfileMetadata();
  const asilOrder = profile.asilGroups.find((group) => group.label === 'Core')?.options ?? [];

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['tags'] });
    qc.invalidateQueries({ queryKey: ['tagsOverview.elements'] });
    qc.invalidateQueries({ queryKey: ['tagsForElement'] });
    qc.invalidateQueries({ queryKey: ['tagsForImportedElement'] });
  };

  const elementsWithTags = useMemo(() => {
    const elementMap = new Map<number, ElementWithTags>();
    for (const te of tagElements) {
      for (const el of te.elements) {
        const existing = elementMap.get(el.node_id);
        if (existing) {
          existing.tags.push(te.tag);
        } else {
          elementMap.set(el.node_id, { element: el, tags: [te.tag] });
        }
      }
    }
    return Array.from(elementMap.values());
  }, [tagElements]);

  const maxAsilQuery = useMaxAsilForElements(elementsWithTags.map((et) => et.element), asilOrder);

  const tagNameFilters = useMemo(
    () => tagElements.map((te) => ({
      text: String(te.tag.attributes?.has_name ?? `Tag ${te.tag.node_id}`),
      value: te.tag.node_id,
    })),
    [tagElements],
  );

  const conceptFilters = useMemo(() => {
    const concepts = new Set(elementsWithTags.map((et) => et.element.concept));
    return Array.from(concepts).map((c) => ({ text: c, value: c }));
  }, [elementsWithTags]);

  const handleRowContextMenu = async (record: ElementWithTags, e: React.MouseEvent) => {
    e.preventDefault();
    const elName = elementName(record.element);
    const isCrossNs = record.element.namespace !== namespace;
    const linkedTagIds = new Set(record.tags.map((t) => t.node_id));

    const availableTags = tagElements.filter((te) => !linkedTagIds.has(te.tag.node_id));

    const menuItems = [
      ...record.tags.map((tag) => ({
        id: `remove:${tag.node_id}`,
        label: `Remove "${String(tag.attributes?.has_name ?? '')}" from ${elName}`,
      })),
      ...availableTags.map((te) => ({
        id: `add:${te.tag.node_id}`,
        label: `Add "${String(te.tag.attributes?.has_name ?? '')}" to ${elName}`,
      })),
    ];

    if (menuItems.length === 0) return;

    const selected = await api.contextMenu.show(menuItems);
    if (!selected) return;

    const [action, tagIdStr] = selected.split(':');
    const tagNodeId = Number(tagIdStr);

    try {
      if (action === 'remove') {
        if (isCrossNs) {
          await unlinkTagCrossNs.mutateAsync({ tagNodeId, importedElementNodeId: record.element.node_id });
        } else {
          await unlinkTag.mutateAsync({ elementNodeId: record.element.node_id, tagNodeId });
        }
        message.success(`Removed tag from ${elName}`);
      } else if (action === 'add') {
        if (isCrossNs) {
          await linkTagCrossNs.mutateAsync({ tagNodeId, importedElementNodeId: record.element.node_id });
        } else {
          await linkTag.mutateAsync({ elementNodeId: record.element.node_id, tagNodeId });
        }
        message.success(`Added tag to ${elName}`);
      }
      invalidateAll();
    } catch (err: unknown) {
      message.error(String((err as Error)?.message ?? 'Operation failed'));
    }
  };

  const columns: ColumnsType<ElementWithTags> = [
    {
      title: 'Element',
      key: 'element',
      width: 240,
      render: (_: unknown, record: ElementWithTags) => {
        const name = elementName(record.element);
        return (
          <ShowInTreeTrigger
            homeTarget={{
              nodeId: record.element.node_id,
              namespace: record.element.namespace,
              concept: record.element.concept,
            }}
          >
            <Typography.Text
              style={{ cursor: 'pointer', color: '#1677ff' }}
              onClick={() => onNavigateToNode?.(record.element.node_id, record.element.namespace, record.element.concept)}
            >
              {name}
            </Typography.Text>
          </ShowInTreeTrigger>
        );
      },
    },
    {
      title: 'Concept',
      dataIndex: ['element', 'concept'],
      key: 'concept',
      width: 150,
      filters: conceptFilters,
      onFilter: (value, record) => record.element.concept === value,
      render: (concept: string) => <Tag>{concept}</Tag>,
    },
    {
      title: 'Tags',
      key: 'tags',
      width: 320,
      filters: tagNameFilters,
      onFilter: (value, record) => record.tags.some((t) => t.node_id === value),
      render: (_: unknown, record: ElementWithTags) => (
        <Space size={4} wrap>
          {record.tags.map((tag) => (
            <TagChip key={tag.node_id} color={String(tag.attributes?.tag_color || 'purple')} style={{ fontSize: 11 }}>
              {String(tag.attributes?.has_name ?? '—')}
            </TagChip>
          ))}
        </Space>
      ),
    },
    {
      title: 'Max ASIL',
      key: 'maxAsil',
      width: 90,
      sorter: (a, b) => {
        const aIdx = asilOrder.indexOf(maxAsilQuery.data?.get(a.element.node_id) ?? '');
        const bIdx = asilOrder.indexOf(maxAsilQuery.data?.get(b.element.node_id) ?? '');
        return aIdx - bIdx;
      },
      render: (_: unknown, record: ElementWithTags) => {
        const asil = maxAsilQuery.data?.get(record.element.node_id) ?? '';
        if (!asil) return <Typography.Text type="secondary">—</Typography.Text>;
        return <Tag color={getAsilColor(asil)} style={{ fontSize: 11 }}>{asil}</Tag>;
      },
    },
  ];

  return (
    <div className="ria-card">
      <DataTable<ElementWithTags>
        dataSource={elementsWithTags}
        columns={columns}
        rowKey={(record) => record.element.node_id}
        tableLayout="auto"
        onRow={(record) => ({
          onContextMenu: (e) => handleRowContextMenu(record, e),
        })}
      />
    </div>
  );
}

export function TagsOverviewView({ ns, onNavigateToNode }: TagsOverviewViewProps) {
  const { token } = theme.useToken();
  const { data: tagElements, isLoading, tags } = useTagsWithElements(ns.name);
  const [activeKey, setActiveKey] = useState<'tags' | 'elements'>('tags');
  const [createTagTrigger, setCreateTagTrigger] = useState(0);

  if (isLoading) {
    return (
      <div className="ria-scope" style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 12, background: token.colorBgLayout,
      }}>
        <Spin />
        <Typography.Text type="secondary">Loading tags…</Typography.Text>
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <div className="ria-scope" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TagsSplash namespace={ns.name} />
      </div>
    );
  }

  const orphanTagCount = tagElements.filter((te) => te.elements.length === 0).length;
  const taggedElementCount = new Set(tagElements.flatMap((te) => te.elements.map((e) => e.node_id))).size;

  const navItems = [
    { key: 'tags', label: 'Tags', count: tags.length, issues: orphanTagCount },
    { key: 'elements', label: 'Tagged Elements', count: taggedElementCount, issues: 0 },
  ];

  const activeNav = navItems.find((n) => n.key === activeKey)!;

  return (
    <div className="ria-scope" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{
        width: 260, flexShrink: 0,
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px 10px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            Tags Overview
          </div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {tags.length} tag{tags.length !== 1 ? 's' : ''} · {taggedElementCount} tagged element{taggedElementCount !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px 8px' }}>
          {navItems.map((item) => {
            const isActive = item.key === activeKey;
            const dot = item.issues === 0 ? '#52c41a' : '#f5222d';
            return (
              <div
                key={item.key}
                className={'ria-navitem' + (isActive ? ' is-active' : '')}
                onClick={() => setActiveKey(item.key as 'tags' | 'elements')}
              >
                <span className="ria-navitem__dot" style={{ background: dot }} />
                <span className="ria-navitem__label">{item.label}</span>
                <span className="ria-navitem__count">{item.count}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 16,
          padding: '20px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          flexShrink: 0,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            background: token.colorPrimaryBg, color: token.colorPrimary,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, flexShrink: 0,
          }}>
            <TagOutlined />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: token.colorText, letterSpacing: '-0.01em' }}>
              {activeKey === 'tags' ? 'Tags' : 'Tagged Elements'}
            </div>
            <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 2, lineHeight: 1.5 }}>
              {activeKey === 'tags'
                ? 'Manage tags applied to safety elements. Right-click rows to rename, recolor or delete.'
                : 'Safety elements with at least one tag applied.'}
            </div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 16, fontSize: 12 }}>
              <span style={{ color: token.colorTextSecondary }}>
                <span className="mono" style={{ color: token.colorText, fontWeight: 600 }}>{activeNav.count}</span> total
              </span>
              {activeKey === 'tags' && (
                <>
                  <span style={{ width: 1, height: 12, background: token.colorBorderSecondary }} />
                  {orphanTagCount > 0 ? (
                    <span className="ria-fg-err" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className="mono" style={{ fontWeight: 600 }}>{orphanTagCount}</span> with no elements
                    </span>
                  ) : (
                    <span className="ria-fg-ok">All tags have elements</span>
                  )}
                </>
              )}
            </div>
          </div>
          {activeKey === 'tags' && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateTagTrigger((n) => n + 1)}>
              Create Tag
            </Button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', background: token.colorBgLayout }}>
          {activeKey === 'tags' ? (
            <TagsToElementsTable
              tagElements={tagElements}
              namespace={ns.name}
              onNavigateToNode={onNavigateToNode}
              triggerCreate={createTagTrigger}
            />
          ) : (
            <ElementsToTagsTable
              tagElements={tagElements}
              namespace={ns.name}
              onNavigateToNode={onNavigateToNode}
            />
          )}
        </div>
      </div>
    </div>
  );
}
