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
import type { ConceptBatch, RelationshipBatch } from '@riacore/app-contracts';
import type { SysmlModel, SysmlElementInfo } from './sysml-v2-parser.js';

function compactAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

export function mapModelToConceptBatches(model: SysmlModel): ConceptBatch[] {
  const batchMap = new Map<string, ConceptBatch>();

  function addItem(element: SysmlElementInfo): void {
    let batch = batchMap.get(element.concept);
    if (!batch) {
      batch = { concept: element.concept, items: [] };
      batchMap.set(element.concept, batch);
    }

    batch.items.push({
      stablePath: element.stablePath,
      attributes: {
        stable_path: element.stablePath,
        ...compactAttributes({
          sysml_id: element.id,
          element_id: element.elementId,
          sysml_type: element.type,
          name: element.name,
          declared_name: element.declaredName,
          qualified_name: element.qualifiedName,
          owner_id: element.ownerId,
          owning_namespace_id: element.owningNamespaceId,
          owning_relationship_id: element.owningRelationshipId,
          owning_membership_id: element.owningMembershipId,
          owning_related_element_id: element.owningRelatedElementId,
          owning_type_id: element.owningTypeId,
          member_element_id: element.memberElementId,
          is_library_element: element.isLibraryElement,
          is_implied: element.isImplied,
          is_implied_included: element.isImpliedIncluded,
          is_composite: element.isComposite,
          is_ordered: element.isOrdered,
          is_unique: element.isUnique,
          is_end: element.isEnd,
          is_abstract: element.isAbstract,
          is_sufficient: element.isSufficient,
          is_individual: element.isIndividual,
          is_variation: element.isVariation,
          is_reference: element.isReference,
          is_derived: element.isDerived,
          is_readonly: element.isReadonly,
          is_portion: element.isPortion,
          is_conjugated: element.isConjugated,
          may_time_vary: element.mayTimeVary,
          direction: element.direction,
          visibility: element.visibility,
          operator: element.operator,
          body: element.body,
          member_name: element.memberName,
          literal_value: element.literalValue,
        }),
      },
    });
  }

  for (const element of model.elements) {
    addItem(element);
  }

  const concepts = [...batchMap.keys()].sort((a, b) => {
    if (a === 'package') return -1;
    if (b === 'package') return 1;
    return a.localeCompare(b);
  });

  return concepts.map((concept) => batchMap.get(concept)!).filter(Boolean);
}

export function mapModelToRelationshipBatches(model: SysmlModel): RelationshipBatch[] {
  const batchMap = new Map<string, RelationshipBatch>();
  const idToStablePath = new Map(model.elements.map((element) => [element.id, element.stablePath]));

  function addRel(relationship: string, sourceId: string | undefined, targetId: string | undefined): void {
    if (!sourceId || !targetId) return;
    const sourceStablePath = idToStablePath.get(sourceId);
    const targetStablePath = idToStablePath.get(targetId);
    if (!sourceStablePath || !targetStablePath) return;

    let batch = batchMap.get(relationship);
    if (!batch) {
      batch = { relationship, items: [] };
      batchMap.set(relationship, batch);
    }
    batch.items.push({ sourceStablePath, targetStablePath });
  }

  function addRelList(relationship: string, sourceId: string, targetIds: string[]): void {
    for (const targetId of targetIds) {
      addRel(relationship, sourceId, targetId);
    }
  }

  for (const element of model.elements) {
    addRel('owns_element', element.ownerId, element.id);
    addRel('in_namespace', element.owningNamespaceId, element.id);
    addRel('owned_by_membership', element.owningMembershipId, element.id);
    addRel('owned_by_type', element.owningTypeId, element.id);
    addRel('membership_owner', element.id, element.owningRelatedElementId);
    addRel('membership_member', element.id, element.memberElementId);
    addRel('feature_value_for', element.id, element.featureWithValueId);
    addRel('feature_value_target', element.id, element.valueId);

    // Specialization relationships (Subsetting, Redefinition, ReferenceSubsetting, FeatureTyping)
    addRel('specializes', element.specificId, element.generalId);
    addRel('typed_by', element.typedFeatureId, element.id);
    addRel('chains_feature', element.id, element.chainingFeatureId);

    // Import relationships
    addRel('imports_namespace', element.id, element.importedNamespaceId);
    addRel('imports_element', element.id, element.importedElementId);

    addRelList('has_member', element.id, element.memberIds);
    addRelList('has_membership', element.id, element.membershipIds);
    addRelList('has_owned_membership', element.id, element.ownedMembershipIds);
    addRelList('has_owned_element', element.id, element.ownedElementIds);
    addRelList('has_type', element.id, element.typeIds);
    addRelList('has_definition', element.id, element.definitionIds);
    addRelList('references_source', element.id, element.sourceIds);
    addRelList('references_target', element.id, element.targetIds);
    addRelList('connects', element.id, element.connectorEndIds);
  }

  return [...batchMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, batch]) => batch);
}