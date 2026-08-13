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
import { useState } from 'react';
import { Button, Dropdown, Input, Modal, Tag, theme } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { QUERY_TEMPLATES, resolveTemplate, type QueryTemplate } from './queryTemplates';

const { useToken } = theme;

const CATEGORY_COLORS: Record<QueryTemplate['category'], string> = {
  meta: 'purple',
  universe: 'blue',
  source: 'green',
  'cross-namespace': 'orange',
  custom: 'default',
};

interface QueryTemplateBarProps {
  /** Called with the resolved Cypher string ready to execute. */
  onSelect: (cypher: string) => void;
  disabled?: boolean;
}

export function QueryTemplateBar({ onSelect, disabled }: QueryTemplateBarProps) {
  const { token } = useToken();
  const [pendingTemplate, setPendingTemplate] = useState<QueryTemplate | null>(null);
  const [paramValue, setParamValue] = useState('');

  const handlePick = (tpl: QueryTemplate) => {
    if (tpl.paramHint) {
      setPendingTemplate(tpl);
      setParamValue('');
    } else {
      onSelect(resolveTemplate(tpl));
    }
  };

  const handleConfirm = () => {
    if (!pendingTemplate) return;
    onSelect(resolveTemplate(pendingTemplate, paramValue));
    setPendingTemplate(null);
    setParamValue('');
  };

  const menuItems = QUERY_TEMPLATES.map((tpl, i) => ({
    key: String(i),
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Tag color={CATEGORY_COLORS[tpl.category]} style={{ margin: 0, fontSize: 10 }}>
          {tpl.category}
        </Tag>
        <span style={{ fontSize: 12 }}>{tpl.label}</span>
      </span>
    ),
    onClick: () => handlePick(tpl),
  }));

  return (
    <>
      <Dropdown menu={{ items: menuItems }} trigger={['click']} disabled={disabled}>
        <Button
          size="small"
          icon={<ThunderboltOutlined />}
          style={{ fontSize: 11, color: token.colorTextSecondary }}
        >
          Templates
        </Button>
      </Dropdown>

      <Modal
        title={`Enter ${pendingTemplate?.paramHint?.label ?? 'parameter'}`}
        open={pendingTemplate !== null}
        onOk={handleConfirm}
        onCancel={() => setPendingTemplate(null)}
        okText="Run"
        okButtonProps={{ disabled: !paramValue.trim() }}
        destroyOnClose
        width={400}
      >
        <Input
          autoFocus
          placeholder={pendingTemplate?.paramHint?.placeholder}
          value={paramValue}
          onChange={(e) => setParamValue(e.target.value)}
          onPressEnter={() => paramValue.trim() && handleConfirm()}
          style={{ fontFamily: 'monospace' }}
        />
        <div style={{ marginTop: 8, fontSize: 11, color: token.colorTextSecondary }}>
          Query: <code>{pendingTemplate?.cypher}</code>
        </div>
      </Modal>
    </>
  );
}
