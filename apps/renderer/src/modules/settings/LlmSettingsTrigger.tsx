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
 * LlmSettingsTrigger — small toolbar button that opens the top-level
 * `LlmSettingsDialog`.
 *
 * Feature: llm-component-review
 * Validates: Requirements 1.1
 *
 * The trigger is wired into the application chrome (top bar) so the user can
 * open the LLM Settings dialog from anywhere in the app, before any workspace
 * is opened. The button delegates to the singleton
 * `useLlmSettingsDialogStore` so other entry points (the "Open Settings"
 * shortcuts inside `LlmReviewModal`) can open the same dialog without any
 * prop-drilling — Requirements 4.8, 10.8.
 *
 * The button is intentionally minimal: an antd `SettingOutlined` icon
 * rendered as a `type="text"` button matching the existing Diff / Graph-Core
 * affordances in `TopBar.tsx`.
 */

import { Button } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useLlmSettingsDialogStore } from '../../store/llmSettingsDialogStore';

export function LlmSettingsTrigger() {
  const openDialog = useLlmSettingsDialogStore((s) => s.openDialog);

  return (
    <Button
      size="small"
      type="text"
      icon={<SettingOutlined />}
      onClick={openDialog}
      style={{ fontSize: 11 }}
      title="LLM Settings"
      aria-label="Open LLM Settings"
    >
      LLM
    </Button>
  );
}
