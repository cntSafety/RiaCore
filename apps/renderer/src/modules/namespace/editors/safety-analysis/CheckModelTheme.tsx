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
import type { CSSProperties, ReactNode } from 'react';
import { ConfigProvider, theme } from 'antd';
import { useThemeMode } from '../../../../theme/ThemeProvider';
import './check-model.css';

const bodyFontSize = 14;
const supportingFontSize = 13;

/** Shared reading scale for every check, including its portalled result details. */
export function CheckModelTheme({ children }: { children: ReactNode }) {
  const mode = useThemeMode();
  return <ConfigProvider componentSize="middle" theme={{
    // The app's compact algorithm reduces the base font again. Use the standard
    // reading scale here while retaining the application's current colour mode.
    algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { fontSize: bodyFontSize, fontSizeSM: supportingFontSize },
    components: {
      Table: { cellFontSize: bodyFontSize, cellFontSizeMD: bodyFontSize, cellFontSizeSM: bodyFontSize, cellPaddingBlockMD: 10 },
      Tag: { fontSizeSM: bodyFontSize },
      Button: { fontSizeSM: bodyFontSize },
    },
  }}><CheckModelSurface>{children}</CheckModelSurface></ConfigProvider>;
}

function CheckModelSurface({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  const style = {
    '--ria-check-font-size': `${token.fontSize}px`,
    '--ria-check-fg': token.colorText,
    '--ria-check-muted': token.colorTextSecondary,
    '--ria-check-hover': token.colorBgTextHover,
    '--ria-check-active': token.colorPrimaryBg,
    '--ria-check-table-head': token.colorFillAlter,
    '--ria-check-accent': token.colorPrimary,
    fontSize: token.fontSize,
    fontFamily: token.fontFamily,
    lineHeight: token.lineHeight,
    color: token.colorText,
  } as CSSProperties;
  return <div className="ria-checks-surface ria-checks" style={style}>{children}</div>;
}
