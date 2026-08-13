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
import type { ImportRunSummary } from '@riacore/app-contracts';
import { useRunImportMutation } from './hooks/useRiacoreMutations';

type Status = 'idle' | 'running' | 'done' | 'error';

export default function ImportPanel() {
  const [workingDir, setWorkingDir] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ImportRunSummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const runImportMutation = useRunImportMutation();

  async function handleRun() {
    if (!workingDir.trim() || !configPath.trim()) return;
    setStatus('running');
    setResult(null);
    setErrorMsg(null);

    try {
      const res = await runImportMutation.mutateAsync({
        workingDir: workingDir.trim(),
        configPath: configPath.trim(),
      });

      setResult(res);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  const running = status === 'running' || runImportMutation.isPending;

  return (
    <div style={s.card}>
      <h3 style={s.title}>Import</h3>

      <label style={s.label}>Working directory (workspace root)</label>
      <input
        style={s.input}
        value={workingDir}
        onChange={e => setWorkingDir(e.target.value)}
        placeholder="C:\sandbox\RiaTestMe"
        disabled={running}
      />

      <label style={s.label}>Config file path</label>
      <input
        style={s.input}
        value={configPath}
        onChange={e => setConfigPath(e.target.value)}
        placeholder="C:\sandbox\RiaTestMe\ria-config\...\arxml-import-config.yaml"
        disabled={running}
      />

      <button
        style={{ ...s.btn, ...(running ? s.btnDisabled : {}) }}
        onClick={handleRun}
        disabled={running || !workingDir.trim() || !configPath.trim()}
      >
        {running ? 'Importing…' : 'Run Import'}
      </button>

      {status === 'running' && (
        <p style={s.muted}>Import in progress…</p>
      )}

      {status === 'error' && (
        <div style={s.errorBox}>
          <strong>Import failed</strong>
          <p style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>{errorMsg}</p>
        </div>
      )}

      {status === 'done' && result && (
        <div style={s.successBox}>
          <div style={s.row}>
            <span style={s.statLabel}>Namespace</span>
            <span style={s.statValue}>{result.namespace}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Concepts</span>
            <span style={s.statValue}>{result.stats.conceptsCreated}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Relationships</span>
            <span style={s.statValue}>{result.stats.relationshipsCreated}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Files</span>
            <span style={s.statValue}>{result.stats.filesProcessed}</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Duration</span>
            <span style={s.statValue}>{(result.stats.durationMs / 1000).toFixed(2)}s</span>
          </div>
          <div style={s.row}>
            <span style={s.statLabel}>Log</span>
            <span style={{ ...s.statValue, fontFamily: 'monospace', fontSize: '0.78rem' }}>
              {workingDir.replace(/\\/g, '/')}/logs
            </span>
          </div>
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
  btn: {
    padding: '7px 18px',
    fontSize: '0.875rem',
    fontWeight: 600,
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    marginBottom: 12,
  },
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
  row: { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  statLabel: { fontSize: '0.8rem', color: '#374151' },
  statValue: { fontSize: '0.8rem', color: '#166534', fontWeight: 500 },
};
