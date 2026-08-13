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
 * provisioning-service.ts — Creates a new import source from an importer's
 * bundled config template. Stores the full config_data on the Source node
 * in the DB as the primary artifact. Optionally writes a YAML file for reference.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProvisionConfigParams, ProvisionConfigResult, ImportConfigData } from '@riacore/app-contracts';
import type { Result } from '@riacore/app-contracts';
import type { IImporterRegistry } from './importer-registry.js';
import type { IDbModule } from '../db/db-module.js';

/** Escape single quotes for inline Cypher string literals. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export interface IProvisioningService {
  provisionConfig(params: ProvisionConfigParams): Promise<Result<ProvisionConfigResult>>;
}

export function createProvisioningService(registry: IImporterRegistry, dbModule?: IDbModule): IProvisioningService {
  return {
    async provisionConfig(params: ProvisionConfigParams): Promise<Result<ProvisionConfigResult>> {
      const { importerName, workingDir, overwrite = false } = params;

      // 1. Resolve descriptor
      const descriptor = registry.findByName(importerName);
      if (!descriptor) {
        return { ok: false, error: `No importer found with name '${importerName}'` };
      }

      // 2. Check template path exists on descriptor
      if (!descriptor.configTemplatePath) {
        return { ok: false, error: `Importer '${importerName}' does not support config provisioning` };
      }

      // 3. Read template
      let templateContent: string;
      try {
        templateContent = fs.readFileSync(descriptor.configTemplatePath, 'utf-8');
      } catch {
        return { ok: false, error: `Config template not found: ${descriptor.configTemplatePath}` };
      }

      // 4. Substitute common placeholders where present (normalise to forward slashes)
      const normalizedDir = workingDir.replace(/\\/g, '/');
      // Only inject workingDir into project_dir when the template has a non-empty
      // placeholder value ("." means "use workspace dir as starting point").
      // Templates that leave project_dir blank ("") intentionally require the user
      // to set it themselves (e.g. via the Config UI browse button).
      const projectDirMatch = templateContent.match(/^project_dir:\s*"?([^"\n]*)"?\s*$/m);
      const templateProjectDir = projectDirMatch ? projectDirMatch[1].trim() : '';
      let substituted = templateProjectDir && templateProjectDir !== ''
        ? templateContent.replace(
            /^project_dir:.*$/m,
            `project_dir: "${normalizedDir}"`,
          )
        : templateContent;
      if (params.namespace) {
        substituted = substituted.replace(
          /^namespace:.*$/m,
          `namespace: ${params.namespace}`,
        );
      }

      // 5. Parse substituted template into ImportConfigData
      let parsed: Record<string, unknown>;
      try {
        parsed = parseYaml(substituted) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      const files = (parsed.files ?? {}) as { include?: unknown[]; exclude?: unknown[] };
      const isArxmlSource = descriptor.sourceType === 'arxml_file';
      const configData: ImportConfigData = {
        namespace: typeof parsed.namespace === 'string' ? parsed.namespace : (params.namespace ?? ''),
        source_name: typeof parsed.source_name === 'string' ? parsed.source_name : (params.namespace ?? importerName),
        project_dir: typeof parsed.project_dir === 'string' ? parsed.project_dir : (isArxmlSource ? normalizedDir : undefined),
        scan_result_dir: typeof parsed.scan_result_dir === 'string' ? parsed.scan_result_dir : undefined,
        files_include: Array.isArray(files.include) ? files.include.map(String) : (isArxmlSource ? ['**/*.arxml'] : []),
        files_exclude: Array.isArray(files.exclude) ? files.exclude.map(String) : [],
        elements: (parsed.elements && typeof parsed.elements === 'object') ? parsed.elements as Record<string, boolean> : {},
        sourceType: descriptor.sourceType,
      };

      // 6. Create Source node in DB with config_data
      const sourceId = `${descriptor.sourceType}::${configData.namespace}`;
      let configPath: string | undefined;

      if (dbModule) {
        const now = new Date().toISOString();
        const configDataJson = JSON.stringify(configData);
        const sourceMetaJson = JSON.stringify({ configDirty: true });

        const existing = await dbModule.runQuery(
          `MATCH (s:RIA_SRC_Source) WHERE s.source_id = $sourceId RETURN count(s) AS cnt`,
          { sourceId },
        );

        if (Number(existing[0]?.cnt ?? 0) === 0) {
          await dbModule.runQuery(
            `CREATE (:RIA_SRC_Source {
              source_id: '${esc(sourceId)}',
              name: '${esc(configData.source_name)}',
              source_type: '${esc(descriptor.sourceType)}',
              target_namespace: '${esc(configData.namespace)}',
              target_metamodel: '',
              importer_version: '',
              config_data: '${esc(configDataJson)}',
              config: '${esc(sourceMetaJson)}',
              created_at: '${esc(now)}',
              updated_at: '${esc(now)}'
            })`,
          );
        } else if (!overwrite) {
          return {
            ok: false,
            error: `Source already exists: ${sourceId}. Use overwrite: true to replace it.`,
          };
        } else {
          await dbModule.runQuery(
            `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${esc(sourceId)}'
             SET s.config_data = '${esc(configDataJson)}',
                 s.config = '${esc(sourceMetaJson)}',
                 s.name = '${esc(configData.source_name)}',
                 s.updated_at = '${esc(now)}'`,
          );
        }
      }

      // 7. Optionally write YAML file for reference
      const outputDir = path.join(workingDir, 'ria-config', 'importer-config', importerName);
      fs.mkdirSync(outputDir, { recursive: true });

      const safeName = params.namespace
        ? params.namespace.replace(/[^a-zA-Z0-9_-]/g, '_')
        : null;
      const configFileName = safeName
        ? `${importerName}-${safeName}-import-config.yaml`
        : `${importerName}-import-config.yaml`;
      const yamlPath = path.join(outputDir, configFileName);

      if (overwrite || !fs.existsSync(yamlPath)) {
        try {
          fs.writeFileSync(yamlPath, substituted, 'utf-8');
          configPath = yamlPath;
        } catch {
          // YAML write is optional — DB record is the primary artifact
        }
      } else {
        configPath = yamlPath;
      }

      if (dbModule && configPath) {
        const sourceMetaWithPath = JSON.stringify({ configPath, configDirty: true });
        await dbModule.runQuery(
          `MATCH (s:RIA_SRC_Source) WHERE s.source_id = '${esc(sourceId)}'
           SET s.config_path = '${esc(configPath)}',
               s.config = '${esc(sourceMetaWithPath)}'`,
        );
      }

      // 9. Ensure a stub RIA_UNIV_Namespace node exists for this import so that
      //    the user can create connections before running the first import (#52).
      //    The stub carries role='imported'; the real import will MERGE/SET its
      //    properties when it runs, so this is fully idempotent.
      if (dbModule) {
        await dbModule.runQuery(
          `MERGE (ns:RIA_UNIV_Namespace {name: '${esc(configData.namespace)}'})
           ON CREATE SET ns.namespace_role = 'imported',
                         ns.metamodel = '',
                         ns.namespace_owning_application = ''
           ON MATCH SET  ns.namespace_role = coalesce(ns.namespace_role, 'imported')`,
        );
      }

      // 10. Return success with sourceId
      return { ok: true, data: { ok: true, sourceId, configPath } };
    },
  };
}
