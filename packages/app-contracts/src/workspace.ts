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
import { z } from 'zod';
import { DbStatus } from './db.js';

export const WorkspaceConfigSchema = z.object({
  workingDir: z.string().min(1, 'Working directory path is required'),
  forceRecheck: z.boolean().optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export type LifecycleAction =
  | 'created'
  | 'opened_consistent'
  | 'loading_from_ria_data'
  | 'opened_loaded_from_ria_data'
  | 'opened_saved_to_ria_data'
  | 'opened_db_only'
  | 'load_failed';

export interface WorkspaceInfo {
  workingDir: string;
  dbPath: string;
  dbStatus: DbStatus;
  lifecycleAction: LifecycleAction;
  lifecycleWarning?: string;
}

export type WorkspaceStatus =
  | { state: 'closed' }
  | { state: 'open'; info: WorkspaceInfo };
