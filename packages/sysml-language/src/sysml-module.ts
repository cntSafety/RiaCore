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
 * sysml-module.ts — Langium v1.x service wiring for the SysIDE SysML grammar.
 */
import type { Module, LangiumServices, LangiumSharedServices, PartialLangiumServices } from 'langium';
import { createDefaultModule, createDefaultSharedModule, inject } from 'langium';
import { SysMLGeneratedModule, SysMlGeneratedSharedModule } from './generated/module.js';

export type SysMLAddedServices = Record<string, never>;
export type SysMLServices = LangiumServices & SysMLAddedServices;

export const SysMLModule: Module<SysMLServices, PartialLangiumServices & SysMLAddedServices> = {};

export function createSysmlSubsetServices(context: {
  fileSystemProvider?: unknown;
  [key: string]: unknown;
}): { shared: LangiumSharedServices; SysmlSubset: SysMLServices } {
  const shared = inject(
    createDefaultSharedModule(context as Parameters<typeof createDefaultSharedModule>[0]),
    SysMlGeneratedSharedModule,
  );
  const SysmlSubset = inject(
    createDefaultModule({ shared }),
    SysMLGeneratedModule,
    SysMLModule,
  );
  shared.ServiceRegistry.register(SysmlSubset);
  return { shared, SysmlSubset };
}
