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
 * ChangedAttributes — before/after values for a modified boundary node in the
 * import impact report.
 *
 * Deliberately not the namespace diff view's `NodeDiffDetail`. That component
 * takes a `NodeModification` (requiring left/right `NodeSnapshot`s it never
 * reads) and lays the values out as two side-by-side table columns, which is
 * unreadable at the width of this modal for the values that actually change here
 * — RST `content` bodies running to several lines. The shared part that carries
 * the real work, the word-level diff, is reused as-is.
 */

import { useMemo } from 'react';
import { Space, Tag, Typography, theme } from 'antd';
import type { PropertyChange } from '@riacore/app-contracts';
import { diffPropertyValues, type WordDiff } from '../diff/textDiff';
import { InlineTextDiff } from '../diff/InlineTextDiff';

const { Text } = Typography;
const { useToken } = theme;

/**
 * Cap on the rendered height of a single value.
 *
 * An imported `content` attribute can hold an entire requirement body, and a
 * handful of those would push the report's actions off-screen. Scrolling the
 * individual value keeps the entry list navigable while still showing the whole
 * text on demand.
 */
const VALUE_MAX_HEIGHT = 160;

const CHANGE_TAG_COLOR: Record<PropertyChange['changeKind'], string> = {
  added: 'success',
  deleted: 'error',
  modified: 'warning',
};

/** Render a value with no counterpart to diff against (added or deleted). */
function PlainValue({ value }: { value: unknown }) {
  if (value === undefined || value === null) {
    return <Text type="secondary" italic style={{ fontSize: 11 }}>—</Text>;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (
    // pre-wrap so what is shown matches what is stored: HTML would otherwise
    // collapse whitespace runs and drop trailing newlines.
    <Text style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
      {text}
    </Text>
  );
}

function ValueRow({
  label,
  children,
  borderColor,
}: {
  label: string;
  children: React.ReactNode;
  borderColor: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <Text
        type="secondary"
        style={{ fontSize: 10, minWidth: 40, paddingTop: 1, flexShrink: 0, textTransform: 'uppercase' }}
      >
        {label}
      </Text>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          maxHeight: VALUE_MAX_HEIGHT,
          overflowY: 'auto',
          borderLeft: `2px solid ${borderColor}`,
          paddingLeft: 8,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ChangeItem({ change }: { change: PropertyChange }) {
  const { token } = useToken();

  // O(n·m) over tokens, so compute once per change rather than per render.
  const wordDiff: WordDiff | null = useMemo(
    () => diffPropertyValues(change.changeKind, change.leftValue, change.rightValue),
    [change],
  );

  const showBefore = change.changeKind !== 'added';
  const showAfter = change.changeKind !== 'deleted';

  return (
    <div style={{ marginBottom: 8 }}>
      <Space size={4} style={{ marginBottom: 2 }} wrap>
        {/* The raw key is the label: imported namespaces have no display
            vocabulary, so translating it would invent names the user cannot
            cross-check against the source file or the CLI. */}
        <Text code style={{ fontSize: 11 }}>{change.attribute}</Text>
        <Tag color={CHANGE_TAG_COLOR[change.changeKind]} style={{ fontSize: 10, margin: 0 }}>
          {change.changeKind}
        </Tag>
        {wordDiff?.whitespaceOnly && (
          // Without this the row reads as a false positive: marked modified, yet
          // both sides look the same. The value really did change — only in
          // whitespace.
          <Tag
            style={{ fontSize: 9, margin: 0 }}
            title="The values differ only in whitespace (spaces, tabs, or line breaks). Changed whitespace is shown as · ⇥ ↵ ␍."
          >
            whitespace only
          </Tag>
        )}
      </Space>

      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        {showBefore && (
          <ValueRow label="Before" borderColor={token.colorErrorBorder}>
            {wordDiff
              ? <InlineTextDiff segments={wordDiff.left} whitespaceOnly={wordDiff.whitespaceOnly} />
              : <PlainValue value={change.leftValue} />}
          </ValueRow>
        )}
        {showAfter && (
          <ValueRow label="After" borderColor={token.colorSuccessBorder}>
            {wordDiff
              ? <InlineTextDiff segments={wordDiff.right} whitespaceOnly={wordDiff.whitespaceOnly} />
              : <PlainValue value={change.rightValue} />}
          </ValueRow>
        )}
      </Space>
    </div>
  );
}

export function ChangedAttributes({ changes }: { changes: PropertyChange[] }) {
  if (changes.length === 0) {
    return <Text type="secondary" style={{ fontSize: 11 }}>No attribute details available.</Text>;
  }

  return (
    <div style={{ width: '100%' }}>
      {changes.map((change) => (
        <ChangeItem key={change.attribute} change={change} />
      ))}
    </div>
  );
}
