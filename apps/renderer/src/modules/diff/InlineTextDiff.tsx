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
 * InlineTextDiff — renders word-level diff segments with the changed words
 * tinted, so an edit inside a long attribute value is visible at a glance.
 *
 * Two rendering rules earn their complexity:
 *
 *  1. `white-space: pre-wrap`. HTML collapses runs of whitespace and discards
 *     trailing newlines, so without this the displayed text is not the stored
 *     text — and a whitespace-only edit is literally unrenderable.
 *  2. Informative whitespace inside a changed segment is drawn as a glyph. A
 *     tinted space is imperceptible, which made real changes look like a diff
 *     bug: a row marked `modified` whose two sides appeared identical. Which
 *     whitespace qualifies is decided by `splitChangedTextForDisplay` in
 *     app-contracts, shared with the exported HTML report so both mark the same
 *     things — and deliberately *not* every space, or ordinary prose edits turn
 *     into dot soup.
 *
 * Colours come from theme tokens rather than literals so the highlight stays
 * legible in both the light and dark themes.
 */

import { theme, Typography } from 'antd';
import { splitChangedTextForDisplay, type Segment } from '@riacore/app-contracts';

const { useToken } = theme;
const { Text } = Typography;

interface Props {
  segments: Segment[];
  /**
   * True when the whole change is whitespace. Drives whether single spaces are
   * drawn as glyphs — nothing else would be visible in that case.
   */
  whitespaceOnly?: boolean;
  /** Monospace, matching the plain value rendering it replaces. */
  fontSize?: number;
}

export function InlineTextDiff({ segments, whitespaceOnly = false, fontSize = 11 }: Props) {
  const { token } = useToken();

  return (
    <Text
      style={{
        fontSize,
        fontFamily: 'monospace',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
      }}
    >
      {segments.map((segment, index) => {
        if (segment.kind === 'same') {
          // Segments are positional and their text repeats, so the index is the
          // only stable identity available here.
          // eslint-disable-next-line react/no-array-index-key
          return <span key={index}>{segment.text}</span>;
        }

        const isRemoved = segment.kind === 'removed';
        const color = isRemoved ? token.colorErrorText : token.colorSuccessText;
        return (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            style={{
              background: isRemoved ? token.colorErrorBg : token.colorSuccessBg,
              color,
              // Strikethrough carries the removed/added distinction without
              // relying on colour alone.
              textDecoration: isRemoved ? 'line-through' : 'none',
              borderRadius: 2,
              padding: '0 1px',
            }}
          >
            {splitChangedTextForDisplay(segment.text, whitespaceOnly).map((part, partIndex) => {
              if (!part.mark) {
                // eslint-disable-next-line react/no-array-index-key
                return <span key={partIndex}>{part.text}</span>;
              }
              return (
                <span
                  // eslint-disable-next-line react/no-array-index-key
                  key={partIndex}
                  title={part.label}
                  style={{
                    opacity: 0.6,
                    outline: part.label ? `1px dotted ${color}` : undefined,
                  }}
                >
                  {/* A newline keeps its real break so pre-wrap still wraps where
                      the stored value does. */}
                  {part.text === '\n' ? `${part.glyph}\n` : part.glyph}
                </span>
              );
            })}
          </span>
        );
      })}
    </Text>
  );
}
