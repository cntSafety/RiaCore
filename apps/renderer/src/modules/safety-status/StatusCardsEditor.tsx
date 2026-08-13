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
 * StatusCardsEditor — adapter that wraps StatusCardsView for the
 * NamespaceRouter editor interface (receives `ns: NamespaceContext`).
 *
 * No "Back" button needed — navigation is handled by the editor dropdown.
 */

import type { NamespaceContext } from '../../store/workspaceStore';
import { StatusCardsView } from './StatusCardsView';

interface StatusCardsEditorProps {
  ns: NamespaceContext;
}

export function StatusCardsEditor({ ns }: StatusCardsEditorProps) {
  return <StatusCardsView namespace={ns.name} onBack={() => {}} />;
}
