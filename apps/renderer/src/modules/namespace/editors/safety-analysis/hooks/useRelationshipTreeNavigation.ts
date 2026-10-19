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
import { App } from 'antd';
import { useCallback, useRef } from 'react';
import type { ScopedTreeNavigator, SelectedTreeElement } from '../types';

/** Always navigate in place through the scope-checked tree adapter. */
export function useRelationshipTreeNavigation(onShowInTree?: ScopedTreeNavigator) {
  const { message } = App.useApp();
  const navigating = useRef(false);
  return useCallback(async (target: SelectedTreeElement) => {
    if (navigating.current) return;
    navigating.current = true;
    try {
      const result = await onShowInTree?.(target);
      if (!result) void message.info('Tree navigation is not available in this view.');
      else if (result.status !== 'selected') void message.info(result.message);
    } catch {
      void message.error('Could not locate this element in the current tree. Please try again.');
    } finally {
      navigating.current = false;
    }
  }, [message, onShowInTree]);
}
