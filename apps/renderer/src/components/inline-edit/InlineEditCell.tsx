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
import { Input, Select, theme } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * Click-to-edit table cells.
 *
 * Interaction contract matches `MalfunctionTableRow`: click (or Enter/Space
 * when focused) opens the editor, Enter or blur commits, Escape reverts. The
 * committed value is held locally so the cell keeps showing the new value while
 * the underlying query refetches.
 *
 * Deliberately carries NO hover affordance, tooltip or custom stylesheet —
 * antd's core Table has no editable-cell primitive, and the official demo's
 * hover-border pattern was judged noise here. Display text wraps instead of
 * truncating, so a long value is fully readable without a tooltip.
 *
 * Both components are domain-agnostic — they take a value and an `onCommit`
 * callback and know nothing about safety concepts or IPC.
 */

export interface InlineTextCellProps {
  value: string;
  /** Persist the new value. Rejecting reverts the cell to the previous value. */
  onCommit: (next: string) => Promise<void> | void;
  /** Shown greyed out when the value is empty. */
  placeholder?: string;
  /** Use a `TextArea` that grows with its content instead of a single-line input. */
  multiline?: boolean;
  /** Styling of the display text. */
  strong?: boolean;
  secondary?: boolean;
  fontSize?: number;
  disabled?: boolean;
}

export function InlineTextCell({
  value,
  onCommit,
  placeholder = '—',
  multiline = false,
  strong = false,
  secondary = false,
  fontSize = 13,
  disabled = false,
}: InlineTextCellProps) {
  const { token } = theme.useToken();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);

  // Adopt refetched server values, but never clobber an open editor.
  useEffect(() => {
    committed.current = value;
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = async (next: string) => {
    setEditing(false);
    if (next === committed.current) {
      setDraft(committed.current);
      return;
    }
    committed.current = next;
    setDraft(next);
    try {
      await onCommit(next);
    } catch {
      // Mutation hooks surface their own error message; just roll the cell back.
      committed.current = value;
      setDraft(value);
    }
  };

  const cancel = () => {
    setDraft(committed.current);
    setEditing(false);
  };

  if (editing) {
    const shared = {
      autoFocus: true,
      value: draft,
      size: 'small' as const,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.target.value),
      onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        void commit(e.target.value),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void commit(draft);
        }
        if (e.key === 'Escape') cancel();
      },
      style: { fontSize, width: '100%' },
    };
    return multiline ? (
      <Input.TextArea
        {...shared}
        autoSize={{ minRows: 1, maxRows: 8 }}
        style={{ ...shared.style, resize: 'none' }}
      />
    ) : (
      <Input {...shared} />
    );
  }

  return (
    <span
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? undefined : 0}
      onClick={disabled ? undefined : () => setEditing(true)}
      onKeyDown={
        disabled
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setEditing(true);
              }
            }
      }
      style={{
        display: 'block',
        minWidth: 0,
        minHeight: 20,
        fontSize,
        fontWeight: strong ? 600 : 400,
        color: draft
          ? secondary
            ? token.colorTextSecondary
            : token.colorText
          : token.colorTextQuaternary,
        cursor: disabled ? 'default' : 'text',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        lineHeight: 1.45,
      }}
    >
      {draft || placeholder}
    </span>
  );
}

export interface InlineSelectCellProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onCommit: (next: string) => Promise<void> | void;
  /** Render the committed value in the display state (e.g. as a coloured Tag). */
  renderDisplay: (value: string) => ReactNode;
  allowClear?: boolean;
  placeholder?: string;
  width?: number;
}

export function InlineSelectCell({
  value,
  options,
  onCommit,
  renderDisplay,
  allowClear = false,
  placeholder,
  width = 150,
}: InlineSelectCellProps) {
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(value);
  const committed = useRef(value);

  useEffect(() => {
    committed.current = value;
    if (!editing) setShown(value);
  }, [value, editing]);

  const commit = async (next: string) => {
    setEditing(false);
    if (next === committed.current) return;
    committed.current = next;
    setShown(next);
    try {
      await onCommit(next);
    } catch {
      committed.current = value;
      setShown(value);
    }
  };

  if (editing) {
    return (
      <Select
        autoFocus
        open
        size="small"
        value={shown || undefined}
        options={options}
        allowClear={allowClear}
        placeholder={placeholder}
        style={{ width, maxWidth: '100%' }}
        onChange={(next: string | undefined) => void commit(next ?? '')}
        onBlur={() => {
          setShown(committed.current);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      style={{ display: 'inline-block', cursor: 'pointer' }}
    >
      {renderDisplay(shown)}
    </span>
  );
}
