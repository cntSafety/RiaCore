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
 * One element tile on the model-view canvas (spec-view.md Phase 5.3).
 *
 * A React Flow node rendering a `ModelTile`: a header carrying the element's
 * name, icon and menu, and one row per port it exposes. Ports are rows rather
 * than nodes of their own, so a component and its interface stay one draggable
 * object.
 *
 * The icon and colour come from the concept presentation catalog, so no
 * source-metamodel concept name appears here — `CommonModel` is the whole
 * vocabulary. Its `color` values are antd theme tokens, which is what lets the
 * tile resolve them through `theme.useToken()` instead of carrying a colour
 * table of its own.
 *
 * Every port row carries a source *and* a target React Flow handle, both
 * invisible, because which of the two a connection uses is decided by the role
 * the port plays in that connection rather than by its own direction — see
 * `modelGraph.ts`.
 */
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { theme, Tooltip } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  BlockOutlined,
  FileTextOutlined,
  FolderOutlined,
  LoginOutlined,
  LogoutOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ConceptPresentation } from '@riacore/app-contracts';
import { ShowInTreeTrigger } from '../../../../components/ShowInTreeTrigger';
import { PortPin } from '../safety-analysis/components/PortPin';
import { getAsilHexColor } from '../safety-analysis/components/diagramModel';
import {
  TILE_SOURCE_HANDLE,
  TILE_TARGET_HANDLE,
  expansionsFor,
  portSourceHandle,
  portTargetHandle,
  type ModelTile,
} from './modelGraph';

/** Tile width, shared with the layout so ELK reserves the right space. */
export const TILE_WIDTH = 260;
/**
 * Tile geometry constants, exported so the ELK-input helper (`modelElkInput.ts`)
 * derives port offsets and node heights from the same numbers the DOM lays the
 * tile out with. `tileHeight` and `portOffset` must agree, so these cannot drift.
 */
export const HEADER_HEIGHT = 40;
export const PORT_ROW_HEIGHT = 26;
export const TILE_PADDING = 10;

/** Height a tile will occupy, computed the same way the DOM will lay it out. */
export function tileHeight(tile: ModelTile): number {
  return HEADER_HEIGHT + TILE_PADDING + tile.ports.length * PORT_ROW_HEIGHT + TILE_PADDING;
}

/**
 * The icon identifiers the shipped catalog uses. An unknown identifier falls
 * back rather than failing: the catalog is editable after deployment, and a
 * typo in it must not blank out the canvas.
 */
const ICONS: Record<string, React.ComponentType<{ style?: React.CSSProperties }>> = {
  BlockOutlined,
  FolderOutlined,
  AppstoreOutlined,
  FileTextOutlined,
  ApiOutlined,
  LoginOutlined,
  LogoutOutlined,
  SwapOutlined,
};

const EXPANSION_LABELS: Record<'contained' | 'connections', string> = {
  contained: 'Expand contained elements',
  connections: 'Expand connections',
};

/** Menu ids are namespaced so they cannot collide with the navigation entries. */
const expansionMenuId = (kind: 'contained' | 'connections') => `modelView.expand.${kind}`;

export interface ModelTileNodeData extends Record<string, unknown> {
  tile: ModelTile;
  presentation: ConceptPresentation[];
  /** The authored safety namespace, where malfunctions live. */
  safetyNamespace?: string;
  onExpand: (kind: 'contained' | 'connections', representativeId: string) => void;
  onNavigateToNode?: (nodeId: number, namespace: string, concept: string) => void;
  onNavigateToReference?: (
    refNodeId: number, refNamespace: string, refConcept: string, hostNodeId: number, hostNamespace: string,
  ) => void;
  onShowDetails?: () => void;
}

