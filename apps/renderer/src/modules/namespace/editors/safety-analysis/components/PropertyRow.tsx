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
import { CopyOutlined } from '@ant-design/icons';
import { Tooltip, theme } from 'antd';
import { useCallback, useState } from 'react';

export interface PropertyRowProps {
  label: string;
  value: string;
  /** Whether to show a copy-to-clipboard button. Defaults to true. */
  copyable?: boolean;
}

/**
 * A key-value display row with a fixed-width monospaced label,
 * a value column, and an optional copy-to-clipboard button.
 *
 * Validates: Requirements 6.1, 6.2, 6.3
 */
export function PropertyRow({ label, value, copyable = true }: PropertyRowProps) {
  const { token } = theme.useToken();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr auto',
        gap: 8,
        alignItems: 'baseline',
      }}
    >
      <span
        style={{
          fontFamily: token.fontFamilyCode,
          textTransform: 'uppercase',
          color: token.colorTextTertiary,
          fontSize: 11,
        }}
      >
        {label}
      </span>

      <span
        style={{
          fontFamily: token.fontFamilyCode,
          fontSize: 12,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>

      {copyable && (
        <Tooltip title={copied ? 'Copied' : 'Copy'}>
          <CopyOutlined
            onClick={handleCopy}
            style={{
              fontSize: 11,
              color: copied ? token.colorSuccess : token.colorTextQuaternary,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          />
        </Tooltip>
      )}
    </div>
  );
}
