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
import { createContext, useContext } from 'react';

/**
 * The metamodel whose profile snapshot the Safety-Analysis editor should read.
 *
 * The Safety editor is a generic renderer over a profile snapshot. More than one
 * profile can share the 'Safety-Analysis' owning application (and therefore the
 * same editor) while registering a distinct metamodel — e.g. the SW-level
 * `SAFETY_ANALYSIS` and the system-level `SYSTEM_SAFETY_ANALYSIS`. Each carries
 * its own `profile_metadata` (occurrence levels, review instructions, FM
 * catalog), so the editor must resolve the metamodel from the active namespace
 * rather than hard-coding it.
 *
 * The default keeps the original single-profile behavior working unchanged for
 * any mount point that has not (yet) provided a value.
 */
export const DEFAULT_SAFETY_METAMODEL = 'SAFETY_ANALYSIS';

export const SafetyMetamodelContext = createContext<string>(DEFAULT_SAFETY_METAMODEL);

/** Returns the metamodel name the surrounding Safety editor is bound to. */
export function useSafetyMetamodel(): string {
  return useContext(SafetyMetamodelContext);
}
