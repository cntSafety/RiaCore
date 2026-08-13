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
 * linkml-parser.ts — Parse a LinkML YAML schema into a typed structure.
 *
 * Reads a LinkML YAML file and produces a `LinkMLSchema` containing
 * classes (concepts) and slots (relationships) with their metadata.
 * Used by the Import Write Service for metamodel registration.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ProfileReviewCatalog,
  ProfileReviewCatalogItem,
  ProfileReviewInstructionSection,
  ProfileReviewMetadata,
  ProfileReviewOption,
} from '@riacore/app-contracts';
import type {
  LinkMLSchema,
  LinkMLClass,
  LinkMLSlot,
  LinkMLAttribute,
  LinkMLEnum,
  RenderingConfig,
} from './import-write-service.js';
import { buildMetamodelProfileMetadata } from './profile-metadata.js';

// ---------------------------------------------------------------------------
// Raw YAML shape (the subset we consume from LinkML)
// ---------------------------------------------------------------------------

interface RawLinkMLClass {
  description?: string;
  abstract?: boolean;
  mixin?: boolean;
  is_a?: string;
  mixins?: string[];
  attributes?: Record<string, RawLinkMLAttribute>;
  slots?: string[];
  rendering?: { icon?: string; color?: string; hidden?: boolean };
}

interface RawLinkMLAttribute {
  description?: string;
  required?: boolean;
  range?: string;
  multivalued?: boolean;
  identifier?: boolean;
  ifabsent?: unknown;
}

interface RawLinkMLSlot {
  description?: string;
  domain?: string;
  range?: string;
  required?: boolean;
  identifier?: boolean;
  multivalued?: boolean;
  is_containment?: boolean;
  ifabsent?: unknown;
}

interface RawLinkMLEnumValue {
  description?: string;
}

interface RawLinkMLEnum {
  description?: string;
  permissible_values?: Record<string, RawLinkMLEnumValue | null>;
}

interface RawLinkMLAnnotation {
  tag?: string;
  value?: unknown;
}

interface RawLinkMLSchema {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  classes?: Record<string, RawLinkMLClass>;
  slots?: Record<string, RawLinkMLSlot>;
  enums?: Record<string, RawLinkMLEnum>;
  annotations?: Record<string, RawLinkMLAnnotation | string>;
  /** Ordered list of attribute names used to produce a human-readable label for nodes in this metamodel. */
  display_identifier_attrs?: string[];
}

// ---------------------------------------------------------------------------
// Profile metadata helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeIfAbsent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const wrapped = value.match(/^string\((.*)\)$/s);
  return wrapped ? wrapped[1] : value;
}

function parseReviewOptions(value: unknown, context: string): ProfileReviewOption[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((entry, index) => {
    const item = asRecord(entry, `${context}[${index}]`);
    return {
      value: requiredString(item.value, `${context}[${index}].value`),
      label: requiredString(item.label, `${context}[${index}].label`),
      ...(optionalString(item.description) ? { description: String(item.description) } : {}),
      ...(optionalString(item.color) ? { color: String(item.color) } : {}),
      ...(optionalString(item.tag) ? { tag: String(item.tag) } : {}),
      ...(typeof item.showAuthorStatusBreakdown === 'boolean'
        ? { showAuthorStatusBreakdown: item.showAuthorStatusBreakdown }
        : {}),
      ...(typeof item.isResolution === 'boolean' ? { isResolution: item.isResolution } : {}),
    };
  });
}

function parseReviewSections(value: unknown): ProfileReviewInstructionSection[] {
  if (!Array.isArray(value)) throw new Error('profile_review.instructions.sections must be an array');
  return value.map((entry, index) => {
    const item = asRecord(entry, `profile_review.instructions.sections[${index}]`);
    if (!Array.isArray(item.paragraphs) || !item.paragraphs.every(v => typeof v === 'string')) {
      throw new Error(`profile_review.instructions.sections[${index}].paragraphs must be a string array`);
    }
    const bullets = item.bullets;
    const catalogs = item.catalogs;
    if (bullets !== undefined && (!Array.isArray(bullets) || !bullets.every(v => typeof v === 'string'))) {
      throw new Error(`profile_review.instructions.sections[${index}].bullets must be a string array`);
    }
    if (catalogs !== undefined && (!Array.isArray(catalogs) || !catalogs.every(v => typeof v === 'string'))) {
      throw new Error(`profile_review.instructions.sections[${index}].catalogs must be a string array`);
    }
    return {
      id: requiredString(item.id, `profile_review.instructions.sections[${index}].id`),
      title: requiredString(item.title, `profile_review.instructions.sections[${index}].title`),
      paragraphs: item.paragraphs as string[],
      ...(bullets ? { bullets: bullets as string[] } : {}),
      ...(optionalString(item.note) ? { note: String(item.note) } : {}),
      ...(catalogs ? { catalogs: catalogs as string[] } : {}),
    };
  });
}

