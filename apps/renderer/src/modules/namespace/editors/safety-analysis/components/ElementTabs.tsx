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
import { Badge, Tabs, theme } from 'antd';

export interface TabDefinition {
  key: string;
  label: string;
  /** When > 0, a count badge is shown next to the label. Undefined or 0 means no badge. */
  count?: number;
}

export interface ElementTabsProps {
  tabs: TabDefinition[];
  activeTab: string;
  onTabChange: (key: string) => void;
}

/**
 * A stateless horizontal tab bar with optional count badges.
 * Tab state is managed by the parent CenterPanel.
 *
 * Validates: Requirements 3.1, 3.9, 4.1, 9.3
 */
export function ElementTabs({ tabs, activeTab, onTabChange }: ElementTabsProps) {
  const { token } = theme.useToken();

  const items = tabs.map((tab) => ({
    key: tab.key,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {tab.label}
        {(tab.count ?? 0) > 0 && (
          <Badge
            count={tab.count}
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
  }));

  return (
    <Tabs
      activeKey={activeTab}
      onChange={onTabChange}
      type="line"
      size="small"
      items={items}
      className="ria-scope"
      style={{ background: token.colorBgContainer }}
      tabBarStyle={{ margin: '0 16px', marginBottom: 0 }}
    />
  );
}
