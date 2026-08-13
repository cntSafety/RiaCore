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
import { useState } from 'react';
import type { StoreResult, LoadResult } from '@riacore/app-contracts';
import {
  useOpenWorkspaceMutation,
  usePersistorLoadMutation,
  usePersistorStoreMutation,
} from './hooks/useRiacoreMutations';

type Operation = 'store' | 'load';
type Status = 'idle' | 'running' | 'done' | 'error';

export default function PersistorPanel() {
  const [workingDir, setWorkingDir] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [operation, setOperation] = useState<Operation>('store');
  const [storeResult, setStoreResult] = useState<StoreResult | null>(null);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const openWorkspaceMutation = useOpenWorkspaceMutation();
  const storeMutation = usePersistorStoreMutation(() => workingDir);
  const loadMutation = usePersistorLoadMutation(() => workingDir);

  async function handleOperation(op: Operation) {
    const normalizedWorkingDir = workingDir.trim();
    if (!normalizedWorkingDir) return;
    setOperation(op);
    setStatus('running');
    setStoreResult(null);
    setLoadResult(null);
    setErrorMsg(null);

    try {
      await openWorkspaceMutation.mutateAsync(normalizedWorkingDir);

      if (op === 'store') {
        const res = await storeMutation.mutateAsync();
        setStoreResult(res);
        setStatus('done');
      } else {
        const res = await loadMutation.mutateAsync();
        setLoadResult(res);
        setStatus('done');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  const running = status === 'running' || openWorkspaceMutation.isPending || storeMutation.isPending || loadMutation.isPending;

  return (
    <div style={s.card}>
      <h3 style={s.title}>Persistor</h3>

      <label style={s.label}>Working directory (workspace root)</label>
      <input
        style={s.input}
        value={workingDir}
        onChange={e => setWorkingDir(e.target.value)}
        placeholder="C:\sandbox\RiaTestMe"
        disabled={running}
      />

      <div style={s.buttonRow}>
        <button
          style={{ ...s.btn, ...(running ? s.btnDisabled : {}) }}
          onClick={() => handleOperation('store')}
          disabled={running || !workingDir.trim()}
        >
          {running && operation === 'store' ? 'Storing…' : 'Store'}
        </button>
        <button
          style={{ ...s.btn, ...s.btnSecondary, ...(running ? s.btnDisabled : {}) }}
          onClick={() => handleOperation('load')}
          disabled={running || !workingDir.trim()}
        >
          {running && operation === 'load' ? 'Loading…' : 'Load'}
        </button>
      </div>

      {status === 'running' && (
        <p style={s.muted}>{operation === 'store' ? 'Store' : 'Load'} in progress…</p>
      )}

      {status === 'error' && (
        <div style={s.errorBox}>
          <strong>{operation === 'store' ? 'Store' : 'Load'} failed</strong>
          <p style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>{errorMsg}</p>
        </div>
      )}

      {status === 'done' && operation === 'store' && storeResult && (
        <div style={s.successBox}>
          <div style={s.row}>
            <span style={s.statLabel}>Namespaces written</span>
            <span style={s.statValue}>{storeResult.namespaces_written.length}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Namespaces skipped</span>
            <span style={s.statValue}>{storeResult.namespaces_skipped.length}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Files written</span>
            <span style={s.statValue}>{storeResult.files_written}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Total records</span>
            <span style={s.statValue}>{storeResult.total_records}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Exported at</span>
            <span style={{ ...s.statValue, fontFamily: 'monospace', fontSize: '0.78rem' }}>
              {storeResult.exported_at}
            </span>
          </div>
        </div>
      )}

      {status === 'done' && operation === 'load' && loadResult && (
        <div style={loadResult.relationships_failed ? s.warningBox : s.successBox}>
          <div style={s.row}>
            <span style={s.statLabel}>Namespaces imported</span>
            <span style={s.statValue}>{loadResult.namespaces_imported.length}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Namespaces skipped</span>
            <span style={s.statValue}>{loadResult.namespaces_skipped.length}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Total records imported</span>
            <span style={s.statValue}>{loadResult.total_records_imported}</span>
          </div>
          {loadResult.relationships_failed != null && loadResult.relationships_failed > 0 && (
            <div style={{ ...s.row, marginTop: 6, paddingTop: 6, borderTop: '1px solid #fcd34d' }}>
              <span style={{ ...s.statLabel, color: '#92400e', fontWeight: 600 }}>
                ⚠ Relationships failed to load
              </span>
              <span style={{ ...s.statValue, color: '#92400e' }}>
                {loadResult.relationships_failed}
              </span>
            </div>
          )}
          {loadResult.relationships_failed != null && loadResult.relationships_failed > 0 && (
            <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#92400e' }}>
              Some relationship edges could not be resolved. The namespace was imported but
              may appear flat (no tree hierarchy). Check the load log for details.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: '16px 20px',
    maxWidth: 480,
    marginTop: 16,
  },
  title: { margin: '0 0 14px', fontSize: '1rem', fontWeight: 600 },
  label: { display: 'block', fontSize: '0.8rem', color: '#374151', marginBottom: 4 },
  input: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    fontSize: '0.85rem',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    marginBottom: 12,
    fontFamily: 'monospace',
  },
  buttonRow: { display: 'flex', gap: 8, marginBottom: 12 },
  btn: {
    padding: '7px 18px',
    fontSize: '0.875rem',
    fontWeight: 600,
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  btnSecondary: { backgroundColor: '#059669' },
  btnDisabled: { backgroundColor: '#93c5fd', cursor: 'not-allowed' },
  muted: { color: '#9ca3af', fontSize: '0.875rem', margin: '4px 0' },
  errorBox: {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    borderRadius: 6,
    padding: '10px 14px',
    marginTop: 8,
  },
  successBox: {
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: 6,
    padding: '10px 14px',
    marginTop: 8,
  },
  warningBox: {
    backgroundColor: '#fffbeb',
    border: '1px solid #fcd34d',
    borderRadius: 6,
    padding: '10px 14px',
    marginTop: 8,
  },
  row: { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  statLabel: { fontSize: '0.8rem', color: '#374151' },
  statValue: { fontSize: '0.8rem', color: '#166534', fontWeight: 500 },
};
