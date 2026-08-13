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
import { App, ConfigProvider, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { riacoreTokens } from './tokens';

const getSystemDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * Resolve the actual antd canvas / text colors at the current theme so we can
 * push them to the main process for the next-launch splash. We use antd's
 * `getDesignToken` API to ask antd what it would compute given our tokens
 * + algorithm, then forward the relevant ones to main.
 */
function resolveThemeColors(dark: boolean): { backgroundColor: string; foregroundColor: string } {
  const token = theme.getDesignToken({
    algorithm: [dark ? theme.darkAlgorithm : theme.defaultAlgorithm, theme.compactAlgorithm],
    token: riacoreTokens,
  });
  // colorBgLayout is the page-level canvas. colorTextBase matches body text.
  // antd may emit `rgba(...)` strings; fall back to the dark/light defaults
  // so we always store a `#RRGGBB` (the splash CSS expects a hex literal).
  const isHex = (v: string | undefined): v is string => !!v && /^#[0-9a-fA-F]{6}$/.test(v);
  const fallback = dark
    ? { backgroundColor: '#141414', foregroundColor: '#e6e6e6' }
    : { backgroundColor: '#ffffff', foregroundColor: '#1f1f1f' };
  return {
    backgroundColor: isHex(token.colorBgLayout) ? token.colorBgLayout : fallback.backgroundColor,
    foregroundColor: isHex(token.colorTextBase) ? token.colorTextBase : fallback.foregroundColor,
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(getSystemDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Push the resolved theme colors to the main process whenever they change.
  // The main process persists the snapshot so the next launch can paint with
  // these exact colors before React mounts. See VS Code's `IPartsSplash`.
  const themeColors = useMemo(() => resolveThemeColors(dark), [dark]);
  useEffect(() => {
    try {
      window.riacore.window.persistTheme({
        isDark: dark,
        backgroundColor: themeColors.backgroundColor,
        foregroundColor: themeColors.foregroundColor,
      });
    } catch {
      // riacore preload may not be present in some test contexts.
    }
  }, [dark, themeColors]);

  return (
    <ConfigProvider
      theme={{
        algorithm: [
          dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          theme.compactAlgorithm,
        ],
        token: riacoreTokens,
        // NOTE: cssVar is intentionally omitted. When enabled, antd scopes CSS
        // variables to the ConfigProvider's own DOM element class, which means
        // portals rendered outside that subtree (message toasts, Modal.confirm,
        // notification popups) do not inherit the dark-mode tokens and fall back
        // to the default light theme. Without cssVar, antd injects styles into
        // <head> via CSS-in-JS (hash-based), which applies globally to all
        // portals regardless of where they mount in the DOM.
      }}
    >
      <App style={{ height: '100%' }}>
        {children}
      </App>
    </ConfigProvider>
  );
}
