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
 * metamodel-loader.ts — LinkML-driven Metamodel Registration (adapted)
 *
 * Reads a LinkML YAML schema (e.g. sw-arxml.linkml.yaml) and registers
 * the metamodel via the Import Write Service instead of REST endpoints.
 *
 * Class names and slot names in the YAML are snake_case and match
 * concept/relationship names exactly — no name-mapping layer is needed.
 *
 * Adapted from importer/arxml/arxml-src/metamodel-loader.ts:
 *   - Removed REST `post201` calls
 *   - Delegates registration to a provided callback (the extended write service)
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// LinkML schema shape (the subset we consume)
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Raw YAML shape (the subset we parse from the file)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

/**
 * Parse a LinkML YAML schema file into a typed `LinkMLSchema` structure.
 *
 * Extracts classes (concepts) with is_a references and identity attributes,
 * and slots (relationships) with domain/range references.
 *
 * @param schemaPath  Absolute or relative path to the `.linkml.yaml` file
 * @returns Parsed schema with classes, slots, and metadata
 * @throws If the file cannot be read or the YAML is invalid
 */
export function loadSchema(schemaPath: string): LinkMLSchema {
  const source = readFileSync(schemaPath, 'utf-8');
  const raw = parseYaml(source) as RawLinkMLSchema;

  const name = raw.name ?? '';
  const version = raw.version;
  const description = raw.description ?? raw.title;

  // Parse classes — extract concepts with is_a and identity attributes
  const classes: Record<string, LinkMLClass> = {};
  for (const [className, rawClass] of Object.entries(raw.classes ?? {})) {
    const cls: LinkMLClass = {
      name: className,
      is_a: rawClass.is_a,
      is_abstract: rawClass.abstract ?? false,
      description: rawClass.description,
    };

    // Detect identity attribute: an attribute with `identifier: true`
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

    classes[className] = cls;
  }

  // Parse slots — extract relationships with domain (source) and range (target)
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

// ---------------------------------------------------------------------------
// Registration callback type
// ---------------------------------------------------------------------------

/**
 * Callback signature for metamodel registration.
 * Matches `IImportWriteServiceExt.registerMetamodelFromSchema()`.
 */
export type RegisterMetamodelFn = (
  schema: LinkMLSchema,
  metamodelName: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a LinkML YAML schema and register the metamodel via the provided
 * registration function (typically the Import Write Service).
 *
 * Registration is idempotent — the write service skips if the metamodel
 * already exists.
 *
 * Abstract concepts are registered before concrete ones (ordering is
 * handled by the write service's registerMetamodelFromSchema).
 *
 * @param metamodelName  Metamodel name (e.g. "SW_ARXML")
 * @param schemaPath     Path to the LinkML YAML schema file
 * @param registerFn     Registration callback (from the extended write service)
 */
export async function registerMetamodelFromSchema(
  metamodelName: string,
  schemaPath: string,
  registerFn: RegisterMetamodelFn,
): Promise<void> {
  const schema = loadSchema(schemaPath);
  await registerFn(schema, metamodelName);
}
