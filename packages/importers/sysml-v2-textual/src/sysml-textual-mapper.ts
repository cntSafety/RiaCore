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
 * sysml-textual-mapper.ts
 *
 * Maps SysmlTextualElementInfo[] → ConceptBatch[] + RelationshipBatch[]
 * for the importer SDK write service.
 *
 * Mirrors the structure of the JSON importer's sysml-v2-mapper.ts, using
 * the same concept names so the same metamodel (sysml-v2.linkml.yaml) works.
 */
import type { ConceptBatch, RelationshipBatch } from '@riacore/app-contracts';
import { toWorkspaceRelative } from '@riacore/importer-sdk';
import type { SysmlTextualModel } from './sysml-textual-parser.js';

function compact(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

/**
 * Persisted form of an element's defining file.
 *
 * The parser works in absolute paths — it has to, it reads the files — but an
 * absolute path must not reach the database: ria-data is committed and shared,
 * so a machine-specific path makes the attribute meaningless on every other
 * checkout. Anchoring at the workspace root is the same rule `project_dir` and
 * every other configured path follows (see importer-sdk/config-paths.ts), so a
 * config that says `../01_SysML` yields `../01_SysML/InnoDrive.sysml` here.
 *
 * A source on another volume has no relative form; `toWorkspaceRelative` returns
 * it absolute, which is the honest answer — such a source does not travel with
 * the workspace in the first place.
 */
function toStoredSourceFile(workspaceRoot: string, sourceFile: string): string | undefined {
  if (!sourceFile) return undefined;
  return toWorkspaceRelative(workspaceRoot, sourceFile);
}

export function mapModelToConceptBatches(
  model: SysmlTextualModel,
  workspaceRoot: string,
): ConceptBatch[] {
  const batchMap = new Map<string, ConceptBatch>();

  for (const el of model.elements) {
    let batch = batchMap.get(el.concept);
    if (!batch) {
      batch = { concept: el.concept, items: [] };
      batchMap.set(el.concept, batch);
    }
    batch.items.push({
      stablePath: el.stablePath,
      attributes: {
        // `sysml_id` is the metamodel's identity attribute (identifier: true on
        // the abstract `sysml_element` base — see sysml-v2-textual.linkml.yaml).
        // The persistor resolves relationship endpoints through this attribute
        // when serializing (store) and re-linking (load); if it is absent the
        // stable-id lookup is empty and load() aborts with "stable-id lookup is
        // empty after inserting N concept(s)". The Langium AST has no stable
        // UUID (unlike the JSON importer's `@id`), so the slash-joined stable
        // path — unique per element and always present — is used as the identity
        // value. `stable_path` is kept as a separate (non-identity) attribute
        // for parity with the JSON importer's serialized shape.
        sysml_id:      el.stablePath,
        stable_path:   el.stablePath,
        ...compact({
          sysml_type:    el.sysmlType,
          name:          el.name,
          declared_name: el.name,
          qualified_name: el.qualifiedName,
          is_abstract:   el.isAbstract,
          is_composite:  el.isComposite,
          is_ordered:    el.isOrdered,
          is_unique:     el.isUnique,
          is_end:        el.isEnd,
          is_individual: el.isIndividual,
          is_variation:  el.isVariation,
          is_reference:  el.isReference,
          is_derived:    el.isDerived,
          is_readonly:   el.isReadonly,
          is_portion:    el.isPortion,
          is_conjugated: el.isConjugated,
          direction:     el.direction,
          body:          el.body,
          source_file:   toStoredSourceFile(workspaceRoot, el.sourceFile),
        }),
      },
    });
  }

  // Emit packages first (matches the JSON importer's ordering convention)
  const concepts = [...batchMap.keys()].sort((a, b) => {
    if (a === 'package') return -1;
    if (b === 'package') return 1;
    return a.localeCompare(b);
  });

  return concepts.map((c) => batchMap.get(c)!);
}

export function mapModelToRelationshipBatches(model: SysmlTextualModel): RelationshipBatch[] {
  // Build a lookup: qualifiedName → stablePath
  // Needed to resolve supertype references (best-effort within the same import run)
  const qnToPath = new Map<string, string>(
    model.elements.map((el) => [el.qualifiedName, el.stablePath]),
  );

  // Also index by short name for same-package resolution
  const nameToPaths = new Map<string, string[]>();
  for (const el of model.elements) {
    if (!el.name) continue;
    const paths = nameToPaths.get(el.name) ?? [];
    paths.push(el.stablePath);
    nameToPaths.set(el.name, paths);
  }

  const batchMap = new Map<string, RelationshipBatch>();
  const relationshipKeys = new Set<string>();

  function addRel(relationship: string, sourcePath: string, targetPath: string): void {
    if (!sourcePath || !targetPath || sourcePath === targetPath) return;
    const key = `${relationship}\u0000${sourcePath}\u0000${targetPath}`;
    if (relationshipKeys.has(key)) return;
    relationshipKeys.add(key);
    let batch = batchMap.get(relationship);
    if (!batch) {
      batch = { relationship, items: [] };
      batchMap.set(relationship, batch);
    }
    batch.items.push({ sourceStablePath: sourcePath, targetStablePath: targetPath });
  }

  function resolveTarget(typeName: string, ownerQN: string): string | undefined {
    // Try fully-qualified first
    const byQN = qnToPath.get(typeName);
    if (byQN) return byQN;

    // Try lexical scopes from nearest to farthest.
    const ownerSegments = ownerQN.split('::').slice(0, -1).filter(Boolean);
    for (let length = ownerSegments.length; length > 0; length -= 1) {
      const scoped = qnToPath.get(`${ownerSegments.slice(0, length).join('::')}::${typeName}`);
      if (scoped) return scoped;
    }

    // A short name is safe only if unique across the imported project.
    const paths = nameToPaths.get(typeName) ?? [];
    return paths.length === 1 ? paths[0] : undefined;
  }

  for (const el of model.elements) {
    // owns_element: parent → child (parent is everything before the last segment)
    const segments = el.qualifiedName.split('::');
    if (segments.length > 1) {
      const parentQN = segments.slice(0, -1).join('::');
      const parentPath = qnToPath.get(parentQN);
      if (parentPath) {
        addRel('owns_element', parentPath, el.stablePath);
        addRel('in_namespace', parentPath, el.stablePath);
      }
    }

    // has_type: element → supertype definition (best-effort resolution)
    for (const superTypeName of el.superTypeNames) {
      const targetPath = resolveTarget(superTypeName, el.qualifiedName);
      if (targetPath) {
        addRel('has_type', el.stablePath, targetPath);
        addRel('has_definition', el.stablePath, targetPath);
      }
    }
  }

  // Connector endpoint support is extracted from anonymous Langium AST nodes
  // by the parser. These records reproduce the JSON importer's relationship
  // shape (ReferenceUsage / Feature / FeatureChaining) for CommonModel views.
  for (const relationship of model.relationships) {
    addRel(
      relationship.relationship,
      relationship.sourceStablePath,
      relationship.targetStablePath,
    );
  }

  return [...batchMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, batch]) => batch);
}
