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
import { Tooltip } from 'antd';
import type { ActionPriorityLevel, ActionPriorityMetadata } from '@riacore/app-contracts';
import { resolveActionPriority } from '@riacore/app-contracts';
import { TagChip } from './TagChip';

/**
 * Renders the profile-configured Action Priority (AP) next to the legacy RPN
 * tag. AP is resolved on demand from the profile's table — see
 * docs/particular/SafetyImprove.md §2 — and is never persisted; this
 * component is the only place it is computed for display.
 *
 * Renders nothing when the profile has not migrated from RPN (no
 * `actionPriority` table) or when the risk rating is incomplete.
 */
export function ActionPriorityTag({
  actionPriority,
  severity,
  occurrence,
  detection,
}: {
  actionPriority: ActionPriorityMetadata | undefined;
  severity: string;
  occurrence: string;
  detection: string;
}) {
  const level = resolveActionPriority(actionPriority, severity, occurrence, detection);
  if (!level || !actionPriority) return null;

  const meta = actionPriority.levels[level as ActionPriorityLevel];
  return (
    <Tooltip title={meta?.description ?? 'Action Priority'}>
      <TagChip color={meta?.color} style={{ fontSize: 11, margin: 0, fontWeight: 600 }}>
        AP {meta?.label ?? level}
      </TagChip>
    </Tooltip>
  );
}
