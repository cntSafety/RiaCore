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
import { Button, Badge, theme } from 'antd';
import { useWorkspaceStore } from '../../../../../store/workspaceStore';

interface PropagationInfoBarProps {
  safetyNamespace: string;
}

export function PropagationInfoBar({ safetyNamespace }: PropagationInfoBarProps) {
  const { token } = theme.useToken();
  const pending = useWorkspaceStore((s) => s.pendingPropagationSource[safetyNamespace] ?? null);
  const setPending = useWorkspaceStore((s) => s.setPendingPropagationSource);

  return (
    <div
      style={{
        height: 42,
        visibility: pending ? 'visible' : 'hidden',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
        background: token.colorWarningBg,
        borderTop: `1px solid ${token.colorWarningBorder}`,
        flexShrink: 0,
      }}
    >
      <Badge status="processing" color={token.colorWarning} />
      <span style={{ fontSize: 12, flex: 1 }}>
        Propagation started from <strong>{pending?.name}</strong>
        {' '}— right-click another malfunction in the tree or diagram to connect
      </span>
      <Button size="small" onClick={() => setPending(safetyNamespace, null)}>
        Cancel
      </Button>
    </div>
  );
}
