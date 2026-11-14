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
import { Alert, Button, Empty, Input, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../../../../api/riacore';
import type { TagAssignmentTarget } from './TagAssignmentPanel';

/** Uses the existing workspace search, including elements with no tags yet. */
export function FindTagTarget({ namespace, onSelect, onCancel }: {
  namespace: string;
  onSelect: (target: TagAssignmentTarget) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ['tagsOverview.search', term, offset],
    queryFn: () => api.namespaces.search(term, offset, 50),
    enabled: term.length >= 2,
  });
  const select = async (nodeId: number) => {
    setPending(true);
    setError('');
    try {
      const element = await api.safety.getInstance(nodeId);
      const tags = await (element.namespace === namespace
        ? api.safety.getTagsForElement(nodeId) : api.safety.getTagsForImportedElement(nodeId));
      onSelect({ element, tags: tags.filter(tag => tag.namespace === namespace) });
    } catch (err) {
      setError(String((err as Error).message || 'Could not load element'));
    } finally {
      setPending(false);
    }
  };
  return <section className="tag-assignment" aria-label="Find element to tag">
    <Typography.Text strong>Find an element to tag</Typography.Text>
    <Typography.Text type="secondary">Search the workspace, including elements with no tags yet.</Typography.Text>
    <Input aria-label="Find element by name" placeholder="Enter at least 2 characters…" autoFocus allowClear disabled={pending}
      value={search} onChange={e => setSearch(e.target.value)} />
    {(error || query.error) && <Alert type="error" title={error || String(query.error?.message)} action={query.error ? <Button onClick={() => query.refetch()}>Retry</Button> : undefined} showIcon />}
    {query.isFetching && <Spin size="small" />}
    {term.length >= 2 && !query.isFetching && <div className="tag-assignment__options">
      {query.data?.results.map(result => <Button key={result.nodeId} className="tag-target-result" disabled={pending || search.trim() !== term}
        onClick={() => select(result.nodeId)}>
        <span>{result.name}</span><Typography.Text type="secondary">{result.namespace} · {result.concept}</Typography.Text>
      </Button>)}
      {!query.error && query.data?.results.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching elements" />}
    </div>}
    <div className="tag-assignment__footer">
      <Space>
        <Button disabled={offset === 0 || query.isFetching || pending} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</Button>
        <Button disabled={!query.data?.hasMore || query.isFetching || pending} onClick={() => setOffset(value => value + 50)}>Next</Button>
      </Space>
      <Button onClick={onCancel} disabled={pending}>Cancel</Button>
    </div>
  </section>;
}