function loadReviewCatalogs(
  schemaPath: string,
  source: unknown,
  titlesValue: unknown,
): ProfileReviewCatalog[] {
  if (source === undefined) return [];
  const relativeSource = requiredString(source, 'profile_review.instructions.catalogSource');
  if (isAbsolute(relativeSource)) {
    throw new Error('profile_review.instructions.catalogSource must be relative to the LinkML schema');
  }
  const schemaDir = dirname(resolve(schemaPath));
  const catalogPath = resolve(schemaDir, relativeSource);
  const relativeCatalogPath = relative(schemaDir, catalogPath);
  if (relativeCatalogPath === '..' || relativeCatalogPath.startsWith('../') || relativeCatalogPath.startsWith('..\\')) {
    throw new Error('profile_review.instructions.catalogSource must stay within the schema directory');
  }

  const sourceData = asRecord(JSON.parse(readFileSync(catalogPath, 'utf-8')), 'review catalog source');
  const titles = titlesValue === undefined ? {} : asRecord(titlesValue, 'profile_review.instructions.catalogTitles');

  return Object.entries(sourceData).map(([id, rawItems]) => {
    if (!Array.isArray(rawItems)) throw new Error(`review catalog "${id}" must be an array`);
    const items: ProfileReviewCatalogItem[] = rawItems.map((rawItem, index) => {
      const item = asRecord(rawItem, `review catalog "${id}"[${index}]`);
      return {
        key: requiredString(item.key, `review catalog "${id}"[${index}].key`),
        name: requiredString(item.name, `review catalog "${id}"[${index}].name`),
        description: requiredString(item.description, `review catalog "${id}"[${index}].description`),
        ...(optionalString(item.measures) ? { measures: String(item.measures) } : {}),
      };
    });
    return {
      id,
      title: optionalString(titles[id]) ?? id,
      items,
    };
  });
}

