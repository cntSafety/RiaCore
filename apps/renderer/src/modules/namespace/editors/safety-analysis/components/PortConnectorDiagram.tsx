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
/**
 * Model lens entry point. Individual Sphinx needs use a one-hop relationship
 * diagram after checking their source namespace's metamodel. Documents, SysML,
 * and ARXML retain the existing CommonModel containment/port canvas.
 */

import { ModelViewCanvas } from '../../model-view/ModelViewCanvas';
import { Alert, Button, Spin } from 'antd';
import type { ReactNode } from 'react';
import { useNamespaces } from '../../../../../hooks/useNamespaces';
import { useWorkspaceQueryEnabled } from '../../../../../hooks/useWorkspaceQueryEnabled';
import { SphinxRelationshipDiagram } from './SphinxRelationshipDiagram';
import { isSphinxNeedConcept, usesSphinxRelationshipModel } from '../utils/sphinxRelationshipGraph';
import type { SelectedTreeElement, ScopedTreeNavigator } from '../types';

export interface PortConnectorDiagramProps {
  selectedTreeElement: SelectedTreeElement;
  workspaceKey: string | null;
  /** The authored safety namespace (where malfunctions live). */
  safetyNamespace?: string;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  /** Navigation callback for "Show Reference in Tree". */
  onNavigateToReference?: (refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string) => void;
  /** Called when the user selects "Show details" on an element tile. */
  onShowDetails?: () => void;
  /** Scope-checked in-place navigation, also used by the Details relationship table. */
  onShowInTree?: ScopedTreeNavigator;
}

export function PortConnectorDiagram({
  selectedTreeElement,
  workspaceKey,
  safetyNamespace,
  onNavigateToNode,
  onNavigateToReference,
  onShowDetails,
  onShowInTree,
}: PortConnectorDiagramProps) {
  const model = (
    <ModelViewCanvas
      // Remounting on selection change keeps the canvas from carrying one
      // element's expansions, hand-placed tiles and viewport into the next.
      key={`${selectedTreeElement.namespace}#${selectedTreeElement.nodeId}`}
      namespace={selectedTreeElement.namespace}
      nodeId={selectedTreeElement.nodeId}
      workspaceKey={workspaceKey}
      safetyNamespace={safetyNamespace}
      onNavigateToNode={onNavigateToNode}
      onNavigateToReference={onNavigateToReference}
      onShowDetails={onShowDetails}
    />
  );
  // Only candidate need concepts resolve metadata here. The SysML/ARXML path
  // mounts exactly the existing canvas without another query or layout setting.
  if (!isSphinxNeedConcept(selectedTreeElement.concept)) return model;
  return (
    <SphinxNeedModelRoute
      key={`${workspaceKey}:${selectedTreeElement.namespace}#${selectedTreeElement.nodeId}`}
      selectedTreeElement={selectedTreeElement}
      workspaceKey={workspaceKey}
      onShowInTree={onShowInTree}
      onShowDetails={onShowDetails}
      fallback={model}
    />
  );
}

function SphinxNeedModelRoute({ fallback, ...props }: Pick<PortConnectorDiagramProps, 'selectedTreeElement' | 'workspaceKey' | 'onShowInTree' | 'onShowDetails'> & { fallback: ReactNode }) {
  const workspaceEnabled = useWorkspaceQueryEnabled();
  const enabled = workspaceEnabled && props.workspaceKey !== null;
  const namespaces = useNamespaces(enabled, props.workspaceKey);
  if (!enabled) return <Alert type="info" title="Open a workspace to view relationships" />;
  if (namespaces.isError) return <Alert type="error" title="Could not resolve the source namespace" action={<Button onClick={() => { void namespaces.refetch(); }}>Retry</Button>} />;
  if (namespaces.isPlaceholderData || namespaces.isPending) return <div style={{ margin: 'auto' }}><Spin /></div>;
  const metamodel = namespaces.data?.find(item => item.name === props.selectedTreeElement.namespace)?.metamodel;
  return usesSphinxRelationshipModel(metamodel, props.selectedTreeElement.concept)
    ? <SphinxRelationshipDiagram {...props} />
    : fallback;
}
