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
 * sysml-v2-endpoints.ts
 *
 * Normalises connector endpoints into the one shape the CommonModel projection
 * resolves: a `(container, pin)` feature chain.
 *
 * The pilot implementation's serialization is not uniform across connector kinds,
 * and the projection's contextual-pin rule needs exactly two chain members — one
 * containing usage and one pin. Where the export already provides that, nothing
 * here fires:
 *
 * - `connect a.p to b.p` — the pilot emits an anonymous Feature with one
 *   FeatureChaining per segment, and `source`/`target` point at that Feature.
 *   Already resolvable; untouched.
 * - `allocate a.b to c.d.e` — chains of two to five *containers* with no pin. The
 *   projection drops them, which is correct: allocation is a container-to-container
 *   relation and the canvas has no edge kind for it. Untouched.
 *
 * Two kinds arrive unusable, and this pass rewrites them:
 *
 * - **flows.** `source`/`target` are the derived Connector ends, which the pilot
 *   sets to the *containing action usage* — `measurePhaseCurrents`, not
 *   `measurePhaseCurrents.id_meas`. The pin is present but one level down, on the
 *   `FlowEnd`: its `ReferenceSubsetting` names the container and a nested
 *   `Redefinition` names the pin. Every flow in a real export was losing its pin
 *   this way, so a decomposed action definition drew its steps and nothing joining
 *   them.
 * - **bindings.** The qualified end (`step.T_in`) already arrives as a proper
 *   two-member chain. The bare end (`= T_accel`) points straight at a parameter of
 *   the *enclosing* definition, leaving the container implicit — which is the
 *   canonical form (`bind a_out = acc.a` in the specification's own examples). A
 *   payload feature is not a pin on its own, so the owner is named here to put
 *   both ends into the same shape.
 *
 * This mirrors `materializeConnectorEndpoints` in the textual importer, which
 * performs the same normalisation on the same concepts. Keeping the two in step is
 * what lets one projection rule serve both importers rather than the query catalog
 * growing a third endpoint shape.
 */
import type { SysmlModel, SysmlElementInfo } from './sysml-v2-parser.js';

/** Concepts whose endpoints this pass rewrites. */
const FLOW_CONCEPT = 'flow_usage';
const BINDING_CONCEPT = 'binding_connector_as_usage';

/**
 * Features that carry a container's payload rather than being containers
 * themselves — an action's parameter, a port definition's item. A pin, in the
 * projection's terms. Matches `PAYLOAD_FEATURE_CONCEPTS` in the textual importer.
 */
const PAYLOAD_FEATURE_CONCEPTS: ReadonlySet<string> = new Set([
  'item_usage',
  'attribute_usage',
  'reference_usage',
]);

interface Index {
  byId: Map<string, SysmlElementInfo>;
  /** Specialization records (Subsetting, Redefinition, …) keyed by their `specific` end. */
  bySpecific: Map<string, SysmlElementInfo[]>;
  /** Elements keyed by their owner. */
  ownedBy: Map<string, SysmlElementInfo[]>;
}

function indexElements(elements: SysmlElementInfo[]): Index {
  const byId = new Map<string, SysmlElementInfo>();
  const bySpecific = new Map<string, SysmlElementInfo[]>();
  const ownedBy = new Map<string, SysmlElementInfo[]>();
  for (const element of elements) {
    byId.set(element.id, element);
    if (element.specificId !== undefined) {
      const list = bySpecific.get(element.specificId) ?? [];
      list.push(element);
      bySpecific.set(element.specificId, list);
    }
    if (element.ownerId !== undefined) {
      const list = ownedBy.get(element.ownerId) ?? [];
      list.push(element);
      ownedBy.set(element.ownerId, list);
    }
  }
  return { byId, bySpecific, ownedBy };
}

/**
 * The `(container, pin)` pair a `FlowEnd` denotes.
 *
 * SysML splits a flow end in two: the container is subsetted on the end itself,
 * and the payload feature is a nested feature that *redefines* the container's
 * feature. Neither half is a chain, which is why recombining them here is what
 * lets a flow reach the same projection rule a written `a.b` endpoint does.
 */
function flowEndPair(end: SysmlElementInfo, index: Index): [SysmlElementInfo, SysmlElementInfo] | undefined {
  const subsetting = (index.bySpecific.get(end.id) ?? [])
    .find((record) => record.concept === 'reference_subsetting');
  const container = subsetting?.generalId === undefined ? undefined : index.byId.get(subsetting.generalId);
  if (!container) return undefined;

  for (const owned of index.ownedBy.get(end.id) ?? []) {
    const redefinition = (index.bySpecific.get(owned.id) ?? [])
      .find((record) => record.concept === 'redefinition');
    const pin = redefinition?.generalId === undefined ? undefined : index.byId.get(redefinition.generalId);
    if (pin) return [container, pin];
  }
  return undefined;
}

/** The owner of a payload feature, which is the container it is a pin of. */
function ownerOf(pin: SysmlElementInfo, index: Index): SysmlElementInfo | undefined {
  return pin.ownerId === undefined ? undefined : index.byId.get(pin.ownerId);
}

/**
 * Rewrite unusable connector endpoints as `(container, pin)` chains.
 *
 * Mutates `model.elements`: appends the synthetic `feature` and `feature_chaining`
 * records, and re-points the connector's `sourceIds`/`targetIds` at the synthetic
 * feature. Returns how many endpoints were rewritten, for the import report.
 *
 * Ids are derived from the connector's own id and the endpoint role, so a
 * re-import of unchanged source produces the same ids — `stablePath` is the
 * importer's identity key, and a synthetic that renumbered between runs would
 * churn node ids for connectors that did not change.
 */
export function materializeConnectorEndpoints(model: SysmlModel): number {
  const index = indexElements(model.elements);
  const synthetic: SysmlElementInfo[] = [];
  let rewritten = 0;

  function addSynthetic(id: string, concept: string, overrides: Partial<SysmlElementInfo>): SysmlElementInfo {
    const element: SysmlElementInfo = {
      id,
      elementId: id,
      // Not a real SysML type; the synthetics exist to carry the chain shape.
      type: 'Feature' as SysmlElementInfo['type'],
      concept,
      stablePath: `/${concept}/${concept}@${id}`,
      name: '',
      declaredName: '',
      qualifiedName: '',
      typeIds: [], definitionIds: [], sourceIds: [], targetIds: [],
      memberIds: [], membershipIds: [], ownedMembershipIds: [], ownedElementIds: [],
      connectorEndIds: [],
      ...overrides,
    };
    synthetic.push(element);
    return element;
  }

  /** Replace one endpoint of `connector` with a chain through `container` and `pin`. */
  function rewrite(
    connector: SysmlElementInfo,
    role: 'source' | 'target',
    container: SysmlElementInfo,
    pin: SysmlElementInfo,
  ): void {
    const base = `${connector.id}-${role}`;
    const feature = addSynthetic(`${base}-feature`, 'feature', {});
    // One chaining record per member. `sourceIds` becomes `references_source`
    // (chain -> feature) and `chainingFeatureId` becomes `chains_feature`
    // (chain -> member), which is exactly the pair the projection matches on.
    for (const [position, member] of [container, pin].entries()) {
      addSynthetic(`${base}-chain-${position}`, 'feature_chaining', {
        sourceIds: [feature.id],
        chainingFeatureId: member.id,
      });
    }
    if (role === 'source') connector.sourceIds = [feature.id];
    else connector.targetIds = [feature.id];
    rewritten += 1;
  }

  for (const connector of model.elements) {
    const isFlow = connector.concept === FLOW_CONCEPT;
    const isBinding = connector.concept === BINDING_CONCEPT;
    if (!isFlow && !isBinding) continue;

    // `bind a = b` reads right to left: the `=` puts the destination on the left, as
    // the specification's own examples use it — `bind 'generate torque'.fuelCmd =
    // fuelCmd` delegates an enclosing parameter inward, `bind wheelTorque1 =
    // 'distribute torque'.wheelTorque1` carries a nested result outward. The pilot
    // derives `source`/`target` in declaration order, so it names the destination as
    // the source, and every boundary delegation arrives inverted.
    //
    // Swapped here, before the ends are resolved, so the rest of this pass and
    // everything downstream see one orientation. A binding draws no arrow, so this is
    // not about an arrowhead: ELK assigns layers from edge direction, and an inbound
    // delegation pointing from the child back to its own frame is a backward edge
    // that gets routed out of the port, around, and back in.
    //
    // Matches `materializeConnectorEndpoints` in the textual importer, which applies
    // the same reading to the same construct.
    if (isBinding) {
      const sources = connector.sourceIds;
      connector.sourceIds = connector.targetIds;
      connector.targetIds = sources;
    }

    for (const role of ['source', 'target'] as const) {
      const endpointId = (role === 'source' ? connector.sourceIds : connector.targetIds)[0];
      if (endpointId === undefined) continue;
      const endpoint = index.byId.get(endpointId);
      if (!endpoint) continue;

      if (isFlow) {
        // The endpoint is the container; the pin is on the matching FlowEnd. Ends
        // are matched by role position, which is the order `connectorEnd` records
        // them in — the same order `source`/`target` are derived from.
        const endId = connector.connectorEndIds[role === 'source' ? 0 : 1];
        const end = endId === undefined ? undefined : index.byId.get(endId);
        const pair = end ? flowEndPair(end, index) : undefined;
        if (!pair) continue;
        const [container, pin] = pair;
        // A flow end whose container is a *port* resolves to that port, not to a
        // chain: `flow from systemStatusIn.status to ...` names the port's payload
        // item, and the port is already the pin a diagram draws on. Wrapping it in
        // a chain would be actively wrong — the projection's contextual-pin rule
        // accepts only a part or action as the container, so a `(port, item)` chain
        // resolves to nothing and the end is lost. This is the same carve-out the
        // textual importer makes, and it is what keeps a port-to-action flow drawn.
        if (container.concept === 'port_usage') {
          if (role === 'source') connector.sourceIds = [container.id];
          else connector.targetIds = [container.id];
          continue;
        }
        rewrite(connector, role, container, pin);
        continue;
      }

      // A binding's qualified end already arrives as a two-member chain and is
      // left alone; only a bare end pointing straight at a payload feature needs
      // its implicit container named.
      if (PAYLOAD_FEATURE_CONCEPTS.has(endpoint.concept)) {
        const owner = ownerOf(endpoint, index);
        if (owner) rewrite(connector, role, owner, endpoint);
      }
    }
  }

  model.elements.push(...synthetic);
  return rewritten;
}
