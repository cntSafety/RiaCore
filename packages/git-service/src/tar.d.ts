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
 * Minimal ambient typing for the subset of the `tar` package's extract API
 * used by git-service-impl.ts. The `tar` package ships without its own
 * TypeScript types and `@types/tar` is not vendored in this workspace.
 */
declare module 'tar' {
  export interface ExtractOptions {
    file: string;
    cwd?: string;
  }

  export function x(options: ExtractOptions): Promise<void>;
}
