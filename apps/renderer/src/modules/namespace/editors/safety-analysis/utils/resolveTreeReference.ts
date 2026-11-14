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
import { api } from '../../../../../api/riacore';
import type { SelectedTreeElement } from '../types';

/** Resolve authored roots without relying on their host branch being loaded. */
export async function resolveTreeReference(
  node: SelectedTreeElement,
  cachedHost?: { node_id: number; namespace: string } | null,
) {
  if (node.hostNodeId !== undefined && node.hostNamespace !== undefined) {
    return { reference: node, host: { node_id: node.hostNodeId, namespace: node.hostNamespace } };
  }
  if (node.concept === 'risk_rating') {
    const parent = await api.safety.getMalfunctionForRiskRating(node.nodeId);
    if (!parent) return null;
    const malfunction = await api.safety.getMalfunction(parent.node_id);
    return malfunction.occursAtTarget ? {
      reference: { nodeId: parent.node_id, namespace: parent.namespace, concept: parent.concept },
      host: malfunction.occursAtTarget,
    } : null;
  }
  if (node.concept === 'safety_note') {
    const host = cachedHost ?? await api.safety.getNoteParent(node.nodeId);
    return host ? { reference: node, host } : null;
  }
  if (node.concept === 'malfunction') {
    const host = cachedHost ?? (await api.safety.getMalfunction(node.nodeId)).occursAtTarget;
    return host ? { reference: node, host } : null;
  }
  return null;
}
