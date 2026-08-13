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
import { useEffect } from 'react';

/**
 * Keyboard shortcuts scoped to the MalfunctionWorkspace / safety editor.
 *
 * Ctrl+N  → trigger "Add Malfunction" on the currently selected architecture node
 *
 * Only fires when the active element is NOT a text input/textarea/select,
 * so typing in a field is never intercepted.
 *
 * Notes:
 * - Ctrl+T (was "focus Task ghost row") was removed because Ctrl+T is
 *   now claimed by Edit > Show in Tree.
 * - The old Ctrl+N ("focus Note ghost row") has been repurposed: adding
 *   a new Malfunction is the primary keyboard action users need.
 */
export function useSectionShortcuts({
  onAddMalfunction,
}: {
  onAddMalfunction: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select'
        || (e.target as HTMLElement).isContentEditable;
      if (isEditable) return;

      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          onAddMalfunction();
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onAddMalfunction]);
}
