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
import { createHash } from 'node:crypto';
import type { LinkMLSchema, LinkMLAttribute, LinkMLSlot } from './metamodel-loader.js';
import type { ParsedNeedsModel, JsonSchemaProperty } from './sn-parser.js';

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function toLinkMlRange(prop: JsonSchemaProperty): string {
  const t = Array.isArray(prop.type) ? prop.type.find((v) => v !== 'null') : prop.type;
  const primary = String(t ?? 'string');
  if (primary === 'integer') return 'integer';
  if (primary === 'number') return 'float';
  if (primary === 'boolean') return 'boolean';
  return 'string';
}

function inferClassNames(model: ParsedNeedsModel): string[] {
  const names = new Set<string>();
  for (const n of model.needs) {
    names.add(`need_${normalizeName(n.type)}`);
  }
  if (names.size === 0) names.add('need_unknown');
  return [...names].sort();
}

export function computeDynamicMetamodelName(namespace: string): string {
  const ns = normalizeName(namespace || 'sphinx_needs');
  return `SN_${ns}`;
}

export function buildSchemaFromModel(model: ParsedNeedsModel, namespace: string): { schema: LinkMLSchema; schemaDigest: string } {
  const classes: LinkMLSchema['classes'] = {};
  const slots: LinkMLSchema['slots'] = {};

  const baseAttributes: Record<string, LinkMLAttribute> = {};
  for (const [fieldName, prop] of Object.entries(model.properties)) {
    if (prop.field_type === 'backlinks') continue;

    baseAttributes[fieldName] = {
      name: fieldName,
      description: prop.description,
      range: toLinkMlRange(prop),
      multivalued: (Array.isArray(prop.type) ? prop.type.includes('array') : prop.type === 'array'),
      required: fieldName === 'id',
    };
  }

  if (!baseAttributes.id) {
    baseAttributes.id = { name: 'id', range: 'string', required: true };
  }

  classes.need_base = {
    name: 'need_base',
    is_abstract: true,
    description: 'Base class for dynamically generated Sphinx-Needs concepts',
    identity_attribute: 'id',
    attributes: baseAttributes,
  };

  for (const className of inferClassNames(model)) {
    classes[className] = {
      name: className,
      is_a: 'need_base',
      is_abstract: false,
      identity_attribute: 'id',
      attributes: {
        id: { name: 'id', range: 'string', required: true },
      },
    };
  }

  // Document nodes provide a containment hierarchy for tree UIs.
  classes.need_document = {
    name: 'need_document',
    is_abstract: false,
    identity_attribute: 'id',
    attributes: {
      id: { name: 'id', range: 'string', required: true },
      title: { name: 'title', range: 'string' },
      docname: { name: 'docname', range: 'string' },
      stable_path: { name: 'stable_path', range: 'string', required: true },
    },
  };

  slots.contains_need = {
    name: 'contains_need',
    domain: 'need_document',
    range: 'need_base',
    description: 'Containment relationship from Sphinx document to contained needs',
    is_containment: true,
  };

  for (const linkName of model.linkFieldNames) {
    const slotName = normalizeName(linkName);
    const slot: LinkMLSlot = {
      name: slotName,
      domain: 'need_base',
      range: 'need_base',
      description: `Dynamic link slot from needs field '${linkName}'`,
      is_containment: false,
    };
    slots[slotName] = slot;
  }

  const schema: LinkMLSchema = {
    name: computeDynamicMetamodelName(namespace),
    version: model.selectedVersion || 'dynamic',
    description: `Dynamic Sphinx-Needs schema generated from ${model.needsFilePath}`,
    classes,
    slots,
    display_identifier_attrs: ['title', 'id'],
  };

  const schemaDigest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  return { schema, schemaDigest };
}
