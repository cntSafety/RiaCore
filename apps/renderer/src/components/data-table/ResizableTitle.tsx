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
import { useCallback, useRef } from 'react';

export interface ResizableTitleProps extends React.HTMLAttributes<HTMLTableCellElement> {
  onResize?: (width: number) => void;
  width?: number;
}

export function ResizableTitle({ onResize, width: _width, children, className, style, ...rest }: ResizableTitleProps) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);
  const thRef = useRef<HTMLTableCellElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!onResize) return;
    e.preventDefault();
    e.stopPropagation();
    // Use configured width as the primary baseline so first left-drag does not
    // jump larger when table auto-layout stretches visible DOM widths.
    const domWidth = thRef.current ? thRef.current.getBoundingClientRect().width : 100;
    const baseWidth = _width ?? domWidth;
    startX.current = e.clientX;
    startWidth.current = baseWidth;
    dragging.current = true;
    handleRef.current?.classList.add('dragging');

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      const newWidth = Math.max(60, startWidth.current + delta);
      onResize(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      handleRef.current?.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [onResize, _width]);

  return (
    <th ref={thRef} className={`riacore-resizable-th${className ? ` ${className}` : ''}`} style={style} {...rest}>
      {children}
      {onResize && (
        <div
          ref={handleRef}
          className="riacore-resize-handle"
          onMouseDown={handleMouseDown}
        />
      )}
    </th>
  );
}
