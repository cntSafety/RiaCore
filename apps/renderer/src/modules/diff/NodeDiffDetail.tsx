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
 * NodeDiffDetail — attribute-level diff table for a single modified node.
 * Shows PropertyChange[] as a left/right comparison table.
 *
 * String values that were edited are word-diffed so the actual change stands out
 * inside otherwise identical prose (see textDiff.ts).
 */

import { useMemo } from 'react';
import { Table, Tag, Typography } from 'antd';
import type { NodeModification, PropertyChange } from '@riacore/app-contracts';
import { labelAttributeKey } from './safetyDiffLabels';
import { diffPropertyValues, type WordDiff } from './textDiff';
import { InlineTextDiff } from './InlineTextDiff';

const { Text } = Typography;

interface Props {
  modification: NodeModification;
  /** Metamodel of the diffed namespace; selects the attribute label vocabulary. */
  metamodel?: string;
}

type ChangeRow = PropertyChange & { key: string; wordDiff: WordDiff | null };

/** Map change kinds to standard Ant Design preset tag colors for readability */
const CHANGE_TAG_COLOR: Record<string, string> = {
  added:    'success',
  deleted:  'error',
  modified: 'warning',
};

function renderValue(val: unknown): React.ReactNode {
  if (val === undefined || val === null) return <Text type="secondary" italic>—</Text>;
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  // pre-wrap so the rendered text matches the stored value: HTML would
  // otherwise collapse whitespace runs and drop trailing newlines.
  return (
    <Text style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
      {str}
    </Text>
  );
}

export function NodeDiffDetail({ modification, metamodel = '' }: Props) {
  // Diffing is O(n·m) over tokens, so it is computed once per property change
  // rather than per column render.
  const rows: ChangeRow[] = useMemo(
    () => modification.propertyChanges.map((ch, i) => ({
      ...ch,
      key: `${ch.attribute}-${i}`,
      wordDiff: diffPropertyValues(ch.changeKind, ch.leftValue, ch.rightValue),
    })),
    [modification],
  );

  return (
    <Table<ChangeRow>
      size="small"
      dataSource={rows}
      pagination={false}
      style={{ margin: '4px 0' }}
      columns={[
        {
          title: 'Change',
          dataIndex: 'changeKind',
          width: 110,
          render: (kind: string, row) => (
            <>
              <Tag color={CHANGE_TAG_COLOR[kind] ?? 'default'} style={{ fontSize: 10, margin: 0 }}>
                {kind}
              </Tag>
              {row.wordDiff?.whitespaceOnly && (
                // Without this the row reads as a false positive: marked
                // modified, yet both sides look the same. The value really did
                // change — only in whitespace.
                <Tag
                  color="default"
                  style={{ fontSize: 9, margin: '2px 0 0', display: 'block', width: 'fit-content' }}
                  title="The values differ only in whitespace (spaces, tabs, or line breaks). Changed whitespace is shown as · ⇥ ↵ ␍."
                >
                  whitespace only
                </Tag>
              )}
            </>
          ),
        },
        {
          title: 'Attribute',
          dataIndex: 'attribute',
          width: 160,
          // Raw key stays in the tooltip: the label is for reading, the key is
          // what the user needs when cross-checking against the model or a CLI.
          render: (val: string) => (
            <Text style={{ fontSize: 11 }} title={val}>
              {labelAttributeKey(val, metamodel)}
            </Text>
          ),
        },
        {
          title: 'Left value',
          dataIndex: 'leftValue',
          render: (v: unknown, row) => (row.wordDiff
            ? <InlineTextDiff segments={row.wordDiff.left} whitespaceOnly={row.wordDiff.whitespaceOnly} />
            : renderValue(v)),
        },
        {
          title: 'Right value',
          dataIndex: 'rightValue',
          render: (v: unknown, row) => (row.wordDiff
            ? <InlineTextDiff segments={row.wordDiff.right} whitespaceOnly={row.wordDiff.whitespaceOnly} />
            : renderValue(v)),
        },
      ]}
    />
  );
}
