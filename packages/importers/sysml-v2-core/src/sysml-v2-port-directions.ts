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
 * sysml-v2-port-directions.ts
 *
 * Gives each port usage the direction its payload actually flows.
 *
 * SysML v2 has no "input port" or "output port" kind. A port is a bundle, and
 * direction is declared on the *features the port carries*:
 *
 *     port def SystemStatusOutputPort { out item status : SystemStatus; }
 *     port systemStatusOut : SystemStatusOutputPort;   // therefore sends status
 *     port systemStateIn   : ~SystemStatusOutputPort;  // therefore receives it
 *
 * Reading that needs three things at once: the port, the definition it is typed
 * by, and that definition's features. Only the importer holds all three. The view
 * layer cannot do it, because a feature's `direction` lives inside the opaque
 * `attributes` JSON of a *different* node and the query engine has no JSON
 * parsing. So the effective direction is materialised here and the projection
 * reads it as if the port had declared it outright — `builtin-mappings.ts`
 * resolves the placeholder `Port` concept to `InPort`/`OutPort` from exactly this
 * attribute, and falls back to `InOutPort` when it is absent.
 *
 * Without this pass every typed port imported from JSON projected as `InOutPort`
 * and drew as a hollow "bidirectional" pin, regardless of which way its data ran.
 *
 * This mirrors `resolvePortDirections` in the textual importer, which performs the
 * same resolution on the same concepts. The two differ only in how they reach a
 * port's type, because the textual AST carries type *names* while the JSON export
 * carries ids:
 *
 * - textual: a conjugated port is marked by a `ConjugatedPortTyping` in its
 *   heritage, so the flag rides on the port usage (`isConjugated`) and the type
 *   name resolves straight to the port definition.
 * - JSON: the port usage's `isConjugated` is `false`; its `type` points at a
 *   derived `ConjugatedPortDefinition` whose own feature list is empty and whose
 *   `originalPortDefinition` names the real definition. Conjugation is therefore
 *   discovered while resolving the type, not before.
 *
 * Deliberately conservative, matching the textual pass: a port whose features
 * disagree — a `MixedPort` that sends power and receives status — or that resolves
 * to no directed features at all is left alone and stays bidirectional. That is a
 * real answer rather than a missing one, and the diagram already knows how to draw
 * it. Scope is likewise the same: the port's own features, else the features its
 * definition declares. Directions inherited through a port definition's
 * supertypes are not walked.
 */
import type { SysmlModel, SysmlElementInfo } from './sysml-v2-parser.js';

/** The concept whose direction this pass resolves. */
const PORT_USAGE_CONCEPT = 'port_usage';

/** A feature direction as SysML declares it. */
type FeatureDirection = 'in' | 'out' | 'inout';

function asFeatureDirection(value: string | undefined): FeatureDirection | undefined {
  return value === 'in' || value === 'out' || value === 'inout' ? value : undefined;
}

/** Conjugating a port swaps the direction of everything it carries. */
function conjugated(direction: FeatureDirection): FeatureDirection {
  return direction === 'in' ? 'out' : direction === 'out' ? 'in' : 'inout';
}

/** The definition a port usage is typed by, and whether that typing conjugates it. */
interface ResolvedType {
  definition: SysmlElementInfo;
  isConjugated: boolean;
}

/**
 * Write the effective `direction` onto every port usage that does not declare one.
 *
 * Mutates `model.elements`. Returns how many ports were resolved, for the import
 * report.
 */
export function resolvePortDirections(model: SysmlModel): number {
  const byId = new Map(model.elements.map((element) => [element.id, element]));
  const ownedBy = new Map<string, SysmlElementInfo[]>();
  for (const element of model.elements) {
    if (element.ownerId === undefined) continue;
    const owned = ownedBy.get(element.ownerId) ?? [];
    owned.push(element);
    ownedBy.set(element.ownerId, owned);
  }

  /** The single direction `owner`'s own features agree on, if they do. */
  function featureDirection(owner: SysmlElementInfo | undefined): FeatureDirection | undefined {
    if (!owner) return undefined;
    const declared = new Set(
      (ownedBy.get(owner.id) ?? [])
        .map((feature) => asFeatureDirection(feature.direction))
        .filter((direction): direction is FeatureDirection => direction !== undefined),
    );
    return declared.size === 1 ? [...declared][0] : undefined;
  }

  /**
   * The port definition behind a usage's type, unwrapping a conjugation.
   *
   * A conjugated port's type is not in `elements` at all — `ConjugatedPortDefinition`
   * is not an imported concept — so an id that resolves to nothing is the signal to
   * consult the conjugation map rather than a sign of a broken reference.
   */
  function resolveType(port: SysmlElementInfo): ResolvedType | undefined {
    for (const typeId of [...port.typeIds, ...port.definitionIds]) {
      const direct = byId.get(typeId);
      if (direct) return { definition: direct, isConjugated: false };

      const originalId = model.conjugatedPortDefinitions.get(typeId);
      const original = originalId === undefined ? undefined : byId.get(originalId);
      if (original) return { definition: original, isConjugated: true };
    }
    return undefined;
  }

  let resolved = 0;
  for (const port of model.elements) {
    // An explicit direction on the port itself is the author's word — `in port p : P`
    // is legal SysML — and is never overridden.
    if (port.concept !== PORT_USAGE_CONCEPT || asFeatureDirection(port.direction)) continue;

    // Features declared on the port body win over the ones it inherits, matching
    // how a redefinition shadows the definition it came from.
    const own = featureDirection(port);
    if (own) {
      port.direction = port.isConjugated ? conjugated(own) : own;
      resolved += 1;
      continue;
    }

    const type = resolveType(port);
    const declared = featureDirection(type?.definition);
    if (!type || !declared) continue;

    // Both conjugation channels flip: the JSON one found while resolving the type,
    // and the flag on the usage itself, which the textual export sets instead.
    const flip = type.isConjugated !== (port.isConjugated === true);
    port.direction = flip ? conjugated(declared) : declared;
    resolved += 1;
  }

  return resolved;
}
