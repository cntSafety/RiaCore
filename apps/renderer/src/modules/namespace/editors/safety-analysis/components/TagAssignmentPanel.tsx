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
import { Alert, Button, Checkbox, Empty, Input, Space, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';
import type { ConceptInstanceData } from '@riacore/app-contracts';
import { useTagMutations } from '../../../../../hooks/useTagMutations';
import { TagChip } from './TagChip';

export interface TagAssignmentTarget {
  element: ConceptInstanceData;
  tags: ConceptInstanceData[];
}

/** Draft only explicit changes: mixed or untouched tags must never be replaced. */
export function TagAssignmentPanel({ targets, tags, namespace, onClose }: {
  targets: TagAssignmentTarget[];
  tags: ConceptInstanceData[];
  namespace: string;
  onClose: () => void;
}) {
  const mutations = useTagMutations();
  const [search, setSearch] = useState('');
  const [changes, setChanges] = useState<Map<number, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const completed = useRef(new Set<string>());
  const [error, setError] = useState('');
  const filtered = tags.filter(tag => String(tag.attributes?.has_name ?? '').toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const operations = useMemo(() => targets.flatMap(target => tags.flatMap(tag => {
    const desired = changes.get(tag.node_id);
    const linked = target.tags.some(t => t.node_id === tag.node_id);
    return desired === undefined || desired === linked ? [] : [{ target, tag, add: desired }];
  })), [targets, tags, changes]);

  const apply = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    let failed = 0;
    let firstError = '';
    for (const { target, tag, add } of operations) {
      const key = `${target.element.node_id}:${tag.node_id}`;
      if (completed.current.has(key)) continue;
      try {
        if (target.element.namespace === namespace) {
          await (add ? mutations.linkTag : mutations.unlinkTag).mutateAsync({
            elementNodeId: target.element.node_id, tagNodeId: tag.node_id,
          });
        } else {
          await (add ? mutations.linkTagCrossNs : mutations.unlinkTagCrossNs).mutateAsync({
            importedElementNodeId: target.element.node_id, tagNodeId: tag.node_id,
          });
        }
        completed.current.add(key);
      } catch (err) {
        failed++;
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      }
    }
    savingRef.current = false;
    setSaving(false);
    if (failed) {
      setError(`${completed.current.size} ${completed.current.size === 1 ? 'change' : 'changes'} saved; ${failed} failed. ${firstError}. Retry the remaining changes or close and review the current tags.`);
    } else {
      onClose();
    }
  };

  return <section className="tag-assignment" aria-label="Manage tags">
    <Typography.Text strong>{targets.length === 1 ? 'Manage tags' : `Manage tags for ${targets.length} elements`}</Typography.Text>
    <Typography.Text>{targets.map(({ element }) => String(element.attributes?.short_name ?? element.attributes?.has_name ?? element.attributes?.element_name ?? `${element.concept} ${element.node_id}`)).join(', ')}</Typography.Text>
    <Typography.Text type="secondary">{targets.length === 1
      ? 'Select tags to apply. Uncheck to remove from this element.'
      : 'A dash means some selected elements have this tag. Unchanged tags stay as they are.'}</Typography.Text>
    <Input aria-label="Search available tags" placeholder="Search tags…" value={search} allowClear
      onChange={e => setSearch(e.target.value)} autoFocus />
    <div className="tag-assignment__options">
      {filtered.map(tag => {
        const count = targets.filter(target => target.tags.some(t => t.node_id === tag.node_id)).length;
        const changed = changes.get(tag.node_id);
        return <Checkbox className="tag-assignment__option" key={tag.node_id} aria-label={String(tag.attributes?.has_name ?? `Tag ${tag.node_id}`)}
            checked={changed ?? count === targets.length}
            indeterminate={changed === undefined && count > 0 && count < targets.length}
            disabled={saving || Boolean(error)}
            onChange={event => setChanges(previous => new Map(previous).set(tag.node_id, event.target.checked))}>
          <TagChip color={String(tag.attributes?.tag_color || 'purple')}>{String(tag.attributes?.has_name ?? '—')}</TagChip>
          {targets.length > 1 && <Typography.Text type="secondary">{count}/{targets.length}</Typography.Text>}
        </Checkbox>;
      })}
      {!filtered.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching tags" />}
    </div>
    {error && <Alert type="error" title={error} showIcon />}
    <div className="tag-assignment__footer">
      <Typography.Text type="secondary" aria-live="polite">{operations.length} {operations.length === 1 ? 'change' : 'changes'}</Typography.Text>
      <Space>
        <Button onClick={onClose} disabled={saving}>{error ? 'Close' : 'Cancel'}</Button>
        <Button type="primary" onClick={apply} disabled={!operations.length} loading={saving}>
          {error ? 'Retry failed changes' : 'Apply changes'}
        </Button>
      </Space>
    </div>
  </section>;
}