function parseProfileReview(raw: RawLinkMLSchema, schemaPath: string): ProfileReviewMetadata | undefined {
  const annotation = raw.annotations?.profile_review;
  if (annotation === undefined) return undefined;
  const annotationValue = typeof annotation === 'string' ? annotation : annotation.value;
  if (typeof annotationValue !== 'string') {
    throw new Error('annotations.profile_review.value must be a JSON string');
  }

  const parsed = asRecord(JSON.parse(annotationValue), 'annotations.profile_review.value');
  const workflow = asRecord(parsed.workflow, 'profile_review.workflow');
  const instructions = asRecord(parsed.instructions, 'profile_review.instructions');
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('profile_review.version must be a positive integer');
  }

  return {
    version,
    workflow: {
      verdicts: parseReviewOptions(workflow.verdicts, 'profile_review.workflow.verdicts'),
      authorStatuses: parseReviewOptions(workflow.authorStatuses, 'profile_review.workflow.authorStatuses'),
      ...(optionalString(workflow.snapshotPolicy) ? { snapshotPolicy: String(workflow.snapshotPolicy) } : {}),
    },
    instructions: {
      title: requiredString(instructions.title, 'profile_review.instructions.title'),
      format: 'markdown',
      sections: parseReviewSections(instructions.sections),
      catalogs: loadReviewCatalogs(schemaPath, instructions.catalogSource, instructions.catalogTitles),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a LinkML YAML schema file into a typed `LinkMLSchema` structure.
 *
 * @param filePath  Absolute or relative path to the `.linkml.yaml` file
 * @returns Parsed schema with classes, slots, and metadata
 * @throws If the file cannot be read or the YAML is invalid
 */
export function parseLinkMLSchema(filePath: string): LinkMLSchema {
  const source = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(source) as RawLinkMLSchema;
  return buildSchemaFromRaw(raw, filePath);
}

/**
 * Compose a profile schema from ordered layer files (base first, overlays win).
 *
 * Each layer is a LinkML YAML fragment. Layers are deep-merged before parsing:
 *   - scalar schema fields (name/title/description/version): later layer wins
 *   - classes / slots: field-level merge (overlay fields override, others kept)
 *   - enums: whole-enum replace (overlay redefines an enum entirely)
 *   - annotations (e.g. profile_review): later layer wins
 * This lets a shared base schema hold the common structure while thin overlays
 * carry only the per-profile differences (enum wording, review instructions).
 */
export function composeProfileSchema(layerPaths: string[]): LinkMLSchema {
  if (!layerPaths || layerPaths.length === 0) {
    throw new Error('composeProfileSchema requires at least one layer path');
  }
  const raws = layerPaths.map((p) => parseYaml(readFileSync(p, 'utf-8')) as RawLinkMLSchema);
  const merged = raws.reduce((acc, cur) => mergeRawSchemas(acc, cur));

  // Catalogs referenced by profile_review resolve relative to the layer that
  // declares the annotation (the overlay), not the base.
  let catalogPath = layerPaths[layerPaths.length - 1];
  for (let i = layerPaths.length - 1; i >= 0; i--) {
    if (raws[i].annotations?.profile_review !== undefined) {
      catalogPath = layerPaths[i];
      break;
    }
  }
  return buildSchemaFromRaw(merged, catalogPath);
}

/** Deep-merge two raw LinkML schema fragments (overlay wins over base). */
function mergeRawSchemas(base: RawLinkMLSchema, overlay: RawLinkMLSchema): RawLinkMLSchema {
  const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => (b !== undefined ? b : a);

  // Whole-value replace, but existing keys keep their original position.
  const mergeReplace = <V>(a?: Record<string, V>, b?: Record<string, V>): Record<string, V> | undefined => {
    if (!a && !b) return undefined;
    const out: Record<string, V> = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b ?? {})) out[k] = v;
    return out;
  };

  // Field-level merge per entry (overlay fields override base fields).
  const mergeFields = <V extends object>(a?: Record<string, V>, b?: Record<string, V>): Record<string, V> | undefined => {
    if (!a && !b) return undefined;
    const out: Record<string, V> = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = (k in out ? { ...(out[k] as object), ...(v as object) } : v) as V;
    }
    return out;
  };

  return {
    name: pick(base.name, overlay.name),
    title: pick(base.title, overlay.title),
    description: pick(base.description, overlay.description),
    version: pick(base.version, overlay.version),
    classes: mergeFields(base.classes, overlay.classes),
    slots: mergeFields(base.slots, overlay.slots),
    enums: mergeReplace(base.enums, overlay.enums),
    annotations: mergeReplace(base.annotations, overlay.annotations),
    display_identifier_attrs: pick(base.display_identifier_attrs, overlay.display_identifier_attrs),
  };
}

