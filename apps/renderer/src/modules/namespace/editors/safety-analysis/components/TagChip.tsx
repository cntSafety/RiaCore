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
import { Tag } from 'antd';
import type { TagProps } from 'antd';
import type { CSSProperties } from 'react';

/**
 * Ant Design preset tag colors. When a tag's stored color is one of these
 * names, antd derives the chip's background/border/text from theme tokens, so
 * it adapts automatically between light and dark mode.
 */
const ANTD_PRESET_TAG_COLORS = new Set([
  // palette presets
  'magenta', 'red', 'volcano', 'orange', 'gold', 'lime', 'green',
  'cyan', 'blue', 'geekblue', 'purple',
  // status presets
  'success', 'processing', 'error', 'warning', 'default',
]);

/** Parse a #rrggbb (or #rgb) hex string into an `rgba(...)` string at `alpha`. */
function hexToRgba(hex: string, alpha: number): string | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const int = parseInt(h, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Resolve a stored tag color into props for an antd `<Tag>` that render
 * correctly in both light and dark themes.
 *
 * - Preset color names pass straight through (`color` prop) — antd makes them
 *   theme-aware.
 * - Custom hex colors become a translucent chip: the hex drives the text and
 *   border, with a low-alpha background, instead of antd's solid
 *   white-on-color fill (which is hardcoded and looks like light mode in dark
 *   themes).
 */
export function tagColorProps(stored: string | undefined): { color?: string; style?: CSSProperties } {
  const value = (stored ?? '').trim();
  if (!value || ANTD_PRESET_TAG_COLORS.has(value)) {
    return { color: value || 'purple' };
  }
  const background = hexToRgba(value, 0.16);
  const borderColor = hexToRgba(value, 0.5);
  if (!background || !borderColor) {
    // Unrecognized format — let antd handle it directly.
    return { color: value };
  }
  return { style: { color: value, background, borderColor } };
}

/**
 * A drop-in replacement for antd `<Tag color={tag_color}>` that renders stored
 * tag colors (preset names or custom hex) consistently across light and dark
 * mode. All other `<Tag>` props (closable, onClose, etc.) are forwarded.
 */
export function TagChip({ color, style, children, ...rest }: TagProps) {
  const resolved = tagColorProps(typeof color === 'string' ? color : undefined);
  return (
    <Tag {...rest} color={resolved.color} style={{ ...resolved.style, ...style }}>
      {children}
    </Tag>
  );
}
