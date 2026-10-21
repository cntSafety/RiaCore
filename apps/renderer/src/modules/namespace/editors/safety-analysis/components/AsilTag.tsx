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
 * AsilTag — the one way an ASIL level is rendered as a chip.
 *
 * Every ASIL tag used to be `<Tag color={getAsilColor(asil)}>`, resolving to an
 * antd preset name. Two reasons that had to go:
 *
 * 1. The presets contain no four distinguishable oranges. The scale needs four
 *    ordered steps in one hue family, which means explicit colours.
 * 2. A preset name is theme-blind. The ramp is theme-dependent, because "more
 *    severe" has to mean "more visually dominant" and dominance inverts with the
 *    background.
 *
 * Routing every call site through this component also means the chip and the
 * diagram can no longer disagree about what level a malfunction is, which they
 * previously could — the dropdown resolved its dot through one copy of the
 * palette and the diagram resolved tile borders through another.
 *
 * The level text is always rendered. Colour is a second channel on top of it,
 * never the only carrier.
 */

import { Tag } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { useAsilPalette } from '../config/asilColors';

export interface AsilTagProps {
  /** The ASIL value, e.g. `'A'`, `'D'`, `'B(C)'`. Decides the colour. */
  asil: string;
  /**
   * Display text, when it differs from the raw value — `ASIL D` on a summary
   * line, or a Select option's own label. The colour still comes from `asil`.
   * Defaults to the value itself.
   */
  label?: ReactNode;
  /** Extra style, merged over the palette's own fill/text/border. */
  style?: CSSProperties;
  /** Font size override for dense surfaces (tables, tree rows). */
  fontSize?: number;
  title?: string;
  /** Present where the chip itself is the edit affordance (table cells). */
  onClick?: () => void;
}

export function AsilTag({ asil, label, style, fontSize, title, onClick }: AsilTagProps) {
  const palette = useAsilPalette();
  const { fill, text } = palette.chip(asil);

  return (
    <Tag
      title={title}
      onClick={onClick}
      style={{
        margin: 0,
        background: fill,
        color: text,
        // A 1px border of the text colour keeps the chip's own edge legible on a
        // surface close to its fill, which the light theme's pale fills are.
        borderColor: text,
        ...(onClick ? { cursor: 'pointer' } : {}),
        ...(fontSize === undefined ? {} : { fontSize }),
        ...style,
      }}
    >
      {label ?? asil}
    </Tag>
  );
}
