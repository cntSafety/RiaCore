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
import { useImportSources } from './useImportSources';
import { useWorkspaceState, isDbOpen } from './useWorkspaceState';

/**
 * Keeps the imports.listSources query alive regardless of which view is
 * currently rendered. Mount this once at the app root so that source data
 * is always fresh when navigating back to WorkspaceCanvas.
 */
export function useKeepImportSourcesSynced() {
  const wsState = useWorkspaceState();
  const dbOpen = isDbOpen(wsState);
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;
  useImportSources(dbOpen, workspaceKey);
}
