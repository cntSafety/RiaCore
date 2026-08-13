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
import { Modal, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '../api/riacore';
import appIconUrl from '../assets/icon.png';

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Themed About dialog rendered in the renderer process.
 * Replaces Electron's native `app.showAboutPanel()` so it respects the dark theme.
 */
export function AboutModal({ open, onClose }: AboutModalProps) {
  const { token } = theme.useToken();
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    api.app.getInfo()
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(''));
  }, [open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="OK"
      cancelButtonProps={{ style: { display: 'none' } }}
      title={null}
      width={360}
      destroyOnClose
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '8px 0' }}>
        <img
          src={appIconUrl}
          alt="RiaCore"
          style={{ width: 64, height: 64, borderRadius: token.borderRadius, flexShrink: 0 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Typography.Text strong style={{ fontSize: 16 }}>RiaCore</Typography.Text>
          {version && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>{version}</Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            © {new Date().getFullYear()} RiaCore
          </Typography.Text>
        </div>
      </div>
    </Modal>
  );
}
