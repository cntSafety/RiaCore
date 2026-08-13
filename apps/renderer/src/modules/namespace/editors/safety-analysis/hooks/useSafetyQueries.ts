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
import { api } from '../../../../../api/riacore';

export function useMalfunctions(namespace: string) {
  return useQuery({
    queryKey: ['safety.malfunctions', namespace],
    queryFn: () => api.safety.getMalfunctions(namespace),
  });
}

export function useMalfunctionsForElement(targetNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.malfunctionsForElement', targetNodeId],
    queryFn: () => api.safety.getMalfunctionsForElement(targetNodeId!),
    enabled: targetNodeId !== undefined,
  });
}

export function useMalfunction(nodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.malfunction', nodeId],
    queryFn: () => api.safety.getMalfunction(nodeId!),
    enabled: nodeId !== undefined,
  });
}

export function useRiskRating(fmNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.riskRating', fmNodeId],
    queryFn: () => api.safety.getRiskRating(fmNodeId!),
    enabled: fmNodeId !== undefined,
  });
}

export function useAllSafetyTasks(namespace: string) {
  return useQuery({
    queryKey: ['safety.allSafetyTasks', namespace],
    queryFn: () => api.safety.getAllSafetyTasks(namespace),
  });
}

export function useSafetyTasks(fmNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.safetyTasks', fmNodeId],
    queryFn: () => api.safety.getSafetyTasks(fmNodeId!),
    enabled: fmNodeId !== undefined,
  });
}

export function useMalfunctionForRiskRating(riskRatingNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.malfunctionForRiskRating', riskRatingNodeId],
    queryFn: () => api.safety.getMalfunctionForRiskRating(riskRatingNodeId!),
    enabled: riskRatingNodeId !== undefined,
  });
}

export function useMalfunctionForReviewItem(reviewItemNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.malfunctionForReviewItem', reviewItemNodeId],
    queryFn: () => api.safety.getMalfunctionForReviewItem(reviewItemNodeId!),
    enabled: reviewItemNodeId !== undefined,
  });
}

export function useRequirements(namespace: string) {
  return useQuery({
    queryKey: ['safety.requirements', namespace],
    queryFn: () => api.safety.getRequirements(namespace),
  });
}

export function useSafetyNotes(namespace: string) {
  return useQuery({
    queryKey: ['safety.safetyNotes', namespace],
    queryFn: () => api.safety.getSafetyNotes(namespace),
  });
}

export function useAllReviewItems(namespace: string) {
  return useQuery({
    queryKey: ['safety.allReviewItems', namespace],
    queryFn: () => api.safety.getAllReviewItems(namespace),
  });
}

export function useReviewItems(elementNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.reviewItems', elementNodeId],
    queryFn: () => api.safety.getReviewItems(elementNodeId!),
    enabled: elementNodeId !== undefined,
  });
}

export function usePropagations(fmNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.propagations', fmNodeId],
    queryFn: () => api.safety.getPropagations(fmNodeId!),
    enabled: fmNodeId !== undefined,
  });
}

export function usePropagationsForComponent(structuralNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.propagationsForComponent', structuralNodeId],
    queryFn: () => api.safety.getPropagationsForComponent(structuralNodeId!),
    enabled: structuralNodeId !== undefined,
  });
}

export function useRequirementsForFm(fmNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.requirementsForFm', fmNodeId],
    queryFn: () => api.safety.getRequirementsForFm(fmNodeId!),
    enabled: fmNodeId !== undefined,
  });
}

export function useMalfunctionsForRequirement(requirementNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.malfunctionsForRequirement', requirementNodeId],
    queryFn: () => api.safety.getMalfunctionsForRequirement(requirementNodeId!),
    enabled: requirementNodeId !== undefined,
  });
}

export function useNotesForFm(fmNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.notesForFm', fmNodeId],
    queryFn: () => api.safety.getNotesForFm(fmNodeId!),
    enabled: fmNodeId !== undefined,
  });
}

export function useNotesForElement(elementNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.notesForElement', elementNodeId],
    queryFn: () => api.safety.getNotesForElement(elementNodeId!),
    enabled: elementNodeId !== undefined,
  });
}

export function useInstance(nodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.instance', nodeId],
    queryFn: () => api.safety.getInstance(nodeId!),
    enabled: nodeId !== undefined,
  });
}

export function useNoteParent(noteNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.noteParent', noteNodeId],
    queryFn: () => api.safety.getNoteParent(noteNodeId!),
    enabled: noteNodeId !== undefined,
  });
}

export function useDirectRequirementsForFm(fmNodeId: number | undefined) {
  return useQuery({
    queryKey: ['safety.directRequirementsForFm', fmNodeId],
    queryFn: () => api.safety.getDirectRequirementsForFm(fmNodeId!),
    enabled: fmNodeId !== undefined,
  });
}

export function useSearchRequirementsAcrossNamespaces(query: string) {
  return useQuery({
    queryKey: ['safety.requirementSearch', query],
    queryFn: () => api.safety.searchRequirementsAcrossNamespaces(query),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}
