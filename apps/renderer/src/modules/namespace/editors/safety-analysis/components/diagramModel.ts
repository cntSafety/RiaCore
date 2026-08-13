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
import type { MalfunctionInfo, ConnectorInfo, PortInfo } from '@riacore/app-contracts';

// Re-export for use in other modules (ConnectorInfo is used by buildDiagramModel)
export type { MalfunctionInfo, ConnectorInfo };

// ---------------------------------------------------------------------------
// Concept classification
// ---------------------------------------------------------------------------

export const PORT_CONCEPTS = new Set(['p_port', 'r_port', 'pr_port']);

export const SWC_CONCEPTS = new Set([
  'application_swc',
  'composition_swc',
  'service_swc',
  'ecu_abstraction_swc',
  'cdd_swc',
  'sensor_actuator_swc',
  'nv_block_swc',
  'parameter_swc',
  'service_proxy_swc',
]);

// ---------------------------------------------------------------------------
// ASIL ordering
// ---------------------------------------------------------------------------

export const ASIL_ORDER: Record<string, number> = {
  QM: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface DiagramModel {
  /** The center component with split IN/OUT ports. */
  center: DiagramCenterComponent;
  /** Components in the left (sender) column. */
  senders: DiagramComponent[];
  /** Components in the right (receiver) column. */
  receivers: DiagramComponent[];
  /** Left-side links: partner port → focus IN port. */
  leftLinks: DiagramLink[];
  /** Right-side links: focus OUT port → partner port. */
  rightLinks: DiagramLink[];
}

export interface DiagramCenterComponent {
  /** node_id of the owning SWC. */
  nodeId: number;
  /** Short name of the component. */
  name: string;
  /** SWC concept (e.g. 'application_swc'). */
  concept: string;
  /** Namespace of the component. */
  namespace: string;
  /** Whether any displayed port has malfunctions. */
  hasMalfunction: boolean;
  /** Max ASIL rating across all displayed ports, or null. */
  maxAsil: string | null;
  /** Subtitle text (e.g. "Component · <concept>"). */
  subtitle: string;
  /** IN ports (requester ports that receive data from senders). */
  portsLeft: DiagramPort[];
  /** OUT ports (provider ports that send data to receivers). */
  portsRight: DiagramPort[];
  /** Ports that exist on the component but have no connector in the current data. */
  portsUnconnected: DiagramPort[];
}

export interface DiagramComponent {
  /** node_id of the owning SWC. */
  nodeId: number;
  /** Short name of the component. */
  name: string;
  /** SWC concept (e.g. 'application_swc'). */
  concept: string;
  /** Namespace of the component. */
  namespace: string;
  /** Whether any displayed port has malfunctions. */
  warn: boolean;
  /** Max ASIL rating across all displayed ports, or null. */
  maxAsil: string | null;
  /** All ports on this component involved in displayed connectors. */
  ports: DiagramPartnerPort[];
}

export interface DiagramPort {
  /** Unique ID for ref tracking (e.g. `"port-{nodeId}"`). */
  id: string;
  /** node_id of the port. */
  nodeId: number;
  /** Short name of the port. */
  name: string;
  /** Port type: p_port, r_port, pr_port. */
  portType: 'p_port' | 'r_port' | 'pr_port';
  /** 'in' or 'out' direction for display. */
  dir: 'in' | 'out';
  /** Whether this port has any malfunctions. */
  warn: boolean;
  /** Max ASIL rating string for this port's malfunctions, or null. */
  maxAsil: string | null;
  /** Namespace of the owning component (for tree navigation). */
  namespace: string;
  /** Malfunctions attached to this port (for navigation). */
  malfunctions: DiagramMalfunctionRef[];
}

export interface DiagramPartnerPort {
  /** Unique ID for ref tracking (e.g. `"partner-{nodeId}"`). */
  id: string;
  /** node_id of the port. */
  nodeId: number;
  /** Short name of the port. */
  name: string;
  /** Port type: p_port, r_port, pr_port. */
  portType: 'p_port' | 'r_port' | 'pr_port';
  /** Whether this port has any malfunctions. */
  warn: boolean;
  /** Max ASIL rating string for this port's malfunctions, or null. */
  maxAsil: string | null;
  /** Namespace of the owning component (for tree navigation). */
  namespace: string;
  /** Malfunctions attached to this port (for navigation). */
  malfunctions: DiagramMalfunctionRef[];
  /** ID of the connected focus port (sender → focus IN port). */
  toFocusPort?: string;
  /** ID of the connected focus port (focus OUT port → receiver). */
  fromFocusPort?: string;
}

/** Lightweight malfunction reference for navigation from port pins. */
export interface DiagramMalfunctionRef {
  /** node_id of the malfunction. */
  nodeId: number;
  /** Display name of the malfunction. */
  name: string;
  /** Malfunction description text. */
  description: string;
}

export interface DiagramLink {
  /** ID of the port on the partner card. */
  partnerPort: string;
  /** ID of the port on the focus component. */
  focusPort: string;
  /** Whether either port has malfunctions (determines path color). */
  warn: boolean;
  /** 'assembly_connector' | 'delegation_connector' — delegation uses dashed stroke. */
  connectorType: 'assembly_connector' | 'delegation_connector';
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Converts an ASIL string to a numeric level for comparison.
 *
 * Core levels map directly: QM=0, A=1, B=2, C=3, D=4.
 * Decomposition variants (e.g. `A(B)`, `QM(D)`) resolve to the highest
 * component level. Unrecognized strings return -1.
 */
export function parseAsilLevel(asil: string): number {
  if (!asil) return -1;

  const trimmed = asil.trim();

  // Check for decomposition variant like "A(B)" or "QM(D)"
  const decompositionMatch = trimmed.match(/^([A-Z]+)\(([A-Z]+)\)$/);
  if (decompositionMatch) {
    const level1 = ASIL_ORDER[decompositionMatch[1]] ?? -1;
    const level2 = ASIL_ORDER[decompositionMatch[2]] ?? -1;
    return Math.max(level1, level2);
  }

  // Direct lookup
  const level = ASIL_ORDER[trimmed];
  return level !== undefined ? level : -1;
}

/**
 * Returns true for any of the 12 valid port and SWC concepts.
 */
export function isDiagramConcept(concept: string): boolean {
  return PORT_CONCEPTS.has(concept) || SWC_CONCEPTS.has(concept);
}

/**
 * Returns the ASIL string with the highest resolved level from a list of
 * malfunctions, or `null` for empty arrays.
 *
 * Uses the ordering QM < A < B < C < D. Decomposition variants resolve to
 * their highest component level.
 */
export function resolveMaxAsil(malfunctions: MalfunctionInfo[]): string | null {
  if (malfunctions.length === 0) return null;

  let maxLevel = -1;
  let maxAsil: string | null = null;

  for (const malfunction of malfunctions) {
    const level = parseAsilLevel(malfunction.asil);
    if (level > maxLevel) {
      maxLevel = level;
      maxAsil = malfunction.asil;
    }
  }

  // Malfunctions exist but none have a recognized ASIL → treat as QM
  if (maxAsil === null || maxLevel < 0) return 'QM';

  return maxAsil;
}

// ---------------------------------------------------------------------------
// Name resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolves a display name for a component from its PortInfo fields.
 * Falls back to the last segment of ownerStablePath, or "Component <nodeId>".
 */
function resolveOwnerName(ownerName: string, ownerStablePath: string, ownerNodeId: number): string {
  if (ownerName && ownerName.trim().length > 0) {
    return ownerName;
  }
  if (ownerStablePath && ownerStablePath.trim().length > 0) {
    const segments = ownerStablePath.split('/').filter(Boolean);
    if (segments.length > 0) {
      return segments[segments.length - 1];
    }
  }
  return `Component ${ownerNodeId}`;
}

// ---------------------------------------------------------------------------
// ASIL color mapping for diagram rendering
// ---------------------------------------------------------------------------

/**
 * Maps an ASIL rating string to a CSS hex color for diagram rendering.
 * Uses the same ASIL ordering as getAsilColor but returns hex values
 * suitable for inline styles (borders, squares).
 *
 * Returns null when there is no ASIL (no malfunctions).
 */
export function getAsilHexColor(asil: string | null): string | null {
  if (!asil) return null;

  // Resolve decomposition to highest component
  const level = parseAsilLevel(asil);
  const LEVEL_COLORS: Record<number, string> = {
    0: '#8c8c8c', // QM — neutral grey
    1: '#52c41a', // A — green
    2: '#a0d911', // B — lime
    3: '#ffa940', // C — light orange
    4: '#d4380d', // D — dark orange-red (volcano)
  };
  return LEVEL_COLORS[level] ?? null;
}

// ---------------------------------------------------------------------------
// Port name prefix stripping
// ---------------------------------------------------------------------------

/**
 * Returns the port name as-is. Previously this function stripped owner-name
 * prefixes to shorten labels, but that caused confusion about which port
 * belongs to which component. Now the full name is always displayed.
 */
export function stripPortPrefix(portName: string, _ownerName: string): string {
  return portName;
}

// ---------------------------------------------------------------------------
// buildConnectorPath
// ---------------------------------------------------------------------------

/**
 * Generates an SVG cubic Bezier path string from point (x1, y1) to (x2, y2).
 *
 * Control points are placed at the horizontal midpoint, producing a smooth
 * S-curve. Matches the `buildPath` pattern used in `WorkspaceCanvas.tsx`.
 *
 * Formula: `M x1 y1 C x1+dx y1, x2-dx y2, x2 y2`
 * where `dx = (x2 - x1) * 0.5`
 */
export function buildConnectorPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// buildDiagramModel
// ---------------------------------------------------------------------------

/**
 * Transforms raw ConnectorInfo[] into a render-ready DiagramModel.
 *
 * Algorithm:
 * 1. Iterate connectors, classifying each as outgoing (center owns sourcePort)
 *    or incoming (center owns targetPort). Self-loops are skipped.
 * 2. Deduplicate focus ports by nodeId.
 * 3. Deduplicate partner components by ownerNodeId, aggregating ports.
 * 4. Build and return the DiagramModel.
 */
export function buildDiagramModel(
  connectors: ConnectorInfo[],
  centerComponentNodeId: number,
  centerComponentName: string,
  centerComponentConcept: string,
  componentMalfunctions: Record<number, MalfunctionInfo[]> = {},
  centerComponentNamespace = '',
  unconnectedPorts: PortInfo[] = [],
): DiagramModel {
  // Maps keyed by ownerNodeId for deduplication
  const sendersMap = new Map<number, DiagramComponent>();
  const receiversMap = new Map<number, DiagramComponent>();

  // Focus ports deduplicated by port nodeId
  const portsLeftMap = new Map<number, DiagramPort>();   // IN ports (center owns targetPort)
  const portsRightMap = new Map<number, DiagramPort>();  // OUT ports (center owns sourcePort)

  const leftLinks: DiagramLink[] = [];
  const rightLinks: DiagramLink[] = [];

  for (const connector of connectors) {
    const { sourcePort, targetPort, connectorType } = connector;

    const centerOwnsSource = sourcePort.ownerNodeId === centerComponentNodeId;
    const centerOwnsTarget = targetPort.ownerNodeId === centerComponentNodeId;

    // Skip self-loop connectors
    if (centerOwnsSource && centerOwnsTarget) {
      continue;
    }

    if (centerOwnsSource) {
      // Outgoing connection: center provides data to receiver
      const srcPortId = `port-${sourcePort.nodeId}`;
      const tgtPortId = `partner-${targetPort.nodeId}`;
      const srcWarn = sourcePort.malfunctions.length > 0;
      const tgtWarn = targetPort.malfunctions.length > 0;
      const linkWarn = srcWarn || tgtWarn;

      // Add sourcePort to focus OUT ports (portsRight), deduplicated
      if (!portsRightMap.has(sourcePort.nodeId)) {
        portsRightMap.set(sourcePort.nodeId, {
          id: srcPortId,
          nodeId: sourcePort.nodeId,
          name: stripPortPrefix(sourcePort.name, centerComponentName),
          portType: sourcePort.portType,
          dir: 'out',
          warn: srcWarn,
          maxAsil: resolveMaxAsil(sourcePort.malfunctions),
          namespace: centerComponentNamespace,
          malfunctions: sourcePort.malfunctions.map(m => ({ nodeId: m.nodeId, name: m.name, description: m.description })),
        });
      }

      // Add targetPort's owner to receivers map
      const receiverNodeId = targetPort.ownerNodeId;
      if (!receiversMap.has(receiverNodeId)) {
        receiversMap.set(receiverNodeId, {
          nodeId: receiverNodeId,
          name: resolveOwnerName(targetPort.ownerName, targetPort.ownerStablePath, receiverNodeId),
          concept: targetPort.ownerConcept,
          namespace: targetPort.ownerNamespace ?? '',
          warn: tgtWarn,
          maxAsil: null,
          ports: [],
        });
      }
      const receiver = receiversMap.get(receiverNodeId)!;

      // Aggregate port onto receiver (deduplicate by nodeId)
      const existingPort = receiver.ports.find(p => p.nodeId === targetPort.nodeId);
      if (!existingPort) {
        receiver.ports.push({
          id: tgtPortId,
          nodeId: targetPort.nodeId,
          name: stripPortPrefix(targetPort.name, receiver.name),
          portType: targetPort.portType,
          warn: tgtWarn,
          maxAsil: resolveMaxAsil(targetPort.malfunctions),
          namespace: targetPort.ownerNamespace ?? '',
          malfunctions: targetPort.malfunctions.map(m => ({ nodeId: m.nodeId, name: m.name, description: m.description })),
          fromFocusPort: srcPortId,
        });
      }
      // Update receiver warn if this port has malfunctions
      if (tgtWarn) {
        receiver.warn = true;
      }

      // Create rightLink
      rightLinks.push({
        partnerPort: tgtPortId,
        focusPort: srcPortId,
        warn: linkWarn,
        connectorType,
      });
    } else if (centerOwnsTarget) {
      // Incoming connection: sender provides data to center
      const tgtPortId = `port-${targetPort.nodeId}`;
      const srcPortId = `partner-${sourcePort.nodeId}`;
      const tgtWarn = targetPort.malfunctions.length > 0;
      const srcWarn = sourcePort.malfunctions.length > 0;
      const linkWarn = srcWarn || tgtWarn;

      // Add targetPort to focus IN ports (portsLeft), deduplicated
      if (!portsLeftMap.has(targetPort.nodeId)) {
        portsLeftMap.set(targetPort.nodeId, {
          id: tgtPortId,
          nodeId: targetPort.nodeId,
          name: stripPortPrefix(targetPort.name, centerComponentName),
          portType: targetPort.portType,
          dir: 'in',
          warn: tgtWarn,
          maxAsil: resolveMaxAsil(targetPort.malfunctions),
          namespace: centerComponentNamespace,
          malfunctions: targetPort.malfunctions.map(m => ({ nodeId: m.nodeId, name: m.name, description: m.description })),
        });
      }

      // Add sourcePort's owner to senders map
      const senderNodeId = sourcePort.ownerNodeId;
      if (!sendersMap.has(senderNodeId)) {
        sendersMap.set(senderNodeId, {
          nodeId: senderNodeId,
          name: resolveOwnerName(sourcePort.ownerName, sourcePort.ownerStablePath, senderNodeId),
          concept: sourcePort.ownerConcept,
          namespace: sourcePort.ownerNamespace ?? '',
          warn: srcWarn,
          maxAsil: null,
          ports: [],
        });
      }
      const sender = sendersMap.get(senderNodeId)!;

      // Aggregate port onto sender (deduplicate by nodeId)
      const existingPort = sender.ports.find(p => p.nodeId === sourcePort.nodeId);
      if (!existingPort) {
        sender.ports.push({
          id: srcPortId,
          nodeId: sourcePort.nodeId,
          name: stripPortPrefix(sourcePort.name, sender.name),
          portType: sourcePort.portType,
          warn: srcWarn,
          maxAsil: resolveMaxAsil(sourcePort.malfunctions),
          namespace: sourcePort.ownerNamespace ?? '',
          malfunctions: sourcePort.malfunctions.map(m => ({ nodeId: m.nodeId, name: m.name, description: m.description })),
          toFocusPort: tgtPortId,
        });
      }
      // Update sender warn if this port has malfunctions
      if (srcWarn) {
        sender.warn = true;
      }

      // Create leftLink
      leftLinks.push({
        partnerPort: srcPortId,
        focusPort: tgtPortId,
        warn: linkWarn,
        connectorType,
      });
    }
    // If center owns neither port, this connector is unrelated — skip silently
  }

  const portsLeft = Array.from(portsLeftMap.values());
  const portsRight = Array.from(portsRightMap.values());

  // Build portsUnconnected: ports passed in that are not already in portsLeft/portsRight
  const connectedPortIds = new Set<number>([
    ...portsLeft.map(p => p.nodeId),
    ...portsRight.map(p => p.nodeId),
  ]);
  const portsUnconnected: DiagramPort[] = unconnectedPorts
    .filter(p => !connectedPortIds.has(p.nodeId))
    .map(p => {
      const portId = `port-${p.nodeId}`;
      // p_port → out direction, r_port → in direction, pr_port → in (conservative)
      const dir: 'in' | 'out' = p.portType === 'p_port' ? 'out' : 'in';
      return {
        id: portId,
        nodeId: p.nodeId,
        name: stripPortPrefix(p.name, centerComponentName),
        portType: p.portType,
        dir,
        warn: p.malfunctions.length > 0,
        maxAsil: resolveMaxAsil(p.malfunctions),
        namespace: centerComponentNamespace,
        malfunctions: p.malfunctions.map(m => ({ nodeId: m.nodeId, name: m.name, description: m.description })),
      };
    });

  // Helper: pick the higher ASIL of two strings
  const higherAsil = (a: string, b: string) =>
    parseAsilLevel(a) >= parseAsilLevel(b) ? a : b;

  // Compute maxAsil for each partner component: max of port-level + component-level malfunctions
  for (const comp of sendersMap.values()) {
    const portAsils = comp.ports.filter(p => p.maxAsil).map(p => p.maxAsil!);
    const compFms = componentMalfunctions[comp.nodeId] ?? [];
    const compAsil = compFms.length > 0 ? (resolveMaxAsil(compFms) ?? 'QM') : null;
    const allAsils = compAsil ? [...portAsils, compAsil] : portAsils;
    comp.maxAsil = allAsils.length > 0 ? allAsils.reduce(higherAsil) : null;
    if (compFms.length > 0) comp.warn = true;
  }
  for (const comp of receiversMap.values()) {
    const portAsils = comp.ports.filter(p => p.maxAsil).map(p => p.maxAsil!);
    const compFms = componentMalfunctions[comp.nodeId] ?? [];
    const compAsil = compFms.length > 0 ? (resolveMaxAsil(compFms) ?? 'QM') : null;
    const allAsils = compAsil ? [...portAsils, compAsil] : portAsils;
    comp.maxAsil = allAsils.length > 0 ? allAsils.reduce(higherAsil) : null;
    if (compFms.length > 0) comp.warn = true;
  }

  // Compute maxAsil for center: max of port-level + component-level malfunctions
  const centerCompFms = componentMalfunctions[centerComponentNodeId] ?? [];
  const centerCompAsil = centerCompFms.length > 0 ? (resolveMaxAsil(centerCompFms) ?? 'QM') : null;
  const allCenterAsils = [
    ...[...portsLeft, ...portsRight].filter(p => p.maxAsil).map(p => p.maxAsil!),
    ...(centerCompAsil ? [centerCompAsil] : []),
  ];
  const centerMaxAsil = allCenterAsils.length > 0 ? allCenterAsils.reduce(higherAsil) : null;
  const hasMalfunction = portsLeft.some(p => p.warn) || portsRight.some(p => p.warn) || centerCompFms.length > 0;

  const center: DiagramCenterComponent = {
    nodeId: centerComponentNodeId,
    name: centerComponentName,
    concept: centerComponentConcept,
    namespace: centerComponentNamespace,
    hasMalfunction,
    maxAsil: centerMaxAsil,
    subtitle: `Component · ${centerComponentConcept}`,
    portsLeft,
    portsRight,
    portsUnconnected,
  };

  return {
    center,
    senders: Array.from(sendersMap.values()),
    receivers: Array.from(receiversMap.values()),
    leftLinks,
    rightLinks,
  };
}
