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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { MoreOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { api } from '../api/riacore';
import type { ShowInTreePayload } from '@riacore/app-contracts';
import { formatShortcutHint } from '../lib/shortcutHints';

let nextTriggerId = 1;
let activeTriggerId: number | null = null;

interface ShowInTreeTriggerProps {
  /** Home location — where the element lives. Always provided. */
  homeTarget: { nodeId: number; namespace: string; concept: string };
  /** Reference location — where this element appears as a reference child. Optional. */
  referenceTarget?: { nodeId: number; namespace: string; concept: string };
  /**
   * Called when the user selects "Show in Tree" (and "Show Reference in Tree" by
   * default). When this and `onNavigateReference` are both undefined, the
   * component falls back to dispatching a cross-window navigation request via
   * `api.window.showInTree`.
   */
  onNavigate?: (nodeId: number, namespace: string, concept: string) => void;
  /**
   * Optional override for "Show Reference in Tree". When provided, this is called
   * instead of `onNavigate` when the user selects "Show Reference in Tree".
   * Use this when the reference navigation requires different logic (e.g. navigating
   * to a cross-namespace reference child that needs a host node context).
   */
  onNavigateReference?: (nodeId: number, namespace: string, concept: string) => void;
  /**
   * When provided, adds a "Show details" menu item that calls this callback.
   * Use this to show the element's detail page without navigating the tree.
   */
  onShowDetails?: () => void;
  /**
   * Extra menu entries appended after the navigation ones, with their ids
   * reported back through {@link onExtraItem}.
   *
   * This is how the model view offers its expansion actions on an element tile
   * (spec-view.md Phase 5.3) without every caller of this component growing a
   * prop for them. Ids are namespaced by the caller; the ids this component
   * owns (`showDetails`, `showInTree`, `showReferenceInTree`) are reserved and
   * an extra item claiming one is ignored, so a caller cannot silently shadow
   * navigation.
   */
  extraItems?: { id: string; label: string }[];
  /** Invoked with the selected {@link extraItems} id. */
  onExtraItem?: (id: string) => void;
  /**
   * The authored safety namespace. Included in cross-window dispatch payloads so
   * the spawn window knows which namespace to use for SafetyEditor mutations.
   */
  safetyNamespace?: string;
  children: React.ReactNode;
  /** Optional extra styles for the wrapper span (e.g. width: '100%' for full-width flex children). */
  wrapperStyle?: React.CSSProperties;
  /** When true, hides the hover kebab button. Context menu still works via right-click. */
  hideKebab?: boolean;
}

/**
 * ShowInTreeTrigger — right-click "Show in Tree" affordance for any element.
 *
 * Behaviour matrix (Requirement 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 12.2, 12.4–12.6):
 *
 * | onNavigate present | referenceTarget | onNavigateReference | Behaviour |
 * |---|---|---|---|
 * | yes | any        | any | In-place: invoke onNavigate (or onNavigateReference) in the current window |
 * | no  | undefined  | n/a | Cross-window: dispatch ShowInTreePayload with requestKind='home' to the spawn window |
 * | no  | defined    | n/a | Cross-window: dispatch ShowInTreePayload with the matching requestKind |
 *
 * In all cases, the menu, hover kebab, and concurrency guard are preserved.
 */
export function ShowInTreeTrigger({
  homeTarget,
  referenceTarget,
  onNavigate,
  onNavigateReference,
  onShowDetails,
  extraItems,
  onExtraItem,
  safetyNamespace,
  children,
  wrapperStyle,
  hideKebab,
}: ShowInTreeTriggerProps) {
  const navigatingRef = useRef<boolean>(false);
  const triggerIdRef = useRef<number | null>(null);
  if (triggerIdRef.current === null) {
    triggerIdRef.current = nextTriggerId++;
  }
  const [isHovered, setIsHovered] = useState(false);

  // Whether to dispatch cross-window via api.window.showInTree (no in-place callback).
  // Requirements: 12.2, 12.4
  const useCrossWindowDispatch = onNavigate === undefined;

  const dispatchCrossWindow = useCallback(async (requestKind: 'home' | 'reference') => {
    const payload: ShowInTreePayload = {
      homeTarget,
      referenceTarget,
      requestKind,
      safetyNamespace,
    };
    try {
      await api.window.showInTree(payload);
    } catch (err) {
      console.warn('[ShowInTreeTrigger] cross-window dispatch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [homeTarget, referenceTarget, safetyNamespace]);

  const dispatchNavigation = useCallback(async (requestKind: 'home' | 'reference') => {
    if (requestKind === 'home') {
      if (useCrossWindowDispatch) {
        await dispatchCrossWindow('home');
      } else {
        onNavigate?.(homeTarget.nodeId, homeTarget.namespace, homeTarget.concept);
      }
      return;
    }

    if (referenceTarget === undefined) return;
    if (useCrossWindowDispatch) {
      await dispatchCrossWindow('reference');
    } else {
      const refCallback = onNavigateReference ?? onNavigate;
      refCallback?.(referenceTarget.nodeId, referenceTarget.namespace, referenceTarget.concept);
    }
  }, [dispatchCrossWindow, homeTarget, onNavigate, onNavigateReference, referenceTarget, useCrossWindowDispatch]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTriggerId !== triggerIdRef.current || navigatingRef.current) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 't') return;

      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (
        target?.isContentEditable ||
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select'
      ) {
        return;
      }

      const requestKind = e.shiftKey ? 'reference' : 'home';
      if (requestKind === 'reference' && referenceTarget === undefined) return;

      e.preventDefault();
      e.stopPropagation();
      navigatingRef.current = true;
      void dispatchNavigation(requestKind).finally(() => {
        navigatingRef.current = false;
      });
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [dispatchNavigation, referenceTarget]);

  const handleContextMenu = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // prevent parent onContextMenu handlers (e.g. ReactFlow's onNodeContextMenu) from firing a second menu
    activeTriggerId = triggerIdRef.current;

    if (navigatingRef.current) return;

    const items: { id: string; label: string }[] = [];
    if (onShowDetails !== undefined) {
      items.push({ id: 'showDetails', label: 'Show details' });
    }
    items.push({ id: 'showInTree', label: `Show in Tree ${formatShortcutHint(['CmdOrCtrl'], 'T')}` });
    if (referenceTarget !== undefined) {
      items.push({ id: 'showReferenceInTree', label: `Show Reference in Tree ${formatShortcutHint(['CmdOrCtrl', 'Shift'], 'T')}` });
    }
    // Reserved ids stay with navigation: an extra item claiming one would
    // otherwise take over a menu entry the user reads as "Show in Tree".
    const reserved = new Set(items.map((item) => item.id));
    const extras = (extraItems ?? []).filter((item) => !reserved.has(item.id));
    items.push(...extras);

    navigatingRef.current = true;
    try {
      const selectedId = await api.contextMenu.show(items);
      if (selectedId === 'showDetails') {
        onShowDetails?.();
      } else if (selectedId === 'showInTree') {
        await dispatchNavigation('home');
      } else if (selectedId === 'showReferenceInTree' && referenceTarget !== undefined) {
        await dispatchNavigation('reference');
      } else if (selectedId !== null && extras.some((item) => item.id === selectedId)) {
        onExtraItem?.(selectedId);
      }
    } finally {
      navigatingRef.current = false;
    }
  };

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'context-menu', ...wrapperStyle }}
      onContextMenu={handleContextMenu}
      onFocus={() => {
        activeTriggerId = triggerIdRef.current;
      }}
      onBlur={() => {
        if (activeTriggerId === triggerIdRef.current) activeTriggerId = null;
      }}
      onMouseEnter={() => {
        activeTriggerId = triggerIdRef.current;
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        if (activeTriggerId === triggerIdRef.current) activeTriggerId = null;
        setIsHovered(false);
      }}
    >
      {children}
      {!hideKebab && (
        <Button
          type="text"
          size="small"
          icon={<MoreOutlined />}
          style={{
            position: 'absolute',
            top: 0,
            right: -20,
            opacity: isHovered ? 1 : 0,
            pointerEvents: isHovered ? 'auto' : 'none',
            padding: 0,
            height: 20,
            width: 20,
            minWidth: 20,
            lineHeight: 1,
          }}
          onClick={(e) => {
            e.stopPropagation();
            void handleContextMenu(e as unknown as MouseEvent);
          }}
        />
      )}
    </span>
  );
}
