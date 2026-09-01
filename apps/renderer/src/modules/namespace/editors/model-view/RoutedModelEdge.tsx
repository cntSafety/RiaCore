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
 */
import { memo } from 'react';
import { BaseEdge, getStraightPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { EdgeSection } from '../safety-analysis/utils/elkLayout';

export interface RoutedModelEdgeData extends Record<string, unknown> {
  /** ELK-computed route. When absent, the edge falls back to a straight path. */
  section?: EdgeSection;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
}

export type RoutedModelEdgeType = Edge<RoutedModelEdgeData, 'routed'>;

/** Build an SVG path visiting start -> each bend (in order) -> end. */
export function polylinePath(section: EdgeSection): string {
  const points = [section.startPoint, ...section.bendPoints, section.endPoint];
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
}

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

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: data?.stroke,
        strokeWidth: data?.strokeWidth,
        strokeDasharray: data?.strokeDasharray,
        strokeOpacity: 0.8,
        fill: 'none',
      }}
    />
  );
}

export const RoutedModelEdge = memo(RoutedModelEdgeImpl);
