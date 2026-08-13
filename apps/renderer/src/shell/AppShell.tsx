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
import { Layout, theme } from 'antd';
import { TopBar } from './TopBar';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { BottomPanel } from './BottomPanel';
import { useWorkspaceStore, type NamespaceContext } from '../store/workspaceStore';

const { Sider, Content } = Layout;
const { useToken } = theme;

interface AppShellProps {
  children: React.ReactNode;
  showTopBar?: boolean;
  showSidebar?: boolean;
  onSelectNamespace?: (ns: NamespaceContext) => void;
  onNavigateHome?: () => void;
  onOpenAppLogs?: () => void;
  onOpenWorkspaceLogs?: () => void;
}

export function AppShell({
  children,
  showTopBar = true,
  showSidebar = true,
  onSelectNamespace,
  onNavigateHome,
  onOpenAppLogs,
  onOpenWorkspaceLogs,
}: AppShellProps) {
  const { token } = useToken();
  const { sidebarWidth } = useWorkspaceStore();

  return (
    <Layout style={{ height: '100%', overflow: 'hidden' }}>
      {showTopBar && (
        <TopBar onNavigateHome={onNavigateHome} />
      )}

      <Layout style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {showSidebar && (
          <Sider
            width={sidebarWidth}
            style={{
              background: token.colorBgContainer,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
              overflow: 'hidden',
            }}
          >
            <WorkspaceSidebar
              onSelectNamespace={onSelectNamespace}
              onNavigateHome={onNavigateHome}
            />
          </Sider>
        )}

        <Content
          style={{
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            background: token.colorBgLayout,
            minHeight: 0,
          }}
        >
          {children}
        </Content>
      </Layout>

      <BottomPanel onOpenAppLogs={onOpenAppLogs} onOpenWorkspaceLogs={onOpenWorkspaceLogs} />
    </Layout>
  );
}
