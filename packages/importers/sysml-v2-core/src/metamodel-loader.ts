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
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Per-concept tree rendering configuration declared in the LinkML metamodel.
 * All fields are optional; an omitted field is left absent rather than defaulted.
 */
export interface RenderingConfig {
  icon?: string; // ant-design icon component name, e.g. "BlockOutlined"
  color?: string; // any CSS color string, e.g. "#1677ff"
  hidden?: boolean;
}

export interface LinkMLClass {
  name: string;
  description?: string;
  is_abstract?: boolean;
  is_a?: string;
  identity_attribute?: string;
  attributes?: Record<string, LinkMLAttribute>;
  rendering?: RenderingConfig; // absent when the YAML omits the block
}

export interface LinkMLAttribute {
  name: string;
  required?: boolean;
  range?: string;
  multivalued?: boolean;
  description?: string;
}

export interface LinkMLSlot {
  name: string;
  domain?: string;
  range?: string;
  description?: string;
  is_containment?: boolean;
}

export interface LinkMLSchema {
  name: string;
  version?: string;
  description?: string;
  classes: Record<string, LinkMLClass>;
  slots: Record<string, LinkMLSlot>;
}

interface RawLinkMLClass {
  description?: string;
  abstract?: boolean;
  is_a?: string;
  attributes?: Record<string, RawLinkMLAttribute>;
  rendering?: { icon?: string; color?: string; hidden?: boolean };
}

interface RawLinkMLAttribute {
  description?: string;
  required?: boolean;
  range?: string;
  multivalued?: boolean;
  identifier?: boolean;
}

interface RawLinkMLSlot {
  description?: string;
  domain?: string;
  range?: string;
  is_containment?: boolean;
}

interface RawLinkMLSchema {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  classes?: Record<string, RawLinkMLClass>;
  slots?: Record<string, RawLinkMLSlot>;
}

export function loadSchema(schemaPath: string): LinkMLSchema {
  const source = readFileSync(schemaPath, 'utf-8');
  const raw = parseYaml(source) as RawLinkMLSchema;

  const name = raw.name ?? '';
  const version = raw.version;
  const description = raw.description ?? raw.title;

  const classes: Record<string, LinkMLClass> = {};
  for (const [className, rawClass] of Object.entries(raw.classes ?? {})) {
    const cls: LinkMLClass = {
      name: className,
      is_a: rawClass.is_a,
      is_abstract: rawClass.abstract ?? false,
      description: rawClass.description,
    };

    if (rawClass.attributes) {
      const attrs: Record<string, LinkMLAttribute> = {};
      for (const [attrName, rawAttr] of Object.entries(rawClass.attributes)) {
        attrs[attrName] = {
          name: attrName,
          required: rawAttr.required,
          range: rawAttr.range,
          multivalued: rawAttr.multivalued,
          description: rawAttr.description,
        };
        if (rawAttr.identifier) {
          cls.identity_attribute = attrName;
        }
      }
      cls.attributes = attrs;
    }

    // Parse the optional rendering block. Each field is attached only when
    // present and correctly typed; omitted fields stay absent (Req 1.5 / 4.4).
    if (rawClass.rendering) {
      const r = rawClass.rendering;
      const parsed: RenderingConfig = {};
      if (typeof r.icon === 'string') parsed.icon = r.icon;
      if (typeof r.color === 'string') parsed.color = r.color;
      if (typeof r.hidden === 'boolean') parsed.hidden = r.hidden;
      if (Object.keys(parsed).length > 0) cls.rendering = parsed;
    }

    classes[className] = cls;
  }

  const slots: Record<string, LinkMLSlot> = {};
  for (const [slotName, rawSlot] of Object.entries(raw.slots ?? {})) {
    slots[slotName] = {
      name: slotName,
      domain: rawSlot.domain,
      range: rawSlot.range,
      description: rawSlot.description,
      is_containment: rawSlot.is_containment,
    };
  }

  return { name, version, description, classes, slots };
}

export type RegisterMetamodelFn = (
  schema: LinkMLSchema,
  metamodelName: string,
) => Promise<void>;

export async function registerMetamodelFromSchema(
  metamodelName: string,
  schemaPath: string,
  registerFn: RegisterMetamodelFn,
): Promise<void> {
  const schema = loadSchema(schemaPath);
  await registerFn(schema, metamodelName);
}