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
import type {
  MetamodelProfileMetadata,
  ProfileSlotMetadata,
} from '@riacore/app-contracts';
import type { LinkMLAttribute, LinkMLSchema, LinkMLSlot } from './import-write-service.js';

function attributeMetadata(
  attribute: LinkMLAttribute,
  order: number,
  identifierName?: string,
): ProfileSlotMetadata {
  return {
    name: attribute.name,
    order,
    ...(attribute.description ? { description: attribute.description } : {}),
    ...(attribute.range ? { range: attribute.range } : {}),
    required: attribute.required ?? false,
    multivalued: attribute.multivalued ?? false,
    identifier: attribute.identifier ?? attribute.name === identifierName,
    containment: false,
    ...(attribute.default_value !== undefined ? { defaultValue: attribute.default_value } : {}),
  };
}

function slotMetadata(slot: LinkMLSlot, order: number): ProfileSlotMetadata {
  return {
    name: slot.name,
    order,
    ...(slot.description ? { description: slot.description } : {}),
    ...(slot.domain ? { domain: slot.domain } : {}),
    ...(slot.range ? { range: slot.range } : {}),
    required: slot.required ?? false,
    multivalued: slot.multivalued ?? false,
    identifier: slot.identifier ?? false,
    containment: slot.is_containment ?? false,
    ...(slot.default_value !== undefined ? { defaultValue: slot.default_value } : {}),
  };
}

/** Normalize parsed LinkML data into the ordered renderer/CLI contract shape. */
export function buildMetamodelProfileMetadata(
  schema: LinkMLSchema,
): MetamodelProfileMetadata {
  return {
    schema: {
      name: schema.name,
      ...(schema.version ? { version: schema.version } : {}),
      ...(schema.description ? { description: schema.description } : {}),
    },

    classes: Object.values(schema.classes).map((concept, order) => ({
      name: concept.name,
      order,
      ...(concept.description ? { description: concept.description } : {}),
      abstract: concept.is_abstract ?? false,
      ...(concept.is_a ? { isA: concept.is_a } : {}),
      slots: Object.values(concept.attributes ?? {}).map((attribute, slotOrder) =>
        attributeMetadata(attribute, slotOrder, concept.identity_attribute),
      ),
    })),
    slots: Object.values(schema.slots).map(slotMetadata),
    enums: Object.values(schema.enums ?? {}).map((enumeration, order) => ({
      name: enumeration.name,
      order,
      ...(enumeration.description ? { description: enumeration.description } : {}),
      permissibleValues: enumeration.permissible_values.map((value, valueOrder) => ({
        value: value.value,
        order: valueOrder,
        ...(value.description ? { description: value.description } : {}),
      })),
    })),
    ...(schema.review ? { review: schema.review } : {}),
    ...(schema.display_identifier_attrs?.length ? { displayIdentifierAttrs: schema.display_identifier_attrs } : {}),
  };
}