function ModelTileNodeImpl({ data }: NodeProps) {
  const { token } = theme.useToken();
  const {
    tile, presentation, safetyNamespace, onExpand,
    onNavigateToNode, onNavigateToReference, onShowDetails,
  } = data as ModelTileNodeData;

  // Port hover is local to the tile. It used to be canvas-level state carried
  // in every node's `data`, which meant moving the pointer across one port
  // rebuilt every node object on the canvas — and rebuilding a node object
  // mid-drag cancels the drag.
  const [hoveredPortId, setHoveredPortId] = useState<string | null>(null);

  const entry = presentation.find((p) => p.concept === tile.concept);
  const Icon = ICONS[entry?.icon ?? ''] ?? BlockOutlined;
  // Catalog colours are antd token names; an unrecognized one falls back to the
  // neutral secondary text token rather than rendering as a literal string.
  const accent = (token as unknown as Record<string, string>)[entry?.color ?? ''] ?? token.colorTextSecondary;

  // ASIL dominates the border when there are malfunctions, because that is the
  // thing the safety workflows are reading the diagram for. The focus tile is
  // otherwise distinguished by the accent colour and a heavier border.
  const asilHex = getAsilHexColor(tile.maxAsil);
  const borderColor = asilHex ?? (tile.isFocus ? token.colorInfo : token.colorBorder);

  const extraItems = expansionsFor(tile.concept).map((kind) => ({
    id: expansionMenuId(kind),
    label: EXPANSION_LABELS[kind],
  }));

  return (
    <div
      aria-label={tile.isFocus ? `${tile.name} — focus` : tile.name}
      style={{
        width: TILE_WIDTH,
        borderRadius: 10,
        border: `${tile.isFocus ? 2 : 1}px solid ${borderColor}`,
        background: token.colorBgContainer,
        boxShadow: tile.isFocus ? token.boxShadowSecondary ?? token.boxShadow : undefined,
        overflow: 'visible',
      }}
    >
      {/* Tile-level handles, used by Ownership edges. Invisible: they mark
          where an edge attaches, they are not connection affordances — the
          model view is read-only and draws no user-made edges. */}
      <Handle type="target" id={TILE_TARGET_HANDLE} position={Position.Left} style={HIDDEN_HANDLE} isConnectable={false} />
      <Handle type="source" id={TILE_SOURCE_HANDLE} position={Position.Right} style={HIDDEN_HANDLE} isConnectable={false} />

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: HEADER_HEIGHT,
          padding: '0 10px',
          borderBottom: tile.ports.length > 0 ? `1px solid ${token.colorBorderSecondary}` : undefined,
          background: token.colorFillAlter,
          borderRadius: '9px 9px 0 0',
        }}
      >
        <ShowInTreeTrigger
          homeTarget={{ nodeId: tile.nodeId, namespace: tile.namespace, concept: tile.sourceConcept }}
          onNavigate={onNavigateToNode}
          onShowDetails={onShowDetails}
          extraItems={extraItems}
          onExtraItem={(id) => {
            const kind = id === expansionMenuId('contained') ? 'contained'
              : id === expansionMenuId('connections') ? 'connections'
                : null;
            if (kind) onExpand(kind, tile.id);
          }}
          wrapperStyle={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}
          hideKebab
        >
          <Icon style={{ fontSize: 14, color: accent, flexShrink: 0 }} />
          <Tooltip title={tile.qualifiedName || tile.name} mouseEnterDelay={0.5}>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: tile.isFocus ? 600 : 500,
                color: token.colorText,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {tile.name}
            </span>
          </Tooltip>
        </ShowInTreeTrigger>
        {tile.warn && <WarningOutlined style={{ fontSize: 12, color: '#d4380d', flexShrink: 0 }} />}
      </div>

      {/* Port rows */}
      {tile.ports.length > 0 && (
        <div style={{ padding: `${TILE_PADDING}px 0` }}>
          {tile.ports.map((port) => (
            <div
              key={port.id}
              style={{
                position: 'relative',
                height: PORT_ROW_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                justifyContent: port.dir === 'in' ? 'flex-start' : 'flex-end',
                padding: '0 4px',
                // An exposed but unconnected port is dimmed rather than hidden:
                // "this component has a port nothing is wired to" is a finding,
                // not noise.
                opacity: port.connected ? 1 : 0.55,
              }}
            >
              <Handle
                type="target"
                id={portTargetHandle(port.id)}
                position={Position.Left}
                style={HIDDEN_HANDLE}
                isConnectable={false}
              />
              <PortPin
                id={port.id}
                name={port.name}
                dir={port.dir}
                warn={port.warn}
                asilColor={getAsilHexColor(port.maxAsil)}
                side={port.dir === 'in' ? 'left' : 'right'}
                refCb={() => { /* the SVG overlay this existed for is gone — React Flow routes edges */ }}
                hovered={hoveredPortId}
                onHover={setHoveredPortId}
                portTarget={{ nodeId: port.nodeId, namespace: tile.namespace, concept: port.sourceConcept }}
                malfunctions={port.malfunctions}
                malfunctionNamespace={safetyNamespace}
                onNavigateToNode={onNavigateToNode}
                onNavigateToReference={onNavigateToReference}
              />
              <Handle
                type="source"
                id={portSourceHandle(port.id)}
                position={Position.Right}
                style={HIDDEN_HANDLE}
                isConnectable={false}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Handles are anchors, not affordances. They keep a non-zero size because React
 * Flow measures them to route the edge, but carry no visible mark of their own —
 * the port pin beside them is what the user sees.
 */
const HIDDEN_HANDLE: React.CSSProperties = {
  width: 6,
  height: 6,
  minWidth: 6,
  minHeight: 6,
  border: 'none',
  background: 'transparent',
  opacity: 0,
  pointerEvents: 'none',
};

export const ModelTileNode = memo(ModelTileNodeImpl);
