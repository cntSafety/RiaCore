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
 * AnomalyBanner — displays a persistent warning when tree integrity anomalies
 * are detected (duplicate node IDs, duplicate namespace names, orphan references).
 *
 * Renders nothing when the `anomalies` array is empty.
 *
 * Requirements: 3.4, 9.1, 9.4
 */

import { useState } from 'react';
import { Alert } from 'antd';
import type { AnomalyReport } from '../utils/treeIndexStore';

export interface AnomalyBannerProps {
  anomalies: AnomalyReport[];
  onDismiss?: () => void;
}

export function AnomalyBanner({ anomalies, onDismiss }: AnomalyBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (anomalies.length === 0) {
    return null;
  }

  const count = anomalies.length;
  const message = `⚠ Tree integrity issue detected — ${count} ${count === 1 ? 'anomaly' : 'anomalies'} found`;

  const description = expanded ? (
    <ul
      style={{ margin: '4px 0 0 0', paddingLeft: 16, fontSize: 12 }}
      aria-label="Anomaly details"
    >
      {anomalies.map((anomaly, index) => (
        <li key={index}>{anomaly.message}</li>
      ))}
    </ul>
  ) : (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        fontSize: 12,
        color: '#d46b08',
        textDecoration: 'underline',
      }}
      aria-expanded={false}
      aria-controls="anomaly-details"
    >
      Show details
    </button>
  );

  return (
    <Alert
      type="warning"
      message={message}
      description={description}
      closable={!!onDismiss}
      onClose={onDismiss}
      style={{ marginBottom: 8, fontSize: 12 }}
      role="alert"
      aria-live="polite"
      aria-label={message}
    />
  );
}
