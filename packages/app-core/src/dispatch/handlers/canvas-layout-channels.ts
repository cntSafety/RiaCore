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
import type { DiagramLayout } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';
import { createLayoutService } from '../../namespaces/layout-service.js';

/**
 * Register the canvas-layout channels:
 *   - canvasLayout:getLayout
 *   - canvasLayout:setRecords
 *
 * Both require an open workspace. The backing {@link createLayoutService} returns
 * `Result<T>`; the IPC contract instead returns `T` directly and throws `Error` on
 * failure, so each handler unwraps the Result: throw `new Error(result.error)` on
 * failure, otherwise return `result.data`.
 *
 * `requiresWorkspace: true` is what enforces Req 1.7: a write (or read) issued while the
 * Workspace_Phase is not `db_open` is rejected by the dispatcher with a "requires an open
 * workspace" Error before the handler runs, so the stored Diagram_Layout is left
 * unchanged.
 */
export function registerCanvasLayoutChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── canvasLayout:getLayout ───────────────────────────────────────────────────
  // Return the complete current Diagram_Layout (empty array when no records exist). On
  // any retrieval failure throw and return no partial layout (Req 2.6).
  registry.register('canvasLayout:getLayout', async (_payload, deps, _ctx) => {
    const service = createLayoutService(deps.dbModule);
    const result = await service.getLayout();
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data satisfies DiagramLayout;
  }, {
    requiresWorkspace: true,
    category: 'canvasLayout',
  });

  // ── canvasLayout:setRecords ──────────────────────────────────────────────────
  // Upsert one or more Layout_Records (MERGE on the stable composite layout_id, SET
  // x,y). Rejects the whole batch if any record has a non-finite coordinate (Req 1.8),
  // leaving the stored Diagram_Layout unchanged. Returns the current layout.
  registry.register('canvasLayout:setRecords', async (payload, deps, _ctx) => {
    const { records } = payload;
    // DIAGNOSTIC (temporary): correlate layout-write timestamps against
    // persistor.store timestamps to investigate the intermittent
    // missing-tile/missing-connection bug on reopen. Remove once root-caused.
    console.log('[DIAG] canvasLayout:setRecords: requested', {
      ts: new Date().toISOString(),
      records: records.map((r) => `${r.elementKind}/${r.elementKey}@(${r.x},${r.y})`),
    });
    const service = createLayoutService(deps.dbModule);
    const result = await service.setRecords(records);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data satisfies DiagramLayout;
  }, {
    requiresWorkspace: true,
    category: 'canvasLayout',
  });
}
