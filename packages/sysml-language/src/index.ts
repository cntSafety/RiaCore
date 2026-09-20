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
 * @riacore/sysml-language — public API
 *
 * Exports the Langium SysML v2 services and all generated AST types/guards
 * needed by consumers (e.g. the sysml-v2-textual importer).
 */

// Service factory — call this to get a ready-to-use parse helper
export { createSysmlSubsetServices } from './sysml-module.js';

// Generated AST types and type guards (re-exported for consumers)
export type {
  Namespace, Element, OwningMembership, Import, Membership,
  Package, LibraryPackage,
  PartDefinition, PortDefinition, ItemDefinition, AttributeDefinition,
  EnumerationDefinition, ActionDefinition, StateDefinition,
  InterfaceDefinition, RequirementDefinition, ConstraintDefinition,
  ConnectionDefinition, FlowConnectionDefinition, UseCaseDefinition,
  ViewDefinition, ViewpointDefinition, MetadataDefinition,
  PartUsage, PortUsage, ItemUsage, AttributeUsage, ActionUsage,
  StateUsage, ExhibitStateUsage, ConnectionUsage, InterfaceUsage,
  FlowConnectionUsage, RequirementUsage, BindingConnectorAsUsage,
  Connector, ItemFlow, ItemFlowEnd,
  Definition, Usage, Feature, Type, Classifier,
} from './generated/ast.js';

export {
  isPackage, isLibraryPackage,
  isPartDefinition, isPortDefinition, isItemDefinition, isAttributeDefinition,
  isEnumerationDefinition, isActionDefinition, isStateDefinition,
  isInterfaceDefinition, isRequirementDefinition, isConstraintDefinition,
  isConnectionDefinition, isFlowConnectionDefinition, isUseCaseDefinition,
  isViewDefinition, isViewpointDefinition, isMetadataDefinition,
  isPartUsage, isPortUsage, isItemUsage, isAttributeUsage, isActionUsage,
  isStateUsage, isExhibitStateUsage, isConnectionUsage, isInterfaceUsage,
  isFlowConnectionUsage, isRequirementUsage,
  // Connector-shaped usages and the flow-specific end node. `isConnector`
  // matches every usage that carries `ends` — connections, interfaces,
  // allocations, flows, successions, bindings — which is what lets the importer
  // read endpoint paths without enumerating AST `$type` literals.
  isConnector, isItemFlow, isItemFlowEnd,
  // A binding is a connector in its own right rather than a ConnectionUsage
  // subtype, so it needs its own guard: `isConnectionUsage` does not match it.
  isBindingConnectorAsUsage,
  // Annotating elements. `Documentation` extends `Comment` in the AST, so a
  // consumer matching both must test the concrete guard first.
  isDocumentation, isComment,
  isOwningMembership, isElement, isNamespace, isDefinition, isUsage,
  isFeature, isType, isClassifier,
} from './generated/ast.js';
