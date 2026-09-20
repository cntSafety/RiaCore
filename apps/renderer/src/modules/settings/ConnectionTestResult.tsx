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
import { useEffect, useRef } from 'react';
import { Alert } from 'antd';

export function ConnectionTestResult({ result }: { result: { ok: boolean; error?: string } }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    container.current?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }, [result]);

  return (
    <div ref={container} style={{ marginTop: 12 }}>
      <Alert
        type={result.ok ? 'success' : 'error'}
        message={result.ok ? 'Connection successful' : 'Connection failed'}
        description={result.ok ? undefined : result.error}
        role={result.ok ? 'status' : 'alert'}
        showIcon
      />
    </div>
  );
}
