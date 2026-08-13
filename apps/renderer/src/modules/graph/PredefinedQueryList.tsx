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
import { Input, Modal, theme, Typography } from 'antd';
import { RightOutlined, DownOutlined } from '@ant-design/icons';
import { QUERY_TEMPLATES, type QueryTemplate } from './queryTemplates';

const { useToken } = theme;
const { Text } = Typography;

export interface PredefinedQueryListProps {
  onSelect: (template: QueryTemplate, paramValue?: string) => void;
  disabled: boolean;
}

function groupByCategory(templates: QueryTemplate[]): Map<string, QueryTemplate[]> {
  return templates.reduce((map, tpl) => {
    const group = map.get(tpl.category) ?? [];
    group.push(tpl);
    map.set(tpl.category, group);
    return map;
  }, new Map<string, QueryTemplate[]>());
}

const CATEGORY_LABELS: Record<string, string> = {
  meta:              'Meta',
  universe:          'Universe',
  source:            'Source',
  'cross-namespace': 'Cross-Namespace',
  custom:            'Custom',
};

function TemplateItem({
  tpl,
  disabled,
  onClick,
}: {
  tpl: QueryTemplate;
  disabled: boolean;
  onClick: () => void;
}) {
  const { token } = useToken();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      title={tpl.label}
      onClick={() => { if (!disabled) onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '5px 16px 5px 24px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled
          ? token.colorTextDisabled
          : hovered
          ? token.colorText
          : token.colorTextSecondary,
        background: hovered && !disabled ? token.colorBgTextHover : 'transparent',
        borderRadius: token.borderRadiusSM,
        margin: '1px 4px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        transition: 'background 0.15s, color 0.15s',
        userSelect: 'none',
      }}
    >
      {tpl.label}
    </div>
  );
}

function CategorySection({
  category,
  templates,
  disabled,
  onSelect,
}: {
  category: string;
  templates: QueryTemplate[];
  disabled: boolean;
  onSelect: (tpl: QueryTemplate) => void;
}) {
  const { token } = useToken();
  const [open, setOpen] = useState(true);

  return (
    <div style={{ marginBottom: 2 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px 4px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ color: token.colorTextTertiary, fontSize: 9, lineHeight: 1 }}>
          {open ? <DownOutlined /> : <RightOutlined />}
        </span>
        <Text
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: token.colorTextSecondary,
          }}
        >
          {CATEGORY_LABELS[category] ?? category}
        </Text>
      </div>

      {open && templates.map((tpl) => (
        <TemplateItem
          key={tpl.label}
          tpl={tpl}
          disabled={disabled}
          onClick={() => onSelect(tpl)}
        />
      ))}
    </div>
  );
}

export function PredefinedQueryList({ onSelect, disabled }: PredefinedQueryListProps) {
  const { token } = useToken();
  const [pendingTemplate, setPendingTemplate] = useState<QueryTemplate | null>(null);
  const [paramValue, setParamValue] = useState('');

  const grouped = groupByCategory(QUERY_TEMPLATES);

  const handleSelect = (tpl: QueryTemplate) => {
    if (tpl.paramHint) {
      setPendingTemplate(tpl);
      setParamValue('');
    } else {
      onSelect(tpl);
    }
  };

  const handleConfirm = () => {
    if (!pendingTemplate) return;
    onSelect(pendingTemplate, paramValue.trim() || undefined);
    setPendingTemplate(null);
    setParamValue('');
  };

  const handleCancel = () => {
    setPendingTemplate(null);
    setParamValue('');
  };

  return (
    <>
      <div style={{ paddingTop: 4, paddingBottom: 8 }}>
        {Array.from(grouped.entries()).map(([category, templates]) => (
          <CategorySection
            key={category}
            category={category}
            templates={templates}
            disabled={disabled}
            onSelect={handleSelect}
          />
        ))}
      </div>

      <Modal
        title={`Enter ${pendingTemplate?.paramHint?.label ?? 'parameter'}`}
        open={pendingTemplate !== null}
        onOk={handleConfirm}
        onCancel={handleCancel}
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
