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
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { GraphCoreWindowView } from './GraphCoreWindowView';
import { graphCoreQueryClient } from './graphCoreQueryClient';

const queryClient = graphCoreQueryClient;

export default function GraphCoreApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <GraphCoreWindowView />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
