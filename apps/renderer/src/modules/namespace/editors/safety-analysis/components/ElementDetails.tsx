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
import type { CSSProperties, ReactNode } from 'react';
import { ConfigProvider, Empty, Typography, theme } from 'antd';
import { useThemeMode } from '../../../../../theme/ThemeProvider';
import { AsilTag } from './AsilTag';
import { parseAsilLevel } from '../config/asilColors';
import './element-details.css';

interface DetailField {
  key: string;
  label: string;
  value: string;
  safety?: boolean;
}

function labelFor(key: string) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function detailValue(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.map(String).map((value) => value.trim()).filter(Boolean).join(', ') || undefined;
  if (typeof raw === 'object') return Object.keys(raw).length ? JSON.stringify(raw) : undefined;
  return String(raw).trim() || undefined;
}

/** Promote only values actually rendered; unselected aliases and unknown fields stay accessible. */
function presentDetails(attributes: Record<string, unknown>, concept: string, heading?: string) {
  const used = new Set<string>();
  const take = (keys: string[], label: string, safety = false): DetailField | undefined => {
    for (const key of keys) {
      const raw = attributes[key];
      if (typeof raw !== 'string' && typeof raw !== 'number') continue;
      const value = String(raw).trim();
      if (!value) continue;
      used.add(key);
      return { key, label, value, safety };
    }
  };
  const summary = [
    take(['id'], 'ID'),
    take(['name', 'has_name', 'short_name', 'declared_name'], 'Name'),
    take(['type_name', 'type'], 'Type'),
    take(['sysml_type'], 'SysML Type'),
    take(['safety_level', 'req_asil', 'asil', 'malfunction_asil'], 'Safety Level', true),
    take(['status'], 'Status'),
  ].filter((field): field is DetailField => !!field);
  const location = take(['qualified_name', 'docname', 'stable_path', 'path'], 'Path');
  if (location?.key === 'qualified_name') location.label = 'Qualified name';
  if (location?.key === 'docname') location.label = 'Document';
  const section = location?.key === 'docname' ? take(['section_name'], 'Section') : undefined;

  let text: DetailField | undefined;
  for (const key of ['content', 'body', 'documentation', 'description', 'desc']) {
    if (typeof attributes[key] !== 'string' || !attributes[key].trim()) continue;
    const requirement = concept.includes('requirement') || concept === 'need_req' || attributes.type === 'req';
    text = take([key], key === 'content' && requirement ? 'Requirement text'
      : key === 'body' || key === 'documentation' ? 'Documentation'
        : key === 'content' ? 'Content' : 'Description');
    break;
  }
  // The header carries this value already. Keep title-only unknown elements inspectable too.
  if ((summary.length || location || text) && heading && typeof attributes.title === 'string'
    && attributes.title.trim() === heading.trim()) used.add('title');
  const additional = Object.entries(attributes).flatMap(([key, raw]) => {
    if (used.has(key)) return [];
    const value = detailValue(raw);
    return value === undefined ? [] : [{ key, label: labelFor(key), value }];
  });
  return { summary, location, section, text, additional };
}

export interface ElementDetailsProps {
  attributes: Record<string, unknown>;
  concept: string;
  namespace: string;
  /** The visible header title, used only to avoid repeating the same source title. */
  heading?: string;
  relationships?: ReactNode;
}

/** One reading scale and presentation for Details, View browsing and requirement previews. */
export function ElementDetails(props: ElementDetailsProps) {
  const mode = useThemeMode();
  return <ConfigProvider componentSize="middle" theme={{
    algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { fontSize: 14, fontSizeSM: 13 },
    components: {
      Table: { cellFontSize: 14, cellFontSizeMD: 14, cellFontSizeSM: 14 },
      Button: { fontSizeSM: 13 },
    },
  }}><DetailsContent {...props} /></ConfigProvider>;
}

function DetailsContent({ attributes, concept, namespace, heading, relationships }: ElementDetailsProps) {
  const { token } = theme.useToken();
  const { summary, location, section, text, additional } = presentDetails(attributes, concept, heading);
  const hasSummary = summary.length > 0 || !!location;
  const hasDetails = hasSummary || !!text || additional.length > 0;
  return <div className="ria-element-details" style={{
    fontSize: token.fontSize,
    fontFamily: token.fontFamily,
    lineHeight: token.lineHeight,
    color: token.colorText,
    '--ria-details-muted': token.colorTextSecondary,
    '--ria-details-fg': token.colorText,
    '--ria-details-font-size': `${token.fontSize}px`,
    '--ria-details-border': token.colorBorderSecondary,
    '--ria-details-fill': token.colorFillQuaternary,
    '--ria-details-table-head': token.colorFillAlter,
    '--ria-details-hover': token.colorBgTextHover,
    '--ria-details-focus': token.colorPrimary,
    '--ria-details-radius': `${token.borderRadius}px`,
  } as CSSProperties}>
    {(hasSummary || text) && <section aria-label="Element summary" className="ria-details-summary">
      {summary.length > 0 && <dl className="ria-details-identity">
        {summary.map((field) => <div key={field.key}>
          <dt>{field.label}</dt>
          <dd>{field.safety && parseAsilLevel(field.value) >= 0
            ? <AsilTag asil={field.value} fontSize={token.fontSize} />
            : field.value}</dd>
        </div>)}
      </dl>}
      {location && <div className="ria-details-location">
        <span className="ria-details-location-label">{location.label}</span>
        <Typography.Text copyable={{ text: location.value }} style={{ fontSize: token.fontSize, overflowWrap: 'anywhere', minWidth: 0 }}>
          {location.value}
        </Typography.Text>
      </div>}
      <div className="ria-details-source">{namespace}{section ? ` · ${section.value}` : ''}</div>
    </section>}
    {text && <section aria-label={text.label}>
      <h3>{text.label}</h3>
      <div className="ria-details-prose"><div>{text.value}</div></div>
    </section>}
    {relationships}
    {additional.length > 0 && <details className="ria-details-additional" open={!hasSummary && !text}>
      <summary>Additional properties <span className="ria-details-count">{additional.length} {additional.length === 1 ? 'field' : 'fields'}</span></summary>
      <dl className="ria-details-properties">
        {additional.map((field) => <div key={field.key}>
          <dt>{field.label}</dt><dd>{field.value}</dd>
        </div>)}
      </dl>
    </details>}
    {!hasDetails && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No details stored for this element" />}
  </div>;
}
