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
import { useQuery } from '@tanstack/react-query';
import type { PortConnectorResult, NamespacePortConnectorsResult, ComponentPortConnectorsResult } from '@riacore/app-contracts';
import { api } from '../api/riacore';

export function usePortConnectors(nodeId: number | null | undefined, workspaceKey: string | null | undefined) {
  return useQuery<PortConnectorResult>({
    queryKey: ['arxml.portConnectors', workspaceKey, nodeId],
    queryFn: () => api.arxml.getPortConnectors(nodeId!),
    enabled: !!nodeId && !!workspaceKey,
    staleTime: 30_000,
  });
}

export function useNamespacePortConnectors(namespace: string | null | undefined, workspaceKey: string | null | undefined) {
  return useQuery<NamespacePortConnectorsResult>({
    queryKey: ['arxml.namespacePortConnectors', workspaceKey, namespace],
    queryFn: () => api.arxml.getNamespacePortConnectors(namespace!),
    enabled: !!namespace && !!workspaceKey,
    staleTime: 30_000,
  });
}

export function useComponentPortConnectors(nodeId: number | null | undefined, workspaceKey: string | null | undefined) {
  return useQuery<ComponentPortConnectorsResult>({
    queryKey: ['arxml.componentPortConnectors', workspaceKey, nodeId],
    queryFn: () => api.arxml.getComponentPortConnectors(nodeId!),
    enabled: !!nodeId && !!workspaceKey,
    staleTime: 30_000,
  });
}
