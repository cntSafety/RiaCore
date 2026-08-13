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
 * Returns a bracket-notation keyboard shortcut hint suitable for appending to
 * a context-menu label, e.g. " [Ctrl+M]" on Windows/Linux or " [⌘M]" on macOS.
 *
 * Platform detection is performed at call time via window.navigator.platform
 * (not a build-time constant) so that a single bundle works across platforms.
 *
 * @param modifiers  Ordered array of modifier tokens. Use [] for no modifiers.
 * @param key        The main key character (e.g. "M", "T", "P").
 */
export function formatShortcutHint(
  modifiers: Array<'CmdOrCtrl' | 'Shift'>,
  key: string,
): string {
  const isMac = window.navigator.platform.startsWith('Mac');
  if (isMac) {
    const parts = modifiers.map((m) => (m === 'CmdOrCtrl' ? '⌘' : '⇧'));
    return `[${parts.join('')}${key}]`;
  } else {
    const parts = modifiers.map((m) => (m === 'CmdOrCtrl' ? 'Ctrl' : 'Shift'));
    return `[${[...parts, key].join('+')}]`;
  }
}
