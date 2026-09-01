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
import { Badge, Segmented, theme } from 'antd';
import { createElement } from 'react';
import type { TabDefinition } from '../config/elementTabs';
import { LENS_ICONS } from '../config/lensIcons';

export interface ElementLensSelectorProps {
  /** Options in display order. */
  options: TabDefinition[];
  /** Currently selected option key. */
  value: string;
  /** Called with the newly selected option key. */
  onChange: (key: string) => void;
}

/**
 * The single view selector used by the CenterPanel header, for model elements
 * (model browser) and for malfunctions (analysis view) alike. One control, one
 * style — a Segmented pill group with an icon, a label and an optional count
 * badge per option.
 */
export function ElementLensSelector({ options, value, onChange }: ElementLensSelectorProps) {
  const { token } = theme.useToken();

  return (
    <Segmented
      size="small"
      value={value}
      onChange={(v) => onChange(v as string)}
      options={options.map((o) => {
        const icon = LENS_ICONS[o.key];
        return {
          value: o.key,
          disabled: o.disabled,
          icon: icon ? createElement(icon) : undefined,
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {o.label}
              {(o.count ?? 0) > 0 && (
                <Badge
                  count={o.count}
                  style={{
                    backgroundColor: token.colorTextQuaternary,
                    fontSize: 10,
                    lineHeight: '16px',
                    minWidth: 16,
                    height: 16,
                    paddingInline: 5,
                  }}
                />
              )}
            </span>
          ),
        };
      })}
      style={{ flexShrink: 0 }}
    />
  );
}
