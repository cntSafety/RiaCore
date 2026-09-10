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
 * The one thing `wal-recovery.ts` (parent) and `wal-probe-child.ts` (child)
 * must agree on.
 *
 * Kept in its own module so the child does not have to load the parent's spawn
 * machinery just to read a string — the child's whole purpose is that nothing
 * except the database engine gets to influence how it exits.
 */

/** Prefix the child prints before a caught error message so the parent can recover it. */
export const WAL_PROBE_ERROR_PREFIX = 'RIACORE_WAL_PROBE_ERROR:';
