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
/** Malfunction attached to a port via occurs_at */
export interface MalfunctionInfo {
  /** node_id of the malfunction */
  nodeId: number;
  /** Human-readable name (has_name attribute) */
  name: string;
  /** Malfunction description (malfunction_description attribute) */
  description: string;
  /** ASIL rating (malfunction_asil attribute, e.g. 'D', 'QM') */
  asil: string;
}

/** Identifies a port and its owning component */
export interface PortInfo {
  /** node_id of the port (p_port or r_port) */
  nodeId: number;
  /** 'p_port' | 'r_port' | 'pr_port' */
  portType: 'p_port' | 'r_port' | 'pr_port';
  /** stable_path from attributes (AUTOSAR path) */
  stablePath: string;
  /** Short name extracted from the last segment of stable_path */
  name: string;
  /** node_id of the owning SWC type */
  ownerNodeId: number;
  /** concept of the owning SWC (e.g. 'application_swc', 'service_swc') */
  ownerConcept: string;
  /** stable_path of the owning SWC */
  ownerStablePath: string;
  /** Short name of the owning SWC */
  ownerName: string;
  /** Namespace of the owning SWC */
  ownerNamespace: string;
  /** Malfunctions attached to this port via occurs_at (empty array if none) */
  malfunctions: MalfunctionInfo[];
}

/** Describes a single connector and its two connected ports */
export interface ConnectorInfo {
  /** node_id of the connector */
  connectorNodeId: number;
  /** 'assembly_connector' | 'delegation_connector' */
  connectorType: 'assembly_connector' | 'delegation_connector';
  /** stable_path of the connector */
  connectorStablePath: string;
  /** node_id of the composition_swc that owns this connector */
  compositionNodeId: number;
  /** stable_path of the owning composition */
  compositionStablePath: string;
  /** The provider/inner port side */
  sourcePort: PortInfo;
  /** The requester/outer port side */
  targetPort: PortInfo;
}

/** Result for a single-port connector query */
export interface PortConnectorResult {
  /** The queried port */
  port: PortInfo;
  /** All connectors involving this port */
  connectors: ConnectorInfo[];
  /**
   * Component-level malfunctions keyed by owner node_id.
   * Includes malfunctions attached directly to component nodes (not via ports)
   * for all owner components appearing in the connectors.
   */
  componentMalfunctions: Record<number, MalfunctionInfo[]>;
}

/** Result for batch namespace connector query */
export interface NamespacePortConnectorsResult {
  /** The queried namespace */
  namespace: string;
  /** All connectors found in this namespace */
  connectors: ConnectorInfo[];
  /** Summary counts */
  summary: {
    totalConnectors: number;
    assemblyConnectors: number;
    delegationConnectors: number;
    uniquePorts: number;
    portsWithMalfunctions: number;
    totalMalfunctions: number;
  };
}

/** Result for batch component connector query */
export interface ComponentPortConnectorsResult {
  /** The queried component */
  component: {
    nodeId: number;
    concept: string;
    stablePath: string;
    name: string;
  };
  /** All connectors involving ports of this component */
  connectors: ConnectorInfo[];
  /**
   * Ports of this component that have no connector (neither assembly nor delegation).
   * These are shown in the diagram as unconnected pins so the user can see all ports.
   */
  unconnectedPorts: PortInfo[];
  /** Summary counts */
  summary: {
    totalConnectors: number;
    assemblyConnectors: number;
    delegationConnectors: number;
    uniquePorts: number;
    portsWithMalfunctions: number;
    totalMalfunctions: number;
  };
  /**
   * Component-level malfunctions keyed by owner node_id.
   * Includes malfunctions attached directly to component nodes (not via ports)
   * for all owner components appearing in the connectors, plus the queried component itself.
   */
  componentMalfunctions: Record<number, MalfunctionInfo[]>;
}

/** Input for arxml.getPortConnectors */
export interface GetPortConnectorsInput {
  nodeId: number;
}

/** Input for arxml.getNamespacePortConnectors */
export interface GetNamespacePortConnectorsInput {
  namespace: string;
}

/** Input for arxml.getComponentPortConnectors */
export interface GetComponentPortConnectorsInput {
  nodeId: number;
}