function buildSchemaFromRaw(raw: RawLinkMLSchema, filePath: string): LinkMLSchema {
  const name = raw.name ?? '';
  const version = raw.version;
  const description = raw.description ?? raw.title;

  // Parse classes
  const rawClassMap = raw.classes ?? {};

  function collectClassAttributes(
    className: string,
    visited = new Set<string>(),
  ): Record<string, RawLinkMLAttribute> {
    if (visited.has(className)) return {};
    visited.add(className);

    const rawClass = rawClassMap[className];
    if (!rawClass) return {};

    const result: Record<string, RawLinkMLAttribute> = {};

    if (rawClass.is_a) {
      Object.assign(result, collectClassAttributes(rawClass.is_a, visited));
    }

    for (const mixinName of rawClass.mixins ?? []) {
      Object.assign(result, collectClassAttributes(mixinName, visited));
    }

    if (rawClass.attributes) {
      Object.assign(result, rawClass.attributes);
    }

    if (rawClass.slots) {
      const rawSlots = raw.slots ?? {};
      for (const slotName of rawClass.slots) {
        if (!result[slotName]) {
          const slotDef = rawSlots[slotName];
          result[slotName] = {
            description: slotDef?.description,
            range: slotDef?.range,
            required: slotDef?.required ?? false,
            identifier: slotDef?.identifier,
            multivalued: slotDef?.multivalued,
            ifabsent: slotDef?.ifabsent,
          };
        }
      }
    }

    return result;
  }

  const classes: Record<string, LinkMLClass> = {};
  for (const [className, rawClass] of Object.entries(rawClassMap)) {
    const cls: LinkMLClass = {
      name: className,
      is_a: rawClass.is_a,
      is_abstract: rawClass.abstract ?? false,
      description: rawClass.description,
    };

    const mergedAttributes = collectClassAttributes(className);

    // Detect identity attribute: an attribute with `identifier: true`
    if (Object.keys(mergedAttributes).length > 0) {
      const attrs: Record<string, LinkMLAttribute> = {};
      const identifierAttrs: string[] = [];

      for (const [attrName, rawAttr] of Object.entries(mergedAttributes)) {
        attrs[attrName] = {
          name: attrName,
          required: rawAttr.required,
          range: rawAttr.range,
          multivalued: rawAttr.multivalued,
          description: rawAttr.description,
          identifier: rawAttr.identifier,
          default_value: normalizeIfAbsent(rawAttr.ifabsent),
        };
        if (rawAttr.identifier) {
          identifierAttrs.push(attrName);
        }
      }

      // Validate: concrete classes must have exactly one identifier attribute
      const isConcrete = !rawClass.abstract && !rawClass.mixin;
      if (isConcrete && identifierAttrs.length > 1) {
        throw new Error(
          `Schema "${name}": class "${className}" declares multiple identifier attributes: ` +
          `[${identifierAttrs.join(', ')}]. Exactly one is allowed per concrete concept type.`
        );
      }
      if (isConcrete && identifierAttrs.length === 0) {
        throw new Error(
          `Schema "${name}": concrete class "${className}" has no identifier attribute declared. ` +
          `Every concrete concept type must declare exactly one attribute with 'identifier: true'.`
        );
      }

      if (identifierAttrs.length === 1) {
        cls.identity_attribute = identifierAttrs[0];
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

  // Validate: all concrete classes in the schema must agree on the same
  // identity attribute name (they all inherit from a common mixin/base).
  const concreteIdentityAttrs = new Set(
    Object.values(classes)
      .filter(c => !c.is_abstract && c.identity_attribute)
      .map(c => c.identity_attribute!)
  );
  if (concreteIdentityAttrs.size > 1) {
    throw new Error(
      `Schema "${name}": concrete classes use different identity attributes: ` +
      `[${[...concreteIdentityAttrs].join(', ')}]. ` +
      `All concept types in a metamodel must share the same identity attribute via a common mixin.`
    );
  }

  // Parse slots
  const slots: Record<string, LinkMLSlot> = {};
  for (const [slotName, rawSlot] of Object.entries(raw.slots ?? {})) {
    slots[slotName] = {
      name: slotName,
      domain: rawSlot.domain,
      range: rawSlot.range,
      description: rawSlot.description,
      required: rawSlot.required,
      multivalued: rawSlot.multivalued,
      identifier: rawSlot.identifier,
      is_containment: rawSlot.is_containment,
      default_value: normalizeIfAbsent(rawSlot.ifabsent),
    };
  }

  // Parse enumerations in declaration order.
  const enums: Record<string, LinkMLEnum> = {};
  for (const [enumName, rawEnum] of Object.entries(raw.enums ?? {})) {
    enums[enumName] = {
      name: enumName,
      description: rawEnum.description,
      permissible_values: Object.entries(rawEnum.permissible_values ?? {}).map(([value, definition]) => ({
        value,
        description: definition?.description,
      })),
    };
  }

  const schema: LinkMLSchema = {
    name,
    version,
    description,
    classes,
    slots,
    enums,
    review: parseProfileReview(raw, filePath),
  };
  if (Array.isArray(raw.display_identifier_attrs) && raw.display_identifier_attrs.length > 0) {
    schema.display_identifier_attrs = raw.display_identifier_attrs.filter((v): v is string => typeof v === 'string');
  }
  schema.profile_metadata = buildMetamodelProfileMetadata(schema);
  return schema;
}
