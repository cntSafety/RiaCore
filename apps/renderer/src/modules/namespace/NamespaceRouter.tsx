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
import { lazy, Suspense } from 'react';
import { Empty, Spin } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import type { NamespaceContext } from '../../store/workspaceStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { SafetyMetamodelContext } from './editors/safety-analysis/hooks/safetyMetamodelContext';

// Lazy-loaded editors by owningApplication key
const NS_EDITOR_MAP: Record<string, React.LazyExoticComponent<React.ComponentType<{ ns: NamespaceContext }>>> = {
  'Safety-Analysis': lazy(() =>
    import('./editors/safety-analysis/SafetyEditor').then((m) => ({ default: m.SafetyEditor }))
  ),
  'Requirements': lazy(() =>
    import('./editors/safety-analysis/RequirementsView').then((m) => ({ default: m.RequirementsView }))
  ),
  'Safety-Tasks': lazy(() =>
    import('./editors/safety-analysis/SafetyTasksView').then((m) => ({ default: m.SafetyTasksView }))
  ),
  'Review-Status': lazy(() =>
    import('./editors/safety-analysis/ReviewStatusView').then((m) => ({ default: m.ReviewStatusView }))
  ),
  'Tags-Overview': lazy(() =>
    import('./editors/safety-analysis/TagsOverviewView').then((m) => ({ default: m.TagsOverviewView }))
  ),
  'Model-Check': lazy(() =>
    import('./editors/safety-analysis/ModelCheckView').then((m) => ({ default: m.ModelCheckView }))
  ),
  'Status-Cards': lazy(() =>
    import('../safety-status/StatusCardsEditor').then((m) => ({ default: m.StatusCardsEditor }))
  ),
  // 'Automotive-SW-Arch' intentionally has no dedicated editor: AUTOSAR imported
  // namespaces fall through to GenericModelBrowserView, reusing the shared
  // safety tree (NamespaceTreePanel + CenterPanel) like SysML-v2 / Sphinx-needs.
};

/**
 * Editors that author safety-domain content (malfunctions, notes, tags,
 * requirements, safety tasks). They MUST only be mounted on authored
 * namespaces — opening them on an imported namespace would cause new
 * instances to be written into the wrong namespace.
 *
 * Mirrors the AUTHORED_ONLY_EDITORS list in `TopBar.tsx` and `NamespaceHeader.tsx`.
 * Both UI dropdowns hide these editors for imported namespaces, but a stale
 * `editorOverrides` entry persisted from before this guard existed could still
 * route an imported namespace here. This is the last-line defense.
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

const GenericModelBrowserView = lazy(() =>
  import('./editors/generic/GenericModelBrowserModal').then((m) => ({ default: m.GenericModelBrowserView }))
);

interface NamespaceRouterProps {
  ns: NamespaceContext;
}

export function NamespaceRouter({ ns }: NamespaceRouterProps) {
  const { editorOverrides } = useWorkspaceStore();
  const editorKey = editorOverrides[ns.namespaceId] ?? ns.owningApplication;
  const Editor = NS_EDITOR_MAP[editorKey] ?? GenericModelBrowserView;

  // Guard: refuse to mount safety-authoring editors on imported namespaces.
  // The dropdowns filter this case out, but a persisted override could
  // still route us here. Render an explanatory empty state instead.
  if (ns.role === 'imported' && AUTHORED_ONLY_EDITORS.has(editorKey)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Empty
            image={<WarningOutlined style={{ fontSize: 40, color: '#faad14' }} />}
            description={
              <div style={{ maxWidth: 480, textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  This editor authors safety content
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  &quot;{ns.name}&quot; is an imported namespace. Open the authored
                  safety namespace and pick this editor from there. Authoring
                  malfunctions, notes, tags, or requirements directly inside an
                  imported namespace is not allowed.
                </div>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', minHeight: 0 }}>
      <Suspense
        fallback={
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
            <Spin size="small" />
          </div>
        }
      >
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          <SafetyMetamodelContext.Provider value={ns.metamodel}>
            <Editor ns={ns} />
          </SafetyMetamodelContext.Provider>
        </div>
      </Suspense>
    </div>
  );
}
