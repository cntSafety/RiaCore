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
 * PortConnectorDiagram — the Diagram lens.
 *
 * Kept as the lens's entry point so `CenterPanel` and the model browser are
 * unchanged, but the diagram itself now lives in
 * `model-view/ModelViewCanvas.tsx` (spec-view.md Phase 5.3).
 *
 * What was here before was a fixed three-column grid — senders left, focus
 * centre, receivers right — with an SVG overlay that measured every port pin's
 * bounding rectangle and drew Bezier paths between them. It could show exactly
 * one thing, and the columns were the layout, so there was nothing to pan, zoom
 * or rearrange. The canvas that replaces it reproduces the same reading order
 * through an ELK left-to-right layout, and adds the three things the grid could
 * not have: a pannable and zoomable viewport, tiles the user can rearrange for
 * the current session, and expansion of an element's contained elements or
 * connections from its own menu.
 */

import { ModelViewCanvas } from '../../model-view/ModelViewCanvas';
import type { SelectedTreeElement } from '../types';

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
}

export function PortConnectorDiagram({
  selectedTreeElement,
  workspaceKey,
  safetyNamespace,
  onNavigateToNode,
  onNavigateToReference,
  onShowDetails,
}: PortConnectorDiagramProps) {
  return (
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
}
