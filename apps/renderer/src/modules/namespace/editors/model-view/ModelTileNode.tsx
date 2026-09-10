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
 *
 * A tile that other tiles are nested inside renders as a **frame**: the same
 * header and port rows, but sized to the box ELK grew around its children and
 * with an empty interior for them to sit in. Nothing about the children is drawn
 * here — React Flow renders a nested node as its own element positioned relative
 * to this one, so the frame only has to leave the room.
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
import { PORT_CONCEPTS, getAsilHexColor } from '../safety-analysis/components/diagramModel';
import {
  TILE_SOURCE_HANDLE,
  TILE_TARGET_HANDLE,
  expansionsFor,
  portSourceHandle,
  portTargetHandle,
  type ModelPort,
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

/**
 * Width a frame's own port column occupies just outside the border it sits
 * against — the pin plus its name. A longer name ellipsizes rather than widening
 * the column, so a frame's overhang is the same on every model and does not jump
 * about with the longest port name it happens to carry.
 */
export const PORT_LABEL_WIDTH = 150;

/**
 * Height a tile will occupy, computed the same way the DOM will lay it out.
 *
 * For a frame this is only the height of its own chrome — the header and its
 * port rows. What the frame *ends up* occupying is decided by ELK, which grows
 * it around its children; see `framePadding`.
 */
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
  /**
   * Whether other tiles are nested inside this one.
   *
   * A frame draws to the size React Flow gives it rather than to `TILE_WIDTH`,
   * because ELK grew it to fit its children. Its own port rows then span that
   * full width, which is what puts the pins on the frame's border — the interior
   * is not theirs to sit in, it belongs to the children.
   *
   * This is not read off `tile`: a tile knows its parent, not its children.
   */
  isFrame?: boolean;
  /**
   * Where ELK put this frame's own ports, keyed by port id, measured down from the
   * frame's top. Only a frame has them, and only after a layout has settled.
   *
   * A frame's pins cannot be laid out by CSS the way an ordinary tile's are: ELK
   * places them itself and does not honour the offsets it was handed for them (see
   * `ElkLayoutResult.portOffsets`), so a centred column disagrees with the routes
   * by over 100px. Given these, the column positions each row absolutely and the
   * pin lands exactly where its connector was anchored.
   */
  portOffsets?: Record<string, number>;
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
    tile, isFrame = false, portOffsets, presentation, safetyNamespace, onExpand,
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

  /**
   * Whether this tile *is* a port rather than an element exposing ports.
   *
   * `buildModelGraph` promotes a port to a tile of its own only when nothing that
   * exposes it is drawn, so the tile's own concept being a port concept is exactly
   * the boundary-stub case — no flag has to be threaded down for it. Its pins face
   * the border the route uses, which for a stub is the opposite of the border the
   * direction implies; see `pinSide`.
   */
  const isPortStub = PORT_CONCEPTS.has(tile.concept);

  const portRow = (port: ModelPort, placement: PortPlacement = 'inside') => (
    <div
      key={port.id}
      style={{
        position: 'relative',
        height: PORT_ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: rowJustify(port.dir, placement),
        padding: '0 4px',
        // Outside the border the column itself is click-through, so each row
        // takes its own events back — see `portColumn`.
        pointerEvents: placement === 'inside' ? undefined : 'auto',
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
        side={pinSide(port.dir, placement)}
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
  );

  /**
   * One border's worth of a frame's own ports, vertically centred and drawn
   * **outside** the frame.
   *
   * `justifyContent: center` over a band that starts below the header is exactly
   * the arithmetic `portRowOffsets` does, so the pins land where the layout
   * anchored the routes. Changing one without the other separates every
   * connector from its pin, which is why that function says so too.
   *
   * Outside, and this is the fix for a reported defect. A frame's route to one of
   * its own children is a *delegation*, which anchors at the border the port faces
   * and then runs **inward** — see `anchorSide`. With the column inside, that route
   * sets off along the port's own row at the port's own y, straight through the
   * 150px of label text sitting there, and every port name on the frame was drawn
   * with a line through it. Nothing keeps an edge out of that band: `framePadding`
   * reserves it against child *nodes* only.
   *
   * Putting the label on the far side of the border removes the collision by
   * construction rather than by clearance, because the route and the text are now
   * on opposite sides of the line the route starts from. The pin stays *on* the
   * border — the column is laid out so the square is its innermost element (see
   * `pinSide`) — so the connector still visibly terminates at its pin.
   *
   * Only the horizontal placement changes. `top`/`bottom`/`justifyContent` are
   * untouched, so `portRowOffsets` remains correct and no route coordinate moves.
   *
   * The column is click-through, with each row taking its own events back. It now
   * overhangs whatever lies beside the frame, and a 150px transparent strip that
   * swallowed drags on a neighbouring tile — or on the pane behind it, blocking
   * panning — would be a worse defect than the one being fixed.
   */
  function portColumn(side: 'west' | 'east') {
    const ports = tile.ports.filter((port) => (side === 'west' ? port.dir === 'in' : port.dir === 'out'));
    if (ports.length === 0) return null;
    const placement: PortPlacement = side === 'west' ? 'outside-west' : 'outside-east';
    // ELK placed these ports and the routes were anchored at its offsets, so each
    // row is pinned to its own y rather than centred as a stack. Only when every
    // port has an offset — a partial map would draw some rows from one geometry
    // and some from another, which is worse than either.
    const placed = portOffsets !== undefined && ports.every((port) => portOffsets[port.id] !== undefined);
    if (placed) {
      return (
        <div
          data-port-column={side}
          data-port-column-placed="true"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [side === 'west' ? 'right' : 'left']: '100%',
            width: PORT_LABEL_WIDTH,
            pointerEvents: 'none',
          }}
        >
          {ports.map((port) => (
            <div
              key={port.id}
              style={{
                position: 'absolute',
                // `portOffsets` is the row's centre, which is what a route
                // terminates at; the row is half its height taller than that.
                top: portOffsets![port.id] - PORT_ROW_HEIGHT / 2,
                [side === 'west' ? 'right' : 'left']: 0,
                width: PORT_LABEL_WIDTH,
              }}
            >
              {portRow(port, placement)}
            </div>
          ))}
        </div>
      );
    }
    return (
      // The attribute is the seam `portRowOffsets` is verified against: these four
      // style properties *are* the formula, so a test can hold them to it.
      <div
        data-port-column={side}
        style={{
          position: 'absolute',
          top: HEADER_HEIGHT,
          bottom: 0,
          // `100%` of the frame's own width, so the column sits flush against the
          // outside of the border it belongs to whatever ELK sized the frame.
          [side === 'west' ? 'right' : 'left']: '100%',
          width: PORT_LABEL_WIDTH,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        {ports.map((port) => portRow(port, placement))}
      </div>
    );
  }

  return (
    <div
      aria-label={tile.isFocus ? `${tile.name} — focus` : tile.name}
      style={{
        // A frame fills the box React Flow sized from ELK's layout; an ordinary
        // tile sizes itself, because nothing else knows its height.
        width: isFrame ? '100%' : TILE_WIDTH,
        height: isFrame ? '100%' : undefined,
        borderRadius: 10,
        border: `${tile.isFocus ? 2 : 1}px solid ${borderColor}`,
        // The frame's interior reads as *behind* its children, so it takes the
        // page's own fill rather than a container surface competing with theirs.
        background: isFrame ? token.colorBgLayout : token.colorBgContainer,
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
          // A frame always rules off its title, because below it is the interior
          // its children occupy rather than more of the same tile.
          borderBottom: isFrame || tile.ports.length > 0
            ? `1px solid ${token.colorBorderSecondary}`
            : undefined,
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

      {/* Port rows. An ordinary tile stacks them all under the header; a frame
          splits them onto the two borders — see `portColumn`. */}
      {isFrame ? (
        <>
          {portColumn('west')}
          {portColumn('east')}
        </>
      ) : tile.ports.length > 0 && (
        <div style={{ padding: `${TILE_PADDING}px 0` }}>
          {/* Called explicitly rather than passed by reference: `map` would hand
              the row index in as the placement. */}
          {tile.ports.map((port) => portRow(port, isPortStub ? 'boundary-stub' : 'inside'))}
        </div>
      )}
    </div>
  );
}

/**
 * Where a port row is drawn relative to the box that owns it.
 *
 * An ordinary tile stacks its rows `inside`, under the header. A frame puts each
 * direction's column on the outside of the border that direction faces — see
 * `portColumn`.
 */
type PortPlacement = 'inside' | 'outside-west' | 'outside-east' | 'boundary-stub';

/**
 * Which end of the row the pin square sits at.
 *
 * The square is the thing the connector terminates at, so it always has to be the
 * element nearest the border the route uses. Inside the box that is the side the
 * port faces; outside it is the opposite, because the row has crossed the border
 * and the innermost end is now the far one. `PortPin` already renders both orders.
 *
 * A **boundary stub** inverts the rule, because for a stub the port's direction and
 * the route's direction are opposites. A stub is a port of something not drawn —
 * typically a boundary port of the enclosing system, promoted to a tile when its
 * owner was hidden (see `ownerOfFocus`). An *input* of that enclosing system
 * carries its signal onward to whatever is on the canvas, so the stub is the
 * connection's **source** and `anchorSide` leaves it on the east border. A pin
 * placed by direction would sit on the west, at the far end of the row from the
 * wire, and the wire would cross the port's own name on its way out — which is how
 * `CC_Task100ms_Out` came to be drawn with a line struck through it.
 */
function pinSide(dir: 'in' | 'out', placement: PortPlacement): 'left' | 'right' {
  if (placement === 'outside-west') return 'right';
  if (placement === 'outside-east') return 'left';
  if (placement === 'boundary-stub') return dir === 'in' ? 'right' : 'left';
  return dir === 'in' ? 'left' : 'right';
}

/** Push the row's content towards the border, which `pinSide` puts the square at. */
function rowJustify(dir: 'in' | 'out', placement: PortPlacement): 'flex-start' | 'flex-end' {
  if (placement === 'outside-west') return 'flex-end';
  if (placement === 'outside-east') return 'flex-start';
  if (placement === 'boundary-stub') return dir === 'in' ? 'flex-end' : 'flex-start';
  return dir === 'in' ? 'flex-start' : 'flex-end';
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
