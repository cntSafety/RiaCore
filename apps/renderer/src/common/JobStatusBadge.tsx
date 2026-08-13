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
import { Badge, Tag, Tooltip, theme } from 'antd';
import { SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, MinusCircleOutlined } from '@ant-design/icons';
import type { JobStatus } from '../store/jobStore';

const { useToken } = theme;

interface JobStatusBadgeProps {
  status: JobStatus;
  label?: string;
  progress?: number;
  tooltip?: string;
}

export function JobStatusBadge({ status, label, progress, tooltip }: JobStatusBadgeProps) {
  const { token } = useToken();

  const config: Record<JobStatus, { color: string; icon: React.ReactNode; text: string }> = {
    running: { color: token.colorPrimary, icon: <SyncOutlined spin />, text: 'Running' },
    done: { color: token.colorSuccess, icon: <CheckCircleOutlined />, text: 'Done' },
    error: { color: token.colorError, icon: <CloseCircleOutlined />, text: 'Error' },
    idle: { color: token.colorTextQuaternary, icon: <MinusCircleOutlined />, text: 'Idle' },
  };

  const { color, icon, text } = config[status];
  const displayText = label ?? text;
  const fullText = progress !== undefined && status === 'running'
    ? `${displayText} ${Math.round(progress)}%`
    : displayText;

  const tag = (
    <Tag
      icon={icon}
      style={{
        fontSize: 11,
        lineHeight: '18px',
        color,
        border: `1px solid ${color}`,
        background: 'transparent',
        margin: 0,
      }}
    >
      {fullText}
    </Tag>
  );

  return tooltip ? <Tooltip title={tooltip}>{tag}</Tooltip> : tag;
}
