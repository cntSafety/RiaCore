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
import type { ReactNode } from 'react';
import { Space, Tag, Typography, theme } from 'antd';

/** Shared section title, count badge and optional action for element details. */
export function SectionHeader({ title, count, action }: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        paddingBottom: 10,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        marginBottom: 12,
      }}
    >
      <Space size={8} align="center">
        <Typography.Text strong style={{ fontSize: 13 }}>{title}</Typography.Text>
        {count !== undefined && (
          <Tag style={{ fontSize: 11, lineHeight: '18px' }}>
            {count === 0 ? 'None' : `${count}`}
          </Tag>
        )}
      </Space>
      {action}
    </div>
  );
}
