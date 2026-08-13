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
import type { MetamodelProfileMetadata, MetamodelRenderingConfig } from '@riacore/app-contracts';
import type { createRegistry } from '../channel-registry.js';

/**
 * Register metamodel channels: getRenderingConfig.
 * All require an open workspace.
 *
 * Kept separate from the already-overloaded `namespace-channels.ts` so
 * metamodel-layer concerns live in one place.
 */
export function registerMetamodelChannels(
  registry: ReturnType<typeof createRegistry>,
): void {
  // ── metamodel.getProfileMetadata ────────────────────────────────────────────
  // Returns the normalized LinkML metadata snapshot persisted at registration.
  registry.register('metamodel.getProfileMetadata', async (payload, deps, _ctx) => {
    const rows = await deps.dbModule.runQuery(
      `MATCH (m:RIA_META_Metamodel)
       WHERE m.name = $metamodel
       RETURN m.profile_metadata AS metadata`,
      { metamodel: payload.metamodel },
    );
    if (rows.length === 0) {
      throw new Error(`Metamodel "${payload.metamodel}" is not registered`);
    }

    const raw = rows[0]?.metadata;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`Metamodel "${payload.metamodel}" has no profile metadata snapshot`);
    }

    const parsed = JSON.parse(raw) as Partial<MetamodelProfileMetadata>;
    if (!parsed.schema || !Array.isArray(parsed.classes) ||
        !Array.isArray(parsed.slots) || !Array.isArray(parsed.enums)) {
      throw new Error(`Metamodel "${payload.metamodel}" has an invalid profile metadata snapshot`);
    }
    return parsed as MetamodelProfileMetadata;
  }, {
    requiresWorkspace: true,
    category: 'metamodel',
  });

  // ── metamodel.getRenderingConfig ─────────────────────────────────────────────
  // Returns the per-concept rendering config (icon/color/hidden) persisted on
  // RIA_META_Concept for a given metamodel. The persistor stores '' as the
  // "absent" sentinel for icon/color and a real boolean for hidden, so we omit
  // empty icon/color (renderer applies its fallback) and coerce hidden.
  registry.register('metamodel.getRenderingConfig', async (payload, deps, _ctx) => {
    const { metamodel } = payload;

    let rows: Record<string, unknown>[];
    try {
      rows = await deps.dbModule.runQuery(
        `MATCH (c:RIA_META_Concept)
         WHERE c.metamodel = $metamodel
         RETURN c.name AS name,
                c.render_icon AS icon,
                c.render_color AS color,
                c.render_hidden AS hidden`,
        { metamodel },
      );
    } catch (err) {
      // Backward-compatibility for pre-1.1.0 workspaces: the render_icon /
      // render_color / render_hidden columns were added to RIA_META_Concept
      // without a SCHEMA_VERSION bump, so an existing DB built by older code
      // lacks them and the binder rejects the query ("Cannot find property
      // render_icon for c"). Rather than blocking the whole namespace tree,
      // fall back to a name-only query and let the renderer apply its default
      // icons/colors. A proper fix (rebuild the DB from ria-data) is triggered
      // by bumping SCHEMA_VERSION — see WorkspaceLifecycle.md.
      const message = err instanceof Error ? err.message : String(err);
      const isMissingRenderColumn = /Cannot find property\s+render_(icon|color|hidden)/i.test(message);
      if (!isMissingRenderColumn) throw err;

      const nameRows = await deps.dbModule.runQuery(
        `MATCH (c:RIA_META_Concept)
         WHERE c.metamodel = $metamodel
         RETURN c.name AS name`,
        { metamodel },
      );
      const fallback: MetamodelRenderingConfig = {};
      for (const row of nameRows) {
        // No persisted rendering config on this legacy schema → defaults only.
        fallback[String(row.name)] = { hidden: false };
      }
      return fallback;
    }

    const config: MetamodelRenderingConfig = {};
    for (const row of rows) {
      const icon = String(row.icon ?? '');
      const color = String(row.color ?? '');
      config[String(row.name)] = {
        ...(icon ? { icon } : {}),   // omit when '' (Req 6.2)
        ...(color ? { color } : {}), // omit when '' (Req 6.3)
        hidden: Boolean(row.hidden), // Req 4.5 / 6.4
      };
    }
    return config;
  }, {
    requiresWorkspace: true,
    category: 'metamodel',
  });
}
