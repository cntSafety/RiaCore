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
import { Breadcrumb, Tag, Button, Select, Space, theme } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import type { NamespaceContext } from '../../store/workspaceStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

const { useToken } = theme;

const EDITOR_OPTIONS = [
  { value: 'Safety-Analysis', label: 'Safety Analysis' },
  { value: 'Requirements', label: 'Requirements' },
  { value: 'Safety-Tasks', label: 'Safety Tasks' },
  { value: 'Review-Status', label: 'Review Status' },
  { value: 'Tags-Overview', label: 'Tags Overview' },
  { value: 'Model-Check', label: 'Check Model' },
];

/**
 * Editors that author safety domain content (malfunctions, notes, tags,
 * requirements, safety tasks). They MUST only be offered for authored
 * namespaces — opening them on an imported namespace would cause new
 * instances to be written into the wrong namespace.
 */
const AUTHORED_ONLY_EDITORS = new Set([
  'Safety-Analysis',
  'Requirements',
  'Safety-Tasks',
  'Review-Status',
  'Tags-Overview',
  'Model-Check',
]);

interface NamespaceHeaderProps {
  ns: NamespaceContext;
  onBack?: () => void;
}

export function NamespaceHeader({ ns, onBack }: NamespaceHeaderProps) {
  const { token } = useToken();
  const { editorOverrides, setEditorOverride } = useWorkspaceStore();

  const currentEditor = editorOverrides[ns.namespaceId] ?? ns.owningApplication;

  const roleColor = ns.role === 'authored' ? token.colorWarning : token.colorPrimary;
  const roleLabel = ns.role === 'authored' ? 'authored' : 'imported';

  return (
    <div
      style={{
        padding: '6px 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}
    >
      <Button
        type="text"
        size="small"
        icon={<ArrowLeftOutlined />}
        onClick={onBack}
        style={{ fontSize: 11, padding: '0 4px' }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{ns.name}</span>
        </div>
      </div>

      {/* View override */}
      <Space size={4}>
        <span style={{ fontSize: 11, color: token.colorTextTertiary }}>View:</span>
        <Select
          size="small"
          value={currentEditor}
          onChange={(v) => setEditorOverride(ns.namespaceId, v)}
          options={EDITOR_OPTIONS.filter((o) =>
            ns.role === 'authored' || !AUTHORED_ONLY_EDITORS.has(o.value),
          )}
          style={{ width: 160, fontSize: 11 }}
        />
      </Space>
    </div>
  );
}
