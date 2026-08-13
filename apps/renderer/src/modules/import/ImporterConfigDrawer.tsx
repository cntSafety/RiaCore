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
import {
  Drawer,
  Select,
  Checkbox,
  Tag,
  Button,
  Space,
  Divider,
  Form,
  Input,
  theme,
  App,
} from 'antd';
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';

const { useToken } = theme;

interface ImporterConfigDrawerProps {
  open: boolean;
  importerId: string | null;
  onClose: () => void;
  onRun?: (importerId: string) => void;
}

const FILE_OPTIONS = [
  { label: 'Chassis_system.arxml', value: 'chassis' },
  { label: 'PowerTrain_arch.arxml', value: 'powertrain' },
  { label: 'DataTypes_catalog.arxml', value: 'datatypes' },
];

const VERSION_OPTIONS = [
  { label: 'v4.0', value: '4.0' },
  { label: 'v4.5', value: '4.5' },
  { label: 'v5.0', value: '5.0' },
];

export function ImporterConfigDrawer({
  open,
  importerId,
  onClose,
  onRun,
}: ImporterConfigDrawerProps) {
  const { token } = useToken();
  const { message } = App.useApp();
  const [selectedFiles, setSelectedFiles] = useState<string[]>(['chassis', 'powertrain']);
  const [version, setVersion] = useState('4.5');
  const [excludedPkgs, setExcludedPkgs] = useState<string[]>(['CompuMethods', 'DataTypes']);
  const [newPkg, setNewPkg] = useState('');
  const [workingDir, setWorkingDir] = useState('');

  const handleBrowse = async () => {
    // Will call dialog.openDirectory IPC once available
    message.info('Native folder dialog not yet wired — enter path manually');
  };

  const addExclude = () => {
    if (newPkg.trim() && !excludedPkgs.includes(newPkg.trim())) {
      setExcludedPkgs([...excludedPkgs, newPkg.trim()]);
      setNewPkg('');
    }
  };

  const removeExclude = (pkg: string) => {
    setExcludedPkgs(excludedPkgs.filter((p) => p !== pkg));
  };

  const handleRun = () => {
    if (importerId && onRun) onRun(importerId);
    onClose();
  };

  return (
    <Drawer
      title={`Configure: ${importerId ?? 'Importer'}`}
      open={open}
      onClose={onClose}
      width={360}
      footer={
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="default">Save Config</Button>
          <Button type="primary" onClick={handleRun}>
            ▶ Run
          </Button>
        </Space>
      }
    >
      <Form layout="vertical" size="small">
        {/* Version */}
        <Form.Item label="Format Version">
          <Select
            autoFocus
            value={version}
            onChange={setVersion}
            options={VERSION_OPTIONS}
            style={{ width: '100%' }}
          />
        </Form.Item>

        {/* Working directory */}
        <Form.Item label="Working Directory">
          <Input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/path/to/workspace"
            suffix={
              <Button
                size="small"
                type="text"
                icon={<FolderOpenOutlined />}
                onClick={handleBrowse}
                style={{ fontSize: 11 }}
              >
                Browse
              </Button>
            }
          />
        </Form.Item>

        {/* Source files */}
        <Form.Item label="Source Files">
          <div
            style={{
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadius,
              padding: '6px 8px',
              maxHeight: 160,
              overflowY: 'auto',
            }}
          >
            <Checkbox.Group
              value={selectedFiles}
              onChange={(vals) => setSelectedFiles(vals as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              {FILE_OPTIONS.map((f) => (
                <Checkbox key={f.value} value={f.value} style={{ fontSize: 12 }}>
                  {f.label}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </div>
        </Form.Item>

        {/* Exclude packages */}
        <Form.Item label="Exclude Packages">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
            {excludedPkgs.map((pkg) => (
              <Tag
                key={pkg}
                closable
                onClose={() => removeExclude(pkg)}
                style={{ fontSize: 11 }}
              >
                {pkg}
              </Tag>
            ))}
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="Package name"
              value={newPkg}
              onChange={(e) => setNewPkg(e.target.value)}
              onPressEnter={addExclude}
              size="small"
            />
            <Button size="small" icon={<PlusOutlined />} onClick={addExclude} />
          </Space.Compact>
        </Form.Item>
      </Form>
    </Drawer>
  );
}
