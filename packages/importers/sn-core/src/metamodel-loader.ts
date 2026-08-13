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
 * metamodel-loader.ts — LinkML parser utility.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface LinkMLClass {
  name: string;
  description?: string;
  is_abstract?: boolean;
  is_a?: string;
  identity_attribute?: string;
  attributes?: Record<string, LinkMLAttribute>;
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
  /** Ordered list of attribute names used to produce a human-readable label for nodes in this metamodel. */
  display_identifier_attrs?: string[];
}

interface RawLinkMLClass {
  description?: string;
  abstract?: boolean;
  is_a?: string;
  attributes?: Record<string, RawLinkMLAttribute>;
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
        if (rawAttr.identifier) cls.identity_attribute = attrName;
      }
      cls.attributes = attrs;
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

  return {
    name: raw.name ?? '',
    version: raw.version,
    description: raw.description ?? raw.title,
    classes,
    slots,
  };
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
