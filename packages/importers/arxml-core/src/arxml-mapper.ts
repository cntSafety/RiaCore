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
 * arxml-mapper.ts — Maps a parsed ArxmlModel to ConceptBatch[] and RelationshipBatch[]
 *
 * Pure mapping functions with no side effects. Adapted from the old
 * arxml-importer.ts buildAllElements() and createAllRelationships() logic.
 */

import type { ArxmlModel } from './arxml-parser.js';
import type { ConceptBatch, RelationshipBatch } from '@riacore/app-contracts';

// ── Concept Mapping ───────────────────────────────────────────────────────────

/**
 * Maps every element in the ArxmlModel to ConceptBatch[], one batch per
 * distinct concept type. Each item carries stablePath and attributes containing
 * at minimum stable_path, uuid, and short_name.
 */
export function mapModelToConceptBatches(model: ArxmlModel): ConceptBatch[] {
  const batchMap = new Map<string, ConceptBatch>();

  function addItem(concept: string, stablePath: string, attributes: Record<string, unknown>): void {
    let batch = batchMap.get(concept);
    if (!batch) {
      batch = { concept, items: [] };
      batchMap.set(concept, batch);
    }
    batch.items.push({ stablePath, attributes: { stable_path: stablePath, ...attributes } });
  }

  function addSimple(concept: string, items: Array<{ stablePath: string; uuid?: string; shortName?: string }>): void {
    for (const it of items) {
      addItem(concept, it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '' });
    }
  }

  // ── Core elements ─────────────────────────────────────────────────────────

  addSimple('ar_package', model.packages);

  // SWC types have variable concept kinds
  for (const s of model.swcTypes) {
    addItem(s.kind, s.stablePath, { uuid: s.uuid ?? '', short_name: s.shortName ?? '' });
  }

  addSimple('p_port', model.pPorts);
  addSimple('r_port', model.rPorts);
  addSimple('sr_interface', model.srInterfaces);
  addSimple('cs_interface', model.csInterfaces);
  addSimple('variable_data_proto', model.dataElements);
  addSimple('cs_operation', model.operations);
  addSimple('swc_prototype', model.swcPrototypes);
  addSimple('swc_internal_behavior', model.internalBehaviors);
  addSimple('swc_implementation', model.implementations);
  addSimple('assembly_connector', model.assemblyConnectors);
  addSimple('delegation_connector', model.delegationConnectors);
  addSimple('system', model.systems);
  addSimple('root_swc_prototype', model.rootCompositions);

  // ── Phase A types ─────────────────────────────────────────────────────────

  for (const it of model.implDataTypes) {
    addItem('impl_data_type', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', category: it.category ?? '' });
  }

  for (const it of model.swBaseTypes) {
    addItem('sw_base_type', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', base_type_size: it.baseTypeSize ?? '', base_type_encoding: it.baseTypeEncoding ?? '' });
  }

  for (const it of model.compuMethods) {
    addItem('compu_method', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', category: it.category ?? '' });
  }

  addSimple('data_constr', model.dataConstrs);

  for (const it of model.modeDeclarationGroups) {
    addItem('mode_declaration_group', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', category: it.category ?? '' });
  }

  addSimple('ms_interface', model.msInterfaces);
  addSimple('nv_data_interface', model.nvDataInterfaces);
  addSimple('parameter_interface', model.parameterInterfaces);
  addSimple('trigger_interface', model.triggerInterfaces);
  addSimple('data_type_mapping_set', model.dataTypeMappingSets);
  addSimple('exclusive_area', model.exclusiveAreas);
  addSimple('per_instance_memory', model.perInstanceMemories);
  addSimple('bsw_module_description', model.bswModuleDescriptions);
  addSimple('bsw_internal_behavior', model.bswInternalBehaviors);

  for (const it of model.bswModuleEntries) {
    addItem('bsw_module_entry', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', call_type: it.callType ?? '', execution_context: it.executionContext ?? '' });
  }

  for (const it of model.units) {
    addItem('unit', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', display_name: it.displayName ?? '' });
  }

  for (const it of model.implDataTypeElements) {
    addItem('impl_data_type_element', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', type_ref: it.typeRef ?? '' });
  }

  for (const it of model.runnableEntities) {
    addItem('runnable_entity', it.stablePath, {
      uuid: it.uuid ?? '', short_name: it.shortName ?? '', symbol: it.symbol ?? '',
      can_be_invoked_concurrently: it.canBeInvokedConcurrently ?? '',
      minimum_start_interval: it.minimumStartInterval ?? '',
    });
  }

  // Events have variable concept kinds
  for (const e of model.events) {
    const attrs: Record<string, unknown> = { uuid: e.uuid ?? '', short_name: e.shortName ?? '' };
    if (e.kind === 'timing_event') attrs.period = e.period ?? '';
    addItem(e.kind, e.stablePath, attrs);
  }

  for (const e of model.bswEntities) {
    addItem('bsw_entity', e.stablePath, { uuid: e.uuid ?? '', short_name: e.shortName ?? '', implemented_entry_ref: e.implementedEntryRef ?? '' });
  }

  // App data types have variable concept kinds
  for (const e of model.appDataTypes) {
    addItem(e.kind, e.stablePath, { uuid: e.uuid ?? '', short_name: e.shortName ?? '' });
  }

  for (const it of model.prPorts) {
    addItem('pr_port', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '' });
  }

  // ── Phase B types ─────────────────────────────────────────────────────────

  addSimple('ecu_instance', model.ecuInstances);

  for (const it of model.commClusters) {
    addItem(it.kind, it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '' });
  }

  for (const it of model.commFrames) {
    addItem(it.kind, it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '' });
  }

  addSimple('i_signal', model.iSignals);
  addSimple('i_signal_i_pdu', model.iSignalIPdus);
  addSimple('i_pdu_group', model.iPduGroups);
  addSimple('system_signal', model.systemSignals);
  addSimple('system_signal_group', model.systemSignalGroups);
  addSimple('i_signal_group', model.iSignalGroups);
  addSimple('lin_sporadic_frame', model.linSporadicFrames);
  addSimple('constant_specification', model.constantSpecifications);
  addSimple('sw_addr_method', model.swAddrMethods);
  addSimple('sr_to_signal_mapping', model.srToSignalMappings);
  addSimple('flat_map', model.flatMaps);
  addSimple('flat_instance_descriptor', model.flatInstanceDescriptors);

  // ── Phase C types ─────────────────────────────────────────────────────────

  addSimple('ecuc_value_collection', model.ecucValueCollections);

  for (const it of model.ecucModuleConfigs) {
    addItem('ecuc_module_config', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', definition_ref: it.definitionRef ?? '' });
  }

  for (const it of model.ecucContainerValues) {
    addItem('ecuc_container_value', it.stablePath, { uuid: it.uuid ?? '', short_name: it.shortName ?? '', definition_ref: it.definitionRef ?? '' });
  }

  // Return batches in a stable order: packages first, then alphabetical by concept
  const result: ConceptBatch[] = [];
  const pkgBatch = batchMap.get('ar_package');
  if (pkgBatch) {
    result.push(pkgBatch);
    batchMap.delete('ar_package');
  }
  // Remaining batches sorted alphabetically for deterministic output
  const remaining = [...batchMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, batch] of remaining) {
    result.push(batch);
  }

  return result;
}


// ── Relationship Mapping ──────────────────────────────────────────────────────

/**
 * Maps every relationship in the ArxmlModel to RelationshipBatch[], one batch
 * per distinct relationship type. Each item carries sourceArPath and targetArPath.
 */
export function mapModelToRelationshipBatches(model: ArxmlModel): RelationshipBatch[] {
  const batchMap = new Map<string, RelationshipBatch>();

  function addRel(relationship: string, sourceStablePath: string, targetStablePath: string): void {
    let batch = batchMap.get(relationship);
    if (!batch) {
      batch = { relationship, items: [] };
      batchMap.set(relationship, batch);
    }
    batch.items.push({ sourceStablePath, targetStablePath });
  }

  function addRels(
    relationship: string,
    pairs: Array<{ sourceArPath: string; targetArPath: string }>,
  ): void {
    for (const p of pairs) {
      addRel(relationship, p.sourceArPath, p.targetArPath);
    }
  }

  // ── Core relationships ────────────────────────────────────────────────────

  // Package containment
  addRels('contains_package',
    model.packages
      .filter((p) => p.parentStablePath != null)
      .map((p) => ({ sourceArPath: p.parentStablePath!, targetArPath: p.stablePath })),
  );

  // SWC type containment
  addRels('contains_swc_type',
    model.swcTypes.map((s) => ({ sourceArPath: s.packageStablePath, targetArPath: s.stablePath })),
  );

  // Port interface containment (SR + CS)
  addRels('contains_port_interface',
    [...model.srInterfaces, ...model.csInterfaces].map((i) => ({ sourceArPath: i.packageStablePath, targetArPath: i.stablePath })),
  );

  // SWC implementation containment
  addRels('contains_swc_implementation',
    model.implementations.map((i) => ({ sourceArPath: i.packageStablePath, targetArPath: i.stablePath })),
  );

  // System containment
  addRels('contains_system',
    model.systems.map((s) => ({ sourceArPath: s.packageStablePath, targetArPath: s.stablePath })),
  );

  // Port ownership
  addRels('has_p_port',
    model.pPorts.map((p) => ({ sourceArPath: p.ownerStablePath, targetArPath: p.stablePath })),
  );
  addRels('has_r_port',
    model.rPorts.map((r) => ({ sourceArPath: r.ownerStablePath, targetArPath: r.stablePath })),
  );

  // Component prototypes
  addRels('has_component',
    model.swcPrototypes.map((p) => ({ sourceArPath: p.compositionArPath, targetArPath: p.stablePath })),
  );
  addRels('typed_by',
    model.swcPrototypes.filter((p) => Boolean(p.typeRef)).map((p) => ({ sourceArPath: p.stablePath, targetArPath: p.typeRef! })),
  );

  // Connectors
  addRels('has_connector',
    [...model.assemblyConnectors, ...model.delegationConnectors].map((c) => ({ sourceArPath: c.compositionArPath, targetArPath: c.stablePath })),
  );

  // Port-interface references
  addRels('provides_interface',
    model.pPorts.filter((p) => Boolean(p.interfaceRef)).map((p) => ({ sourceArPath: p.stablePath, targetArPath: p.interfaceRef! })),
  );
  addRels('requires_interface',
    model.rPorts.filter((r) => Boolean(r.interfaceRef)).map((r) => ({ sourceArPath: r.stablePath, targetArPath: r.interfaceRef! })),
  );

  // Data elements and operations
  addRels('has_data_element',
    model.dataElements.map((d) => ({ sourceArPath: d.interfaceArPath, targetArPath: d.stablePath })),
  );
  addRels('has_operation',
    model.operations.map((o) => ({ sourceArPath: o.interfaceArPath, targetArPath: o.stablePath })),
  );

  // Internal behavior
  addRels('has_internal_behavior',
    model.internalBehaviors.map((b) => ({ sourceArPath: b.swcArPath, targetArPath: b.stablePath })),
  );
  addRels('implements_behavior',
    model.implementations.filter((i) => Boolean(i.behaviorRef)).map((i) => ({ sourceArPath: i.stablePath, targetArPath: i.behaviorRef! })),
  );

  // Assembly connector port refs
  addRels('provider_port',
    model.assemblyConnectors.filter((c) => Boolean(c.providerPortRef)).map((c) => ({ sourceArPath: c.stablePath, targetArPath: c.providerPortRef! })),
  );
  addRels('requester_port',
    model.assemblyConnectors.filter((c) => Boolean(c.requesterPortRef)).map((c) => ({ sourceArPath: c.stablePath, targetArPath: c.requesterPortRef! })),
  );

  // Delegation connector port refs
  addRels('inner_port',
    model.delegationConnectors.filter((c) => Boolean(c.innerPortRef)).map((c) => ({ sourceArPath: c.stablePath, targetArPath: c.innerPortRef! })),
  );
  addRels('outer_port',
    model.delegationConnectors.filter((c) => Boolean(c.outerPortRef)).map((c) => ({ sourceArPath: c.stablePath, targetArPath: c.outerPortRef! })),
  );

  // System root compositions
  addRels('has_root_composition',
    model.rootCompositions.map((r) => ({ sourceArPath: r.systemArPath, targetArPath: r.stablePath })),
  );
  addRels('software_composition_tref',
    model.rootCompositions.filter((r) => Boolean(r.softwareCompositionRef)).map((r) => ({ sourceArPath: r.stablePath, targetArPath: r.softwareCompositionRef! })),
  );


  // ── Phase A relationships ─────────────────────────────────────────────────

  addRels('contains_impl_data_type',
    model.implDataTypes.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_sw_base_type',
    model.swBaseTypes.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_compu_method',
    model.compuMethods.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_data_constr',
    model.dataConstrs.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_mode_declaration_group',
    model.modeDeclarationGroups.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_data_type_mapping_set',
    model.dataTypeMappingSets.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_app_data_type',
    model.appDataTypes.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_unit',
    model.units.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_bsw_module_description',
    model.bswModuleDescriptions.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_bsw_module_entry',
    model.bswModuleEntries.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );

  // MS/NV/Param/Trigger interface containment
  addRels('contains_port_interface_ms_nv_param_trigger', [
    ...model.msInterfaces.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
    ...model.nvDataInterfaces.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
    ...model.parameterInterfaces.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
    ...model.triggerInterfaces.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  ]);

  // Impl data type sub-elements
  addRels('has_sub_element',
    model.implDataTypeElements.map((it) => ({ sourceArPath: it.parentStablePath, targetArPath: it.stablePath })),
  );
  addRels('references_type',
    model.implDataTypeElements.filter((it) => Boolean(it.typeRef)).map((it) => ({ sourceArPath: it.stablePath, targetArPath: it.typeRef! })),
  );

  // Mode-switch interface mode group ref
  addRels('has_mode_group',
    model.msInterfaces.filter((it) => Boolean(it.modeGroupRef)).map((it) => ({ sourceArPath: it.stablePath, targetArPath: it.modeGroupRef! })),
  );

  // Runnable entities
  addRels('has_runnable',
    model.runnableEntities.map((it) => ({ sourceArPath: it.behaviorArPath, targetArPath: it.stablePath })),
  );

  // Events
  addRels('has_event',
    model.events.map((e) => ({ sourceArPath: e.behaviorArPath, targetArPath: e.stablePath })),
  );
  addRels('triggers_runnable',
    model.events.filter((e) => Boolean(e.startOnEventRef)).map((e) => ({ sourceArPath: e.stablePath, targetArPath: e.startOnEventRef! })),
  );

  // Exclusive areas
  addRels('has_exclusive_area',
    model.exclusiveAreas.map((it) => ({ sourceArPath: it.behaviorArPath, targetArPath: it.stablePath })),
  );

  // Per-instance memories
  addRels('has_per_instance_memory',
    model.perInstanceMemories.map((it) => ({ sourceArPath: it.behaviorArPath, targetArPath: it.stablePath })),
  );

  // BSW behaviors and entities
  addRels('has_bsw_behavior',
    model.bswInternalBehaviors.map((it) => ({ sourceArPath: it.moduleArPath, targetArPath: it.stablePath })),
  );
  addRels('has_bsw_entity',
    model.bswEntities.map((e) => ({ sourceArPath: e.behaviorArPath, targetArPath: e.stablePath })),
  );
  addRels('implements_entry',
    model.bswEntities.filter((e) => Boolean(e.implementedEntryRef)).map((e) => ({ sourceArPath: e.stablePath, targetArPath: e.implementedEntryRef! })),
  );

  // PR-ports
  addRels('has_pr_port',
    model.prPorts.map((it) => ({ sourceArPath: it.ownerStablePath, targetArPath: it.stablePath })),
  );
  addRels('provides_requires_interface',
    model.prPorts.filter((it) => Boolean(it.interfaceRef)).map((it) => ({ sourceArPath: it.stablePath, targetArPath: it.interfaceRef! })),
  );

  // Constant specifications
  addRels('contains_constant_specification',
    model.constantSpecifications.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );

  // SW address methods
  addRels('contains_sw_addr_method',
    model.swAddrMethods.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );

  // ── Phase B relationships ─────────────────────────────────────────────────

  addRels('contains_ecu_instance',
    model.ecuInstances.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_comm_cluster',
    model.commClusters.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_comm_frame',
    model.commFrames.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_i_signal',
    model.iSignals.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_i_pdu',
    model.iSignalIPdus.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_i_pdu_group',
    model.iPduGroups.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_system_signal',
    model.systemSignals.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_system_signal_group',
    model.systemSignalGroups.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_i_signal_group',
    model.iSignalGroups.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_lin_sporadic_frame',
    model.linSporadicFrames.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_flat_map',
    model.flatMaps.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('maps_signal',
    model.srToSignalMappings.filter((it) => Boolean(it.signalRef)).map((it) => ({ sourceArPath: it.stablePath, targetArPath: it.signalRef! })),
  );
  addRels('has_signal_mapping',
    model.srToSignalMappings.map((it) => ({ sourceArPath: it.systemArPath, targetArPath: it.stablePath })),
  );
  addRels('has_flat_instance',
    model.flatInstanceDescriptors.map((it) => ({ sourceArPath: it.flatMapArPath, targetArPath: it.stablePath })),
  );

  // ── Phase C relationships ─────────────────────────────────────────────────

  addRels('contains_ecuc_value_collection',
    model.ecucValueCollections.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('contains_ecuc_module_config',
    model.ecucModuleConfigs.map((it) => ({ sourceArPath: it.packageStablePath, targetArPath: it.stablePath })),
  );
  addRels('has_ecuc_container',
    model.ecucContainerValues.filter((it) => Boolean(it.parentStablePath)).map((it) => ({ sourceArPath: it.parentStablePath, targetArPath: it.stablePath })),
  );

  // Return batches sorted alphabetically by relationship name for deterministic output
  return [...batchMap.values()].sort((a, b) => a.relationship.localeCompare(b.relationship));
}
