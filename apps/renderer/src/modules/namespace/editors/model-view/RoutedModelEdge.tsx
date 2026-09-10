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
 * RoutedModelEdge — a custom React Flow edge that draws an SVG polyline through
 * the ELK-computed bend points of its `EdgeSection`. When no section is present
 * it falls back to a straight path between the source and target handles so the
 * edge always stays visible.
 *
 * The visual encoding (stroke colour, stroke width, dashed styling, arrow
 * marker) is carried on `edge.data` / `markerEnd` and applied here, replacing
 * the encoding that previously lived on the default edge in `ModelViewCanvas`.
 *
 * ## Emphasis
 *
 * A route in a dense frame is one of a dozen near-parallel lines a couple of
 * dozen pixels apart, and no amount of spacing makes such a line traceable by
 * eye — measured on a six-input frame, twelve delegations share twelve lanes and
 * none of them overlaps, yet following one to the port it lands on is still
 * guesswork. So the diagram answers it on demand instead: clicking a route
 * emphasises it and mutes every other, and the two ends are marked so the ports
 * it joins can be read off directly.
 */
import { memo } from 'react';
import { BaseEdge, getStraightPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { EdgeSection } from '../safety-analysis/utils/elkLayout';

/**
 * How a route is drawn relative to the one the user has picked out.
 *
 * `undefined` is the resting state — nothing is selected, so nothing is
 * de-emphasised either. Muting every route whenever none is chosen would make the
 * whole canvas read as inactive.
 */
export type EdgeEmphasis = 'selected' | 'muted';

export interface RoutedModelEdgeData extends Record<string, unknown> {
  /** ELK-computed route. When absent, the edge falls back to a straight path. */
  section?: EdgeSection;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  emphasis?: EdgeEmphasis;
}

export type RoutedModelEdgeType = Edge<RoutedModelEdgeData, 'routed'>;

/** Build an SVG path visiting start -> each bend (in order) -> end. */
export function polylinePath(section: EdgeSection): string {
  const points = [section.startPoint, ...section.bendPoints, section.endPoint];
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
}

/**
 * Opacity of a route that is not the selected one.
 *
 * Low enough that the selected route reads as the only strong line on the canvas,
 * high enough that the rest is still legible as context — the point of picking one
 * route out is to see it *among* the others, not instead of them.
 */
const MUTED_OPACITY = 0.16;

/** Resting opacity, unchanged from before emphasis existed. */
const NORMAL_OPACITY = 0.8;

/** Extra stroke the selected route gains, and the width of the halo behind it. */
const SELECTED_EXTRA_WIDTH = 1.25;
const HALO_EXTRA_WIDTH = 9;

/**
 * Radius of the dot marking each end of the selected route.
 *
 * The route already terminates at the port's own border coordinate, so the dot
 * lands on the pin. It exists because the *arrowhead* only marks the target end,
 * and "where does this line start" is half the question being asked.
 */
const ENDPOINT_DOT = 3.5;

/**
 * Width of the invisible stroke that receives clicks.
 *
 * A 2.5px line is not a realistic click target, and the lanes are 24px apart, so
 * this is set just inside that: wide enough to hit without reaching into the
 * neighbouring route's territory.
 */
const INTERACTION_WIDTH = 20;

function RoutedModelEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
}: EdgeProps<RoutedModelEdgeType>) {
  const path = data?.section
    ? polylinePath(data.section)
    : getStraightPath({ sourceX, sourceY, targetX, targetY })[0];

  const emphasis = data?.emphasis;
  const selected = emphasis === 'selected';
  const width = (data?.strokeWidth ?? 2) + (selected ? SELECTED_EXTRA_WIDTH : 0);

  // Endpoints come from the section where there is one, so the dots sit exactly
  // where the route was anchored rather than at React Flow's handle coordinates,
  // which are the DOM's view of the same port and can differ by a pixel.
  const start = data?.section?.startPoint ?? { x: sourceX, y: sourceY };
  const end = data?.section?.endPoint ?? { x: targetX, y: targetY };

  return (
    <g data-edge-emphasis={emphasis ?? 'none'}>
      {/* A halo under the selected route, so it separates from the neighbours it
          runs parallel to even where they cross it. Drawn before the route and
          carrying no marker, so the arrowhead stays a single crisp shape. */}
      {selected && (
        <path
          d={path}
          fill="none"
          stroke={data?.stroke}
          strokeWidth={width + HALO_EXTRA_WIDTH}
          strokeOpacity={0.22}
          strokeLinecap="round"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={INTERACTION_WIDTH}
        style={{
          stroke: data?.stroke,
          strokeWidth: width,
          strokeDasharray: data?.strokeDasharray,
          strokeOpacity: emphasis === 'muted' ? MUTED_OPACITY : selected ? 1 : NORMAL_OPACITY,
          fill: 'none',
          cursor: 'pointer',
        }}
      />
      {selected && [start, end].map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={ENDPOINT_DOT}
          fill={data?.stroke}
          style={{ pointerEvents: 'none' }}
        />
      ))}
    </g>
  );
}

export const RoutedModelEdge = memo(RoutedModelEdgeImpl);
