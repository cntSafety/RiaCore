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
import { Breadcrumb, Button, Dropdown, theme } from 'antd';
import {
  DownOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import { useWorkspaceStore } from '../store/workspaceStore';

const EDITOR_OPTIONS = [
  { value: 'Safety-Analysis', label: 'Safety Analysis' },
  { value: 'Requirements', label: 'Requirements' },
  { value: 'Safety-Tasks', label: 'Safety Tasks' },
  { value: 'Review-Status', label: 'Review Status' },
  { value: 'Tags-Overview', label: 'Tags Overview' },
  { value: 'Model-Check', label: 'Check Model' },
  { value: 'Status-Cards', label: 'Status Cards' },
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
  'Status-Cards',
]);

const { useToken } = theme;

export function TopBar({
  onNavigateHome,
}: {
  onNavigateHome?: () => void;
}) {
  const { token } = useToken();
  const { projectName, activeNamespace, editorOverrides, setEditorOverride } = useWorkspaceStore();

  const currentEditor = activeNamespace
    ? editorOverrides[activeNamespace.namespaceId] ?? activeNamespace.owningApplication
    : '';
  const currentEditorLabel =
    EDITOR_OPTIONS.find((o) => o.value === currentEditor)?.label ?? currentEditor;

  const dropdownMenuItems = EDITOR_OPTIONS.filter((o) => {
    if (!activeNamespace) return true;
    if (activeNamespace.role === 'authored') return true;
    return !AUTHORED_ONLY_EDITORS.has(o.value);
  }).map((o) => ({
    key: o.value,
    label: o.label,
  }));

  const breadcrumbItems = [
    ...(projectName   ? [{ title: projectName }] : []),
    ...(activeNamespace ? [{ title: activeNamespace.name }] : []),
    ...(activeNamespace
      ? [
          {
            title: (
              <Dropdown
                menu={{
                  items: dropdownMenuItems,
                  onClick: ({ key }) =>
                    setEditorOverride(activeNamespace.namespaceId, key),
                }}
                trigger={['click']}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    background: token.colorPrimary,
                    color: '#fff',
                    borderRadius: 12,
                    padding: '1px 10px',
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: 'pointer',
                    lineHeight: '20px',
                  }}
                >
                  {currentEditorLabel}
                  <DownOutlined style={{ fontSize: 9 }} />
                </span>
              </Dropdown>
            ),
          },
        ]
      : []),
  ];

  return (
    <div
      className="riacore-topbar"
      style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
        gap: 8,
      }}
    >
      {/* Home button */}
      {activeNamespace && (
        <Button
          type="text"
          size="small"
          icon={<HomeOutlined style={{ fontSize: 14, color: token.colorPrimary }} />}
          onClick={onNavigateHome}
          style={{
            padding: '0 6px',
            height: 22,
            flexShrink: 0,
            color: token.colorPrimary,
          }}
          title="Back to overview"
        />
      )}

      <Breadcrumb items={breadcrumbItems} style={{ fontSize: 12, flex: 1 }} separator="›" />
    </div>
  );
}
