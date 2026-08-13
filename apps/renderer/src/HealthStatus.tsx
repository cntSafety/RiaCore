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
import { useEffect, useState } from 'react';
import type { WorkspaceStatus, DbStatus } from '@riacore/app-contracts';
import { api } from './api/riacore';

interface HealthInfo {
  workspace: WorkspaceStatus;
  db: DbStatus;
}

export default function HealthStatus() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [workspace, db] = await Promise.all([
          api.workspace.getStatus(),
          api.db.probe(),
        ]);
        if (!cancelled) {
          setHealth({ workspace, db });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (error) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>Health Status</h3>
        <div style={{ ...styles.indicator, backgroundColor: '#fee2e2', color: '#991b1b' }}>
          Error: {error}
        </div>
      </div>
    );
  }

  if (!health) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>Health Status</h3>
        <p style={styles.muted}>Loading...</p>
      </div>
    );
  }

  const wsOpen = health.workspace.state === 'open';
  const dbOpen = health.db.state === 'open';

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Health Status</h3>

      <div style={styles.row}>
        <span style={styles.label}>Workspace</span>
        <span style={{ ...styles.badge, ...(wsOpen ? styles.badgeGreen : styles.badgeGray) }}>
          {health.workspace.state}
        </span>
      </div>

      {wsOpen && health.workspace.state === 'open' && (
        <div style={styles.detail}>
          <div style={styles.row}>
            <span style={styles.label}>Working Dir</span>
            <span style={styles.value}>{health.workspace.info.workingDir}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>DB Path</span>
            <span style={styles.value}>{health.workspace.info.dbPath}</span>
          </div>
        </div>
      )}

      <div style={styles.row}>
        <span style={styles.label}>Database</span>
        <span style={{
          ...styles.badge,
          ...(dbOpen ? styles.badgeGreen : health.db.state === 'error' ? styles.badgeRed : styles.badgeGray),
        }}>
          {health.db.state}
        </span>
      </div>

      {'error' in health.db && health.db.state === 'error' && (
        <div style={styles.detail}>
          <span style={{ color: '#991b1b', fontSize: '0.85rem' }}>{health.db.error}</span>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: '16px 20px',
    maxWidth: 480,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  title: {
    margin: '0 0 12px 0',
    fontSize: '1rem',
    fontWeight: 600,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 0',
  },
  label: {
    fontSize: '0.875rem',
    color: '#374151',
  },
  value: {
    fontSize: '0.8rem',
    color: '#6b7280',
    fontFamily: 'monospace',
    maxWidth: 280,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  detail: {
    paddingLeft: 12,
    borderLeft: '2px solid #e5e7eb',
    marginBottom: 4,
  },
  badge: {
    fontSize: '0.75rem',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 12,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  badgeGreen: {
    backgroundColor: '#dcfce7',
    color: '#166534',
  },
  badgeGray: {
    backgroundColor: '#f3f4f6',
    color: '#6b7280',
  },
  badgeRed: {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
  },
  muted: {
    color: '#9ca3af',
    fontSize: '0.875rem',
  },
};
